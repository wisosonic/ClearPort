export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
export const ACCOUNT_TYPES: AccountType[] = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'];

export interface LedgerAccount { id: string; accountCode: string; name: string; accountType: AccountType; isActive: boolean; parentId: string | null; currencyCode: string | null }

export interface TrialBalance {
  baseCurrency: string; asOf: string | null; balanced: boolean; totals: { debit: string; credit: string };
  lines: { accountCode: string; name: string; accountType: AccountType; isActive: boolean; debit: string; credit: string; balance: string }[];
}

export interface JournalLine {
  id: string; accountCode: string; accountName: string; currencyCode: string; debit: string; credit: string;
  baseDebit: string; baseCredit: string; clearanceFileId: string | null;
}
export interface JournalEntry {
  id: string; entryNumber: string; entryDate: string; description: string; sourceType: string | null; status: 'DRAFT' | 'POSTED' | 'REVERSED';
  reversalOfId: string | null; totals: { baseDebit: string; baseCredit: string }; lines: JournalLine[];
}

export const SOURCES = ['MANUAL', 'INVOICE', 'PAYMENT', 'EXPENSE', 'REVERSAL'] as const;

export const AMOUNT = /^\d+(\.\d{1,4})?$/;
export const POSITIVE = (s: string) => AMOUNT.test(s.trim()) && Number(s) > 0;
