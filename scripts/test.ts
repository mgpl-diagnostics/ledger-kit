// npm test — ledger-kit on real MongoDB (single-node replica set) and real PostgreSQL, both started
// in-process, through db-kit's repositories.
//
// The same scenario runs twice on each database, into two fresh databases: once with db-kit 1.1.0's
// accounting (its default posting and its functions), once with ledger-kit's (ledgerPostingHook and
// ledger-kit's functions). Every voucher, ledger entry, audit line, error and report is snapshotted with
// ids replaced by names; the two snapshots must be identical. Then ledger-kit-only checks: the trial
// balance after every step, lock dates under concurrency, atomicity, carrying on a db-kit series, and
// the engine boundary (ledger-kit must not call db-kit's accounting).
//
// Fictional organisation and people only.
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import EmbeddedPostgres from "embedded-postgres";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import * as dbkit from "@mgpl-diagnostics/db-kit";
import {
  cancelInvoice, ConflictError, createDb, issueInvoice, NotFoundError, PeriodLockedError, recordPayment, registerPatient, seedOrganization,
  ValidationError, type Backend, type Db, type Id, type PostingHook, type Repositories,
} from "@mgpl-diagnostics/db-kit";
import * as ledger from "../src/index";

let failed = 0;
let passed = 0;
const ok = (cond: unknown, msg: string) => {
  if (cond) { passed++; console.log(`  ok    ${msg}`); }
  else { failed++; console.log(`  FAIL  ${msg}`); }
};
const rejects = async (p: Promise<unknown>, type: new (...a: any[]) => Error, msg: string) => {
  try { await p; ok(false, `${msg} (no error)`); } catch (e) { ok(e instanceof type, `${msg}${e instanceof type ? "" : ` (got ${(e as Error).name}: ${(e as Error).message})`}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const START = Date.now();

/** IST wall-clock time → Date. */
const at = (day: string, time = "10:00") => new Date(`${day}T${time}:00+05:30`);
const FY25 = { from: at("2025-04-01", "00:00"), to: new Date(at("2026-04-01", "00:00").getTime() - 1) };
const FY26 = { from: at("2026-04-01", "00:00"), to: new Date(at("2027-04-01", "00:00").getTime() - 1) };
const EVER = { from: at("2020-01-01"), to: new Date(START + 365 * 86400000) };

// ------------------------------------------------------------------ engines

/** Everything the scenario calls on an accounting engine. */
interface Engine {
  name: "db-kit" | "ledger-kit";
  /** The posting hook billing uses (undefined = db-kit's default). */
  hook?: PostingHook;
  seedChartOfAccounts: typeof ledger.seedChartOfAccounts;
  postVoucher: typeof ledger.postVoucher;
  cancelVoucher: typeof ledger.cancelVoucher;
  postInvoice: typeof ledger.postInvoice;
  postPayment: typeof ledger.postPayment;
  assertBalanced: typeof ledger.assertBalanced;
  salesEntries: typeof ledger.salesEntries;
  receiptEntries: typeof ledger.receiptEntries;
  ledgerBalance: typeof ledger.ledgerBalance;
  ledgerStatement: typeof ledger.ledgerStatement;
  cashBook: typeof ledger.cashBook;
  trialBalance: typeof ledger.trialBalance;
  profitAndLoss: typeof ledger.profitAndLoss;
  balanceSheet: typeof ledger.balanceSheet;
  dayBook: typeof ledger.dayBook;
  outstandingReceivables: typeof ledger.outstandingReceivables;
  gstSummary: typeof ledger.gstSummary;
  constants: unknown;
}

const DBKIT: Engine = {
  name: "db-kit", hook: undefined,
  seedChartOfAccounts: dbkit.seedChartOfAccounts, postVoucher: dbkit.postVoucher, cancelVoucher: dbkit.cancelVoucher,
  postInvoice: dbkit.postInvoice, postPayment: dbkit.postPayment, assertBalanced: dbkit.assertBalanced,
  salesEntries: dbkit.salesEntries, receiptEntries: dbkit.receiptEntries,
  ledgerBalance: dbkit.ledgerBalance, ledgerStatement: dbkit.ledgerStatement, cashBook: dbkit.cashBook, trialBalance: dbkit.trialBalance,
  profitAndLoss: dbkit.profitAndLoss, balanceSheet: dbkit.balanceSheet, dayBook: dbkit.dayBook,
  outstandingReceivables: dbkit.outstandingReceivables, gstSummary: dbkit.gstSummary,
  constants: { groups: dbkit.TALLY_GROUPS, ledgers: dbkit.DEFAULT_LEDGERS, prefix: dbkit.VOUCHER_PREFIX, key: dbkit.voucherCounterKey("o", "sales", "2026-27") },
};

const LEDGER: Engine = {
  name: "ledger-kit", hook: ledger.ledgerPostingHook,
  seedChartOfAccounts: ledger.seedChartOfAccounts, postVoucher: ledger.postVoucher, cancelVoucher: ledger.cancelVoucher,
  postInvoice: ledger.postInvoice, postPayment: ledger.postPayment, assertBalanced: ledger.assertBalanced,
  salesEntries: ledger.salesEntries, receiptEntries: ledger.receiptEntries,
  ledgerBalance: ledger.ledgerBalance, ledgerStatement: ledger.ledgerStatement, cashBook: ledger.cashBook, trialBalance: ledger.trialBalance,
  profitAndLoss: ledger.profitAndLoss, balanceSheet: ledger.balanceSheet, dayBook: ledger.dayBook,
  outstandingReceivables: ledger.outstandingReceivables, gstSummary: ledger.gstSummary,
  constants: { groups: ledger.TALLY_GROUPS, ledgers: ledger.DEFAULT_LEDGERS, prefix: ledger.VOUCHER_PREFIX, key: ledger.voucherCounterKey("o", "sales", "2026-27") },
};

// ------------------------------------------------------------------ the scenario

type Snapshot = Record<string, unknown>;

/** An error as data: class name, message, HTTP status. */
async function outcome(p: Promise<unknown> | (() => unknown)): Promise<unknown> {
  try {
    return { ok: await (typeof p === "function" ? p() : p) };
  } catch (e) {
    const err = e as Error & { statusCode?: number };
    return { error: err.name, message: err.message, statusCode: err.statusCode, validation: e instanceof ValidationError, conflict: e instanceof ConflictError, notFound: e instanceof NotFoundError };
  }
}

/**
 * One lab's books, start to finish: two financial years, two branches, every voucher type, GST
 * intra- and inter-state, round-off both ways, partial payments in every mode, a refund, a
 * cancelled invoice, lock dates, rejected vouchers, and every report org-wide and per branch.
 * `step` runs after each stage (the trial balance check).
 */
async function scenario(r: Repositories, e: Engine, step: (label: string, orgId: Id) => Promise<void>): Promise<Snapshot> {
  const snap: Snapshot = { constants: e.constants };
  const { org, branch: rpr, owner } = await seedOrganization(r, {
    org: { name: "Sunrise Diagnostics", code: "SUN", gstin: "22AAAAA0000A1Z5" },
    branch: { code: "RPR01", name: "Raipur" },
    owner: { name: "Asha Rao", email: "asha@example.com", passwordHash: "scrypt$test" },
  });
  const orgId = org.id;
  const bls = await r.branches.create({ orgId, code: "BLS01", name: "Bilaspur", kind: "collection_center", active: true });

  // an organisation without a chart of accounts: billing posts nothing
  const bare = await seedOrganization(r, {
    org: { name: "No Books Lab", code: "NOB" }, branch: { code: "NB01", name: "Main" },
    owner: { name: "Ravi Iyer", email: "ravi@example.com", passwordHash: "scrypt$test" },
  });
  const bareP = await registerPatient(r, { orgId: bare.org.id, branchId: bare.branch.id, name: "Meena Das", sex: "female", ageYears: 40 });
  const bareInv = await issueInvoice(r, { orgId: bare.org.id, branchId: bare.branch.id, patientId: bareP.id, items: [{ name: "ESR", ratePaise: 9900 }], payments: [{ amountPaise: 9900, mode: "cash" }], date: at("2026-03-02") });
  snap.withoutChart = {
    vouchers: await r.vouchers.count({ orgId: bare.org.id }),
    postInvoice: await e.postInvoice(r, bareInv.invoice),
    postPayment: await e.postPayment(r, bareInv.payments[0]!, bareInv.invoice.invoiceNo),
    cashBook: await outcome(e.cashBook(r, { orgId: bare.org.id, ...FY25 })),
  };

  // chart of accounts
  const coa = await e.seedChartOfAccounts(r, orgId);
  const again = await e.seedChartOfAccounts(r, orgId);
  snap.chart = { groups: coa.groups, ledgers: coa.ledgers, againGroups: again.groups.length, againLedgers: again.ledgers.length };
  const L = Object.fromEntries((await r.ledgers.find({ orgId })).map((l) => [l.systemKey ?? l.name, l.id]));
  // balanced opening balances (equipment brought in as capital)
  await r.ledgers.update(L["Lab Equipment"]!, { openingPaise: 50000000 });
  await r.ledgers.update(L.capital!, { openingPaise: -50000000 });
  await step("chart of accounts + opening balances", orgId);

  // pure functions
  const ledgerMap = new Map((await r.ledgers.find({ orgId })).filter((l) => l.systemKey).map((l) => [l.systemKey!, l]));
  const fakeInvoice = { id: "inv", items: [{ amountPaise: 9000, discountPaise: 1000 }], taxPaise: 15, totalPaise: 9000, discountPaise: 1000, roundOffPaise: -15 } as any;
  snap.pure = {
    sales: e.salesEntries(fakeInvoice, ledgerMap), salesInterState: e.salesEntries(fakeInvoice, ledgerMap, true),
    receipt: e.receiptEntries({ mode: "wallet", kind: "payment", amountPaise: 500, invoiceId: "inv" } as any, ledgerMap),
    refund: e.receiptEntries({ mode: "cheque", kind: "refund", amountPaise: 500, invoiceId: "inv" } as any, ledgerMap),
    balanced: await outcome(() => e.assertBalanced([{ ledgerId: "a", debitPaise: 1, creditPaise: 0 }, { ledgerId: "b", debitPaise: 0, creditPaise: 1 }])),
    oneLine: await outcome(() => e.assertBalanced([{ ledgerId: "a", debitPaise: 1, creditPaise: 0 }])),
    unbalanced: await outcome(() => e.assertBalanced([{ ledgerId: "a", debitPaise: 2, creditPaise: 0 }, { ledgerId: "b", debitPaise: 0, creditPaise: 1 }])),
    twoSided: await outcome(() => e.assertBalanced([{ ledgerId: "a", debitPaise: 1, creditPaise: 1 }, { ledgerId: "b", debitPaise: 0, creditPaise: 0 }])),
    fractional: await outcome(() => e.assertBalanced([{ ledgerId: "a", debitPaise: 1.5, creditPaise: 0 }, { ledgerId: "b", debitPaise: 0, creditPaise: 1.5 }])),
    negative: await outcome(() => e.assertBalanced([{ ledgerId: "a", debitPaise: -1, creditPaise: 0 }, { ledgerId: "b", debitPaise: 0, creditPaise: -1 }])),
  };

  // billing (db-kit workflows; they post through the engine's hook)
  const p1 = await registerPatient(r, { orgId, branchId: rpr.id, name: "Kiran Mehta", sex: "female", ageYears: 31 });
  const p2 = await registerPatient(r, { orgId, branchId: bls.id, name: "Arjun Nair", sex: "male", ageYears: 52 });
  const inv1 = await issueInvoice(r, {
    orgId, branchId: rpr.id, patientId: p1.id, date: at("2026-03-20"),
    items: [
      { code: "CBC", name: "Complete Blood Count", ratePaise: 39900 },
      { code: "LFT", name: "Liver Function Tests", ratePaise: 64900, discountPaise: 4900 },
      { code: "SYR5", name: "Syringe 5 ml", category: "consumable", qty: 2, ratePaise: 1000, taxPercent: 12 },
    ],
    billDiscountPaise: 5000, payments: [{ amountPaise: 50000, mode: "cash" }],
  }, owner.id);
  // round-off down (1120 → 1100) and up (1180 → 1200), odd tax split (15 → 7 + 8)
  const inv2 = await issueInvoice(r, { orgId, branchId: rpr.id, patientId: p1.id, date: at("2026-03-31", "23:30"), items: [{ name: "Kit A", category: "consumable", ratePaise: 1000, taxPercent: 12 }] });
  const inv3 = await issueInvoice(r, { orgId, branchId: rpr.id, patientId: p2.id, date: at("2026-04-01", "00:30"), items: [{ name: "Kit B", category: "consumable", ratePaise: 1000, taxPercent: 18 }], payments: [{ amountPaise: 1200, mode: "card" }] });
  const inv4 = await issueInvoice(r, { orgId, branchId: bls.id, patientId: p2.id, date: at("2026-04-02"), items: [{ name: "Swab", category: "consumable", ratePaise: 125, taxPercent: 12 }, { name: "TSH", ratePaise: 29900 }] });
  await step("invoices across the financial-year boundary", orgId);

  for (const mode of ["upi", "card", "netbanking", "wallet", "cheque"] as const) await recordPayment(r, { invoiceId: inv1.invoice.id, amountPaise: 7000, mode }, owner.id);
  await recordPayment(r, { invoiceId: inv1.invoice.id, amountPaise: 5000, mode: "cash", kind: "refund" }, owner.id);
  await recordPayment(r, { invoiceId: inv2.invoice.id, amountPaise: 1100, mode: "insurance" });
  await step("payments in every mode + a refund", orgId);

  // inter-state invoice (IGST)
  await r.orgs.update(orgId, { settings: { interState: true } });
  const inv5 = await issueInvoice(r, { orgId, branchId: rpr.id, patientId: p1.id, date: at("2026-04-05"), items: [{ name: "Kit C", category: "consumable", ratePaise: 10000, taxPercent: 12 }] });
  await r.orgs.update(orgId, { settings: {} });
  // a cancelled invoice
  const inv6 = await issueInvoice(r, { orgId, branchId: bls.id, patientId: p2.id, date: at("2026-04-06"), items: [{ name: "Blood Group", ratePaise: 11900 }] });
  await cancelInvoice(r, inv6.invoice.id, "duplicate", owner.id);
  await step("IGST invoice + a cancelled invoice", orgId);
  snap.invoices = [inv1, inv2, inv3, inv4, inv5, inv6].map((x) => x.invoice.invoiceNo);

  // manual vouchers of every type
  const jv = (type: ledger.VoucherInput["type"], date: Date, dr: string, cr: string, paise: number, branchId: Id = rpr.id, narration?: string) =>
    e.postVoucher(r, { orgId, branchId, type, date, narration, entries: [{ ledgerId: L[dr]!, debitPaise: paise, creditPaise: 0 }, { ledgerId: L[cr]!, debitPaise: 0, creditPaise: paise }] }, owner.id);
  await jv("receipt", at("2026-03-01"), "cash", "capital", 1000000, rpr.id, "Capital introduced");
  await jv("contra", at("2026-03-02"), "bank", "cash", 400000, rpr.id, "Cash deposited");
  await jv("payment", at("2026-03-05"), "Rent", "bank", 150000, rpr.id, "March rent");
  await jv("purchase", at("2026-03-06"), "purchases", "bank", 80000, bls.id);
  await jv("journal", at("2026-03-31", "23:59"), "Salaries", "doctors_payable", 20000);
  await jv("journal", at("2026-04-01", "00:00"), "Electricity", "cash", 3000);
  await jv("credit_note", at("2026-04-03"), "sales", "receivables", 1000);
  await jv("debit_note", at("2026-04-04"), "receivables", "sales", 500, bls.id);
  const zeroLines = await e.postVoucher(r, { orgId, branchId: rpr.id, type: "journal", date: at("2026-04-07"), entries: [
    { ledgerId: L.cash!, debitPaise: 700, creditPaise: 0 }, { ledgerId: L.bank!, debitPaise: 0, creditPaise: 0 }, { ledgerId: L.upi!, debitPaise: 0, creditPaise: 700 },
  ] });
  const closing = await jv("closing", at("2026-03-31", "23:59"), "sales", "capital", 2500);
  const toCancel = await jv("journal", at("2026-04-08"), "Rent", "cash", 999);
  snap.cancelled = [await e.cancelVoucher(r, toCancel.id, owner.id), await e.cancelVoucher(r, toCancel.id, owner.id)];
  snap.zeroLines = zeroLines.entries.length;
  await step("manual vouchers of every type", orgId);

  // rejected vouchers
  const bad = (entries: ledger.VoucherInput["entries"]) => outcome(e.postVoucher(r, { orgId, branchId: rpr.id, type: "journal", date: at("2026-04-09"), entries }));
  snap.rejected = {
    unbalanced: await bad([{ ledgerId: L.cash!, debitPaise: 100, creditPaise: 0 }, { ledgerId: L.bank!, debitPaise: 0, creditPaise: 90 }]),
    oneLine: await bad([{ ledgerId: L.cash!, debitPaise: 100, creditPaise: 0 }]),
    fractional: await bad([{ ledgerId: L.cash!, debitPaise: 0.5, creditPaise: 0 }, { ledgerId: L.bank!, debitPaise: 0, creditPaise: 0.5 }]),
    twoSided: await bad([{ ledgerId: L.cash!, debitPaise: 100, creditPaise: 100 }, { ledgerId: L.bank!, debitPaise: 0, creditPaise: 0 }]),
    unknownLedger: await bad([{ ledgerId: L.cash!, debitPaise: 100, creditPaise: 0 }, { ledgerId: "00000000-0000-4000-8000-000000000001", debitPaise: 0, creditPaise: 100 }]),
    unknownVoucher: await outcome(e.cancelVoucher(r, "00000000-0000-4000-8000-000000000002")),
  };
  snap.countersAfterRejects = await r.counters.peek(ledger.voucherCounterKey(orgId, "journal", "2026-27"));
  await step("rejected vouchers leave nothing behind", orgId);

  // lock dates: branch lock, then org lock
  const setLock = (scope: string, lockedUpTo: Date | null) => r.transaction(async (tx) => {
    const [l] = await tx.periodLocks.hold(orgId, [scope], "update");
    await tx.periodLocks.update(l!.id, { lockedUpTo });
  });
  const marchPurchase = (await r.vouchers.find({ orgId, type: "purchase" }))[0]!;
  await setLock(bls.id, new Date(at("2026-04-01", "00:00").getTime() - 1));
  snap.branchLock = {
    onLockDay: await outcome(jv("journal", at("2026-03-31", "18:00"), "cash", "capital", 100, bls.id)),
    otherBranch: await outcome(jv("journal", at("2026-03-31", "18:00"), "cash", "capital", 100, rpr.id)),
    afterLock: await outcome(jv("journal", at("2026-04-01", "00:00"), "cash", "capital", 100, bls.id)),
    cancelLocked: await outcome(e.cancelVoucher(r, marchPurchase.id)),
    invoiceInLockedPeriod: await outcome(issueInvoice(r, { orgId, branchId: bls.id, patientId: p2.id, date: at("2026-03-15"), items: [{ name: "ESR", ratePaise: 9900 }] })),
  };
  await setLock("org", at("2026-03-10", "23:59"));
  snap.orgLock = {
    rpr: await outcome(jv("journal", at("2026-03-10"), "cash", "capital", 100, rpr.id)),
    rprLater: await outcome(jv("journal", at("2026-03-11"), "cash", "capital", 100, rpr.id)),
  };
  await setLock("org", null);
  await setLock(bls.id, null);
  await step("lock dates", orgId);

  // reports
  const ledgers = await r.ledgers.find({ orgId });
  const scopes: { label: string; branchId?: Id }[] = [{ label: "org" }, { label: "RPR01", branchId: rpr.id }, { label: "BLS01", branchId: bls.id }];
  const reports: Snapshot = {};
  for (const s of scopes) {
    const q = { orgId, branchId: s.branchId };
    reports[s.label] = {
      trialBalance: await e.trialBalance(r, q),
      trialBalanceFY25: await e.trialBalance(r, { ...q, asOf: FY25.to }),
      trialBalanceMidMarch: await e.trialBalance(r, { ...q, asOf: at("2026-03-15") }),
      balances: Object.fromEntries(await Promise.all(ledgers.map(async (l) => [l.name, await e.ledgerBalance(r, { ...q, ledgerId: l.id })]))),
      balancesFY25: Object.fromEntries(await Promise.all(ledgers.map(async (l) => [l.name, await e.ledgerBalance(r, { ...q, ledgerId: l.id, asOf: FY25.to })]))),
      receivablesFY26: await e.ledgerStatement(r, { ...q, ledgerId: L.receivables!, ...FY26 }),
      receivablesEver: await e.ledgerStatement(r, { ...q, ledgerId: L.receivables!, ...EVER }),
      bankFY25: await e.ledgerStatement(r, { ...q, ledgerId: L.bank!, ...FY25 }),
      salesFY26: await e.ledgerStatement(r, { ...q, ledgerId: L.sales!, ...FY26 }),
      cashBookFY25: await e.cashBook(r, { ...q, ...FY25 }),
      cashBookFY26: await e.cashBook(r, { ...q, ...FY26 }),
      cashBookEver: await e.cashBook(r, { ...q, ...EVER }),
      profitAndLossFY25: await e.profitAndLoss(r, { ...q, ...FY25 }),
      profitAndLossFY26: await e.profitAndLoss(r, { ...q, ...FY26 }),
      profitAndLossEver: await e.profitAndLoss(r, { ...q, ...EVER }),
      balanceSheetFY25: await e.balanceSheet(r, { ...q, asOf: FY25.to }),
      balanceSheetNow: await e.balanceSheet(r, { ...q, asOf: EVER.to }),
      dayBook: await e.dayBook(r, { ...q, ...EVER }),
      dayBookFY25Journal: await e.dayBook(r, { ...q, ...FY25, type: "journal" }),
      dayBookSales: await e.dayBook(r, { ...q, ...EVER, type: "sales" }),
      outstanding: await e.outstandingReceivables(r, { ...q, asOf: at("2026-06-15") }),
      outstandingLater: await e.outstandingReceivables(r, { ...q, asOf: at("2026-07-30") }),
      gstFY25: await e.gstSummary(r, { ...q, ...FY25 }),
      gstFY26: await e.gstSummary(r, { ...q, ...FY26 }),
    };
  }
  reports.unknownLedger = await outcome(e.ledgerBalance(r, { orgId, ledgerId: "00000000-0000-4000-8000-000000000003" }));
  reports.unknownStatement = await outcome(e.ledgerStatement(r, { orgId, ledgerId: "00000000-0000-4000-8000-000000000003", ...FY25 }));
  snap.reports = reports;

  // the stored books
  snap.vouchers = await r.vouchers.listByDate({ orgId, includeCancelled: true });
  snap.ledgerEntries = await r.ledgerEntries.list({ orgId });
  snap.audit = (await r.audit.find({ orgId })).filter((a) => a.action.startsWith("voucher.")).map((a) => ({ action: a.action, entityId: a.entityId, data: a.data, userId: a.userId }));
  snap.closing = closing.voucherNo;
  return snap;
}

// ------------------------------------------------------------------ normalising a snapshot

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9a-f]{24}\b/g;

/** id → readable label (ledger name, voucher number, invoice number…), for one database. */
async function labels(r: Repositories): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const o of await r.orgs.find()) m.set(o.id, `org:${o.code}`);
  for (const b of await r.branches.find()) m.set(b.id, `branch:${b.code}`);
  for (const u of await r.users.find()) m.set(u.id, `user:${u.email}`);
  for (const p of await r.patients.find()) m.set(p.id, `patient:${p.uhid}`);
  for (const g of await r.accountGroups.find()) m.set(g.id, `group:${g.name}`);
  for (const l of await r.ledgers.find()) m.set(l.id, `ledger:${l.name}`);
  for (const i of await r.invoices.find()) m.set(i.id, `invoice:${i.invoiceNo}`);
  const vouchers = await r.vouchers.find();
  for (const v of vouchers) m.set(v.id, `voucher:${v.voucherNo}`);
  for (const v of vouchers) if (v.paymentId) m.set(v.paymentId, `payment:${v.voucherNo}`);
  for (const t of ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"]) m.set(t, `missing:${t.slice(-1)}`);
  return m;
}

const SKIP = new Set(["id", "createdAt", "updatedAt", "at"]);

/** Ids → labels, Dates → ISO (or "now" for the ones taken from the clock), timestamps dropped. */
function normalise(x: unknown, ids: Map<string, string>): unknown {
  if (x instanceof Date) return Math.abs(x.getTime() - Date.now()) < 3600_000 ? "now" : x.toISOString();
  if (typeof x === "string") return x.replace(UUID, (s) => ids.get(s) ?? `UNKNOWN-ID`);
  if (Array.isArray(x)) return x.map((v) => normalise(v, ids));
  if (x instanceof Map) return normalise(Object.fromEntries(x), ids);
  if (x && typeof x === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) if (!SKIP.has(k) && v !== undefined) out[k] = normalise(v, ids);
    return out;
  }
  return x;
}

/** First differing path between two normalised values, for a readable failure. */
function firstDiff(a: unknown, b: unknown, path = ""): string | null {
  if (isDeepStrictEqual(a, b)) return null;
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDiff((a as any)[k], (b as any)[k], `${path}.${k}`);
      if (d) return d;
    }
  }
  return `${path}: ${JSON.stringify(a)?.slice(0, 300)} ≠ ${JSON.stringify(b)?.slice(0, 300)}`;
}

// ------------------------------------------------------------------ per backend

type Open = (name: string, posting?: PostingHook) => Promise<Db>;

async function backendSuite(backend: Backend, open: Open) {
  const tag = `[${backend}]`;

  // 1. identical behaviour: db-kit's engine and ledger-kit's on fresh databases, same scenario
  console.log(`\n${tag} identical behaviour: db-kit 1.1.0 accounting vs ledger-kit`);
  const snaps: Record<string, unknown> = {};
  for (const e of [DBKIT, LEDGER]) {
    const db = await open(e.name === "db-kit" ? "books_dbkit" : "books_ledger", e.hook);
    const r = db.rawRepos;
    const step = async (label: string, orgId: Id) => {
      const tb = await e.trialBalance(r, { orgId });
      const bs = await e.balanceSheet(r, { orgId, asOf: EVER.to });
      if (e.name === "ledger-kit")
        ok(tb.differencePaise === 0 && tb.totalDebitPaise === tb.totalCreditPaise && bs.differencePaise === 0, `${tag} trial balance and balance sheet balance after: ${label} (Dr ${tb.totalDebitPaise} = Cr ${tb.totalCreditPaise})`);
    };
    const raw = await scenario(r, e, step);
    const n = normalise(raw, await labels(r)) as Snapshot;
    // row order between equal keys (lines of one voucher, audit lines) is the database's, not the engine's
    for (const k of ["ledgerEntries", "audit"]) n[k] = (n[k] as unknown[]).map((x) => JSON.stringify(x)).sort().map((x) => JSON.parse(x));
    snaps[e.name] = n;
    await db.close();
  }
  const a = snaps["db-kit"] as Snapshot;
  const b = snaps["ledger-kit"] as Snapshot;
  ok(!JSON.stringify(b).includes("UNKNOWN-ID"), `${tag} every id in the snapshot maps to a name`);
  for (const k of Object.keys(a)) {
    const d = firstDiff(a[k], b[k], k);
    ok(!d, `${tag} identical: ${k}${d ? ` — ${d}` : ""}`);
  }
  ok(Object.keys(a).length === Object.keys(b).length, `${tag} same snapshot sections (${Object.keys(a).length})`);

  // a few anchors, so "identical" cannot mean "identically empty"
  const v = b.vouchers as { voucherNo: string; status: string; type: string }[];
  const nos = v.map((x) => x.voucherNo);
  ok(nos.includes("SAL/2025-26/000002") && nos.includes("SAL/2026-27/000001") && nos.includes("JRN/2025-26/000001") && nos.includes("JRN/2026-27/000001"), `${tag} numbering restarts on 1 April IST (${v.length} vouchers)`);
  ok(new Set(v.map((x) => x.type)).size === 9, `${tag} all nine voucher types posted`);
  ok(v.filter((x) => x.status === "cancelled").length === 2, `${tag} two cancelled vouchers keep their numbers`);
  const rep = b.reports as any;
  ok(rep.org.trialBalance.rows.length > 10 && rep.org.gstFY26.igstPaise === 1200 && rep.org.gstFY26.cgstPaise > 0, `${tag} reports carry real numbers (IGST ${rep.org.gstFY26.igstPaise}, CGST ${rep.org.gstFY26.cgstPaise})`);
  ok((b.branchLock as any).onLockDay.error === "PeriodLockedError" && (b.branchLock as any).otherBranch.ok, `${tag} lock dates refuse the locked branch only`);
  ok((b.withoutChart as any).vouchers === 0 && (b.withoutChart as any).postInvoice === null, `${tag} no chart of accounts: nothing posted`);

  // 2. ledger-kit carries on a series db-kit started (same counters, same numbers)
  console.log(`${tag} switching an existing database from db-kit to ledger-kit`);
  const old = await open("books_dbkit", ledger.ledgerPostingHook);
  const r = old.rawRepos;
  const org = (await r.orgs.findOne({ code: "SUN" }))!;
  const rpr = (await r.branches.findOne({ orgId: org.id, code: "RPR01" }))!;
  const cash = (await r.ledgers.findBySystemKey(org.id, "cash"))!;
  const capital = (await r.ledgers.findBySystemKey(org.id, "capital"))!;
  const lastJrn = (await r.vouchers.find({ orgId: org.id, type: "journal" })).map((x) => x.voucherNo).filter((n) => n.startsWith("JRN/2026-27/")).sort().at(-1)!;
  const next = await ledger.postVoucher(r, { orgId: org.id, branchId: rpr.id, type: "journal", date: at("2026-05-01"), entries: [{ ledgerId: cash.id, debitPaise: 100, creditPaise: 0 }, { ledgerId: capital.id, debitPaise: 0, creditPaise: 100 }] });
  ok(Number(next.voucherNo.slice(-6)) === Number(lastJrn.slice(-6)) + 1, `${tag} ledger-kit continues db-kit's series: ${lastJrn} → ${next.voucherNo}`);
  const patient = (await r.patients.find({ orgId: org.id }))[0]!;
  const lastSal = (await r.vouchers.find({ orgId: org.id, type: "sales" })).map((x) => x.voucherNo).filter((n) => n.startsWith("SAL/2026-27/")).sort().at(-1)!;
  const inv = await issueInvoice(r, { orgId: org.id, branchId: rpr.id, patientId: patient.id, date: at("2026-05-02"), items: [{ name: "ESR", ratePaise: 9900 }], payments: [{ amountPaise: 9900, mode: "upi" }] });
  const sal = (await r.vouchers.find({ invoiceId: inv.invoice.id } as any)).map((x) => x.voucherNo).sort();
  ok(sal.includes(`SAL/2026-27/${String(Number(lastSal.slice(-6)) + 1).padStart(6, "0")}`) && sal.some((n) => n.startsWith("RCT/")), `${tag} ledgerPostingHook posts the next sales and receipt vouchers (${sal.join(", ")})`);
  await dbkit.cancelVoucher(r, next.id);
  ok((await ledger.trialBalance(r, { orgId: org.id })).differencePaise === 0 && (await dbkit.trialBalance(r, { orgId: org.id })).totalDebitPaise === (await ledger.trialBalance(r, { orgId: org.id })).totalDebitPaise, `${tag} mixed history: both engines read the same balanced books`);

  // 3. ledgerPostingHook runs inside billing's transaction: a failure rolls the invoice back
  const invoicesBefore = await r.invoices.count({ orgId: org.id });
  const vouchersBefore = await r.vouchers.count({ orgId: org.id });
  const failing = await open("books_dbkit", {
    ...ledger.ledgerPostingHook,
    async paymentRecorded(tx, p, no, a) { await ledger.ledgerPostingHook.paymentRecorded(tx, p, no, a); throw new ConflictError("posting failed"); },
  });
  await rejects(issueInvoice(failing.rawRepos, { orgId: org.id, branchId: rpr.id, patientId: patient.id, date: at("2026-05-03"), items: [{ name: "ESR", ratePaise: 9900 }], payments: [{ amountPaise: 100, mode: "cash" }] }), ConflictError, `${tag} a failing hook fails the invoice`);
  ok((await r.invoices.count({ orgId: org.id })) === invoicesBefore && (await r.vouchers.count({ orgId: org.id })) === vouchersBefore, `${tag} …and rolls back the invoice and its vouchers`);
  await failing.close();

  // 4. atomicity: a voucher posted inside a failing transaction leaves no voucher, entry or number
  const key = ledger.voucherCounterKey(org.id, "journal", "2026-27");
  const seq = await r.counters.peek(key);
  const entries = (await r.ledgerEntries.list({ orgId: org.id })).length;
  await rejects(r.transaction(async (tx) => {
    await ledger.postVoucher(tx, { orgId: org.id, branchId: rpr.id, type: "journal", date: at("2026-05-04"), entries: [{ ledgerId: cash.id, debitPaise: 100, creditPaise: 0 }, { ledgerId: capital.id, debitPaise: 0, creditPaise: 100 }] });
    throw new ConflictError("boom");
  }), ConflictError, `${tag} error after postVoucher inside a transaction propagates`);
  ok((await r.counters.peek(key)) === seq && (await r.ledgerEntries.list({ orgId: org.id })).length === entries, `${tag} rollback: no voucher number used, no ledger entries`);

  // 5. lock dates under concurrency: a lock moved while a posting is in flight still stops it
  let lockHeld!: () => void;
  const holding = new Promise<void>((res) => (lockHeld = res));
  const mover = r.transaction(async (tx) => {
    const [l] = await tx.periodLocks.hold(org.id, ["org"], "update");
    lockHeld();
    await sleep(300);
    await tx.periodLocks.update(l!.id, { lockedUpTo: at("2026-05-31", "23:59") });
  });
  await holding;
  await rejects(ledger.postVoucher(r, { orgId: org.id, branchId: rpr.id, type: "journal", date: at("2026-05-20"), entries: [{ ledgerId: cash.id, debitPaise: 100, creditPaise: 0 }, { ledgerId: capital.id, debitPaise: 0, creditPaise: 100 }] }), PeriodLockedError, `${tag} concurrent lock change: the in-flight posting waits, then fails`);
  await mover;
  const mayInvoiceVoucher = (await r.vouchers.find({ invoiceId: inv.invoice.id, type: "sales" } as any))[0]!;
  await rejects(ledger.cancelVoucher(r, mayInvoiceVoucher.id), PeriodLockedError, `${tag} cancelling a voucher in the locked period fails`);
  await r.transaction(async (tx) => {
    for (const l of await tx.periodLocks.hold(org.id, ["org"], "update")) await tx.periodLocks.update(l.id, { lockedUpTo: null });
  });
  ok((await ledger.trialBalance(r, { orgId: org.id })).differencePaise === 0, `${tag} books balance at the end`);
  await old.close();
}

// ------------------------------------------------------------------ engine boundary

/** ledger-kit is a port, not a wrapper: its source must not call db-kit's accounting functions. */
function engineBoundary() {
  console.log("\n[engine boundary]");
  const engine = /\b(postVoucher|cancelVoucher|seedChartOfAccounts|postInvoice|postPayment|unpostInvoice|assertBalanced|assertPeriodOpen|salesEntries|receiptEntries|defaultPostingHook|trialBalance|profitAndLoss|balanceSheet|ledgerStatement|ledgerBalance|dayBook|cashBook|gstSummary|outstandingReceivables|TALLY_GROUPS|DEFAULT_LEDGERS|VOUCHER_PREFIX|voucherCounterKey|UnbalancedVoucherError)\b/;
  const offenders: string[] = [];
  for (const f of readdirSync("src")) {
    const imports = readFileSync(join("src", f), "utf8").match(/import[^;]*from\s+"@mgpl-diagnostics\/db-kit"/g) ?? [];
    if (imports.some((i) => engine.test(i))) offenders.push(f);
  }
  ok(offenders.length === 0, `src/ imports no accounting function from db-kit${offenders.length ? ` (offenders: ${offenders.join(", ")})` : ""}`);
  const exported = Object.keys(ledger);
  const wanted = ["seedChartOfAccounts", "postVoucher", "cancelVoucher", "assertBalanced", "assertPeriodOpen", "postInvoice", "postPayment", "unpostInvoice", "ledgerPostingHook",
    "trialBalance", "ledgerBalance", "ledgerStatement", "cashBook", "dayBook", "profitAndLoss", "balanceSheet", "outstandingReceivables", "gstSummary", "UnbalancedVoucherError"];
  ok(wanted.every((w) => exported.includes(w)), `exports what finance-kit and db-kit need (${wanted.length} names)`);
  ok(ledger.UnbalancedVoucherError.prototype instanceof ValidationError && new ledger.UnbalancedVoucherError(1, 2).statusCode === 422, "UnbalancedVoucherError is a db-kit ValidationError (422)");
}

// ------------------------------------------------------------------ main

async function main() {
  engineBoundary();

  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await backendSuite("mongo", (name, posting) => createDb({ backend: "mongo", mongo: { uri: rs.getUri(name) }, posting }));
  await rs.stop();

  const dir = join(tmpdir(), `ledger-kit-pg-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "postgres", port: 54333, persistent: false });
  await pg.initialise();
  await pg.start();
  const created = new Set<string>();
  await backendSuite("pg", async (name, posting) => {
    if (!created.has(name)) { await pg.createDatabase(name); created.add(name); }
    return createDb({ backend: "pg", pg: { url: `postgres://postgres:postgres@localhost:54333/${name}` }, posting });
  });
  await pg.stop();
  rmSync(dir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed in ${((Date.now() - START) / 1000).toFixed(1)}s`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
