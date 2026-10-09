/** Offline AEAD export and held restore of gateway-owned state. No provider
 * adapter, runtime composition, credentials from env or activation seam. */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { canonical, exact, object, requireThat } from './contracts.ts';
import { validateConnectorDevices } from './connectors.ts';
import { acquireRuntimeStateLease, privateStateDirectory, publishPrivateStateFile, readPrivateStateFile, RESTORE_HOLD_FILE, RESTORE_HOLD_SETTING, STATE_ID_FILE, stateIdentity, runtimeStateRoot, type RuntimeStateLease } from './runtime-state-lock.ts';

const LIMIT = 64 * 1024 ** 2, MAX_FILES = 258;
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const secretName = /^REALBUD_COMPOSIO_(PROJECT|WEBHOOK)_[A-Z0-9_]{1,80}$/;
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const inside = (root: string, path: string) => path.startsWith(`${root}${sep}`);
type Scope = { registry: string | null; secrets: string | null };
type FileEntry = { path: string; bytes: number; sha256: string; data: string };
type Snapshot = { version: 1; archiveId: string; stateId: string; createdAt: number; sourceRevision: string; applicationId: number; schemaVersion: number; chainHead: string; scope: Scope; files: FileEntry[] };
export type GatewayBackupConfig = { directory: string; registry?: string; secrets?: string };
function safeRelative(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9._/-]{1,240}$/.test(value) && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.realbud-gateway-') && !part.startsWith('.gateway-')); }
function scopeAdmissible(scope: Scope): boolean {
  if (![scope.registry, scope.secrets].every(path => path === null || (safeRelative(path) && path !== 'ledger.sqlite' && !path.startsWith('ledger.sqlite/')))) return false;
  return !scope.registry || !scope.secrets || (scope.registry !== scope.secrets && !scope.registry.startsWith(`${scope.secrets}/`) && !scope.secrets.startsWith(`${scope.registry}/`));
}
function configuredScope(config: GatewayBackupConfig, root: string): Scope {
  const path = (value?: string, directory = false) => {
    if (value === undefined) return null;
    requireThat(isAbsolute(value) && inside(root, resolve(value)), 'gateway_backup_scope_mismatch', 503);
    requireThat(runtimeStateRoot(directory ? value : dirname(value)) === root, 'gateway_backup_split_state_root', 503);
    const result = relative(root, resolve(value)).split(sep).join('/'); requireThat(safeRelative(result), 'gateway_backup_scope_mismatch', 503); return result;
  };
  const registry = path(config.registry), secrets = path(config.secrets, true);
  const scope = { registry, secrets }; requireThat(scopeAdmissible(scope), 'gateway_backup_scope_mismatch', 503); return scope;
}
function canonicalFile(path: string, limit: number): Buffer {
  requireThat(realpathSync(path) === resolve(path), 'gateway_backup_aliased_file', 503);
  return readPrivateStateFile(path, limit);
}
function key(file: string, stateRoot: string, artifact: string): Buffer {
  requireThat(isAbsolute(file) && isAbsolute(artifact) && !inside(stateRoot, resolve(file)) && resolve(file) !== stateRoot &&
    !inside(dirname(resolve(artifact)), resolve(file)) && dirname(resolve(file)) !== dirname(resolve(artifact)), 'gateway_backup_key_scope', 503);
  const bytes = canonicalFile(file, 32); requireThat(bytes.length === 32, 'gateway_backup_key_invalid', 503); return bytes;
}
export function createGatewayRecoveryKey(file: string): { status: 'created'; path: string } {
  requireThat(isAbsolute(file), 'gateway_backup_key_path', 503); privateStateDirectory(dirname(file));
  publishPrivateStateFile(file, randomBytes(32)); return { status: 'created', path: resolve(file) };
}
/** Read-only structural and immutable event-chain verification, with no schema
 * migration or checkpoint and no LedgerDatabase runtime admission. */
function verifyDatabase(path: string): { schemaVersion: number; chainHead: string } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    requireThat(db.prepare('PRAGMA application_id').get()?.application_id === 0x52424757, 'gateway_backup_foreign_database', 503);
    const schemaVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version);
    requireThat([1, 2, 3].includes(schemaVersion), 'gateway_backup_schema_unsupported', 503);
    // The empty event chain alone cannot prove the mandatory recovery schema.
    // Require the real tables/columns used by hold insertion and chain checks
    // before a candidate can publish target admission metadata.
    for (const [table, required] of [
      ['settings', ['key', 'value']],
      ['events', ['seq', 'tenant', 'kind', 'request', 'at', 'body', 'previous', 'hash']],
    ] as const) {
      requireThat(Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)), 'gateway_backup_schema_incomplete', 503);
      const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name)));
      requireThat(required.every(column => columns.has(column)), 'gateway_backup_schema_incomplete', 503);
    }
    requireThat(db.prepare('PRAGMA quick_check').get()?.quick_check === 'ok' && db.prepare('PRAGMA foreign_key_check').all().length === 0, 'gateway_backup_database_damaged', 503);
    let chainHead = 'genesis';
    for (const value of db.prepare('SELECT * FROM events ORDER BY seq').iterate()) {
      const expected = digest(canonical({ tenant: value.tenant, kind: value.kind, request: value.request, at: value.at, body: value.body, previous: chainHead }));
      requireThat(value.previous === chainHead && value.hash === expected, 'gateway_backup_ledger_integrity', 503); chainHead = String(value.hash);
    }
    return { schemaVersion, chainHead };
  } finally { db.close(); }
}
function file(path: string, bytes: Buffer): FileEntry { return { path, bytes: bytes.length, sha256: digest(bytes), data: bytes.toString('base64') }; }
function allowed(path: string, scope: Scope): boolean { return path === 'ledger.sqlite' || path === scope.registry || Boolean(scope.secrets && path.startsWith(`${scope.secrets}/`) && secretName.test(path.slice(scope.secrets.length + 1))); }
function validateSnapshot(value: unknown): Snapshot {
  object(value); exact(value, ['version', 'archiveId', 'stateId', 'createdAt', 'sourceRevision', 'applicationId', 'schemaVersion', 'chainHead', 'scope', 'files']);
  requireThat(value.version === 1 && uuid(value.archiveId) && uuid(value.stateId) && Number.isSafeInteger(value.createdAt) && Number(value.createdAt) >= 0 &&
    typeof value.sourceRevision === 'string' && /^(unknown|[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.sourceRevision) && value.applicationId === 0x52424757 && [1, 2, 3].includes(Number(value.schemaVersion)) &&
    (value.chainHead === 'genesis' || opaque(value.chainHead)), 'gateway_backup_manifest_invalid', 503);
  object(value.scope); exact(value.scope, ['registry', 'secrets']);
  const scope = value.scope as Scope;
  requireThat(scopeAdmissible(scope), 'gateway_backup_scope_mismatch', 503);
  requireThat(Array.isArray(value.files) && value.files.length > 0 && value.files.length <= MAX_FILES, 'gateway_backup_manifest_invalid', 503);
  let total = 0; const paths = new Set<string>();
  for (const row of value.files) {
    object(row); exact(row, ['path', 'bytes', 'sha256', 'data']);
    requireThat(safeRelative(row.path) && allowed(row.path, scope) && !paths.has(row.path) && Number.isSafeInteger(row.bytes) && Number(row.bytes) >= 0 && opaque(row.sha256) && typeof row.data === 'string', 'gateway_backup_manifest_invalid', 503);
    const bytes = Buffer.from(row.data, 'base64');
    requireThat(bytes.toString('base64') === row.data && bytes.length === row.bytes && digest(bytes) === row.sha256 && (total += bytes.length) <= LIMIT, 'gateway_backup_file_integrity', 503); paths.add(row.path);
    if (row.path === scope.registry) validateConnectorDevices(JSON.parse(bytes.toString()));
    if (scope.secrets && row.path.startsWith(`${scope.secrets}/`)) requireThat(bytes.length <= 8192 && bytes.length > 1 && bytes.toString().endsWith('\n'), 'gateway_backup_secret_invalid', 503);
  }
  requireThat(paths.has('ledger.sqlite') && (!scope.registry || paths.has(scope.registry)), 'gateway_backup_manifest_incomplete', 503);
  for (const path of paths) requireThat(![...paths].some(other => other.startsWith(`${path}/`)), 'gateway_backup_manifest_path_collision', 503);
  return value as Snapshot;
}
function encrypted(snapshot: Snapshot, recoveryKey: Buffer): Buffer {
  const nonce = randomBytes(12), metadata = { version: 1, algorithm: 'aes-256-gcm', archiveId: snapshot.archiveId };
  const cipher = createCipheriv('aes-256-gcm', recoveryKey, nonce); cipher.setAAD(Buffer.from(canonical(metadata)));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(canonical(snapshot))), cipher.final()]);
  return Buffer.from(JSON.stringify({ ...metadata, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }));
}
function decrypted(bytes: Buffer, recoveryKey: Buffer): Snapshot {
  requireThat(bytes.length <= LIMIT * 2, 'gateway_backup_archive_too_large', 503);
  try {
    const envelope: unknown = JSON.parse(bytes.toString()); object(envelope); exact(envelope, ['version', 'algorithm', 'archiveId', 'nonce', 'tag', 'ciphertext']);
    requireThat(envelope.version === 1 && envelope.algorithm === 'aes-256-gcm' && uuid(envelope.archiveId), 'gateway_backup_envelope_invalid', 503);
    const decode = (value: unknown, size?: number) => { requireThat(typeof value === 'string', 'gateway_backup_envelope_invalid', 503); const decoded = Buffer.from(value, 'base64'); requireThat(decoded.toString('base64') === value && (!size || decoded.length === size), 'gateway_backup_envelope_invalid', 503); return decoded; };
    const cipher = createDecipheriv('aes-256-gcm', recoveryKey, decode(envelope.nonce, 12)); cipher.setAAD(Buffer.from(canonical({ version: 1, algorithm: 'aes-256-gcm', archiveId: envelope.archiveId }))); cipher.setAuthTag(decode(envelope.tag, 16));
    const plaintext = Buffer.concat([cipher.update(decode(envelope.ciphertext)), cipher.final()]); requireThat(plaintext.length <= LIMIT * 1.5, 'gateway_backup_archive_too_large', 503);
    const snapshot = validateSnapshot(JSON.parse(plaintext.toString())); requireThat(snapshot.archiveId === envelope.archiveId, 'gateway_backup_archive_identity', 503); return snapshot;
  } catch { throw Object.assign(new Error('gateway_backup_verification_failed'), { status: 503 }); }
}
function verifyCandidate(snapshot: Snapshot, scratch: string): void {
  const ledger = snapshot.files.find(row => row.path === 'ledger.sqlite')!;
  const path = join(scratch, 'verified.sqlite'); publishPrivateStateFile(path, Buffer.from(ledger.data, 'base64'));
  const verified = verifyDatabase(path); requireThat(verified.schemaVersion === snapshot.schemaVersion && verified.chainHead === snapshot.chainHead, 'gateway_backup_manifest_database_mismatch', 503);
}
export async function exportGatewayBackup(config: GatewayBackupConfig & { keyFile: string; output: string; sourceRevision?: string }): Promise<{ status: 'exported'; path: string; sha256: string }> {
  const captured = canonical(config), root = privateStateDirectory(config.directory); stateIdentity(root);
  const scope = configuredScope(config, root);
  requireThat(isAbsolute(config.output) && !inside(root, resolve(config.output)), 'gateway_backup_output_scope', 503);
  const recoveryKey = key(config.keyFile, root, config.output);
  let lease: RuntimeStateLease | undefined, scratch: string | undefined;
  try {
    lease = acquireRuntimeStateLease(root, 'maintenance');
    requireThat(!readdirSync(root).some(name => /^\.gateway-(backup|restore|verify)-/.test(name)), 'gateway_backup_orphan_state', 503);
    scratch = mkdtempSync(join(root, '.gateway-backup-'));
    const source = join(root, 'ledger.sqlite'); canonicalFile(source, LIMIT);
    for (const suffix of ['-wal', '-shm', '-journal']) if (existsSync(`${source}${suffix}`)) canonicalFile(`${source}${suffix}`, LIMIT);
    const sourceDb = new DatabaseSync(source, { readOnly: true });
    try { publishPrivateStateFile(join(scratch, 'snapshot.sqlite'), Buffer.alloc(0)); await backup(sourceDb, join(scratch, 'snapshot.sqlite')); }
    finally { sourceDb.close(); }
    lease.assertCurrent(); requireThat(canonical(config) === captured && canonical(configuredScope(config, root)) === canonical(scope), 'gateway_backup_scope_changed', 503);
    const database = canonicalFile(join(scratch, 'snapshot.sqlite'), LIMIT), verified = verifyDatabase(join(scratch, 'snapshot.sqlite'));
    const files = [file('ledger.sqlite', database)];
    if (scope.registry) {
      const path = join(root, scope.registry);
      requireThat(!existsSync(`${path}.lock`) && !readdirSync(dirname(path)).some(name => name.startsWith(`.${basename(path)}.`) && name.endsWith('.tmp')), 'gateway_backup_unrecovered_registry', 503);
      const bytes = canonicalFile(path, 1_000_000); validateConnectorDevices(JSON.parse(bytes.toString())); files.push(file(scope.registry, bytes));
    }
    if (scope.secrets) {
      requireThat(existsSync(join(root, scope.secrets)), 'gateway_backup_scope_mismatch', 503);
      const directory = privateStateDirectory(join(root, scope.secrets));
      const names = readdirSync(directory).sort(); requireThat(names.length <= MAX_FILES - files.length, 'gateway_backup_manifest_invalid', 503);
      for (const name of names) {
        requireThat(secretName.test(name), 'gateway_backup_unadmitted_secret_file', 503);
        files.push(file(`${scope.secrets}/${name}`, canonicalFile(join(directory, name), 8192)));
      }
    }
    const snapshot = validateSnapshot({ version: 1, archiveId: randomUUID(), stateId: lease.stateId, createdAt: Date.now(), sourceRevision: config.sourceRevision ?? 'unknown', applicationId: 0x52424757, ...verified, scope, files });
    lease.assertCurrent(); requireThat(canonical(config) === captured, 'gateway_backup_scope_changed', 503);
    const archive = encrypted(snapshot, recoveryKey); publishPrivateStateFile(config.output, archive);
    return { status: 'exported', path: resolve(config.output), sha256: digest(archive) };
  } finally { recoveryKey.fill(0); try { if (scratch) rmSync(scratch, { recursive: true, force: true }); } finally { lease?.release(); } }
}
/** Verification is available without admitting the restored runtime. */
export function verifyGatewayBackup(options: { archive: string; keyFile: string; scratchDirectory: string }): { status: 'verified'; path: string; sha256: string } {
  const root = privateStateDirectory(options.scratchDirectory), recoveryKey = key(options.keyFile, root, options.archive); let scratch: string | undefined;
  try { scratch = mkdtempSync(join(root, '.gateway-verify-')); const bytes = canonicalFile(options.archive, LIMIT * 2), snapshot = decrypted(bytes, recoveryKey); verifyCandidate(snapshot, scratch); return { status: 'verified', path: resolve(options.archive), sha256: digest(bytes) }; }
  finally { recoveryKey.fill(0); if (scratch) rmSync(scratch, { recursive: true, force: true }); }
}
export function restoreGatewayBackup(options: { archive: string; keyFile: string; directory: string }): { status: 'restored-held'; path: string; sha256: string } {
  const root = privateStateDirectory(options.directory);
  requireThat(readdirSync(root).length === 0, 'gateway_restore_target_not_empty', 503);
  const recoveryKey = key(options.keyFile, root, options.archive);
  let snapshot: Snapshot, archive: Buffer;
  try { archive = canonicalFile(options.archive, LIMIT * 2); snapshot = decrypted(archive, recoveryKey); } finally { recoveryKey.fill(0); }
  const scratch = mkdtempSync(join(root, '.gateway-restore-')); let lease: RuntimeStateLease | undefined;
  try {
    verifyCandidate(snapshot, scratch);
    lease = acquireRuntimeStateLease(root, 'maintenance'); lease.assertCurrent();
    requireThat(readdirSync(root).every(name => [STATE_ID_FILE, '.realbud-gateway-leases', basename(scratch)].includes(name)), 'gateway_restore_target_changed', 503);
    const archiveDigest = digest(archive), held = { version: 1, state: 'in-progress', archiveDigest, sourceStateId: snapshot.stateId, targetStateId: stateIdentity(root).id };
    // This guard is admitted BEFORE any restorable state. Interrupted restore
    // remains held even if no database or only part of the files was published.
    publishPrivateStateFile(join(root, RESTORE_HOLD_FILE), Buffer.from(canonical(held)));
    const ledger = join(scratch, 'verified.sqlite'), db = new DatabaseSync(ledger);
    try {
      const at = Date.now(), body = canonical({ archiveDigest, sourceStateId: snapshot.stateId, targetStateId: lease.stateId, admission: 'held' });
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(RESTORE_HOLD_SETTING, body);
        const previous = snapshot.chainHead, tenant = 'realbud-gateway-recovery', kind = 'gateway_restore_held', request = null;
        db.prepare('INSERT INTO events(tenant,kind,request,at,body,previous,hash) VALUES(?,?,?,?,?,?,?)').run(tenant, kind, request, at, body, previous, digest(canonical({ tenant, kind, request, at, body, previous })));
        db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE);');
      } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
    } finally { db.close(); }
    verifyDatabase(ledger); lease.assertCurrent();
    for (const row of snapshot.files) {
      const destination = join(root, row.path); privateStateDirectory(dirname(destination));
      publishPrivateStateFile(destination, row.path === 'ledger.sqlite' ? canonicalFile(ledger, LIMIT) : Buffer.from(row.data, 'base64'));
    }
    publishPrivateStateFile(join(root, RESTORE_HOLD_FILE), Buffer.from(canonical({ ...held, state: 'complete-held' })), true);
    return { status: 'restored-held', path: root, sha256: archiveDigest };
  } finally { try { rmSync(scratch, { recursive: true, force: true }); } finally { lease?.release(); } }
}
