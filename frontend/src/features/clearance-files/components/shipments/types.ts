export interface PortRef { id: string; code: string; name: string; countryCode: string }
export interface PartyRef { id: string; name: string; partyType: string }

export interface Container {
  id: string; containerNumber: string; containerType: string | null; sealNumber: string | null;
  grossWeight: string | null; netWeight: string | null; packageCount: number | null; status: string;
}
export interface Goods {
  id: string; description: string; countryOfOrigin: string | null; quantity: string | null; unitOfMeasure: string | null;
  grossWeight: string | null; netWeight: string | null; unitPrice: string | null; lineTotal: string | null; currencyCode: string | null;
  hsCode: { id: string; code: string; description: string } | null;
}
export interface Shipment {
  id: string; shipmentType: string; vesselName: string | null; voyageNumber: string | null; billOfLadingNumber: string | null;
  masterBlNumber: string | null; houseBlNumber: string | null; etd: string | null; eta: string | null; actualArrivalAt: string | null; notes: string | null;
  originPort: PortRef | null; destinationPort: PortRef | null; shippingAgent: PartyRef | null; freightForwarder: PartyRef | null;
  _count: { containers: number; goodsItems: number };
}
export interface ShipmentDetail extends Shipment { containers: Container[]; goodsItems: Goods[] }
