import type { BillDuplicateCheck, BillFacts, BillSourceEvidence, SourceBillOccurrence, SourceBillState } from '@shared/source-bills';
import { sameBillFacts } from '@shared/source-bills';
import { validBillDate } from '@shared/bill-dates';

export interface BillDuplicateRequest {
  itemId: string; messageId: string; expectedSourceDigest: string; facts: BillFacts; billId?: string;
}
export interface BillDuplicateConfirmation { key: string; reviewDigest: string }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const billId = (value: unknown): value is string => typeof value === 'string' && /^source-bill:[a-f0-9]{64}$/.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const date = (value: unknown) => value === null || (typeof value === 'string' && validBillDate(value));
const invoiceReference = (value: unknown, max: number) => value === undefined || value === null || (text(value, max) && !!value.trim());
const facts = (value: unknown): value is BillFacts => object(value) && text(value.propertyId, 200) && !!value.propertyId.trim() && text(value.kind, 80) && !!value.kind.trim() &&
  text(value.vendor, 160) && !!value.vendor.trim() && (value.amountCents === null || (Number.isSafeInteger(value.amountCents) && Number(value.amountCents) >= 0 && Number(value.amountCents) <= 999_999_999_999)) &&
  value.currency === 'AUD' && date(value.invoiceDate) && date(value.dueDate) && text(value.note, 1000) &&
  invoiceReference(value.invoiceNumber, 120) && invoiceReference(value.invoiceVersion, 80) && (!value.invoiceVersion || !!value.invoiceNumber);

/** This read can hold a save, but never supplies approval on the person's behalf. */
export function readBillDuplicateCheck(value: unknown, sourceDigest: string): BillDuplicateCheck {
  const fail = (): never => { throw new Error('Matching bills could not be checked safely. Your review is kept; check again before saving.'); };
  if (!object(value) || value.version !== 1 || value.sourceDigest !== sourceDigest || !digest(value.sourceDigest) ||
    (value.reviewDigest !== null && !digest(value.reviewDigest)) || typeof value.complete !== 'boolean' || !Array.isArray(value.candidates) || value.candidates.length > 20) return fail();
  const seen = new Set<string>();
  for (const candidate of value.candidates) {
    if (!object(candidate) || !billId(candidate.billId) || !revision(candidate.revision) || !revision(candidate.matchedRevision) || candidate.matchedRevision > candidate.revision ||
      !digest(candidate.sourceDigest) || !facts(candidate.facts) || !text(candidate.subject, 2048) || !Number.isSafeInteger(candidate.receivedAt) || Number(candidate.receivedAt) < 0 || !Number.isFinite(new Date(Number(candidate.receivedAt)).getTime())) return fail();
    if (candidate.match !== undefined && !['exact-evidence', 'invoice-identity', 'invoice-conflict'].includes(String(candidate.match))) return fail();
    if (seen.has(candidate.billId)) return fail(); seen.add(candidate.billId);
  }
  if (value.complete && value.candidates.length && !digest(value.reviewDigest)) return fail();
  // Project only the reviewed contract; unknown server fields never enter state.
  return { version: 1, sourceDigest: value.sourceDigest, reviewDigest: value.reviewDigest as string | null, complete: value.complete,
    candidates: value.candidates.map(candidate => ({ billId: candidate.billId, revision: candidate.revision, matchedRevision: candidate.matchedRevision,
      ...(candidate.match !== undefined ? { match: candidate.match } : {}),
      sourceDigest: candidate.sourceDigest, subject: candidate.subject, receivedAt: candidate.receivedAt,
      facts: { propertyId: candidate.facts.propertyId, kind: candidate.facts.kind, vendor: candidate.facts.vendor, amountCents: candidate.facts.amountCents,
        ...(candidate.facts.invoiceNumber !== undefined ? { invoiceNumber: candidate.facts.invoiceNumber } : {}),
        ...(candidate.facts.invoiceVersion !== undefined ? { invoiceVersion: candidate.facts.invoiceVersion } : {}),
        currency: candidate.facts.currency, invoiceDate: candidate.facts.invoiceDate, dueDate: candidate.facts.dueDate, note: candidate.facts.note } })) };
}

export function billDuplicateCheckRequired(editing: SourceBillOccurrence | null, evidence: BillSourceEvidence, submitted: BillFacts, nextState: SourceBillState): boolean {
  if (editing && nextState === 'cancelled') return false;
  return !editing || editing.state === 'cancelled' || editing.source.digest !== evidence.digest ||
    !sameBillFacts(editing.facts, submitted);
}

export function confirmedBillDuplicateReview(check: BillDuplicateCheck, key: string, confirmation: BillDuplicateConfirmation | null, reason: string): { reviewDigest: string } | null {
  return check.complete && check.candidates.length > 0 && !check.candidates.some(candidate => candidate.match === 'invoice-conflict') && check.reviewDigest && confirmation?.key === key &&
    confirmation.reviewDigest === check.reviewDigest && reason.trim() ? { reviewDigest: check.reviewDigest } : null;
}
