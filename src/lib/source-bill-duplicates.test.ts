import { describe, expect, it } from 'vitest';
import type { BillDuplicateCheck, BillFacts, BillSourceEvidence, SourceBillOccurrence } from '@shared/source-bills';
import { billDuplicateCheckRequired, confirmedBillDuplicateReview, readBillDuplicateCheck } from './source-bill-duplicates';

const digest = 'a'.repeat(64), reviewDigest = 'b'.repeat(64);
const facts: BillFacts = { propertyId: 'property / one', kind: 'Water', vendor: 'Utility', amountCents: 12500, currency: 'AUD', invoiceDate: '2026-09-01', dueDate: '2026-10-01', note: '' };
const evidence: BillSourceEvidence = { accountId: 'account', receiptId: 'receipt', threadId: 'thread', identity: 'c'.repeat(64), digest, message: { id: 'message', at: 1, subject: 'Water bill', from: 'Utility', body: 'Invoice', attachments: [] } };
const bill: SourceBillOccurrence = { id: 'bill', revision: 2, source: evidence, facts, state: 'received', seriesId: null, expectedArrivalDate: null, createdAt: 1, reviewedAt: 1, reviewedBy: 'staff', reviewReason: 'Checked', history: [] };
const check = (): BillDuplicateCheck => ({ version: 1, sourceDigest: digest, reviewDigest, complete: true, candidates: [{ billId: `source-bill:${'e'.repeat(64)}`, revision: 2, matchedRevision: 1, sourceDigest: digest, facts, subject: 'Water bill', receivedAt: 1 }] });

describe('duplicate check boundary', () => {
  it('accepts a historical match and projects only the reviewed contract', () => {
    const input = { ...check(), untrusted: 'ignored', candidates: [{ ...check().candidates[0], extra: 'ignored', facts: { ...facts, extra: 'ignored' } }] };
    expect(readBillDuplicateCheck(input, digest)).toEqual(check());
  });
  it.each([
    ['source changed', { sourceDigest: 'd'.repeat(64) }],
    ['missing digest', { reviewDigest: null }],
    ['unknown completeness', { complete: undefined }],
    ['unknown schema', { version: 2 }],
    ['overflow', { candidates: Array.from({ length: 21 }, (_, n) => ({ ...check().candidates[0], billId: `source-bill:${n.toString(16).padStart(64, '0')}` })) }],
    ['repeated row', { candidates: [...check().candidates, ...check().candidates] }],
  ])('holds %s', (_name, change) => expect(() => readBillDuplicateCheck({ ...check(), ...change }, digest)).toThrow('could not be checked safely'));
  it.each([
    { revision: 0 }, { matchedRevision: 3 }, { billId: '../other' }, { receivedAt: Infinity }, { receivedAt: 9e15 },
    { facts: { ...facts, currency: 'USD' } }, { facts: { ...facts, amountCents: 0.5 } },
    { facts: { ...facts, propertyId: '' } }, { facts: { ...facts, invoiceDate: '2026-02-30' } },
  ])('holds malformed candidate %#', change => expect(() => readBillDuplicateCheck({ ...check(), candidates: [{ ...check().candidates[0], ...change }] }, digest)).toThrow());
  it('retains incomplete evidence without granting an override', () => {
    const incomplete = readBillDuplicateCheck({ ...check(), complete: false, reviewDigest: null }, digest);
    expect(incomplete.complete).toBe(false);
    expect(confirmedBillDuplicateReview(incomplete, 'current', { key: 'current', reviewDigest }, 'Separate period')).toBeNull();
  });
  it('rejects two historical matches presented as separate candidates for one bill', () => {
    const original = check();
    original.candidates.push({ ...original.candidates[0], matchedRevision: 2 });
    expect(() => readBillDuplicateCheck(original, digest)).toThrow('could not be checked safely');
  });
  it('accepts a complete empty check without inventing a review', () => {
    const empty = readBillDuplicateCheck({ ...check(), candidates: [], reviewDigest: null }, digest);
    expect(confirmedBillDuplicateReview(empty, 'current', { key: 'current', reviewDigest }, 'Reason')).toBeNull();
  });
  it('retains invoice identity and conflict semantics while rejecting unknown match kinds', () => {
    const candidate = { ...check().candidates[0], match: 'invoice-conflict', facts: { ...facts, invoiceNumber: '000142/A', invoiceVersion: '2' } };
    const result = readBillDuplicateCheck({ ...check(), candidates: [candidate] }, digest);
    expect(result.candidates[0]).toMatchObject(candidate);
    expect(confirmedBillDuplicateReview(result, 'current', { key: 'current', reviewDigest }, 'A separate bill')).toBeNull();
    expect(() => readBillDuplicateCheck({ ...check(), candidates: [{ ...candidate, match: 'auto-approved' }] }, digest)).toThrow();
    expect(() => readBillDuplicateCheck({ ...check(), candidates: [{ ...candidate, facts: { ...candidate.facts, invoiceNumber: null } }] }, digest)).toThrow();
  });
});

describe('explicit separate-invoice review', () => {
  it('requires the current fields, candidate digest and a written reason', () => {
    const confirmation = { key: 'current-source-and-facts', reviewDigest };
    expect(confirmedBillDuplicateReview(check(), confirmation.key, confirmation, 'A separate invoice period')).toEqual({ reviewDigest });
    expect(confirmedBillDuplicateReview(check(), 'changed-fields', confirmation, 'A separate period')).toBeNull();
    expect(confirmedBillDuplicateReview({ ...check(), reviewDigest: 'd'.repeat(64) }, confirmation.key, confirmation, 'A separate period')).toBeNull();
    expect(confirmedBillDuplicateReview(check(), confirmation.key, confirmation, '  ')).toBeNull();
    expect(confirmedBillDuplicateReview(check(), confirmation.key, null, 'Saved draft reason')).toBeNull();
  });
  it('checks new bills and reactivation even with unchanged facts', () => {
    expect(billDuplicateCheckRequired(null, evidence, facts, 'received')).toBe(true);
    expect(billDuplicateCheckRequired({ ...bill, state: 'cancelled' }, evidence, facts, 'received')).toBe(true);
  });
  it('allows cancellation and routine active status management without repeated approval', () => {
    expect(billDuplicateCheckRequired(bill, evidence, { ...facts, note: 'Cancel this duplicate' }, 'cancelled')).toBe(false);
    expect(billDuplicateCheckRequired(bill, evidence, facts, 'hold')).toBe(false);
    expect(billDuplicateCheckRequired(bill, evidence, { ...facts, vendor: ' Utility ' }, 'in-process')).toBe(false);
    expect(billDuplicateCheckRequired(bill, evidence, { ...facts, invoiceNumber: null, invoiceVersion: null }, 'in-process')).toBe(false);
  });
  it('rechecks changes to source and every submitted fact, including note', () => {
    expect(billDuplicateCheckRequired(bill, { ...evidence, digest: 'd'.repeat(64) }, facts, 'hold')).toBe(true);
    for (const change of [{ propertyId: 'other' }, { kind: 'Levy' }, { vendor: 'Other' }, { amountCents: null }, { invoiceDate: null }, { dueDate: null }, { note: 'New note' }]) {
      expect(billDuplicateCheckRequired(bill, evidence, { ...facts, ...change }, 'received')).toBe(true);
    }
  });
});
