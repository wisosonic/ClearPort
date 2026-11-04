export const PARTY_TYPES = ['SHIPPING_AGENT', 'FREIGHT_FORWARDER', 'SUPPLIER', 'TRANSPORTER', 'OTHER'] as const;
export type PartyType = (typeof PARTY_TYPES)[number];

export interface Party {
  id: string; name: string; partyType: PartyType; taxNumber: string | null; phone: string | null; email: string | null; address: string | null; countryCode: string | null;
}
