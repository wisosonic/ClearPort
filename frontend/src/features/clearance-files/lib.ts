import type { Locale } from '@/lib/format';

export interface Stage { id?: string; code: string; nameEn: string; nameAr: string | null; isTerminal?: boolean }
export interface Person { id?: string; firstName: string; lastName: string }

export interface FileDetail {
  id: string; fileNumber: string; fileType: string; status: 'OPEN' | 'ON_HOLD' | 'CLOSED' | 'CANCELLED'; priority: string;
  openedAt: string; expectedArrivalAt: string | null; closedAt: string | null; customsReference: string | null; internalNotes: string | null;
  client: { id: string; clientCode: string; name: string };
  branch: { id: string; code: string; name: string } | null;
  currentStage: Stage | null;
  assignee: (Person & { id: string }) | null;
  createdBy: Person | null;
  workflowTemplate: { id: string; name: string } | null;
  shipments: { id: string; shipmentType: string; vesselName: string | null; voyageNumber: string | null; billOfLadingNumber: string | null; eta: string | null; _count: { containers: number; goodsItems: number } }[];
}

export interface Blocker { code: string; message: string; details?: unknown }
export interface TransitionOption {
  transitionId: string; toStage: Stage; requiresReason: boolean; allowed: boolean; blockers: Blocker[];
}

export const stageName = (s: { nameEn: string; nameAr: string | null } | null | undefined, locale: Locale) =>
  s ? (locale === 'ar' && s.nameAr ? s.nameAr : s.nameEn) : '—';

export const statusTone = { OPEN: 'blue', ON_HOLD: 'amber', CLOSED: 'green', CANCELLED: 'neutral' } as const;
export const priorityTone = { LOW: 'neutral', NORMAL: 'neutral', HIGH: 'amber', URGENT: 'red' } as const;

/** A date input value (yyyy-mm-dd) to the ISO date-time the API expects, in UTC. */
export const dateToIso = (d: string) => (d ? `${d}T00:00:00.000Z` : undefined);
/** ISO date-time to a date input value. */
export const isoToDate = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '');
