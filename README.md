<div align="center">

# tally-kit

**The accounting engine of MGPL Diagnostics.**
Account groups, ledgers and vouchers, posted by double entry, with trial balance, day book, P&L and
balance sheet. Exact to the paisa, ACID on MongoDB and PostgreSQL.

![status](https://img.shields.io/badge/status-in%20development-E9A23B) ![money](https://img.shields.io/badge/money-integer%20paise-14264A)

</div>

> 🚧 **In development.** The scope and rules are in [AGENTS.md](AGENTS.md).

## What it will do

| | |
| --- | --- |
| **Chart of accounts** | the 28 standard account groups, ledgers, opening balances |
| **Vouchers** | sales, receipt, payment, journal, contra, credit / debit note, purchase, closing. Numbered per type per financial year, always balanced |
| **Automatic posting** | invoices and payments from db-kit post their vouchers by themselves (`PostingHook`) |
| **Books** | trial balance, ledger statement, day book, cash and bank books, profit & loss, balance sheet |

It is a library: the backend calls it, storage lives in
[db-kit](https://github.com/mgpl-diagnostics/db-kit), and money rules such as GST and settlements live in
[finance-kit](https://github.com/mgpl-diagnostics/finance-kit).

## Not Tally

tally-kit is our own, independent software. It follows the familiar Tally-style accounting concepts.
It is not affiliated with, endorsed by, or compatible with Tally Solutions or its products, and it
does not import or export Tally data.

## Licence

All rights reserved. See [LICENSE](LICENSE).
