Read-only final targeted check as Grok 4.6 xhigh. No tools, no file edits. Return at most 700 words, with PASS/FAIL on exactly these two prior findings and any concrete blocker to them. Do not expand into a new whole-system audit. (1) A pending encrypted cold completion cannot be overwritten by another v2 restore; matching replay reuses original proof bytes; the journal durably ingests first then consumes proof; a real kill after commit before consume can reopen under the new identity and consume without a duplicate revision or reservation release. (2) Restore-lock empty initialization cannot permanently strand recovery: the file contains only an information-free SQLite mutex, never journal or business records; empty first creation is initialized under BEGIN IMMEDIATE and committed before applying, unknown nonempty schema remains held. Existing active lock still excludes other processes. Tests now pass 87 focused checks including actual process kills at both mutex initialization points, journal completion commit, active journal owner and operation-journal publication. The preserved-applying-stage replay test was added after those 87 and will run in the full gate. Cold coordinator and UI are still unwired: do not claim release. The code is below.

## server/private-backup-completion.ts
```ts
/** Installation-key-authenticated cold completion, never archive-supplied.
 * The public historical receipt alone cannot authorize a workspace rebind. */
import { lstatSync, unlinkSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join, parse, resolve } from 'node:path';
import { decryptJson, isEncryptedEnvelope } from './desk-crypto.ts';
import { windowsFilePrivacy } from './windows-file-privacy.ts';
import { fsyncDir } from './atomic.ts';
import { parsePrivateBackupReceipt, type PrivateBackupReceipt } from '../shared/private-workspace-backup.ts';
import { privateBackupTransferId, privateBackupTransferDigest } from '../shared/private-backup-transfers.ts';

export const PRIVATE_BACKUP_COMPLETION_FILE = 'private-workspace-restore-v2-completion.json';
export interface BackupRestoreBinding { operationId: string; previousWorkspaceId: string }
export interface BackupColdCompletion extends BackupRestoreBinding {
  version: 1; workspaceId: string; directoryId: string; storeId: string; preparedDigest: string;
  receipt: PrivateBackupReceipt; restoredAt: string;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function validBackupRestoreBinding(v: unknown): v is BackupRestoreBinding {
  return object(v) && Object.keys(v).sort().join(',') === 'operationId,previousWorkspaceId' && privateBackupTransferId(v.operationId) && privateBackupTransferId(v.previousWorkspaceId);
}
export function parseBackupColdCompletion(v: unknown): BackupColdCompletion | null {
  if (!object(v) || Object.keys(v).sort().join(',') !== 'directoryId,operationId,preparedDigest,previousWorkspaceId,receipt,restoredAt,storeId,version,workspaceId' || v.version !== 1 ||
      !['directoryId', 'operationId', 'previousWorkspaceId', 'storeId', 'workspaceId'].every(k => privateBackupTransferId(v[k])) || !privateBackupTransferDigest(v.preparedDigest) ||
      typeof v.restoredAt !== 'string' || !Number.isFinite(Date.parse(v.restoredAt)) || new Date(v.restoredAt).toISOString() !== v.restoredAt) return null;
  const receipt = parsePrivateBackupReceipt(v.receipt);
  return receipt && receipt.workspaceId === v.workspaceId ? { ...v, receipt } as unknown as BackupColdCompletion : null;
}
function hold(): never { throw Object.assign(new Error('Backup workspace reconciliation needs verified cold-restore evidence. Existing files were preserved.'), { status: 503 }); }
async function smallPrivateFile(path: string) {
  const absolute = resolve(path), root = parse(absolute).root; let current = root;
  const identities: { path: string; ino: number; dev: number }[] = [];
  for (const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean).slice(0, -1)) {
    current = join(current, part); const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) hold(); identities.push({ path: current, ino: stat.ino, dev: stat.dev });
  }
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024 || process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid?.())) hold();
  await windowsFilePrivacy(path, 'file');
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat(); if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size || opened.nlink !== 1) hold();
    const bytes = await handle.readFile(); if (bytes.length !== stat.size) hold();
    const assertCurrent = () => {
      for (const parent of identities) { const actual = lstatSync(parent.path); if (!actual.isDirectory() || actual.isSymbolicLink() || actual.ino !== parent.ino || actual.dev !== parent.dev) hold(); }
      const actual = lstatSync(path);
      if (!actual.isFile() || actual.isSymbolicLink() || actual.nlink !== 1 || actual.ino !== stat.ino || actual.dev !== stat.dev || actual.size !== stat.size || actual.mtimeMs !== stat.mtimeMs || actual.ctimeMs !== stat.ctimeMs) hold();
    };
    assertCurrent(); return { bytes, assertCurrent };
  } finally { await handle.close(); }
}
/** Verifies a journal's cold completion, including same-workspace restoration.
 * The caller holds its SQL owner transition
 * and invokes assertCurrent again immediately before committing reconciliation. */
export async function readBackupColdCompletion(directory: string, key: Buffer, workspaceId: string) {
  try {
    if (!Buffer.isBuffer(key) || key.length !== 32 || !privateBackupTransferId(workspaceId)) hold();
    const completion = await readBackupColdCompletionProof(directory, key), proof = completion?.proof;
    if (!proof || proof.workspaceId !== workspaceId) hold();
    const workspace = await verifyBackupWorkspaceIdentity(directory, workspaceId);
    const assertCurrent = () => {
      completion!.assertCurrent(); workspace.assertCurrent();
      for (const name of ['private-workspace-restore.json', 'private-workspace-restore-v2.json']) {
        try { lstatSync(join(directory, name)); hold(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    };
    assertCurrent(); return { proof, assertCurrent, consume() { assertCurrent(); unlinkSync(join(directory, PRIVATE_BACKUP_COMPLETION_FILE)); fsyncDir(directory); } };
  } catch { return hold(); }
}

/** Cold apply can inspect the proof while its own stage still exists. It may
 * only reuse that exact proof on replay, never replace a previous operation's. */
export async function readBackupColdCompletionProof(directory: string, key: Buffer) {
  try {
    if (!Buffer.isBuffer(key) || key.length !== 32) hold();
    const file = await smallPrivateFile(join(directory, PRIVATE_BACKUP_COMPLETION_FILE));
    const envelope: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes));
    if (!isEncryptedEnvelope(envelope)) hold();
    const proof = parseBackupColdCompletion(decryptJson(key, envelope)); if (!proof) hold();
    return { proof, assertCurrent: file.assertCurrent };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; return hold(); }
}

export async function verifyBackupWorkspaceIdentity(directory: string, workspaceId: string) {
  const workspace = await smallPrivateFile(join(directory, 'company-installation/workspace.json'));
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(workspace.bytes));
  if (!privateBackupTransferId(workspaceId) || !object(value) || Object.keys(value).sort().join(',') !== 'id,version,workerMemberKey' || value.version !== 1 || value.id !== workspaceId ||
      !(value.workerMemberKey === null || typeof value.workerMemberKey === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.workerMemberKey))) hold();
  return workspace;
}

```


## server/private-backup-cold-restore.ts
```ts
/** Cold restore coordinator. Only internally prepared artifacts are accepted;
 * this module never opens an uploaded database or retains an archive password.
 * Invoke apply before application stores, clocks or bridges are imported. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { encryptJson, decryptJson, isEncryptedEnvelope } from './desk-crypto.ts';
import { fsyncDir } from './atomic.ts';
import { windowsFilePrivacy } from './windows-file-privacy.ts';
import { PrivateBackupPreparedStore } from './private-backup-prepared.ts';
import { privateBackupTargetPaths, privateBackupTargetGuard } from './private-backup-capture.ts';
import { PRIVATE_RESTORE_STAGE_FILE, PRIVATE_RESTORE_RECEIPT_FILE } from './private-workspace-backup.ts';
import { parsePrivateBackupReceipt, type PrivateBackupReceipt } from '../shared/private-workspace-backup.ts';
import { PRIVATE_BACKUP_COMPLETION_FILE, validBackupRestoreBinding, parseBackupColdCompletion, readBackupColdCompletionProof, verifyBackupWorkspaceIdentity, type BackupRestoreBinding } from './private-backup-completion.ts';

export const PRIVATE_RESTORE_V2_STAGE_FILE = 'private-workspace-restore-v2.json';
const MAX_STAGE = 64 * 1024;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
interface Stage {
  version: 2; state: 'staged' | 'applying'; directoryId: string; storeId: string;
  workspaceId: string; preparedDigest: string; targetGuard: string; receipt: PrivateBackupReceipt;
  operation?: BackupRestoreBinding;
}
type ManifestEntry = { path: string; beforeHash: string | null; intendedHash: string | null; bytes: number };
function hold(message = 'The prepared restore needs recovery. Startup is held and existing files are preserved.'): never {
  throw Object.assign(new Error(message), { status: 503 });
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
async function parents(path: string): Promise<void> {
  const absolute = resolve(path), root = parse(absolute).root; let current = root;
  for (const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    try { const s = await lstat(current); if (!s.isDirectory() || s.isSymbolicLink()) hold(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
async function fileHandle(path: string) {
  await parents(dirname(path));
  let before;
  try { before = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) hold();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { const after = await handle.stat(); if (after.ino !== before.ino || after.dev !== before.dev || after.nlink !== 1) hold(); return handle; }
  catch (error) { await handle.close(); throw error; }
}
/** SQLite's process-owned write lock is released by the OS after a crash. There
 * is no timeout-based takeover of another live restore writer. */
type LockFault = (point: 'created' | 'initializing') => void;
async function withRestoreLock<T>(directory: string, work: () => Promise<T>, fault?: LockFault): Promise<T> {
  const folder = join(resolve(directory), 'private-backup-v2'); await parents(folder);
  const created = await mkdir(folder, { recursive: true, mode: 0o700 }), folderStat = await lstat(folder);
  if (process.platform !== 'win32' && ((folderStat.mode & 0o077) || folderStat.uid !== process.getuid?.())) hold();
  await windowsFilePrivacy(folder, 'directory', created !== undefined);
  const path = join(folder, 'restore-lock.sqlite'); let first = false;
  try { const handle = await open(path, 'wx', 0o600); await handle.close(); first = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024 || process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid?.())) hold();
  await windowsFilePrivacy(path, 'file', first);
  if (first) fault?.('created');
  const db = new DatabaseSync(path); let locked = false;
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0; PRAGMA synchronous=FULL;');
    try { db.exec('BEGIN IMMEDIATE'); locked = true; }
    catch { hold('Another process is preparing or applying a private restore. Wait for it to finish before retrying.'); }
    let schema = db.prepare("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 2").all();
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    // This file contains only an OS-released mutex, never operation history or
    // recovery records. An empty first creation can be initialized under the
    // actual SQLite lock; unknown nonempty files remain held and untouched.
    if (stat.size === 0 && schema.length === 0 && version === 0) {
      db.exec('CREATE TABLE restore_owner (id INTEGER PRIMARY KEY CHECK(id=1)); PRAGMA user_version=1;');
      fault?.('initializing'); db.exec('COMMIT'); locked = false;
      try { db.exec('BEGIN IMMEDIATE'); locked = true; }
      catch { hold('Another process is preparing or applying a private restore. Wait for it to finish before retrying.'); }
      schema = db.prepare("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 2").all();
    }
    if (schema.length !== 1 || schema[0].sql !== 'CREATE TABLE restore_owner (id INTEGER PRIMARY KEY CHECK(id=1))' || db.prepare('PRAGMA user_version').get()?.user_version !== 1) hold();
    return await work();
  } finally { try { if (locked) db.exec('ROLLBACK'); } finally { db.close(); } }
}
export async function privateRestoreTargetHash(path: string): Promise<string | null> {
  const handle = await fileHandle(path); if (!handle) return null;
  try {
    const before = await handle.stat(), hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    if (before.size > 1024 ** 3) hold('The restore target exceeds its supported size. Existing files were preserved.');
    let offset = 0;
    while (offset < before.size) {
      const part = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!part.bytesRead) hold(); hash.update(buffer.subarray(0, part.bytesRead)); offset += part.bytesRead;
    }
    const after = await handle.stat(), named = await lstat(path);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || named.ino !== after.ino || named.dev !== after.dev || named.nlink !== 1 || named.isSymbolicLink()) hold();
    return hash.digest('hex');
  } finally { await handle.close(); }
}
const fileHash = privateRestoreTargetHash;
async function readStage(directory: string, key: Buffer): Promise<Stage | null> {
  const handle = await fileHandle(join(directory, PRIVATE_RESTORE_V2_STAGE_FILE)); if (!handle) return null;
  try {
    if ((await handle.stat()).size > MAX_STAGE) hold();
    const bytes = await handle.readFile(); if (bytes.length > MAX_STAGE) hold();
    const envelope: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!isEncryptedEnvelope(envelope)) hold();
    const value = decryptJson(key, envelope);
    if (!object(value) || Object.keys(value).filter(k => k !== 'operation').sort().join(',') !== 'directoryId,preparedDigest,receipt,state,storeId,targetGuard,version,workspaceId' || value.version !== 2 ||
        Object.hasOwn(value, 'operation') && !validBackupRestoreBinding(value.operation) ||
        !['staged', 'applying'].includes(value.state as string) ||
        !['directoryId', 'storeId', 'workspaceId'].every(k => typeof value[k] === 'string' && UUID.test(value[k])) ||
        !['preparedDigest', 'targetGuard'].every(k => typeof value[k] === 'string' && HASH.test(value[k]))) hold();
    const receipt = parsePrivateBackupReceipt(value.receipt);
    if (!receipt || receipt.workspaceId !== value.workspaceId) hold();
    return { ...value, receipt } as unknown as Stage;
  } catch { return hold(); } finally { await handle.close(); }
}
async function atomicBytes(path: string, input: AsyncIterable<Uint8Array>, expected?: { bytes: number; digest: string }, beforePublish?: () => Promise<void>, scratchDirectory = dirname(path)): Promise<void> {
  await parents(dirname(path)); const created = await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await windowsFilePrivacy(dirname(path), 'directory', created !== undefined);
  await parents(scratchDirectory);
  const scratchCreated = await mkdir(scratchDirectory, { recursive: true, mode: 0o700 });
  await windowsFilePrivacy(scratchDirectory, 'directory', scratchCreated !== undefined);
  if ((await lstat(scratchDirectory)).dev !== (await lstat(dirname(path))).dev) hold('Restore staging and business files must be on the same local filesystem.');
  // Business replacements live in the private staging area so creating a
  // temporary file cannot change the guarded company-membership directory.
  const temporary = join(scratchDirectory, `.realbud-restore-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600), hash = createHash('sha256'); let bytes = 0;
  try {
    await windowsFilePrivacy(temporary, 'file', true);
    for await (const chunk of input) {
      if (!(chunk instanceof Uint8Array) || chunk.length > 1024 * 1024) hold();
      bytes += chunk.length; if (bytes > (expected?.bytes ?? MAX_STAGE)) hold(); hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) { const result = await handle.write(chunk, offset, chunk.length - offset); if (!result.bytesWritten) hold(); offset += result.bytesWritten; }
    }
    if (expected && (bytes !== expected.bytes || hash.digest('hex') !== expected.digest)) hold('A prepared restore file failed verification. The target file was preserved.');
    await handle.sync(); await handle.close();
    await beforePublish?.();
    await rename(temporary, path); fsyncDir(dirname(path));
  } finally { await handle.close().catch(() => {}); await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
}
async function saveStage(directory: string, key: Buffer, stage: Stage) {
  const bytes = Buffer.from(JSON.stringify(encryptJson(key, stage))); if (bytes.length > MAX_STAGE) hold();
  await atomicBytes(join(directory, PRIVATE_RESTORE_V2_STAGE_FILE), (async function* () { yield bytes; })());
}
function preparedDirectory(directory: string, directoryId: string): string { return join(directory, 'private-backup-v2', 'prepared', directoryId); }
async function inspectTarget(directory: string, store: PrivateBackupPreparedStore, stage: Pick<Stage, 'state' | 'targetGuard'>): Promise<void> {
  if (await privateBackupTargetGuard(directory) !== stage.targetGuard) hold('The installation settings changed after restore preparation. Startup is held.');
  const paths = new Set(await privateBackupTargetPaths(directory));
  for (const entry of store.entries()) {
    const actual = await fileHash(join(directory, entry.path));
    if (stage.state === 'staged' ? actual !== entry.beforeHash : actual !== entry.beforeHash && actual !== entry.intendedHash) hold('The restore target changed after preparation. Startup is held; no further files were replaced.');
    paths.delete(entry.path);
  }
  if (paths.size) hold('New business files appeared after restore preparation. Startup is held.');
}
async function noV1Stage(directory: string) { if (await fileHash(join(directory, PRIVATE_RESTORE_STAGE_FILE)) !== null) hold('Another restore is already staged. Recover it before preparing another restore.'); }
export interface StagePrivateRestoreV2Options {
  directory: string; key: Buffer; directoryId: string; storeId: string; workspaceId: string;
  expectedPreparedDigest: string; receipt: PrivateBackupReceipt;
  assertFresh: () => void; assertIdle: () => void; epoch: () => string;
  /** Internal journal binding. Never accepted from an archive or raw HTTP body. */
  operation?: BackupRestoreBinding;
  /** Test-only initialization interruption; never taken from HTTP input. */
  lockFault?: LockFault;
}
/** Host must hold its installation write barrier throughout this call. */
async function stagePrivateRestoreV2Unlocked(options: StagePrivateRestoreV2Options): Promise<{ needsRestart: true; receipt: PrivateBackupReceipt }> {
  if (!Buffer.isBuffer(options.key) || options.key.length !== 32 || ![options.directoryId, options.storeId, options.workspaceId].every(v => typeof v === 'string' && UUID.test(v)) || !HASH.test(options.expectedPreparedDigest)) hold();
  if (options.operation !== undefined && !validBackupRestoreBinding(options.operation)) hold();
  const receipt = parsePrivateBackupReceipt(options.receipt); if (!receipt || receipt.workspaceId !== options.workspaceId) hold();
  const directory = resolve(options.directory), key = Buffer.from(options.key); let store: PrivateBackupPreparedStore | undefined;
  try {
    options.assertIdle(); options.assertFresh(); const epoch = options.epoch();
    await noV1Stage(directory);
    const existing = await readStage(directory, key);
    if (existing) {
      if (existing.directoryId !== options.directoryId || existing.storeId !== options.storeId || existing.preparedDigest !== options.expectedPreparedDigest || JSON.stringify(existing.receipt) !== JSON.stringify(receipt) || JSON.stringify(existing.operation) !== JSON.stringify(options.operation)) hold('A different restore is already staged.');
      return { needsRestart: true, receipt: existing.receipt };
    }
    if (await fileHash(join(directory, PRIVATE_BACKUP_COMPLETION_FILE)) !== null) hold('Finish recording the previous restore before preparing another restore.');
    const ownership = options.operation ? await verifyBackupWorkspaceIdentity(directory, options.operation.previousWorkspaceId) : undefined;
    store = await PrivateBackupPreparedStore.open({ directory: preparedDirectory(directory, options.directoryId), key, storeId: options.storeId, workspaceId: options.workspaceId });
    const summary = await store.validate();
    if (!summary.sealed || summary.digest !== options.expectedPreparedDigest) hold();
    const stage: Stage = { version: 2, state: 'staged', directoryId: options.directoryId, storeId: options.storeId, workspaceId: options.workspaceId,
      preparedDigest: summary.digest, receipt, targetGuard: await privateBackupTargetGuard(directory), ...(options.operation ? { operation: { ...options.operation } } : {}) };
    await inspectTarget(directory, store, stage);
    options.assertIdle(); options.assertFresh(); if (options.epoch() !== epoch) hold('The target changed while preparing restoration. No restore was staged.');
    ownership?.assertCurrent();
    await saveStage(directory, key, stage);
    return { needsRestart: true, receipt };
  } finally { try { await store?.close(); } finally { key.fill(0); } }
}
async function applyStagedPrivateRestoreV2Unlocked(options: {
  directory: string; key: Buffer; afterWrite?: (path: string) => void; lockFault?: LockFault;
}): Promise<{ restored: boolean; receipt?: PrivateBackupReceipt }> {
  const directory = resolve(options.directory), key = Buffer.from(options.key); let store: PrivateBackupPreparedStore | undefined;
  try {
    const stage = await readStage(directory, key); if (!stage) return { restored: false };
    await noV1Stage(directory);
    const priorCompletion = await readBackupColdCompletionProof(directory, key);
    if (priorCompletion) {
      const proof = priorCompletion.proof;
      if (!stage.operation || proof.operationId !== stage.operation.operationId || proof.previousWorkspaceId !== stage.operation.previousWorkspaceId ||
          proof.workspaceId !== stage.workspaceId || proof.directoryId !== stage.directoryId || proof.storeId !== stage.storeId ||
          proof.preparedDigest !== stage.preparedDigest || JSON.stringify(proof.receipt) !== JSON.stringify(stage.receipt)) hold('The previous restore must be recorded before applying another one.');
    }
    store = await PrivateBackupPreparedStore.open({ directory: preparedDirectory(directory, stage.directoryId), key, storeId: stage.storeId, workspaceId: stage.workspaceId });
    const summary = await store.validate(); if (!summary.sealed || summary.digest !== stage.preparedDigest) hold();
    await inspectTarget(directory, store, stage);
    if (stage.state === 'staged') { stage.state = 'applying'; await saveStage(directory, key, stage); }
    for (const entry of store.entries() as Iterable<ManifestEntry>) {
      if (await privateBackupTargetGuard(directory) !== stage.targetGuard) hold();
      const target = join(directory, entry.path), actual = await fileHash(target);
      if (actual !== entry.beforeHash && actual !== entry.intendedHash) hold();
      if (actual !== entry.intendedHash) {
        if (entry.intendedHash === null) { await unlink(target); fsyncDir(dirname(target)); }
        else await atomicBytes(target, store.readFile(entry.path), { bytes: entry.bytes, digest: entry.intendedHash }, async () => {
          if (await privateBackupTargetGuard(directory) !== stage.targetGuard || await fileHash(target) !== actual) hold('The target changed while its replacement was prepared. Its file was preserved.');
        }, join(directory, 'private-backup-v2', 'apply'));
      }
      options.afterWrite?.(entry.path);
    }
    await inspectTarget(directory, store, stage);
    for (const entry of store.entries()) if (await fileHash(join(directory, entry.path)) !== entry.intendedHash) hold();
    const restoredAt = priorCompletion?.proof.restoredAt ?? new Date().toISOString();
    if (priorCompletion) priorCompletion.assertCurrent();
    else if (stage.operation) {
      const proof = parseBackupColdCompletion({ version: 1, ...stage.operation, workspaceId: stage.workspaceId, directoryId: stage.directoryId,
        storeId: stage.storeId, preparedDigest: stage.preparedDigest, receipt: stage.receipt, restoredAt });
      if (!proof) hold();
      const bytes = Buffer.from(JSON.stringify(encryptJson(key, proof)));
      await atomicBytes(join(directory, PRIVATE_BACKUP_COMPLETION_FILE), (async function* () { yield bytes; })());
    }
    const completed = Buffer.from(JSON.stringify({ version: 1, restoredAt, receipt: stage.receipt, rekeyed: true, reviewRequired: true }));
    await atomicBytes(join(directory, PRIVATE_RESTORE_RECEIPT_FILE), (async function* () { yield completed; })());
    await unlink(join(directory, PRIVATE_RESTORE_V2_STAGE_FILE)); fsyncDir(directory);
    return { restored: true, receipt: stage.receipt };
  } finally { try { await store?.close(); } finally { key.fill(0); } }
}
export function stagePrivateRestoreV2(options: StagePrivateRestoreV2Options) { return withRestoreLock(options.directory, () => stagePrivateRestoreV2Unlocked(options), options.lockFault); }
export function applyStagedPrivateRestoreV2(options: Parameters<typeof applyStagedPrivateRestoreV2Unlocked>[0]) { return withRestoreLock(options.directory, () => applyStagedPrivateRestoreV2Unlocked(options), options.lockFault); }

```


## server/private-backup-operations.ts
```ts
/** Durable control records for private backup v2. No business bodies, paths,
 * passphrases or keys belong in these records. Artifact bytes remain owned by
 * the coordinator; reservations must cover its enforced component limits. */
import { randomUUID } from 'node:crypto';
import { lstatSync, unlinkSync } from 'node:fs';
import { link, lstat, mkdir, open, opendir, unlink } from 'node:fs/promises';
import { join, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decryptJson, encryptJson, isEncryptedEnvelope } from './desk-crypto.ts';
import { fsyncDir } from './atomic.ts';
import { windowsFilePrivacy } from './windows-file-privacy.ts';
import { readBackupColdCompletion } from './private-backup-completion.ts';
import { parsePrivateBackupTransferOperation, privateBackupTransferDigest, privateBackupTransferId, type PrivateBackupTransferOperation, type PrivateBackupTransferPhase } from '../shared/private-backup-transfers.ts';

export const PRIVATE_BACKUP_OPERATION_LIMITS = Object.freeze({ records: 1000, active: 4, journalBytes: 64 * 1024 ** 2, recordBytes: 64 * 1024, reservationBytes: 32 * 1024 ** 3 });
export interface BackupCatalogReference {
  directoryId: string; catalogId: string; workspaceId: string; digest: string; createdAt: string; databasePresent: boolean;
}
export interface BackupPreparedReference { directoryId: string; storeId: string; workspaceId: string; digest: string }
export interface BackupOperationRecord {
  version: 1; revision: number; operation: PrivateBackupTransferOperation;
  reservedBytes: number;
  /** Sticky from staging onward, including a failed/uncertain stage. Only a
   * separately verified cold completion permits releasing its reservation. */
  restoreHeld: boolean;
  references: { capture?: BackupCatalogReference; preview?: BackupCatalogReference; prepared?: BackupPreparedReference };
}
export interface BackupOperationStoreOptions {
  directory: string; key: Buffer; workspaceId: string;
  /** Installation-owned business directory, used only to verify a cold restore
   * when its archive replaced the prior workspace identity. Never an HTTP path. */
  restoreDirectory?: string;
  limits?: { records?: number; active?: number; reservationBytes?: number };
  now?: () => number;
  /** Test-only process interruption seam; never populated from serialized input. */
  fault?: (point: 'initial-ready' | 'initial-linked' | 'completion-committed') => void;
}
const SCHEMA = {
  control: 'CREATE TABLE control (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)',
  operations: 'CREATE TABLE operations (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL)',
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const integer = (v: unknown, minimum = 0): v is number => Number.isSafeInteger(v) && Number(v) >= minimum && Number(v) < Number.MAX_SAFE_INTEGER;
const closedPhases = new Set<PrivateBackupTransferPhase>(['cancelled', 'expired', 'completed']);
const restorePhases = new Set<PrivateBackupTransferPhase>(['staging', 'staged', 'applying']);
const interruptedPhases = new Set<PrivateBackupTransferPhase>(['capturing', 'sealing', 'checking']);
const transitions: Record<PrivateBackupTransferPhase, readonly PrivateBackupTransferPhase[]> = {
  capturing: ['sealing', 'failed', 'interrupted', 'cancelled'], sealing: ['ready', 'failed', 'interrupted', 'cancelled'],
  ready: ['cancelled', 'expired'], uploading: ['uploaded', 'failed', 'interrupted', 'cancelled'],
  uploaded: ['checking', 'failed', 'interrupted', 'cancelled'], checking: ['reviewed', 'failed', 'interrupted', 'cancelled'],
  reviewed: ['staging', 'failed', 'cancelled'], staging: ['staged', 'failed'], staged: ['applying'],
  applying: ['completed', 'failed'], completed: [], cancelled: [], expired: [],
  interrupted: ['capturing', 'sealing', 'uploading', 'uploaded', 'checking', 'cancelled'],
  failed: ['capturing', 'sealing', 'uploading', 'uploaded', 'checking', 'staging', 'staged', 'applying', 'cancelled'],
};
function fail(message = 'Backup operation records need recovery. Existing files were preserved.', status = 503): never { throw Object.assign(new Error(message), { status }); }
function reference(v: unknown, prepared: boolean): boolean {
  if (!object(v) || !exact(v, prepared ? ['directoryId', 'storeId', 'workspaceId', 'digest'] : ['directoryId', 'catalogId', 'workspaceId', 'digest', 'createdAt', 'databasePresent']) ||
      !privateBackupTransferId(v.directoryId) || !privateBackupTransferId(v.workspaceId) || !privateBackupTransferId(v[prepared ? 'storeId' : 'catalogId']) || !privateBackupTransferDigest(v.digest)) return false;
  return prepared || typeof v.createdAt === 'string' && Number.isFinite(Date.parse(v.createdAt)) && new Date(v.createdAt).toISOString() === v.createdAt && typeof v.databasePresent === 'boolean';
}
function validate(v: unknown, workspaceId: string): BackupOperationRecord {
  if (!object(v) || !exact(v, ['version', 'revision', 'operation', 'reservedBytes', 'restoreHeld', 'references']) || v.version !== 1 || !integer(v.revision, 1) || !integer(v.reservedBytes) ||
      v.reservedBytes > PRIVATE_BACKUP_OPERATION_LIMITS.reservationBytes || typeof v.restoreHeld !== 'boolean' || !object(v.references) || !exact(v.references, [], ['capture', 'preview', 'prepared'])) return fail();
  const op = parsePrivateBackupTransferOperation(v.operation); if (!op || op.workspaceId !== workspaceId) return fail();
  for (const [name, ref] of Object.entries(v.references)) if (!reference(ref, name === 'prepared')) return fail();
  if (op.kind === 'export' && (v.references.preview || v.references.prepared || v.restoreHeld) || op.kind === 'upload' && v.references.capture) return fail();
  if (op.phase === 'completed' && (op.kind !== 'upload' || !v.restoreHeld || !v.references.prepared)) return fail();
  if (restorePhases.has(op.phase) && !v.restoreHeld || v.restoreHeld && (op.canCancel || ['cancelled', 'expired'].includes(op.phase)) || v.restoreHeld && op.phase !== 'completed' && !v.reservedBytes) return fail();
  if (v.references.capture && (v.references.capture as BackupCatalogReference).workspaceId !== workspaceId) return fail();
  if (v.references.preview && op.preview && (v.references.preview as BackupCatalogReference).workspaceId !== op.preview.workspaceId) return fail();
  if (v.references.prepared && (!v.restoreHeld || !v.references.preview || (v.references.prepared as BackupPreparedReference).workspaceId !== (v.references.preview as BackupCatalogReference).workspaceId)) return fail();
  if (Buffer.byteLength(JSON.stringify(v)) > PRIVATE_BACKUP_OPERATION_LIMITS.recordBytes) return fail();
  return { version: 1, revision: v.revision, operation: op, reservedBytes: v.reservedBytes, restoreHeld: v.restoreHeld, references: structuredClone(v.references) } as BackupOperationRecord;
}
async function privateDirectory(directory: string): Promise<void> {
  const root = parse(directory).root; let current = root;
  for (const part of directory.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    try { const s = await lstat(current); if (!s.isDirectory() || s.isSymbolicLink()) fail(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const made = await mkdir(directory, { recursive: true, mode: 0o700 }), stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid?.())) fail();
  await windowsFilePrivacy(directory, 'directory', made !== undefined);
}

/** Publish a complete, private database with an exclusive hard link. The fixed
 * name is never an empty/truncated initialization marker. A killed publisher's
 * second link is recoverable only for its authenticated, empty initial store. */
async function initialize(path: string, directory: string, options: BackupOperationStoreOptions, nonce: string): Promise<boolean> {
  try { await lstat(path); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let entries = 0;
  for await (const _entry of await opendir(directory)) if (++entries > 32) fail('Interrupted backup initialization files need recovery. Existing files were preserved.');
  const temporary = join(directory, `.operations-init-${nonce}.sqlite`), file = await open(temporary, 'wx', 0o600);
  let published = false;
  try {
    await windowsFilePrivacy(temporary, 'file', true);
    const db = new DatabaseSync(temporary);
    try {
      db.exec('PRAGMA page_size=4096; PRAGMA max_page_count=16; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
      db.exec(`${SCHEMA.control}; ${SCHEMA.operations}; PRAGMA user_version=1;`);
      db.prepare('INSERT INTO control VALUES(1,?)').run(JSON.stringify(encryptJson(options.key, { version: 1, workspaceId: options.workspaceId, owner: null, initialization: nonce })));
      db.exec('COMMIT');
    } finally { db.close(); }
    await file.sync(); options.fault?.('initial-ready');
    try { await link(temporary, path); published = true; fsyncDir(directory); options.fault?.('initial-linked'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    return published;
  } finally {
    await file.close(); await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); fsyncDir(directory);
  }
}

export async function createBackupOperationStore(options: BackupOperationStoreOptions) {
  if (!Buffer.isBuffer(options.key) || options.key.length !== 32 || !privateBackupTransferId(options.workspaceId)) fail('A protected workspace is required.', 400);
  const limits = { ...PRIVATE_BACKUP_OPERATION_LIMITS, ...options.limits }, now = options.now ?? Date.now;
  for (const name of ['records', 'active', 'reservationBytes'] as const) if (!integer(limits[name], 1) || limits[name] > PRIVATE_BACKUP_OPERATION_LIMITS[name]) fail('Invalid backup operation limits.', 400);
  const directory = resolve(options.directory), path = join(directory, 'operations.sqlite'); await privateDirectory(directory);
  const nonce = randomUUID(); await initialize(path, directory, options, nonce);
  const initial = await lstat(path);
  if (!initial.isFile() || initial.isSymbolicLink() || ![1, 2].includes(initial.nlink) || !initial.size || initial.size > limits.journalBytes || process.platform !== 'win32' && ((initial.mode & 0o077) || initial.uid !== process.getuid?.())) fail();
  await windowsFilePrivacy(path, 'file');
  const key = Buffer.from(options.key); let db: DatabaseSync;
  try { db = new DatabaseSync(path); } catch (error) { key.fill(0); throw error; }
  let closed = false;
  const encode = (value: unknown) => JSON.stringify(encryptJson(key, value));
  const decode = (value: unknown): unknown => {
    if (typeof value !== 'string' || Buffer.byteLength(value) > 2 * limits.recordBytes) return fail();
    try { const envelope: unknown = JSON.parse(value); if (!isEncryptedEnvelope(envelope)) return fail(); return decryptJson(key, envelope); } catch { return fail(); }
  };
  const tx = <T>(work: () => T): T => { if (closed) fail('Backup operation storage is closed.', 409); db.exec('BEGIN IMMEDIATE'); try { const result = work(); db.exec('COMMIT'); return result; } catch (error) { try { db.exec('ROLLBACK'); } catch { /* SQLite may already have rolled back a full-disk transaction. */ } throw error; } };
  const control = (requireCurrent = true) => {
    const row = db.prepare('SELECT CASE WHEN length(payload)<=? THEN payload END AS payload FROM control WHERE id=1').get(2 * limits.recordBytes);
    const value = row && decode(row.payload);
    if (!object(value) || !exact(value, ['version', 'workspaceId', 'owner', 'initialization']) || value.version !== 1 || !privateBackupTransferId(value.workspaceId) || requireCurrent && value.workspaceId !== options.workspaceId ||
      !(value.initialization === null || privateBackupTransferId(value.initialization)) ||
      !(value.owner === null || object(value.owner) && exact(value.owner, ['pid', 'nonce']) && integer(value.owner.pid, 1) && privateBackupTransferId(value.owner.nonce))) return fail();
    return value as { version: 1; workspaceId: string; owner: { pid: number; nonce: string } | null; initialization: string | null };
  };
  const assertOwner = () => {
    if (closed) fail('Backup operation storage is closed.', 409);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.ino !== initial.ino || stat.dev !== initial.dev || stat.size > limits.journalBytes ||
        process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid?.())) fail();
    const owner = control().owner; if (owner?.pid !== process.pid || owner.nonce !== nonce) fail();
  };
  const rowRecord = (row: Record<string, unknown>): BackupOperationRecord => {
    const value = decode(row.payload);
    if (!object(value) || !object(value.operation) || !privateBackupTransferId(value.operation.workspaceId)) return fail();
    const record = validate(value, value.operation.workspaceId);
    if (record.operation.id !== row.id || record.revision !== row.revision) fail(); return record;
  };
  const rows = () => db.prepare('SELECT id,revision,CASE WHEN length(payload)<=? THEN payload END AS payload FROM operations ORDER BY id LIMIT ?').iterate(2 * limits.recordBytes, limits.records + 1);
  const read = (id: string) => {
    if (!privateBackupTransferId(id)) fail('Invalid backup operation.', 400);
    const row = db.prepare('SELECT id,revision,CASE WHEN length(payload)<=? THEN payload END AS payload FROM operations WHERE id=?').get(2 * limits.recordBytes, id);
    if (!row) fail('This backup operation was not found.', 404); return rowRecord(row);
  };
  const totals = () => {
    let records = 0, workspaceRecords = 0, active = 0, reservedBytes = 0;
    for (const row of rows()) { const r = rowRecord(row); records++; const current = r.operation.workspaceId === options.workspaceId; workspaceRecords += Number(current);
      active += Number(current && !closedPhases.has(r.operation.phase)); reservedBytes += r.reservedBytes; }
    if (records > limits.records || !integer(reservedBytes) || reservedBytes > limits.reservationBytes) fail();
    return { records, workspaceRecords, active, reservedBytes };
  };
  const save = (record: BackupOperationRecord) => db.prepare('INSERT OR REPLACE INTO operations VALUES(?,?,?)').run(record.operation.id, record.revision, encode(record));
  const stamp = () => { const value = now(); if (!integer(value, 1)) fail('The backup clock is unavailable.'); return value; };
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-1024;');
    const schema = db.prepare("SELECT name,type,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 3").all();
    if (schema.length !== 2 || schema.some(row => row.type !== 'table' || !Object.hasOwn(SCHEMA, String(row.name)) || row.sql !== SCHEMA[row.name as keyof typeof SCHEMA]) || db.prepare('PRAGMA user_version').get()?.user_version !== 1) fail();
    const page = Number(db.prepare('PRAGMA page_size').get()?.page_size); if (!integer(page, 512) || page > 65_536) fail();
    db.exec(`PRAGMA max_page_count=${Math.floor(limits.journalBytes / page)};`);
    const prior = control(false);
    let completion: Awaited<ReturnType<typeof readBackupColdCompletion>> | undefined;
    if (options.restoreDirectory) {
      try { completion = await readBackupColdCompletion(options.restoreDirectory, key, options.workspaceId); }
      catch (error) { if (prior.workspaceId !== options.workspaceId) throw error; }
    } else if (prior.workspaceId !== options.workspaceId) fail();
    let consumeCompletion = false;
    tx(() => {
      const header = control(false);
      if (header.owner) {
        try { process.kill(header.owner.pid, 0); fail('Another running service owns backup operations.', 409); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      totals();
      if (lstatSync(path).nlink === 2) {
        if (!header.initialization || header.owner || totals().records !== 0) fail();
        const candidatePath = join(directory, `.operations-init-${header.initialization}.sqlite`);
        try {
          const candidate = lstatSync(candidatePath);
          if (!candidate.isFile() || candidate.isSymbolicLink() || candidate.nlink !== 2 || candidate.ino !== initial.ino || candidate.dev !== initial.dev) fail();
          unlinkSync(candidatePath); fsyncDir(directory);
        } catch (error) {
          // The publishing process may finish removing its own extra link
          // while this opener holds the SQL admission lock.
          const named = lstatSync(path);
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || named.nlink !== 1 || named.ino !== initial.ino || named.dev !== initial.dev || named.isSymbolicLink()) throw error;
        }
      }
      if (header.workspaceId !== options.workspaceId && (!completion || completion.proof.previousWorkspaceId !== header.workspaceId)) fail();
      const matchingCompletion = completion && (completion.proof.previousWorkspaceId === header.workspaceId || completion.proof.workspaceId === header.workspaceId) &&
        db.prepare('SELECT id FROM operations WHERE id=?').get(completion.proof.operationId);
      if (header.workspaceId !== options.workspaceId && !matchingCompletion) fail();
      if (completion && matchingCompletion) {
        completion.assertCurrent();
        const proof = completion.proof, restored = read(proof.operationId), prepared = restored.references.prepared;
        if (restored.operation.workspaceId !== proof.previousWorkspaceId || restored.operation.kind !== 'upload' || !restored.restoreHeld ||
            header.workspaceId !== proof.previousWorkspaceId && restored.operation.phase !== 'completed' ||
            !['staging', 'staged', 'applying', 'failed', 'completed'].includes(restored.operation.phase) || !prepared || prepared.directoryId !== proof.directoryId ||
            prepared.storeId !== proof.storeId || prepared.digest !== proof.preparedDigest || prepared.workspaceId !== proof.workspaceId ||
            restored.references.preview?.workspaceId !== proof.workspaceId || restored.operation.artifact?.archiveDigest !== proof.receipt.digest ||
            restored.operation.preview && JSON.stringify(restored.operation.preview) !== JSON.stringify(proof.receipt)) fail();
        // Verified cold publication may have outlived its process before a
        // journal phase update. Keep the original ownership and reservation:
        // completion does not prove that retained artifacts were cleaned up.
        if (restored.operation.phase !== 'completed') {
          restored.revision++; restored.operation.phase = 'completed'; restored.operation.canCancel = false;
          restored.operation.requiresPassphrase = false; restored.operation.preview = proof.receipt;
          restored.operation.updatedAt = Math.max(stamp(), restored.operation.updatedAt); delete restored.operation.error;
          save(validate(restored, proof.previousWorkspaceId));
        }
        consumeCompletion = true;
      }
      db.prepare('UPDATE control SET payload=? WHERE id=1').run(encode({ ...header, workspaceId: options.workspaceId, owner: { pid: process.pid, nonce }, initialization: null }));
      // We own the journal now. No previous live computation can still publish.
      // Ciphertext upload progress remains resumable; staging evidence stays held.
      for (const row of rows()) {
        const r = rowRecord(row); if (r.operation.workspaceId !== options.workspaceId || !interruptedPhases.has(r.operation.phase)) continue;
        r.revision++; r.operation.phase = 'interrupted'; r.operation.updatedAt = Math.max(stamp(), r.operation.updatedAt);
        r.operation.requiresPassphrase = r.operation.kind === 'export' || r.operation.receivedBytes === r.operation.progress.totalBytes;
        delete r.operation.preview; r.operation.error = { code: 'interrupted' }; save(validate(r, options.workspaceId));
      }
    });
    // Commit the durable journal first. A killed process leaves an exact proof
    // that the next opener recognizes as already ingested and then consumes.
    if (consumeCompletion) { options.fault?.('completion-committed'); completion!.consume(); }
  } catch (error) {
    try { tx(() => { const header = control(false); if (header.owner?.pid === process.pid && header.owner.nonce === nonce) db.prepare('UPDATE control SET payload=? WHERE id=1').run(encode({ ...header, owner: null })); }); } catch { /* Preserve unverifiable storage; never clear another owner. */ }
    db.close(); key.fill(0); throw error;
  }
  return {
    get(id: string) { assertOwner(); const record = read(id); if (record.operation.workspaceId !== options.workspaceId) fail('This backup operation was not found.', 404); return record; },
    usage() { assertOwner(); return { ...totals(), limits: { records: limits.records, active: limits.active, reservedBytes: limits.reservationBytes } }; },
    list(pageOptions: { limit?: number; after?: string } = {}) {
      assertOwner(); const limit = pageOptions.limit ?? 20;
      if (!integer(limit, 1) || limit > 20 || pageOptions.after !== undefined && !privateBackupTransferId(pageOptions.after)) fail('Invalid backup operation page.', 400);
      const result: BackupOperationRecord[] = []; let next: string | null = null;
      for (const row of rows()) {
        const record = rowRecord(row); if (record.operation.workspaceId !== options.workspaceId || record.operation.id <= (pageOptions.after ?? '')) continue;
        if (result.length === limit) { next = result.at(-1)!.operation.id; break; } result.push(record);
      }
      return { items: result, next, total: totals().workspaceRecords };
    },
    create(operation: PrivateBackupTransferOperation, reservedBytes: number): BackupOperationRecord {
      return tx(() => {
        assertOwner(); const record = validate({ version: 1, revision: 1, operation, reservedBytes, restoreHeld: false, references: {} }, options.workspaceId);
        if (operation.phase !== (operation.kind === 'export' ? 'capturing' : 'uploading') || !reservedBytes) fail('Invalid new backup operation.', 400);
        const existing = db.prepare('SELECT id FROM operations WHERE id=?').get(operation.id);
        if (existing) { const before = read(operation.id); if (before.operation.workspaceId !== options.workspaceId || before.operation.kind !== operation.kind || operation.kind === 'upload' && before.operation.progress.totalBytes !== operation.progress.totalBytes) fail('This operation identifier belongs to a different request.', 409); return before; }
        const used = totals();
        if (used.records >= limits.records || used.active >= limits.active) fail('Saved backup operations have reached their limit. Review existing operations first.', 409);
        if (used.reservedBytes + reservedBytes > limits.reservationBytes) fail('Backup temporary storage is fully reserved. Finish or cancel an existing operation.', 507);
        save(record); return structuredClone(record);
      });
    },
    update(id: string, revision: number, change: (record: BackupOperationRecord) => void): BackupOperationRecord {
      return tx(() => {
        assertOwner(); const before = read(id); if (before.operation.workspaceId !== options.workspaceId) fail('This backup operation was not found.', 404);
        if (before.revision !== revision) fail('Backup progress changed. Check the saved operation before retrying.', 409);
        const next = structuredClone(before), result: unknown = change(next);
        if (result !== undefined) {
          // TypeScript accepts async functions where void is expected. An
          // asynchronous edit cannot own this synchronous transaction.
          if (result instanceof Promise) void result.catch(() => {});
          fail('Backup operation edits must finish synchronously.', 400);
        }
        next.revision = before.revision + 1;
        next.operation.updatedAt = Math.max(stamp(), before.operation.updatedAt);
        validate(next, options.workspaceId);
        if (next.operation.id !== id || next.operation.kind !== before.operation.kind || next.operation.createdAt !== before.operation.createdAt || before.restoreHeld && !next.restoreHeld || restorePhases.has(next.operation.phase) && !next.restoreHeld) fail();
        if (next.operation.phase !== before.operation.phase && !transitions[before.operation.phase].includes(next.operation.phase)) fail('This backup transition is unavailable.', 409);
        if (!before.restoreHeld && next.restoreHeld && !(before.operation.phase === 'reviewed' && next.operation.phase === 'staging')) fail('A restore must start from its reviewed backup.', 409);
        if (before.restoreHeld && ['capturing', 'sealing', 'uploading', 'uploaded', 'checking', 'reviewed', 'interrupted', 'cancelled', 'expired'].includes(next.operation.phase)) fail('Restore artifacts must be retained for recovery.', 409);
        if (before.operation.artifact && !['cancelled', 'expired'].includes(next.operation.phase) && JSON.stringify(before.operation.artifact) !== JSON.stringify(next.operation.artifact)) fail();
        if (before.restoreHeld) {
          for (const name of ['preview', 'prepared'] as const) {
            if (before.references[name] && JSON.stringify(before.references[name]) !== JSON.stringify(next.references[name])) fail('Restore artifacts must be retained for recovery.', 409);
          }
          if (next.operation.phase !== 'completed' && next.reservedBytes !== before.reservedBytes || next.reservedBytes > before.reservedBytes) fail('Restore storage must remain reserved until completion and cleanup.', 409);
        }
        if (before.operation.kind === 'upload' && (next.operation.progress.totalBytes !== before.operation.progress.totalBytes || next.operation.receivedBytes! < before.operation.receivedBytes!)) fail();
        const used = totals(); if (used.reservedBytes - before.reservedBytes + next.reservedBytes > limits.reservationBytes) fail('Backup temporary storage is fully reserved.', 507);
        save(next); return structuredClone(next);
      });
    },
    /** Only removes old terminal metadata whose artifact cleanup already
     * released all reservations. Never removes staged/restore-held evidence. */
    prune(beforeTime: number): number {
      return tx(() => {
        assertOwner(); if (!integer(beforeTime, 1)) fail('Invalid backup retention time.', 400);
        const ids: string[] = [];
        for (const row of rows()) { const r = rowRecord(row); if (!r.restoreHeld && !r.reservedBytes && ['cancelled', 'expired'].includes(r.operation.phase) && r.operation.updatedAt < beforeTime) ids.push(r.operation.id); }
        for (const id of ids) db.prepare('DELETE FROM operations WHERE id=?').run(id); return ids.length;
      });
    },
    close() {
      if (closed) return;
      try { tx(() => { assertOwner(); const header = control(); db.prepare('UPDATE control SET payload=? WHERE id=1').run(encode({ ...header, owner: null })); }); }
      finally { closed = true; try { db.close(); } finally { key.fill(0); } }
    },
  };
}
export type BackupOperationStore = Awaited<ReturnType<typeof createBackupOperationStore>>;

```
