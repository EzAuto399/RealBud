Bounded implementation proposal. No tools or external actions. Own ONLY server/private-backup-operations.ts and its .test.ts. You are not alone; preserve unrelated changes. Codex is implementing a separate filesystem resource helper. Return JSON {summary,patch,risks}, unified diff for only those2files. Keep scope tight. User requests Grok4.6 xhigh substantially; Codex integrates and tests.

Implement durable resource allocations and internal cleanup lifecycle in existing encrypted journal. No new generic framework, no HTTP changes, no filesystem deletions in this module.
Contract to export:
 type BackupResourceRole = 'capture'|'decoded'|'preview'|'prepared'|'archive'|'build'|'upload';
 interface BackupResourceAllocation { id:string; nonce:string; role:BackupResourceRole; bytes:number; state:'allocated'|'deleting'|'removed' }
 Add optional allocations?:BackupResourceAllocation[] to BackupOperationRecord, preserving missing field on legacy records. New allocate() creates list; limit32 retained allocations per operation. ids/nonces are generated in allocate using randomUUID, immutable. bytes positive safe <=global reservation32GiB, role allowed by operation kind(export capture/archive; upload decoded/preview/prepared/build/upload), sum bytes of non-removed allocations <=record.reservedBytes. One non-removed allocation per role. No arbitrary paths/business values/passphrase/keys. Filesystem marker binds {version:1, operationId,workspaceId (original operation owner), allocation: {id,nonce,role,bytes}}; its state is deliberately not part of marker. Role maps to fixed existing directories, prepared stays DATA/private-backup-v2/prepared/<allocation.id>.

Methods (all owner/CAS/deep-clone safe):
 allocate(id,revision,{role,bytes}) ->record: current-workspace only; phase must be active and !restoreHeld, except adding prepared/build while staging but no prepared reference yet may be needed; simplest allow nonterminal and refuse same-kind duplicate, held input only staging with no prepared reference. No allocations after completed/cancelled/expired. Generated ids globally unique across retained journal allocations; reject collision rather than reuse.
 beginResourceCleanup(id,revision,allocationId) ->record: internal read-any-workspace but eligible only (phase cancelled/expired/completed) OR current-workspace phase failed/interrupted AND !restoreHeld. ALL restoreHeld non-completed refused. Changes allocated->deleting; same deleting idempotent under current revision; removed is idempotent. This method never signals writer quiescence: caller must abort/drain/close before physical deletion. Do not release bytes here.
 finishResourceCleanup(id,revision,allocationId) ->record: caller invoked only after strict filesystem removal+fsync. Requires deleting (removed idempotent), eligibility same; state->removed. Retain bytes/identity in audit allocation; keep reservedBytes unchanged here.
 releaseCleanedReservation(id,revision) ->record: terminal cancelled/expired/completed only; every allocation removed, or no allocations AND no references/artifact ever allocated (new failure before files). Retain refs/original owner/restoreHeld for completed. Sets reservedBytes=0 only. Legacy records with refs but no allocations refused. No explicit proof flag in generic update.
 cleanupCandidates({limit?,after?}) ->{items,next,total}: internal, max20, any-owner records eligible for cleanup; no customer route. Include terminal with reservation>0 or nonremoved allocs, and current failed/interrupted if !held, not staged or uncertain held. Public get/update/list remain404 foreign.
 retireForeign() ->number: internal owner tx; for all foreign original-owner records that are not held and not already terminal, mark cancelled, canCancel=false,requiresPassphrase=false, remove public artifact/preview (parser forbids cancelled artifact), keep references/allocations/reservation/original owner. This permits safe cleanup after encrypted cold completion changed control.workspaceId. Do not alter held incomplete restores.
 prune(beforeTime): additionally allows completed (incl held) only if reservation0 AND all allocationsremoved; keep historical refs until prune. No deletion of metadata whose resources remain allocated/deleting.

Generic update must not alter allocations (compare exact after callback), must not lower reservation on an allocation-aware record or any completed record; specialized release is sole path for those. For legacy no-allocation, non-held cancellation existing test behavior may remain until public coordinator alwaysallocates. Preserve completion proof as sole transition to completed. Existing constructor exact cold proof ingestion, publication/link crash handling, immutable restore refs and public scope must remain.

Reference compatibility: refs may exist on legacy records without allocations; they are retained but ineligible for automatic file cleanup. For new records with allocations, when adding capture/preview/prepared reference its directoryId must match the corresponding live allocation(rolecapture/preview/prepared). Catalog/store UUID is generated later by catalog/prepared class, not allocation id. Do not require semantic sealed state in allocations; exact component reference and existingphase rules cover that. Allocation cleanup must freeze identity and cannot delete refs needed by unfinished restores. Restarter should retain deleting states; no auto-removal assumption.

Tests should cover allocate/reopen/CAS/immutable snapshots/sum quota/one-role-active/invalid role/generic tamper; cancelled/failed cleanup retains reservation until finish+release; deleting survives restart; stage-held cleanup refused even foreign; encrypted cold completion allows completed cleanup without public old-history exposure; foreign nonheld retire preservesowner/ref/reservations; prune after all removed only; legacy unowned ref cleanup/release staysheld; generated collision refuses. Use existing fake encrypted proof seams for journal domain tests; don't claim file deletion or actual host behavior.


### server/private-backup-operations.ts
```typescript
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

### server/private-backup-operations.test.ts
```typescript
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createBackupOperationStore, type BackupOperationStore, type BackupOperationRecord, type BackupOperationStoreOptions } from './private-backup-operations.ts';
import type { PrivateBackupTransferOperation } from '../shared/private-backup-transfers.ts';
import { encryptJson, decryptJson } from './desk-crypto.ts';
import { PRIVATE_BACKUP_COMPLETION_FILE, type BackupColdCompletion } from './private-backup-completion.ts';

const roots: string[] = [], stores: BackupOperationStore[] = [];
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const archiveWorkspace = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const folder = () => { const root = mkdtempSync(join(realpathSync(tmpdir()), 'RealBud operation journal Ω ')); roots.push(root); return root; };
async function setup(options: Partial<BackupOperationStoreOptions> = {}) {
  const settings = { directory: join(folder(), 'operations'), workspaceId, key: randomBytes(32), now: () => 1000, ...options };
  const store = await createBackupOperationStore(settings); stores.push(store); return { store, settings };
}
function operation(kind: 'export' | 'upload' = 'export', id: string = randomUUID()): PrivateBackupTransferOperation {
  return { version: 2, id, workspaceId, kind, phase: kind === 'export' ? 'capturing' : 'uploading', createdAt: 10, updatedAt: 10, expiresAt: null,
    progress: { completedBytes: 0, totalBytes: kind === 'upload' ? 123 : null }, canCancel: true, requiresPassphrase: false,
    ...(kind === 'upload' ? { receivedBytes: 0, prefixCommitment: digest('[]') } : {}) };
}
function change(store: BackupOperationStore, record: BackupOperationRecord, update: (record: BackupOperationRecord) => void) { return store.update(record.operation.id, record.revision, update); }
function reviewed(store: BackupOperationStore, restoredWorkspaceId = archiveWorkspace) {
  let r = store.create(operation('upload'), 100);
  r = change(store, r, next => { next.operation.phase = 'uploaded'; next.operation.receivedBytes = 123; next.operation.progress.completedBytes = 123;
    next.operation.artifact = { archiveBytes: 123, archiveDigest: digest('fixture ciphertext') }; next.operation.requiresPassphrase = true; });
  r = change(store, r, next => { next.operation.phase = 'checking'; next.operation.requiresPassphrase = false; });
  return change(store, r, next => { next.operation.phase = 'reviewed'; next.operation.preview = { digest: next.operation.artifact!.archiveDigest, workspaceId: restoredWorkspaceId,
    createdAt: '2026-09-21T00:00:00.000Z', fileCount: 2, recordCount: 0, plainBytes: 30, included: ['Private saved work'], excluded: ['Credentials'], restoreChanges: ['Pause work'] };
    next.references.preview = { directoryId: randomUUID(), catalogId: randomUUID(), workspaceId: restoredWorkspaceId, digest: digest('catalog'), createdAt: '2026-09-21T00:00:00.000Z', databasePresent: false }; });
}
function staged(store: BackupOperationStore, restoredWorkspaceId = archiveWorkspace) {
  let r = reviewed(store, restoredWorkspaceId);
  r = change(store, r, next => { next.operation.phase = 'staging'; next.operation.canCancel = false; next.restoreHeld = true;
    next.references.prepared = { directoryId: randomUUID(), storeId: randomUUID(), workspaceId: restoredWorkspaceId, digest: digest('prepared') }; });
  return change(store, r, next => { next.operation.phase = 'staged'; });
}
function coldProof(record: BackupOperationRecord): BackupColdCompletion {
  const p = record.references.prepared!;
  return { version: 1, operationId: record.operation.id, previousWorkspaceId: record.operation.workspaceId, workspaceId: p.workspaceId,
    directoryId: p.directoryId, storeId: p.storeId, preparedDigest: p.digest, receipt: record.operation.preview!, restoredAt: '2026-09-21T12:00:00.000Z' };
}
function writeColdProof(directory: string, key: Buffer, proof: BackupColdCompletion) {
  mkdirSync(join(directory, 'company-installation'), { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, 'company-installation/workspace.json'), JSON.stringify({ version: 1, id: proof.workspaceId, workerMemberKey: null }), { mode: 0o600 });
  writeFileSync(join(directory, PRIVATE_BACKUP_COMPLETION_FILE), JSON.stringify(encryptJson(key, proof)), { mode: 0o600 });
}
afterEach(() => { vi.restoreAllMocks(); for (const s of stores.splice(0)) { try { s.close(); } catch { /* intentional corrupted/moved fixture */ } } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('durable private backup operation records', () => {
  it('keeps encrypted records, immutable snapshots, revision checks and request replay', async () => {
    const { store, settings } = await setup();
    const input = operation(), first = store.create(input, 100);
    input.progress.completedBytes = 50; first.operation.progress.completedBytes = 80;
    expect(store.get(input.id).operation.progress.completedBytes).toBe(0);
    const copy = store.get(input.id); copy.references.capture = { directoryId: randomUUID(), catalogId: randomUUID(), workspaceId, digest: digest('source'), createdAt: '2026-09-21T00:00:00.000Z', databasePresent: false };
    expect(store.get(input.id).references).toEqual({});
    const next = change(store, store.get(input.id), r => { r.operation.phase = 'sealing'; r.references = copy.references; });
    expect(next.revision).toBe(2); expect(next.operation.updatedAt).toBe(1000);
    expect(() => store.update(input.id, 1, r => { r.operation.phase = 'failed'; })).toThrow(/progress changed/i);
    expect(store.create(operation('export', input.id), 100)).toEqual(next);
    expect(() => store.create(operation('upload', input.id), 100)).toThrow(/different request/);
    expect(store.usage()).toMatchObject({ records: 1, active: 1, reservedBytes: 100 });
    const bytes = readFileSync(join(settings.directory, 'operations.sqlite'));
    expect(bytes.includes(settings.key)).toBe(false); expect(bytes.includes(Buffer.from(workspaceId))).toBe(false);
    expect(bytes.includes(Buffer.from('sealing'))).toBe(false); expect(bytes.includes(Buffer.from(copy.references.capture!.digest))).toBe(false);
    if (process.platform !== 'win32') expect(statSync(join(settings.directory, 'operations.sqlite')).mode & 0o777).toBe(0o600);
  });

  it('atomically refuses quota overbooking and retains reservations after cancellation until cleanup', async () => {
    const { store } = await setup({ limits: { records: 3, active: 2, reservationBytes: 200 } });
    let first = store.create(operation(), 120);
    expect(() => store.create(operation(), 90)).toThrow(/fully reserved/);
    const second = store.create(operation(), 80);
    expect(() => store.create(operation(), 1)).toThrow(/reached their limit/);
    expect(() => change(store, second, r => { r.reservedBytes = 81; })).toThrow(/fully reserved/);
    expect(store.get(second.operation.id)).toEqual(second);
    first = change(store, first, r => { r.operation.phase = 'cancelled'; r.operation.canCancel = false; });
    expect(store.prune(1001)).toBe(0); expect(store.usage().reservedBytes).toBe(200);
    first = change(store, first, r => { r.reservedBytes = 0; });
    expect(store.prune(1000)).toBe(0); expect(store.prune(1001)).toBe(1);
    expect(() => store.get(first.operation.id)).toThrow(/not found/); expect(store.usage()).toMatchObject({ records: 1, reservedBytes: 80 });
    expect(store.create(operation(), 120).reservedBytes).toBe(120);
  });

  it('refuses identity changes, non-transactional callbacks and unsupported private metadata', async () => {
    const { store } = await setup(), first = store.create(operation(), 100);
    for (const mutation of [
      (r: BackupOperationRecord) => { r.operation.id = randomUUID(); },
      (r: BackupOperationRecord) => { r.operation.workspaceId = randomUUID(); },
      (r: BackupOperationRecord) => { r.operation.createdAt++; },
      (r: BackupOperationRecord) => { Object.assign(r.references, { path: '/private/never-serialize', passphrase: 'never-save-this' }); },
      (r: BackupOperationRecord) => { Object.assign(r.operation, { secret: 'do-not-save' }); },
    ]) { expect(() => change(store, first, mutation)).toThrow(); expect(store.get(first.operation.id)).toEqual(first); }
    expect(() => change(store, first, async r => { await Promise.resolve(); r.reservedBytes = 0; throw new Error('asynchronous edit'); })).toThrow(/synchronously/);
    await Promise.resolve(); expect(store.get(first.operation.id)).toEqual(first);
    expect(() => change(store, first, r => { r.operation.phase = 'uploaded'; })).toThrow();
  });

  it('cannot advertise completion for a failed export or advance upload progress backwards', async () => {
    const { store } = await setup();
    let exportRecord = store.create(operation(), 10);
    exportRecord = change(store, exportRecord, r => { r.operation.phase = 'failed'; });
    expect(() => change(store, exportRecord, r => { r.operation.phase = 'completed'; r.operation.canCancel = false; r.operation.progress = { completedBytes: 123, totalBytes: 123 }; r.operation.artifact = { archiveBytes: 123, archiveDigest: digest('export') }; })).toThrow();
    let upload = store.create(operation('upload'), 10);
    upload = change(store, upload, r => { r.operation.receivedBytes = 123; r.operation.progress.completedBytes = 123; });
    expect(() => change(store, upload, r => { r.operation.receivedBytes = 0; r.operation.progress.completedBytes = 0; })).toThrow();
    expect(() => store.create({ ...operation('upload', upload.operation.id), progress: { completedBytes: 0, totalBytes: 124 } }, 10)).toThrow(/different request/);
  });

  it('retains restore-held artifacts across cancellation, pruning, reopen and failed apply', async () => {
    const { store, settings } = await setup(); let r = staged(store);
    expect(() => change(store, r, next => { next.restoreHeld = false; })).toThrow();
    expect(() => change(store, r, next => { next.operation.phase = 'cancelled'; delete next.operation.artifact; delete next.operation.preview; })).toThrow();
    expect(() => change(store, r, next => { next.reservedBytes = 0; })).toThrow();
    expect(store.prune(10_000)).toBe(0); store.close();
    const { store: reopened } = await setup(settings); expect(reopened.get(r.operation.id)).toEqual(r);
    r = change(reopened, r, next => { next.operation.phase = 'applying'; });
    r = change(reopened, r, next => { next.operation.phase = 'failed'; delete next.operation.preview; next.operation.error = { code: 'recovery-required' }; });
    expect(r.restoreHeld).toBe(true); expect(r.references.prepared).toBeDefined();
    expect(() => change(reopened, r, next => { next.operation.phase = 'checking'; })).toThrow(/retained/);
    expect(reopened.prune(10_000)).toBe(0);
  });

  it('freezes reviewed and prepared identities through completion and retains reservations until cleanup', async () => {
    const { store, settings } = await setup(); let r = staged(store, workspaceId);
    expect(() => change(store, r, next => { next.operation.phase = 'completed'; })).toThrow(/transition/);
    expect(() => change(store, r, next => { next.references.prepared!.storeId = randomUUID(); })).toThrow(/retained/);
    expect(() => change(store, r, next => { delete next.references.prepared; })).toThrow(/retained/);
    r = change(store, r, next => { next.operation.phase = 'applying'; });
    expect(() => change(store, r, next => { next.operation.phase = 'completed'; next.operation.artifact!.archiveDigest = digest('different'); next.operation.preview!.digest = digest('different'); })).toThrow();
    expect(() => change(store, r, next => { next.operation.phase = 'completed'; })).toThrow(/transition/);
    expect(store.get(r.operation.id)).toEqual(r);
    const directory = folder(); store.close(); writeColdProof(directory, settings.key, coldProof(r));
    const { store: reopened } = await setup({ ...settings, restoreDirectory: directory });
    r = reopened.get(r.operation.id);
    expect(r.operation.phase).toBe('completed');
    expect(r.reservedBytes).toBe(100); expect(r.restoreHeld).toBe(true); expect(reopened.prune(10_000)).toBe(0);
  });

  it('reconciles an authenticated cold completion without relabelling old transfers or releasing their disk reservations', async () => {
    const { store, settings } = await setup({ limits: { reservationBytes: 200 } }), directory = folder();
    const oldExport = store.create(operation(), 100), restored = staged(store), proof = coldProof(restored); store.close();
    writeColdProof(directory, settings.key, proof);
    const { store: reopened } = await setup({ ...settings, workspaceId: archiveWorkspace, restoreDirectory: directory });
    expect(reopened.list()).toEqual({ items: [], total: 0, next: null });
    expect(() => reopened.get(oldExport.operation.id)).toThrow(/not found/); expect(() => reopened.get(restored.operation.id)).toThrow(/not found/);
    expect(reopened.usage()).toMatchObject({ records: 2, workspaceRecords: 0, active: 0, reservedBytes: 200 });
    expect(() => reopened.create({ ...operation(), workspaceId: archiveWorkspace }, 1)).toThrow(/fully reserved/);
    const db = new DatabaseSync(join(settings.directory, 'operations.sqlite'), { readOnly: true });
    try {
      const row = db.prepare('SELECT payload FROM operations WHERE id=?').get(restored.operation.id)!;
      expect(decryptJson(settings.key, JSON.parse(String(row.payload)))).toMatchObject({ restoreHeld: true, reservedBytes: 100, operation: { workspaceId, phase: 'completed', artifact: restored.operation.artifact } });
    } finally { db.close(); }
    reopened.close(); const again = await setup({ ...settings, workspaceId: archiveWorkspace }); expect(again.store.list().total).toBe(0);
  });

  it('reconciles a same-workspace completion once without changing it on a later restart', async () => {
    const { store, settings } = await setup(), directory = folder(), r = staged(store, workspaceId); store.close();
    writeColdProof(directory, settings.key, coldProof(r));
    const { store: reopened } = await setup({ ...settings, restoreDirectory: directory });
    const completed = reopened.get(r.operation.id); expect(completed.operation.phase).toBe('completed'); expect(completed.revision).toBe(r.revision + 1);
    reopened.close(); const { store: again } = await setup({ ...settings, now: () => 2000, restoreDirectory: directory });
    expect(again.get(r.operation.id)).toEqual(completed);
  });

  it('replays a completion whose journal commit outlived its process before proof consumption', async () => {
    const { store, settings } = await setup(), directory = folder(), r = staged(store); store.close();
    writeColdProof(directory, settings.key, coldProof(r));
    const module = pathToFileURL(join(process.cwd(), 'server/private-backup-operations.ts')).href;
    const program = `import { createBackupOperationStore } from ${JSON.stringify(module)}; let text=''; for await(const chunk of process.stdin) text+=chunk; const { key, ...settings }=JSON.parse(text); await createBackupOperationStore({...settings,key:Buffer.from(key,'hex'),fault(point){if(point==='completion-committed'){process.stdout.write('committed\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}}});`;
    const next = { ...settings, workspaceId: archiveWorkspace, restoreDirectory: directory };
    const envModule: string = '../scripts/service-smoke-env.mjs'; const { serviceSmokeEnv } = await import(envModule);
    const child = spawn(process.execPath, ['--input-type=module', '-e', program], { env: serviceSmokeEnv({ executable: process.execPath, home: directory, data: directory, scratch: directory, port: 0 }), stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '', timer: ReturnType<typeof setTimeout> | undefined;
    const closed = new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject); });
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2000); });
    const ready = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Fixture completion did not commit: ${errors}`)), 5000);
      child.stdout.on('data', chunk => { output = (output + chunk).slice(-100); if (output.includes('committed\n')) resolve(); });
      void closed.then(() => reject(new Error(`Fixture completion exited: ${errors}`)), reject);
    });
    child.stdin.end(JSON.stringify({ ...next, key: settings.key.toString('hex') }));
    try { await ready; expect(existsSync(join(directory, PRIVATE_BACKUP_COMPLETION_FILE))).toBe(true); await expect(createBackupOperationStore(next)).rejects.toThrow(/Another running service/); }
    finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; }
    const { store: reopened } = await setup(next);
    expect(reopened.list().total).toBe(0); expect(reopened.usage().reservedBytes).toBe(100);
    expect(existsSync(join(directory, PRIVATE_BACKUP_COMPLETION_FILE))).toBe(false);
    const db = new DatabaseSync(join(settings.directory, 'operations.sqlite'), { readOnly: true });
    try { expect(db.prepare('SELECT revision FROM operations WHERE id=?').get(r.operation.id)?.revision).toBe(r.revision + 1); } finally { db.close(); }
  }, 15_000);

  it.each(['absent', 'plaintext', 'wrong-key', 'previous-workspace', 'archive-workspace', 'operation', 'prepared', 'archive-digest', 'pending-stage', 'changed-workspace'])('refuses %s reconciliation evidence and retains the journal', async fault => {
    const { store, settings } = await setup(), directory = folder(), r = staged(store), proof = coldProof(r); store.close();
    if (fault === 'previous-workspace') proof.previousWorkspaceId = randomUUID();
    if (fault === 'archive-workspace') { proof.workspaceId = randomUUID(); proof.receipt = { ...proof.receipt, workspaceId: proof.workspaceId }; }
    if (fault === 'operation') proof.operationId = randomUUID();
    if (fault === 'prepared') proof.preparedDigest = digest('different prepared data');
    if (fault === 'archive-digest') proof.receipt = { ...proof.receipt, digest: digest('different archive') };
    writeColdProof(directory, fault === 'wrong-key' ? randomBytes(32) : settings.key, proof);
    if (fault === 'plaintext') writeFileSync(join(directory, PRIVATE_BACKUP_COMPLETION_FILE), JSON.stringify(proof));
    if (fault === 'absent') rmSync(join(directory, PRIVATE_BACKUP_COMPLETION_FILE));
    if (fault === 'pending-stage') writeFileSync(join(directory, 'private-workspace-restore-v2.json'), 'unfinished', { mode: 0o600 });
    if (fault === 'changed-workspace') writeFileSync(join(directory, 'company-installation/workspace.json'), JSON.stringify({ version: 1, id: randomUUID(), workerMemberKey: null }));
    const before = readFileSync(join(settings.directory, 'operations.sqlite'));
    await expect(createBackupOperationStore({ ...settings, workspaceId: archiveWorkspace, restoreDirectory: directory })).rejects.toThrow();
    expect(readFileSync(join(settings.directory, 'operations.sqlite'))).toEqual(before);
    const { store: old } = await setup(settings); expect(old.get(r.operation.id)).toEqual(r);
  });

  it('interrupts dead computations on reopen while keeping sealed upload evidence and requesting the passphrase again', async () => {
    const { store, settings } = await setup(); const exp = store.create(operation(), 20);
    let uploaded = store.create(operation('upload'), 20);
    uploaded = change(store, uploaded, r => { r.operation.receivedBytes = 123; r.operation.progress.completedBytes = 123; r.operation.artifact = { archiveBytes: 123, archiveDigest: digest('ciphertext') }; r.operation.phase = 'uploaded'; });
    uploaded = change(store, uploaded, r => { r.operation.phase = 'checking'; });
    store.close(); const { store: reopened } = await setup(settings);
    expect(reopened.get(exp.operation.id).operation).toMatchObject({ phase: 'interrupted', requiresPassphrase: true, error: { code: 'interrupted' } });
    expect(reopened.get(uploaded.operation.id).operation).toMatchObject({ phase: 'interrupted', requiresPassphrase: true, artifact: uploaded.operation.artifact, receivedBytes: 123 });
    expect(reopened.usage().reservedBytes).toBe(40);
  });

  it('paginates stable operation identities with bounded pages and refuses unknown workspace/key reuse', async () => {
    const { store, settings } = await setup({ limits: { active: 4 } });
    const records = Array.from({ length: 4 }, () => store.create(operation(), 1));
    const first = store.list({ limit: 2 }), last = store.list({ limit: 2, after: first.next! });
    expect(first.total).toBe(4); expect(last.next).toBeNull();
    expect([...first.items, ...last.items].map(r => r.operation.id)).toEqual(records.map(r => r.operation.id).sort());
    expect(() => store.list({ limit: 21 })).toThrow(/Invalid/); expect(() => store.list({ after: '../path' })).toThrow(/Invalid/);
    store.close(); const bytes = readFileSync(join(settings.directory, 'operations.sqlite'));
    await expect(createBackupOperationStore({ ...settings, workspaceId: archiveWorkspace })).rejects.toThrow(/recovery/);
    await expect(createBackupOperationStore({ ...settings, key: randomBytes(32) })).rejects.toThrow(/recovery/);
    expect(readFileSync(join(settings.directory, 'operations.sqlite'))).toEqual(bytes);
    await setup(settings);
  });

  it('refuses a second owner in the same process without changing the active journal', async () => {
    const { store, settings } = await setup(), r = store.create(operation(), 20);
    await expect(createBackupOperationStore(settings)).rejects.toThrow(/Another running service/);
    expect(store.get(r.operation.id)).toEqual(r);
  });

  it('admits only one of two simultaneous initializers and keeps the winning journal usable', async () => {
    const settings = { directory: join(folder(), 'operations'), key: randomBytes(32), workspaceId };
    const attempts = await Promise.allSettled([createBackupOperationStore(settings), createBackupOperationStore(settings)]);
    const opened = attempts.flatMap(result => result.status === 'fulfilled' ? [result.value] : []); stores.push(...opened);
    expect(opened).toHaveLength(1); expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);
    const saved = opened[0].create(operation(), 10); expect(opened[0].get(saved.operation.id)).toEqual(saved);
  });

  it.each(['initial-ready', 'initial-linked'] as const)('recovers after an actual process kill at %s without treating a partial database as initialized', async point => {
    const root = folder(), settings = { directory: join(root, 'operations'), key: randomBytes(32), workspaceId };
    const module = pathToFileURL(join(process.cwd(), 'server/private-backup-operations.ts')).href;
    const program = `import { createBackupOperationStore } from ${JSON.stringify(module)}; let text=''; for await(const chunk of process.stdin) text+=chunk; const { key, point, ...settings }=JSON.parse(text); await createBackupOperationStore({...settings,key:Buffer.from(key,'hex'),fault(at){if(at===point){process.stdout.write('initializing\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}}});`;
    const envModule: string = '../scripts/service-smoke-env.mjs'; const { serviceSmokeEnv } = await import(envModule);
    const child = spawn(process.execPath, ['--input-type=module', '-e', program], { env: serviceSmokeEnv({ executable: process.execPath, home: root, data: root, scratch: root, port: 0 }), stdio: ['pipe', 'pipe', 'pipe'] });
    let errors = '', output = '', timer: ReturnType<typeof setTimeout> | undefined;
    const closed = new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject); });
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2000); });
    const ready = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Fixture initializer did not start: ${errors}`)), 5000);
      child.stdout.on('data', chunk => { output = (output + chunk).slice(-100); if (output.includes('initializing\n')) resolve(); });
      void closed.then(() => reject(new Error(`Fixture initializer exited: ${errors}`)), reject);
    });
    child.stdin.end(JSON.stringify({ ...settings, key: settings.key.toString('hex'), point }));
    try { await ready; if (point === 'initial-linked') expect(statSync(join(settings.directory, 'operations.sqlite')).size).toBeGreaterThan(0); }
    finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; }
    const { store } = await setup(settings); expect(store.usage()).toMatchObject({ records: 0, reservedBytes: 0 });
    const saved = store.create(operation(), 10); expect(store.get(saved.operation.id)).toEqual(saved);
    expect(statSync(join(settings.directory, 'operations.sqlite')).nlink).toBe(1);
  }, 15_000);

  it('preserves an empty pre-existing fixed journal rather than assuming that it never contained records', async () => {
    const root = folder(); writeFileSync(join(root, 'operations.sqlite'), '', { mode: 0o600 });
    await expect(createBackupOperationStore({ directory: root, key: randomBytes(32), workspaceId })).rejects.toThrow(/recovery/);
    expect(readFileSync(join(root, 'operations.sqlite')).length).toBe(0);
  });

  it('refuses swapped files, extra schema and malformed encrypted rows without replacing original evidence', async () => {
    const { store, settings } = await setup(), path = join(settings.directory, 'operations.sqlite'); store.create(operation(), 10); store.close();
    const db = new DatabaseSync(path); db.exec('CREATE TABLE unexpected (value TEXT)'); db.close();
    const bytes = readFileSync(path); await expect(createBackupOperationStore(settings)).rejects.toThrow(/recovery/); expect(readFileSync(path)).toEqual(bytes);
    const second = await setup(), row = second.store.create(operation(), 10), secondPath = join(second.settings.directory, 'operations.sqlite');
    const sql = new DatabaseSync(secondPath); sql.prepare('UPDATE operations SET payload=? WHERE id=?').run('not-encrypted', row.operation.id); sql.close();
    expect(() => second.store.get(row.operation.id)).toThrow(/recovery/);
    const third = await setup(), thirdPath = join(third.settings.directory, 'operations.sqlite');
    renameSync(thirdPath, `${thirdPath}.saved`); const replacement = new DatabaseSync(thirdPath); replacement.close();
    expect(() => third.store.usage()).toThrow(/recovery/);
  });

  it.skipIf(process.platform === 'win32')('refuses public or multiply linked journal files', async () => {
    const { store, settings } = await setup(), path = join(settings.directory, 'operations.sqlite'); store.close();
    chmodSync(path, 0o644); await expect(createBackupOperationStore(settings)).rejects.toThrow(/recovery/);
    chmodSync(path, 0o600); linkSync(path, `${path}.hardlink`); await expect(createBackupOperationStore(settings)).rejects.toThrow(/recovery/);
    rmSync(`${path}.hardlink`); renameSync(path, `${path}.original`); symlinkSync(`${path}.original`, path); await expect(createBackupOperationStore(settings)).rejects.toThrow(/recovery/);
  });

  it('survives an actual killed owner and refuses takeover while that owner remains alive', async () => {
    const root = folder(), settings = { directory: join(root, 'operations'), key: randomBytes(32), workspaceId };
    const initial = operation(), module = pathToFileURL(join(process.cwd(), 'server/private-backup-operations.ts')).href;
    const program = `import { createBackupOperationStore } from ${JSON.stringify(module)}; let text=''; for await(const chunk of process.stdin) text+=chunk; const { key, initial, ...settings }=JSON.parse(text); const store=await createBackupOperationStore({...settings,key:Buffer.from(key,'hex')}); store.create(initial,100); process.stdout.write('owned\\n'); setInterval(()=>{},1000);`;
    const envModule: string = '../scripts/service-smoke-env.mjs'; const { serviceSmokeEnv } = await import(envModule);
    const child = spawn(process.execPath, ['--input-type=module', '-e', program], { env: serviceSmokeEnv({ executable: process.execPath, home: root, data: root, scratch: root, port: 0 }), stdio: ['pipe', 'pipe', 'pipe'] });
    let errors = '', output = '', timer: ReturnType<typeof setTimeout> | undefined;
    const closed = new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject); });
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2000); });
    const ready = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Fixture owner did not start: ${errors}`)), 5000);
      child.stdout.on('data', chunk => { output = (output + chunk).slice(-100); if (output.includes('owned\n')) resolve(); });
      void closed.then(() => reject(new Error(`Fixture owner exited: ${errors}`)), reject);
    });
    child.stdin.end(JSON.stringify({ ...settings, key: settings.key.toString('hex'), initial }));
    try { await ready; await expect(createBackupOperationStore(settings)).rejects.toThrow(/Another running service/); }
    finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; }
    const { store } = await setup(settings);
    expect(store.get(initial.id).operation).toMatchObject({ phase: 'interrupted', requiresPassphrase: true });
    expect(store.usage()).toMatchObject({ records: 1, reservedBytes: 100 });
  }, 15_000);
});

```

### shared/private-backup-transfers.ts
```typescript
import { parsePrivateBackupReceipt, type PrivateBackupReceipt } from './private-workspace-backup.ts';

/** Public transport projections only. Never include scratch paths, keys,
 * passphrases, raw exceptions, or uploaded business values here. */
export const PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES = 1024 * 1024;
export const PRIVATE_BACKUP_TRANSFER_MAX_BYTES = 1024 * 1024 * 1024;
export const PRIVATE_BACKUP_TRANSFER_MAX_ITEMS = 20;
export const PRIVATE_BACKUP_TRANSFER_API = '/api/private-backup/v2';
export const PRIVATE_BACKUP_TRANSFER_PHASES = [
  'capturing', 'sealing', 'ready', 'uploading', 'uploaded', 'checking', 'reviewed',
  'staging', 'staged', 'applying', 'completed', 'interrupted', 'failed', 'cancelled', 'expired',
] as const;
export type PrivateBackupTransferPhase = typeof PRIVATE_BACKUP_TRANSFER_PHASES[number];
export const PRIVATE_BACKUP_TRANSFER_ERRORS = {
  interrupted: 'This backup operation was interrupted. Check its saved progress before continuing.',
  'invalid-backup': 'This file could not be verified as a complete supported backup. Keep the original file.',
  'incorrect-passphrase': 'The backup could not be opened with that passphrase. Check it and try again.',
  'storage-unavailable': 'Backup storage is unavailable. Keep the original file and check this computer.',
  'insufficient-space': 'This computer needs more free space before the backup can continue.',
  'workspace-busy': 'Finish the current work before continuing this backup operation.',
  'restore-unavailable': 'This workspace is not ready to restore this backup.',
  'recovery-required': 'This backup operation needs recovery. Keep its files and contact support.',
  expired: 'This saved transfer has expired. Keep the original backup file.',
} as const;
export type PrivateBackupTransferErrorCode = keyof typeof PRIVATE_BACKUP_TRANSFER_ERRORS;
export interface PrivateBackupTransferArtifact { archiveBytes: number; archiveDigest: string }
export interface PrivateBackupTransferOperation {
  version: 2; id: string; workspaceId: string; kind: 'export' | 'upload';
  phase: PrivateBackupTransferPhase; createdAt: number; updatedAt: number; expiresAt: number | null;
  progress: { completedBytes: number; totalBytes: number | null };
  canCancel: boolean; requiresPassphrase: boolean;
  /** Required for upload operations, including interrupted/closed ones. */
  receivedBytes?: number; prefixCommitment?: string;
  artifact?: PrivateBackupTransferArtifact;
  /** Published only after complete authentication AND business graph validation. */
  preview?: PrivateBackupReceipt;
  error?: { code: PrivateBackupTransferErrorCode };
}
export interface PrivateBackupTransferPage {
  version: 2; workspaceId: string;
  limits: { archiveBytes: number; chunkBytes: typeof PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES };
  items: PrivateBackupTransferOperation[]; total: number; nextCursor: string | null;
}
export interface PrivateBackupDownloadTicket extends PrivateBackupTransferArtifact {
  url: string; filename: string; expiresAt: number;
}
/** SHA-256 of UTF-8 JSON.stringify(tuples), in this exact order, with lowercase
 * digests. At most 1024 tuples; this is NOT the whole-file archive digest. */
export type PrivateBackupChunkTuple = [offset: number, size: number, sha256: string];

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const integer = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && Number(v) >= min;
export const privateBackupTransferId = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
export const privateBackupTransferDigest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function artifact(v: unknown): PrivateBackupTransferArtifact | null {
  return object(v) && keys(v, ['archiveBytes', 'archiveDigest']) && integer(v.archiveBytes, 1) && v.archiveBytes <= PRIVATE_BACKUP_TRANSFER_MAX_BYTES && privateBackupTransferDigest(v.archiveDigest)
    ? { archiveBytes: v.archiveBytes, archiveDigest: v.archiveDigest } : null;
}
function receipt(v: unknown): PrivateBackupReceipt | null {
  if (!object(v) || !keys(v, ['digest', 'createdAt', 'workspaceId', 'fileCount', 'recordCount', 'plainBytes', 'included', 'excluded', 'restoreChanges'])) return null;
  const parsed = parsePrivateBackupReceipt(v);
  if (!parsed || parsed.createdAt.length > 40) return null;
  // Human-readable category labels, not filenames, evidence bodies, or errors.
  if ([parsed.included, parsed.excluded, parsed.restoreChanges].some(list => list.length > 20 || list.some(s => !s.trim() || new TextEncoder().encode(s).length > 300 || /[\u0000-\u001f\u007f]/.test(s)))) return null;
  return parsed;
}
export function parsePrivateBackupTransferOperation(v: unknown): PrivateBackupTransferOperation | null {
  if (!object(v) || !keys(v, ['version', 'id', 'workspaceId', 'kind', 'phase', 'createdAt', 'updatedAt', 'expiresAt', 'progress', 'canCancel', 'requiresPassphrase'], ['receivedBytes', 'prefixCommitment', 'artifact', 'preview', 'error']) ||
      v.version !== 2 || !privateBackupTransferId(v.id) || !privateBackupTransferId(v.workspaceId) || typeof v.kind !== 'string' || !['export', 'upload'].includes(v.kind) ||
      !PRIVATE_BACKUP_TRANSFER_PHASES.includes(v.phase as PrivateBackupTransferPhase) || !integer(v.createdAt, 1) || !integer(v.updatedAt, v.createdAt) ||
      !(v.expiresAt === null || integer(v.expiresAt, v.createdAt)) || typeof v.canCancel !== 'boolean' || typeof v.requiresPassphrase !== 'boolean' ||
      !object(v.progress) || !keys(v.progress, ['completedBytes', 'totalBytes']) || !integer(v.progress.completedBytes) ||
      !(v.progress.totalBytes === null || integer(v.progress.totalBytes, v.progress.completedBytes))) return null;
  const phase = v.phase as PrivateBackupTransferPhase;
  if (['staging', 'staged', 'applying', 'completed', 'cancelled', 'expired'].includes(phase) && v.canCancel) return null;
  if (v.requiresPassphrase && !['interrupted', 'failed', 'uploaded'].includes(phase)) return null;
  if (v.kind === 'upload') {
    const size = v.progress.totalBytes;
    if (!integer(size, 1) || size > PRIVATE_BACKUP_TRANSFER_MAX_BYTES || !integer(v.receivedBytes) || v.receivedBytes > size ||
        v.receivedBytes !== size && v.receivedBytes % PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES !== 0 || !privateBackupTransferDigest(v.prefixCommitment) ||
        ['capturing', 'ready'].includes(phase)) return null;
    if (['uploaded', 'checking', 'reviewed', 'staging', 'staged', 'applying', 'completed'].includes(phase) && v.receivedBytes !== size) return null;
    if (v.requiresPassphrase && v.receivedBytes !== size) return null;
  } else if (Object.hasOwn(v, 'receivedBytes') || Object.hasOwn(v, 'prefixCommitment') || ['uploading', 'uploaded', 'checking', 'reviewed', 'staging', 'staged', 'applying'].includes(phase)) return null;
  const parsedArtifact = v.artifact === undefined ? undefined : artifact(v.artifact);
  if (parsedArtifact === null || parsedArtifact && v.kind === 'upload' && parsedArtifact.archiveBytes !== v.progress.totalBytes) return null;
  if (parsedArtifact && ['capturing', 'uploading', 'cancelled', 'expired'].includes(phase)) return null;
  if (['ready', 'uploaded', 'checking', 'reviewed', 'staging', 'staged', 'applying', 'completed'].includes(phase) && !parsedArtifact) return null;
  const parsedPreview = v.preview === undefined ? undefined : receipt(v.preview);
  if (parsedPreview === null || parsedPreview && (!parsedArtifact || !['ready', 'reviewed', 'staging', 'staged', 'applying', 'completed'].includes(phase))) return null;
  if (parsedPreview && parsedPreview.digest !== parsedArtifact?.archiveDigest) return null;
  if (['reviewed', 'staging', 'staged', 'applying'].includes(phase) && !parsedPreview) return null;
  if (v.error !== undefined && (!object(v.error) || !keys(v.error, ['code']) || typeof v.error.code !== 'string' || !Object.hasOwn(PRIVATE_BACKUP_TRANSFER_ERRORS, v.error.code))) return null;
  return {
    version: 2, id: v.id, workspaceId: v.workspaceId, kind: v.kind as 'export' | 'upload', phase,
    createdAt: v.createdAt, updatedAt: v.updatedAt, expiresAt: v.expiresAt as number | null,
    progress: { completedBytes: v.progress.completedBytes, totalBytes: v.progress.totalBytes as number | null },
    canCancel: v.canCancel, requiresPassphrase: v.requiresPassphrase,
    ...(v.kind === 'upload' ? { receivedBytes: v.receivedBytes as number, prefixCommitment: v.prefixCommitment as string } : {}),
    ...(parsedArtifact ? { artifact: parsedArtifact } : {}), ...(parsedPreview ? { preview: parsedPreview } : {}),
    ...(v.error ? { error: { code: (v.error as { code: PrivateBackupTransferErrorCode }).code } } : {}),
  };
}
export function parsePrivateBackupTransferResponse(v: unknown): PrivateBackupTransferOperation | null {
  return object(v) && keys(v, ['operation']) ? parsePrivateBackupTransferOperation(v.operation) : null;
}
export function parsePrivateBackupTransferPage(v: unknown): PrivateBackupTransferPage | null {
  if (!object(v) || !keys(v, ['version', 'workspaceId', 'limits', 'items', 'total', 'nextCursor']) || v.version !== 2 || !privateBackupTransferId(v.workspaceId) ||
      !object(v.limits) || !keys(v.limits, ['archiveBytes', 'chunkBytes']) || !integer(v.limits.archiveBytes, 1) || v.limits.archiveBytes > PRIVATE_BACKUP_TRANSFER_MAX_BYTES || v.limits.chunkBytes !== PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES ||
      !Array.isArray(v.items) || v.items.length > PRIVATE_BACKUP_TRANSFER_MAX_ITEMS || !integer(v.total, v.items.length) ||
      !(v.nextCursor === null || typeof v.nextCursor === 'string' && /^[a-zA-Z0-9_-]{1,512}$/.test(v.nextCursor))) return null;
  const items = v.items.map(parsePrivateBackupTransferOperation);
  if (items.some(item => !item || item.workspaceId !== v.workspaceId) || new Set(items.map(item => item?.id)).size !== items.length) return null;
  return { version: 2, workspaceId: v.workspaceId, limits: { archiveBytes: v.limits.archiveBytes, chunkBytes: PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES }, items: items as PrivateBackupTransferOperation[], total: v.total, nextCursor: v.nextCursor as string | null };
}
export function parsePrivateBackupDownloadTicket(v: unknown): PrivateBackupDownloadTicket | null {
  if (!object(v) || !keys(v, ['url', 'filename', 'expiresAt', 'archiveBytes', 'archiveDigest']) || typeof v.url !== 'string' ||
      !/^\/api\/private-backup\/v2\/downloads\/[A-Za-z0-9_-]{32,128}$/.test(v.url) || typeof v.filename !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}\.realbud-backup$/.test(v.filename) || !integer(v.expiresAt, 1)) return null;
  const a = artifact({ archiveBytes: v.archiveBytes, archiveDigest: v.archiveDigest });
  return a ? { ...a, url: v.url, filename: v.filename, expiresAt: v.expiresAt } : null;
}

```
