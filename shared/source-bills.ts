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
  /** Reviewed source labels, never inferred supplier identity or payment proof. */
  invoiceNumber?: string | null; invoiceVersion?: string | null;
  /** Reviewed labels: the supplier reference (e.g. REI) and what the invoice
   * charges for. Neither is inferred supplier identity or payment proof. */
  supplierReference?: string | null; workDescription?: string | null;
}
/** Comparison only: retain stored legacy facts and their original audit hashes. */
export function sameBillFacts(a: BillFacts, b: BillFacts): boolean {
  return (['propertyId', 'kind', 'vendor', 'note'] as const).every(key => a[key].trim() === b[key].trim()) &&
    (['amountCents', 'currency', 'invoiceDate', 'dueDate'] as const).every(key => a[key] === b[key]) &&
    (['invoiceNumber', 'invoiceVersion', 'supplierReference', 'workDescription'] as const).every(key => (a[key]?.trim() ?? null) === (b[key]?.trim() ?? null));
}
export type SourceBillState = 'received' | 'in-process' | 'hold' | 'cancelled';
/** Human-reviewed claims, never a connector receipt or permission to act. */
export interface BillFinancialObservation {
  provenance: 'simulated' | 'actual'; sourceKind: 'external-record' | 'document' | 'csv-status' | 'unknown';
  sourceIds: string[]; locator: string; accountContext: string; observedAt: number;
  coverage: 'complete' | 'partial' | 'unknown';
  entry: 'recorded' | 'not-recorded' | 'unknown';
  payment: 'confirmed-paid' | 'unpaid' | 'arranged-unconfirmed' | 'unknown';
  funding: 'sufficient' | 'insufficient' | 'unknown';
  advance: 'none' | 'outstanding' | 'recovered' | 'unknown';
  note: string;
}
export interface BillFinancialReview extends BillFinancialObservation {
  version: 1; basisBillRevision: number; sourceDigest: string;
  reviewedAt: number; reviewedBy: string; reviewReason: string;
}
export interface BillDuplicateReference { billId: string; revision: number; matchedRevision: number; sourceDigest: string }
export type BillDuplicateMatch = 'exact-evidence' | 'invoice-identity' | 'invoice-conflict';
export interface BillDuplicateCandidate extends BillDuplicateReference { facts: BillFacts; subject: string; receivedAt: number; match?: BillDuplicateMatch }
/** Review candidates only: matching vendor labels do not establish supplier identity. */
export interface BillDuplicateCheck {
  version: 1; sourceDigest: string; reviewDigest: string | null; candidates: BillDuplicateCandidate[]; complete: boolean;
}
export interface BillDuplicateReview {
  version: 1; reviewDigest: string; candidates: BillDuplicateReference[];
  reviewedAt: number; reviewedBy: string; reason: string;
}
export interface BillOccurrenceVersion {
  revision: number; facts: BillFacts; state: SourceBillState; source: BillSourceEvidence;
  seriesId: string | null; expectedArrivalDate: string | null;
  reviewedAt: number; reviewedBy: string; reviewReason: string;
  duplicateReview?: BillDuplicateReview;
  financialReview?: BillFinancialReview;
}
export interface SourceBillOccurrence extends BillOccurrenceVersion {
  id: string; createdAt: number; history: BillOccurrenceVersion[];
}
/** A later return to earlier facts cannot revive an observation made stale by
 * an intervening correction. Status-only changes retain the original basis. */
export function isBillFinancialReviewStale(row: SourceBillOccurrence): boolean {
  const review = row.financialReview;
  if (!review) return false;
  const versions = [...row.history, row], basis = versions.find(v => v.revision === review.basisBillRevision);
  return row.state === 'cancelled' || !basis || basis.source.digest !== review.sourceDigest || versions.some(v =>
    v.revision > review.basisBillRevision && (v.source.digest !== review.sourceDigest || !sameBillFacts(v.facts, basis.facts)));
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
/** Usual gap from a bill's arrival to its reviewed due date, measured on the
 * pattern's reviewed bills. A forecast basis, never a payment record. */
export interface BillPaymentTerms { days: number; reviewedBills: number }
/** Derived on every read and never stored, so corrections, paid status and
 * paused patterns remove stale predictions. `expected-payment` is a forecast:
 * `reviewed-bill-due-date` = a received bill not marked paid;
 * `approved-pattern-payment-terms` = an approved arrival window plus
 * `paymentTerms` from at least two reviewed bills. */
export interface BillCalendarEntry {
  id: string; type: 'expected-arrival' | 'invoice-due' | 'expected-payment'; date: string; endDate: string;
  propertyId: string; kind: string; vendor: string; billId: string | null; seriesId: string | null;
  basis: 'human-reviewed-invoice-date' | 'approved-arrival-pattern' | 'reviewed-bill-due-date' | 'approved-pattern-payment-terms';
  state: SourceBillState | 'predicted';
  paymentTerms?: BillPaymentTerms;
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

/** Office-imported rate and levy reference numbers per property (e.g. from the
 * REI property list). A matching number proposes a property; a person still
 * chooses it. `rei` is what the spreadsheet showed, never verified paid status. */
export type BillReferenceKind = 'council' | 'water' | 'levy';
export interface PropertyBillReference { kind: BillReferenceKind; digits: string; raw: string }
export interface PropertyBillReferenceEntry {
  propertyId: string; code: string; refs: PropertyBillReference[];
  rei: { period: string | null; status: string | null } | null;
}
export interface PropertyBillReferenceRejected { code: string; kind: BillReferenceKind; raw: string; reason: string }
export interface PropertyBillReferenceHeld { code: string; street: string; reason: string; refs: number }
export interface PropertyBillReferenceShared { kind: BillReferenceKind; digits: string; propertyIds: string[]; message: string }
/** Suggested from the REI period only; approving it still needs a reviewed bill. */
export interface PropertyBillPatternSuggestion { propertyId: string; kind: BillReferenceKind; intervalMonths: 3; lastPeriod: string; nextAround: string; message: string }
export interface PropertyBillReferenceDirectory {
  version: 1; purpose: 'property-bill-references'; revision: number; updatedAt: number | null;
  entries: PropertyBillReferenceEntry[]; held: PropertyBillReferenceHeld[]; rejected: PropertyBillReferenceRejected[];
}
export interface PropertyBillReferenceView extends PropertyBillReferenceDirectory {
  shared: PropertyBillReferenceShared[]; suggestions: PropertyBillPatternSuggestion[];
  counts: { properties: number; refs: Record<BillReferenceKind, number>; rejected: number; held: number; shared: number };
}
export type PropertyBillReferenceMatch =
  | { state: 'matched'; propertyId: string; kind: BillReferenceKind; digits: string; how: 'whole' | 'within'; evidence: string; rei: PropertyBillReferenceEntry['rei'] }
  | { state: 'ambiguous'; propertyIds: string[]; evidence: string }
  | { state: 'none' };
