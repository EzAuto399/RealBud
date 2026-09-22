import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, open, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createBackupOperationStore, type BackupOperationStore } from './private-backup-operations.ts';
import { createBackupResourceRuntime } from './private-backup-resource-runtime.ts';
import { createBackupTransferStore } from './private-backup-transfer.ts';
import type { PrivateBackupTransferOperation } from '../shared/private-backup-transfers.ts';

const roots: string[] = [], journals: BackupOperationStore[] = [], runtimes: ReturnType<typeof createBackupResourceRuntime>[] = [];
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const gate = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { release, promise }; };
async function fixture(kind: 'upload' | 'export' = 'export') {
  const root = await mkdtemp(join(realpathSync(tmpdir()), 'RealBud resource runtime Ω ')); roots.push(root);
  const key = randomBytes(32), workspaceId = randomUUID(), directory = join(root, 'private-backup-v2');
  const settings = { directory: join(directory, 'operations'), key, workspaceId };
  const journal = await createBackupOperationStore(settings); journals.push(journal);
  const runtime = createBackupResourceRuntime({ journal, directory, key }); runtimes.push(runtime);
  const id = randomUUID(), operation: PrivateBackupTransferOperation = { version: 2, id, workspaceId, kind, phase: kind === 'export' ? 'capturing' : 'uploading', createdAt: 10, updatedAt: 10, expiresAt: null,
    progress: { completedBytes: 0, totalBytes: kind === 'upload' ? 1024 * 1024 : null }, canCancel: true, requiresPassphrase: false,
    ...(kind === 'upload' ? { receivedBytes: 0, prefixCommitment: sha('[]') } : {}) };
  const record = journal.create(operation, 4 * 1024 * 1024, { trackResources: true });
  return { directory, settings, journal, runtime, key, workspaceId, id, record };
}
afterEach(async () => { vi.restoreAllMocks(); for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => {}); for (const journal of journals.splice(0)) journal.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('journal-bound backup file lifetime', () => {
  it('authenticates reopen access and discards only reversible stage scratch while preserving the review', async () => {
    const f = await fixture('upload'); const digest = sha('fixture');
    f.journal.update(f.id, f.journal.get(f.id).revision, next => {
      next.operation.phase = 'uploaded'; next.operation.receivedBytes = 1024 * 1024; next.operation.artifact = { archiveBytes: 1024 * 1024, archiveDigest: digest };
    });
    f.journal.update(f.id, f.journal.get(f.id).revision, next => { next.operation.phase = 'checking'; });
    f.journal.update(f.id, f.journal.get(f.id).revision, next => { next.operation.phase = 'reviewed'; next.operation.preview = { digest, createdAt: new Date(10).toISOString(), workspaceId: f.workspaceId, fileCount: 1, recordCount: 0, plainBytes: 1, included: [], excluded: [], restoreChanges: [] }; });
    let directory = '';
    await f.runtime.run(f.id, async work => { directory = (await work.claim('prepared', 1024 * 1024)).directory; await mkdir(directory, { mode: 0o700 }); await writeFile(join(directory, 'prepared.sqlite'), 'fixture', { mode: 0o600 }); expect(await work.access('prepared')).toBe(directory); });
    await expect(f.runtime.discard(f.id, ['upload'])).rejects.toMatchObject({ status: 409 });
    await f.runtime.discard(f.id, ['prepared', 'build']); expect(existsSync(directory)).toBe(false);
    expect(f.journal.get(f.id)).toMatchObject({ reservedBytes: f.record.reservedBytes, operation: { phase: 'reviewed' }, allocations: [{ state: 'removed' }] });
    await f.runtime.run(f.id, async work => { const claimed = await work.claim('prepared', 1024 * 1024); await mkdir(claimed.directory, { mode: 0o700 }); await writeFile(join(claimed.directory, 'prepared.sqlite'), 'fixture', { mode: 0o600 }); await unlink(join(f.directory, 'claims', `${claimed.binding.allocation.id}.json`)); await expect(work.access('prepared')).rejects.toMatchObject({ status: 503 }); });
  });

  it('continues later cleanup while preserving both untracked legacy records and unknown-file holds', async () => {
    const f = await fixture(), ids = [1, 2, 3].map(n => `00000000-0000-4000-8000-00000000000${n}`), paths: string[] = [];
    f.journal.create({ ...f.record.operation, id: ids[0] }, 17);
    const cancel = (id: string) => f.journal.update(id, f.journal.get(id).revision, next => { next.operation.phase = 'cancelled'; next.operation.canCancel = false; });
    cancel(ids[0]);
    for (const [index, id] of ids.slice(1).entries()) {
      f.journal.create({ ...f.record.operation, id }, 4096, { trackResources: true });
      await f.runtime.run(id, async context => {
        const { directory } = await context.claim('archive', 4096); paths.push(directory); await mkdir(directory, { mode: 0o700 });
        await writeFile(join(directory, 'archive.realbud-backup'), 'Fictional backup', { mode: 0o600 });
        if (index === 0) await writeFile(join(directory, 'unattributed.txt'), 'Preserve fixture', { mode: 0o600 });
      });
      cancel(id);
    }
    expect(await f.runtime.recover()).toEqual({ cleaned: 1, held: 2 });
    expect(f.journal.get(ids[0])).toMatchObject({ reservedBytes: 17 }); expect(f.journal.get(ids[0]).allocations).toBeUndefined();
    expect(f.journal.get(ids[1])).toMatchObject({ reservedBytes: 4096, allocations: [{ state: 'deleting' }] });
    expect(existsSync(join(paths[0], 'archive.realbud-backup'))).toBe(true); expect(existsSync(join(paths[0], 'unattributed.txt'))).toBe(true);
    expect(existsSync(paths[1])).toBe(false); expect(f.journal.get(ids[2]).reservedBytes).toBe(0);
  });
  it('retains a process-local fallback when the journal cannot save the failed-close hold', async () => {
    const f = await fixture(); let directory = '';
    const hold = vi.spyOn(f.journal, 'holdResourceCleanup').mockImplementation(() => { throw new Error('Fictional full journal'); });
    await expect(f.runtime.run(f.id, async context => {
      directory = (await context.claim('archive', 4096)).directory; await mkdir(directory, { mode: 0o700 });
      await writeFile(join(directory, 'archive.realbud-backup'), 'Preserve fixture', { mode: 0o600 }); context.own(() => { throw new Error('Fictional failed close'); });
    })).rejects.toThrow('full journal'); hold.mockRestore();
    await expect(f.runtime.cancel(f.id)).rejects.toThrow('could not close'); await expect(f.runtime.close()).rejects.toThrow('restart recovery'); f.journal.close();
    const journal = await createBackupOperationStore(f.settings); journals.push(journal);
    const runtime = createBackupResourceRuntime({ journal, directory: f.directory, key: f.key }); runtimes.push(runtime);
    expect(journal.get(f.id).cleanupHold).toBeUndefined();
    expect(await runtime.recover()).toEqual({ cleaned: 0, held: 1 }); expect(existsSync(directory)).toBe(true); expect(journal.usage().reservedBytes).toBe(f.record.reservedBytes);
  });
  it('drains its own in-flight ownership publication even when the task returns before awaiting it', async () => {
    const f = await fixture(); let published = false;
    await f.runtime.run(f.id, async context => { void context.claim('archive', 1024 * 1024).then(() => { published = true; }); });
    expect(published).toBe(true); expect(f.journal.get(f.id).allocations).toHaveLength(1);
    expect(await f.runtime.cancel(f.id)).toMatchObject({ reservedBytes: 0 });
  });
  it('persists cancellation before abort, waits for the actual handle close and only then removes files and releases storage', async () => {
    const f = await fixture(), ready = gate(), close = gate(); let directory = '', settled = false;
    const work = f.runtime.run(f.id, async context => {
      const claimed = await context.claim('archive', 2 * 1024 * 1024); directory = claimed.directory;
      await mkdir(directory, { mode: 0o700 }); const handle = await open(join(directory, 'archive.realbud-backup'), 'wx', 0o600);
      context.own(async () => { await close.promise; await handle.close(); });
      await handle.writeFile('Fictional archive bytes'); await handle.sync();
      await new Promise<void>(resolve => { context.signal.addEventListener('abort', () => {
        expect(f.journal.get(f.id).operation.phase).toBe('cancelled'); resolve();
      }, { once: true }); ready.release(); });
    }).catch(error => error);
    await ready.promise;
    const cancelled = f.runtime.cancel(f.id).then(value => { settled = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false); expect(f.journal.usage().reservedBytes).toBe(f.record.reservedBytes);
    expect(existsSync(join(directory, 'archive.realbud-backup'))).toBe(true);
    close.release(); expect(await work).toBeInstanceOf(Error);
    expect(await cancelled).toMatchObject({ reservedBytes: 0, allocations: [{ state: 'removed' }] });
    expect(existsSync(directory)).toBe(false); expect(f.journal.usage().reservedBytes).toBe(0);
    expect(await f.runtime.cancel(f.id)).toMatchObject({ reservedBytes: 0 });
  });
  it('preserves all files and the reservation on an unknown file; verified cleanup can resume after operator recovery', async () => {
    const f = await fixture(); let directory = '';
    await f.runtime.run(f.id, async context => {
      directory = (await context.claim('archive', 1024 * 1024)).directory; await mkdir(directory, { mode: 0o700 });
      await writeFile(join(directory, 'archive.realbud-backup'), 'Fictional archive', { mode: 0o600 });
      await writeFile(join(directory, 'unattributed.txt'), 'Preserve fixture', { mode: 0o600 });
    });
    await expect(f.runtime.cancel(f.id)).rejects.toThrow('unexpected');
    expect(f.journal.get(f.id)).toMatchObject({ reservedBytes: f.record.reservedBytes, allocations: [{ state: 'deleting' }] });
    expect(await readFile(join(directory, 'archive.realbud-backup'), 'utf8')).toBe('Fictional archive');
    await f.runtime.close(); f.journal.close();
    const journal = await createBackupOperationStore(f.settings); journals.push(journal);
    const runtime = createBackupResourceRuntime({ journal, directory: f.directory, key: f.key }); runtimes.push(runtime);
    expect(await runtime.recover()).toEqual({ cleaned: 0, held: 1 }); expect(journal.usage().reservedBytes).toBe(f.record.reservedBytes);
    await unlink(join(directory, 'unattributed.txt')); // Test fixture simulates explicit local recovery.
    expect(await runtime.recover()).toEqual({ cleaned: 1, held: 0 }); expect(journal.usage().reservedBytes).toBe(0); expect(existsSync(directory)).toBe(false);
  });
  it('retains a failed-close hold even when a new journal and runtime open in the same process', async () => {
    const f = await fixture(); let directory = '';
    await expect(f.runtime.run(f.id, async context => {
      directory = (await context.claim('archive', 1024 * 1024)).directory; await mkdir(directory, { mode: 0o700 });
      await writeFile(join(directory, 'archive.realbud-backup'), 'Retained fixture', { mode: 0o600 }); context.own(() => { throw undefined; });
    })).rejects.toThrow('could not close');
    await expect(f.runtime.cancel(f.id)).rejects.toThrow('could not close');
    expect(existsSync(directory)).toBe(true); expect(f.journal.usage().reservedBytes).toBe(f.record.reservedBytes);
    await expect(f.runtime.close()).rejects.toThrow('restart recovery'); f.journal.close();
    const journal = await createBackupOperationStore(f.settings); journals.push(journal);
    const runtime = createBackupResourceRuntime({ journal, directory: f.directory, key: f.key }); runtimes.push(runtime);
    expect(await runtime.recover()).toEqual({ cleaned: 0, held: 0 }); expect(journal.usage().reservedBytes).toBe(f.record.reservedBytes);
    expect(journal.get(f.id).cleanupHold).toEqual({ pid: process.pid }); expect(existsSync(directory)).toBe(true);
    await expect(runtime.cancel(f.id)).rejects.toThrow('could not close');
    expect(() => journal.update(f.id, journal.get(f.id).revision, next => { delete next.cleanupHold; })).toThrow('process-exit');
  });
  it('keeps a real failed-close writer held after it releases the journal, then cleans only after its process exits', async () => {
    const f = await fixture(); await f.runtime.close(); f.journal.close();
    const program = `import {createBackupOperationStore} from ${JSON.stringify(new URL('./private-backup-operations.ts', import.meta.url).href)};
      import {createBackupResourceRuntime} from ${JSON.stringify(new URL('./private-backup-resource-runtime.ts', import.meta.url).href)};
      import {mkdir,open} from 'node:fs/promises';import {join} from 'node:path';
      let text='';for await(const c of process.stdin)text+=c;const v=JSON.parse(text),key=Buffer.from(v.key,'hex');
      const journal=await createBackupOperationStore({...v.settings,key}),runtime=createBackupResourceRuntime({journal,directory:v.directory,key});let held;
      await runtime.run(v.id,async c=>{const a=await c.claim('archive',1048576);await mkdir(a.directory,{mode:448});held=await open(join(a.directory,'archive.realbud-backup'),'wx',384);c.own(()=>{throw new Error('Fictional failed close');});await held.writeFile('Retained live-writer fixture');await held.sync();}).catch(()=>{});
      await runtime.cancel(v.id).catch(()=>{});await runtime.close().catch(()=>{});journal.close();
      process.stdout.write('ready\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);await held.close();`;
    const envModule: string = '../scripts/service-smoke-env.mjs'; const { serviceSmokeEnv } = await import(envModule);
    const child = spawn(process.execPath, ['--input-type=module', '-e', program], { env: serviceSmokeEnv({ executable: process.execPath, home: f.directory, data: f.directory, scratch: f.directory, port: 0 }), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', errors = '', timer: ReturnType<typeof setTimeout> | undefined;
    const closed = new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject); });
    child.stderr.on('data', c => { errors = (errors + c).slice(-1000); });
    const ready = new Promise<void>((resolve, reject) => { timer = setTimeout(() => reject(new Error(`Writer did not initialize: ${errors}`)), 5000); child.stdout.on('data', c => { out = (out + c).slice(-100); if (out.includes('ready')) resolve(); }); void closed.then(() => reject(new Error(`Writer exited: ${errors}`)), reject); });
    child.stdin.end(JSON.stringify({ settings: { directory: f.settings.directory, workspaceId: f.workspaceId }, key: f.key.toString('hex'), directory: f.directory, id: f.id }));
    try {
      await ready; clearTimeout(timer);
      const journal = await createBackupOperationStore(f.settings); journals.push(journal);
      const runtime = createBackupResourceRuntime({ journal, directory: f.directory, key: f.key }); runtimes.push(runtime);
      expect(journal.get(f.id).cleanupHold).toEqual({ pid: child.pid });
      expect(await runtime.recover()).toEqual({ cleaned: 0, held: 0 }); expect(journal.usage().reservedBytes).toBe(f.record.reservedBytes);
      const allocation = journal.get(f.id).allocations![0], directory = join(f.directory, 'exports', allocation.id);
      expect(existsSync(join(directory, 'archive.realbud-backup'))).toBe(true);
      child.kill('SIGKILL'); await closed;
      expect(await runtime.recover()).toEqual({ cleaned: 1, held: 0 }); expect(existsSync(directory)).toBe(false); expect(journal.usage().reservedBytes).toBe(0);
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; }
  }, 15_000);
  it('resumes an actual ciphertext transfer after reopen and cleans its journal and bytes on cancellation', async () => {
    const f = await fixture('upload'), bytes = randomBytes(1024 * 1024); let directory = '';
    await f.runtime.run(f.id, async context => {
      directory = (await context.claim('upload', 2 * 1024 * 1024)).directory;
      const transfer = await createBackupTransferStore({ directory, key: f.key, workspaceId: f.workspaceId }); context.own(() => transfer.close());
      await transfer.start(f.id, bytes.length); await transfer.append(f.id, 0, bytes, sha(bytes));
    });
    await f.runtime.close(); f.journal.close();
    const journal = await createBackupOperationStore(f.settings); journals.push(journal);
    const runtime = createBackupResourceRuntime({ journal, directory: f.directory, key: f.key }); runtimes.push(runtime);
    expect(await runtime.recover()).toEqual({ cleaned: 0, held: 0 }); expect(existsSync(directory)).toBe(true);
    await runtime.run(f.id, async context => {
      expect(await context.claim('upload', 2 * 1024 * 1024)).toMatchObject({ existing: true, directory });
      const transfer = await createBackupTransferStore({ directory: context.path('upload'), key: f.key, workspaceId: f.workspaceId }); context.own(() => transfer.close());
      expect(await transfer.status(f.id)).toMatchObject({ offset: bytes.length, size: bytes.length });
    });
    await runtime.cancel(f.id); expect(existsSync(directory)).toBe(false); expect(journal.usage().reservedBytes).toBe(0);
  });
  it('cancels a new operation with no allocated files and refuses work after closing', async () => {
    const f = await fixture(); expect(await f.runtime.cancel(f.id)).toMatchObject({ reservedBytes: 0 });
    await expect(f.runtime.run(f.id, async () => {})).rejects.toThrow('closed');
    await f.runtime.close(); await expect(f.runtime.cancel(f.id)).rejects.toThrow('closing');
  });
});
