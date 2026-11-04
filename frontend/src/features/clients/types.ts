export interface Contact { id: string; name: string; position: string | null; phone: string | null; email: string | null; isPrimary: boolean }

export interface ClientDetail {
  id: string; clientCode: string; clientType: 'COMPANY' | 'INDIVIDUAL'; name: string; legalName: string | null; taxNumber: string | null;
  registrationNumber: string | null; phone: string | null; email: string | null; address: string | null; countryCode: string | null;
  paymentTermsDays: number; creditLimit: string | null; notes: string | null; isActive: boolean; contacts: Contact[];
}

export interface BalanceRow { currency: string; invoiced: string; received: string; refunded: string; allocated: string; outstanding: string; unappliedCredit: string; netBalance: string }
export interface Balance { clientId: string; creditLimit: string | null; balances: BalanceRow[] }

export interface StatementLine { date: string; type: string; reference: string; description: string; currency: string; debit: string; credit: string; balance: string }
export interface Statement { openingBalances: Record<string, string>; closingBalances: Record<string, string>; lines: StatementLine[] }

export interface ClientFile {
  id: string; fileNumber: string; fileType: string; status: string; priority: string; openedAt: string; customsReference: string | null;
  currentStage: { code: string; nameEn: string; nameAr: string | null } | null;
}
