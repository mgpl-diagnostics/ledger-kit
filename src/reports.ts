import { NotFoundError, type AccountGroup, type AccountNature, type Id, type Invoice, type Ledger, type Paise, type Repositories, type Voucher, type VoucherType } from "@mgpl-diagnostics/db-kit";

/**
 * Books reports, computed from postings. Balances are in paise, positive = Debit.
 * All reports accept an optional branchId to see one branch's books.
 */

export interface Scope {
  orgId: Id;
  branchId?: Id;
}

const day = 24 * 3600 * 1000;
const before = (d: Date) => new Date(d.getTime() - 1);

async function chart(repos: Repositories, orgId: Id) {
  const [groups, ledgers] = await Promise.all([repos.accountGroups.find({ orgId }), repos.ledgers.find({ orgId })]);
  const gById = new Map(groups.map((g) => [g.id, g]));
  const primary = (g: AccountGroup): AccountGroup => (g.parentId ? primary(gById.get(g.parentId)!) : g);
  return { groups, ledgers, gById, primary };
}

// ------------------------------------------------------------------ ledgers

export async function ledgerBalance(repos: Repositories, scope: Scope & { ledgerId: Id; asOf?: Date }): Promise<Paise> {
  const ledger = await repos.ledgers.get(scope.ledgerId);
  if (!ledger) throw new NotFoundError("Ledger", scope.ledgerId);
  const [t] = await repos.ledgerEntries.totals({ orgId: scope.orgId, branchId: scope.branchId, ledgerId: scope.ledgerId, to: scope.asOf });
  return (scope.branchId ? 0 : ledger.openingPaise) + (t ? t.debitPaise - t.creditPaise : 0);
}

export interface StatementRow {
  date: Date;
  voucherNo: string;
  voucherType: VoucherType;
  debitPaise: Paise;
  creditPaise: Paise;
  /** Running balance after this row (positive = Dr). */
  balancePaise: Paise;
  invoiceId?: Id | null;
}

/** Ledger account / cash book / bank book: opening, every posting with running balance, closing. */
export async function ledgerStatement(repos: Repositories, q: Scope & { ledgerId: Id; from: Date; to: Date }) {
  const ledger = await repos.ledgers.get(q.ledgerId);
  if (!ledger) throw new NotFoundError("Ledger", q.ledgerId);
  const opening = await ledgerBalance(repos, { ...q, asOf: before(q.from) });
  const entries = await repos.ledgerEntries.list({ orgId: q.orgId, branchId: q.branchId, ledgerId: q.ledgerId, from: q.from, to: q.to });
  let bal = opening;
  let dr = 0;
  let cr = 0;
  const rows: StatementRow[] = entries.map((e) => {
    bal += e.debitPaise - e.creditPaise;
    dr += e.debitPaise;
    cr += e.creditPaise;
    return { date: e.date, voucherNo: e.voucherNo, voucherType: e.voucherType, debitPaise: e.debitPaise, creditPaise: e.creditPaise, balancePaise: bal, invoiceId: e.invoiceId };
  });
  return { ledger, openingPaise: opening, rows, totalDebitPaise: dr, totalCreditPaise: cr, closingPaise: bal };
}

/** Cash book = the statement of the "cash" system ledger. */
export async function cashBook(repos: Repositories, q: Scope & { from: Date; to: Date }) {
  const cash = await repos.ledgers.findBySystemKey(q.orgId, "cash");
  if (!cash) throw new NotFoundError("Ledger with systemKey", "cash");
  return ledgerStatement(repos, { ...q, ledgerId: cash.id });
}

// ------------------------------------------------------------------ trial balance

export interface TrialBalanceRow {
  ledger: Ledger;
  group: AccountGroup;
  primaryGroup: AccountGroup;
  debitPaise: Paise;
  creditPaise: Paise;
}

/** Closing balance of every ledger, on its debit or credit side. Debits = credits when the books are right. */
export async function trialBalance(repos: Repositories, q: Scope & { asOf?: Date }) {
  const { ledgers, gById, primary } = await chart(repos, q.orgId);
  const totals = new Map((await repos.ledgerEntries.totals({ orgId: q.orgId, branchId: q.branchId, to: q.asOf })).map((t) => [t.ledgerId, t]));
  const rows: TrialBalanceRow[] = [];
  let dr = 0;
  let cr = 0;
  for (const l of ledgers) {
    const t = totals.get(l.id);
    const bal = (q.branchId ? 0 : l.openingPaise) + (t ? t.debitPaise - t.creditPaise : 0);
    if (bal === 0) continue;
    const group = gById.get(l.groupId)!;
    rows.push({ ledger: l, group, primaryGroup: primary(group), debitPaise: bal > 0 ? bal : 0, creditPaise: bal < 0 ? -bal : 0 });
    if (bal > 0) dr += bal;
    else cr -= bal;
  }
  rows.sort((a, b) => a.primaryGroup.name.localeCompare(b.primaryGroup.name) || a.ledger.name.localeCompare(b.ledger.name));
  /** Non-zero only when opening balances were entered unbalanced (Tally shows "Difference in opening balances"). */
  return { rows, totalDebitPaise: dr, totalCreditPaise: cr, differencePaise: dr - cr };
}

// ------------------------------------------------------------------ P&L and balance sheet

export interface GroupLine {
  group: AccountGroup;
  amountPaise: Paise;
  ledgers: { ledger: Ledger; amountPaise: Paise }[];
}

/** Income and expenses for a period, by primary group; gross and net profit. Year-end closing vouchers are left out. */
export async function profitAndLoss(repos: Repositories, q: Scope & { from: Date; to: Date }) {
  const { ledgers, gById, primary } = await chart(repos, q.orgId);
  const totals = new Map((await repos.ledgerEntries.totals({ orgId: q.orgId, branchId: q.branchId, from: q.from, to: q.to, excludeVoucherTypes: ["closing"] })).map((t) => [t.ledgerId, t]));
  const lines = new Map<Id, GroupLine>();
  for (const l of ledgers) {
    const p = primary(gById.get(l.groupId)!);
    if (p.nature !== "income" && p.nature !== "expenses") continue;
    const t = totals.get(l.id);
    if (!t) continue;
    // income is a credit balance, expense a debit balance: show both as positive amounts
    const amount = p.nature === "income" ? t.creditPaise - t.debitPaise : t.debitPaise - t.creditPaise;
    if (amount === 0) continue;
    const line = lines.get(p.id) ?? { group: p, amountPaise: 0, ledgers: [] };
    line.amountPaise += amount;
    line.ledgers.push({ ledger: l, amountPaise: amount });
    lines.set(p.id, line);
  }
  const all = [...lines.values()];
  const sum = (nature: AccountNature, gp: boolean) => all.filter((x) => x.group.nature === nature && x.group.affectsGrossProfit === gp).reduce((s, x) => s + x.amountPaise, 0);
  const grossProfit = sum("income", true) - sum("expenses", true);
  const netProfit = grossProfit + sum("income", false) - sum("expenses", false);
  return {
    income: all.filter((x) => x.group.nature === "income"),
    expenses: all.filter((x) => x.group.nature === "expenses"),
    grossProfitPaise: grossProfit,
    netProfitPaise: netProfit,
  };
}

/** Assets and liabilities at a date; profit to date is shown on the liabilities side, like Tally. */
export async function balanceSheet(repos: Repositories, q: Scope & { asOf: Date }) {
  const { ledgers, gById, primary } = await chart(repos, q.orgId);
  const totals = new Map((await repos.ledgerEntries.totals({ orgId: q.orgId, branchId: q.branchId, to: q.asOf })).map((t) => [t.ledgerId, t]));
  const lines = new Map<Id, GroupLine>();
  let profit = 0;
  for (const l of ledgers) {
    const p = primary(gById.get(l.groupId)!);
    const t = totals.get(l.id);
    const bal = (q.branchId ? 0 : l.openingPaise) + (t ? t.debitPaise - t.creditPaise : 0); // +Dr
    if (bal === 0) continue;
    if (p.nature === "income" || p.nature === "expenses") {
      profit -= bal; // income credit (−) raises profit, expense debit (+) lowers it
      continue;
    }
    const amount = p.nature === "assets" ? bal : -bal;
    const line = lines.get(p.id) ?? { group: p, amountPaise: 0, ledgers: [] };
    line.amountPaise += amount;
    line.ledgers.push({ ledger: l, amountPaise: amount });
    lines.set(p.id, line);
  }
  const all = [...lines.values()];
  const assets = all.filter((x) => x.group.nature === "assets");
  const liabilities = all.filter((x) => x.group.nature === "liabilities");
  const totalAssets = assets.reduce((s, x) => s + x.amountPaise, 0);
  const totalLiabilities = liabilities.reduce((s, x) => s + x.amountPaise, 0) + profit;
  return { assets, liabilities, profitPaise: profit, totalAssetsPaise: totalAssets, totalLiabilitiesPaise: totalLiabilities, differencePaise: totalAssets - totalLiabilities };
}

// ------------------------------------------------------------------ day book, outstanding, GST

export async function dayBook(repos: Repositories, q: Scope & { from: Date; to: Date; type?: VoucherType }): Promise<Voucher[]> {
  return repos.vouchers.listByDate({ orgId: q.orgId, branchId: q.branchId, from: q.from, to: q.to, type: q.type, includeCancelled: true });
}

export interface OutstandingRow {
  invoice: Invoice;
  ageDays: number;
  bucket: "0-30" | "31-60" | "61-90" | "90+";
}

/** Bills receivable with ageing buckets (Tally "Bills Receivable"). */
export async function outstandingReceivables(repos: Repositories, q: Scope & { asOf?: Date }) {
  const asOf = q.asOf ?? new Date();
  const invoices = await repos.invoices.listOutstanding(q.orgId, q.branchId);
  const rows: OutstandingRow[] = invoices.map((invoice) => {
    const ageDays = Math.max(0, Math.floor((asOf.getTime() - (invoice.issuedAt ?? invoice.createdAt).getTime()) / day));
    const bucket = ageDays <= 30 ? "0-30" : ageDays <= 60 ? "31-60" : ageDays <= 90 ? "61-90" : "90+";
    return { invoice, ageDays, bucket };
  });
  const buckets = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 } as Record<OutstandingRow["bucket"], Paise>;
  for (const r of rows) buckets[r.bucket] += r.invoice.duePaise;
  return { rows, buckets, totalDuePaise: rows.reduce((s, r) => s + r.invoice.duePaise, 0) };
}

/** Output tax for a period from the GST ledgers, with the taxable value from sales. */
export async function gstSummary(repos: Repositories, q: Scope & { from: Date; to: Date }) {
  const keyed = new Map<string, Ledger>();
  for (const l of await repos.ledgers.find({ orgId: q.orgId })) if (l.systemKey) keyed.set(l.systemKey, l);
  const totals = new Map((await repos.ledgerEntries.totals({ orgId: q.orgId, branchId: q.branchId, from: q.from, to: q.to, excludeVoucherTypes: ["closing"] })).map((t) => [t.ledgerId, t]));
  const credit = (key: string) => {
    const l = keyed.get(key);
    const t = l && totals.get(l.id);
    return t ? t.creditPaise - t.debitPaise : 0;
  };
  const cgst = credit("cgst"), sgst = credit("sgst"), igst = credit("igst");
  // taxable value = sales (gross) less discounts allowed
  return { taxableValuePaise: credit("sales") + credit("discount"), cgstPaise: cgst, sgstPaise: sgst, igstPaise: igst, totalTaxPaise: cgst + sgst + igst };
}
