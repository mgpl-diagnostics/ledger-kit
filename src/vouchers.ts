import {
  financialYear, NotFoundError, PeriodLockedError, ValidationError, type Id, type Repositories, type Voucher, type VoucherEntry, type VoucherType,
} from "@mgpl-diagnostics/db-kit";

/**
 * Vouchers: numbered per type per financial year, balanced, stored with one LedgerEntry per line,
 * refused in a locked period. Voucher numbers and counter keys are the ones db-kit 1.1.0 uses, so a
 * series started there continues here without a gap or a repeat.
 */

export const VOUCHER_PREFIX: Record<VoucherType, string> = {
  sales: "SAL", receipt: "RCT", payment: "PMT", journal: "JRN", contra: "CTR", credit_note: "CRN", debit_note: "DBN", purchase: "PUR", closing: "CLS",
};

export const voucherCounterKey = (orgId: Id, type: VoucherType, fy: string) => `voucher:${orgId}:${type}:${fy}`;

export interface VoucherInput {
  orgId: Id;
  branchId: Id;
  type: VoucherType;
  date?: Date;
  narration?: string;
  entries: VoucherEntry[];
  invoiceId?: Id | null;
  paymentId?: Id | null;
}

export class UnbalancedVoucherError extends ValidationError {
  readonly statusCode = 422;
  constructor(debit: number, credit: number) {
    super(`Voucher does not balance: debit ${debit} ≠ credit ${credit} paise`);
    this.name = "UnbalancedVoucherError";
  }
}

/** Throws unless every line is one-sided whole paise and debits equal credits. */
export function assertBalanced(entries: VoucherEntry[]): void {
  if (entries.length < 2) throw new UnbalancedVoucherError(0, 0);
  let dr = 0;
  let cr = 0;
  for (const e of entries) {
    const okDr = Number.isInteger(e.debitPaise) && e.debitPaise >= 0;
    const okCr = Number.isInteger(e.creditPaise) && e.creditPaise >= 0;
    if (!okDr || !okCr || (e.debitPaise > 0) === (e.creditPaise > 0)) throw new ValidationError("Each voucher line needs exactly one positive debit or credit (whole paise)");
    dr += e.debitPaise;
    cr += e.creditPaise;
  }
  if (dr !== cr) throw new UnbalancedVoucherError(dr, cr);
}

// ------------------------------------------------------------------ lock dates

/**
 * Inside a transaction: throws PeriodLockedError when `date` is on or before the organisation's or
 * the branch's lock date. Holds both lock rows until commit, so a concurrent lock change cannot slip
 * in between this check and the commit. postVoucher and cancelVoucher call it.
 */
export async function assertPeriodOpen(tx: Repositories, orgId: Id, branchId: Id, date: Date): Promise<void> {
  for (const lock of await tx.periodLocks.hold(orgId, ["org", branchId], "share"))
    if (lock.lockedUpTo && date.getTime() <= lock.lockedUpTo.getTime()) throw new PeriodLockedError(date, lock.lockedUpTo, lock.scope);
}

// ------------------------------------------------------------------ post and cancel

/** Numbers, stores and posts a voucher atomically (voucher + its ledger entries). Refused in a locked period. */
export async function postVoucher(repos: Repositories, input: VoucherInput, actorId?: Id): Promise<Voucher> {
  const entries = input.entries.filter((e) => e.debitPaise > 0 || e.creditPaise > 0);
  assertBalanced(entries);
  const date = input.date ?? new Date();
  return repos.transaction(async (tx) => {
    await assertPeriodOpen(tx, input.orgId, input.branchId, date);
    const ids = [...new Set(entries.map((e) => e.ledgerId))];
    for (const id of ids) if (!(await tx.ledgers.get(id))) throw new NotFoundError("Ledger", id);
    const fy = financialYear(date);
    const seq = await tx.counters.next(voucherCounterKey(input.orgId, input.type, fy));
    const voucher = await tx.vouchers.create({
      orgId: input.orgId, branchId: input.branchId, type: input.type, voucherNo: `${VOUCHER_PREFIX[input.type]}/${fy}/${String(seq).padStart(6, "0")}`,
      date, narration: input.narration, entries, invoiceId: input.invoiceId ?? null, paymentId: input.paymentId ?? null, status: "posted", createdBy: actorId ?? null,
    });
    await tx.ledgerEntries.insertMany(entries.map((e) => ({
      orgId: input.orgId, branchId: input.branchId, voucherId: voucher.id, voucherType: input.type, voucherNo: voucher.voucherNo,
      ledgerId: e.ledgerId, date, debitPaise: e.debitPaise, creditPaise: e.creditPaise, invoiceId: e.invoiceId ?? null,
    })));
    await tx.audit.log({ orgId: input.orgId, branchId: input.branchId, userId: actorId ?? null, action: `voucher.${input.type}`, entity: "voucher", entityId: voucher.id, data: { voucherNo: voucher.voucherNo } });
    return voucher;
  });
}

/** Cancels a voucher: the number stays, the postings are removed. Refused in a locked period. */
export async function cancelVoucher(repos: Repositories, voucherId: Id, actorId?: Id): Promise<Voucher> {
  return repos.transaction(async (tx) => {
    const v = await tx.vouchers.get(voucherId);
    if (!v) throw new NotFoundError("Voucher", voucherId);
    if (v.status === "cancelled") return v;
    await assertPeriodOpen(tx, v.orgId, v.branchId, v.date);
    await tx.ledgerEntries.deleteByVoucher(voucherId);
    const out = (await tx.vouchers.update(voucherId, { status: "cancelled" }))!;
    await tx.audit.log({ orgId: v.orgId, branchId: v.branchId, userId: actorId ?? null, action: "voucher.cancel", entity: "voucher", entityId: voucherId });
    return out;
  });
}
