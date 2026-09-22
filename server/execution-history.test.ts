import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobRun, LoopRun, Recipe } from '../shared/contracts.ts';
import { JobRunStore } from './job-runs.ts';
import { LoopManager } from './routines.ts';
import { WorkflowDatabase } from './workflow-database.ts';
import { executionDigest, executionStream } from './execution-history.ts';
import { restoreExecutionRecords, validateExecutionRecords, type ExecutionBackupRecord } from './execution-history-backup.ts';
import * as atomic from './atomic.ts';

const folders: string[] = [], close: Array<() => void> = [];
const at = Date.parse('2026-09-21T00:00:00Z');
const folder = () => { const dir = mkdtempSync(join(tmpdir(), 'realbud-execution-history-')); folders.push(dir); return dir; };
const recipe = (id = 'job'): Recipe => ({ id, title: 'Private result', description: 'Review a saved file', steps: ['Read'], allowedOrigins: [], evidence: 'Source', capabilities: ['read-book'], limits: { maxTurns: 2, maxRuntimeMinutes: 1 }, siteNotes: null, status: 'active', createdAt: 1, schedule: null, planApprovedAt: 1, revision: 1, updatedAt: 1, approvedRevision: 1, attachment: null, submitAcknowledgedAt: null });
const run = (i: number, extra: Partial<JobRun> = {}): JobRun => ({ id: `run-${i}`, jobId: 'job', jobTitle: 'Private result', jobRevision: 1, mode: 'prepare', trigger: 'manual', status: 'completed', scheduledFor: i, createdAt: i, finishedAt: i + 1, idempotencyKey: `request-${i}`, attempt: 1, spec: { title: 'Private result', description: 'Review a saved file', steps: ['Read'], allowedOrigins: [], evidence: 'Source', capabilities: ['read-book'], limits: { maxTurns: 2, maxRuntimeMinutes: 1 } }, evidence: [{ kind: 'output', at: i, note: `Private completed result ${i}` }], approvalRequests: [], detail: 'Prepared', ...extra });
const request = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const loopRun = (i: number): LoopRun => ({ id: `loop-${i}`, loopId: 'inbound-triage', loopName: 'Morning priorities', loopRevision: 1, manual: true, requestId: request(i), status: 'completed', createdAt: at + i, scheduledFor: at + i, finishedAt: at + i + 1, detail: 'Prepared' });
const state = () => Object.fromEntries(['morning-arrears', 'owner-letter', 'inbound-triage'].map(id => [id, { enabled: false, handledThrough: at, revision: 1 }]));
function jobs(dir: string, filename = 'job-runs.json') { const store = new JobRunStore({ file: join(dir, filename), now: () => at }); close.push(() => store.close()); return store; }
function loops(dir: string, execute = vi.fn(async () => ({ ok: true, detail: 'Prepared' }))) { const manager = new LoopManager({ file: join(dir, 'loops.json'), now: () => at, timezone: 'UTC', hostTimezone: 'UTC', execute }); close.push(() => manager.close()); return { manager, execute }; }
function allRows(database: WorkflowDatabase) { const rows: ExecutionBackupRecord[] = []; for (const kind of ['execution-job', 'execution-loop', 'execution-request', 'execution-state']) { let before: number | undefined; do { const page = database.page(kind, { before, limit: 200 }); rows.push(...page.records.map(row => ({ ...row, kind }))); before = page.next ?? undefined; if (!page.next) break; } while (true); } return rows; }
afterEach(() => { vi.restoreAllMocks(); for (const finish of close.splice(0).reverse()) finish(); for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('permanent encrypted execution history', () => {
  it('migrates all legacy runs, keeps evicted retry identity and full outcome after restart, and marks historical work seen', () => {
    const dir = folder(), file = join(dir, 'job-runs.json');
    const original = JSON.stringify({ version: 1, runs: Array.from({ length: 1001 }, (_, i) => run(i)) }); writeFileSync(file, original);
    const store = jobs(dir); expect(readFileSync(file, 'utf8')).toBe(original);
    const fresh = store.enqueue(recipe(), { mode: 'prepare', trigger: 'manual', idempotencyKey: 'new' }).run;
    expect(store.list().some(r => r.id === 'run-0')).toBe(false);
    store.start(fresh.id); store.settle(fresh.id, { status: 'completed', detail: 'Done' });
    const restarted = jobs(dir);
    expect(restarted.enqueue(recipe(), { mode: 'prepare', trigger: 'manual', idempotencyKey: 'request-0' })).toMatchObject({ created: false, run: { id: 'run-0', status: 'completed' } });
    expect(restarted.get('run-0')?.evidence[0]?.note).toBe('Private completed result 0');
    expect(restarted.markSeen('run-0')).toMatchObject({ seenAt: at, status: 'completed' });
    expect(jobs(dir).get('run-0')?.seenAt).toBe(at);
    expect(readFileSync(join(dir, 'workflow-state.sqlite')).includes(Buffer.from('Private completed result 0'))).toBe(false);
  });

  it('keeps stable filtered page cursors across inserts and rejects cursor reuse for another filter', () => {
    const dir = folder(); writeFileSync(join(dir, 'job-runs.json'), JSON.stringify({ version: 1, runs: Array.from({ length: 12 }, (_, i) => run(i, { jobId: i % 2 ? 'other' : 'job' })) }));
    const store = jobs(dir), first = store.history({ limit: 4, jobId: 'job' });
    expect(first.runs.map(r => r.id)).toEqual(['run-10', 'run-8']);
    store.enqueue(recipe('new-job'), { mode: 'attended', trigger: 'manual', idempotencyKey: 'latest' });
    const next = store.history({ limit: 4, jobId: 'job', cursor: first.nextCursor! });
    expect(next.runs.map(r => r.id)).toEqual(['run-6', 'run-4']);
    expect(() => store.history({ cursor: first.nextCursor!, jobId: 'other' })).toThrow(expect.objectContaining({ status: 400 }));
  });

  it('never evicts an active attended run from overlap and approval guards', () => {
    const dir = folder(); writeFileSync(join(dir, 'job-runs.json'), JSON.stringify({ version: 1, runs: [run(0, { mode: 'attended', status: 'queued', createdAt: at }), ...Array.from({ length: 1000 }, (_, i) => run(i + 1, { jobId: 'finished' }))] }));
    const store = jobs(dir); store.enqueue(recipe('other'), { mode: 'attended', trigger: 'manual', idempotencyKey: 'another' });
    expect(store.list().find(r => r.id === 'run-0')?.status).toBe('queued');
    expect(() => store.enqueue(recipe(), { mode: 'attended', trigger: 'manual', idempotencyKey: 'overlap' })).toThrow(/already has work/);
  });

  it('rejects changed plan, execution mode and scheduled input on the same historical key', () => {
    const dir = folder(); writeFileSync(join(dir, 'job-runs.json'), JSON.stringify({ version: 1, runs: [run(0)] })); const store = jobs(dir);
    for (const input of [{ mode: 'shadow' as const, trigger: 'manual' as const }, { mode: 'prepare' as const, trigger: 'schedule' as const }, { mode: 'prepare' as const, trigger: 'manual' as const, scheduledFor: 500 }]) expect(() => store.enqueue(recipe(), { ...input, idempotencyKey: 'request-0' })).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => store.enqueue({ ...recipe(), revision: 2 }, { mode: 'prepare', trigger: 'manual', idempotencyKey: 'request-0' })).toThrow(expect.objectContaining({ status: 409 }));
  });

  it('keeps fresh stores empty and isolates distinct history files sharing one directory', () => {
    const dir = folder(), a = jobs(dir), b = jobs(dir, 'second-jobs.json');
    const db = new WorkflowDatabase({ dir }); close.push(() => db.close()); expect(db.hasRecords()).toBe(false);
    const input = { mode: 'attended' as const, trigger: 'manual' as const, idempotencyKey: 'same-local-key' };
    expect(a.enqueue(recipe(), input).created).toBe(true); expect(b.enqueue(recipe(), input).created).toBe(true);
    expect(a.getByIdempotencyKey(input.idempotencyKey)?.id).not.toBe(b.getByIdempotencyKey(input.idempotencyKey)?.id);
  });

  it('holds stale second writers before dispatch and keeps the winning request identity', () => {
    const dir = folder(), a = jobs(dir), b = jobs(dir), input = { mode: 'attended' as const, trigger: 'manual' as const, idempotencyKey: 'winning-key' };
    const first = a.enqueue(recipe(), input);
    expect(b.enqueue(recipe(), input)).toMatchObject({ created: false, run: { id: first.run.id } });
    expect(() => b.enqueue(recipe('other'), { ...input, idempotencyKey: 'losing-key' })).toThrow(expect.objectContaining({ status: 503 }));
    expect(jobs(dir).getByIdempotencyKey('losing-key')).toBeUndefined();
  });

  it('rolls back a failed migration transaction and preserves exact legacy bytes', () => {
    const dir = folder(), file = join(dir, 'job-runs.json'), original = JSON.stringify([run(0), run(1)]); writeFileSync(file, original);
    const database = new WorkflowDatabase({ dir }); close.push(() => database.close());
    const create = database.create.bind(database); let calls = 0;
    vi.spyOn(database, 'create').mockImplementation((...args) => { if (++calls === 3) throw new Error('simulated disk failure'); return create(...args); });
    const store = new JobRunStore({ file, database }); close.push(() => store.close());
    expect(store.recovery.active).toBe(true); expect(readFileSync(file, 'utf8')).toBe(original); expect(database.hasRecords()).toBe(false);
  });

  it('refuses mismatched cache history and corrupted encrypted receipts without replacement', () => {
    const dir = folder(), store = jobs(dir); const saved = store.enqueue(recipe(), { mode: 'attended', trigger: 'manual', idempotencyKey: 'kept' }).run;
    const file = join(dir, 'job-runs.json'), changed = JSON.stringify({ version: 1, runs: [{ ...saved, detail: 'Unexpected edit' }] }); writeFileSync(file, changed);
    expect(jobs(dir).recovery.active).toBe(true); expect(readFileSync(file, 'utf8')).toBe(changed);
  });

  it('holds a migrated projection when its permanent ledger was lost instead of forgetting old keys', () => {
    const dir = folder(), store = jobs(dir); store.enqueue(recipe(), { mode: 'attended', trigger: 'manual', idempotencyKey: 'keep-forever' });
    store.close(); unlinkSync(join(dir, 'workflow-state.sqlite'));
    const prior = readFileSync(join(dir, 'job-runs.json'), 'utf8'), restarted = jobs(dir);
    expect(restarted.recovery.active).toBe(true);
    expect(() => restarted.enqueue(recipe(), { mode: 'attended', trigger: 'manual', idempotencyKey: 'keep-forever' })).toThrow(expect.objectContaining({ status: 503 }));
    expect(readFileSync(join(dir, 'job-runs.json'), 'utf8')).toBe(prior);
    expect(() => validateExecutionRecords([], { 'job-runs.json': prior })).toThrow(/recovery/);
  });

  it('pauses the store after discovering a malformed permanent request receipt', () => {
    const dir = folder(), store = jobs(dir); store.enqueue(recipe(), { mode: 'attended', trigger: 'manual', idempotencyKey: 'corrupt-key' });
    const database = new WorkflowDatabase({ dir }); close.push(() => database.close());
    const row = database.page<Record<string, unknown>>('execution-request', { limit: 1 }).records[0]!;
    database.update('execution-request', row.id, row.revision, () => ({ ...row.value, binding: 'invalid' }));
    expect(() => store.getByIdempotencyKey('corrupt-key')).toThrow(expect.objectContaining({ status: 503 }));
    expect(store.recovery.active).toBe(true);
    expect(() => store.enqueue(recipe('other'), { mode: 'attended', trigger: 'manual', idempotencyKey: 'new-key' })).toThrow(expect.objectContaining({ status: 503 }));
  });

  it('rolls back legacy migration if its source bytes change while rows are being imported', () => {
    const dir = folder(), file = join(dir, 'job-runs.json'); writeFileSync(file, JSON.stringify([run(0), run(1)]));
    const database = new WorkflowDatabase({ dir }); close.push(() => database.close());
    const create = database.create.bind(database), changed = JSON.stringify([run(0), run(1), run(2)]); let calls = 0;
    vi.spyOn(database, 'create').mockImplementation((...args) => { const result = create(...args); if (++calls === 1) writeFileSync(file, changed); return result; });
    const store = new JobRunStore({ file, database }); close.push(() => store.close());
    expect(store.recovery.active).toBe(true); expect(database.hasRecords()).toBe(false); expect(readFileSync(file, 'utf8')).toBe(changed);
  });

  it('retains loop manual identities and historical results beyond 2,000 runs and restart without dispatch', async () => {
    const dir = folder(); writeFileSync(join(dir, 'loops.json'), JSON.stringify({ version: 3, timezone: 'UTC', state: state(), runs: Array.from({ length: 2001 }, (_, i) => loopRun(i)) }));
    const { manager, execute } = loops(dir);
    const newRun = manager.runNow('inbound-triage', { requestId: request(9999), expectedRevision: 1 }); await manager.tick();
    expect(newRun).not.toBeNull(); expect(execute).toHaveBeenCalledOnce();
    expect(manager.listRuns().some(r => r.id === 'loop-0')).toBe(false);
    const restarted = loops(dir);
    expect(restarted.manager.runNow('inbound-triage', { requestId: request(0), expectedRevision: 1 })).toMatchObject({ id: 'loop-0', status: 'completed' });
    await restarted.manager.tick(); expect(restarted.execute).not.toHaveBeenCalled();
    expect(restarted.manager.markSeen('loop-0')?.seenAt).toBe(at);
    expect(restarted.manager.history({ limit: 1 }).runs).toHaveLength(1);
    expect(() => restarted.manager.runNow('owner-letter', { requestId: request(0), expectedRevision: 1 })).toThrow(expect.objectContaining({ status: 409 }));
  });

  it('preserves a durable failed-write intent across restart instead of retrying dispatch', async () => {
    const dir = folder(), { manager, execute } = loops(dir);
    vi.spyOn(atomic, 'writeFileAtomic').mockImplementationOnce(() => { throw new Error('full disk'); });
    expect(() => manager.runNow('inbound-triage', { requestId: request(0), expectedRevision: 1 })).toThrow();
    const resumed = loops(dir); const prior = resumed.manager.runNow('inbound-triage', { requestId: request(0), expectedRevision: 1 });
    expect(prior?.status).toBe('interrupted'); await resumed.manager.tick(); expect(execute).not.toHaveBeenCalled(); expect(resumed.execute).not.toHaveBeenCalled();
  });

  it('restores permanent keys and interrupted outcomes with clock defaults off and matching file digests', () => {
    const dir = folder(), store = jobs(dir); const original = store.enqueue(recipe(), { mode: 'attended', trigger: 'manual', idempotencyKey: 'restore-key' }).run;
    const { manager } = loops(dir); manager.patchClock('owner-letter', { enabled: false });
    const database = new WorkflowDatabase({ dir }); close.push(() => database.close()); const rows = allRows(database);
    const files = Object.fromEntries(['job-runs.json', 'loops.json'].map(name => [name, readFileSync(join(dir, name), 'utf8')]));
    validateExecutionRecords(rows, files);
    const restored = restoreExecutionRecords(rows, files, { ...files, 'loops.json': JSON.stringify({ version: 3, timezone: 'UTC', state: state(), runs: [] }) }, at + 1);
    const target = folder(), targetDB = new WorkflowDatabase({ dir: target }); close.push(() => targetDB.close());
    for (const row of restored.records) targetDB.create(row.kind, row.id, row.value, null);
    for (const [name, value] of Object.entries(restored.files)) writeFileSync(join(target, name), value);
    const restarted = jobs(target);
    expect(restarted.enqueue(recipe(), { mode: 'attended', trigger: 'manual', idempotencyKey: 'restore-key' })).toMatchObject({ created: false, run: { id: original.id, status: 'interrupted' } });
    expect(loops(target).manager.listLoops().every(loop => !loop.enabled)).toBe(true);
    const receipt = restored.records.find(row => row.kind === 'execution-state' && (row.value as {stream:string}).stream === executionStream('job', 'job-runs.json'))!;
    expect((receipt.value as {currentHash:string}).currentHash).toBe(executionDigest(restored.files['job-runs.json']!));
    const missing = rows.filter(row => row.kind !== 'execution-request'); expect(() => validateExecutionRecords(missing, files)).toThrow(/recovery/);
  });
});
