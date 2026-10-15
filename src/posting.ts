import { NotFoundError, type Id, type Invoice, type Ledger, type Payment, type PaymentMode, type PostingHook, type Repositories, type Voucher, type VoucherEntry } from "@mgpl-diagnostics/db-kit";
import { cancelVoucher, postVoucher } from "./vouchers";

/**
 * Automatic posting for db-kit's billing workflows:
 *
 *   Sales voucher (invoice)       Dr Patient Receivables  total
 *                                 Dr Discount Allowed     discount
 *                                 Cr Lab Test Income      gross (qty × rate)
 *                                 Cr Output CGST / SGST   tax  (IGST when the org's settings.interState is set)
 *                                 Dr/Cr Round Off         rounding
 *   Receipt voucher (payment)     Dr Cash / Bank / UPI / Card    Cr Patient Receivables
 *   Payment voucher (refund)      Dr Patient Receivables         Cr Cash / Bank / UPI / Card
 *
 * Without a chart of accounts (no "receivables" and "sales" ledgers) nothing is posted.
 */

/** The system ledger a payment mode lands in. */
export const MODE_LEDGER: Record<PaymentMode, string> = {
  cash: "cash", upi: "upi", wallet: "upi", card: "card", netbanking: "bank", cheque: "bank", insurance: "bank",
};

/** Ledgers by systemKey, or null when the organisation has no chart of accounts (posting is skipped). */
export async function systemLedgers(repos: Repositories, orgId: Id): Promise<Map<string, Ledger> | null> {
  const all = await repos.ledgers.find({ orgId });
  const map = new Map<string, Ledger>();
  for (const l of all) if (l.systemKey) map.set(l.systemKey, l);
  return map.has("receivables") && map.has("sales") ? map : null;
}

const need = (m: Map<string, Ledger>, key: string) => {
  const l = m.get(key);
  if (!l) throw new NotFoundError("Ledger with systemKey", key);
  return l.id;
};

export function salesEntries(invoice: Invoice, ledgers: Map<string, Ledger>, interState = false): VoucherEntry[] {
  const gross = invoice.items.reduce((s, i) => s + i.amountPaise + i.discountPaise, 0);
  const tax = invoice.taxPaise;
  const cgst = Math.floor(tax / 2);
  const r = invoice.roundOffPaise;
  const e: VoucherEntry[] = [
    { ledgerId: need(ledgers, "receivables"), debitPaise: invoice.totalPaise, creditPaise: 0, invoiceId: invoice.id },
    { ledgerId: need(ledgers, "discount"), debitPaise: invoice.discountPaise, creditPaise: 0 },
    { ledgerId: need(ledgers, "sales"), debitPaise: 0, creditPaise: gross },
  ];
  if (tax > 0) {
    if (interState) e.push({ ledgerId: need(ledgers, "igst"), debitPaise: 0, creditPaise: tax });
    else e.push({ ledgerId: need(ledgers, "cgst"), debitPaise: 0, creditPaise: cgst }, { ledgerId: need(ledgers, "sgst"), debitPaise: 0, creditPaise: tax - cgst });
  }
  if (r !== 0) e.push({ ledgerId: need(ledgers, "round_off"), debitPaise: r < 0 ? -r : 0, creditPaise: r > 0 ? r : 0 });
  return e.filter((x) => x.debitPaise > 0 || x.creditPaise > 0);
}

export function receiptEntries(payment: Payment, ledgers: Map<string, Ledger>): VoucherEntry[] {
  const money = need(ledgers, MODE_LEDGER[payment.mode]);
  const recv = need(ledgers, "receivables");
  return payment.kind === "refund"
    ? [{ ledgerId: recv, debitPaise: payment.amountPaise, creditPaise: 0, invoiceId: payment.invoiceId }, { ledgerId: money, debitPaise: 0, creditPaise: payment.amountPaise }]
    : [{ ledgerId: money, debitPaise: payment.amountPaise, creditPaise: 0 }, { ledgerId: recv, debitPaise: 0, creditPaise: payment.amountPaise, invoiceId: payment.invoiceId }];
}

/** Posts the sales voucher for an invoice (inside the caller's transaction). No-op without a chart of accounts. */
export async function postInvoice(tx: Repositories, invoice: Invoice, actorId?: Id): Promise<Voucher | null> {
  const ledgers = await systemLedgers(tx, invoice.orgId);
  if (!ledgers) return null;
  const org = await tx.orgs.get(invoice.orgId);
  return postVoucher(tx, {
    orgId: invoice.orgId, branchId: invoice.branchId, type: "sales", date: invoice.issuedAt ?? new Date(),
    narration: `Invoice ${invoice.invoiceNo}`, entries: salesEntries(invoice, ledgers, Boolean(org?.settings?.interState)), invoiceId: invoice.id,
  }, actorId);
}

/** Posts a receipt (payment) or payment (refund) voucher. No-op without a chart of accounts. */
export async function postPayment(tx: Repositories, payment: Payment, invoiceNo: string, actorId?: Id): Promise<Voucher | null> {
  const ledgers = await systemLedgers(tx, payment.orgId);
  if (!ledgers) return null;
  return postVoucher(tx, {
    orgId: payment.orgId, branchId: payment.branchId, type: payment.kind === "refund" ? "payment" : "receipt", date: payment.receivedAt,
    narration: `${payment.kind === "refund" ? "Refund" : "Payment"} ${payment.mode.toUpperCase()} against ${invoiceNo}`,
    entries: receiptEntries(payment, ledgers), invoiceId: payment.invoiceId, paymentId: payment.id,
  }, actorId);
}

/** Cancels the sales voucher of a cancelled invoice. */
export async function unpostInvoice(tx: Repositories, invoiceId: Id, actorId?: Id): Promise<void> {
  for (const v of await tx.vouchers.find({ invoiceId, type: "sales", status: "posted" } as any)) await cancelVoucher(tx, v.id, actorId);
}

/**
 * The posting hook for db-kit's billing: `createDb({ ..., posting: ledgerPostingHook })`. issueInvoice,
 * recordPayment and cancelInvoice then post through ledger-kit, inside their own transaction.
 */
export const ledgerPostingHook: PostingHook = {
  async invoiceIssued(tx, invoice, actorId) {
    await postInvoice(tx, invoice, actorId);
  },
  async paymentRecorded(tx, payment, invoiceNo, actorId) {
    await postPayment(tx, payment, invoiceNo, actorId);
  },
  async invoiceCancelled(tx, invoiceId, actorId) {
    await unpostInvoice(tx, invoiceId, actorId);
  },
};
