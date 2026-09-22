import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowDatabase } from './workflow-database.ts';
import { SourceBillRegister, previewBillSource } from './source-bills.ts';
import { createSourceBillsApi, type BillApiHost } from './source-bills-api.ts';
import { expectedBillsPage } from './expected-bills-page.ts';
import type { BillFacts, BillMailSource } from '../shared/source-bills.ts';

const resources: { dir: string; db: WorkflowDatabase }[] = [];
afterEach(() => { for (const { dir, db } of resources.splice(0)) { db.close(); rmSync(dir, { recursive: true, force: true }); } });
const itemId = 'a'.repeat(64), messageId = 'ab';
const now = Date.parse('2026-09-21T01:00:00Z');
const range = { from: '2026-09-01', to: '2026-12-31' };
const facts: BillFacts = { propertyId: 'private-property', kind: 'Water', vendor: 'Fictional utility', amountCents: 12345, currency: 'AUD', invoiceDate: '2026-09-20', dueDate: '2026-10-10', note: 'Synthetic review' };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rb-bill-api-test-')), db = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 9) });
  resources.push({ dir, db });
  const store = new SourceBillRegister(db, { dataDir: dir, now: () => now });
  const source: BillMailSource = { accountId: 'private-mail', receiptId: 'synthetic-receipt', threadId: 'abc', message: { id: messageId,
    at: now - 1000, from: 'billing@example.test', subject: 'Fictional water invoice', body: 'Please review this fictional invoice.', bodyTruncated: false, attachments: [] } };
  let recovering = false, propertyIds = ['private-property'];
  const host = {
    register: vi.fn(() => store),
    source: vi.fn(async (item: string, message: string) => {
      if (item !== itemId || message !== messageId) throw Object.assign(new Error('Saved message unavailable.'), { status: 404 });
      return structuredClone(source);
    }),
    savedThread: vi.fn(async (accountId: string, threadId: string) => ({ itemId, accountId, receiptId: source.receiptId,
      thread: { id: threadId, historyComplete: true, messages: [{ ...source.message, threadId, to: 'office@example.test', direction: 'incoming' as const, bodyTruncated: false }] } })),
    propertyIds: vi.fn(() => propertyIds), actorId: vi.fn(() => 'private-local-reviewer'), recovery: vi.fn(() => recovering),
    collect: vi.fn(async () => ({ latestScan: { status: 'complete' } })), now: () => now,
  } satisfies BillApiHost;
  const handle = createSourceBillsApi(host);
  const call = (path: string, method = 'GET', body?: unknown) => handle(new URL(path, 'http://127.0.0.1'), method, body);
  const acceptance = () => ({ itemId, messageId, expectedSourceDigest: previewBillSource(source).digest, sourceReviewed: true, facts: structuredClone(facts), reviewReason: 'Human reviewed the saved message.' });
  return { dir, db, store, host, source, call, acceptance, recovery: (value: boolean) => { recovering = value; }, properties: (value: string[]) => { propertyIds = value; } };
}

describe('private source-bill host API', () => {
  it('accepts only a host-resolved saved message and host actor, preserving evidence across rescan and restart', async () => {
    const f = fixture();
    const preview = await f.call(`/api/bill-evidence/${itemId}?messageId=${messageId}`);
    expect(preview).toEqual({ status: 200, body: previewBillSource(f.source) });
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
    const nextSource = { ...f.source, threadId: 'abd', message: { ...f.source.message, id: 'ac', at: Date.parse('2026-10-21T01:00:00Z') } };
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
    const f = fixture(), saved = [], patterns = [];
    for (let i = 0; i < 501; i++) {
      const source = { ...f.source, threadId: (1000+i).toString(16), message: { ...f.source.message, id: (2000+i).toString(16) } };
      const row = f.store.accept({ expectedSourceDigest: previewBillSource(source).digest, sourceReviewed: true,
        facts: { ...facts, vendor: `Fictional vendor ${i}` }, reviewReason: 'Reviewed synthetic source.' }, source, 'private-local-reviewer');
      saved.push(row);
      if (i < 101) patterns.push(f.store.approveSeries({ occurrenceId: row.id, expectedOccurrenceRevision: row.revision,
        intervalMonths: 1, anchorDate: '2026-09-21', windowBeforeDays: 0, windowAfterDays: 0, timeZone: 'Australia/Brisbane', reviewReason: 'Reviewed fictional monthly arrival.' }, 'private-local-reviewer'));
    }
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
  },30_000);

  it('binds continuation pages to the property and calendar query and distinguishes a missing exact record', async () => {
    const f = fixture();
    for (let i=0;i<3;i++) {
      const source = { ...f.source, message: { ...f.source.message, id: (10+i).toString(16) } };
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
