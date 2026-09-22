import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { WorkflowDatabase } from './workflow-database.ts';
import { SourceBillRegister, previewBillSource, validateSourceBillRegister } from './source-bills.ts';
import { SOURCE_BILL_RECORD_KINDS, validateSourceBillRecord, validateSourceBillRecords, type SourceBillRecord, aliasId, arrivalId } from './source-bill-graph.ts';
import type { BillMailSource, BillFacts, SourceBillOccurrence, BillRecurrenceSeries } from '../shared/source-bills.ts';

const fixtures: { dir: string; databases: WorkflowDatabase[] }[] = [];
const workers: Worker[] = [];
afterEach(async () => { await Promise.all(workers.splice(0).map(worker => worker.terminate())); vi.restoreAllMocks(); for (const f of fixtures.splice(0)) { for (const db of f.databases) db.close(); rmSync(f.dir, { recursive: true, force: true }); } });
const key = Buffer.alloc(32, 17);
const range = { from: '2026-01-01', to: '2026-06-30' };
const source = (n = 0): BillMailSource => ({ accountId: 'fixture-account', receiptId: `receipt-${n}`, threadId: `thread-${n}`, message: { id: `message-${n}`, at: Date.parse('2026-01-31T01:00:00Z'), from: 'fake@example.invalid', subject: 'Fictional invoice', body: `Fictional retained source ${n}`, attachments: [] } });
const facts = (n = 0): BillFacts => ({ propertyId: `property-${n}`, kind: 'Water', vendor: 'Fictional water', amountCents: 100, currency: 'AUD', invoiceDate: '2026-01-31', dueDate: '2026-02-20', note: 'Fixture review' });
const review = (mail = source(), n = 0) => ({ expectedSourceDigest: previewBillSource(mail).digest, sourceReviewed: true, facts: facts(n), reviewReason: 'Checked fictional source' });
const pattern = { intervalMonths: 1, anchorDate: '2026-01-31', windowBeforeDays: 0, windowAfterDays: 0, timeZone: 'UTC', reviewReason: 'Observed fictional arrival' };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'source-bill-retention-')), db = new WorkflowDatabase({ dir, key });
  const resource = { dir, databases: [db] }; fixtures.push(resource);
  const open = () => { const second = new WorkflowDatabase({ dir, key }); resource.databases.push(second); return { db: second, store: new SourceBillRegister(second, { dataDir: dir }) }; };
  return { dir, db, open, store: new SourceBillRegister(db, { dataDir: dir }) };
}
function records(db: WorkflowDatabase): SourceBillRecord[] {
  const result: SourceBillRecord[] = [];
  for (const kind of SOURCE_BILL_RECORD_KINDS) {
    let before: number | undefined;
    do { const page = db.page(kind, { before, limit: 200 }); result.push(...page.records.map(row => ({ kind, ...row }))); before = page.next ?? undefined; } while (before);
  }
  return result;
}
function approve(store: SourceBillRegister, row: SourceBillOccurrence) { return store.approveSeries({ ...pattern, occurrenceId: row.id, expectedOccurrenceRevision: row.revision }, 'fixture-reviewer'); }
function allPages<T>(page: (cursor?: string) => { items: T[]; nextCursor: string | null }): T[] {
  let cursor: string | undefined; const items: T[] = [];
  do { const result = page(cursor); items.push(...result.items); cursor = result.nextCursor ?? undefined; } while (cursor);
  return items;
}

/** Real independent SQLite handles start after one shared barrier. Only synthetic
 * data and local modules are used; this never invokes a model or mail provider. */
async function race(dir: string, operations: { method: string; args: unknown[] }[]) {
  const barrier = new SharedArrayBuffer(4), state = new Int32Array(barrier);
  const results = operations.map(operation => new Promise<{ status: number; value?: { id: string; revision: number } }>((resolve, reject) => {
    let outcome: { status: number; value?: { id: string; revision: number } } | undefined;
    const worker = new Worker(`const { workerData, parentPort } = require('node:worker_threads'); (async () => {
      const { WorkflowDatabase } = await import(workerData.database);
      const { SourceBillRegister } = await import(workerData.domain);
      const db = new WorkflowDatabase({ dir: workerData.dir, key: Buffer.alloc(32,17) });
      const store = new SourceBillRegister(db, { dataDir: workerData.dir });
      const barrier = new Int32Array(workerData.barrier); Atomics.add(barrier,0,1); parentPort.postMessage('ready'); while(Atomics.load(barrier,0)<=workerData.parties) { const observed=Atomics.load(barrier,0); if(observed>workerData.parties) break; Atomics.wait(barrier,0,observed); }
      try { const value = store[workerData.operation.method](...workerData.operation.args); parentPort.postMessage({ status:200, value:{ id:value.id, revision:value.revision } }); }
      catch(error) { parentPort.postMessage({ status:error.status ?? 500 }); }
      finally { db.close(); }
    })().catch(error => { throw error; });`, { eval: true, workerData: { dir, barrier, operation, parties: operations.length, database: new URL('./workflow-database.ts', import.meta.url).href, domain: new URL('./source-bills.ts', import.meta.url).href }, execArgv: ['--experimental-strip-types'], env: { ...process.env, REALBUD_DATA_DIR: dir, DATA_DIR: dir, REALBUD_DESK_KEY: key.toString('hex') } });
    workers.push(worker);
    worker.on('message', value => { if (value === 'ready') { if (Atomics.load(state, 0) === operations.length) { Atomics.add(state, 0, 1); Atomics.notify(state, 0); } } else outcome = value; });
    worker.on('error', reject);
    worker.on('exit', code => { if (code || !outcome) reject(new Error(`Fixture worker exited ${code}`)); else resolve(outcome); });
  }));
  return Promise.all(results);
}

describe('permanent source-bill heads', () => {
  it('retains the 501st bill and 101st pattern with truthful complete compatibility and stable pages', () => {
    const { store, db, dir } = fixture(); const accepted: SourceBillOccurrence[] = [];
    for (let n = 0; n < 501; n++) { const row = store.accept(review(source(n), n), source(n), 'reviewer'); accepted.push(row); if (n < 101) approve(store, row); }
    expect(store.counts()).toMatchObject({ occurrences: 501, series: 101, activeSeries: 101 });
    expect(store.snapshot(range).occurrences).toHaveLength(501); expect(store.expectedRows()).toHaveLength(501);
    expect(allPages(cursor => store.occurrencePage({ cursor, limit: 17 }))).toHaveLength(501);
    expect(allPages(cursor => store.seriesPage({ cursor, limit: 9 }))).toHaveLength(101);
    expect(store.getOccurrence(accepted[0]!.id)).toEqual(accepted[0]);
    expect(store.getSeriesForOccurrence(accepted[0]!.id)?.occurrenceId).toBe(accepted[0]!.id);
    expect(store.matchingSeries({ accountId: source().accountId, ...facts() })).toHaveLength(1);
    validateSourceBillRecords(records(db));
    expect(readFileSync(join(dir, 'workflow-state.sqlite')).includes(Buffer.from('Fictional retained source'))).toBe(false);
  });
  it('keeps corrected and cancelled historical aliases after reopen without another acceptance', () => {
    const f = fixture(), original = f.store.accept(review(), source(), 'reviewer');
    const next = source(99), changed = f.store.correct(original.id, { ...review(next), expectedRevision: 1, state: 'hold' }, next, 'reviewer');
    const cancelled = f.store.correct(original.id, { ...review(next), expectedRevision: 2, state: 'cancelled' }, next, 'reviewer');
    const reopened = f.open().store;
    expect(reopened.findBySourceIdentity(original.source.identity)).toEqual(cancelled);
    expect(reopened.findBySourceIdentity(changed.source.identity)).toEqual(cancelled);
    expect(() => reopened.accept(review(), source(), 'reviewer')).toThrow(/correction/);
    expect(reopened.accept(review(next), next, 'reviewer').id).toBe(original.id);
    expect(reopened.counts().occurrences).toBe(1);
    validateSourceBillRecords(records(f.db));
  });
  it('maintains the per-entity 50-review limit without eviction', () => {
    const { store } = fixture(); let row = store.accept(review(), source(), 'reviewer');
    for (let i = 0; i < 50; i++) row = store.correct(row.id, { ...review(), expectedRevision: row.revision, state: 'hold', reviewReason: `Fictional correction ${i}` }, source(), 'reviewer');
    expect(row.history).toHaveLength(50);
    expect(() => store.correct(row.id, { ...review(), expectedRevision: row.revision, state: 'hold' }, source(), 'reviewer')).toThrow(/history limit/);
    expect(store.getOccurrence(row.id)).toEqual(row);
  });
  it('retains the 8 MB encrypted entity ceiling and the last saved history on an oversized correction', () => {
    const { store, db } = fixture();
    const large = source(); large.message.body = '漢'.repeat(12000);
    large.message.attachments = Array.from({ length: 100 }, (_, n) => ({ id: `${n}${'漢'.repeat(500)}`, name: '漢'.repeat(255), mimeType: '漢'.repeat(120), size: 1 }));
    const input = { ...review(large), limitedSourceAcknowledged: true };
    let row = store.accept(input, large, 'reviewer'), stopped = false;
    for (let n = 0; n < 50; n++) {
      try { row = store.correct(row.id, { ...input, expectedRevision: row.revision, state: 'hold' }, large, 'reviewer'); }
      catch (error) { expect(error).toMatchObject({ status: 413 }); stopped = true; break; }
    }
    expect(stopped).toBe(true); expect(row.history.length).toBeLessThan(50); expect(store.getOccurrence(row.id)).toEqual(row);
    validateSourceBillRecords(records(db));
  });
  it('rolls back head/alias/reservation writes when the durable head write fails', () => {
    const { store, db } = fixture(); const row = store.accept(review(), source(), 'reviewer'), before = records(db);
    const save = db.update.bind(db);
    vi.spyOn(db, 'update').mockImplementation((kind, id, revision, operation) => { if (kind === 'bill-occurrence') throw Object.assign(new Error('Synthetic disk failure'), { status: 503 }); return save(kind, id, revision, operation); });
    const newer = source(8);
    expect(() => store.correct(row.id, { ...review(newer), expectedRevision: 1, state: 'hold' }, newer, 'reviewer')).toThrow(/disk failure/);
    expect(records(db)).toEqual(before); expect(store.findBySourceIdentity(previewBillSource(newer).identity)).toBeUndefined();
  });
});

describe('strict atomic v1 migration', () => {
  function legacy() { const f = fixture(), row = f.store.accept(review(), source(), 'reviewer'); approve(f.store, row); const snapshot = f.store.snapshot(range); return { version: 1 as const, occurrences: snapshot.occurrences, series: snapshot.series }; }
  it('replaces the exact old aggregate with a bound marker and retains all evidence', () => {
    const value = legacy(), target = fixture(); const old = target.db.create('bill-register', 'source-bills', value);
    expect(target.store.snapshot(range).occurrences).toEqual(value.occurrences);
    const marker = target.db.get<{ version: number; migration: { sourceRevision: number } }>('bill-register', 'source-bills')!;
    expect(marker.value.version).toBe(2); expect(marker.value.migration.sourceRevision).toBe(old.revision);
    expect(() => validateSourceBillRegister(marker.value)).toThrow(/recovery/);
    validateSourceBillRecords(records(target.db)); expect(target.open().store.snapshot(range).series).toEqual(value.series);
  });
  it('does not create a marker when reading a genuinely empty workspace', () => { const { db, store } = fixture(); expect(store.counts().revision).toBe(0); expect(db.hasRecords()).toBe(false); });
  it('rolls back an interrupted migration and can retry with the exact original aggregate', () => {
    const value = legacy(), { db, store } = fixture(); const original = db.create('bill-register', 'source-bills', value), create = db.create.bind(db);
    vi.spyOn(db, 'create').mockImplementation((kind, id, input, limit) => { if (kind === 'bill-origin') throw Object.assign(new Error('Synthetic migration failure'), { status: 503 }); return create(kind, id, input, limit); });
    expect(() => store.counts()).toThrow(/migration failure/);
    expect(records(db)).toEqual([{ kind: 'bill-register', ...original }]);
    vi.restoreAllMocks(); expect(store.counts()).toMatchObject({ occurrences: 1, series: 1 });
  });
  it('holds mixed, orphaned and invalid legacy graphs without rewriting them', () => {
    const value = legacy(), { db, store } = fixture(); db.create('bill-register', 'source-bills', value);
    db.create('bill-occurrence', value.occurrences[0]!.id, value.occurrences[0]); const before = records(db);
    expect(() => store.counts()).toThrow(/recovery/); expect(records(db)).toEqual(before);
    const orphan = fixture(); orphan.db.create('bill-occurrence', value.occurrences[0]!.id, value.occurrences[0]);
    expect(() => orphan.store.counts()).toThrow(/recovery/);
    const invalid = fixture(); invalid.db.create('bill-register', 'source-bills', { ...value, unexpected: true });
    expect(() => invalid.store.counts()).toThrow(/recovery/);
  });
});

describe('cross-handle authority and corruption', () => {
  it('revalidates after same-handle mutation, rollback and external committed corruption', () => {
    const f = fixture(); const row = f.store.accept(review(), source(), 'reviewer'), other = f.open(); expect(other.store.counts().occurrences).toBe(1);
    const token = f.db.changeToken();
    expect(() => f.db.transaction(() => { f.db.create('fixture', 'rolled-back', { safe: true }); throw new Error('abort'); })).toThrow();
    expect(f.db.changeToken()).not.toBe(token); expect(f.store.counts().occurrences).toBe(1);
    const external = new DatabaseSync(join(f.dir, 'workflow-state.sqlite')); external.prepare('DELETE FROM workflow_records WHERE id=?').run(aliasId(row.source.identity)); external.close();
    const before = readFileSync(join(f.dir, 'workflow-state.sqlite'));
    expect(() => f.store.getOccurrence(row.id)).toThrow(/recovery/); expect(() => other.store.counts()).toThrow(/recovery/);
    expect(readFileSync(join(f.dir, 'workflow-state.sqlite'))).toEqual(before);
  });
  it('serializes real simultaneous acceptance and stale corrections across separate SQLite handles', async () => {
    const f = fixture();
    const accepted = await race(f.dir, [0, 1].map(() => ({ method: 'accept', args: [review(), source(), 'reviewer'] })));
    expect(accepted.map(r => r.status)).toEqual([200, 200]); expect(new Set(accepted.map(r => r.value?.id)).size).toBe(1);
    const row = f.store.findBySourceIdentity(previewBillSource(source()).identity)!;
    const corrections = await race(f.dir, ['hold', 'in-process'].map(state => ({ method: 'correct', args: [row.id, { ...review(), expectedRevision: 1, state }, source(), 'reviewer'] })));
    expect(corrections.map(r => r.status).sort()).toEqual([200, 409]); expect(f.store.getOccurrence(row.id)?.history).toHaveLength(1);
  }, 15_000);
  it('serializes active pattern and arrival reservations across separate handles', async () => {
    const f = fixture(), a = f.store.accept(review(), source(), 'reviewer'), b = f.store.accept(review(source(1)), source(1), 'reviewer');
    const results = await race(f.dir, [a, b].map(row => ({ method: 'approveSeries', args: [{ ...pattern, occurrenceId: row.id, expectedOccurrenceRevision: 1 }, 'reviewer'] })));
    expect(results.map(r => r.status).sort()).toEqual([200, 409]); const series = f.store.seriesPage().items[0]!;
    const requests = [2, 3].map(n => { const mail = source(n); return { method: 'accept', args: [{ ...review(mail), seriesId: series.id, expectedArrivalDate: '2026-02-28' }, mail, 'reviewer'] }; });
    expect((await race(f.dir, requests)).map(r => r.status).sort()).toEqual([200, 409]);
    validateSourceBillRecords(records(f.db));
  }, 15_000);
});

describe('complete graph and bounded pages', () => {
  it('rejects missing/forged aliases, origin binding, active-window changes and occupied-slot lies', () => {
    const f = fixture(), bill = f.store.accept(review(), source(), 'reviewer'), series = approve(f.store, bill), valid = records(f.db);
    validateSourceBillRecords(valid);
    for (const kind of SOURCE_BILL_RECORD_KINDS) expect(() => validateSourceBillRecords(valid.filter(r => r.kind !== kind))).toThrow(/recovery/);
    const wrong = structuredClone(valid); (wrong.find(r => r.kind === 'bill-series')!.value as BillRecurrenceSeries).sourceOccurrenceRevision = 99;
    expect(() => validateSourceBillRecords(wrong)).toThrow(/recovery/);
    const window = structuredClone(valid); (window.find(r => r.kind === 'bill-series')!.value as BillRecurrenceSeries).timeZone = 'America/Los_Angeles';
    expect(() => validateSourceBillRecords(window)).toThrow(/recovery/);
    expect(() => validateSourceBillRecord('bill-arrival-slot', arrivalId(series.id, '2026-02-30'), 1, { version: 1, seriesId: series.id, date: '2026-02-30', occurrenceId: null })).toThrow(/recovery/);
  });
  it('does not shift an insertion snapshot, and retains direct access beyond the first page', () => {
    const { store } = fixture(); for (let n = 0; n < 6; n++) store.accept(review(source(n), n), source(n), 'reviewer');
    const first = store.occurrencePage({ limit: 2 }); store.accept(review(source(9), 9), source(9), 'reviewer');
    const next = store.occurrencePage({ cursor: first.nextCursor!, limit: 2 });
    expect(next.total).toBe(6); expect(next.snapshotCursor).toBe(first.snapshotCursor); expect(store.occurrencePage({ cursor: first.snapshotCursor, limit: 2 }).items).toEqual(first.items);
    const remainder = allPages(cursor => store.occurrencePage({ cursor: cursor ?? first.nextCursor!, limit: 2 }));
    expect(new Set([...first.items, ...remainder].map(r => r.id)).size).toBe(6);
    expect(store.findBySourceIdentity(previewBillSource(source()).identity)?.source.message.id).toBe('message-0');
    expect(() => store.occurrencePage({ cursor: first.nextCursor!, propertyId: 'other' })).toThrow(/page/);
    expect(() => store.seriesPage({ cursor: first.nextCursor! })).toThrow(/page/);
    expect(() => store.occurrencePage({ limit: 201 })).toThrow(/page size/);
  });
  it('keeps filtered snapshot totals exact and rejects calendar offsets after occupancy or cadence changes', () => {
    const { store } = fixture(); const original = store.accept(review(), source(), 'reviewer'), series = approve(store, original);
    const filtered = store.occurrencePage({ propertyId: 'property-0', limit: 1 });
    const first = store.calendarPage({ from: '2026-02-21', to: '2026-06-30', limit: 1 });
    expect(first.items[0]?.id).toBe(`arrival:${series.id}:2026-02-28`);
    const arrived = source(2); store.accept({ ...review(arrived), seriesId: series.id, expectedArrivalDate: '2026-02-28' }, arrived, 'reviewer');
    expect(store.occurrencePage({ propertyId: 'property-0', cursor: filtered.snapshotCursor }).total).toBe(1);
    expect(() => store.calendarPage({ from: '2026-02-21', to: '2026-06-30', limit: 1, cursor: first.nextCursor! })).toThrow(/Refresh the calendar/);
    const current = allPages(cursor => store.calendarPage({ from: '2026-02-21', to: '2026-06-30', limit: 1, cursor }));
    expect(current.map(r => r.id)).toContain(`arrival:${series.id}:2026-03-31`);
    expect(current.map(r => r.id)).not.toContain(`arrival:${series.id}:2026-02-28`);
    const beforePause = store.calendarPage({ ...range, limit: 1 });
    store.reviseSeries(series.id, { ...pattern, expectedRevision: series.revision, active: false }, 'reviewer');
    expect(() => store.calendarPage({ ...range, limit: 1, cursor: beforePause.nextCursor! })).toThrow(/Refresh the calendar/);
  });
  it('continues empty property pages and suppresses an arrival received outside the calendar scan page', () => {
    const { store } = fixture(); const original = store.accept(review(), source(), 'reviewer'), series = approve(store, original);
    const arrived = source(1); store.accept({ ...review(arrived), seriesId: series.id, expectedArrivalDate: '2026-02-28' }, arrived, 'reviewer');
    for (let n = 2; n < 205; n++) store.accept(review(source(n), n), source(n), 'reviewer');
    const first = store.occurrencePage({ propertyId: 'property-0', limit: 2 }); expect(first.items).toEqual([]); expect(first.nextCursor).not.toBeNull();
    expect(allPages(cursor => store.occurrencePage({ cursor, propertyId: 'property-0', limit: 2 }))).toHaveLength(2);
    const calendar = allPages(cursor => store.calendarPage({ ...range, cursor, propertyId: 'property-0', limit: 1 }));
    expect(calendar.filter(r => r.id === `arrival:${series.id}:2026-02-28`)).toEqual([]);
    expect(calendar.filter(r => r.type === 'expected-arrival')).toHaveLength(4);
    expect(new Set(calendar.map(r => r.id)).size).toBe(calendar.length);
    const page = store.calendarPage({ ...range, limit: 1 }); expect(page.nextCursor).not.toBeNull();
    expect(() => store.calendarPage({ ...range, from: '2026-02-01', cursor: page.nextCursor! })).toThrow(/page/);
  });
});
