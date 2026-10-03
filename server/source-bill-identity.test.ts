import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceBillRegister, previewBillSource, validateSourceBillRegister } from './source-bills.ts';
import { WorkflowDatabase } from './workflow-database.ts';
import { deriveBillLookups } from './source-bill-graph.ts';
import { BillReviewDraftStore } from './bill-review-drafts.ts';
import { createSourceBillsApi, type BillApiHost } from './source-bills-api.ts';
import type { BillFacts, BillMailSource } from '../shared/source-bills.ts';
import { sameBillFacts } from '../shared/source-bills.ts';
import type { BillReviewDraftValue } from '../shared/bill-review-drafts.ts';

const resources: { dir: string; db: WorkflowDatabase }[] = [];
afterEach(() => { for (const { dir, db } of resources.splice(0)) { db.close(); rmSync(dir, { recursive: true, force: true }); } });
const now = Date.parse('2026-10-01T00:00:00Z');
const facts = (extra: Partial<BillFacts> = {}): BillFacts => ({ propertyId: 'fictional-property', kind: 'Water', vendor: 'Fictional Water', amountCents: 12345, currency: 'AUD', invoiceDate: '2026-10-01', dueDate: '2026-10-21', note: '', invoiceNumber: '000123-A', invoiceVersion: '1', ...extra });
const source = (n = 1): BillMailSource => ({ accountId: 'fictional-account', receiptId: `fictional-scan-${n}`, threadId: `fictional-thread-${n}`, message: {
  id: n.toString(16), at: now, from: 'fictional-vendor@example.test', subject: 'Fictional water invoice', body: `Forward ${n}. See the fictional invoice.`, bodyTruncated: false, attachments: [],
} });
const review = (s = source(), f = facts()) => ({ expectedSourceDigest: previewBillSource(s).digest, sourceReviewed: true, limitedSourceAcknowledged: true, facts: f, reviewReason: 'Fictional original and identity reviewed.' });
const preview = (s = source(), f = facts()) => ({ expectedSourceDigest: previewBillSource(s).digest, facts: f });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fictional-bill-identity-')), db = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 19) }); resources.push({ dir, db });
  return { dir, db, store: new SourceBillRegister(db, { dataDir: dir, now: () => now }) };
}

describe('reviewed business invoice candidates', () => {
  it.each(['forward', 'pdf', 'truncated'] as const)('holds a %s with a reviewed invoice number despite different or absent body text', kind => {
    const { store } = fixture(), original = store.accept(review(), source(), 'fictional-reviewer'), next = source(2);
    if (kind === 'pdf') { next.message.body = ''; next.message.attachments = [{ id: 'fictional-pdf', name: 'invoice.pdf', mimeType: 'application/pdf', size: 200 }]; }
    if (kind === 'truncated') next.message.bodyTruncated = true;
    const check = store.duplicateCandidates(preview(next), next);
    expect(check.candidates).toMatchObject([{ billId: original.id, match: 'invoice-identity', facts: { invoiceNumber: '000123-A', invoiceVersion: '1' } }]);
    expect(() => store.accept(review(next), next, 'fictional-reviewer')).toThrow(/possible duplicate/i);
    expect(store.counts().occurrences).toBe(1);
  });

  it.each([{ invoiceVersion: '2' }, { amountCents: 23456 }, { invoiceDate: '2026-10-02' }, { dueDate: null }, { kind: 'Council' }])('holds conflicting identity facts %j even with a distinctness confirmation', changed => {
    const { store } = fixture(); store.accept(review(), source(), 'fictional-reviewer');
    const mail = source(2), conflicting = facts(changed), check = store.duplicateCandidates(preview(mail, conflicting), mail);
    expect(check.candidates[0].match).toBe('invoice-conflict');
    expect(() => store.accept({ ...review(mail, conflicting), duplicateReview: { reviewDigest: check.reviewDigest } }, mail, 'fictional-reviewer')).toThrow(/conflicting versions or bill facts/i);
    expect(store.counts().occurrences).toBe(1);
  });

  it.each(['number', 'property', 'supplier', 'account'] as const)('does not infer identity across a changed %s', difference => {
    const { store } = fixture(); store.accept(review(), source(), 'fictional-reviewer');
    const mail = source(2), changed = facts();
    if (difference === 'number') changed.invoiceNumber = '123-A';
    if (difference === 'property') changed.propertyId = 'fictional-other-property';
    if (difference === 'supplier') changed.vendor = 'Fictional Water Pty Ltd';
    if (difference === 'account') mail.accountId = 'fictional-other-account';
    expect(store.duplicateCandidates(preview(mail, changed), mail).candidates).toEqual([]);
  });

  it('keeps distinct reviewed numbers separate even when a template body and all other facts are identical', () => {
    const { store } = fixture(); store.accept(review(), source(), 'fictional-reviewer');
    const mail = source(2); mail.message.body = source().message.body;
    const distinct = facts({ invoiceNumber: '000124-A' });
    expect(store.duplicateCandidates(preview(mail, distinct), mail).candidates).toEqual([]);
    expect(store.accept(review(mail, distinct), mail, 'fictional-reviewer').facts.invoiceNumber).toBe('000124-A');
  });

  it('retains the exact-text fallback for a legacy bill with no reviewed invoice number', () => {
    const { store } = fixture(), legacy = facts(); delete legacy.invoiceNumber; delete legacy.invoiceVersion;
    store.accept(review(source(), legacy), source(), 'fictional-reviewer');
    const mail = source(2); mail.message.body = source().message.body;
    expect(store.duplicateCandidates(preview(mail, legacy), mail).candidates[0].match).toBe('exact-evidence');
  });

  it.each(['hold', 'in-process', 'cancelled'] as const)('preserves a legacy distinct-invoice decision when null identity accompanies a %s correction', nextState => {
    const { store, dir } = fixture(), legacy = facts(); delete legacy.invoiceNumber; delete legacy.invoiceVersion;
    store.accept(review(source(), legacy), source(), 'fictional-reviewer');
    const mail = source(2); mail.message.body = source().message.body;
    const check = store.duplicateCandidates(preview(mail, legacy), mail);
    const saved = store.accept({ ...review(mail, legacy), duplicateReview: { reviewDigest: check.reviewDigest } }, mail, 'fictional-reviewer');
    const originalFacts = JSON.stringify(saved.facts), originalAudit = JSON.stringify(saved.duplicateReview);
    const submitted = { ...legacy, invoiceNumber: null, invoiceVersion: null };
    expect(sameBillFacts(saved.facts, submitted)).toBe(true);
    expect(store.accept(review(mail, submitted), mail, 'fictional-reviewer')).toEqual(saved);
    const corrected = store.correct(saved.id, { ...review(mail, submitted), expectedRevision: 1, state: nextState }, mail, 'fictional-reviewer');
    expect(corrected.state).toBe(nextState); expect(corrected.revision).toBe(2);
    expect(JSON.stringify(corrected.facts)).toBe(originalFacts);
    expect(JSON.stringify(corrected.duplicateReview)).toBe(originalAudit);
    expect(corrected.history[0]).toMatchObject({ facts: saved.facts, duplicateReview: saved.duplicateReview });
    expect(store.accept(review(mail, submitted), mail, 'fictional-reviewer')).toEqual(corrected);
    const reopened = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 19) });
    try { expect(new SourceBillRegister(reopened, { dataDir: dir }).getOccurrence(saved.id)).toEqual(corrected); } finally { reopened.close(); }
    expect(store.counts().occurrences).toBe(2);
  });

  it('compares unknown identity canonically without hiding reviewed changes or changing stored null facts', () => {
    const { store } = fixture(), unknown = facts({ invoiceNumber: null, invoiceVersion: null }), legacy = { ...unknown };
    delete legacy.invoiceNumber; delete legacy.invoiceVersion;
    const accepted = store.accept(review(source(), unknown), source(), 'fictional-reviewer');
    expect(store.accept(review(source(), legacy), source(), 'fictional-reviewer')).toEqual(accepted);
    expect(sameBillFacts(unknown, { ...legacy, propertyId: ` ${legacy.propertyId} `, note: ' ' })).toBe(true);
    for (const changed of [{ invoiceNumber: '000123-A' }, { invoiceVersion: '2' }, { invoiceNumber: '' }, { amountCents: 12346 }, { note: 'Review changed' }]) {
      expect(sameBillFacts(unknown, { ...legacy, ...changed })).toBe(false);
    }
    expect(store.getOccurrence(accepted.id)?.facts).toEqual(unknown);
  });

  it('retains explicit name-collision review and portable graph evidence without merging either source', () => {
    const { store, dir } = fixture(); store.accept(review(), source(), 'fictional-reviewer');
    const mail = source(2), changed = facts({ vendor: ' fictional water ' }), check = store.duplicateCandidates(preview(mail, changed), mail);
    const accepted = store.accept({ ...review(mail, changed), duplicateReview: { reviewDigest: check.reviewDigest }, reviewReason: 'Fictional originals confirm two separate suppliers sharing a display name.' }, mail, 'fictional-reviewer');
    expect(accepted.facts.vendor).toBe('fictional water');
    expect(accepted.duplicateReview?.candidates).toHaveLength(1);
    const snapshot = store.snapshot({ from: '2026-10-01', to: '2026-10-31' });
    expect(() => deriveBillLookups(snapshot.occurrences, snapshot.series)).not.toThrow();
    expect(() => validateSourceBillRegister({ version: 1, occurrences: snapshot.occurrences, series: snapshot.series })).not.toThrow();
    const reopened = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 19) });
    try { expect(new SourceBillRegister(reopened, { dataDir: dir }).getOccurrence(accepted.id)).toEqual(accepted); } finally { reopened.close(); }
    const forged = structuredClone(snapshot.occurrences); forged.find(row => row.id === accepted.id)!.facts.amountCents = 23456;
    expect(() => deriveBillLookups(forged, [])).toThrow(/recovery/i);
  });

  it('preserves correction history and prevents an older client silently dropping reviewed identity', () => {
    const { store } = fixture(), original = store.accept(review(), source(), 'fictional-reviewer'), omitted = facts();
    delete omitted.invoiceNumber; delete omitted.invoiceVersion;
    expect(() => store.correct(original.id, { ...review(source(), omitted), expectedRevision: 1, state: 'hold' }, source(), 'fictional-reviewer')).toThrow(/explicitly clear/i);
    const changed = facts({ invoiceVersion: '2', amountCents: 23456 });
    const revised = store.correct(original.id, { ...review(source(), changed), expectedRevision: 1, state: 'hold' }, source(), 'fictional-reviewer');
    expect(revised.history[0].facts.invoiceVersion).toBe('1'); expect(revised.facts.invoiceVersion).toBe('2');
    const cleared = store.correct(original.id, { ...review(source(), facts({ invoiceNumber: null, invoiceVersion: null })), expectedRevision: 2, state: 'hold' }, source(), 'fictional-reviewer');
    expect(cleared.facts).toMatchObject({ invoiceNumber: null, invoiceVersion: null });
  });

  it.each([{ invoiceNumber: '' }, { invoiceNumber: 'x'.repeat(121) }, { invoiceVersion: 'x'.repeat(81) }, { invoiceNumber: null, invoiceVersion: '2' }, { invoiceNumber: 'bad\u0000value' }])('rejects invalid identity fields %j', changed => {
    const { store } = fixture();
    expect(() => store.accept(review(source(), facts(changed)), source(), 'fictional-reviewer')).toThrow();
    expect(store.counts().occurrences).toBe(0);
  });

  it('uses host-owned source and actor at the API, with unchanged property checks and conflict response', async () => {
    const { store } = fixture(), itemId = 'a'.repeat(64); let mail = source();
    const host: BillApiHost = { register: () => store, propertyIds: () => ['fictional-property'], recovery: () => false, actorId: () => 'fictional-host-reviewer',
      source: async () => mail, collect: async () => ({}), savedThread: async () => { throw new Error('not used'); } };
    const call = createSourceBillsApi(host), body = () => ({ itemId, messageId: mail.message.id, ...review(mail) });
    const saved = await call(new URL('http://localhost/api/bill-occurrences'), 'POST', body());
    expect(saved?.body).toMatchObject({ reviewedBy: 'fictional-host-reviewer', facts: { invoiceNumber: '000123-A' } });
    mail = source(2);
    const refused = await call(new URL('http://localhost/api/bill-occurrences'), 'POST', { ...body(), facts: facts({ invoiceVersion: '2' }) });
    expect(refused).toMatchObject({ status: 409, body: { code: 'bill_duplicate_review_required' } });
  });

  it('roundtrips incomplete identity draft fields without changing legacy drafts or granting acceptance', () => {
    const { db, dir } = fixture(), workspaceId = 'fictional-workspace', store = new BillReviewDraftStore(db, { workspaceId, now: () => now });
    const legacy: BillReviewDraftValue = { workspaceId, state: 'editing', billId: null, billRevision: null, itemId: null, messageId: null, sourceDigest: null,
      fields: { propertyId: '', kind: '', vendor: '', amount: '', invoiceDate: '', dueDate: '', note: '' }, billState: 'hold', reason: '', seriesId: '', arrivalDate: '', proposalRequest: null };
    const id = randomUUID(), saved = store.create(id, null, legacy);
    expect(saved.fields).toEqual(legacy.fields);
    const edited = { ...legacy, fields: { ...legacy.fields, invoiceNumber: '', invoiceVersion: 'version still being reviewed' } };
    const updated = store.update(id, 1, edited);
    const reopened = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 19) });
    try { expect(new BillReviewDraftStore(reopened, { workspaceId }).get(id)).toEqual(updated); } finally { reopened.close(); }
    expect(() => store.update(id, 2, { ...edited, fields: { ...edited.fields, invoiceNumber: 'x'.repeat(121) } })).toThrow();
    expect(db.count('bill-occurrence')).toBe(0);
  });

  it.each([{ omitted: ['invoiceNumber'] }, { omitted: ['invoiceVersion'] }, { omitted: ['invoiceNumber', 'invoiceVersion'] }] as const)('refuses an older draft update omitting saved identity fields $omitted, but allows explicit clearing', ({ omitted }) => {
    const { db } = fixture(), workspaceId = 'fictional-workspace', store = new BillReviewDraftStore(db, { workspaceId, now: () => now });
    const initial: BillReviewDraftValue = { workspaceId, state: 'editing', billId: null, billRevision: null, itemId: null, messageId: null, sourceDigest: null,
      fields: { propertyId: '', kind: '', vendor: '', amount: '', invoiceDate: '', dueDate: '', note: '', invoiceNumber: 'INV-001', invoiceVersion: '2' },
      billState: 'hold', reason: '', seriesId: '', arrivalDate: '', proposalRequest: null };
    const id = randomUUID(), saved = store.create(id, null, initial), outdated = structuredClone(initial);
    for (const key of omitted) delete outdated.fields[key];
    outdated.reason = 'An older client changed its note.';
    expect(() => store.update(id, 1, outdated)).toThrow(expect.objectContaining({ status: 409 }));
    expect(store.get(id)).toEqual(saved);
    const cleared: BillReviewDraftValue = { ...initial, fields: { ...initial.fields, invoiceNumber: '', invoiceVersion: '' } };
    expect(store.update(id, 1, cleared).fields).toEqual(cleared.fields);
    delete cleared.fields.invoiceNumber; delete cleared.fields.invoiceVersion;
    expect(store.update(id, 2, cleared).fields).toEqual(cleared.fields);
  });
});
