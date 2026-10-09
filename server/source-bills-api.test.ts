import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowDatabase } from './workflow-database.ts';
import { SourceBillRegister, previewBillSource } from './source-bills.ts';
import { createSourceBillsApi, type BillApiHost } from './source-bills-api.ts';
import { expectedBillsPage } from './expected-bills-page.ts';
import type { BillDuplicateCheck, BillFacts, BillMailSource } from '../shared/source-bills.ts';
import type { JevRequest, JevResult } from './jev-client.ts';
import { removeFixture } from './testing/private-fixture.ts';
import { billSenderEnvelopeDigest } from './source-bill-rules.ts';
import { validateOccurrence } from './source-bill-graph.ts';
import { listHistory } from './computer-history.ts';

const resources: { dir: string; db: WorkflowDatabase }[] = [];
afterEach(async () => { for (const { dir, db } of resources.splice(0)) { db.close(); await removeFixture(dir); } });
const itemId = 'a'.repeat(64), messageId = 'ab';
const now = Date.parse('2026-09-21T01:00:00Z');
const range = { from: '2026-09-01', to: '2026-12-31' };
const facts: BillFacts = { propertyId: 'private-property', kind: 'Water', vendor: 'Fictional utility', amountCents: 12345, currency: 'AUD', invoiceDate: '2026-09-20', dueDate: '2026-10-10', note: 'Synthetic review' };
function fixture(jev?: BillApiHost['jev']) {
  const dir = mkdtempSync(join(tmpdir(), 'rb-bill-api-test-')), db = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 9) });
  resources.push({ dir, db });
  const store = new SourceBillRegister(db, { dataDir: dir, now: () => now });
  const source: BillMailSource = { accountId: 'private-mail', receiptId: 'synthetic-receipt', threadId: 'abc', message: { id: messageId,
    at: now - 1000, from: 'billing@example.test', subject: 'Fictional water invoice', body: 'Please review this fictional invoice.', bodyTruncated: false, attachments: [] } };
  let recovering = false, propertyIds = ['private-property'];
  const reviewContext = { workspaceId: 'fictional-private-workspace', setupRevision: 1, accountId: source.accountId as string | null };
  const host = {
    sourceToken: vi.fn(() => db.changeToken()),
    withReviewContext: async <T>(work: (context: typeof reviewContext) => T) => work(reviewContext),
    register: vi.fn(() => store),
    source: vi.fn(async (item: string, message: string) => {
      if (item !== itemId || message !== messageId) throw Object.assign(new Error('Saved message unavailable.'), { status: 404 });
      return structuredClone(source);
    }),
    savedThread: vi.fn(async (accountId: string, threadId: string) => ({ itemId, accountId, receiptId: source.receiptId,
      thread: { id: threadId, historyComplete: true, messages: [{ ...source.message, threadId, to: 'office@example.test', direction: 'incoming' as const, bodyTruncated: false }] } })),
    propertyIds: vi.fn(() => propertyIds), actorId: vi.fn(() => 'private-local-reviewer'), recovery: vi.fn(() => recovering),
    collect: vi.fn(async () => ({ latestScan: { status: 'complete' } })), now: () => now, ...(jev ? { jev } : {}),
  } satisfies BillApiHost;
  const handle = createSourceBillsApi(host);
  const call = (path: string, method = 'GET', body?: unknown) => handle(new URL(path, 'http://127.0.0.1'), method, body);
  const acceptance = () => ({ itemId, messageId, expectedSourceDigest: previewBillSource(source).digest, sourceReviewed: true, facts: structuredClone(facts), reviewReason: 'Human reviewed the saved message.' });
  return { dir, db, store, host, source, call, acceptance, reviewContext, recovery: (value: boolean) => { recovering = value; }, properties: (value: string[]) => { propertyIds = value; } };
}

describe('actual original sender staff review', () => {
  function forwardedFixture() {
    const f = fixture(), originalItemId = 'b'.repeat(64), originalMessageId = 'cd';
    const original: BillMailSource = { ...structuredClone(f.source), receiptId: 'actual-original-receipt', threadId: 'original-thread', message: { ...structuredClone(f.source.message), id: originalMessageId, at: f.source.message.at - 1000, from: 'billing@original.example.test', authResults: 'mx.google.com; dmarc=pass header.from=original.example.test', subject: 'Original fictional invoice' } };
    f.source.message.subject = 'Fwd: Original fictional invoice'; f.source.message.body = '---------- Forwarded message ---------\nFrom: billing@original.example.test\nFictional invoice';
    f.source.message.from = 'office@forwarder.example.test';
    f.host.source.mockImplementation(async (id, message) => {
      if (id === itemId && message === messageId) return structuredClone(f.source);
      if (id === originalItemId && message === originalMessageId) return structuredClone(original);
      throw Object.assign(new Error('Actual original unavailable'), { status: 404 });
    });
    const evidence = previewBillSource(original);
    const input = { ...f.acceptance(), expectedWorkspaceId: f.reviewContext.workspaceId, expectedSetupRevision: f.reviewContext.setupRevision, expectedAccountId: f.reviewContext.accountId,
      originalSourceReviewed: true, forwardedOriginalSource: { itemId: originalItemId, messageId: originalMessageId, expectedSourceDigest: evidence.digest, expectedEnvelopeDigest: billSenderEnvelopeDigest(evidence) } };
    return { ...f, original, input, originalItemId, originalMessageId };
  }
  it('persists exact trusted original provenance with host review identity and strict portable graph admission', async () => {
    const f = forwardedFixture(), saved = (await f.call('/api/bill-occurrences', 'POST', f.input))!.body as any;
    expect(saved.forwardedSenderReview).toMatchObject({ version: 1, forwardedSourceDigest: f.input.expectedSourceDigest, originalItemId: f.originalItemId, originalEnvelopeDigest: f.input.forwardedOriginalSource.expectedEnvelopeDigest, reviewedBy: 'private-local-reviewer', reviewedAt: now });
    expect(saved.forwardedSenderReview.originalSource).toEqual(previewBillSource(f.original));
    const portable = JSON.parse(JSON.stringify(saved)); expect(validateOccurrence(portable)).toEqual(saved);
    const reopened = new SourceBillRegister(f.db, { dataDir: f.dir, now: () => now }); expect(reopened.getOccurrence(saved.id)).toEqual(saved);
    for (const mutate of [(row: any) => { row.forwardedSenderReview.originalSource.message.from = 'spoofed@example.test'; }, (row: any) => { row.forwardedSenderReview.originalSource.message.extra = 'unadmitted'; }, (row: any) => { row.forwardedSenderReview.originalSource.accountId = 'other-account'; }]) {
      const tampered = structuredClone(saved); mutate(tampered); expect(() => validateOccurrence(tampered)).toThrow(/recovery/);
    }
  });
  it('requires separate human confirmation and rejects missing, wrong-account, changed, forwarded or caller-supplied original evidence', async () => {
    const f = forwardedFixture();
    await expect(f.call('/api/bill-occurrences', 'POST', { ...f.input, originalSourceReviewed: false })).rejects.toMatchObject({ status: 400 });
    await expect(f.call('/api/bill-occurrences', 'POST', { ...f.input, forwardedOriginalSource: { ...f.input.forwardedOriginalSource, itemId: 'c'.repeat(64) } })).rejects.toMatchObject({ status: 404 });
    await expect(f.call('/api/bill-occurrences', 'POST', { ...f.input, forwardedOriginalSource: { ...f.input.forwardedOriginalSource, sender: 'caller@fake.test' } })).rejects.toMatchObject({ status: 400 });
    f.original.accountId = 'other-account'; await expect(f.call('/api/bill-occurrences', 'POST', f.input)).rejects.toMatchObject({ status: 409 }); f.original.accountId = f.source.accountId;
    f.original.message.authResults = 'mx.google.com; dmarc=fail header.from=original.example.test';
    expect(previewBillSource(f.original).digest).toBe(f.input.forwardedOriginalSource.expectedSourceDigest); // Legacy hashes deliberately do not bind these headers.
    await expect(f.call('/api/bill-occurrences', 'POST', f.input)).rejects.toMatchObject({ status: 409 });
    f.input.forwardedOriginalSource.expectedEnvelopeDigest = billSenderEnvelopeDigest(previewBillSource(f.original));
    f.original.message.subject = 'Fwd: another copy'; f.input.forwardedOriginalSource.expectedSourceDigest = previewBillSource(f.original).digest; f.input.forwardedOriginalSource.expectedEnvelopeDigest = billSenderEnvelopeDigest(previewBillSource(f.original));
    await expect(f.call('/api/bill-occurrences', 'POST', f.input)).rejects.toThrow('Another forwarded copy');
    expect(f.store.counts().occurrences).toBe(0);
  });
  it('checks changed source and current setup/account/workspace after awaits, and accepts the stable retry', async () => {
    const f = forwardedFixture(); let token = 'initial'; f.host.sourceToken.mockImplementation(() => token);
    const sourceRead = f.host.source.getMockImplementation()!;
    f.host.source.mockImplementation(async (id, message) => { const saved = await sourceRead(id, message); if (id === f.originalItemId) token = 'source changed during original read'; return saved; });
    await expect(f.call('/api/bill-occurrences', 'POST', f.input)).rejects.toThrow('source envelope changed'); expect(f.store.counts().occurrences).toBe(0);
    f.host.source.mockImplementation(sourceRead);
    for (const context of [{ workspaceId: 'replaced' }, { setupRevision: 2 }, { accountId: 'other-account' }]) {
      const old = { ...f.reviewContext }; Object.assign(f.reviewContext, context);
      await expect(f.call('/api/bill-occurrences', 'POST', f.input)).rejects.toMatchObject({ status: 409 }); Object.assign(f.reviewContext, old);
    }
    const saved = (await f.call('/api/bill-occurrences', 'POST', f.input))!.body as any;
    await expect(f.call(`/api/bill-occurrences/${saved.id}`, 'PUT', { ...f.input, expectedRevision: saved.revision - 1, state: 'received' })).rejects.toThrow('revision');
    expect(f.store.getOccurrence(saved.id)?.forwardedSenderReview).toBeDefined();
  });
});

describe('private source-bill host API', () => {
  it('previews exact-evidence candidates without writing, then requires an explicit current distinctness review', async () => {
    const f = fixture(), original = (await f.call('/api/bill-occurrences', 'POST', f.acceptance()))!.body;
    f.source.message.id = 'ac'; f.source.threadId = 'def';
    f.host.source.mockImplementation(async () => structuredClone(f.source));
    const input = { itemId, messageId: 'ac', expectedSourceDigest: previewBillSource(f.source).digest, facts };
    const before = f.store.counts();
    const check = (await f.call('/api/bill-occurrences/duplicate-candidates', 'POST', input))!.body as { reviewDigest: string };
    expect(check).toMatchObject({ complete: true, candidates: [{ billId: (original as { id: string }).id }] });
    expect(f.store.counts()).toEqual(before); expect(f.host.collect).not.toHaveBeenCalled();
    const accepted = { ...input, sourceReviewed: true, reviewReason: 'Two separately checked fictional invoice originals.' };
    expect(await f.call('/api/bill-occurrences', 'POST', accepted)).toMatchObject({ status: 409, body: { code: 'bill_duplicate_review_required' } });
    const saved = await f.call('/api/bill-occurrences', 'POST', { ...accepted, duplicateReview: { reviewDigest: check.reviewDigest } });
    expect(saved).toMatchObject({ status: 200, body: { duplicateReview: { reviewedBy: 'private-local-reviewer', reason: accepted.reviewReason } } });
    expect(f.store.counts().occurrences).toBe(2);
  });

  describe('Jev ordering of duplicate candidates', () => {
    const route = '/api/bill-occurrences/duplicate-candidates';
    /** Two saved bills from the same fictional evidence, then a third message to review against both. */
    async function third(answer: (request: JevRequest, options?: { signal?: AbortSignal }) => JevResult | Promise<JevResult>) {
      let ready = false;
      const decide = vi.fn(async (request: JevRequest, options?: { signal?: AbortSignal }) => answer(request, options));
      const f = fixture({ ready: () => ready, decide });
      await f.call('/api/bill-occurrences', 'POST', f.acceptance());
      const use = (id: string, thread: string) => {
        f.source.message.id = id; f.source.threadId = thread; f.host.source.mockImplementation(async () => structuredClone(f.source));
        return { itemId, messageId: id, expectedSourceDigest: previewBillSource(f.source).digest, facts };
      };
      const second = use('ac', 'def'), check = (await f.call(route, 'POST', second))!.body as BillDuplicateCheck;
      await f.call('/api/bill-occurrences', 'POST', { ...second, sourceReviewed: true, reviewReason: 'Two separately checked fictional invoice originals.', duplicateReview: { reviewDigest: check.reviewDigest } });
      const input = use('ad', 'fed'); ready = true;
      return { f, decide, input, ready: (value: boolean) => { ready = value; }, read: async (body: object = input, rank = true) => (await f.call(route, 'POST', rank ? { ...body, rank } : body))!.body as BillDuplicateCheck };
    }
    const noul = (values: number[]) => (request: JevRequest): JevResult => ({ ok: true, id: "dec-fictional", model: 'fictional-jev', ms: 1,
      answers: Object.fromEntries(Object.keys(request.questions).map((key, n) => [key, { type: 'noul' as const, noul: values[n]! }])) });

    it('ranks once per review digest, keeps the digest and still holds the save', async () => {
      const { f, decide, read, input } = await third(noul([0.2, 0.95]));
      const first = await read(), again = await read();
      expect(decide).toHaveBeenCalledTimes(1);
      expect(again).toEqual(first);
      expect(first.candidates).toHaveLength(2);
      const plain = [...first.candidates].map(c => c.billId).sort();
      expect(first.candidates.map(c => c.billId)).toEqual([plain[1], plain[0]]);
      expect(first.candidates.map(c => c.likely)).toEqual(['same', undefined]);
      expect(await f.call('/api/bill-occurrences', 'POST', { ...input, sourceReviewed: true, reviewReason: 'Checked fictional originals.' })).toMatchObject({ status: 409, body: { code: 'bill_duplicate_review_required' } });
      const saved = await f.call('/api/bill-occurrences', 'POST', { ...input, sourceReviewed: true, reviewReason: 'Checked fictional originals.', duplicateReview: { reviewDigest: first.reviewDigest } });
      expect(saved).toMatchObject({ status: 200 });
      // The ranking keeps no record of its own: its one decision is a history row.
      expect(listHistory(1)[0]).toMatchObject({ name: 'bill duplicate ranking', usage: { requestIds: ['dec-fictional'], calls: 1, decisions: [{ id: 'dec-fictional', model: 'fictional-jev', ms: 1 }] } });
    });

    it.each(['refused', 'budget', 'invalid'] as const)('keeps today\'s order after a hard %s and does not ask again for that review', async reason => {
      const { decide, read } = await third(() => ({ ok: false, reason }));
      const first = await read();
      expect(first.candidates.map(c => c.billId)).toEqual(first.candidates.map(c => c.billId).sort());
      expect(first.candidates.every(c => c.likely === undefined)).toBe(true);
      await read(); expect(decide).toHaveBeenCalledTimes(1);
    });

    it.each(['timeout', 'unavailable', 'http'] as const)('retries once after a transient %s, then keeps today\'s order', async reason => {
      const { decide, read } = await third(() => ({ ok: false, reason }));
      for (let n = 0; n < 4; n++) expect((await read()).candidates.every(c => c.likely === undefined)).toBe(true);
      expect(decide).toHaveBeenCalledTimes(2);
    });

    it('ranks on the retry when the transient failure clears', async () => {
      let calls = 0;
      const { decide, read } = await third(request => ++calls === 1 ? { ok: false, reason: 'unavailable' } : noul([0.95, 0.05])(request));
      expect((await read()).candidates.some(c => c.likely)).toBe(false);
      expect((await read()).candidates.map(c => c.likely)).toEqual(['same', 'different']);
      await read(); expect(decide).toHaveBeenCalledTimes(2);
    });

    it('never calls Jev for the pre-save check: kept order if ranked, otherwise today\'s order', async () => {
      const { decide, read } = await third(noul([0.2, 0.95]));
      const before = await read(undefined, false);
      expect(decide).not.toHaveBeenCalled();
      expect(before.candidates.map(c => c.billId)).toEqual(before.candidates.map(c => c.billId).sort());
      const reviewed = await read();
      expect(await read(undefined, false)).toEqual(reviewed);
      expect(decide).toHaveBeenCalledTimes(1);
    });

    it('stops ranking at the 3 s budget with today\'s order, and the pre-save check does not wait for it', async () => {
      const { decide, read } = await third((_request, options) => new Promise<JevResult>(resolve => options?.signal?.addEventListener('abort', () => resolve({ ok: false, reason: 'aborted' }))));
      const started = Date.now(), reviewing = read();
      await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
      const saving = await read(undefined, false);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(saving.candidates.every(c => c.likely === undefined)).toBe(true);
      const ranked = await reviewing;
      expect(Date.now() - started).toBeGreaterThanOrEqual(2_900); expect(Date.now() - started).toBeLessThan(4_500);
      expect(ranked.candidates.map(c => c.billId)).toEqual(ranked.candidates.map(c => c.billId).sort());
      expect(ranked.candidates.every(c => c.likely === undefined)).toBe(true);
    }, 10_000);

    it('refuses a rank flag other than true', async () => {
      const { f, input } = await third(noul([0.5, 0.5]));
      await expect(f.call(route, 'POST', { ...input, rank: 'yes' })).rejects.toMatchObject({ status: 400 });
    });

    it('asks nothing when Jev is not ready and ranks afresh when the reviewed facts change', async () => {
      const { decide, read, input, ready } = await third(noul([0.95, 0.05]));
      ready(false); expect((await read()).candidates.every(c => c.likely === undefined)).toBe(true); expect(decide).not.toHaveBeenCalled();
      ready(true); await read(); await read({ ...input, facts: { ...facts, note: 'Changed fictional note' } });
      expect(decide).toHaveBeenCalledTimes(2);
    });
  });

  it.each(['source', 'actorId', 'accountId', 'candidateIds', 'reviewDigest'])('rejects caller-controlled duplicate preview %s', field => {
    const f = fixture();
    const input = { itemId, messageId, expectedSourceDigest: previewBillSource(f.source).digest, facts, [field]: 'fictional-forged-value' };
    return expect(f.call('/api/bill-occurrences/duplicate-candidates', 'POST', input)).rejects.toMatchObject({ status: 400 });
  });

  it.each(['recovery', 'property'] as const)('rechecks %s after duplicate preview source resolution', async changed => {
    const f = fixture();
    f.host.source.mockImplementationOnce(async () => { if (changed === 'recovery') f.recovery(true); else f.properties([]); return f.source; });
    await expect(f.call('/api/bill-occurrences/duplicate-candidates', 'POST', { itemId, messageId, expectedSourceDigest: previewBillSource(f.source).digest, facts })).rejects.toMatchObject({ status: changed === 'recovery' ? 503 : 409 });
    expect(f.host.register).not.toHaveBeenCalled(); expect(f.host.collect).not.toHaveBeenCalled();
  });

  it('accepts only a host-resolved saved message and host actor, preserving evidence across rescan and restart', async () => {
    const f = fixture();
    const preview = await f.call(`/api/bill-evidence/${itemId}?messageId=${messageId}`);
    expect(preview).toEqual({ status: 200, body: { ...previewBillSource(f.source), senderEnvelopeDigest: billSenderEnvelopeDigest(previewBillSource(f.source)) } });
    const accepted = await f.call('/api/bill-occurrences', 'POST', f.acceptance());
    expect(accepted).toMatchObject({ status: 200, body: { revision: 1, source: previewBillSource(f.source), reviewedBy: 'private-local-reviewer', facts } });
    expect(f.host.source).toHaveBeenLastCalledWith(itemId, messageId);
    f.source.receiptId = 'later-receipt';
    expect(await f.call('/api/bill-occurrences', 'POST', f.acceptance())).toEqual(accepted);
    const reopened = new WorkflowDatabase({ dir: f.dir, key: Buffer.alloc(32, 9) });
    try { expect(new SourceBillRegister(reopened, { dataDir: f.dir }).snapshot(range).occurrences).toEqual([accepted!.body]); }
    finally { reopened.close(); }
  });

  it.each(['source', 'actorId', 'reviewedBy', 'accountId', 'receiptId'] as const)('rejects client %s injection without saving a bill', async field => {
    const f = fixture();
    await expect(f.call('/api/bill-occurrences', 'POST', { ...f.acceptance(), [field]: field === 'source' ? f.source : 'forged-authority' })).rejects.toMatchObject({ status: 400 });
    expect(f.store.snapshot(range).occurrences).toEqual([]);
  });

  it('rejects an unavailable source, changed digest or property outside the current private directory', async () => {
    const f = fixture();
    await expect(f.call('/api/bill-occurrences', 'POST', { ...f.acceptance(), itemId: 'b'.repeat(64) })).rejects.toMatchObject({ status: 404 });
    await expect(f.call('/api/bill-occurrences', 'POST', { ...f.acceptance(), expectedSourceDigest: 'b'.repeat(64) })).rejects.toMatchObject({ status: 409 });
    await expect(f.call('/api/bill-occurrences', 'POST', { ...f.acceptance(), facts: { ...facts, propertyId: 'another-agency-property' } })).rejects.toMatchObject({ status: 409 });
    expect(f.store.snapshot(range).occurrences).toEqual([]);
  });

  it.each(['/api/bill-occurrences', '/api/bill-scan', '/api/bill-series', `/api/bill-occurrences/source-bill:${'c'.repeat(64)}`, `/api/bill-series/bill-series:${'c'.repeat(36)}`])(
    'blocks %s before source/provider reads or register writes when private recovery is active', async path => {
      const f = fixture(); f.recovery(true);
      await expect(f.call(path, path.includes('/source-bill:') || path.includes('/bill-series:') ? 'PUT' : 'POST', f.acceptance())).rejects.toMatchObject({ status: 503 });
      expect(f.host.source).not.toHaveBeenCalled(); expect(f.host.register).not.toHaveBeenCalled(); expect(f.host.collect).not.toHaveBeenCalled();
    });

  it.each(['accept', 'correct'] as const)('rechecks recovery after a saved source await before %s writes', async operation => {
    const f = fixture();
    const { itemId: _item, messageId: _message, ...review } = f.acceptance();
    const existing = operation === 'correct' ? f.store.accept(review, f.source, 'private-local-reviewer') : null;
    const before = f.store.snapshot(range);
    let release!: () => void, entered!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    f.host.source.mockImplementationOnce(async () => { entered(); await pending; return f.source; });
    const result = f.call(existing ? `/api/bill-occurrences/${existing.id}` : '/api/bill-occurrences', existing ? 'PUT' : 'POST',
      existing ? { ...f.acceptance(), expectedRevision: existing.revision, state: 'hold' } : f.acceptance());
    await started; f.recovery(true); release();
    await expect(result).rejects.toMatchObject({ status: 503 });
    expect(f.host.register).not.toHaveBeenCalled(); expect(f.store.snapshot(range)).toEqual(before);
  });

  it('routes a revision-bound correction and approved pattern changes through the real encrypted register', async () => {
    const f = fixture(); await f.call('/api/bill-occurrences', 'POST', f.acceptance());
    const occurrence = f.store.snapshot(range).occurrences[0];
    const correction = { ...f.acceptance(), expectedRevision: occurrence.revision, state: 'hold', facts: { ...facts, note: 'Investigate a discrepancy.' } };
    expect(await f.call(`/api/bill-occurrences/${occurrence.id}`, 'PUT', correction)).toMatchObject({ status: 200, body: { revision: 2, state: 'hold', history: [{ revision: 1, state: 'received' }] } });
    await expect(f.call(`/api/bill-occurrences/${occurrence.id}`, 'PUT', correction)).rejects.toMatchObject({ status: 409 });
    const settings = { intervalMonths: 1, anchorDate: '2026-09-21', windowBeforeDays: 0, windowAfterDays: 0, timeZone: 'Australia/Brisbane', reviewReason: 'Confirmed monthly arrival.' };
    expect(await f.call('/api/bill-series', 'POST', { ...settings, occurrenceId: occurrence.id, expectedOccurrenceRevision: 2 })).toMatchObject({ status: 200, body: { revision: 1, active: true, reviewedBy: 'private-local-reviewer' } });
    const series = f.store.snapshot(range).series[0];
    expect(await f.call(`/api/bill-series/${series.id}`, 'PUT', { ...settings, expectedRevision: 1, active: false })).toMatchObject({ status: 200, body: { revision: 2, active: false, history: [{ revision: 1, active: true }] } });
    await expect(f.call(`/api/bill-series/${series.id}`, 'PUT', { ...settings, expectedRevision: 1, active: true })).rejects.toMatchObject({ status: 409 });
  });

  it('rechecks the current property directory after source resolution', async () => {
    const f = fixture();
    f.host.source.mockImplementationOnce(async () => { f.properties([]); return f.source; });
    await expect(f.call('/api/bill-occurrences', 'POST', f.acceptance())).rejects.toMatchObject({ status: 409 });
    expect(f.host.register).not.toHaveBeenCalled(); expect(f.store.snapshot(range).occurrences).toEqual([]);
  });

  it('rejects approving a new arrival pattern for a property removed from the private directory', async () => {
    const f = fixture(); await f.call('/api/bill-occurrences', 'POST', f.acceptance());
    const occurrence = f.store.snapshot(range).occurrences[0]; f.properties([]);
    await expect(f.call('/api/bill-series', 'POST', { occurrenceId: occurrence.id, expectedOccurrenceRevision: occurrence.revision,
      intervalMonths: 1, anchorDate: '2026-09-21', windowBeforeDays: 0, windowAfterDays: 0, timeZone: 'Australia/Brisbane', reviewReason: 'Confirmed monthly arrival.' })).rejects.toMatchObject({ status: 409 });
    expect(f.store.snapshot(range).series).toEqual([]);
  });

  it('allows pausing a pattern after property removal but rejects reactivation until the property is current', async () => {
    const f = fixture(); await f.call('/api/bill-occurrences', 'POST', f.acceptance());
    const occurrence = f.store.snapshot(range).occurrences[0];
    const settings = { intervalMonths: 1, anchorDate: '2026-09-21', windowBeforeDays: 0, windowAfterDays: 0, timeZone: 'Australia/Brisbane', reviewReason: 'Confirmed monthly arrival.' };
    await f.call('/api/bill-series', 'POST', { ...settings, occurrenceId: occurrence.id, expectedOccurrenceRevision: occurrence.revision });
    const series = f.store.snapshot(range).series[0]; f.properties([]);
    expect(await f.call(`/api/bill-series/${series.id}`, 'PUT', { ...settings, expectedRevision: series.revision, active: false })).toMatchObject({ status: 200, body: { active: false } });
    await expect(f.call(`/api/bill-series/${series.id}`, 'PUT', { ...settings, expectedRevision: series.revision + 1, active: true })).rejects.toMatchObject({ status: 409 });
    expect(f.store.snapshot(range).series[0]).toMatchObject({ active: false, revision: series.revision + 1 });
  });

  it.each(['hold', 'cancelled'] as const)('can set an already linked bill to %s after pausing its arrival pattern without erasing the historical link', async state => {
    const f = fixture(); await f.call('/api/bill-occurrences', 'POST', f.acceptance());
    const origin = f.store.snapshot(range).occurrences[0];
    const settings = { intervalMonths: 1, anchorDate: '2026-09-21', windowBeforeDays: 0, windowAfterDays: 0, timeZone: 'Australia/Brisbane', reviewReason: 'Confirmed monthly arrival.' };
    await f.call('/api/bill-series', 'POST', { ...settings, occurrenceId: origin.id, expectedOccurrenceRevision: origin.revision });
    const series = f.store.snapshot(range).series[0];
    const nextSource = { ...f.source, threadId: 'abd', message: { ...f.source.message, id: 'ac', at: Date.parse('2026-10-21T01:00:00Z'), body: 'Fictional next monthly invoice.' } };
    f.host.source.mockImplementation(async () => nextSource);
    const accepted = { ...f.acceptance(), itemId: 'b'.repeat(64), messageId: 'ac', expectedSourceDigest: previewBillSource(nextSource).digest,
      seriesId: series.id, expectedArrivalDate: '2026-10-21' };
    await f.call('/api/bill-occurrences', 'POST', accepted);
    const linked = f.store.snapshot(range).occurrences.find(row => row.source.message.id === 'ac')!;
    await f.call(`/api/bill-series/${series.id}`, 'PUT', { ...settings, expectedRevision: series.revision, active: false });
    expect(await f.call(`/api/bill-occurrences/${linked.id}`, 'PUT', { ...accepted, expectedRevision: linked.revision, state })).toMatchObject({ status: 200,
      body: { state, seriesId: series.id, expectedArrivalDate: '2026-10-21', history: [{ state: 'received', seriesId: series.id, expectedArrivalDate: '2026-10-21' }] } });
  });

  it('keeps local source viewing available during recovery without contacting the provider', async () => {
    const f = fixture(); f.recovery(true);
    expect((await f.call(`/api/bill-evidence/${itemId}?messageId=${messageId}`))?.status).toBe(200);
    expect((await f.call('/api/bill-register?from=2026-09-01&to=2026-12-31'))?.status).toBe(200);
    expect(f.host.collect).not.toHaveBeenCalled();
  });

  it('collects the reviewed host scope only for an explicit empty-body request', async () => {
    const f = fixture();
    for (const invalid of [undefined, null, [], { accountId: 'other-account' }, { query: 'anything' }, { maxMessages: 500 }]) {
      await expect(f.call('/api/bill-scan', 'POST', invalid)).rejects.toMatchObject({ status: 400 });
    }
    expect(f.host.collect).not.toHaveBeenCalled();
    expect(await f.call('/api/bill-scan', 'POST', {})).toEqual({ status: 200, body: { latestScan: { status: 'complete' } } });
    expect(f.host.collect).toHaveBeenCalledExactlyOnceWith();
  });

  it.each(['', '?messageId=', '?messageId=not-a-gmail-id', '?messageId=ab%2Fcd', `?messageId=${'a'.repeat(129)}`])('rejects unsupported message parameters %s', async query => {
    const f = fixture();
    await expect(f.call(`/api/bill-evidence/${itemId}${query}`)).rejects.toMatchObject({ status: 400 });
    expect(f.host.source).not.toHaveBeenCalled();
  });

  it.each([
    ['/api/bill-register', 'POST'], ['/api/bill-evidence/not-an-id?messageId=ab', 'GET'], [`/api/bill-evidence/${itemId}`, 'POST'],
    ['/api/bill-occurrences/source-bill:bad', 'PUT'], ['/api/bill-series', 'DELETE'], ['/api/bill-series/bill-series:bad', 'PUT'], ['/api/bill-scan', 'GET'],
  ])('rejects an unsupported ID or method: %s %s', async (path, method) => {
    const f = fixture();
    expect(await f.call(path, method, f.acceptance())).toEqual({ status: 404, body: { error: 'Unknown bill review action.' } });
    expect(f.host.source).not.toHaveBeenCalled(); expect(f.host.register).not.toHaveBeenCalled(); expect(f.host.collect).not.toHaveBeenCalled();
  });

  it('passes unrelated paths through and refuses invalid or unbounded date ranges', async () => {
    const f = fixture();
    expect(await f.call('/api/bill-register-lookalike')).toBeNull(); expect(await f.call('/api/other')).toBeNull();
    for (const range of ['from=2026-02-30&to=2026-03-01', 'from=2026-10-01&to=2026-09-01', 'from=2026-01-01&to=2030-01-01']) {
      await expect(f.call(`/api/bill-register?${range}`)).rejects.toMatchObject({ status: 400 });
    }
    expect((await f.call('/api/bill-register'))?.status).toBe(200);
  });

  it.each([
    '/api/bill-register?limit=101', '/api/bill-register?limit=01', '/api/bill-register?limit=2&limit=3',
    '/api/bill-register?propertyId=', '/api/bill-register?propertyId=%00', '/api/bill-register?accountId=other',
    '/api/bill-occurrences?cursor=', '/api/bill-occurrences?cursor=not-json', '/api/bill-series?limit=1.5',
    '/api/bill-register/calendar?from=2026-09-01&from=2026-09-02',
    '/api/bill-series/matching?accountId=mail&propertyId=private-property&kind=Water',
    `/api/bill-evidence/${itemId}?messageId=ab&messageId=ac`,
  ])('strictly rejects invalid, duplicate or widened list options: %s', async path => {
    const f = fixture();
    await expect(f.call(path)).rejects.toMatchObject({ status: 400 });
    expect(f.host.source).not.toHaveBeenCalled(); expect(f.host.collect).not.toHaveBeenCalled();
  });

  it('resolves current saved source by authoritative bill identity while preserving historical evidence when it is unavailable', async () => {
    const f = fixture(), accepted = await f.call('/api/bill-occurrences','POST',f.acceptance());
    const id = (accepted!.body as { id: string }).id;
    f.recovery(true);
    expect(await f.call(`/api/bill-occurrences/${id}/source`)).toMatchObject({ status: 200, body: { itemId, accountId: f.source.accountId, thread: { id: f.source.threadId } } });
    expect(f.host.savedThread).toHaveBeenLastCalledWith(f.source.accountId,f.source.threadId);
    await expect(f.call(`/api/bill-occurrences/${id}/source?accountId=other`)).rejects.toMatchObject({ status: 400 });
    f.host.savedThread.mockRejectedValueOnce(Object.assign(new Error('Unavailable.'),{status:404}));
    await expect(f.call(`/api/bill-occurrences/${id}/source`)).rejects.toMatchObject({status:404});
    expect(await f.call(`/api/bill-occurrences/${id}`)).toMatchObject({ body: { occurrence: { source: previewBillSource(f.source) } } });
    const wrong = await f.host.savedThread(f.source.accountId,f.source.threadId);
    f.host.savedThread.mockResolvedValueOnce({ ...wrong, accountId: 'another-account' });
    await expect(f.call(`/api/bill-occurrences/${id}/source`)).rejects.toMatchObject({status:503});
  });

  it('keeps the 501st saved bill and 101st arrival pattern addressable without a full-register API projection', async () => {
    const f = fixture(), saved: ReturnType<typeof f.store.accept>[] = [], patterns: ReturnType<typeof f.store.approveSeries>[] = [];
    // One commit for the setup: each accept still runs in full, but a hosted
    // Windows runner pays ~0.1 s of durable-commit flushing per transaction.
    f.db.transaction(() => { for (let i = 0; i < 501; i++) {
      const source = { ...f.source, threadId: (1000+i).toString(16), message: { ...f.source.message, id: (2000+i).toString(16) } };
      const row = f.store.accept({ expectedSourceDigest: previewBillSource(source).digest, sourceReviewed: true,
        facts: { ...facts, vendor: `Fictional vendor ${i}` }, reviewReason: 'Reviewed synthetic source.' }, source, 'private-local-reviewer');
      saved.push(row);
      if (i < 101) patterns.push(f.store.approveSeries({ occurrenceId: row.id, expectedOccurrenceRevision: row.revision,
        intervalMonths: 1, anchorDate: '2026-09-21', windowBeforeDays: 0, windowAfterDays: 0, timeZone: 'Australia/Brisbane', reviewReason: 'Reviewed fictional monthly arrival.' }, 'private-local-reviewer'));
    } });
    const snapshot = vi.spyOn(f.store,'snapshot').mockImplementation(() => { throw new Error('Unbounded snapshot is forbidden in production APIs.'); });
    vi.spyOn(f.store,'expectedRows').mockImplementation(() => { throw new Error('Unbounded projection is forbidden in production APIs.'); });
    const workspace = (await f.call('/api/bill-register?limit=20&from=2026-09-01&to=2026-12-31'))!.body as import('../shared/source-bills.ts').SourceBillsWorkspace;
    expect(workspace).toMatchObject({ version: 2, counts: { occurrences: 501, series: 101, activeSeries: 101 }, occurrences: { total: 501 }, series: { total: 101 } });
    expect(workspace.occurrences.items).toHaveLength(20); expect(workspace.series.items).toHaveLength(20); expect(workspace.calendar.items.length).toBeLessThanOrEqual(20);
    expect(expectedBillsPage(new URLSearchParams('limit=3'), () => [], () => f.store)).toMatchObject({ total: 501, counts: { source: 501, legacy: 0 }, bills: expect.any(Array), nextCursor: expect.any(String) });
    const lastMatch = expectedBillsPage(new URLSearchParams('query=Fictional+vendor+500'), () => [], () => f.store);
    expect(lastMatch.total).toBe(1); expect(lastMatch.bills.map(row => row.id)).toEqual([saved[500].id]);
    const old = saved.find(row => !workspace.occurrences.items.some(item => item.id === row.id))!;
    const oldPattern = patterns.find(row => !workspace.series.items.some(item => item.id === row.id))!;
    expect(await f.call(`/api/bill-occurrences/${old.id}`)).toMatchObject({ body: { occurrence: { id: old.id } } });
    expect(await f.call(`/api/bill-occurrences/by-source/${old.source.identity}`)).toMatchObject({ body: { occurrence: { id: old.id } } });
    expect(await f.call(`/api/bill-series/${oldPattern.id}`)).toMatchObject({ body: { series: { id: oldPattern.id }, occurrence: { id: oldPattern.occurrenceId } } });
    const match = new URLSearchParams({ accountId: oldPattern.accountId, propertyId: oldPattern.propertyId, kind: oldPattern.kind, vendor: oldPattern.vendor });
    expect(await f.call(`/api/bill-series/matching?${match}`)).toMatchObject({ body: { series: [{ id: oldPattern.id }] } });
    f.host.source.mockResolvedValueOnce(old.source);
    expect(await f.call(`/api/bill-occurrences/${old.id}`, 'PUT', { ...f.acceptance(), expectedSourceDigest: old.source.digest,
      facts: { ...old.facts, note: 'Corrected from historical lookup.' }, expectedRevision: old.revision, state: 'hold' })).toMatchObject({ body: { revision: 2, state: 'hold' } });
    expect(await f.call(`/api/bill-series/${oldPattern.id}`, 'PUT', { expectedRevision: oldPattern.revision, intervalMonths: 1,
      anchorDate: oldPattern.anchorDate, windowBeforeDays: 0, windowAfterDays: 0, timeZone: oldPattern.timeZone, active: false, reviewReason: 'Pause from historical lookup.' })).toMatchObject({ body: { revision: 2, active: false } });
    expect(snapshot).not.toHaveBeenCalled(); expect(f.host.collect).not.toHaveBeenCalled();
    // Saving these 602 records through FULL-sync SQLite took about 45 s on a Windows runner.
  }, process.platform === 'win32' ? 120_000 : 30_000);

  it('binds continuation pages to the property and calendar query and distinguishes a missing exact record', async () => {
    const f = fixture();
    for (let i=0;i<3;i++) {
      const source = { ...f.source, message: { ...f.source.message, id: (10+i).toString(16), body: `Fictional separate invoice ${i}.` } };
      f.store.accept({ expectedSourceDigest: previewBillSource(source).digest, sourceReviewed: true, facts, reviewReason: 'Synthetic review.' },source,'local');
    }
    const first = (await f.call('/api/bill-occurrences?limit=1&propertyId=private-property'))!.body as import('../shared/source-bills.ts').SourceBillPage<import('../shared/source-bills.ts').SourceBillOccurrence>;
    expect(first.total).toBe(3); expect(first.nextCursor).toBeTruthy();
    await expect(f.call(`/api/bill-occurrences?cursor=${first.nextCursor}&propertyId=other`)).rejects.toMatchObject({status:400});
    expect((await f.call(`/api/bill-occurrences?cursor=${first.nextCursor}&propertyId=private-property&limit=1`))!.body).toMatchObject({total:3,items:expect.any(Array)});
    const calendar = (await f.call('/api/bill-register/calendar?limit=1&from=2026-10-01&to=2026-10-31'))!.body as import('../shared/source-bills.ts').SourceBillCalendarPage;
    expect(calendar.nextCursor).toBeTruthy();
    await expect(f.call(`/api/bill-register/calendar?cursor=${calendar.nextCursor}&from=2026-10-01&to=2026-11-30`)).rejects.toMatchObject({status:400});
    await expect(f.call(`/api/bill-occurrences/source-bill:${'0'.repeat(64)}`)).rejects.toMatchObject({status:404});
    expect(await f.call(`/api/bill-occurrences/by-source/${'0'.repeat(64)}`)).toMatchObject({body:{occurrence:null,originSeries:null}});
    expect((await f.call('/api/bill-occurrences?propertyId=historical-deleted-property'))!.body).toMatchObject({items:[],total:0});
  });

  it('suppresses an arrival prediction after its reviewed source bill is linked, keeping the real invoice due date separate',async()=>{
    const f=fixture();await f.call('/api/bill-occurrences','POST',f.acceptance());
    const original=f.store.findBySourceIdentity(previewBillSource(f.source).identity)!;
    const pattern=(await f.call('/api/bill-series','POST',{occurrenceId:original.id,expectedOccurrenceRevision:1,
      intervalMonths:1,anchorDate:'2026-09-21',windowBeforeDays:0,windowAfterDays:0,timeZone:'Australia/Brisbane',reviewReason:'Reviewed monthly arrival.'}))!.body as import('../shared/source-bills.ts').BillRecurrenceSeries;
    const before=(await f.call('/api/bill-register/calendar?from=2026-10-21&to=2026-10-21&limit=1'))!.body as import('../shared/source-bills.ts').SourceBillCalendarPage;
    expect(before.items).toMatchObject([{seriesId:pattern.id,type:'expected-arrival',state:'predicted'}]);
    const source={...f.source,threadId:'abc123',message:{...f.source.message,id:'abd123',at:Date.parse('2026-10-21T01:00:00Z')}};
    f.host.source.mockResolvedValueOnce(source);
    const accepted=(await f.call('/api/bill-occurrences','POST',{...f.acceptance(),expectedSourceDigest:previewBillSource(source).digest,
      seriesId:pattern.id,expectedArrivalDate:'2026-10-21',facts:{...facts,dueDate:'2026-11-10'}}))!.body as import('../shared/source-bills.ts').SourceBillOccurrence;
    expect((await f.call('/api/bill-register/calendar?from=2026-10-21&to=2026-10-21&limit=1'))!.body).toMatchObject({items:[],nextCursor:null});
    expect((await f.call('/api/bill-register/calendar?from=2026-11-10&to=2026-11-10&limit=1'))!.body).toMatchObject({items:[{billId:accepted.id,type:'invoice-due',date:'2026-11-10'}]});
  });

  it('refuses a workspace assembled across different saved revisions',async()=>{
    const f=fixture();await f.call('/api/bill-occurrences','POST',f.acceptance());
    const original=f.store.findBySourceIdentity(previewBillSource(f.source).identity)!;
    const otherDb=new WorkflowDatabase({dir:f.dir,key:Buffer.alloc(32,9)}),other=new SourceBillRegister(otherDb,{dataDir:f.dir});
    const read=f.store.occurrencePage.bind(f.store);let changed=false;
    const page=vi.spyOn(f.store,'occurrencePage').mockImplementation(query=>{
      if(!changed){changed=true;other.correct(original.id,{expectedRevision:1,sourceReviewed:true,expectedSourceDigest:original.source.digest,
        facts:{...original.facts,note:'External edit'},state:'hold',reviewReason:'Reviewed on the other handle.'},original.source,'local');}
      return read(query);
    });
    try {
      await expect(f.call('/api/bill-register')).rejects.toMatchObject({status:409});
      page.mockRestore();
      expect(await f.call('/api/bill-register')).toMatchObject({body:{occurrences:{items:[{id:original.id,revision:2}]}}});
    } finally {otherDb.close();}
  });
});
