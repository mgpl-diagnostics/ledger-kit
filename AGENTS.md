# AGENTS.md — @mgpl-diagnostics/tally-kit

**Our own accounting engine** for MGPL Diagnostics: account groups, ledgers, vouchers, double-entry
posting and the books reports. The approach is Tally-like (the concepts), but it is our software. We
do **not** use or integrate with Tally software: no Tally XML, no import, no export.

> **Status:** repository scaffolded, no code yet. The building agent starts here. Read the org-wide
> context first: `CONTEXT.md` from the MGPL context bundle, plus the `AGENTS.md` files of db-kit and
> finance-kit.

## Scope

| tally-kit owns | It does not own |
| --- | --- |
| Chart of accounts: the 28 standard groups (15 primary + 13 sub-groups), ledgers, opening balances | **Storage**: every table and collection lives in **db-kit** (MongoDB + PostgreSQL, ACID) |
| Vouchers: sales, receipt, payment, journal, contra, credit note, debit note, purchase, closing. Numbering per type per financial year; balanced-entry validation; cancel | GST rules, receivables, partner settlements, cash/bank, lock dates, year-end close: **finance-kit** |
| Automatic posting for invoices and payments, as the implementation of db-kit's `PostingHook` | GraphQL / HTTP: the future **api** repo |
| Books reports: trial balance, ledger statement (running balance), day book, cash and bank books, group summaries, profit & loss, balance sheet | Permissions: **auth-kit** (`accounts:read`, `accounts:post`, `accounts:manage`) |

## Where the code comes from (migration plan)

1. Today the engine lives in **db-kit**: `src/core/accounting.ts` (groups, ledgers, `postVoucher`,
   `cancelVoucher`, `postInvoice`, `postPayment`) and `src/core/reports.ts`.
2. db-kit 1.1.0 already exposes the seam:
   ```ts
   interface PostingHook {
     invoiceIssued(tx: Repositories, invoice: Invoice, actorId?: string): Promise<void>;
     paymentRecorded(tx: Repositories, payment: Payment, invoiceNo: string, actorId?: string): Promise<void>;
     invoiceCancelled(tx: Repositories, invoiceId: string, actorId?: string): Promise<void>;
   }
   ```
3. tally-kit:
   - ports that logic in, with **identical behaviour** (same voucher numbers, same entries; prove it
     with tests);
   - exports `tallyPostingHook` for db-kit;
   - exports the posting and report functions finance-kit needs.
4. finance-kit's `src/posting.ts` switches from db-kit's functions to tally-kit's (one file).
5. Only after that, deprecate the accounting functions in db-kit (re-export from tally-kit or
   remove them in a major version).

## Rules

1. **Library only.** Functions take `repos: Repositories` from `@mgpl-diagnostics/db-kit` (peer
   dependency) and run multi-record work inside `repos.transaction()`.
2. **Money is integer paise.** Every voucher balances: debits = credits, each line one-sided. Reject
   anything else with a typed error.
3. **Respect lock dates.** finance-kit's period locks are stored in db-kit (`periodLocks`). Posting,
   cancelling or editing on or before a lock must fail inside the same transaction.
4. **Indian financial year** (1 Apr – 31 Mar, IST) for numbering and reports.
5. **Tests run on real MongoDB (replica set) and PostgreSQL**, started in-process, the same way as
   db-kit's suite. The trial balance must balance after every scenario.
6. Conventions:
   - TypeScript strict, ESM, tsup, Node ≥ 20, published to GitHub Packages;
   - CI job id **`ci`** (required on `main`), including the `llms-full.txt` freshness check;
   - docs: README, AGENTS.md, CLAUDE.md, llms.txt, llms-full.txt (`scripts/llms-full.mjs`);
   - LICENSE: all rights reserved.
7. **Name.** "Tally" is a trademark of Tally Solutions. Keep the README clear that this is our own
   independent software, not affiliated with Tally Solutions, and confirm the final package name
   with the owner before the first release.
8. Never commit patient data, real signatures, secrets or `.env` files.

## Repository rules

`main` takes pull requests only:
- squash merge, linear history;
- 1 code-owner review (`@BackStacked`);
- the `ci` check is required;
- release tags `v*` are admin-only.

Rules are applied from `mgpl-diagnostics/.github` (`scripts/protect-repos.mjs`).
