You are a bounded implementation architect for RealBud. No tools/actions; source packet only. Codex owns code and tests. The user asks Grok 4.6 xhigh specialist work throughout the goal. Propose a concrete minimal implementation for resource ownership, cleanup and aggregate physical disk admission in the upcoming v2 backup coordinator. Use existing modules; do not invent another generic storage framework. Output JSON: decisions, exact minimal schema/API changes, pseudocode ordered protocols for admission/retry/cancel/restart/cold-complete/retention, top failure tests, remaining constraints. Concise <=4500 words. No thoughts or generic recommendations.

Context: public HTTP/client v2 contract exists but is NOT wired. An operation journal keeps cross-workspace history encrypted under destination key. Exact cold completion proof permits new header workspace identity, retains old operation owner and positive reservation, consumes proof only after journal commit. Current get/update/list reject foreign owners. Need clean completed artifacts after verified restore without leaking old operation history, safely retire prior-owner non-held export/upload resources, and prune metadata only after owned bytes deleted. Staged/applying/uncertain restore artifacts must never be removed. Journal currently stores sealed references only so interrupted creation needs durable ownership before artifact bytes. Avoid inferring ownership from UUID filename alone; don't recursively delete an unverified arbitrary tree or treat a damaged marker as empty. New public v2 stages must bind operation. Legacy v1 restore with an existing v2 journal must not permanently strand journal identity; do not suggest trusting plaintext historical receipt.

Physical budget: new catalog code being implemented by another specialist exports catalogStorageBudget(limits) => {databaseBytes,rollbackBytes,totalBytes} and caps main DB via verified PRAGMA max_page_count, reopen physical checks. Catalog plaintext up to1GiB/100kentries in coordinator; generic higher legacy limits exist. Prepared store cap3GiB main+rollback overhead, bytecap1GiB. Builder main cap1GiB (new optional smaller databaseBytes) fixed4096pages; temp_storeMEMORY and typedSQLITE_FULL. Uploaded/export archive max1GiB. Operation and transfer journals64MiB each. Need reserve worst-case peak, statfs free-space admission (avoid treating check as actual OS reservation), bounded scan/ownership for existing orphans and no releasing reservations before files actually removed. Multi-op32GiB max ledger/fouractive; enforce component ceilings and carry ownership/limits across restart. Avoid blanket cap2x formulas that ignore journal per-page and spill headers; cap checks are source-level not native Windows certification. Prepared builder in current source makes random scratchdir then finally recursive-rm; fix ownership if interrupted. No current customer artifacts of this unreleased internal module, but v1 customer archives stay supported.

Useful scope: deterministic fixed parent dirs with per-resource UUID; exact private authenticated resource marker/journal allocation before create, no callerpaths. Retain original owned references after completion for auditable cleanup without exposing through customer routes. Preserve retries/lostresponse/processdeath; explicitly identify writer-quiescence and Windows open-handle constraints. Public cancel intent must persist before abort/drain/delete; do not delete behind a live writer. Ordinary business files are outside temporary artifact cleanup. Prefer simple APIs consistent with existing service conventions.


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

### server/private-backup-transfer.ts
```typescript
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { encryptJson, decryptJson, isEncryptedEnvelope } from './desk-crypto.ts';
import { windowsFilePrivacy } from './windows-file-privacy.ts';
import { fsyncDir } from './atomic.ts';

export const BACKUP_TRANSFER_CHUNK_BYTES = 1024 * 1024;
export const BACKUP_TRANSFER_MAX_BYTES = 1024 * 1024 * 1024;
export const BACKUP_TRANSFER_JOURNAL_BYTES = 64 * 1024 * 1024;
export const BACKUP_TRANSFER_CANCEL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ACTIVE = 4;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
function fail(message: string, status = 409): never { throw Object.assign(new Error(message), { status }); }
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && Number(v) >= min;
interface Chunk { offset: number; size: number; digest: string }
export interface BackupUploadStatus {
  id: string; size: number; offset: number; state: 'uploading' | 'uploaded' | 'staged' | 'cancelled';
  createdAt: number; updatedAt: number; digest: string | null; manifestDigest: string | null;
  /** Commitment to the exact durably accepted prefix, for reselected files. */
  prefixDigest: string;
}
interface Upload extends Omit<BackupUploadStatus, 'prefixDigest'> { version: 1; workspaceId: string; pending: Chunk | null }
type FaultPoint = 'intent-saved' | 'data-written' | 'data-synced' | 'recovery-before-sync' | 'receipt-saved' | 'cancel-saved';
export interface BackupTransferOptions {
  /** An installation-owned directory, never a browser-provided path. */
  directory: string; key: Buffer; workspaceId: string;
  now?: () => number;
  /** Test-only interruption hook. No serialized value can configure it. */
  fault?: (point: FaultPoint, id: string) => void;
}

async function safeParents(path: string): Promise<void> {
  const absolute = resolve(path), root = parse(absolute).root; let current = root;
  for (const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    try { const s = await lstat(current); if (!s.isDirectory() || s.isSymbolicLink()) fail('Backup transfer storage needs recovery.', 503); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
async function privateFolder(path: string): Promise<void> {
  await safeParents(path);
  const created = await mkdir(path, { recursive: true, mode: 0o700 }), s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink() || process.platform !== 'win32' && ((s.mode & 0o077) || s.uid !== process.getuid?.())) fail('Backup transfer storage is not private.', 503);
  await windowsFilePrivacy(path, 'directory', created !== undefined);
}
async function checkedFile(path: string, absent = false) {
  await safeParents(dirname(path));
  try {
    const s = await lstat(path);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || process.platform !== 'win32' && ((s.mode & 0o077) || s.uid !== process.getuid?.())) fail('Backup transfer file needs recovery.', 503);
    await windowsFilePrivacy(path, 'file'); return s;
  } catch (error) { if (absent && (error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function checkedHandle(path: string, flags: number) {
  const before = await checkedFile(path);
  const handle = await open(path, flags | (constants.O_NOFOLLOW ?? 0));
  try {
    const after = await handle.stat();
    if (!before || before.ino !== after.ino || before.dev !== after.dev || after.nlink !== 1) fail('Backup transfer changed while opening.', 503);
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
function validChunk(value: unknown): value is Chunk {
  return object(value) && Object.keys(value).length === 3 && integer(value.offset) && value.offset % BACKUP_TRANSFER_CHUNK_BYTES === 0 &&
    integer(value.size, 1) && value.size <= BACKUP_TRANSFER_CHUNK_BYTES && typeof value.digest === 'string' && HASH.test(value.digest);
}
function validUpload(value: unknown, workspaceId: string, id: string): value is Upload {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'createdAt,digest,id,manifestDigest,offset,pending,size,state,updatedAt,version,workspaceId' || value.version !== 1 || value.id !== id || value.workspaceId !== workspaceId ||
      !integer(value.size, 1) || value.size > BACKUP_TRANSFER_MAX_BYTES || !integer(value.offset) || value.offset > value.size ||
      !integer(value.createdAt, 1) || !integer(value.updatedAt, 1) || value.updatedAt < value.createdAt ||
      typeof value.state !== 'string' || !['uploading', 'uploaded', 'staged', 'cancelled'].includes(value.state)) return false;
  if (value.offset !== value.size && value.offset % BACKUP_TRANSFER_CHUNK_BYTES !== 0) return false;
  if (value.pending !== null && (!validChunk(value.pending) || value.pending.offset !== value.offset || value.pending.size !== Math.min(BACKUP_TRANSFER_CHUNK_BYTES, value.size - value.offset) || value.state !== 'uploading')) return false;
  const completed = value.state === 'uploaded' || value.state === 'staged';
  return completed ? value.offset === value.size && value.pending === null && typeof value.digest === 'string' && HASH.test(value.digest) && typeof value.manifestDigest === 'string' && HASH.test(value.manifestDigest)
    : value.digest === null && value.manifestDigest === null;
}
/** Fixed-size ciphertext transport only. Uploaded data remains untrusted until
 * the codec and complete business graph validate. A live process owns writes;
 * confirmed process exit, not a timeout, permits restart recovery. */
export async function createBackupTransferStore(options: BackupTransferOptions) {
  if (options.key.length !== 32 || !UUID.test(options.workspaceId)) fail('Invalid backup transfer installation.', 400);
  const directory = resolve(options.directory), now = options.now ?? Date.now;
  const nonce = randomUUID(), pid = process.pid;
  await privateFolder(directory);
  const journal = join(directory, 'transfers.sqlite');
  const existing = await checkedFile(journal, true);
  if (existing && existing.size > BACKUP_TRANSFER_JOURNAL_BYTES) fail('Backup transfer journal needs size recovery. Existing copies were preserved.', 503);
  if (!existing) { const file = await open(journal, 'wx', 0o600); try { await windowsFilePrivacy(journal, 'file', true); await file.sync(); } finally { await file.close(); } fsyncDir(directory); }
  const key = Buffer.from(options.key);
  let db: DatabaseSync;
  try { db = new DatabaseSync(journal); } catch (error) { key.fill(0); throw error; }
  let closed = false, closing = false, queued = 0, tail: Promise<unknown> = Promise.resolve();
  const transact = <T>(fn: () => T): T => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const encode = (value: unknown) => JSON.stringify(encryptJson(key, value));
  const decode = (payload: unknown): unknown => { try { const v = JSON.parse(String(payload)); if (!isEncryptedEnvelope(v)) throw new Error(); return decryptJson(key, v); } catch { return fail('Backup transfer journal needs recovery.', 503); } };
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1500;');
    const schema = db.prepare("SELECT type,name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
    if (existing && schema.some(row => row.type !== 'table' || !['owner', 'operations', 'chunks'].includes(String(row.name)))) fail('Backup transfer schema needs recovery.', 503);
    if (existing && Number(db.prepare('PRAGMA user_version').get()?.user_version) !== 1) fail('Backup transfer version needs recovery.', 503);
    if (!existing) db.exec('CREATE TABLE owner (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL); CREATE TABLE operations (id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE chunks (id TEXT NOT NULL, offset INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(id,offset)); PRAGMA user_version=1;');
    const pageBytes = Number(db.prepare('PRAGMA page_size').get()?.page_size);
    if (!Number.isSafeInteger(pageBytes) || pageBytes < 512 || pageBytes > 65_536) fail('Backup transfer page size needs recovery.', 503);
    db.exec(`PRAGMA max_page_count=${Math.floor(BACKUP_TRANSFER_JOURNAL_BYTES / pageBytes)};`);
    transact(() => {
      const previous = db.prepare('SELECT payload FROM owner WHERE id=1').get();
      if (previous) {
        const owner = decode(previous.payload);
        if (!object(owner) || Object.keys(owner).sort().join(',') !== 'nonce,pid,workspaceId' || owner.workspaceId !== options.workspaceId || !integer(owner.pid, 1) || typeof owner.nonce !== 'string' || !UUID.test(owner.nonce)) fail('Backup transfer ownership needs recovery.', 503);
        try { process.kill(owner.pid, 0); fail('Another running service owns these backup transfers.'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      db.prepare('INSERT OR REPLACE INTO owner VALUES(1,?)').run(encode({ pid, nonce, workspaceId: options.workspaceId }));
    });
  } catch (error) { db.close(); key.fill(0); throw error; }
  const assertOwner = () => {
    if (closed) fail('Backup transfers are closed.');
    const row = db.prepare('SELECT payload FROM owner WHERE id=1').get(), owner = row && decode(row.payload);
    if (!object(owner) || owner.pid !== pid || owner.nonce !== nonce || owner.workspaceId !== options.workspaceId) fail('Backup transfer ownership changed.', 503);
  };
  const run = <T>(work: () => Promise<T>): Promise<T> => {
    if (closing || closed || queued >= 8) return Promise.reject(Object.assign(new Error('Backup transfer is busy or closing. Check its saved status before retrying.'), { status: 409 }));
    queued++;
    const task = tail.then(async () => { assertOwner(); return work(); }).finally(() => { queued--; }); tail = task.catch(() => {}); return task;
  };
  const read = (id: string): Upload => {
    if (typeof id !== 'string' || !UUID.test(id)) fail('Invalid backup transfer.', 400);
    const row = db.prepare('SELECT payload FROM operations WHERE id=?').get(id);
    if (!row) fail('This backup transfer was not found.', 404);
    const value = decode(row.payload); if (!validUpload(value, options.workspaceId, id)) fail('Backup transfer receipt needs recovery.', 503); return value;
  };
  const save = (value: Upload) => {
    if (!validUpload(value, options.workspaceId, value.id)) fail('Backup transfer transition needs recovery.', 503);
    assertOwner(); db.prepare('INSERT OR REPLACE INTO operations VALUES(?,?)').run(value.id, encode(value));
  };
  const publicStatus = ({ version: _version, workspaceId: _workspace, pending: _pending, ...status }: Upload): BackupUploadStatus => {
    const manifest: [number, number, string][] = [];
    for (let offset = 0; offset < status.offset; offset += BACKUP_TRANSFER_CHUNK_BYTES) {
      const chunk = readChunk(status.id, offset);
      if (!chunk || chunk.size !== Math.min(BACKUP_TRANSFER_CHUNK_BYTES, status.size - offset)) fail('The saved upload prefix needs recovery.', 503);
      manifest.push([chunk.offset, chunk.size, chunk.digest]);
    }
    return { ...status, prefixDigest: hash(JSON.stringify(manifest)) };
  };
  const artifactPath = (id: string) => join(directory, `${id}.ciphertext`);
  const readChunk = (id: string, offset: number): Chunk | null => {
    const row = db.prepare('SELECT payload FROM chunks WHERE id=? AND offset=?').get(id, offset); if (!row) return null;
    const value = decode(row.payload);
    if (!object(value) || value.id !== id || !validChunk(value.chunk) || value.chunk.offset !== offset || Object.keys(value).length !== 2) fail('Backup chunk receipt needs recovery.', 503);
    return value.chunk;
  };
  const commitChunk = (upload: Upload, chunk: Chunk) => transact(() => {
    db.prepare('INSERT INTO chunks VALUES(?,?,?)').run(upload.id, chunk.offset, encode({ id: upload.id, chunk }));
    upload.offset += chunk.size; upload.pending = null; upload.updatedAt = Math.max(now(), upload.createdAt); save(upload);
  });
  async function reconcile(upload: Upload): Promise<Upload> {
    if (upload.state === 'cancelled') { if (await checkedFile(artifactPath(upload.id), true)) { await unlink(artifactPath(upload.id)); fsyncDir(directory); } return upload; }
    const stat = await checkedFile(artifactPath(upload.id), true);
    // Admission writes its receipt before exclusive file creation. A missing
    // zero-length upload can be recreated; partial/missing data cannot.
    if (!stat && upload.offset === 0 && !upload.pending && upload.state === 'uploading') {
      const handle = await open(artifactPath(upload.id), 'wx', 0o600); try { await windowsFilePrivacy(artifactPath(upload.id), 'file', true); await handle.sync(); } finally { await handle.close(); } fsyncDir(directory); return upload;
    }
    if (!stat) fail('Backup transfer data is missing. Keep the original backup and contact support.', 503);
    if (!upload.pending) { if (stat.size !== upload.offset) fail('Backup transfer data changed unexpectedly.', 503); return upload; }
    const pending = upload.pending;
    if (stat.size === upload.offset) { upload.pending = null; save(upload); return upload; }
    if (stat.size !== upload.offset + pending.size) fail('An interrupted backup chunk needs recovery. The original backup is unchanged.', 503);
    const handle = await checkedHandle(artifactPath(upload.id), constants.O_RDWR);
    try {
      const data = Buffer.alloc(pending.size); const result = await handle.read(data, 0, data.length, pending.offset);
      if (result.bytesRead !== data.length || hash(data) !== pending.digest) fail('An interrupted backup chunk failed its integrity check.', 503);
      // A previous full write may have died before fsync. Bytes visible in the
      // page cache are not a durable receipt until recovery syncs them too.
      options.fault?.('recovery-before-sync', upload.id); await handle.sync();
    }
    finally { await handle.close(); }
    commitChunk(upload, pending); return upload;
  }
  async function append(id: string, offset: number, data: Uint8Array, digest: string): Promise<BackupUploadStatus> {
    if (!(data instanceof Uint8Array) || !integer(offset) || !HASH.test(digest) || data.length < 1 || data.length > BACKUP_TRANSFER_CHUNK_BYTES || hash(data) !== digest) fail('The backup chunk is invalid.', 400);
    const upload = await reconcile(read(id));
    if (upload.state !== 'uploading') fail('This transfer no longer accepts upload chunks.');
    const chunk = { offset, size: data.length, digest }, prior = readChunk(id, offset);
    if (prior) { if (prior.size !== chunk.size || prior.digest !== chunk.digest) fail('This chunk differs from its saved receipt.'); return publicStatus(upload); }
    if (offset !== upload.offset || data.length !== Math.min(BACKUP_TRANSFER_CHUNK_BYTES, upload.size - upload.offset)) fail('Resume from the saved upload position with the original file.');
    upload.pending = chunk; save(upload); options.fault?.('intent-saved', id);
    const handle = await checkedHandle(artifactPath(id), constants.O_RDWR);
    try { let written = 0; while (written < data.length) { const part = await handle.write(data, written, data.length - written, offset + written); if (!part.bytesWritten) fail('Backup storage did not accept the chunk.', 503); written += part.bytesWritten; } options.fault?.('data-written', id); await handle.sync(); }
    finally { await handle.close(); }
    options.fault?.('data-synced', id); commitChunk(upload, chunk); options.fault?.('receipt-saved', id); return publicStatus(upload);
  }
  async function verifyArtifact(upload: Upload): Promise<void> {
    const handle = await checkedHandle(artifactPath(upload.id), constants.O_RDONLY), whole = createHash('sha256');
    try {
      const before = await handle.stat(), buffer = Buffer.alloc(BACKUP_TRANSFER_CHUNK_BYTES);
      for (let offset = 0; offset < upload.size;) {
        const part = await handle.read(buffer, 0, Math.min(buffer.length, upload.size - offset), offset);
        if (!part.bytesRead) fail('The completed backup is truncated.', 503);
        whole.update(buffer.subarray(0, part.bytesRead)); offset += part.bytesRead;
      }
      const after = await handle.stat();
      if (before.size !== upload.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || whole.digest('hex') !== upload.digest) fail('The completed backup bytes changed. Keep the original file and copy it again.', 503);
    } finally { await handle.close(); }
  }
  async function pruneCancelled(): Promise<number> {
    let removed = 0;
    // Only terminal transport receipts expire. Business history and staged or
    // otherwise active copies are never removed by this retention policy.
    for (const row of db.prepare('SELECT id FROM operations').iterate()) {
      const upload = read(String(row.id));
      if (upload.state !== 'cancelled' || now() - upload.updatedAt < BACKUP_TRANSFER_CANCEL_RETENTION_MS) continue;
      await reconcile(upload);
      transact(() => { db.prepare('DELETE FROM chunks WHERE id=?').run(upload.id); db.prepare('DELETE FROM operations WHERE id=?').run(upload.id); }); removed++;
    }
    return removed;
  }
  return {
    start(id: string, size: number) { return run(async () => {
      if (typeof id !== 'string' || !UUID.test(id) || !integer(size, 1) || size > BACKUP_TRANSFER_MAX_BYTES) fail('Choose a non-empty backup up to 1 GiB.', 400);
      if (db.prepare('SELECT id FROM operations WHERE id=?').get(id)) { const current = await reconcile(read(id)); if (current.size !== size || current.state === 'cancelled') fail('This upload identifier is already bound to another request.'); return publicStatus(current); }
      await pruneCancelled();
      let active = 0;
      for (const row of db.prepare('SELECT id FROM operations').iterate()) if (read(String(row.id)).state !== 'cancelled') active++;
      if (active >= MAX_ACTIVE) fail('Finish or remove an earlier backup transfer before starting another.');
      const at = now(), value: Upload = { version: 1, workspaceId: options.workspaceId, id, size, offset: 0, state: 'uploading', createdAt: at, updatedAt: at, digest: null, manifestDigest: null, pending: null };
      save(value); await reconcile(value); return publicStatus(value);
    }); },
    status(id: string) { return run(async () => publicStatus(await reconcile(read(id)))); },
    append(id: string, offset: number, data: Uint8Array, digest: string) {
      // Own the bounded bytes before entering the queue; callers cannot mutate
      // an admitted buffer while a previous operation is completing.
      if (!(data instanceof Uint8Array) || data.length > BACKUP_TRANSFER_CHUNK_BYTES) return Promise.reject(Object.assign(new Error('The backup chunk is too large.'), { status: 413 }));
      if (queued >= 8 || closing || closed) return Promise.reject(Object.assign(new Error('Check the saved transfer status before retrying.'), { status: 409 }));
      const owned = Buffer.from(data); return run(() => append(id, offset, owned, digest));
    },
    seal(id: string, manifestDigest: string) { return run(async () => {
      if (!HASH.test(manifestDigest)) fail('Check the complete upload before finishing.', 400);
      const upload = await reconcile(read(id));
      if (upload.state === 'uploaded' || upload.state === 'staged') { if (upload.manifestDigest !== manifestDigest) fail('The completed upload does not match this file.'); await verifyArtifact(upload); return publicStatus(upload); }
      if (upload.state !== 'uploading' || upload.offset !== upload.size) fail('The upload has not finished.');
      const manifest: [number, number, string][] = [], whole = createHash('sha256');
      const handle = await checkedHandle(artifactPath(id), constants.O_RDONLY);
      try {
        for (let offset = 0; offset < upload.size; offset += BACKUP_TRANSFER_CHUNK_BYTES) {
          const chunk = readChunk(id, offset), size = Math.min(BACKUP_TRANSFER_CHUNK_BYTES, upload.size - offset);
          if (!chunk || chunk.size !== size) fail('The complete upload is missing a chunk receipt.', 503);
          const data = Buffer.alloc(size), read = await handle.read(data, 0, size, offset);
          if (read.bytesRead !== size || hash(data) !== chunk.digest) fail('The uploaded backup failed its chunk check.', 503);
          whole.update(data); manifest.push([offset, size, chunk.digest]);
        }
        if ((await handle.stat()).size !== upload.size || hash(JSON.stringify(manifest)) !== manifestDigest) fail('The complete uploaded backup differs from the selected file.');
      } finally { await handle.close(); }
      upload.state = 'uploaded'; upload.digest = whole.digest('hex'); upload.manifestDigest = manifestDigest; upload.updatedAt = Math.max(now(), upload.createdAt); save(upload); return publicStatus(upload);
    }); },
    /** Internal only: the host must never return this server-generated path. */
    artifact(id: string) { return run(async () => { const upload = await reconcile(read(id)); if (!['uploaded', 'staged'].includes(upload.state)) fail('The backup upload is not complete.'); await verifyArtifact(upload); return { path: artifactPath(id), size: upload.size, digest: upload.digest! }; }); },
    markStaged(id: string, digest: string) { return run(async () => { const upload = await reconcile(read(id)); if (!['uploaded', 'staged'].includes(upload.state) || upload.digest !== digest) fail('The reviewed backup changed.'); await verifyArtifact(upload); upload.state = 'staged'; upload.updatedAt = Math.max(now(), upload.createdAt); save(upload); return publicStatus(upload); }); },
    cancel(id: string) { return run(async () => { const upload = read(id); if (upload.state === 'staged') fail('This backup is staged for restore and must be retained for restart recovery.'); upload.state = 'cancelled'; upload.pending = null; upload.digest = null; upload.manifestDigest = null; upload.updatedAt = Math.max(now(), upload.createdAt); save(upload); options.fault?.('cancel-saved', id); await reconcile(upload); return publicStatus(upload); }); },
    pruneCancelled() { return run(pruneCancelled); },
    async close() {
      closing = true; await tail; if (closed) return;
      try { assertOwner(); transact(() => { db.prepare('DELETE FROM owner WHERE id=1').run(); }); }
      finally { closed = true; db.close(); key.fill(0); }
    },
  };
}

```

### server/private-backup-completion.ts
```typescript
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

### server/private-backup-prepare.ts
```typescript
/** Materialize final randomized ciphertext once, before the compact stage is
 * published. Later restart recovery reads identical prepared bytes. */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rm } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PrivateBackupCatalog } from './private-backup-catalog.ts';
import { PrivateBackupPreparedStore } from './private-backup-prepared.ts';
import { privateBackupTargetPaths } from './private-backup-capture.ts';
import { privateRestoreTargetHash } from './private-backup-cold-restore.ts';
import { encryptJson } from './desk-crypto.ts';
import { WORKFLOW_MAX_ENCRYPTED_RECORD_LENGTH } from './workflow-database.ts';
import { windowsFilePrivacy } from './windows-file-privacy.ts';
import { fsyncDir } from './atomic.ts';

export const PRIVATE_BACKUP_BUILD_MAX_BYTES = 1024 ** 3;
const PAGE_BYTES = 4096;
function fail(message = 'The private restore could not be prepared. Existing business records were preserved.', status = 503): never { throw Object.assign(new Error(message), { status }); }
async function safeFolder(path: string) {
  const absolute = resolve(path), root = parse(absolute).root; let current = root;
  for (const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    try { const s = await lstat(current); if (!s.isDirectory() || s.isSymbolicLink()) fail(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const created = await mkdir(path, { recursive: true, mode: 0o700 }), stat = await lstat(path);
  if (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid?.())) fail();
  await windowsFilePrivacy(path, 'directory', created !== undefined);
}
async function* chunks(bytes: Buffer) { try { for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) yield bytes.subarray(offset, offset + 1024 * 1024); } finally { bytes.fill(0); } }
export async function preparePrivateBackupRestore(options: {
  directory: string; key: Buffer; source: PrivateBackupCatalog; prepared: PrivateBackupPreparedStore;
  databasePresent: boolean; assertLease: () => void; signal?: AbortSignal;
  onProgress?: (value: { files: number; bytes: number }) => void | Promise<void>;
  /** Internal storage admission limit; never a browser-supplied path or quota. */
  databaseBytes?: number;
}) {
  if (!Buffer.isBuffer(options.key) || options.key.length !== 32) fail();
  const databaseBytes = options.databaseBytes ?? PRIVATE_BACKUP_BUILD_MAX_BYTES;
  if (!Number.isSafeInteger(databaseBytes) || databaseBytes < 65_536 || databaseBytes > PRIVATE_BACKUP_BUILD_MAX_BYTES || databaseBytes % PAGE_BYTES) fail('The restore preparation capacity is invalid.', 400);
  const key = Buffer.from(options.key), directory = resolve(options.directory);
  const assert = () => {
    options.signal?.throwIfAborted(); const result: unknown = options.assertLease();
    if (result !== undefined) {
      if (result && typeof result === 'object' && 'then' in result) void Promise.resolve(result).catch(() => {});
      fail('The snapshot lease assertion must complete synchronously.', 500);
    }
  };
  let scratch: string | undefined;
  try {
    assert(); const source = options.source.summary(), target = options.prepared.summary();
    if (!source.sealed || target.sealed || target.entries || target.workspaceId !== source.workspaceId || !options.databasePresent && source.records) fail();
    options.source.validate();
    const remaining = new Set(await privateBackupTargetPaths(directory)); assert();
    let files = 0, bytes = 0;
    const added = async (size: number) => { files++; bytes += size; assert(); await options.onProgress?.({ files, bytes }); assert(); };
    for (const file of options.source.iterateFiles()) {
      assert();
      // JSON encoding is confined by catalog validation to Desk and the legacy
      // private-vault envelopes; all ordinary business bytes remain exact.
      const content = file.encoding === 'json' ? Buffer.from(JSON.stringify(encryptJson(key, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.data))))) : Buffer.from(file.data);
      const size = content.length, before = await privateRestoreTargetHash(join(directory, file.path)); assert();
      await options.prepared.addFile(file.path, before, chunks(content), { signal: options.signal }); assert();
      remaining.delete(file.path); await added(size);
    }
    if (options.databasePresent) {
      const parent = join(directory, 'private-backup-v2', 'build'); await safeFolder(parent); assert();
      scratch = join(parent, randomUUID()); await mkdir(scratch, { mode: 0o700 }); await windowsFilePrivacy(scratch, 'directory', true);
      const database = join(scratch, 'workflow-state.sqlite');
      const created = await open(database, 'wx', 0o600); await created.close(); await windowsFilePrivacy(database, 'file', true); assert();
      const db = new DatabaseSync(database);
      try {
        db.exec(`PRAGMA trusted_schema=OFF; PRAGMA page_size=${PAGE_BYTES}; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; PRAGMA cache_size=-2048; PRAGMA temp_store=MEMORY;`);
        if (db.prepare('PRAGMA page_size').get()?.page_size !== PAGE_BYTES || db.prepare(`PRAGMA max_page_count=${databaseBytes / PAGE_BYTES}`).get()?.max_page_count !== databaseBytes / PAGE_BYTES) fail('Restore preparation storage reached its capacity.', 413);
        db.exec('CREATE TABLE workflow_records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL); PRAGMA user_version=1; BEGIN IMMEDIATE;');
        const insert = db.prepare('INSERT INTO workflow_records VALUES(?,?,?,?)');
        for (const row of options.source.iterateRecords()) {
          assert(); const payload = JSON.stringify(encryptJson(key, row.value));
          if (payload.length > WORKFLOW_MAX_ENCRYPTED_RECORD_LENGTH) fail('A restored workflow record exceeds its storage limit. No restore was staged.');
          insert.run(row.id, row.kind, row.revision, payload);
        }
        db.exec('COMMIT');
      } catch (error) {
        // SQLITE_FULL may already have rolled back. Closing discards any
        // remaining transaction; no incomplete database enters the prepared store.
        if ((error as { errcode?: number }).errcode === 13) fail('Restore preparation storage reached its capacity. No restore was staged.', 413);
        throw error;
      } finally { db.close(); }
      const handle = await open(database, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await handle.stat(); if (before.size > databaseBytes || !before.isFile() || before.nlink !== 1) fail();
        const baseline = await privateRestoreTargetHash(join(directory, 'workflow-state.sqlite')); assert();
        async function* stream() {
          const buffer = Buffer.alloc(1024 * 1024); let offset = 0;
          try {
            while (offset < before.size) {
              assert(); const result = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset); assert();
              if (!result.bytesRead) fail(); offset += result.bytesRead; yield buffer.subarray(0, result.bytesRead);
            }
            const after = await handle.stat(); if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail();
          } finally { buffer.fill(0); }
        }
        await options.prepared.addFile('workflow-state.sqlite', baseline, stream(), { signal: options.signal }); assert();
        remaining.delete('workflow-state.sqlite'); await added(before.size);
      } finally { await handle.close(); }
    }
    for (const path of remaining) {
      assert(); const before = await privateRestoreTargetHash(join(directory, path)); assert(); if (before === null) fail();
      await options.prepared.addRemoval(path, before); assert();
    }
    const final = options.source.validate(); if (final.digest !== source.digest || final.entries !== source.entries) fail();
    assert(); const sealed = await options.prepared.seal({ signal: options.signal }); assert(); return sealed;
  } finally {
    key.fill(0);
    if (scratch) { await rm(scratch, { recursive: true, force: true }); fsyncDir(dirname(scratch)); }
  }
}

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
