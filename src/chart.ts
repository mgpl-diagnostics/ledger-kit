import type { AccountGroup, AccountNature, Id, Ledger, Repositories } from "@mgpl-diagnostics/db-kit";

/**
 * Chart of accounts: groups → ledgers.
 *
 * The 28 standard groups (15 primary + 13 sub-groups) and the ledgers a diagnostic lab needs on day
 * one. Names, parents and system keys are the ones db-kit 1.1.0 seeds, so books started with db-kit
 * carry on unchanged under tally-kit.
 */

export interface GroupDef {
  name: string;
  parent?: string;
  nature?: AccountNature;
  /** Shown above the gross-profit line of the P&L (trading account). */
  gp?: boolean;
}

/** The 28 standard groups: 15 primary + 13 sub-groups. A sub-group takes its parent's nature. */
export const TALLY_GROUPS: GroupDef[] = [
  { name: "Capital Account", nature: "liabilities" },
  { name: "Loans (Liability)", nature: "liabilities" },
  { name: "Current Liabilities", nature: "liabilities" },
  { name: "Fixed Assets", nature: "assets" },
  { name: "Investments", nature: "assets" },
  { name: "Current Assets", nature: "assets" },
  { name: "Branch / Divisions", nature: "liabilities" },
  { name: "Misc. Expenses (ASSET)", nature: "assets" },
  { name: "Suspense A/c", nature: "liabilities" },
  { name: "Sales Accounts", nature: "income", gp: true },
  { name: "Purchase Accounts", nature: "expenses", gp: true },
  { name: "Direct Incomes", nature: "income", gp: true },
  { name: "Indirect Incomes", nature: "income" },
  { name: "Direct Expenses", nature: "expenses", gp: true },
  { name: "Indirect Expenses", nature: "expenses" },
  { name: "Reserves & Surplus", parent: "Capital Account" },
  { name: "Bank OD A/c", parent: "Loans (Liability)" },
  { name: "Secured Loans", parent: "Loans (Liability)" },
  { name: "Unsecured Loans", parent: "Loans (Liability)" },
  { name: "Duties & Taxes", parent: "Current Liabilities" },
  { name: "Provisions", parent: "Current Liabilities" },
  { name: "Sundry Creditors", parent: "Current Liabilities" },
  { name: "Bank Accounts", parent: "Current Assets" },
  { name: "Cash-in-Hand", parent: "Current Assets" },
  { name: "Deposits (Asset)", parent: "Current Assets" },
  { name: "Loans & Advances (Asset)", parent: "Current Assets" },
  { name: "Stock-in-Hand", parent: "Current Assets" },
  { name: "Sundry Debtors", parent: "Current Assets" },
];

/** Ledgers a diagnostic lab needs on day one. `key` = systemKey used by automatic posting. */
export const DEFAULT_LEDGERS: { name: string; group: string; key?: string }[] = [
  { name: "Capital Account", group: "Capital Account", key: "capital" },
  { name: "Cash", group: "Cash-in-Hand", key: "cash" },
  { name: "Bank Account", group: "Bank Accounts", key: "bank" },
  { name: "UPI Collections", group: "Bank Accounts", key: "upi" },
  { name: "Card Settlements", group: "Bank Accounts", key: "card" },
  { name: "Patient Receivables", group: "Sundry Debtors", key: "receivables" },
  { name: "Lab Test Income", group: "Sales Accounts", key: "sales" },
  { name: "Output CGST", group: "Duties & Taxes", key: "cgst" },
  { name: "Output SGST", group: "Duties & Taxes", key: "sgst" },
  { name: "Output IGST", group: "Duties & Taxes", key: "igst" },
  { name: "Discount Allowed", group: "Indirect Expenses", key: "discount" },
  { name: "Round Off", group: "Indirect Expenses", key: "round_off" },
  { name: "Doctor Referral Commission", group: "Indirect Expenses", key: "doctor_commission" },
  { name: "Doctors Payable", group: "Sundry Creditors", key: "doctors_payable" },
  { name: "Reagents & Consumables", group: "Purchase Accounts", key: "purchases" },
  { name: "Salaries", group: "Indirect Expenses" },
  { name: "Rent", group: "Indirect Expenses" },
  { name: "Electricity", group: "Indirect Expenses" },
  { name: "Lab Equipment", group: "Fixed Assets" },
];

/** Creates the groups and default ledgers for an organisation (skips ones that exist). */
export async function seedChartOfAccounts(repos: Repositories, orgId: Id): Promise<{ groups: AccountGroup[]; ledgers: Ledger[] }> {
  return repos.transaction(async (tx) => {
    const byName = new Map<string, AccountGroup>();
    for (const g of await tx.accountGroups.find({ orgId })) byName.set(g.name, g);
    for (const def of TALLY_GROUPS) {
      if (byName.has(def.name)) continue;
      const parent = def.parent ? byName.get(def.parent)! : null;
      const g = await tx.accountGroups.create({
        orgId, name: def.name, parentId: parent?.id ?? null,
        nature: def.nature ?? parent!.nature, affectsGrossProfit: def.gp ?? parent?.affectsGrossProfit ?? false, system: true,
      });
      byName.set(g.name, g);
    }
    const existing = new Set((await tx.ledgers.find({ orgId })).map((l) => l.name));
    for (const l of DEFAULT_LEDGERS) {
      if (existing.has(l.name)) continue;
      await tx.ledgers.create({ orgId, name: l.name, groupId: byName.get(l.group)!.id, openingPaise: 0, systemKey: l.key ?? null, active: true });
    }
    return { groups: [...byName.values()], ledgers: await tx.ledgers.find({ orgId }) };
  });
}
