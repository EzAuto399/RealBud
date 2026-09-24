export interface BillMailSource {
  accountId: string; receiptId: string; threadId: string;
  message: {
    id: string; at: number; from: string; subject: string; body: string; bodyTruncated?: boolean;
    attachments: { id: string; name: string; mimeType: string; size: number | null }[];
  };
}
export interface BillSourceEvidence extends BillMailSource { digest: string; identity: string }
export interface BillFacts {
  propertyId: string; kind: string; vendor: string; amountCents: number | null; currency: 'AUD';
  invoiceDate: string | null; dueDate: string | null; note: string;
}
export type SourceBillState = 'received' | 'in-process' | 'hold' | 'cancelled';
export interface BillOccurrenceVersion {
  revision: number; facts: BillFacts; state: SourceBillState; source: BillSourceEvidence;
  seriesId: string | null; expectedArrivalDate: string | null;
  reviewedAt: number; reviewedBy: string; reviewReason: string;
}
export interface SourceBillOccurrence extends BillOccurrenceVersion {
  id: string; createdAt: number; history: BillOccurrenceVersion[];
}
export interface BillSeriesVersion {
  revision: number; intervalMonths: 1 | 3 | 12; anchorDate: string;
  windowBeforeDays: number; windowAfterDays: number; timeZone: string; active: boolean;
  reviewedAt: number; reviewedBy: string; reviewReason: string;
}
export interface BillRecurrenceSeries extends BillSeriesVersion {
  id: string; occurrenceId: string; sourceOccurrenceRevision: number; sourceDigest: string;
  accountId: string; propertyId: string; kind: string; vendor: string;
  createdAt: number; history: BillSeriesVersion[];
}
export interface BillCalendarEntry {
  id: string; type: 'expected-arrival' | 'invoice-due'; date: string; endDate: string;
  propertyId: string; kind: string; vendor: string; billId: string | null; seriesId: string | null;
  basis: 'human-reviewed-invoice-date' | 'approved-arrival-pattern';
  state: SourceBillState | 'predicted';
}
export interface SourceBillsSnapshot {
  version: 1; revision: number; occurrences: SourceBillOccurrence[];
  series: BillRecurrenceSeries[]; calendar: BillCalendarEntry[];
}

export interface SourceBillCounts { revision: number; occurrences: number; series: number; activeSeries: number }
export interface SourceBillPageQuery { cursor?: string; limit?: number; propertyId?: string }
export interface SourceBillPage<T> { items: T[]; nextCursor: string | null; snapshotCursor: string; total: number; revision: number }
export interface SourceBillCalendarQuery extends SourceBillPageQuery { from: string; to: string }
export interface SourceBillCalendarPage { items: BillCalendarEntry[]; nextCursor: string | null; revision: number }
export interface SourceBillPatternQuery { accountId: string; propertyId: string; kind: string; vendor: string; includeSeriesId?: string }
export interface SourceBillsWorkspace {
  version: 2; revision: number; counts: Omit<SourceBillCounts, 'revision'>;
  range: { from: string; to: string }; propertyId: string | null;
  occurrences: SourceBillPage<SourceBillOccurrence>; series: SourceBillPage<BillRecurrenceSeries>; calendar: SourceBillCalendarPage;
}
