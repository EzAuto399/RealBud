import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { PrivateBackupPreparedStore } from './private-backup-prepared.ts';
import { stagePrivateRestoreV2, applyStagedPrivateRestoreV2, PRIVATE_RESTORE_V2_STAGE_FILE } from './private-backup-cold-restore.ts';
import { PRIVATE_RESTORE_STAGE_FILE, PRIVATE_RESTORE_RECEIPT_FILE } from './private-workspace-backup.ts';
import { parsePrivateRestoreReceipt, type PrivateBackupReceipt } from '../shared/private-workspace-backup.ts';
import { createBackupOperationStore } from './private-backup-operations.ts';
import { PRIVATE_BACKUP_COMPLETION_FILE, readBackupColdCompletion } from './private-backup-completion.ts';
import type { PrivateBackupTransferOperation } from '../shared/private-backup-transfers.ts';

const roots: string[] = [], stores: PrivateBackupPreparedStore[] = [];
const sha = (v: Uint8Array | string) => createHash('sha256').update(v).digest('hex');
function write(root: string, path: string, bytes: Uint8Array | string) { mkdirSync(dirname(join(root, path)), { recursive: true, mode: 0o700 }); writeFileSync(join(root, path), bytes, { mode: 0o600 }); }
async function* input(bytes: Buffer) { for (let offset = 0; offset < bytes.length; offset += 509) yield bytes.subarray(offset, offset + 509); }
async function fixture() {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'RealBud cold restore Ω ')); roots.push(directory);
  const key = randomBytes(32), workspaceId = randomUUID(), directoryId = randomUUID();
  const oldIdentity = JSON.stringify({ version: 1, id: randomUUID(), workerMemberKey: null });
  const nextIdentity = JSON.stringify({ version: 1, id: workspaceId, workerMemberKey: null });
  write(directory, 'company-installation/workspace.json', oldIdentity);
  write(directory, 'vault/USER.md', 'Fictional untouched fixture');
  write(directory, 'vault/README.md', 'Fictional removable fixture');
  const parent = join(directory, 'private-backup-v2', 'prepared'); mkdirSync(parent, { recursive: true, mode: 0o700 });
  const prepared = await PrivateBackupPreparedStore.create({ directory: join(parent, directoryId), key, workspaceId }); stores.push(prepared);
  const expected = new Map([
    ['company-installation/workspace.json', Buffer.from(nextIdentity)],
    ['vault/USER.md', Buffer.from('\uFEFFFictional exact café 🏡\r\n  unfinished  ')],
    ['vault/workflow-inputs/bank.csv', Buffer.from('\uFEFFDate,Reference\r\n2026-09-21,00012\r\n')],
  ]);
  for (const [path, bytes] of expected) await prepared.addFile(path, existsSync(join(directory, path)) ? sha(readFileSync(join(directory, path))) : null, input(bytes));
  await prepared.addRemoval('vault/README.md', sha('Fictional removable fixture'));
  const summary = await prepared.seal(); await prepared.close();
  const receipt: PrivateBackupReceipt = { digest: sha('Fictional encrypted uploaded archive'), createdAt: '2026-09-21T00:00:00.000Z', workspaceId, fileCount: 3, recordCount: 0, plainBytes: [...expected.values()].reduce((n, b) => n + b.length, 0), included: ['Private fixture files'], excluded: ['Credentials'], restoreChanges: ['Review work'] };
  const options = { directory, key, directoryId, storeId: summary.storeId, workspaceId, expectedPreparedDigest: summary.digest, receipt, assertFresh: () => {}, assertIdle: () => {}, epoch: () => 'fixture-idle' };
  return { directory, key, prepared, expected, options, receipt };
}
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.close(); for (const directory of roots.splice(0)) rmSync(directory, { force: true, recursive: true }); });

describe('bounded cold private restore coordination', () => {
  it('publishes authenticated operation completion only after exact cold application and reconciles the restored identity', async () => {
    const f = await fixture(), previousWorkspaceId = JSON.parse(readFileSync(join(f.directory, 'company-installation/workspace.json'), 'utf8')).id as string;
    const settings = { directory: join(f.directory, 'private-backup-v2', 'operations'), key: f.key, workspaceId: previousWorkspaceId };
    const journal = await createBackupOperationStore(settings), operationId = randomUUID();
    const initial: PrivateBackupTransferOperation = { version: 2, id: operationId, workspaceId: previousWorkspaceId, kind: 'upload', phase: 'uploading', createdAt: 10, updatedAt: 10,
      expiresAt: null, progress: { completedBytes: 0, totalBytes: 123 }, receivedBytes: 0, prefixCommitment: sha('[]'), canCancel: true, requiresPassphrase: false };
    let record = journal.create(initial, 100);
    record = journal.update(operationId, record.revision, r => { r.operation.phase = 'uploaded'; r.operation.receivedBytes = 123; r.operation.progress.completedBytes = 123;
      r.operation.artifact = { archiveBytes: 123, archiveDigest: f.receipt.digest }; });
    record = journal.update(operationId, record.revision, r => { r.operation.phase = 'checking'; });
    record = journal.update(operationId, record.revision, r => { r.operation.phase = 'reviewed'; r.operation.preview = f.receipt;
      r.references.preview = { directoryId: randomUUID(), catalogId: randomUUID(), workspaceId: f.options.workspaceId, digest: sha('fixture logical catalog'), createdAt: f.receipt.createdAt, databasePresent: false }; });
    record = journal.update(operationId, record.revision, r => { r.operation.phase = 'staging'; r.operation.canCancel = false; r.restoreHeld = true;
      r.references.prepared = { directoryId: f.options.directoryId, storeId: f.options.storeId, workspaceId: f.options.workspaceId, digest: f.options.expectedPreparedDigest }; });
    journal.close();
    const options = { ...f.options, operation: { operationId, previousWorkspaceId } };
    await expect(stagePrivateRestoreV2({ ...options, operation: { operationId, previousWorkspaceId: randomUUID() } })).rejects.toThrow();
    expect(existsSync(join(f.directory, PRIVATE_RESTORE_V2_STAGE_FILE))).toBe(false);
    await stagePrivateRestoreV2(options);
    await expect(stagePrivateRestoreV2({ ...options, operation: { operationId: randomUUID(), previousWorkspaceId } })).rejects.toThrow(/different restore/);
    await expect(applyStagedPrivateRestoreV2({ ...options, afterWrite() { throw new Error('Fixture interrupted publication'); } })).rejects.toThrow(/interrupted publication/);
    const applyingStage = readFileSync(join(f.directory, PRIVATE_RESTORE_V2_STAGE_FILE));
    expect(existsSync(join(f.directory, PRIVATE_BACKUP_COMPLETION_FILE))).toBe(false);
    await expect(readBackupColdCompletion(f.directory, f.key, f.options.workspaceId)).rejects.toThrow(/verified cold/);
    await applyStagedPrivateRestoreV2(options);
    // Recreate the exact durable state of a kill after completion publication
    // but before stage removal. Replay must keep the original completion bytes.
    const publishedProof = readFileSync(join(f.directory, PRIVATE_BACKUP_COMPLETION_FILE));
    write(f.directory, PRIVATE_RESTORE_V2_STAGE_FILE, applyingStage);
    await applyStagedPrivateRestoreV2(options);
    expect(readFileSync(join(f.directory, PRIVATE_BACKUP_COMPLETION_FILE))).toEqual(publishedProof);
    const completion = await readBackupColdCompletion(f.directory, f.key, f.options.workspaceId);
    expect(completion.proof).toMatchObject({ operationId, previousWorkspaceId, workspaceId: f.options.workspaceId, preparedDigest: f.options.expectedPreparedDigest, receipt: f.receipt });
    completion.assertCurrent();
    const bytes = readFileSync(join(f.directory, PRIVATE_BACKUP_COMPLETION_FILE));
    expect(bytes.includes(f.key)).toBe(false); expect(bytes.includes(Buffer.from(operationId))).toBe(false);
    await expect(stagePrivateRestoreV2({ ...options, operation: { operationId: randomUUID(), previousWorkspaceId: f.options.workspaceId } })).rejects.toThrow(/previous restore/);
    expect(readFileSync(join(f.directory, PRIVATE_BACKUP_COMPLETION_FILE))).toEqual(bytes);
    const reopened = await createBackupOperationStore({ ...settings, workspaceId: f.options.workspaceId, restoreDirectory: f.directory });
    try {
      expect(reopened.list()).toEqual({ items: [], total: 0, next: null });
      expect(reopened.usage()).toMatchObject({ records: 1, active: 0, reservedBytes: 100 });
      expect(() => reopened.get(operationId)).toThrow(/not found/);
      expect(existsSync(join(f.directory, PRIVATE_BACKUP_COMPLETION_FILE))).toBe(false);
      for (const [path, expected] of f.expected) expect(readFileSync(join(f.directory, path))).toEqual(expected);
    } finally { reopened.close(); }
  });

  it.each(['created', 'initializing'] as const)('recovers the empty mutex after a real process kill while its lock is %s', async point => {
    const f = await fixture();
    const program = `import { stagePrivateRestoreV2 } from ${JSON.stringify(new URL('./private-backup-cold-restore.ts', import.meta.url).href)}; let text=''; for await(const chunk of process.stdin) text+=chunk; const { key, point, ...options }=JSON.parse(text); await stagePrivateRestoreV2({...options,key:Buffer.from(key,'hex'),assertIdle(){},assertFresh(){},epoch(){return 'fixture';},lockFault(at){if(at===point){process.stdout.write('initializing\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}}});`;
    const envModule: string = '../scripts/service-smoke-env.mjs'; const { serviceSmokeEnv } = await import(envModule);
    const child = spawn(process.execPath, ['--input-type=module', '-e', program], { env: serviceSmokeEnv({ executable: process.execPath, home: f.directory, data: f.directory, scratch: f.directory, port: 0 }), stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '', timer: ReturnType<typeof setTimeout> | undefined;
    const closed = new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject); });
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2000); });
    const ready = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Fixture lock did not initialize: ${errors}`)), 5000);
      child.stdout.on('data', chunk => { output = (output + chunk).slice(-100); if (output.includes('initializing\n')) resolve(); });
      void closed.then(() => reject(new Error(`Fixture lock exited: ${errors}`)), reject);
    });
    child.stdin.end(JSON.stringify({ ...f.options, key: f.key.toString('hex'), point }));
    try { await ready; }
    finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; }
    await stagePrivateRestoreV2(f.options); await applyStagedPrivateRestoreV2(f.options);
    for (const [path, expected] of f.expected) expect(readFileSync(join(f.directory, path))).toEqual(expected);
  }, 15_000);
  it.each(['stage', 'apply'] as const)('releases the real process lock after a killed %s owner and preserves retry evidence', async phase => {
    const f = await fixture();
    if (phase === 'apply') await stagePrivateRestoreV2(f.options);
    const program = `
      import { stagePrivateRestoreV2, applyStagedPrivateRestoreV2 } from ${JSON.stringify(new URL('./private-backup-cold-restore.ts', import.meta.url).href)};
      import { PrivateBackupPreparedStore } from ${JSON.stringify(new URL('./private-backup-prepared.ts', import.meta.url).href)};
      let text = ''; for await (const chunk of process.stdin) text += chunk;
      const input = JSON.parse(text), options = { ...input.options, key: Buffer.from(input.key, 'hex'), assertFresh() {}, assertIdle() {}, epoch: () => 'fixture-idle' };
      const locked = () => { process.stdout.write('locked\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };
      if (input.phase === 'stage') { PrivateBackupPreparedStore.prototype.validate = async () => locked(); await stagePrivateRestoreV2(options); }
      else await applyStagedPrivateRestoreV2({ ...options, afterWrite: locked });
    `;
    const envModule: string = '../scripts/service-smoke-env.mjs'; const { serviceSmokeEnv } = await import(envModule);
    const child = spawn(process.execPath, ['--input-type=module', '-e', program], { env: serviceSmokeEnv({ executable: process.execPath, home: f.directory, data: f.directory, scratch: f.directory, port: 0 }), stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    const closed = new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject); });
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Fixture restore owner did not acquire its lock: ${errors}`)), 5000);
      child.stdout.on('data', chunk => { output = (output + chunk).slice(-100); if (output.includes('locked\n')) resolve(); });
      void closed.then(() => reject(new Error(`Fixture restore owner exited before signalling: ${errors}`)), reject);
    });
    const { key: _key, ...options } = f.options;
    child.stdin.end(JSON.stringify({ phase, key: f.key.toString('hex'), options }));
    try {
      await ready;
      await expect(stagePrivateRestoreV2(f.options)).rejects.toThrow(/Another process/);
      if (phase === 'stage') expect(existsSync(join(f.directory, PRIVATE_RESTORE_V2_STAGE_FILE))).toBe(false);
      else expect(existsSync(join(f.directory, PRIVATE_RESTORE_V2_STAGE_FILE))).toBe(true);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
    if (phase === 'stage') await stagePrivateRestoreV2(f.options);
    await expect(applyStagedPrivateRestoreV2(f.options)).resolves.toMatchObject({ restored: true });
    for (const [path, bytes] of f.expected) expect(readFileSync(join(f.directory, path))).toEqual(bytes);
    expect(existsSync(join(f.directory, 'vault/README.md'))).toBe(false);
  }, 15_000);

  it('holds competing stage writers until the owning operation finishes', async () => {
    const f = await fixture(), validate = PrivateBackupPreparedStore.prototype.validate;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(PrivateBackupPreparedStore.prototype, 'validate').mockImplementationOnce(async function (this: PrivateBackupPreparedStore, options) { entered(); await gate; return validate.call(this, options); });
    const owner = stagePrivateRestoreV2(f.options); await started;
    try { await expect(stagePrivateRestoreV2(f.options)).rejects.toThrow(/Another process/); }
    finally { release(); }
    await owner;
    await expect(applyStagedPrivateRestoreV2(f.options)).resolves.toMatchObject({ restored: true });
  });
  it('stages without replacing business files, applies exact bytes, then records completion once', async () => {
    const f = await fixture(), original = readFileSync(join(f.directory, 'vault/USER.md'));
    expect(await stagePrivateRestoreV2(f.options)).toEqual({ needsRestart: true, receipt: f.receipt });
    expect(readFileSync(join(f.directory, 'vault/USER.md'))).toEqual(original);
    expect(await stagePrivateRestoreV2(f.options)).toEqual({ needsRestart: true, receipt: f.receipt });
    expect(await applyStagedPrivateRestoreV2(f.options)).toEqual({ restored: true, receipt: f.receipt });
    for (const [path, bytes] of f.expected) expect(readFileSync(join(f.directory, path))).toEqual(bytes);
    expect(existsSync(join(f.directory, 'vault/README.md'))).toBe(false);
    expect(existsSync(join(f.directory, PRIVATE_RESTORE_V2_STAGE_FILE))).toBe(false);
    const completed = parsePrivateRestoreReceipt(JSON.parse(readFileSync(join(f.directory, PRIVATE_RESTORE_RECEIPT_FILE), 'utf8')));
    expect(completed?.receipt).toEqual(f.receipt);
    expect(await applyStagedPrivateRestoreV2(f.options)).toEqual({ restored: false });
  });

  it.each([1, 2, 3, 4])('resumes exact intended files after interruption following replacement/removal %i', async count => {
    const f = await fixture(); await stagePrivateRestoreV2(f.options); let writes = 0;
    await expect(applyStagedPrivateRestoreV2({ ...f.options, afterWrite() { if (++writes === count) throw new Error('fixture interrupted'); } })).rejects.toThrow('fixture interrupted');
    expect(existsSync(join(f.directory, PRIVATE_RESTORE_V2_STAGE_FILE))).toBe(true);
    await expect(applyStagedPrivateRestoreV2(f.options)).resolves.toMatchObject({ restored: true });
    for (const [path, bytes] of f.expected) expect(readFileSync(join(f.directory, path))).toEqual(bytes);
    expect(existsSync(join(f.directory, 'vault/README.md'))).toBe(false);
  });

  it.each(['edited target', 'new business file', 'configuration', 'membership', 'database journal'])('holds the entire application before writes for %s', async attack => {
    const f = await fixture(); await stagePrivateRestoreV2(f.options);
    const attacks = { 'edited target': 'vault/USER.md', 'new business file': 'vault/decisions/new.md', configuration: 'config.json', membership: 'company-installation/seat.json', 'database journal': 'workflow-state.sqlite-journal' };
    write(f.directory, attacks[attack as keyof typeof attacks], 'Fictional unexpected change');
    const first = readFileSync(join(f.directory, 'company-installation/workspace.json'));
    await expect(applyStagedPrivateRestoreV2(f.options)).rejects.toThrow();
    expect(readFileSync(join(f.directory, 'company-installation/workspace.json'))).toEqual(first);
    expect(existsSync(join(f.directory, PRIVATE_RESTORE_V2_STAGE_FILE))).toBe(true);
  });

  it('preserves a target changed while its replacement stream was being written', async () => {
    const f = await fixture(); await stagePrivateRestoreV2(f.options);
    const read = PrivateBackupPreparedStore.prototype.readFile;
    vi.spyOn(PrivateBackupPreparedStore.prototype, 'readFile').mockImplementation(async function* (this: PrivateBackupPreparedStore, path: string, options) {
      yield* read.call(this, path, options);
      if (path === 'vault/USER.md') write(f.directory, path, 'Fictional concurrent edit');
    });
    await expect(applyStagedPrivateRestoreV2(f.options)).rejects.toThrow(/changed/);
    expect(readFileSync(join(f.directory, 'vault/USER.md'), 'utf8')).toBe('Fictional concurrent edit');
  });

  it('rejects changed prepared identity, occupied targets and conflicting legacy staging', async () => {
    const f = await fixture();
    await expect(stagePrivateRestoreV2({ ...f.options, expectedPreparedDigest: '0'.repeat(64) })).rejects.toThrow();
    await expect(stagePrivateRestoreV2({ ...f.options, assertFresh() { throw new Error('occupied'); } })).rejects.toThrow('occupied');
    expect(existsSync(join(f.directory, PRIVATE_RESTORE_V2_STAGE_FILE))).toBe(false);
    write(f.directory, PRIVATE_RESTORE_STAGE_FILE, 'Fictional other stage');
    await expect(stagePrivateRestoreV2(f.options)).rejects.toThrow(/already staged/);
  });

  it('keeps staged evidence and targets when the destination key is unavailable or wrong', async () => {
    const f = await fixture(); await stagePrivateRestoreV2(f.options);
    const before = readFileSync(join(f.directory, PRIVATE_RESTORE_V2_STAGE_FILE));
    await expect(applyStagedPrivateRestoreV2({ directory: f.directory, key: randomBytes(32) })).rejects.toThrow(/recovery/);
    expect(readFileSync(join(f.directory, PRIVATE_RESTORE_V2_STAGE_FILE))).toEqual(before);
    expect(readFileSync(join(f.directory, 'vault/USER.md'), 'utf8')).toBe('Fictional untouched fixture');
  });
});
