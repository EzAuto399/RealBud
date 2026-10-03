import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceBillRegister, previewBillSource, validateSourceBillRegister } from './source-bills.ts';
import { WorkflowDatabase } from './workflow-database.ts';
import { deriveBillLookups, validateOccurrence } from './source-bill-graph.ts';
import { BillReviewDraftStore, validateSavedBillReviewDraft, billReviewDraftRecordId } from './bill-review-drafts.ts';
import { createSourceBillsApi, type BillApiHost } from './source-bills-api.ts';
import { isBillFinancialReviewStale, type BillFacts, type BillMailSource, type BillFinancialObservation } from '../shared/source-bills.ts';
import type { BillReviewDraftValue, BillFinancialReviewDraft } from '../shared/bill-review-drafts.ts';

const resources: { dir: string; databases: WorkflowDatabase[] }[] = [];
afterEach(() => { for (const { dir, databases } of resources.splice(0)) { for (const db of databases) db.close(); rmSync(dir, { recursive: true, force: true }); } });
const now = Date.parse('2026-10-01T00:00:00Z');
const facts: BillFacts = { propertyId: 'fictional-property', kind: 'Council', vendor: 'Fictional Council', amountCents: 12345, currency: 'AUD', invoiceDate: '2026-09-20', dueDate: '2026-10-20', note: '' };
const source = (): BillMailSource => ({ accountId: 'fictional-mail-account', receiptId: 'fictional-scan', threadId: 'abcdef', message: {
  id: 'ab', at: now - 1000, from: 'fictional@example.test', subject: 'Fictional bill', body: 'Fictional bill for an isolated test.', attachments: [],
} });
const billReview = (s = source(), f = facts) => ({ expectedSourceDigest: previewBillSource(s).digest, sourceReviewed: true, facts: f, reviewReason: 'Fictional original reviewed.' });
const observation = (extra: Partial<BillFinancialObservation> = {}): BillFinancialObservation => ({ provenance: 'simulated', sourceKind: 'external-record',
  sourceIds: ['SYN-FINANCE-001'], locator: 'Fictional record / simulation only', accountContext: 'Fictional selected office', observedAt: now - 100,
  coverage: 'complete', entry: 'recorded', payment: 'confirmed-paid', funding: 'sufficient', advance: 'outstanding', note: 'Synthetic payment and advance are independent.', ...extra });
const financialRequest = (revision = 1, obs = observation()) => ({ expectedRevision: revision, expectedSourceDigest: previewBillSource(source()).digest,
  sourceReviewed: true, reviewReason: 'Reviewed the fictional financial source and scope.', observation: obs });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fictional-bill-finance-')), db = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 23) });
  const resource = { dir, databases: [db] }; resources.push(resource);
  const store = new SourceBillRegister(db, { dataDir: dir, now: () => now });
  const bill = store.accept(billReview(), source(), 'fictional-reviewer');
  return { dir, db, store, bill, open: () => {
    const other = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 23) }); resource.databases.push(other);
    return new SourceBillRegister(other, { dataDir: dir, now: () => now });
  } };
}
const allUnknown = { entry: 'unknown', payment: 'unknown', funding: 'unknown', advance: 'unknown' } as const;

describe('reviewed financial observations on a bill', () => {
  it('starts legacy bills unknown and persists independent simulated states without rewriting bill facts or calendar', () => {
    const f = fixture(), beforeCalendar = f.store.calendarPage({ from: '2026-09-01', to: '2026-11-01' });
    expect(f.bill.financialReview).toBeUndefined(); expect(isBillFinancialReviewStale(f.bill)).toBe(false);
    const row = f.store.reviewFinancial(f.bill.id, financialRequest(), 'fictional-reviewer');
    expect(row).toMatchObject({ revision: 2, facts, state: 'received', financialReview: { version: 1, basisBillRevision: 1,
      sourceDigest: f.bill.source.digest, provenance: 'simulated', entry: 'recorded', payment: 'confirmed-paid', funding: 'sufficient', advance: 'outstanding', reviewedBy: 'fictional-reviewer' } });
    const { id: _id, createdAt: _createdAt, history: _history, ...basis } = f.bill;
    expect(row.history).toEqual([basis]);
    expect(isBillFinancialReviewStale(row)).toBe(false); expect(f.open().getOccurrence(row.id)).toEqual(row);
    // The due date stays; only the derived payment forecast is withdrawn once the bill is marked paid.
    expect(beforeCalendar.items.map(entry => entry.type)).toEqual(['invoice-due', 'expected-payment']);
    expect(f.store.calendarPage({ from: '2026-09-01', to: '2026-11-01' }).items).toEqual(beforeCalendar.items.filter(entry => entry.type !== 'expected-payment'));
    expect(readFileSync(join(f.dir, 'workflow-state.sqlite')).includes(Buffer.from(row.financialReview!.locator))).toBe(false);
  });

  it('reconciles an exact lost acknowledgement without another revision and rejects a divergent or foreign reviewer replay', () => {
    const f = fixture(), request = financialRequest(), first = f.store.reviewFinancial(f.bill.id, request, 'fictional-reviewer'), counts = f.store.counts();
    expect(f.open().reviewFinancial(f.bill.id, request, 'fictional-reviewer')).toEqual(first);
    expect(f.store.counts()).toEqual(counts);
    for (const changed of [{ ...request, reviewReason: 'Another decision' }, { ...request, observation: observation({ advance: 'recovered' }) }])
      expect(() => f.store.reviewFinancial(f.bill.id, changed, 'fictional-reviewer')).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => f.store.reviewFinancial(f.bill.id, request, 'another-reviewer')).toThrow(expect.objectContaining({ status: 409 }));
    expect(f.store.getOccurrence(f.bill.id)).toEqual(first);
  });

  it('checks revision/source and rechecks after another database handle changes the bill', () => {
    const f = fixture(), other = f.open();
    other.correct(f.bill.id, { ...billReview(), expectedRevision: 1, state: 'hold' }, source(), 'fictional-reviewer');
    expect(() => f.store.reviewFinancial(f.bill.id, financialRequest(), 'fictional-reviewer')).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => f.store.reviewFinancial(f.bill.id, { ...financialRequest(2), expectedSourceDigest: 'f'.repeat(64) }, 'fictional-reviewer')).toThrow(expect.objectContaining({ status: 409 }));
    expect(f.store.getOccurrence(f.bill.id)?.financialReview).toBeUndefined();
  });

  it('keeps a status-only correction current; a fact correction stays stale even after restoration until newly reviewed', () => {
    const f = fixture(), finance = f.store.reviewFinancial(f.bill.id, financialRequest(), 'fictional-reviewer');
    const held = f.store.correct(f.bill.id, { ...billReview(), expectedRevision: 2, state: 'hold' }, source(), 'fictional-reviewer');
    expect(isBillFinancialReviewStale(held)).toBe(false); expect(held.financialReview).toEqual(finance.financialReview);
    const changed = f.store.correct(f.bill.id, { ...billReview(source(), { ...facts, amountCents: 999 }), expectedRevision: 3, state: 'hold' }, source(), 'fictional-reviewer');
    expect(isBillFinancialReviewStale(changed)).toBe(true);
    const restored = f.store.correct(f.bill.id, { ...billReview(), expectedRevision: 4, state: 'hold' }, source(), 'fictional-reviewer');
    expect(isBillFinancialReviewStale(restored)).toBe(true); expect(restored.financialReview).toEqual(finance.financialReview);
    const renewed = f.store.reviewFinancial(f.bill.id, financialRequest(5, observation({ payment: 'unknown' })), 'fictional-reviewer');
    expect(renewed.revision).toBe(6); expect(isBillFinancialReviewStale(renewed)).toBe(false);
    expect(renewed.history[4].financialReview).toEqual(finance.financialReview);
    expect(f.open().getOccurrence(f.bill.id)).toEqual(renewed);
  });

  it('marks source replacement stale even when the old source is later restored', () => {
    const f = fixture(); f.store.reviewFinancial(f.bill.id, financialRequest(), 'fictional-reviewer');
    const changed = source(); changed.message.body += ' New source revision.';
    expect(isBillFinancialReviewStale(f.store.correct(f.bill.id, { ...billReview(changed), expectedRevision: 2, state: 'received' }, changed, 'fictional-reviewer'))).toBe(true);
    const restored = f.store.correct(f.bill.id, { ...billReview(), expectedRevision: 3, state: 'received' }, source(), 'fictional-reviewer');
    expect(isBillFinancialReviewStale(restored)).toBe(true);
  });

  it('retains cancelled review history but refuses new financial observations on the cancelled bill', () => {
    const f = fixture(); const reviewed = f.store.reviewFinancial(f.bill.id, financialRequest(), 'fictional-reviewer');
    const cancelled = f.store.correct(f.bill.id, { ...billReview(), expectedRevision: 2, state: 'cancelled' }, source(), 'fictional-reviewer');
    expect(cancelled.financialReview).toEqual(reviewed.financialReview); expect(isBillFinancialReviewStale(cancelled)).toBe(true);
    expect(() => f.store.reviewFinancial(f.bill.id, financialRequest(3), 'fictional-reviewer')).toThrow(/cancelled/i);
  });

  it('stores actual reviewed document claims distinctly and never infers entry from the document', () => {
    const f = fixture(), row = f.store.reviewFinancial(f.bill.id, financialRequest(1, observation({ provenance: 'actual', sourceKind: 'document', entry: 'unknown', payment: 'unpaid', funding: 'unknown', advance: 'unknown' })), 'fictional-reviewer');
    expect(row.financialReview).toMatchObject({ provenance: 'actual', sourceKind: 'document', entry: 'unknown', payment: 'unpaid' });
    expect(row.financialReview).not.toHaveProperty('externallyVerified');
  });

  it('can preserve a CSV-status note only with all financial dimensions unknown', () => {
    const f = fixture(), csv = observation({ ...allUnknown, provenance: 'actual', sourceKind: 'csv-status', note: 'Fictional sheet label says paid; this is not REI proof.' });
    const saved = f.store.reviewFinancial(f.bill.id, financialRequest(1, csv), 'fictional-reviewer');
    expect(saved.financialReview).toMatchObject(allUnknown);
    expect(saved.financialReview?.note).toBe(csv.note);
  });

  it('can explicitly retain uncertainty without inventing an evidence source or coverage', () => {
    const f = fixture(), unknown = observation({ ...allUnknown, sourceKind: 'unknown', sourceIds: [], locator: '', accountContext: '', coverage: 'unknown' });
    const saved = f.store.reviewFinancial(f.bill.id, financialRequest(1, unknown), 'fictional-reviewer');
    expect(saved.financialReview).toMatchObject({ ...allUnknown, sourceIds: [], coverage: 'unknown', sourceKind: 'unknown' });
    expect(f.open().getOccurrence(f.bill.id)).toEqual(saved);
  });

  it.each([
    { sourceIds: [] }, { locator: '' }, { accountContext: '' }, { coverage: 'unknown' }, { sourceKind: 'csv-status' }, { sourceKind: 'unknown' },
    { sourceKind: 'document' }, { coverage: 'partial', entry: 'not-recorded' }, { coverage: 'partial', advance: 'none' },
    { observedAt: now + 1 }, { observedAt: Number.MAX_SAFE_INTEGER }, { sourceIds: ['same', ' same '] }, { sourceIds: ['two\nidentifiers'] }, { sourceIds: Array.from({ length: 21 }, (_, i) => `SYN-${i}`) },
  ] as Partial<BillFinancialObservation>[])('refuses unsupported or malformed claims %j without mutating the record', changed => {
    const f = fixture();
    expect(() => f.store.reviewFinancial(f.bill.id, financialRequest(1, observation(changed)), 'fictional-reviewer')).toThrow();
    expect(f.store.getOccurrence(f.bill.id)).toEqual(f.bill);
  });

  it('requires explicit reviewer confirmation and rejects caller-supplied audit or verification fields', () => {
    const f = fixture(), request = financialRequest();
    for (const invalid of [{ ...request, sourceReviewed: false }, { ...request, reviewedBy: 'forged' }, { ...request, observation: { ...request.observation, externallyVerified: true } }, { ...request, reviewReason: '' }])
      expect(() => f.store.reviewFinancial(f.bill.id, invalid, 'fictional-reviewer')).toThrow();
    expect(f.store.getOccurrence(f.bill.id)).toEqual(f.bill);
  });

  it('validates portable history and refuses detached, changed or removed retained financial evidence', () => {
    const f = fixture(); const reviewed = f.store.reviewFinancial(f.bill.id, financialRequest(), 'fictional-reviewer');
    const corrected = f.store.correct(f.bill.id, { ...billReview(), expectedRevision: 2, state: 'hold' }, source(), 'fictional-reviewer');
    expect(() => validateOccurrence(corrected)).not.toThrow();
    expect(() => validateSourceBillRegister({ version: 1, occurrences: [corrected], series: [] })).not.toThrow();
    expect(() => deriveBillLookups([corrected], [])).not.toThrow();
    const variants = [structuredClone(corrected), structuredClone(corrected), structuredClone(corrected), structuredClone(reviewed)];
    variants[0].financialReview!.sourceDigest = 'f'.repeat(64);
    variants[1].financialReview!.payment = 'unpaid';
    delete variants[2].financialReview;
    variants[3].facts.amountCents = 100;
    for (const forged of variants) expect(() => validateOccurrence(forged)).toThrow(/recovery/i);
  });

  it('exposes a host-authorized API mutation without collecting mail or allowing source/actor injection', async () => {
    const f = fixture(); let recovery = false, properties = ['fictional-property'];
    const host: BillApiHost = { register: () => f.store, propertyIds: () => properties, recovery: () => recovery, actorId: () => 'host-reviewer',
      source: vi.fn(async () => source()), collect: vi.fn(async () => ({})), savedThread: vi.fn(async () => { throw new Error('not used'); }) };
    const call = createSourceBillsApi(host), url = new URL(`http://localhost/api/bill-occurrences/${f.bill.id}/financial-review`);
    recovery = true; await expect(call(url, 'POST', financialRequest())).rejects.toMatchObject({ status: 503 });
    recovery = false; properties = []; await expect(call(url, 'POST', financialRequest())).rejects.toMatchObject({ status: 409 });
    properties = ['fictional-property']; const saved = await call(url, 'POST', financialRequest());
    expect(saved).toMatchObject({ status: 200, body: { financialReview: { reviewedBy: 'host-reviewer' } } });
    expect(await call(url, 'POST', financialRequest())).toEqual(saved);
    expect(host.source).not.toHaveBeenCalled(); expect(host.collect).not.toHaveBeenCalled();
  });
});

describe('durable financial review drafts', () => {
  const draft = (billId: string, digest: string): BillReviewDraftValue => ({ workspaceId: 'fictional-office', state: 'editing', billId, billRevision: 1,
    itemId: null, messageId: null, sourceDigest: digest, fields: { propertyId: '', kind: '', vendor: '', amount: '', invoiceDate: '', dueDate: '', note: '' },
    billState: 'received', reason: '', seriesId: '', arrivalDate: '', proposalRequest: null,
    financialReview: { ...observation(), sourceIds: 'SYN-FINANCE-001\nStill typing', observedAt: '2026-10-', reviewReason: '' } satisfies BillFinancialReviewDraft });

  it('persists raw financial drafts, lists their discriminator, reconciles lost writes and preserves conflict winners', () => {
    const f = fixture(), store = new BillReviewDraftStore(f.db, { workspaceId: 'fictional-office', now: () => now }), id = randomUUID(), input = draft(f.bill.id, f.bill.source.digest);
    const saved = store.create(id, null, input);
    expect(store.page().items[0]).toMatchObject({ id, billId: f.bill.id, hasFinancialReview: true });
    expect(store.create(id, null, input)).toEqual(saved);
    const otherDb = new WorkflowDatabase({ dir: f.dir, key: Buffer.alloc(32, 23) }); resources.find(r => r.dir === f.dir)!.databases.push(otherDb);
    const other = new BillReviewDraftStore(otherDb, { workspaceId: 'fictional-office', now: () => now }); expect(other.get(id)).toEqual(saved);
    const changed = { ...input, financialReview: { ...input.financialReview!, note: 'An edited fictional note' } };
    const next = other.update(id, 1, changed);
    expect(store.update(id, 1, changed)).toEqual(next);
    expect(() => store.update(id, 1, input)).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => store.update(id, 2, { ...changed, financialReview: undefined })).toThrow();
    const omitted: BillReviewDraftValue = { ...changed }; delete omitted.financialReview;
    expect(() => store.update(id, 2, omitted)).toThrow(expect.objectContaining({ status: 409 }));
    expect(store.get(id)).toEqual(next); expect(f.store.getOccurrence(f.bill.id)?.financialReview).toBeUndefined();
    expect(validateSavedBillReviewDraft(billReviewDraftRecordId(id), next.revision, next)).toEqual(next);
  });

  it('requires a bill/source binding, limits raw fields, and never saves reviewer confirmation or injected authority', () => {
    const f = fixture(), store = new BillReviewDraftStore(f.db, { workspaceId: 'fictional-office', now: () => now }), input = draft(f.bill.id, f.bill.source.digest);
    for (const invalid of [{ ...input, billId: null, billRevision: null }, { ...input, sourceDigest: null },
      { ...input, financialReview: { ...input.financialReview, sourceReviewed: true } },
      { ...input, financialReview: { ...input.financialReview, locator: 'x'.repeat(1001) } }]) expect(() => store.create(randomUUID(), null, invalid)).toThrow();
    expect(store.page().items).toEqual([]);
  });
});
