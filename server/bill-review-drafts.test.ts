import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { WorkflowDatabase } from './workflow-database.ts';
import { BillReviewDraftStore, BILL_REVIEW_DRAFT_KIND, billReviewDraftRecordId, validateSavedBillReviewDraft, validateBillReviewDraftProposalLink } from './bill-review-drafts.ts';
import { BILL_REVIEW_DRAFT_LIMITS, BILL_REVIEW_DRAFT_MAX_BYTES, type BillReviewDraftValue, type BillReviewDraft, type BillReviewDraftPageQuery } from '../shared/bill-review-drafts.ts';
import { proposalBackupFixture } from './testing/proposal-backup-fixture.ts';
import { encryptJson } from './desk-crypto.ts';

const key = Buffer.alloc(32, 41), resources: { directory: string; databases: WorkflowDatabase[] }[] = [], workers: Worker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map(worker => worker.terminate())); vi.restoreAllMocks();
  for (const resource of resources.splice(0)) { for (const database of resource.databases) database.close(); rmSync(resource.directory, { recursive: true, force: true }); }
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'RealBud bill draft ')), database = new WorkflowDatabase({ dir: directory, key });
  const resource = { directory, databases: [database] }; resources.push(resource);
  const workspaceId = randomUUID(); let time = 1000;
  const store = new BillReviewDraftStore(database, { workspaceId, now: () => time });
  return { directory, database, workspaceId, store, time: (next: number) => { time = next; },
    open: (options: { workspaceId?: string; key?: Buffer } = {}) => {
      const other = new WorkflowDatabase({ dir: directory, key: options.key ?? key }); resource.databases.push(other);
      return new BillReviewDraftStore(other, { workspaceId: options.workspaceId ?? workspaceId, now: () => time });
    } };
}
function input(workspaceId: string): BillReviewDraftValue {
  return { workspaceId, state: 'editing', billId: null, billRevision: null, itemId: null, messageId: null, sourceDigest: null,
    fields: { propertyId: '', kind: 'Water', vendor: '', amount: '1.', invoiceDate: '2026-0', dueDate: '', note: 'Fictional unsaved human work 保留' },
    billState: 'hold', reason: '', seriesId: '', arrivalDate: '', proposalRequest: null };
}
function requested(workspaceId: string): BillReviewDraftValue {
  const itemId = 'a'.repeat(64), messageId = 'ab12', sourceDigest = 'b'.repeat(64);
  return { ...input(workspaceId), itemId, messageId, sourceDigest,
    proposalRequest: { requestId: randomUUID(), itemId, messageId, expectedSourceDigest: sourceDigest } };
}
function value(draft: BillReviewDraft): BillReviewDraftValue {
  const { version: _version, id: _id, revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = draft;
  return input;
}
const bytes = (f: ReturnType<typeof fixture>) => readFileSync(join(f.directory, 'workflow-state.sqlite'));

type Operation = { method: 'create' | 'update'; args: unknown[] };
async function race(f: ReturnType<typeof fixture>, operations: Operation[]) {
  const barrier = new SharedArrayBuffer(4), state = new Int32Array(barrier);
  return Promise.all(operations.map(operation => new Promise<{ status: number; draft?: BillReviewDraft }>((resolve, reject) => {
    let result: { status: number; draft?: BillReviewDraft } | undefined;
    const worker = new Worker(`const {workerData,parentPort}=require('node:worker_threads');
      (async()=>{
        const {WorkflowDatabase}=await import(workerData.database);
        const {BillReviewDraftStore}=await import(workerData.domain);
        const database=new WorkflowDatabase({dir:workerData.directory,key:Buffer.alloc(32,41)});
        const store=new BillReviewDraftStore(database,{workspaceId:workerData.workspaceId,now:()=>1000});
        const state=new Int32Array(workerData.barrier);
        Atomics.add(state,0,1);parentPort.postMessage('ready');
        while(Atomics.load(state,0)<=workerData.parties){const current=Atomics.load(state,0);if(current>workerData.parties)break;Atomics.wait(state,0,current);}
        try{parentPort.postMessage({status:200,draft:store[workerData.operation.method](...workerData.operation.args)});}
        catch(error){parentPort.postMessage({status:error.status??500});}
        finally{database.close();}
      })();`, { eval: true, workerData: { directory: f.directory, workspaceId: f.workspaceId, barrier, parties: operations.length, operation,
        database: new URL('./workflow-database.ts', import.meta.url).href, domain: new URL('./bill-review-drafts.ts', import.meta.url).href },
      execArgv: ['--experimental-strip-types'], env: { PATH: dirname(process.execPath), HOME: f.directory, USERPROFILE: f.directory, REALBUD_DATA_DIR: f.directory } });
    workers.push(worker);
    worker.on('message', message => { if (message === 'ready') { if (Atomics.load(state, 0) === operations.length) { Atomics.add(state, 0, 1); Atomics.notify(state, 0); } } else result = message; });
    worker.on('error', reject); worker.on('exit', code => code || !result ? reject(new Error(`Fictional draft worker exited ${code}`)) : resolve(result));
  })));
}

describe('permanent encrypted bill review drafts', () => {
  it('reads a fresh workspace without creating a marker or draft', () => {
    const f = fixture(), before = bytes(f);
    expect(f.store.page()).toEqual({ version: 1, workspaceId: f.workspaceId, filter: 'active', items: [], total: 0, nextCursor: null });
    expect(() => f.store.get(randomUUID())).toThrow(expect.objectContaining({ status: 404 }));
    expect(f.database.hasRecords()).toBe(false); expect(bytes(f)).toEqual(before);
  });

  it('preserves incomplete raw typing, manual text and source hints across restart without granting approval', () => {
    const f = fixture(), id = randomUUID(), fields = requested(f.workspaceId), created = f.store.create(id, null, fields);
    expect(created).toEqual({ version: 1, id, revision: 1, createdAt: 1000, updatedAt: 1000, ...fields });
    expect(f.open().get(id)).toEqual(created); expect(bytes(f).includes(Buffer.from(fields.fields.note))).toBe(false);
    created.fields.note = 'Caller mutation must not change durable data';
    expect(f.store.get(id).fields.note).toBe(fields.fields.note);
    expect(() => f.open({ key: Buffer.alloc(32, 42) }).get(id)).toThrow(expect.objectContaining({ status: 503 }));
    expect(() => f.open({ workspaceId: randomUUID() }).get(id)).toThrow(expect.objectContaining({ status: 503 }));
    const before = bytes(f);
    expect(() => f.store.update(id, 1, { ...fields, sourceReviewed: true })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => f.store.update(id, 1, { ...fields, fields: { ...fields.fields, apiKey: 'fictional-rejected-field' } })).toThrow(expect.objectContaining({ status: 400 }));
    expect(bytes(f)).toEqual(before);
  });

  it('deduplicates exact creates without reverting a later saved revision', () => {
    const f = fixture(), id = randomUUID(), initial = input(f.workspaceId), first = f.store.create(id, null, initial);
    f.time(2000); expect(f.store.create(id, null, initial)).toEqual(first);
    const changed = { ...initial, state: 'saved' as const, fields: { ...initial.fields, vendor: 'Fictional supplier' } };
    const saved = f.store.update(id, 1, changed);
    expect(() => f.store.create(id, null, initial)).toThrow(expect.objectContaining({ status: 409 }));
    expect(f.store.create(id, null, changed)).toEqual(saved); expect(saved.revision).toBe(2); expect(saved.createdAt).toBe(1000);
    expect(f.database.count(BILL_REVIEW_DRAFT_KIND)).toBe(1);
  });

  it('uses cross-handle CAS, preserves a newer winner, and acknowledges identical uncertain retries', () => {
    const f = fixture(), other = f.open(), id = randomUUID(), first = f.store.create(id, null, input(f.workspaceId));
    const edited = { ...value(first), reason: 'Fictional operator checked the figure' }, winner = other.update(id, first.revision, edited);
    expect(() => f.store.update(id, first.revision, { ...edited, reason: 'A stale second-window edit' })).toThrow(expect.objectContaining({ status: 409 }));
    expect(f.store.update(id, first.revision, edited)).toEqual(winner); expect(f.store.get(id)).toEqual(winner);
    expect(() => f.store.update(id, winner.revision + 1, edited)).toThrow(expect.objectContaining({ status: 409 }));
  });

  it.each(['accepted', 'discarded'] as const)('retains %s draft bytes and the original request tuple; closed drafts cannot be reused', state => {
    const f = fixture(), id = randomUUID(), initial = requested(f.workspaceId), first = f.store.create(id, null, initial);
    const saved = f.store.update(id, first.revision, { ...initial, state });
    const before = bytes(f);
    expect(f.store.update(id, first.revision, { ...initial, state })).toEqual(saved);
    for (const next of [{ ...initial, state: 'editing' }, { ...initial, state, reason: 'Changed closed text' }, { ...initial, state, proposalRequest: null }])
      expect(() => f.store.update(id, saved.revision, next)).toThrow(expect.objectContaining({ status: 409 }));
    expect(bytes(f)).toEqual(before); expect(f.store.page().total).toBe(0); expect(f.store.page({ filter: 'all' }).items[0]).toMatchObject({ id, state, hasProposalRequest: true });
    expect(f.open().get(id)).toEqual(saved); expect(f.database.count(BILL_REVIEW_DRAFT_KIND)).toBe(1);
  });

  it('cannot clear or replace an admitted proposal identity, including a valid tuple for another source', () => {
    const f = fixture(), id = randomUUID(), initial = requested(f.workspaceId), first = f.store.create(id, null, initial);
    const another = requested(f.workspaceId); another.itemId = 'c'.repeat(64); another.proposalRequest!.itemId = another.itemId;
    for (const next of [{ ...initial, proposalRequest: null }, another, { ...initial, proposalRequest: { ...initial.proposalRequest!, requestId: randomUUID() } }])
      expect(() => f.store.update(id, first.revision, next)).toThrow(expect.objectContaining({ status: 409 }));
    expect(f.store.get(id)).toEqual(first);
    expect(f.store.create(randomUUID(), null, another).proposalRequest).toEqual(another.proposalRequest);
  });

  it('requires current workspace identity and internally consistent hints without requiring complete form fields', () => {
    const f = fixture(), id = randomUUID(), initial = requested(f.workspaceId), before = bytes(f);
    expect(() => f.store.create(id, null, { ...initial, workspaceId: randomUUID() })).toThrow(expect.objectContaining({ status: 409 }));
    for (const invalid of [{ ...initial, messageId: 'bb' }, { ...initial, sourceDigest: null }, { ...initial, billId: 'source-bill:' + 'a'.repeat(64) },
      { ...initial, billRevision: 2 }, { ...initial, state: 'approved' }, { ...initial, proposalRequest: { ...initial.proposalRequest!, confirmed: true } }])
      expect(() => f.store.create(id, null, invalid)).toThrow(expect.objectContaining({ status: 400 }));
    expect(f.database.hasRecords()).toBe(false); expect(bytes(f)).toEqual(before);
  });

  it.each([{ state: ['accepted'] }, { state: ['discarded'] }, { billState: ['hold'] }])('rejects coerced enum input %j without changing an existing draft', patch => {
    const f = fixture(), initial = input(f.workspaceId), saved = f.store.create(randomUUID(), null, initial), before = bytes(f);
    expect(() => f.store.create(randomUUID(), null, { ...initial, ...patch })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => f.store.update(saved.id, saved.revision, { ...initial, ...patch })).toThrow(expect.objectContaining({ status: 400 }));
    expect(f.store.get(saved.id)).toEqual(saved); expect(bytes(f)).toEqual(before);
  });

  it.each([{ state: ['accepted'] }, { state: ['discarded'] }, { billState: ['hold'] }])('preserves malformed persisted enums %j instead of reclassifying or reopening their history', patch => {
    const f = fixture(), initial = { ...input(f.workspaceId), state: 'discarded' as const }, oldest = f.store.create(randomUUID(), null, initial);
    for (let index = 0; index < 21; index++) f.store.create(randomUUID(), null, input(f.workspaceId));
    f.database.update(BILL_REVIEW_DRAFT_KIND, billReviewDraftRecordId(oldest.id), 1, row => ({ ...row as BillReviewDraft, revision: 2, ...patch }));
    const before = bytes(f);
    for (const run of [() => f.store.get(oldest.id), () => f.store.page(), () => f.store.page({ filter: 'all' }),
      () => f.store.update(oldest.id, 2, { ...initial, state: 'editing' })])
      expect(run).toThrow(expect.objectContaining({ status: 503 }));
    expect(bytes(f)).toEqual(before);
  });

  it('validates a present proposal intent while permitting the saved-before-dispatch boundary', async () => {
    const f = fixture(), fixtureProposal = await proposalBackupFixture(f.database, f.directory);
    const linked = { ...input(f.workspaceId), itemId: fixtureProposal.request.itemId, messageId: fixtureProposal.request.messageId,
      sourceDigest: fixtureProposal.request.expectedSourceDigest, proposalRequest: fixtureProposal.request };
    const saved = f.store.create(randomUUID(), null, linked);
    expect(() => validateBillReviewDraftProposalLink(saved, fixtureProposal.record)).not.toThrow();
    const mismatch = { ...linked, itemId: 'd'.repeat(64), proposalRequest: { ...fixtureProposal.request, itemId: 'd'.repeat(64) } };
    expect(() => f.store.create(randomUUID(), null, mismatch)).toThrow(expect.objectContaining({ status: 409 }));
    const unbound = f.store.create(randomUUID(), null, input(f.workspaceId));
    expect(() => f.store.update(unbound.id, unbound.revision, mismatch)).toThrow(expect.objectContaining({ status: 409 }));
    expect(f.store.get(unbound.id)).toEqual(unbound);
    expect(f.store.create(randomUUID(), null, requested(f.workspaceId)).proposalRequest).not.toBeNull();
  });

  it('fails closed if a subsequently present intent belongs to a different source', async () => {
    const f = fixture(), proposal = await proposalBackupFixture(f.database, f.directory);
    const request = { ...proposal.request, requestId: randomUUID() }, initial = { ...input(f.workspaceId), itemId: request.itemId, messageId: request.messageId, sourceDigest: request.expectedSourceDigest, proposalRequest: request };
    const draft = f.store.create(randomUUID(), null, initial);
    const mismatched = structuredClone(proposal.record.value) as { payloadDigest: string }; mismatched.payloadDigest = 'f'.repeat(64);
    f.database.create('bill-proposal', `bill-proposal:${request.requestId}`, mismatched, null);
    const before = bytes(f);
    for (const read of [() => f.store.get(draft.id), () => f.store.page(), () => f.store.update(draft.id, draft.revision, initial)])
      expect(read).toThrow(expect.objectContaining({ status: 503 }));
    expect(bytes(f)).toEqual(before);
  });

  it.each(['source digest', 'message identity'])('rejects inconsistent retained %s even if the intent payload hash matches the draft', async field => {
    const f = fixture(), proposal = await proposalBackupFixture(f.database, f.directory);
    const request = { ...proposal.request, requestId: randomUUID() };
    if (field === 'source digest') request.expectedSourceDigest = 'f'.repeat(64);
    else request.messageId = 'ff12';
    const initial = { ...input(f.workspaceId), itemId: request.itemId, messageId: request.messageId, sourceDigest: request.expectedSourceDigest, proposalRequest: request };
    const draft = f.store.create(randomUUID(), null, initial);
    const mismatched = structuredClone(proposal.record.value) as { payloadDigest: string };
    mismatched.payloadDigest = createHash('sha256').update(JSON.stringify([request.itemId, request.messageId, request.expectedSourceDigest])).digest('hex');
    const retained = f.database.create('bill-proposal', `bill-proposal:${request.requestId}`, mismatched, null), before = bytes(f);
    expect(() => validateBillReviewDraftProposalLink(initial, retained)).toThrow(expect.objectContaining({ status: 503 }));
    expect(() => f.store.create(randomUUID(), null, initial)).toThrow(expect.objectContaining({ status: 409 }));
    for (const read of [() => f.store.get(draft.id), () => f.store.page(), () => f.store.update(draft.id, draft.revision, initial)])
      expect(read).toThrow(expect.objectContaining({ status: 503 }));
    expect(bytes(f)).toEqual(before);
  });

  it('limits individual fields and encrypted size while retaining multilingual raw text exactly', () => {
    const f = fixture(), initial = input(f.workspaceId), id = randomUUID();
    for (const field of Object.keys(initial.fields) as (keyof typeof initial.fields)[]) initial.fields[field] = '漢'.repeat(BILL_REVIEW_DRAFT_LIMITS[field]);
    initial.reason = '漢'.repeat(BILL_REVIEW_DRAFT_LIMITS.reason); initial.seriesId = '漢'.repeat(BILL_REVIEW_DRAFT_LIMITS.seriesId); initial.arrivalDate = '漢'.repeat(BILL_REVIEW_DRAFT_LIMITS.arrivalDate);
    const saved = f.store.create(id, null, initial); expect(value(saved)).toEqual(initial);
    expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThanOrEqual(BILL_REVIEW_DRAFT_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(encryptJson(key, saved)))).toBeLessThanOrEqual(BILL_REVIEW_DRAFT_MAX_BYTES);
    const before = bytes(f);
    expect(() => f.store.update(id, saved.revision, { ...initial, fields: { ...initial.fields, note: 'x'.repeat(BILL_REVIEW_DRAFT_LIMITS.note + 1) } })).toThrow(expect.objectContaining({ status: 400 }));
    const large = { ...initial, reason: '\ud800'.repeat(BILL_REVIEW_DRAFT_LIMITS.reason), fields: { ...initial.fields, note: '\ud800'.repeat(BILL_REVIEW_DRAFT_LIMITS.note) } };
    expect(() => f.store.update(id, saved.revision, large)).toThrow(expect.objectContaining({ status: 413 }));
    expect(bytes(f)).toEqual(before); expect(f.store.get(id)).toEqual(saved);
  });

  it('retains over 1,000 encrypted drafts and returns bounded summaries across all pages', () => {
    const f = fixture(), ids: string[] = [];
    for (let index = 0; index < 1001; index++) {
      const id = randomUUID(), initial = input(f.workspaceId); initial.fields.vendor = `Fictional ${index}`;
      initial.state = index % 2 ? 'discarded' : 'saved'; ids.push(id); f.store.create(id, null, initial);
    }
    vi.spyOn(f.database, 'list').mockImplementation(() => { throw new Error('Draft history must not use the truncated list.'); });
    vi.spyOn(f.database, 'page').mockImplementation(() => { throw new Error('Draft history must project small summaries.'); });
    expect(f.store.page().total).toBe(501); expect(f.store.page().items).toHaveLength(20);
    const found: string[] = []; let cursor: string | undefined;
    do {
      const page = f.store.page({ filter: 'all', limit: 100, cursor }); expect(page.total).toBe(1001); expect(page.items.length).toBeLessThanOrEqual(100);
      for (const row of page.items) { expect(Object.hasOwn(row, 'fields')).toBe(false); expect(Object.hasOwn(row, 'proposalRequest')).toBe(false); found.push(row.id); }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(found).toEqual(ids.reverse()); expect(f.open().get(found.at(-1)!).fields.vendor).toBe('Fictional 0');
  }, 15_000);

  it('keeps insertion continuations stable while new drafts are excluded and existing closures stay current', () => {
    const f = fixture(), ids = Array.from({ length: 5 }, () => randomUUID());
    ids.forEach(id => f.store.create(id, null, input(f.workspaceId)));
    const first = f.store.page({ limit: 2 }), newest = f.store.create(randomUUID(), null, input(f.workspaceId));
    f.store.update(ids[1], 1, { ...input(f.workspaceId), state: 'discarded' });
    const continuation = f.store.page({ limit: 2, cursor: first.nextCursor! });
    expect(continuation.total).toBe(4); expect(continuation.items.map(row => row.id)).toEqual([ids[2], ids[0]]); expect(continuation.nextCursor).toBeNull();
    expect([...first.items, ...continuation.items].some(row => row.id === newest.id)).toBe(false); expect(f.store.page().total).toBe(5);
  });

  it('rejects malformed or cross-workspace cursors and invalid page options without writing data', () => {
    const f = fixture(); for (let index = 0; index < 3; index++) f.store.create(randomUUID(), null, input(f.workspaceId));
    const first = f.store.page({ limit: 1 }), cursor = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString());
    const before = bytes(f);
    const queries: unknown[] = [null, [], { limit: 0 }, { limit: 101 }, { limit: 1.2 }, { filter: 'accepted' }, { cursor: '' }, { cursor: first.nextCursor + '=' }, { extra: true }, { filter: 'all', cursor: first.nextCursor }];
    for (const patch of [{ kind: 'bank-history' }, { workspaceId: randomUUID() }, { high: 9999 }, { before: 0 }, { before: cursor.high + 1 }, { version: 2 }, { unknown: 1 }])
      queries.push({ cursor: Buffer.from(JSON.stringify({ ...cursor, ...patch })).toString('base64url') });
    for (const query of queries) expect(() => f.store.page(query as BillReviewDraftPageQuery)).toThrow(expect.objectContaining({ status: 400 }));
    expect(bytes(f)).toEqual(before);
  });

  it.each(['workspace', 'revision', 'identity', 'authority', 'proposal source'] as const)('preserves corrupted %s records and blocks reads and replacement', field => {
    const f = fixture(), saved = f.store.create(randomUUID(), null, requested(f.workspaceId));
    f.database.update<any>(BILL_REVIEW_DRAFT_KIND, billReviewDraftRecordId(saved.id), 1, row => {
      row.revision = 2;
      if (field === 'workspace') row.workspaceId = randomUUID();
      else if (field === 'revision') row.revision = 999;
      else if (field === 'identity') row.id = randomUUID();
      else if (field === 'authority') row.sourceReviewed = true;
      else row.messageId = 'ff';
      return row;
    });
    const before = bytes(f);
    for (const run of [() => f.store.get(saved.id), () => f.store.page(), () => f.store.create(saved.id, null, value(saved)), () => f.store.update(saved.id, 2, value(saved))])
      expect(run).toThrow(expect.objectContaining({ status: 503 }));
    expect(bytes(f)).toEqual(before);
  });

  it('validates closed off-page records and keeps damaged ciphertext untouched', () => {
    const f = fixture(), oldest = f.store.create(randomUUID(), null, { ...input(f.workspaceId), state: 'discarded' });
    for (let index = 0; index < 105; index++) f.store.create(randomUUID(), null, input(f.workspaceId));
    const raw = new DatabaseSync(join(f.directory, 'workflow-state.sqlite'));
    try { raw.prepare('UPDATE workflow_records SET payload=? WHERE id=?').run('{broken encrypted draft', billReviewDraftRecordId(oldest.id)); } finally { raw.close(); }
    const before = bytes(f);
    expect(() => f.store.page({ limit: 1 })).toThrow(expect.objectContaining({ status: 503 }));
    expect(() => f.store.page({ filter: 'all', limit: 1 })).toThrow(expect.objectContaining({ status: 503 }));
    expect(bytes(f)).toEqual(before);
  });

  it('handles actual simultaneous create, conflicting create and revision-bound edits using independent databases', async () => {
    const f = fixture(), id = randomUUID(), initial = input(f.workspaceId);
    const duplicates = await race(f, [{ method: 'create', args: [id, null, initial] }, { method: 'create', args: [id, null, initial] }]);
    expect(duplicates.map(row => row.status)).toEqual([200, 200]); expect(duplicates[0].draft).toEqual(duplicates[1].draft);
    const next = randomUUID(), contested = await race(f, [{ method: 'create', args: [next, null, initial] }, { method: 'create', args: [next, null, { ...initial, reason: 'Different writer' }] }]);
    expect(contested.map(row => row.status).sort()).toEqual([200, 409]);
    const edits = await race(f, [{ method: 'update', args: [id, 1, { ...initial, reason: 'Writer A' }] }, { method: 'update', args: [id, 1, { ...initial, reason: 'Writer B' }] }]);
    expect(edits.map(row => row.status).sort()).toEqual([200, 409]); expect(f.store.get(id)).toEqual(edits.find(row => row.status === 200)!.draft);
    expect(f.store.page({ filter: 'all' }).total).toBe(2);
  }, 15_000);

  it('keeps logical revisions and timestamps monotonic and exposes a side-effect-free backup validator', () => {
    const f = fixture(), initial = input(f.workspaceId), first = f.store.create(randomUUID(), null, initial);
    f.time(100); const saved = f.store.update(first.id, first.revision, { ...initial, state: 'saved' });
    expect(saved).toMatchObject({ revision: 2, createdAt: 1000, updatedAt: 1000 });
    expect(validateSavedBillReviewDraft(billReviewDraftRecordId(saved.id), 2, saved, f.workspaceId)).toEqual(saved);
    for (const [id, revision, row, workspaceId] of [[billReviewDraftRecordId(saved.id), 1, saved, f.workspaceId], [billReviewDraftRecordId(randomUUID()), 2, saved, f.workspaceId],
      [billReviewDraftRecordId(saved.id), 2, { ...saved, version: 2 }, f.workspaceId], [billReviewDraftRecordId(saved.id), 2, saved, randomUUID()]] as const)
      expect(() => validateSavedBillReviewDraft(id, revision, row, workspaceId)).toThrow(expect.objectContaining({ status: 503 }));
  });
});
