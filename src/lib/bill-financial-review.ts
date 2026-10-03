import type { BillFinancialObservation, SourceBillOccurrence } from '@shared/source-bills';
import type { BillFinancialReviewDraft, BillReviewDraftValue } from '@shared/bill-review-drafts';
import { draftBillFacts } from './source-bill-form';

export const financialLabels = {
  entry: { unknown: 'Unknown', recorded: 'Recorded', 'not-recorded': 'Not recorded in checked scope' },
  payment: { unknown: 'Unknown', 'confirmed-paid': 'Paid with reviewed evidence', unpaid: 'Unpaid', 'arranged-unconfirmed': 'Arranged, payment unconfirmed' },
  funding: { unknown: 'Unknown', sufficient: 'Sufficient', insufficient: 'Insufficient' },
  advance: { unknown: 'Unknown', none: 'No advance', outstanding: 'Outstanding', recovered: 'Recovered' },
} as const;
export const financialDimensionLabels = { entry: 'Entry', payment: 'Payment', funding: 'Funding', advance: 'Advance' } as const;
export const financialDimensions = ['entry', 'payment', 'funding', 'advance'] as const;

export function newFinancialDraft(bill: SourceBillOccurrence, workspaceId: string): BillReviewDraftValue {
  const facts = draftBillFacts(bill.facts);
  return {
    workspaceId, state: 'editing', billId: bill.id, billRevision: bill.revision,
    itemId: null, messageId: null, sourceDigest: bill.source.digest,
    fields: { propertyId: facts.propertyId, kind: facts.kind, vendor: facts.vendor, amount: facts.amount,
      invoiceNumber: facts.invoiceNumber ?? '', invoiceVersion: facts.invoiceVersion ?? '',
      invoiceDate: facts.invoiceDate, dueDate: facts.dueDate, note: facts.note },
    billState: bill.state, reason: '', seriesId: '', arrivalDate: '', proposalRequest: null,
    financialReview: { provenance: 'simulated', sourceKind: 'unknown', sourceIds: '', locator: '', accountContext: '', observedAt: '', coverage: 'unknown', entry: 'unknown', payment: 'unknown', funding: 'unknown', advance: 'unknown', note: '', reviewReason: '' },
  };
}

function checkedText(raw: string, max: number, label: string): string {
  const value = raw.trim();
  if (value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error(`Check ${label}; it is too long or contains unsupported characters.`);
  return value;
}

/** Keep drafts timezone-stable across devices, while displaying local wall time. */
export function financialObservedDraft(raw: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(raw)) return raw;
  const [year, month, day, hour, minute, second = 0] = raw.split(/[-T:]/).map(Number), date = new Date(raw);
  if (!Number.isSafeInteger(date.getTime()) || date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second) return raw;
  return date.toISOString();
}
export function financialObservedInput(raw: string): string {
  if (!raw.endsWith('Z')) return raw;
  const date = new Date(raw);
  if (!Number.isSafeInteger(date.getTime())) return raw;
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
export function financialObservedAt(raw: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw)) throw new Error('Enter when the financial evidence was observed.');
  const date = new Date(raw);
  if (!Number.isSafeInteger(date.getTime()) || date.getTime() < 0 || date.toISOString() !== raw) throw new Error('Enter a valid observation date and time in your local timezone.');
  if (date.getTime() > Date.now()) throw new Error('The observation time cannot be in the future.');
  return date.getTime();
}

export function financialObservation(draft: BillFinancialReviewDraft): BillFinancialObservation {
  const sourceIds = draft.sourceIds.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  if (sourceIds.length > 20 || new Set(sourceIds).size !== sourceIds.length || sourceIds.some(value => value.length > 200 || /[\x00-\x1f\x7f]/.test(value))) throw new Error('Use up to 20 distinct evidence references, one per line (200 characters each).');
  const observation: BillFinancialObservation = {
    provenance: draft.provenance, sourceKind: draft.sourceKind, sourceIds,
    locator: checkedText(draft.locator, 1000, 'the evidence location'), accountContext: checkedText(draft.accountContext, 200, 'the account context'),
    observedAt: financialObservedAt(draft.observedAt), coverage: draft.coverage,
    entry: draft.entry, payment: draft.payment, funding: draft.funding, advance: draft.advance,
    note: checkedText(draft.note, 1000, 'the evidence note'),
  };
  const claims = financialDimensions.some(key => observation[key] !== 'unknown');
  if (claims && (observation.coverage === 'unknown' || !sourceIds.length || !observation.locator || !observation.accountContext)) throw new Error('For a known state, provide evidence references, location, account context and the scope checked.');
  if (claims && ['unknown', 'csv-status'].includes(observation.sourceKind)) throw new Error('CSV status and unknown sources cannot establish these financial states. Keep each state unknown until the evidence is checked.');
  if (observation.entry !== 'unknown' && observation.sourceKind !== 'external-record') throw new Error('Entry status needs a checked external record.');
  if (observation.entry === 'not-recorded' && observation.coverage !== 'complete') throw new Error('Not recorded requires a complete check of the stated scope.');
  if (observation.advance === 'none' && observation.coverage !== 'complete') throw new Error('No advance requires a complete check of the stated scope.');
  return observation;
}

export function financialReviewRequest(value: BillReviewDraftValue) {
  if (!value.financialReview || !value.billId || !value.billRevision || !value.sourceDigest) throw new Error('Reopen this financial draft with its original saved bill.');
  const reviewReason = checkedText(value.financialReview.reviewReason, 1000, 'the financial review reason');
  if (!reviewReason) throw new Error('Explain how you checked the financial evidence.');
  return { expectedRevision: value.billRevision, expectedSourceDigest: value.sourceDigest, sourceReviewed: true as const, reviewReason, observation: financialObservation(value.financialReview) };
}

export function matchesFinancialReceipt(row: SourceBillOccurrence | null | undefined, billId: string, sent: ReturnType<typeof financialReviewRequest>): row is SourceBillOccurrence {
  const review = row?.financialReview;
  if (!row || row.id !== billId || row.revision !== sent.expectedRevision + 1 || row.source.digest !== sent.expectedSourceDigest || !review || review.basisBillRevision !== sent.expectedRevision || review.sourceDigest !== sent.expectedSourceDigest || review.reviewReason !== sent.reviewReason) return false;
  const expected = sent.observation;
  return Object.keys(expected).every(rawKey => {
    const key = rawKey as keyof BillFinancialObservation;
    return key === 'sourceIds' ? review.sourceIds.length === expected.sourceIds.length && review.sourceIds.every((id, index) => id === expected.sourceIds[index]) : review[key] === expected[key];
  });
}

/** Confirmation is for these exact fields, including the saved bill/source basis. */
export function financialConfirmationKey(value: BillReviewDraftValue): string {
  return JSON.stringify([value.workspaceId, value.billId, value.billRevision, value.sourceDigest, value.financialReview]);
}
/** A persisted draft may outlive a successful claim when its acknowledgement was lost. */
export function recoveredFinancialDraftReceipt(value: BillReviewDraftValue, row: SourceBillOccurrence | null | undefined): SourceBillOccurrence | null {
  try { return value.billId && matchesFinancialReceipt(row, value.billId, financialReviewRequest(value)) ? row : null; }
  catch { return null; }
}
