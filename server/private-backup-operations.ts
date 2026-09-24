/** Durable control records for private backup v2. No business bodies, paths,
 * passphrases or keys belong in these records. Artifact bytes remain owned by
 * the coordinator; reservations must cover its enforced component limits. */
import { randomUUID } from 'node:crypto';
import { lstatSync, unlinkSync } from 'node:fs';
import { link, lstat, mkdir, open, opendir, unlink } from 'node:fs/promises';
import { join, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decryptJson, encryptJson, isEncryptedEnvelope } from './desk-crypto.ts';
import { fsyncDir, restrictNewSync } from './atomic.ts';
import { windowsFilePrivacy } from './windows-file-privacy.ts';
import { readBackupColdCompletion } from './private-backup-completion.ts';
import { parsePrivateBackupTransferOperation, privateBackupTransferDigest, privateBackupTransferId, type PrivateBackupTransferOperation, type PrivateBackupTransferPhase } from '../shared/private-backup-transfers.ts';

export const PRIVATE_BACKUP_OPERATION_LIMITS = Object.freeze({ records: 1000, active: 4, journalBytes: 64 * 1024 ** 2, recordBytes: 64 * 1024, reservationBytes: 32 * 1024 ** 3 });
export interface BackupCatalogReference {
  directoryId: string; catalogId: string; workspaceId: string; digest: string; createdAt: string; databasePresent: boolean;
}
export interface BackupPreparedReference { directoryId: string; storeId: string; workspaceId: string; digest: string }
export type BackupResourceRole = 'capture' | 'decoded' | 'preview' | 'prepared' | 'archive' | 'build' | 'upload';
export const BACKUP_RESOURCE_ROLES: readonly BackupResourceRole[] = ['capture', 'decoded', 'preview', 'prepared', 'archive', 'build', 'upload'];
export interface BackupResourceAllocation {
  id: string; nonce: string; role: BackupResourceRole; bytes: number; state: 'allocated' | 'deleting' | 'removed';
}
/** Filesystem marker for a retained allocation. State is journal-only and must
 * never appear here. Prepared files stay at DATA/private-backup-v2/prepared/<allocation.id>. */
export interface BackupResourceMarker {
  version: 1; operationId: string; workspaceId: string;
  allocation: { id: string; nonce: string; role: BackupResourceRole; bytes: number };
}
export interface BackupOperationRecord {
  version: 1; revision: number; operation: PrivateBackupTransferOperation;
  reservedBytes: number;
  /** Sticky from staging onward, including a failed/uncertain stage. Only a
   * separately verified cold completion permits releasing its reservation. */
  restoreHeld: boolean;
  references: { capture?: BackupCatalogReference; preview?: BackupCatalogReference; prepared?: BackupPreparedReference };
  /** Absent on legacy records. allocate() creates the list; removed rows stay. */
  allocations?: BackupResourceAllocation[];
  /** A failed handle close requires confirmed process exit, not merely a new
   * runtime instance. PID reuse conservatively keeps the cleanup hold. */
  cleanupHold?: { pid: number };
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
  /** Test-only identity seam; never populated from serialized input. */
  randomId?: () => string;
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
const RESOURCE_KIND: Record<'export' | 'upload', readonly BackupResourceRole[]> = { export: ['capture', 'archive'], upload: ['decoded', 'preview', 'prepared', 'build', 'upload'] };
const transitions: Record<PrivateBackupTransferPhase, readonly PrivateBackupTransferPhase[]> = {
  capturing: ['sealing', 'failed', 'interrupted', 'cancelled'], sealing: ['ready', 'failed', 'interrupted', 'cancelled'],
  ready: ['cancelled', 'expired'], uploading: ['uploaded', 'failed', 'interrupted', 'cancelled'],
  uploaded: ['checking', 'failed', 'interrupted', 'cancelled'], checking: ['reviewed', 'failed', 'interrupted', 'cancelled'],
  reviewed: ['staging', 'failed', 'cancelled'], staging: ['staged', 'failed'], staged: ['applying'],
  // Completion is admitted only by the encrypted cold-proof reconciliation
  // below, never by a generic progress update or a coordinator success flag.
  applying: ['failed'], completed: [], cancelled: [], expired: [],
  interrupted: ['capturing', 'sealing', 'uploading', 'uploaded', 'checking', 'cancelled'],
  failed: ['capturing', 'sealing', 'uploading', 'uploaded', 'checking', 'staging', 'staged', 'applying', 'cancelled'],
};
function fail(message = 'Backup operation records need recovery. Existing files were preserved.', status = 503): never { throw Object.assign(new Error(message), { status }); }
function reference(v: unknown, prepared: boolean): boolean {
  if (!object(v) || !exact(v, prepared ? ['directoryId', 'storeId', 'workspaceId', 'digest'] : ['directoryId', 'catalogId', 'workspaceId', 'digest', 'createdAt', 'databasePresent']) ||
      !privateBackupTransferId(v.directoryId) || !privateBackupTransferId(v.workspaceId) || !privateBackupTransferId(v[prepared ? 'storeId' : 'catalogId']) || !privateBackupTransferDigest(v.digest)) return false;
  return prepared || typeof v.createdAt === 'string' && Number.isFinite(Date.parse(v.createdAt)) && new Date(v.createdAt).toISOString() === v.createdAt && typeof v.databasePresent === 'boolean';
}
export function backupResourceMarker(operationId: string, workspaceId: string, allocation: BackupResourceAllocation): BackupResourceMarker {
  return { version: 1, operationId, workspaceId, allocation: { id: allocation.id, nonce: allocation.nonce, role: allocation.role, bytes: allocation.bytes } };
}
export function parseBackupResourceMarker(v: unknown): BackupResourceMarker | null {
  if (!object(v) || !exact(v, ['version', 'operationId', 'workspaceId', 'allocation']) || v.version !== 1 || !privateBackupTransferId(v.operationId) || !privateBackupTransferId(v.workspaceId) || !object(v.allocation) ||
      !exact(v.allocation, ['id', 'nonce', 'role', 'bytes']) || !privateBackupTransferId(v.allocation.id) || !privateBackupTransferId(v.allocation.nonce) ||
      !BACKUP_RESOURCE_ROLES.includes(v.allocation.role as BackupResourceRole) || !integer(v.allocation.bytes, 1) || v.allocation.bytes > PRIVATE_BACKUP_OPERATION_LIMITS.reservationBytes) return null;
  return { version: 1, operationId: v.operationId, workspaceId: v.workspaceId, allocation: { id: v.allocation.id, nonce: v.allocation.nonce, role: v.allocation.role as BackupResourceRole, bytes: v.allocation.bytes } };
}
function cleanupEligible(record: BackupOperationRecord, workspaceId: string) {
  if (record.restoreHeld && record.operation.phase !== 'completed') return false;
  if (record.cleanupHold) {
    try { process.kill(record.cleanupHold.pid, 0); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false; }
  }
  return closedPhases.has(record.operation.phase) || record.operation.workspaceId === workspaceId && (record.operation.phase === 'failed' || record.operation.phase === 'interrupted');
}
/** Reversible stage scratch has no published prepared reference. Only its
 * builder/prepared allocations may be discarded while a review remains valid. */
function allocationCleanupEligible(record: BackupOperationRecord, workspaceId: string, allocation: BackupResourceAllocation) {
  return cleanupEligible(record, workspaceId) || record.operation.workspaceId === workspaceId &&
    record.operation.phase === 'reviewed' && !record.restoreHeld && !record.cleanupHold && !record.references.prepared &&
    (allocation.role === 'prepared' || allocation.role === 'build');
}
function parseAllocations(v: unknown, kind: 'export' | 'upload', reservedBytes: number, references: BackupOperationRecord['references']): BackupResourceAllocation[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 32) return fail();
  const parsed: BackupResourceAllocation[] = []; const ids = new Set<string>(); const nonces = new Set<string>(); const live = new Set<BackupResourceRole>(); let liveBytes = 0;
  for (const item of v) {
    if (!object(item) || !exact(item, ['id', 'nonce', 'role', 'bytes', 'state']) || !privateBackupTransferId(item.id) || !privateBackupTransferId(item.nonce) ||
        !BACKUP_RESOURCE_ROLES.includes(item.role as BackupResourceRole) || !(RESOURCE_KIND[kind] as readonly string[]).includes(item.role as string) || !integer(item.bytes, 1) ||
        item.bytes > PRIVATE_BACKUP_OPERATION_LIMITS.reservationBytes || item.state !== 'allocated' && item.state !== 'deleting' && item.state !== 'removed' ||
        item.id === item.nonce || ids.has(item.id) || nonces.has(item.nonce) || ids.has(item.nonce) || nonces.has(item.id)) return fail();
    ids.add(item.id); nonces.add(item.nonce);
    if (item.state !== 'removed') { if (live.has(item.role as BackupResourceRole)) return fail(); live.add(item.role as BackupResourceRole); liveBytes += item.bytes; }
    parsed.push({ id: item.id, nonce: item.nonce, role: item.role as BackupResourceRole, bytes: item.bytes, state: item.state });
  }
  if (!integer(liveBytes) || liveBytes > reservedBytes) return fail();
  for (const name of ['capture', 'preview', 'prepared'] as const) {
    const ref = references[name]; if (ref && !parsed.some(a => a.role === name && a.id === ref.directoryId)) return fail();
  }
  return parsed;
}
function validate(v: unknown, workspaceId: string): BackupOperationRecord {
  if (!object(v) || !exact(v, ['version', 'revision', 'operation', 'reservedBytes', 'restoreHeld', 'references'], ['allocations', 'cleanupHold']) || v.version !== 1 || !integer(v.revision, 1) || !integer(v.reservedBytes) ||
      v.reservedBytes > PRIVATE_BACKUP_OPERATION_LIMITS.reservationBytes || typeof v.restoreHeld !== 'boolean' || !object(v.references) || !exact(v.references, [], ['capture', 'preview', 'prepared'])) return fail();
  const op = parsePrivateBackupTransferOperation(v.operation); if (!op || op.workspaceId !== workspaceId) return fail();
  // A busy reason is live status only. Older services accept exactly {code}
  // and would hold every saved operation if a reason were ever persisted.
  if (op.error?.reason !== undefined) return fail();
  for (const [name, ref] of Object.entries(v.references)) if (!reference(ref, name === 'prepared')) return fail();
  if (op.kind === 'export' && (v.references.preview || v.references.prepared || v.restoreHeld) || op.kind === 'upload' && v.references.capture) return fail();
  if (op.phase === 'completed' && (op.kind !== 'upload' || !v.restoreHeld || !v.references.prepared)) return fail();
  if (restorePhases.has(op.phase) && !v.restoreHeld || v.restoreHeld && (op.canCancel || ['cancelled', 'expired'].includes(op.phase)) || v.restoreHeld && op.phase !== 'completed' && !v.reservedBytes) return fail();
  if (v.references.capture && (v.references.capture as BackupCatalogReference).workspaceId !== workspaceId) return fail();
  if (v.references.preview && op.preview && (v.references.preview as BackupCatalogReference).workspaceId !== op.preview.workspaceId) return fail();
  if (v.references.prepared && (!v.restoreHeld || !v.references.preview || (v.references.prepared as BackupPreparedReference).workspaceId !== (v.references.preview as BackupCatalogReference).workspaceId)) return fail();
  const parsedAllocations = parseAllocations(v.allocations, op.kind, v.reservedBytes, v.references as BackupOperationRecord['references']);
  if (v.cleanupHold !== undefined && (!object(v.cleanupHold) || !exact(v.cleanupHold, ['pid']) || !integer(v.cleanupHold.pid, 1))) return fail();
  if (Buffer.byteLength(JSON.stringify(v)) > PRIVATE_BACKUP_OPERATION_LIMITS.recordBytes) return fail();
  return { version: 1, revision: v.revision, operation: op, reservedBytes: v.reservedBytes, restoreHeld: v.restoreHeld, references: structuredClone(v.references), ...(parsedAllocations ? { allocations: parsedAllocations } : {}), ...(v.cleanupHold ? { cleanupHold: structuredClone(v.cleanupHold) } : {}) } as BackupOperationRecord;
}
async function privateDirectory(directory: string): Promise<void> {
  const root = parse(directory).root; let current = root; const missing: string[] = [];
  for (const part of directory.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    try { const s = await lstat(current); if (!s.isDirectory() || s.isSymbolicLink()) fail(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; missing.push(current); }
  }
  // Every level created here, on first use the shared private-backup-v2 root as
  // well as this store's own folder, gets its own protected Windows descriptor
  // in one process; a folder that already existed stays verify-only.
  const created: string[] = [];
  for (const folder of missing) {
    try { await mkdir(folder, { mode: 0o700 }); created.push(folder); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid?.())) fail();
  if (created.length) restrictNewSync(created.map(path => ({ path, kind: 'directory' as const })));
  else await windowsFilePrivacy(directory, 'directory');
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
  const limits = { ...PRIVATE_BACKUP_OPERATION_LIMITS, ...options.limits }, now = options.now ?? Date.now, newId = options.randomId ?? randomUUID;
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
    let records = 0, workspaceRecords = 0, active = 0, reservedBytes = 0; const resourceIds = new Set<string>();
    for (const row of rows()) { const r = rowRecord(row); records++; const current = r.operation.workspaceId === options.workspaceId; workspaceRecords += Number(current);
      for (const allocation of r.allocations ?? []) for (const id of [allocation.id, allocation.nonce]) { if (resourceIds.has(id)) fail(); resourceIds.add(id); }
      active += Number(current && !closedPhases.has(r.operation.phase)); reservedBytes += r.reservedBytes; }
    if (records > limits.records || !integer(reservedBytes) || reservedBytes > limits.reservationBytes) fail();
    return { records, workspaceRecords, active, reservedBytes };
  };
  const save = (record: BackupOperationRecord) => db.prepare('INSERT OR REPLACE INTO operations VALUES(?,?,?)').run(record.operation.id, record.revision, encode(record));
  const stamp = () => { const value = now(); if (!integer(value, 1)) fail('The backup clock is unavailable.'); return value; };
  const persist = (before: BackupOperationRecord, workspace: string, edit: (next: BackupOperationRecord) => void) => {
    const next = structuredClone(before);
    edit(next);
    next.revision = before.revision + 1;
    next.operation.updatedAt = Math.max(stamp(), before.operation.updatedAt);
    validate(next, workspace);
    save(next);
    return structuredClone(next);
  };
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
    create(operation: PrivateBackupTransferOperation, reservedBytes: number, resourceOptions?: { trackResources: true }): BackupOperationRecord {
      return tx(() => {
        assertOwner();
        if (resourceOptions !== undefined && (!object(resourceOptions) || !exact(resourceOptions, ['trackResources']) || resourceOptions.trackResources !== true)) fail('Invalid backup resource tracking.', 400);
        const record = validate({ version: 1, revision: 1, operation, reservedBytes, restoreHeld: false, references: {}, ...(resourceOptions ? { allocations: [] } : {}) }, options.workspaceId);
        if (operation.phase !== (operation.kind === 'export' ? 'capturing' : 'uploading') || !reservedBytes) fail('Invalid new backup operation.', 400);
        const existing = db.prepare('SELECT id FROM operations WHERE id=?').get(operation.id);
        if (existing) { const before = read(operation.id); if (before.operation.workspaceId !== options.workspaceId || before.operation.kind !== operation.kind || operation.kind === 'upload' && before.operation.progress.totalBytes !== operation.progress.totalBytes || resourceOptions && !before.allocations) fail('This operation identifier belongs to a different request.', 409); return before; }
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
        if (JSON.stringify(next.allocations) !== JSON.stringify(before.allocations)) fail();
        if (JSON.stringify(next.cleanupHold) !== JSON.stringify(before.cleanupHold)) fail('Backup cleanup holds require process-exit recovery.', 409);
        if ((before.allocations || before.cleanupHold) && next.reservedBytes < before.reservedBytes) fail('Restore storage must remain reserved until completion and cleanup.', 409);
        if (before.operation.phase === 'completed' && next.reservedBytes !== before.reservedBytes) fail('Restore storage must remain reserved until completion and cleanup.', 409);
        if (next.allocations) {
          for (const name of ['capture', 'preview', 'prepared'] as const) {
            const ref = next.references[name]; if (!ref) continue;
            if (JSON.stringify(ref) !== JSON.stringify(before.references[name]) || restorePhases.has(next.operation.phase)) {
              if (!next.allocations.some(a => a.role === name && a.state === 'allocated' && a.id === ref.directoryId)) fail();
            }
          }
        }
        if (before.operation.kind === 'upload' && (next.operation.progress.totalBytes !== before.operation.progress.totalBytes || next.operation.receivedBytes! < before.operation.receivedBytes!)) fail();
        const used = totals(); if (used.reservedBytes - before.reservedBytes + next.reservedBytes > limits.reservationBytes) fail('Backup temporary storage is fully reserved.', 507);
        save(next); return structuredClone(next);
      });
    },
    /** Creates a retained allocation. Identifiers are generated here; callers
     * never supply paths, passphrases or business values. */
    allocate(id: string, revision: number, request: { role: BackupResourceRole; bytes: number }) {
      return tx(() => {
        assertOwner(); const before = read(id); if (before.operation.workspaceId !== options.workspaceId) fail('This backup operation was not found.', 404);
        if (before.revision !== revision) fail('Backup progress changed. Check the saved operation before retrying.', 409);
        if (closedPhases.has(before.operation.phase)) fail('This backup transition is unavailable.', 409);
        if (before.cleanupHold) fail('This backup operation requires process-exit recovery.', 409);
        if (!object(request) || !exact(request, ['role', 'bytes'])) fail('Invalid backup allocation.', 400);
        const role = request.role, bytes = request.bytes;
        if (!(RESOURCE_KIND[before.operation.kind] as readonly string[]).includes(role) || !integer(bytes, 1) || bytes > PRIVATE_BACKUP_OPERATION_LIMITS.reservationBytes) fail('Invalid backup operation.', 400);
        if (before.restoreHeld && (before.operation.phase !== 'staging' || before.references.prepared || role !== 'prepared' && role !== 'build')) fail('Restore artifacts must be retained for recovery.', 409);
        const existing = before.allocations ?? [];
        if (existing.length >= 32) fail('Saved backup operations have reached their limit. Review existing operations first.', 409);
        if (existing.some(a => a.state !== 'removed' && a.role === role)) fail('This backup transition is unavailable.', 409);
        const liveBytes = existing.reduce((sum, a) => a.state === 'removed' ? sum : sum + a.bytes, 0);
        if (!integer(liveBytes + bytes) || liveBytes + bytes > before.reservedBytes) fail('Backup temporary storage is fully reserved.', 507);
        const allocationId = newId(), allocationNonce = newId();
        if (!privateBackupTransferId(allocationId) || !privateBackupTransferId(allocationNonce)) fail('Invalid backup operation.', 400);
        if (allocationId === allocationNonce) fail('This operation identifier belongs to a different request.', 409);
        for (const row of rows()) {
          for (const a of rowRecord(row).allocations ?? []) {
            if (a.id === allocationId || a.nonce === allocationNonce || a.id === allocationNonce || a.nonce === allocationId) fail('This operation identifier belongs to a different request.', 409);
          }
        }
        return persist(before, options.workspaceId, next => {
          next.allocations = [...(next.allocations ?? []), { id: allocationId, nonce: allocationNonce, role, bytes, state: 'allocated' }];
        });
      });
    },
    /** Marks a retained allocation deleting. Does not imply writers are idle;
     * callers must abort, drain and close before removing files. Never releases
     * reservedBytes. */
    beginResourceCleanup(id: string, revision: number, allocationId: string) {
      return tx(() => {
        assertOwner(); const before = read(id);
        if (before.revision !== revision) fail('Backup progress changed. Check the saved operation before retrying.', 409);
        if (!privateBackupTransferId(allocationId)) fail('Invalid backup operation.', 400);
        const current = before.allocations?.find(a => a.id === allocationId); if (!current) fail('Invalid backup operation.', 400);
        if (!allocationCleanupEligible(before, options.workspaceId, current)) fail('This backup transition is unavailable.', 409);
        if (current.state !== 'allocated') return structuredClone(before);
        return persist(before, before.operation.workspaceId, next => { next.allocations!.find(a => a.id === allocationId)!.state = 'deleting'; });
      });
    },
    /** Caller invokes only after strict filesystem removal and fsync. Keeps
     * identity and bytes for audit; does not lower reservedBytes. */
    finishResourceCleanup(id: string, revision: number, allocationId: string) {
      return tx(() => {
        assertOwner(); const before = read(id);
        if (before.revision !== revision) fail('Backup progress changed. Check the saved operation before retrying.', 409);
        if (!privateBackupTransferId(allocationId)) fail('Invalid backup operation.', 400);
        const current = before.allocations?.find(a => a.id === allocationId); if (!current) fail('Invalid backup operation.', 400);
        if (!allocationCleanupEligible(before, options.workspaceId, current)) fail('This backup transition is unavailable.', 409);
        if (current.state === 'removed') return structuredClone(before);
        if (current.state !== 'deleting') fail('This backup transition is unavailable.', 409);
        return persist(before, before.operation.workspaceId, next => { next.allocations!.find(a => a.id === allocationId)!.state = 'removed'; });
      });
    },
    /** Sets reservedBytes to 0 after every retained allocation is removed, or
     * when nothing was ever allocated. Sole path that lowers reservation on
     * allocation-aware and completed records. */
    releaseCleanedReservation(id: string, revision: number) {
      return tx(() => {
        assertOwner(); const before = read(id);
        if (before.revision !== revision) fail('Backup progress changed. Check the saved operation before retrying.', 409);
        if (!closedPhases.has(before.operation.phase) || !cleanupEligible(before, options.workspaceId)) fail('This backup transition is unavailable.', 409);
        if (!before.allocations || before.allocations.some(a => a.state !== 'removed')) fail('Backup storage has no complete cleanup record. Its reservation was retained.', 409);
        if (!before.reservedBytes) return structuredClone(before);
        return persist(before, before.operation.workspaceId, next => { next.reservedBytes = 0; });
      });
    },
    /** Internal page of records whose files or reservations still need cleanup.
     * Includes foreign terminal work; public get/list still hide those. */
    cleanupCandidates(pageOptions: { limit?: number; after?: string } = {}) {
      assertOwner(); const limit = pageOptions.limit ?? 20;
      if (!integer(limit, 1) || limit > 20 || pageOptions.after !== undefined && !privateBackupTransferId(pageOptions.after)) fail('Invalid backup operation page.', 400);
      const result: BackupOperationRecord[] = []; let next: string | null = null, total = 0;
      for (const row of rows()) {
        const record = rowRecord(row);
        if (!cleanupEligible(record, options.workspaceId) || !record.reservedBytes && !(record.allocations ?? []).some(a => a.state !== 'removed')) continue;
        total++;
        if (record.operation.id <= (pageOptions.after ?? '')) continue;
        if (result.length === limit) { next = result.at(-1)!.operation.id; continue; }
        result.push(record);
      }
      return { items: result, next, total };
    },
    /** Internal only: permits retirement cleanup under the original owner.
     * Never use this read for a customer operation/status response. */
    getCleanupRecord(id: string) {
      assertOwner(); const record = read(id);
      if (!cleanupEligible(record, options.workspaceId)) fail('This backup must retain its files for recovery.', 409);
      return record;
    },
    /** Persisted before reporting a handle-close failure. Only confirmed exit
     * permits subsequent automatic cleanup; generic updates cannot clear it. */
    holdResourceCleanup(id: string, revision: number) {
      return tx(() => {
        assertOwner(); const before = read(id);
        if (before.operation.workspaceId !== options.workspaceId) fail('This backup operation was not found.', 404);
        if (before.revision !== revision) fail('Backup progress changed. Check the saved operation before retrying.', 409);
        if (before.cleanupHold) return before;
        return persist(before, before.operation.workspaceId, next => { next.cleanupHold = { pid: process.pid }; });
      });
    },
    /** The filesystem helper re-reads this binding at every awaited boundary.
     * Foreign ownership is admitted only for eligible internal cleanup. */
    resourceBinding(id: string, allocationId: string, action: 'read' | 'claim' | 'remove') {
      assertOwner(); const record = read(id);
      if (!['read', 'claim', 'remove'].includes(action) || !privateBackupTransferId(allocationId)) fail('Invalid backup allocation.', 400);
      const current = record.operation.workspaceId === options.workspaceId, allocation = record.allocations?.find(a => a.id === allocationId);
      if (!allocation || !current && !cleanupEligible(record, options.workspaceId)) fail('This backup resource was not found.', 404);
      if (action === 'claim' && (!current || record.cleanupHold || closedPhases.has(record.operation.phase) || allocation.state !== 'allocated' ||
        record.restoreHeld && (record.operation.phase !== 'staging' || record.references.prepared || allocation.role !== 'prepared' && allocation.role !== 'build'))) fail('This backup allocation no longer accepts files.', 409);
      if (action === 'remove' && (!allocationCleanupEligible(record, options.workspaceId, allocation) || allocation.state !== 'deleting')) fail('Save eligible cleanup intent before removing backup files.', 409);
      return { operationId: id, workspaceId: record.operation.workspaceId, allocation: structuredClone(allocation) };
    },
    /** Cancels foreign, unheld, nonterminal records after control.workspaceId
     * changes. Strips public artifact/preview; keeps owner, refs, allocations
     * and reservation so cleanup can finish. */
    retireForeign() {
      return tx(() => {
        assertOwner(); const targets: BackupOperationRecord[] = [];
        for (const row of rows()) {
          const before = rowRecord(row);
          if (before.operation.workspaceId === options.workspaceId || before.restoreHeld || closedPhases.has(before.operation.phase)) continue;
          targets.push(before);
        }
        for (const before of targets) persist(before, before.operation.workspaceId, next => {
          next.operation.phase = 'cancelled'; next.operation.canCancel = false; next.operation.requiresPassphrase = false;
          delete next.operation.artifact; delete next.operation.preview;
        });
        return targets.length;
      });
    },
    /** Only removes old terminal metadata whose artifact cleanup already
     * released all reservations. Never removes staged/restore-held evidence. */
    prune(beforeTime: number): number {
      return tx(() => {
        assertOwner(); if (!integer(beforeTime, 1)) fail('Invalid backup retention time.', 400);
        const ids: string[] = [];
        for (const row of rows()) {
          const r = rowRecord(row);
          if (r.cleanupHold && !cleanupEligible(r, options.workspaceId)) continue;
          if (r.reservedBytes || (r.allocations ?? []).some(a => a.state !== 'removed') || r.operation.updatedAt >= beforeTime) continue;
          if (r.operation.phase === 'completed' || !r.restoreHeld && ['cancelled', 'expired'].includes(r.operation.phase)) ids.push(r.operation.id);
        }
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
