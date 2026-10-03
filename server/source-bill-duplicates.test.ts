import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceBillRegister, previewBillSource } from './source-bills.ts';
import { WorkflowDatabase } from './workflow-database.ts';
import { deriveBillLookups, validateOccurrence } from './source-bill-graph.ts';
import type { BillFacts, BillMailSource } from '../shared/source-bills.ts';

const resources: { dir: string; db: WorkflowDatabase }[] = [];
afterEach(() => { for (const { dir, db } of resources.splice(0)) { db.close(); rmSync(dir, { recursive: true, force: true }); } });
const now = Date.parse('2026-10-01T00:00:00Z');
const facts = (): BillFacts => ({ propertyId: 'fictional-property', kind: 'Water', vendor: 'Fictional Water', amountCents: 12345, currency: 'AUD', invoiceDate: '2026-10-01', dueDate: '2026-10-21', note: '' });
const source = (n = 1): BillMailSource => ({ accountId: 'fictional-account', receiptId: `fictional-scan-${n}`, threadId: `fictional-thread-${n}`, message: {
  id: `fictional-message-${n}`, at: now, from: 'fictional-vendor@example.test', subject: 'Fictional invoice FICTION-001', body: 'Fictional invoice FICTION-001, water AUD 123.45 for Fictional Oak Street.', bodyTruncated: false, attachments: [],
} });
const review = (s = source(), f = facts()) => ({ expectedSourceDigest: previewBillSource(s).digest, sourceReviewed: true, facts: f, reviewReason: 'Fictional source and invoice reviewed.' });
const preview = (s = source(), f = facts()) => ({ expectedSourceDigest: previewBillSource(s).digest, facts: f });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fictional-bill-duplicates-')), db = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 7) }); resources.push({ dir, db });
  return { dir, db, store: new SourceBillRegister(db, { dataDir: dir, now: () => now }) };
}

describe('exact-evidence cross-message bill duplicate review', () => {
  it('holds a resent invoice before creating a second record, while the same-message replay stays idempotent', () => {
    const { store } = fixture(), original = store.accept(review(), source(), 'fictional-reviewer');
    const before = store.counts();
    expect(store.accept(review(), { ...source(), receiptId: 'later-scan' }, 'fictional-reviewer')).toEqual(original);
    const check = store.duplicateCandidates(preview(source(2)), source(2));
    expect(check).toMatchObject({ version: 1, complete: true, candidates: [{ billId: original.id, revision: 1, matchedRevision: 1, sourceDigest: original.source.digest }] });
    expect(check.reviewDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(() => store.accept(review(source(2)), source(2), 'fictional-reviewer')).toThrow(/possible duplicate/i);
    expect(store.counts()).toEqual(before);
  });

  it('records the explicit separate-invoice decision and preserves it on replay, correction and reopen', () => {
    const { store, db, dir } = fixture(); store.accept(review(), source(), 'fictional-reviewer');
    const mail = source(2), check = store.duplicateCandidates(preview(mail), mail);
    const request = { ...review(mail), reviewReason: 'Two separately confirmed fictional invoice originals.', duplicateReview: { reviewDigest: check.reviewDigest } };
    const saved = store.accept(request, mail, 'fictional-second-reviewer');
    expect(saved.duplicateReview).toMatchObject({ version: 1, reviewDigest: check.reviewDigest, reviewedAt: now, reviewedBy: 'fictional-second-reviewer', reason: request.reviewReason, candidates: [{ matchedRevision: 1 }] });
    expect(store.accept(request, mail, 'fictional-second-reviewer')).toEqual(saved);
    const corrected = store.correct(saved.id, { ...review(mail), expectedRevision: saved.revision, state: 'hold', reviewReason: 'Awaiting internal review.' }, mail, 'fictional-third-reviewer');
    expect(corrected.duplicateReview).toEqual(saved.duplicateReview);
    expect(corrected.history[0].duplicateReview).toEqual(saved.duplicateReview);
    const reopened = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 7) });
    try { expect(new SourceBillRegister(reopened, { dataDir: dir }).getOccurrence(saved.id)).toEqual(corrected); } finally { reopened.close(); }
    expect(db.count('bill-occurrence')).toBe(2);
  });

  it.each(['body', 'account', 'facts', 'empty', 'truncated'] as const)('does not call a %s-only similarity an exact-evidence duplicate', difference => {
    const { store } = fixture(); store.accept(review(), source(), 'fictional-reviewer');
    const mail = source(2), nextFacts = facts();
    if (difference === 'body') mail.message.body += ' A different invoice.';
    if (difference === 'account') mail.accountId = 'fictional-other-account';
    if (difference === 'facts') nextFacts.amountCents = 23456;
    if (difference === 'empty') mail.message.body = '';
    if (difference === 'truncated') mail.message.bodyTruncated = true;
    expect(store.duplicateCandidates(preview(mail, nextFacts), mail).candidates).toEqual([]);
    expect(store.accept({ ...review(mail, nextFacts), limitedSourceAcknowledged: true }, mail, 'fictional-reviewer').duplicateReview).toBeUndefined();
  });

  it('ignores notes in matching but binds all submitted fields to the reviewed digest', () => {
    const { store } = fixture(); store.accept(review(), source(), 'fictional-reviewer');
    const mail = source(2), altered = { ...facts(), note: 'A new note' }, check = store.duplicateCandidates(preview(mail), mail);
    expect(store.duplicateCandidates(preview(mail, altered), mail).candidates).toHaveLength(1);
    expect(() => store.accept({ ...review(mail, altered), duplicateReview: { reviewDigest: check.reviewDigest } }, mail, 'fictional-reviewer')).toThrow(/changed|again/i);
    expect(store.counts().occurrences).toBe(1);
  });

  it.each([null, true, {}, { reviewDigest: 'bad' }, { reviewDigest: 'a'.repeat(64), reviewedBy: 'fictional-forged-reviewer' }])('rejects malformed or caller-authored duplicate audit evidence: %j', duplicateReview => {
    const { store } = fixture(); store.accept(review(), source(), 'fictional-reviewer');
    expect(() => store.accept({ ...review(source(2)), duplicateReview }, source(2), 'fictional-reviewer')).toThrow();
    expect(store.counts().occurrences).toBe(1);
  });

  it('rejects confirmation after a candidate revision changes or another duplicate is saved', () => {
    const { store } = fixture(), original = store.accept(review(), source(), 'fictional-reviewer'), mail = source(2);
    const check = store.duplicateCandidates(preview(mail), mail);
    store.correct(original.id, { ...review(), expectedRevision: 1, state: 'hold' }, source(), 'fictional-reviewer');
    expect(() => store.accept({ ...review(mail), duplicateReview: { reviewDigest: check.reviewDigest } }, mail, 'fictional-reviewer')).toThrow(/changed|again/i);
    const fresh = store.duplicateCandidates(preview(mail), mail), third = source(3), thirdCheck = store.duplicateCandidates(preview(third), third);
    store.accept({ ...review(third), duplicateReview: { reviewDigest: thirdCheck.reviewDigest } }, third, 'fictional-reviewer');
    expect(() => store.accept({ ...review(mail), duplicateReview: { reviewDigest: fresh.reviewDigest } }, mail, 'fictional-reviewer')).toThrow(/changed|again/i);
    expect(store.counts().occurrences).toBe(2);
  });

  it('matches retained earlier source evidence, but does not block a currently cancelled candidate', () => {
    const { store } = fixture(), original = store.accept(review(), source(), 'fictional-reviewer');
    const correctedSource = source(9); correctedSource.message.body += ' Corrected invoice.';
    store.correct(original.id, { ...review(correctedSource), expectedRevision: 1, state: 'received' }, correctedSource, 'fictional-reviewer');
    const check = store.duplicateCandidates(preview(source(2)), source(2));
    expect(check.candidates[0]).toMatchObject({ billId: original.id, revision: 2, matchedRevision: 1, sourceDigest: original.source.digest });
    store.correct(original.id, { ...review(correctedSource), expectedRevision: 2, state: 'cancelled' }, correctedSource, 'fictional-reviewer');
    expect(store.duplicateCandidates(preview(source(2)), source(2)).candidates).toEqual([]);
    expect(() => store.accept({ ...review(source(2)), duplicateReview: { reviewDigest: check.reviewDigest } }, source(2), 'fictional-reviewer')).toThrow(/changed|again/i);
    expect(store.accept(review(source(2)), source(2), 'fictional-reviewer').state).toBe('received');
  });

  it('checks changed correction evidence and preserves the original row until the distinct review succeeds', () => {
    const { store } = fixture(); store.accept(review(), source(), 'fictional-reviewer');
    const separate = source(2); separate.message.body += ' Separate invoice.';
    const row = store.accept(review(separate), separate, 'fictional-reviewer'), changed = source(3);
    const request = { ...review(changed), expectedRevision: row.revision, state: 'received' };
    expect(() => store.correct(row.id, request, changed, 'fictional-reviewer')).toThrow(/possible duplicate/i);
    expect(store.getOccurrence(row.id)).toEqual(row);
    const check = store.duplicateCandidates({ ...preview(changed), billId: row.id }, changed);
    const result = store.correct(row.id, { ...request, duplicateReview: { reviewDigest: check.reviewDigest } }, changed, 'fictional-reviewer');
    expect(result.history[0].source).toEqual(row.source);
    expect(result.duplicateReview?.candidates).toHaveLength(1);
  });

  it('always permits cancellation but requires a fresh review when a cancelled bill is reactivated', () => {
    const { store } = fixture(), first = store.accept(review(), source(), 'fictional-reviewer');
    store.correct(first.id, { ...review(), expectedRevision: 1, state: 'cancelled' }, source(), 'fictional-reviewer');
    const other = store.accept(review(source(2)), source(2), 'fictional-reviewer');
    expect(() => store.correct(first.id, { ...review(), expectedRevision: 2, state: 'received' }, source(), 'fictional-reviewer')).toThrow(/possible duplicate/i);
    const check = store.duplicateCandidates({ ...preview(), billId: first.id }, source());
    const reactivated = store.correct(first.id, { ...review(), expectedRevision: 2, state: 'received', duplicateReview: { reviewDigest: check.reviewDigest } }, source(), 'fictional-reviewer');
    expect(reactivated.duplicateReview?.candidates[0].billId).toBe(other.id);
    expect(store.correct(other.id, { ...review(source(2)), expectedRevision: 1, state: 'cancelled' }, source(2), 'fictional-reviewer').state).toBe('cancelled');
  });

  it('limits candidate output to20, scans beyond the first page, and refuses an incomplete confirmation', () => {
    const { store, db } = fixture();
    for (let n = 1; n <= 21; n++) {
      const mail = source(n), check = store.duplicateCandidates(preview(mail), mail);
      store.accept({ ...review(mail), ...(check.candidates.length ? { duplicateReview: { reviewDigest: check.reviewDigest } } : {}) }, mail, 'fictional-reviewer');
    }
    const mail = source(22), check = store.duplicateCandidates(preview(mail), mail);
    expect(check).toMatchObject({ complete: false, reviewDigest: null }); expect(check.candidates).toHaveLength(20);
    expect(() => store.accept({ ...review(mail), duplicateReview: { reviewDigest: 'a'.repeat(64) } }, mail, 'fictional-reviewer')).toThrow(/too many|more than/i);
    // Read-bounded paging, even when many unrelated records precede a match.
    for (let n = 100; n < 302; n++) { const unrelated = source(n); unrelated.message.body += String(n); store.accept(review(unrelated), unrelated, 'fictional-reviewer'); }
    const page = vi.spyOn(db, 'page');
    expect(store.duplicateCandidates(preview(mail), mail).candidates).toHaveLength(20);
    expect(page.mock.calls.filter(([kind]) => kind === 'bill-occurrence').every(([, options]) => options?.limit === 200)).toBe(true);
    expect(page.mock.calls.filter(([kind]) => kind === 'bill-occurrence').length).toBeGreaterThan(1);
  });

  it('strictly validates optional saved review evidence without invalidating older bill records', () => {
    const { store } = fixture(), first = store.accept(review(), source(), 'fictional-reviewer'), mail = source(2);
    expect(validateOccurrence(first)).toEqual(first);
    const check = store.duplicateCandidates(preview(mail), mail);
    const saved = store.accept({ ...review(mail), duplicateReview: { reviewDigest: check.reviewDigest } }, mail, 'fictional-reviewer');
    expect(validateOccurrence(saved)).toEqual(saved);
    for (const value of [null, {}, { ...saved.duplicateReview, extra: true }, { ...saved.duplicateReview, candidates: [] }, { ...saved.duplicateReview, reviewDigest: 'bad' }, { ...saved.duplicateReview, reason: '' }]) {
      expect(() => validateOccurrence({ ...saved, duplicateReview: value })).toThrow(/recovery/i);
    }
  });

  it('rejects unresolved, altered, self or cancelled historical candidate references in the portable graph', () => {
    const { store } = fixture(), first = store.accept(review(), source(), 'fictional-reviewer'), mail = source(2);
    const check = store.duplicateCandidates(preview(mail), mail);
    const saved = store.accept({ ...review(mail), duplicateReview: { reviewDigest: check.reviewDigest } }, mail, 'fictional-reviewer');
    expect(() => deriveBillLookups([first, saved], [])).not.toThrow();
    for (const change of [{ billId: `source-bill:${'a'.repeat(64)}` }, { billId: saved.id }, { revision: 2 }, { sourceDigest: 'a'.repeat(64) }]) {
      const altered = structuredClone(saved); Object.assign(altered.duplicateReview!.candidates[0], change);
      expect(() => deriveBillLookups([first, altered], [])).toThrow(/recovery/i);
    }
    expect(() => deriveBillLookups([{ ...first, state: 'cancelled' }, saved], [])).toThrow(/recovery/i);
  });
});
