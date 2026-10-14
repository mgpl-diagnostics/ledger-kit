<div align="center">

# tally-kit

**The accounting engine of MGPL Diagnostics.**
Account groups, ledgers and vouchers, posted by double entry, with trial balance, day book, P&L and
balance sheet. Exact to the paisa, ACID on MongoDB and PostgreSQL.

![status](https://img.shields.io/badge/status-in%20development-E9A23B) ![money](https://img.shields.io/badge/money-integer%20paise-14264A)

</div>

> 🚧 **0.1.0, not released yet.** The package name is confirmed before the first release.

## What it does

| | |
| --- | --- |
| **Chart of accounts** | the 28 standard account groups (15 primary + 13 sub-groups) and the ledgers a lab needs on day one, seeded idempotently |
| **Vouchers** | sales, receipt, payment, journal, contra, credit / debit note, purchase, closing. Numbered per type per financial year (`SAL/2026-27/000001`), always balanced, one-sided lines in whole paise, cancelled with the number kept |
| **Lock dates** | posting or cancelling on or before an organisation or branch lock date fails, checked inside the posting transaction |
| **Automatic posting** | `tallyPostingHook`: db-kit's invoices, payments, refunds and cancellations post their own vouchers |
| **Books** | trial balance, ledger statement with running balance, cash book, day book, profit & loss (gross and net), balance sheet, outstanding receivables with ageing, GST summary; org-wide or per branch |

It is a library: the backend calls it, storage lives in
[db-kit](https://github.com/mgpl-diagnostics/db-kit), and money rules such as GST and settlements live in
[finance-kit](https://github.com/mgpl-diagnostics/finance-kit).

## Use

```ts
import { createDb } from "@mgpl-diagnostics/db-kit";
import { tallyPostingHook, seedChartOfAccounts, postVoucher, trialBalance } from "@mgpl-diagnostics/tally-kit";

// billing (issueInvoice, recordPayment, cancelInvoice) now posts through tally-kit
const db = await createDb({ backend: "pg", pg: { url: process.env.DATABASE_URL! }, posting: tallyPostingHook });
const repos = db.repos;

await seedChartOfAccounts(repos, orgId); // once per organisation

const cash = await repos.ledgers.findBySystemKey(orgId, "cash");
const capital = await repos.ledgers.findBySystemKey(orgId, "capital");
await postVoucher(repos, {
  orgId, branchId, type: "receipt", narration: "Capital introduced",
  entries: [
    { ledgerId: cash!.id, debitPaise: 1_000_000, creditPaise: 0 },
    { ledgerId: capital!.id, debitPaise: 0, creditPaise: 1_000_000 },
  ],
}, actorId);

const tb = await trialBalance(repos, { orgId }); // tb.totalDebitPaise === tb.totalCreditPaise
```

finance-kit supplies its own hook (`financePosting`, GST by place of supply, B2B customer ledgers) and
posts through tally-kit's `postVoucher` / `cancelVoucher`.

## Same books as db-kit 1.1.0

tally-kit is a port of db-kit 1.1.0's `accounting.ts` and `reports.ts` with identical behaviour: the
same function names and signatures, voucher numbers, counter keys, ledger entries, audit lines, errors
and report figures. `npm test` runs one scenario (two financial years, two branches, every voucher
type, every payment mode, IGST, round-off both ways, lock dates, rejected vouchers, every report)
through db-kit's engine and through tally-kit's, on real MongoDB and real PostgreSQL, and requires the
two sets of books to be identical. A database posted by db-kit carries on under tally-kit with no
migration: the next voucher takes the next number.

## API

| Area | Calls |
| --- | --- |
| Chart | `TALLY_GROUPS`, `DEFAULT_LEDGERS`, `seedChartOfAccounts` |
| Vouchers | `postVoucher`, `cancelVoucher`, `assertBalanced`, `assertPeriodOpen`, `VOUCHER_PREFIX`, `voucherCounterKey` |
| Posting | `tallyPostingHook`, `postInvoice`, `postPayment`, `unpostInvoice`, `salesEntries`, `receiptEntries`, `MODE_LEDGER` |
| Books | `ledgerBalance`, `ledgerStatement`, `cashBook`, `trialBalance`, `profitAndLoss`, `balanceSheet`, `dayBook`, `outstandingReceivables`, `gstSummary` |

Errors: `UnbalancedVoucherError` (422, a db-kit `ValidationError`), and db-kit's `ValidationError` (400),
`NotFoundError` (404) and `PeriodLockedError` (409).

## Not Tally

tally-kit is our own, independent software. It follows the familiar Tally-style accounting concepts.
It is not affiliated with, endorsed by, or compatible with Tally Solutions or its products, and it
does not import or export Tally data.

## Licence

All rights reserved. See [LICENSE](LICENSE).
