import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { createMailIngestionService as createNormalizedMailService, MAIL_HISTORY_WINDOW_DAYS, MORNING_MAIL_RECIPE, type MailAuthority } from './mail-ingestion.ts';
import { defaultAgencySettings } from './agency-setup.ts';
import { mailHistoryWindows, officeDayOrdinal, officeDayStart, parseMailHistoryCheckpoint, planMailHistory, type MailScanRequest } from '../shared/mail-ingestion.ts';
import type { MailScanResult, MailThread } from '../shared/mail-ingestion.ts';
import type { InboxReview } from '../shared/accounts-review.ts';
import type { JobRun } from '../shared/contracts.ts';

import { WorkflowDatabase } from './workflow-database.ts';
import { DatabaseSync } from 'node:sqlite';
import { mailRecordId } from './mail-records.ts';
import { removeFixture } from './testing/private-fixture.ts';
const services: ReturnType<typeof createNormalizedMailService>[] = [];
const databases: WorkflowDatabase[] = [];
// Existing behavioral scenarios deliberately use the explicit compatibility
// reader. HTTP and clock consumers use bounded metadata/page seams instead.
function createMailIngestionService(options: Parameters<typeof createNormalizedMailService>[0]) {
  const service = createNormalizedMailService(options); services.push(service);
  return { prepareInput: service.prepareInput, source: service.source, cancel: service.cancel, get: service.getLegacySnapshot,
    collect: async (...args: Parameters<typeof service.collect>) => { await service.collect(...args); return service.getLegacySnapshot(); },
    update: async (...args: Parameters<typeof service.update>) => { await service.update(...args); return service.getLegacySnapshot(); },
    applyReview: async (...args: Parameters<typeof service.applyReview>) => { await service.applyReview(...args); return service.getLegacySnapshot(); },
  };
}
vi.mock('./recipes.ts', () => ({ getRecipe: (id: string) => ({ id, capabilities: ['read-files'] }) }));
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const s of services.splice(0)) await s.close(); for(const db of databases.splice(0)) db.close(); for (const root of roots.splice(0)) await removeFixture(root); });
const initialTime = Date.parse('2026-09-21T00:00:00Z');
function thread(id = 'abc', messageId = 'aa'): MailThread {
  return { id, historyComplete: true, messages: [{ id: messageId, threadId: id, at: initialTime - 1000, direction: 'incoming',
    from: 'tenant@example.test', to: 'accounts@example.test', subject: 'Fictional repair', body: 'Please review the fictional repair.', bodyTruncated: false, attachments: [] }] };
}
async function fixture() {
  const root = await mkdtemp(join(realpathSync(tmpdir()), 'rb-mail-test-')); roots.push(root);
  let time = initialTime;
  const authority: MailAuthority = { accountId: 'mail-a', bindingRevision: 'a'.repeat(64), settingsRevision: 1,
    settings: { ...defaultAgencySettings(), workflowPackId: 'austin-office', agencyName: 'Fictional agency', timeZone: 'Australia/Brisbane', gmailAccountId: 'mail-a', selectedWorkflows: ['morning-priorities'],
      mailScope: { historyDays: 7, includeSent: true, maxMessages: 500, attachments: 'metadata-only' } } };
  const data: Pick<MailScanResult, 'threads' | 'pages' | 'paginationComplete' | 'gaps'> = { threads: [thread()], pages: 1, paginationComplete: true, gaps: [] };
  const authorize = vi.fn(async () => structuredClone(authority));
  const scan = vi.fn(async (current: MailAuthority, request: Parameters<Parameters<typeof createMailIngestionService>[0]['scan']>[1], _signal: AbortSignal): Promise<MailScanResult> =>
    ({ ...structuredClone(data), accountId: current.accountId, windowStartAt: request.windowStartAt, windowEndAt: request.windowEndAt }));
  const database = new WorkflowDatabase({dir:root,key:Buffer.alloc(32,7)}); databases.push(database);
  const options = { database, directory: root, workspaceId: 'private-workspace-a', workroomDirectory: join(root, 'workroom'), key: Buffer.alloc(32, 7), authorize, scan, now: () => time };
  const service = createMailIngestionService(options);
  const vault = { async read(name: string): Promise<any> {
    if(name==='mail-workspace') { const state=await service.get(); return {...state,workspaceId:options.workspaceId,receipts: database.page<any>('mail-receipt',{limit:200}).records.map(r=>r.value)}; }
    return database.get<any>(name==='mail-prepared-input'?'mail-prepared':'mail-source',mailRecordId(name==='mail-prepared-input'?'mail-prepared':'mail-source',name==='mail-prepared-input'?'workspace':name.slice(10)))?.value;
  }, async write(name:string,value:any) {
    if(name==='mail-workspace') {for(const r of value.receipts){const id=mailRecordId('mail-receipt',r.id),old=database.get('mail-receipt',id)!;database.update('mail-receipt',id,old.revision,()=>r);} const id=mailRecordId('mail-register'),reg=database.get<any>('mail-register',id)!;database.update('mail-register',id,reg.revision,()=>({...reg.value,latestScanId:value.latestScan?.id??null,activeScan:null}));return;}
    const kind=name==='mail-prepared-input'?'mail-prepared':'mail-source',id=mailRecordId(kind,name==='mail-prepared-input'?'workspace':name.slice(10)),old=database.get(kind,id)!;database.update(kind,id,old.revision,()=>value);
  }};
  return { root, options, service, vault, authority, authorize, scan, data, advance: (ms = 1000) => { time += ms; },
    workspaceFile: join(root, 'workflow-state.sqlite') };
}
async function reviewRun(f: Awaited<ReturnType<typeof fixture>>, patch: Partial<InboxReview> = {}): Promise<JobRun> {
  const receipt = await f.service.prepareInput();
  if (!receipt) throw new Error('Expected pending synthetic review work');
  const input = JSON.parse(await readFile(join(f.options.workroomDirectory, 'workflow-inputs', 'accounts-inbox.json'), 'utf8')) as { sourceReference: string; threads: { threadId: string; messages: { messageId: string }[] }[] };
  const review: InboxReview = { version: 1, kind: 'accounts-inbox-triage', skillSource: 'email-inbox-triage@0.1.0', sourceReference: input.sourceReference,
    status: 'complete', coverageComplete: true, actionsPerformed: [], holds: [], threads: input.threads.map(t => ({ threadId: t.threadId, disposition: 'reply-review', owner: 'accounts-reviewer', priority: 'normal',
      sourceMessageIds: t.messages.map(m => m.messageId), reason: 'Source needs a human reply review.', nextAction: 'Review the source before replying.', missingFacts: [] })), ...patch };
  return { id: randomUUID(), jobId: MORNING_MAIL_RECIPE, status: 'awaiting-approval', evidence: [{ kind: 'output', note: JSON.stringify(review) }] } as unknown as JobRun;
}

describe('durable private mail acquisition and work list', () => {
  it('uses the explicitly selected collection purpose without falling back to morning authority', async () => {
    const f = await fixture();
    await f.service.collect('bills-calendar');
    expect(f.authorize.mock.calls).toEqual([['bills-calendar'],['bills-calendar']]);
    f.authorize.mockClear();
    f.authorize.mockRejectedValueOnce(Object.assign(new Error('Bills setup needs review'),{status:409}));
    await expect(f.service.collect('bills-calendar')).rejects.toMatchObject({status:409});
    expect(f.authorize.mock.calls).toEqual([['bills-calendar']]);
    expect(f.scan).toHaveBeenCalledTimes(1);
  });
  it('persists encrypted evidence across restart without crossing workspace identity or encryption keys', async () => {
    const f = await fixture(), saved = await f.service.collect();
    expect(saved.latestScan).toMatchObject({ status: 'complete', messageCount: 1, threadCount: 1 });
    expect(saved.items[0]).toMatchObject({ disposition: 'hold', reviewed: false, newEvidence: true });
    const bytes = await readFile(f.workspaceFile, 'utf8');
    const recordBytes=()=>{const raw=new DatabaseSync(f.workspaceFile);try{return raw.prepare('SELECT id,revision,payload FROM workflow_records ORDER BY id').all();}finally{raw.close();}};const originalRecords=recordBytes();
    expect(bytes).not.toContain('Fictional repair'); expect(bytes).not.toContain('tenant@example.test');
    expect(await createMailIngestionService(f.options).get()).toEqual(saved);
    expect((await f.service.source(saved.items[0].id)).thread).toEqual(thread());
    await expect(createMailIngestionService({ ...f.options, database: undefined, workspaceId: 'private-workspace-b' }).get()).rejects.toMatchObject({ status: 503 });
    await expect(createMailIngestionService({ ...f.options, database: undefined, key: Buffer.alloc(32, 8) }).get()).rejects.toMatchObject({ status: 503 });
    expect(recordBytes()).toEqual(originalRecords);
  });

  it('recovers an interrupted durable intent on startup while preserving prior tasks', async () => {
    const f = await fixture(), saved = await f.service.collect();
    const state = await f.vault.read('mail-workspace') as any;
    state.latestScan.status = 'running'; state.latestScan.completedAt = null;
    state.receipts = state.receipts.map((r: any) => r.id === state.latestScan.id ? state.latestScan : r);
    await f.vault.write('mail-workspace', state);
    const restarted = createMailIngestionService(f.options), result = await restarted.get();
    expect(result.latestScan?.status).toBe('interrupted'); expect(result.items).toEqual(saved.items);
    expect((await createMailIngestionService(f.options).get()).latestScan?.status).toBe('interrupted');
    expect(f.scan).toHaveBeenCalledTimes(1);
  });

  it('refuses malformed storage without replacing its original bytes or reading the provider', async () => {
    const f = await fixture(); await f.service.collect();
    const raw = new DatabaseSync(f.workspaceFile); raw.prepare("UPDATE workflow_records SET payload=? WHERE kind='mail-register'").run('{broken fixture'); raw.close();
    const damaged=await readFile(f.workspaceFile);
    await expect(f.service.get()).rejects.toMatchObject({ status: 503 });
    await expect(f.service.collect()).rejects.toMatchObject({ status: 503 });
    expect(await readFile(f.workspaceFile)).toEqual(damaged); expect(f.scan).toHaveBeenCalledTimes(1);
  });

  it('keeps previous work when the next scan is partial, empty or fails', async () => {
    const f = await fixture(), previous = await f.service.collect(); f.advance();
    f.data.threads = []; f.data.paginationComplete = false; f.data.gaps = ['A provider page was unavailable.'];
    const partial = await f.service.collect(); expect(partial.items).toEqual(previous.items); expect(partial.latestScan?.status).toBe('partial');
    f.scan.mockRejectedValueOnce(new Error('Fictional read failure'));
    await expect(f.service.collect()).rejects.toThrow('Fictional read failure');
    const failed = await f.service.get(); expect(failed.items).toEqual(previous.items); expect(failed.latestScan?.status).toBe('failed');
    expect((await f.service.source(previous.items[0].id)).thread).toEqual(thread());
  });

  it('rejects a foreign account before publishing source or changing the work list', async () => {
    const f = await fixture(), prior = await f.service.collect();
    f.scan.mockImplementationOnce(async (_authority, request) => ({ ...f.data, accountId: 'other-agency', windowStartAt: request.windowStartAt, windowEndAt: request.windowEndAt }));
    await expect(f.service.collect()).rejects.toThrow();
    expect((await f.service.get()).items).toEqual(prior.items); expect((await f.service.get()).latestScan?.status).toBe('failed');
  });

  it.each(['revoked', 'binding', 'settings'] as const)('withholds pending provider evidence after %s authority change', async change => {
    const f = await fixture(), prior = await f.service.collect(); let release!: () => void, entered!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    f.scan.mockImplementationOnce(async (authority, request) => { entered(); await pending; return { ...f.data, accountId: authority.accountId, windowStartAt: request.windowStartAt, windowEndAt: request.windowEndAt }; });
    const run = f.service.collect(); await started;
    if (change === 'revoked') f.authorize.mockRejectedValue(new Error('Synthetic authority revoked'));
    else if (change === 'binding') f.authority.bindingRevision = 'b'.repeat(64);
    else f.authority.settingsRevision++;
    release(); await expect(run).rejects.toThrow();
    expect((await f.service.get()).items).toEqual(prior.items); expect((await f.service.get()).latestScan?.status).toBe('failed');
  });

  it('allows one collection, records explicit cancellation and does not retry the provider', async () => {
    const f = await fixture(); let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.scan.mockImplementationOnce(async (_authority, _request, signal) => {
      entered(); await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Synthetic cancellation')), { once: true }));
      throw new Error('Unexpected continuation');
    });
    const running = f.service.collect(); await started;
    await expect(f.service.collect()).rejects.toMatchObject({ status: 409 });
    expect((await f.service.get()).latestScan?.status).toBe('running');
    f.service.cancel(); await expect(running).rejects.toThrow('Synthetic cancellation');
    expect((await f.service.get()).latestScan?.status).toBe('interrupted'); expect(f.scan).toHaveBeenCalledTimes(1);
    expect((await f.service.collect()).latestScan?.status).toBe('complete');
  });

  it.each(['done', 'snoozed'] as const)('preserves %s and manual decisions on identical evidence, reopening only substantive new mail', async status => {
    const f = await fixture(), first = await f.service.collect(), id = first.items[0].id;
    await f.service.update(id, { expectedRevision: first.items[0].revision, status, snoozedUntil: initialTime + 86_400_000, priority: 'high', owner: 'Practice reviewer', note: 'Keep my decision.', disposition: 'waiting' });
    const manual = (await f.service.get()).items[0]; f.advance();
    const repeated = await f.service.collect(); expect(repeated.items[0]).toEqual(manual);
    expect(await f.service.prepareInput()).toBeNull(); expect((await f.service.get()).items[0]).toEqual(manual);
    f.data.threads[0].messages.push({ ...thread().messages[0], id: 'ab', at: initialTime + 500, body: 'A substantive new reply arrived.' });
    const changed = (await f.service.collect()).items[0];
    expect(changed).toMatchObject({ status: 'open', snoozedUntil: null, newEvidence: true, priority: 'high', owner: 'Practice reviewer', note: 'Keep my decision.', disposition: 'waiting' });
    expect(changed.sourceMessageIds).toEqual(['aa', 'ab']); expect(changed.revision).toBeGreaterThan(manual.revision);
  });

  it('does not reopen completed work just because a later scan has reduced coverage', async () => {
    const f = await fixture(), initial = await f.service.collect(), item = initial.items[0];
    await f.service.update(item.id, { expectedRevision: item.revision, status: 'done', priority: 'high', note: 'Reviewed manually.' });
    f.data.threads[0].historyComplete = false; f.data.gaps = ['The provider returned incomplete history.'];
    const result = await f.service.collect();
    expect(result.latestScan?.status).toBe('partial');
    expect(result.items[0]).toMatchObject({ status: 'done', priority: 'high', note: 'Reviewed manually.' });
  });

  it('durably resurfaces a snoozed task exactly at its deadline while preserving its manual decisions and evidence', async () => {
    const f = await fixture(), initial = await f.service.collect(), item = initial.items[0];
    const snoozed = await f.service.update(item.id, { expectedRevision: item.revision, status: 'snoozed', snoozedUntil: initialTime + 60_000,
      priority: 'high', owner: 'Practice reviewer', note: 'Call after the agreed time.', disposition: 'waiting', nextAction: 'Review the response.' });
    f.advance(59_999); expect(await f.service.get()).toEqual(snoozed);
    f.advance(1);
    const restarted = createMailIngestionService(f.options);
    const [first, concurrent] = await Promise.all([restarted.get(), restarted.get()]);
    expect(first.items[0]).toEqual({ ...snoozed.items[0], status: 'open', snoozedUntil: null,
      revision: snoozed.items[0].revision + 1, updatedAt: initialTime + 60_000 });
    expect(first.revision).toBe(snoozed.revision + 1); expect(concurrent).toEqual(first);
    expect(await createMailIngestionService(f.options).get()).toEqual(first);
    expect((await restarted.source(item.id)).thread).toEqual(thread()); expect(f.scan).toHaveBeenCalledTimes(1);
  });

  it('holds a stale edit after saving an elapsed snooze and accepts a refreshed decision', async () => {
    const f = await fixture(), initial = await f.service.collect(), item = initial.items[0];
    const snoozed = await f.service.update(item.id, { expectedRevision: item.revision, status: 'snoozed', snoozedUntil: initialTime + 1000 });
    f.advance();
    await expect(f.service.update(item.id, { expectedRevision: snoozed.items[0].revision, status: 'done' })).rejects.toMatchObject({ status: 409 });
    const saved = await createMailIngestionService(f.options).get();
    expect(saved.items[0]).toMatchObject({ status: 'open', revision: snoozed.items[0].revision + 1, updatedAt: initialTime + 1000 });
    expect((await f.service.update(item.id, { expectedRevision: saved.items[0].revision, status: 'done' })).items[0].status).toBe('done');
  });

  it('recovers interrupted collection and expired snoozes together with one saved revision', async () => {
    const f = await fixture(), initial = await f.service.collect(), item = initial.items[0];
    const snoozed = await f.service.update(item.id, { expectedRevision: item.revision, status: 'snoozed', snoozedUntil: initialTime + 1000 });
    const state = await f.vault.read('mail-workspace') as any;
    state.latestScan.status = 'running'; state.latestScan.completedAt = null;
    state.receipts = state.receipts.map((r: any) => r.id === state.latestScan.id ? state.latestScan : r);
    await f.vault.write('mail-workspace', state); f.advance();
    const saved = await createMailIngestionService(f.options).get();
    expect(saved.revision).toBe(snoozed.revision + 1);
    expect(saved.latestScan).toMatchObject({ status: 'interrupted', completedAt: initialTime + 1000 });
    expect(saved.items[0]).toMatchObject({ status: 'open', revision: snoozed.items[0].revision + 1, updatedAt: initialTime + 1000 });
  });

  it('saves elapsed snoozes before a failed provider read without relying on a later work-list fetch', async () => {
    const f = await fixture(), initial = await f.service.collect(), item = initial.items[0];
    const snoozed = await f.service.update(item.id, { expectedRevision: item.revision, status: 'snoozed', snoozedUntil: initialTime + 1000 });
    f.advance(); f.scan.mockRejectedValueOnce(new Error('Synthetic provider unavailable'));
    await expect(f.service.collect()).rejects.toThrow('Synthetic provider unavailable');
    const state = await f.vault.read('mail-workspace') as any;
    expect(state.items[0]).toEqual({ ...snoozed.items[0], status: 'open', snoozedUntil: null, revision: snoozed.items[0].revision + 1, updatedAt: initialTime + 1000 });
    expect(state.latestScan.status).toBe('failed');
  });

  it('resurfaces an elapsed snooze in the collection result when the deadline passes during an unchanged scan', async () => {
    const f = await fixture(), initial = await f.service.collect(), item = initial.items[0];
    const snoozed = await f.service.update(item.id, { expectedRevision: item.revision, status: 'snoozed', snoozedUntil: initialTime + 1000 });
    const implementation = f.scan.getMockImplementation()!;
    f.scan.mockImplementationOnce(async (...args) => { const result = await implementation(...args); f.advance(); return result; });
    const saved = await f.service.collect();
    expect(saved.items[0]).toEqual({ ...snoozed.items[0], status: 'open', snoozedUntil: null, revision: snoozed.items[0].revision + 1, updatedAt: initialTime + 1000 });
    expect(await createMailIngestionService(f.options).get()).toEqual(saved);
  });

  it('preserves complete prior evidence when a later page drops messages or only reorders them', async () => {
    const f = await fixture();
    f.data.threads[0].messages.push({ ...thread().messages[0], id: 'ab', at: initialTime - 500, body: 'Reviewed later reply.' });
    const collected = await f.service.collect(), item = collected.items[0];
    await f.service.update(item.id, { expectedRevision: item.revision, status: 'done' });
    f.data.threads[0].messages.reverse();
    expect((await f.service.collect()).items[0].status).toBe('done');
    f.data.threads[0].messages = f.data.threads[0].messages.filter(message => message.id === 'aa');
    f.data.threads[0].historyComplete = false; f.data.gaps = ['Message history was incomplete.'];
    const reduced = await f.service.collect();
    expect(reduced.items[0]).toMatchObject({ status: 'done', sourceMessageIds: ['aa', 'ab'] });
    expect((await f.service.source(item.id)).thread.messages.map(message => message.id)).toEqual(['aa', 'ab']);
  });

  it('rejects stale edits and source tampering while preserving the accepted decision', async () => {
    const f = await fixture(), initial = await f.service.collect(), item = initial.items[0];
    const changed = await f.service.update(item.id, { expectedRevision: item.revision, priority: 'high' });
    await expect(f.service.update(item.id, { expectedRevision: item.revision, status: 'done' })).rejects.toMatchObject({ status: 409 });
    expect((await f.service.get()).items).toEqual(changed.items);
    const source = await f.vault.read(`mail-scan-${item.sourceReceiptId}`) as any;
    source.data.threads[0].messages[0].body = 'Changed after review'; await f.vault.write(`mail-scan-${item.sourceReceiptId}`, source);
    await expect(f.service.source(item.id)).rejects.toMatchObject({ status: 503 });
    await expect(f.service.get()).rejects.toMatchObject({status:503});
  });

  it('holds worker preparation after source binding changes or the receipt becomes stale', async () => {
    const f = await fixture(); await f.service.collect(); await f.service.prepareInput();
    f.authority.bindingRevision = 'b'.repeat(64); await expect(f.service.prepareInput()).rejects.toMatchObject({ status: 409 });
    f.authority.bindingRevision = 'a'.repeat(64); f.advance(12 * 60 * 60_000 + 1);
    await expect(f.service.prepareInput()).rejects.toMatchObject({ status: 409 });
  });

  it.each(['broken-json', 'broken-envelope', 'missing-request', 'oversized-request', 'unknown-request-field', 'malformed-message', 'foreign-workspace', 'unknown-version'] as const)(
    'returns opaque recovery for corrupt normalized source %s and preserves encrypted bytes', async defect => {
      const f=await fixture(), initial=await f.service.collect(),item=initial.items[0];
      await f.service.update(item.id,{expectedRevision:item.revision,status:'done',note:'Keep the accepted human decision.'});
      const id=mailRecordId('mail-source',item.sourceReceiptId),raw=new DatabaseSync(f.workspaceFile);
      const diagnostic='synthetic-private-diagnostic-do-not-expose';
      if(defect==='broken-json'||defect==='broken-envelope')raw.prepare('UPDATE workflow_records SET payload=? WHERE id=?').run(defect==='broken-json'?`{${diagnostic}`:JSON.stringify({v:1,iv:{diagnostic},ct:diagnostic,tag:diagnostic}),id);
      else {const saved=await f.vault.read(`mail-scan-${item.sourceReceiptId}`);if(defect==='missing-request')saved.request=null;else if(defect==='oversized-request')saved.request.maxMessages=501;else if(defect==='unknown-request-field')saved.request.diagnostic=diagnostic;else if(defect==='malformed-message')saved.data.threads[0].messages[0].at=diagnostic;else if(defect==='foreign-workspace')saved.workspaceId=diagnostic;else saved.version=999;await f.vault.write(`mail-scan-${item.sourceReceiptId}`,saved);}
      raw.close();const bytes=await readFile(f.workspaceFile);
      await expect(f.service.source(item.id)).rejects.toMatchObject({status:503});
      await expect(f.service.get()).rejects.toMatchObject({status:503});
      expect(await readFile(f.workspaceFile)).toEqual(bytes);expect(f.scan).toHaveBeenCalledTimes(1);
    });

  it('fences competing preparations and rejects adoption of the superseded projection', async () => {
    const f=await fixture();f.data.threads=[thread('abc','aa'),thread('def','bb')];await f.service.collect();
    const oldRun=await reviewRun(f);let entered!:()=>void,release!:()=>void,checks=0;
    const reached=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    f.authorize.mockImplementation(async()=>{if(++checks===2){entered();await gate;}return structuredClone(f.authority);});
    const first=f.service.prepareInput();await reached;
    const other=createMailIngestionService(f.options),item=(await other.get()).items[0];
    await other.update(item.id,{expectedRevision:item.revision,status:'done',note:'Human decision between preparations.'});
    expect(await other.prepareInput()).toMatchObject({batchThreadCount:1});
    const winner=await f.vault.read('mail-prepared-input');release();await expect(first).rejects.toMatchObject({status:409});
    expect(await f.vault.read('mail-prepared-input')).toEqual(winner);
    await expect(f.service.applyReview(oldRun)).rejects.toMatchObject({status:409});
    expect((await f.service.get()).items.find(row=>row.id===item.id)).toMatchObject({status:'done',note:'Human decision between preparations.'});
  });

  it('rejects a changed workroom projection against its saved prepared digest', async () => {
    const f=await fixture();await f.service.collect();const run=await reviewRun(f),before=await f.service.get();
    const path=join(f.options.workroomDirectory,'workflow-inputs','accounts-inbox.json'),input=JSON.parse(await readFile(path,'utf8'));
    input.reviewBatch.pendingThreadCount++;await writeFile(path,JSON.stringify(input),{mode:0o600});
    await expect(f.service.applyReview(run)).rejects.toMatchObject({status:409});expect(await f.service.get()).toEqual(before);
  });

  it('requires a matching, actually validated review and adopts it once', async () => {
    const f = await fixture(); await f.service.collect();
    const wrong = await reviewRun(f, { sourceReference: 'realbud-mail:foreign' });
    await expect(f.service.applyReview(wrong)).rejects.toThrow(/current mail evidence/);
    const invalid = await reviewRun(f, { threads: [{ threadId: 'abc', disposition: 'reply-review', owner: 'accounts-reviewer', priority: 'normal', sourceMessageIds: ['ffff'], reason: 'Unknown source.', nextAction: 'Review', missingFacts: [] }] });
    await expect(f.service.applyReview(invalid)).rejects.toMatchObject({status:400});
    const run = await reviewRun(f), applied = await f.service.applyReview(run);
    expect(applied.items[0]).toMatchObject({ disposition: 'reply-review', owner: 'accounts-reviewer', newEvidence: false });
    expect(await f.service.applyReview(run)).toEqual(applied);
  });

  it('rejects reviews from a different workflow pack without changing the saved list', async () => {
    const f = await fixture(); await f.service.collect(); const run = await reviewRun(f), prior = await f.service.get();
    f.authority.settings.workflowPackId = 'office-core';
    await expect(f.service.applyReview(run)).rejects.toMatchObject({ status: 409 });
    expect(await f.service.get()).toEqual(prior);
    f.authority.settings.workflowPackId = null;
    await expect(f.service.applyReview(run)).rejects.toMatchObject({ status: 409 });
    expect(await f.service.get()).toEqual(prior);
  });

  it.each(['too-many-missing-facts', 'unsupported-control-text'] as const)('rejects %s in model output before it can make the work list unreadable', async defect => {
    const f = await fixture(); await f.service.collect(); const run = await reviewRun(f), prior = await f.service.get();
    const report = JSON.parse(run.evidence[0].note) as InboxReview;
    if (defect === 'too-many-missing-facts') report.threads[0].missingFacts = Array.from({ length: 101 }, (_, i) => `Unverified fact ${i}`);
    else report.threads[0].reason = 'Unverified\u007ftext';
    run.evidence[0].note = JSON.stringify(report);
    await expect(f.service.applyReview(run)).rejects.toThrow();
    expect(await createMailIngestionService(f.options).get()).toEqual(prior);
  });

  it('bounds derived coverage gaps while retaining the explicit unresolved-work hold', async () => {
    const f = await fixture();
    for (let batch = 0; batch < 2; batch++) {
      f.data.threads = Array.from({ length: 100 }, (_, i) => thread((batch * 100 + i + 1).toString(16), (batch * 100 + i + 1).toString(16)));
      await f.service.collect();
    }
    const prior = await f.service.get();
    f.data.threads = []; f.data.paginationComplete = false; f.data.gaps = Array.from({ length: 200 }, (_, i) => `Unconfirmed provider coverage ${i}`);
    await f.service.collect();
    const recovered = await createMailIngestionService(f.options).get();
    expect(recovered.items).toEqual(prior.items); expect(recovered.latestScan?.status).toBe('partial');
    expect(recovered.latestScan?.gaps).toHaveLength(200);
    expect(recovered.latestScan?.gaps).toContain('More unresolved conversations exist than this scan can carry; review or narrow the saved work list.');
  });

  it('preserves a human decision made while a prepared review is running', async () => {
    const f = await fixture(), collected = await f.service.collect(), run = await reviewRun(f), item = collected.items[0];
    const updated = await f.service.update(item.id, { expectedRevision: item.revision, status: 'done', priority: 'high', owner: 'Practice reviewer', note: 'Human decision while worker was busy.' });
    const adopted = await f.service.applyReview(run);
    expect(adopted.items).toEqual(updated.items);
  });

  it('prepares bounded review batches and advances through unreviewed evidence without asking the model to rescan', async () => {
    const f = await fixture(); f.data.threads = Array.from({ length: 21 }, (_, i) => thread((i + 1).toString(16), (i + 101).toString(16)));
    await f.service.collect();
    const first = await reviewRun(f), adopted = await f.service.applyReview(first);
    expect(adopted.items.filter(i => !i.newEvidence)).toHaveLength(20);
    const second = await reviewRun(f); expect(second.evidence[0].note).not.toBe(first.evidence[0].note);
    await f.service.applyReview(second); expect(await f.service.prepareInput()).toBeNull(); expect(f.scan).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized encrypted source before claiming successful collection or replacing prior work', async () => {
    const f = await fixture(), prior = await f.service.collect();
    f.authority.settings.propertyReferences = Array.from({ length: 200 }, (_, i) => ({ propertyId: `property-${i}`, reference: `REF-${i}`, aliases: Array.from({ length: 20 }, (_, a) => `${a}${'x'.repeat(195)}`) }));
    f.data.threads = [{ ...thread(), messages: Array.from({ length: 40 }, (_, i) => ({ ...thread().messages[0], id: (i + 1).toString(16), body: 'x'.repeat(12_000), subject: 'x'.repeat(2048), from: 'x'.repeat(2048), to: 'x'.repeat(2048) })) }];
    await expect(f.service.collect()).rejects.toMatchObject({ status: 413 });
    expect((await f.service.get()).items).toEqual(prior.items);
    expect((await f.service.get()).latestScan?.status).toBe('failed');
  });

  it('keeps a large source readable after encryption without storing duplicate worker input', async () => {
    const f = await fixture();
    f.authority.settings.propertyReferences = Array.from({ length: 175 }, (_, i) => ({ propertyId: `property-${i}`, reference: `REF-${i}`, aliases: Array.from({ length: 20 }, (_, a) => `${a}${'x'.repeat(195)}`) }));
    f.data.threads = [{ ...thread(), messages: Array.from({ length: 40 }, (_, i) => ({ ...thread().messages[0], id: (i + 1).toString(16), body: 'x'.repeat(10_000) })) }];
    const saved = await f.service.collect();
    expect(saved.latestScan?.status).toBe('complete');
    const restarted = createMailIngestionService(f.options);
    expect((await restarted.source(saved.items[0].id)).thread.messages).toHaveLength(40);
    await expect(restarted.prepareInput()).rejects.toMatchObject({ status: 413 });
    expect((await restarted.get()).items).toEqual(saved.items);
  });

  it('retains multilingual tasks beyond the old aggregate encrypted vault read limit', async () => {
    const f = await fixture(); let priorItems: Awaited<ReturnType<typeof f.service.get>>['items'] = [], refused = false;
    for (let batch = 0; batch < 4; batch++) {
      f.data.threads = Array.from({ length: 100 }, (_, i) => {
        const id = (batch * 100 + i + 1).toString(16), row = thread(id, id);
        row.messages[0].subject = '物'.repeat(2048); row.messages[0].body = ''; return row;
      });
      try { const saved = await f.service.collect(); priorItems = saved.items; }
      catch (error) { expect(error).toMatchObject({ status: 413 }); refused = true; }
      expect((await createMailIngestionService(f.options).get()).items).toEqual(priorItems);
      if (refused) break;
    }
    expect(refused).toBe(false); expect(priorItems).toHaveLength(400);
  });
});

describe('bounded, checkpointed historical mail acquisition', () => {
  async function historyFixture(scope: Partial<MailAuthority['settings']['mailScope']> = {}) {
    const f = await fixture();
    f.authority.settings.mailScope = { ...f.authority.settings.mailScope, historyDays: 90, maxMessages: 10, ...scope };
    const scan = vi.fn(async (current: MailAuthority, request: MailScanRequest, signal: AbortSignal): Promise<MailScanResult> => {
      void signal;
      const index = windowIndex(request);
      return { accountId: current.accountId, windowStartAt: request.windowStartAt, windowEndAt: request.windowEndAt,
        pages: 1, paginationComplete: true, gaps: [],
        threads: [{ id: (index + 1).toString(16), historyComplete: true, messages: [{ id: (index + 21).toString(16),
          threadId: (index + 1).toString(16), at: request.windowStartAt + 1000, direction: 'incoming', from: 'vendor@example.test',
          to: 'accounts@example.test', subject: 'Fictional quarterly invoice', body: 'Fictional invoice for review.',
          bodyTruncated: false, attachments: [] }] }] };
    });
    const plan = planMailHistory({ accountId: f.authority.accountId, bindingRevision: f.authority.bindingRevision,
      timeZone: f.authority.settings.timeZone, endAt: initialTime, totalDays: f.authority.settings.mailScope.historyDays,
      windowDays: Math.min(MAIL_HISTORY_WINDOW_DAYS, f.authority.settings.mailScope.historyDays),
      includeSent: f.authority.settings.mailScope.includeSent, maxMessagesPerWindow: f.authority.settings.mailScope.maxMessages });
    const windows = mailHistoryWindows(plan);
    function windowIndex(request: MailScanRequest) {
      const at = windows.findIndex(w => w.startAt === request.windowStartAt && w.endAt === request.windowEndAt);
      if (at < 0) throw new Error(`Unplanned window ${request.windowStartAt}-${request.windowEndAt}`);
      return at;
    }
    const build = () => { const service = createNormalizedMailService({ ...f.options, scan }); services.push(service); return service; };
    const saved = async () => JSON.parse(await readFile(join(f.options.workroomDirectory, 'mail-history', 'checkpoint.json'), 'utf8'));
    return { ...f, scan, plan, windows, build, saved, requested: () => scan.mock.calls.map(call => windowIndex(call[1])) };
  }

  it('divides the approved interval into office-calendar windows that tile it without overlap or gap', () => {
    // Brisbane has no DST; the Chicago interval contains a spring-forward and the
    // Auckland one a fall-back, so calendar counting is what keeps them aligned.
    for (const [timeZone, iso, shifts] of [['Australia/Brisbane', '2026-03-20T15:30:00Z', false], ['America/Chicago', '2026-03-20T15:30:00Z', true],
      ['Pacific/Auckland', '2026-05-20T15:30:00Z', true], ['Pacific/Auckland', '2026-03-20T15:30:00Z', false]] as [string, string, boolean][]) {
      const endAt = Date.parse(iso);
      const plan = planMailHistory({ accountId: 'mail-a', bindingRevision: 'a'.repeat(64), timeZone, endAt,
        totalDays: 90, windowDays: 30, includeSent: true, maxMessagesPerWindow: 100 });
      expect(plan.windowCount).toBe(3);
      expect(plan.maxMessagesTotal).toBe(300);
      const windows = mailHistoryWindows(plan);
      expect(windows[0].endAt).toBe(endAt);
      expect(windows[2].startAt).toBe(plan.approvedStartAt);
      for (let index = 0; index + 1 < windows.length; index++) {
        expect(windows[index].startAt).toBe(windows[index + 1].endAt);
        expect(windows[index].endAt).toBeGreaterThan(windows[index].startAt);
        // Every interior boundary is that office day's own first instant.
        expect(officeDayStart(windows[index].startAt, timeZone)).toBe(windows[index].startAt);
        expect(officeDayOrdinal(windows[index].startAt, timeZone) - officeDayOrdinal(windows[index + 1].startAt, timeZone)).toBe(30);
      }
      // Calendar dates, not 24-hour durations: only a zone without a transition
      // inside the interval has a whole-day millisecond span.
      const span = officeDayStart(endAt, timeZone) - plan.approvedStartAt;
      expect(officeDayOrdinal(endAt, timeZone) - officeDayOrdinal(plan.approvedStartAt, timeZone)).toBe(90);
      if (shifts) expect(span).not.toBe(90 * 86_400_000);
      else expect(span).toBe(90 * 86_400_000);
    }
    expect(() => planMailHistory({ accountId: 'mail-a', bindingRevision: 'a'.repeat(64), timeZone: 'Australia/Brisbane',
      endAt: Date.parse('2026-03-20T15:30:00Z'), totalDays: 91, windowDays: 30, includeSent: true, maxMessagesPerWindow: 100 })).toThrow();
    expect(() => planMailHistory({ accountId: 'mail-a', bindingRevision: 'a'.repeat(64), timeZone: 'Australia/Brisbane',
      endAt: Date.parse('2026-03-20T15:30:00Z'), totalDays: 7, windowDays: 30, includeSent: true, maxMessagesPerWindow: 100 })).toThrow();
  });

  it('checkpoints every window and reports what was not checked', async () => {
    const f = await historyFixture();
    const coverage = await f.build().collectHistory();
    expect(f.requested()).toEqual([0, 1, 2]);
    expect(coverage).toMatchObject({ accountId: 'mail-a', windowCount: 3, windowsComplete: 3, windowsPartial: 0,
      windowsFailed: 0, windowsNotChecked: 0, windowsWithUnfetchedPages: 0, messagesSeen: 3, complete: true, gaps: [], notChecked: [] });
    expect(coverage!.checkedFromAt).toBe(f.plan.approvedStartAt);
    expect(coverage!.checkedToAt).toBe(f.plan.approvedEndAt);
    const state = await f.saved();
    expect(state.windows.map((w: any) => w.status)).toEqual(['complete', 'complete', 'complete']);
    expect(state.messages.map((m: any) => m.windowIndex).sort()).toEqual([0, 1, 2]);
    // Identity only: no bodies, subjects or attachment names reach this file.
    expect(JSON.stringify(state)).not.toContain('Fictional quarterly invoice');
    expect(JSON.stringify(state)).not.toContain('vendor@example.test');
    // A completed window is never requested again.
    f.scan.mockClear();
    expect(await f.build().collectHistory()).toMatchObject({ complete: true, messagesSeen: 3 });
    expect(f.scan).not.toHaveBeenCalled();
    expect(await f.build().historyCoverage()).toMatchObject({ complete: true, windowsComplete: 3 });
  });

  it('resumes an unconfirmed window after a crash without re-reading a completed one', async () => {
    const f = await historyFixture();
    let release!: () => void;
    f.scan.mockImplementationOnce(async (_authority, _request, signal) => {
      await new Promise<void>((resolve, reject) => { release = resolve; signal.addEventListener('abort', () => reject(signal.reason)); });
      throw new Error('unreachable');
    });
    const crashing = f.build();
    const running = crashing.collectHistory().catch(error => error);
    const peek = async () => { try { return await f.saved(); } catch { return null; } };
    // Bounded by time, not iterations: Windows admission makes each private write slower.
    for (const until = Date.now() + 30_000; Date.now() < until && (await peek())?.windows[0].status !== 'running';) await new Promise(r => setTimeout(r, 5));
    const midway = await f.saved();
    // The intent is durable before the provider is asked for the window.
    expect(midway.windows[0]).toMatchObject({ status: 'running', attemptedAt: initialTime, capturedAt: null, pages: 0 });
    expect(midway.completedAt).toBeNull();
    // A separate service sees the unconfirmed window as coverage it does not have.
    expect(await f.build().historyCoverage()).toMatchObject({ complete: false, windowsComplete: 0, windowsNotChecked: 3, checkedFromAt: null });
    crashing.cancel(); release();
    await running;
    f.scan.mockClear();
    const resumed = await f.build().collectHistory();
    expect(f.requested()).toEqual([0, 1, 2]);
    expect(resumed).toMatchObject({ complete: true, windowsComplete: 3, messagesSeen: 3 });
    f.scan.mockClear();
    f.scan.mockImplementationOnce(async () => { throw Object.assign(new Error('The fictional source refused this window.'), { status: 502 }); });
    const state = await f.saved();
    state.windows[1] = { ...state.windows[1], status: 'pending', pages: 0, paginationComplete: false, threadsSeen: 0, messagesSeen: 0, gaps: [], capturedAt: null };
    state.messages = state.messages.filter((m: any) => m.windowIndex !== 1);
    state.completedAt = null;
    await writeFile(join(f.options.workroomDirectory, 'mail-history', 'checkpoint.json'), JSON.stringify(state), { mode: 0o600 });
    await expect(f.build().collectHistory()).rejects.toMatchObject({ status: 502 });
    expect(f.requested()).toEqual([1]);
    const failed = await f.saved();
    expect(failed.windows.map((w: any) => w.status)).toEqual(['complete', 'failed', 'complete']);
    expect(failed.windows[1].gaps).toEqual(['This history window could not be confirmed. Its coverage is still missing.']);
    expect(await f.build().historyCoverage()).toMatchObject({ complete: false, windowsComplete: 2, windowsFailed: 1, messagesSeen: 2 });
    expect((await f.build().historyCoverage())!.notChecked).toEqual([expect.stringContaining('was not checked because its read could not be confirmed.')]);
  });

  it('reports a partial window honestly and replays the same messages without adding records', async () => {
    const f = await historyFixture();
    f.scan.mockImplementation(async (current, request) => ({ accountId: current.accountId, windowStartAt: request.windowStartAt,
      windowEndAt: request.windowEndAt, pages: 20, paginationComplete: false, gaps: ['More mailbox pages remain; this scan is partial.'],
      threads: [{ id: 'aa', historyComplete: true, messages: [{ id: request.windowStartAt.toString(16), threadId: 'aa', at: request.windowStartAt + 5, direction: 'incoming',
        from: 'vendor@example.test', to: 'accounts@example.test', subject: 'Fictional invoice', body: 'Fictional.', bodyTruncated: false, attachments: [] }] }] }));
    const first = await f.build().collectHistory();
    expect(first).toMatchObject({ complete: false, windowsComplete: 0, windowsPartial: 3, windowsWithUnfetchedPages: 3,
      windowsNotChecked: 0, notChecked: [], gaps: ['More mailbox pages remain; this scan is partial.'] });
    // Threads recur across windows; one source identity per message, no duplicates.
    expect(first.messagesSeen).toBe(3);
    expect(first.checkedFromAt).toBe(f.plan.approvedStartAt);
    const replay = await f.build().collectHistory();
    expect(f.requested()).toEqual([0, 1, 2, 0, 1, 2]);
    expect(replay.messagesSeen).toBe(3);
    const state = await f.saved();
    expect(state.messages).toHaveLength(3);
    expect(new Set(state.messages.map((m: any) => m.key)).size).toBe(3);
  });

  it('starts one collection per approved revision and reports its progress in the workspace read model', async () => {
    const f = await historyFixture();
    const service = f.build();
    expect(await service.historyStatus()).toMatchObject({ state: 'not-started', windowCount: 0, detail: 'History: not started.', coverage: null });
    await service.startHistory({ accountId: 'mail-a', settingsRevision: 1, historyDays: 90 });
    expect(f.requested()).toEqual([0, 1, 2]);
    expect(await service.historyStatus()).toMatchObject({ state: 'complete', accountId: 'mail-a', settingsRevision: 1,
      windowsChecked: 3, windowCount: 3, heldReason: null, detail: 'History: complete (3 of 3 windows).' });
    // The same read model the workspace serves carries it; no separate source.
    expect((await service.get()).history).toMatchObject({ state: 'complete', coverage: { complete: true, messagesSeen: 3 } });
    // A repeat check with the same approval never restarts a complete collection.
    f.scan.mockClear();
    await service.startHistory({ accountId: 'mail-a', settingsRevision: 1, historyDays: 90 });
    expect(f.scan).not.toHaveBeenCalled();
    // Nor does one arriving while a collection for a new approval is running.
    f.authority.settings.mailScope = { ...f.authority.settings.mailScope, historyDays: 30 };
    f.authority.settingsRevision = 2;
    let release!: () => void;
    f.scan.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); throw new Error('unreachable'); });
    const second = f.build();
    const running = second.startHistory({ accountId: 'mail-a', settingsRevision: 2, historyDays: 30 });
    // Wait for the replanned window to reach its (held) read; the status is
    // already 'checking' a few private writes before that call is made.
    await vi.waitFor(() => expect(f.scan).toHaveBeenCalledTimes(1), { timeout: 30_000 });
    expect(await second.historyStatus()).toMatchObject({ state: 'checking', detail: 'History: checking 0 of 1 windows.' });
    // A repeat check joins the collection in flight instead of starting another.
    expect(second.startHistory({ accountId: 'mail-a', settingsRevision: 2, historyDays: 30 })).toBe(running);
    expect(f.scan).toHaveBeenCalledTimes(1);
    second.cancel(); release(); await running;
  });

  it('plans again for a changed approval and keeps the superseded checkpoint', async () => {
    const f = await historyFixture();
    await f.build().startHistory({ accountId: 'mail-a', settingsRevision: 1, historyDays: 90 });
    const first = await f.saved();
    expect(first.plan.totalDays).toBe(90);
    f.scan.mockClear();
    f.authority.settings.mailScope = { ...f.authority.settings.mailScope, historyDays: 30 };
    f.authority.settingsRevision = 2;
    const service = f.build();
    await service.startHistory({ accountId: 'mail-a', settingsRevision: 2, historyDays: 30 });
    const replanned = await f.saved();
    expect(replanned.plan.totalDays).toBe(30);
    expect(replanned.windows).toHaveLength(1);
    expect(replanned.planDigest).not.toBe(first.planDigest);
    expect(f.scan).toHaveBeenCalledTimes(1);
    // The old approval's coverage is retained beside the new plan, not deleted.
    const previous = JSON.parse(await readFile(join(f.options.workroomDirectory, 'mail-history', 'previous.json'), 'utf8'));
    expect(previous).toEqual(first);
    expect(previous.windows.map((w: any) => w.status)).toEqual(['complete', 'complete', 'complete']);
    expect(await service.historyStatus()).toMatchObject({ state: 'complete', settingsRevision: 2, windowCount: 1 });
  });

  it('holds with an intact checkpoint when the source changes mid-collection and resumes the unchecked windows at boot', async () => {
    const f = await historyFixture();
    let authorizations = 0;
    f.authorize.mockImplementation(async () => {
      authorizations++;
      // The reviewed binding is withdrawn after the first window is captured.
      return { ...structuredClone(f.authority), bindingRevision: authorizations >= 3 ? 'b'.repeat(64) : f.authority.bindingRevision };
    });
    const held = f.build();
    await held.startHistory({ accountId: 'mail-a', settingsRevision: 1, historyDays: 90 });
    expect(await held.historyStatus()).toMatchObject({ state: 'held',
      heldReason: 'Mail setup changed during collection. The previous history coverage is preserved.',
      windowsChecked: 2, windowCount: 3, detail: 'History: held (Mail setup changed during collection. The previous history coverage is preserved).' });
    const stopped = await f.saved();
    expect(stopped.windows.map((w: any) => w.status)).toEqual(['complete', 'failed', 'pending']);
    expect(stopped.messages).toHaveLength(1);
    f.scan.mockClear();
    f.authorize.mockImplementation(async () => structuredClone(f.authority));
    // A restart resumes from the checkpoint without re-reading a complete window.
    const booted = f.build();
    await booted.resumeHistoryIfPending();
    await vi.waitFor(async () => expect(await booted.historyStatus()).toMatchObject({ state: 'complete' }), { timeout: 30_000 });
    expect(f.requested()).toEqual([1, 2]);
    expect(await booted.historyCoverage()).toMatchObject({ complete: true, windowsComplete: 3, messagesSeen: 3 });
    // Nothing is pending, so a later boot starts no collection of its own.
    f.scan.mockClear();
    const quiet = f.build();
    await quiet.resumeHistoryIfPending();
    expect(f.scan).not.toHaveBeenCalled();
    expect(await quiet.historyStatus()).toMatchObject({ state: 'complete', settingsRevision: null });
  });

  it('turns the per-scan message cap into a per-window cap bounded by the plan total', async () => {
    const f = await historyFixture({ maxMessages: 2 });
    const service = f.build();
    f.scan.mockImplementation(async (current, request) => ({ accountId: current.accountId, windowStartAt: request.windowStartAt,
      windowEndAt: request.windowEndAt, pages: 1, paginationComplete: true, gaps: [],
      threads: [{ id: 'aa', historyComplete: true, messages: Array.from({ length: 3 }, (_, i) => ({ id: (i + 176).toString(16), threadId: 'aa',
        at: request.windowStartAt + i, direction: 'incoming' as const, from: 'v@example.test', to: 'a@example.test',
        subject: 'Fictional', body: 'Fictional.', bodyTruncated: false, attachments: [] })) }] }));
    expect(f.plan.maxMessagesPerWindow).toBe(2);
    expect(f.plan.maxMessagesTotal).toBe(6);
    // A window that returns more than its own cap is refused, not truncated.
    await expect(service.collectHistory()).rejects.toMatchObject({ status: 400 });
    expect(f.scan.mock.calls.map(call => call[1].maxMessages)).toEqual([2]);
    expect((await f.saved()).windows[0].status).toBe('failed');
    const state = await f.saved();
    expect(() => parseMailHistoryCheckpoint({ ...state, messages: Array.from({ length: 7 }, (_, i) => ({ key: 'a'.repeat(63) + i,
      threadId: 'aa', messageId: (i + 16).toString(16), at: 1, direction: 'incoming', digest: 'b'.repeat(64), windowIndex: 0 })) },
      f.options.workspaceId, value => createHash('sha256').update(JSON.stringify(value)).digest('hex'))).toThrow();
  });
});
