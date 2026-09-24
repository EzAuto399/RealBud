/** Bounded live capture under a host-owned snapshot lease. Capture writes only
 * to its supplied provisional catalog; verification rereads original sources.
 * Neither operation admits an archive, releases a lease, or grants authority. */
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { decryptBytes, isEncryptedEnvelope } from './desk-crypto.ts';
import { PrivateBackupCatalog, type CatalogFile } from './private-backup-catalog.ts';
import { isPrivateBackupPath, privateBackupSourcePaths, validatePrivateLogicalRecord, PRIVATE_PACK_HISTORY_ROOTS, privateBackupHistoryStorage, privateBackupHistoryDirectory } from './private-workspace-backup.ts';
import { WORKFLOW_MAX_ENCRYPTED_RECORD_LENGTH } from './workflow-database.ts';
import { windowsFilePrivacy } from './windows-file-privacy.ts';

export interface PrivateCaptureLimits {
  maxDirectoryEntries?: number;
  maxRecords?: number;
  maxSourceBytes?: number;
}
export interface PrivateCaptureProgress {
  phase: 'files' | 'records' | 'guards';
  verifying: boolean;
  fileCount: number;
  recordCount: number;
  sourceBytes: number;
}
export interface PrivateCaptureOptions {
  directory: string;
  workspaceId: string;
  key: Buffer;
  catalog: PrivateBackupCatalog;
  /** Synchronous, authoritative lease and host epoch check. Called around every
   * asynchronous read/yield and before each catalog mutation. Never a UI flag. */
  assertLease(): void;
  signal?: AbortSignal;
  onProgress?(progress: PrivateCaptureProgress): void | Promise<void>;
  limits?: PrivateCaptureLimits;
}
export interface PrivateCaptureReceipt {
  version: 1;
  workspaceId: string;
  catalogId: string;
  catalogDigest: string;
  catalogEntries: number;
  databasePresent: boolean;
  sourceDigest: string;
  fileCount: number;
  recordCount: number;
  sourceBytes: number;
  directoryEntries: number;
}
export interface PrivateTargetReadOptions {
  assertLease?: () => void; signal?: AbortSignal; limits?: PrivateCaptureLimits;
}
interface FilesystemOptions extends PrivateTargetReadOptions { directory: string; onProgress?: PrivateCaptureOptions['onProgress'] }
interface Fingerprint {
  databasePresent: boolean; sourceDigest: string; fileCount: number;
  recordCount: number; sourceBytes: number; directoryEntries: number;
}
const DATABASE = 'workflow-state.sqlite';
const MAX_FILE = 8 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 100_000;
const MAX_RECORDS = 100_000;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;
const PRIVATE_PREFIX = 'company-installation/private/';
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) < Number.MAX_SAFE_INTEGER;
/** `code` is a fixed backup failure reason for diagnostics, never message text. */
function fail(message: string, status = 409, code?: 'changed-during-copy' | 'database-journal'): never { throw Object.assign(new Error(message), { status, ...(code ? { code } : {}) }); }
const changed = (): never => fail('Private business data changed during capture. No verified backup was published.', 409, 'changed-during-copy');
function parseJson(data: Buffer): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); }
  catch { return fail('A private business JSON record needs recovery. No verified backup was published.', 503); }
}
function statIdentity(stat: Stats): unknown[] {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
}
function sameStat(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function checkFile(stat: Stats, max = Number.MAX_SAFE_INTEGER): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > max) fail('A private source file is linked, invalid or exceeds its entity limit.');
  if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail('A private source file has unverified permissions.');
}

class CaptureFilesystem {
  protected options: FilesystemOptions;
  protected root: string;
  protected writing: boolean;
  protected limit: Required<PrivateCaptureLimits>;
  protected fingerprint = createHash('sha256');
  protected fileCount = 0;
  protected recordCount = 0;
  protected sourceBytes = 0;
  protected directoryEntries = 0;
  constructor(options: FilesystemOptions, writing: boolean) {
    this.options = options; this.root = resolve(options.directory); this.writing = writing;
    this.limit = { maxDirectoryEntries: options.limits?.maxDirectoryEntries ?? MAX_DIRECTORY_ENTRIES,
      maxRecords: options.limits?.maxRecords ?? MAX_RECORDS, maxSourceBytes: options.limits?.maxSourceBytes ?? MAX_SOURCE_BYTES };
    for (const [name, maximum] of Object.entries({ maxDirectoryEntries: MAX_DIRECTORY_ENTRIES, maxRecords: MAX_RECORDS, maxSourceBytes: MAX_SOURCE_BYTES })) {
      const value = this.limit[name as keyof Required<PrivateCaptureLimits>];
      if (!integer(value, 1) || value > maximum) fail('The private capture limits are invalid.', 400);
    }
  }
  protected check(): void {
    if (this.options.signal?.aborted) fail('The private source capture was cancelled.', 409);
    const result: unknown = this.options.assertLease?.();
    if (result !== undefined) {
      // A accidentally async assertion must not grant admission while its
      // rejection is still pending. Consume it only to avoid an unhandled task.
      if (result && typeof result === 'object' && 'then' in result) void Promise.resolve(result).catch(() => {});
      fail('The snapshot lease assertion must complete synchronously.', 500);
    }
  }
  protected async checked<T>(operation: () => Promise<T>): Promise<T> {
    this.check(); const result = await operation(); this.check(); return result;
  }
  protected async progress(phase: PrivateCaptureProgress['phase']): Promise<void> {
    this.check();
    if (this.options.onProgress) await this.checked(async () => {
      await this.options.onProgress!({ phase, verifying: !this.writing, fileCount: this.fileCount, recordCount: this.recordCount, sourceBytes: this.sourceBytes });
    });
  }
  protected include(value: unknown): void { this.fingerprint.update(JSON.stringify(value)); this.fingerprint.update('\n'); }
  protected consume(bytes: number): void {
    this.sourceBytes += bytes;
    if (this.sourceBytes > this.limit.maxSourceBytes) fail('The private source capture exceeds its declared size capacity.', 413);
  }
  protected async stat(path: string): Promise<Stats | undefined> {
    try { return await this.checked(() => lstat(path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  protected async ancestors(path: string): Promise<void> {
    const absolute = resolve(path), root = parse(absolute).root;
    let cursor = root;
    for (const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
      cursor = join(cursor, part);
      const stat = await this.stat(cursor);
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail('Private source storage contains a linked or invalid folder.');
    }
  }
  protected async directory(relative: string): Promise<string[]> {
    const path = join(this.root, relative);
    await this.ancestors(path);
    const before = await this.stat(path);
    if (!before) return [];
    if (!before.isDirectory() || before.isSymbolicLink()) fail('Private source storage contains a linked or invalid folder.');
    await this.checked(() => windowsFilePrivacy(path, 'directory'));
    this.check();
    const handle = await opendir(path);
    const names: string[] = [];
    try {
      this.check();
      while (true) {
        const entry = await this.checked(() => handle.read());
        if (!entry) break;
        if (++this.directoryEntries > this.limit.maxDirectoryEntries) fail('The source directory listing exceeds its declared entry capacity, including excluded files.', 413);
        names.push(entry.name);
      }
    } finally { await handle.close(); }
    const after = await this.stat(path);
    if (!after || !sameStat(before, after)) changed();
    return names.sort();
  }
  protected async file(relative: string, max = MAX_FILE): Promise<{ data: Buffer; stat: Stats } | undefined> {
    const path = join(this.root, relative);
    await this.ancestors(dirname(path));
    const before = await this.stat(path);
    if (!before) return undefined;
    checkFile(before, max);
    await this.checked(() => windowsFilePrivacy(path, 'file'));
    // O_NOFOLLOW protects the final component on systems supporting it. Handle
    // and ancestor checks on both sides also detect rename/link races.
    this.check();
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      this.check();
      const opened = await this.checked(() => handle.stat()); checkFile(opened, max);
      if (!sameStat(before, opened)) changed();
      const data = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < data.length) {
        const result = await this.checked(() => handle.read(data, offset, Math.min(1024 * 1024, data.length - offset), offset));
        if (!result.bytesRead) changed(); offset += result.bytesRead;
      }
      const extra = Buffer.alloc(1), tail = await this.checked(() => handle.read(extra, 0, 1, offset));
      const afterHandle = await this.checked(() => handle.stat()), afterPath = await this.stat(path);
      await this.ancestors(dirname(path));
      if (tail.bytesRead || !afterPath || !sameStat(before, afterHandle) || !sameStat(before, afterPath)) changed();
      return { data, stat: afterPath! };
    } finally { await handle.close(); }
  }
  protected async paths(): Promise<string[]> {
    const paths = new Set<string>(), policy = privateBackupSourcePaths();
    for (const path of policy.staticPaths) {
      await this.ancestors(dirname(join(this.root, path)));
      if (await this.stat(join(this.root, path))) paths.add(path);
    }
    const walk = async (relative: string, depth: number) => {
      for (const name of await this.directory(relative)) {
        const path = `${relative}/${name}`;
        if (privateBackupHistoryStorage(relative) && !isPrivateBackupPath(path)) {
          const stat = await this.stat(join(this.root, path));
          if (!privateBackupHistoryDirectory(relative, name) || !stat?.isDirectory() || stat.isSymbolicLink()) fail('Unrecognized workflow pack archive storage needs recovery before backup.');
        }
        if (Boolean(isPrivateBackupPath(path))) paths.add(path);
        else if (depth) {
          const stat = await this.stat(join(this.root, path));
          if (!stat) changed();
          if (stat!.isSymbolicLink()) fail('Private workflow support contains a linked entry.');
          if (stat!.isDirectory()) await walk(path, depth - 1);
        } else if (path.startsWith(`${PRIVATE_PREFIX}mail-`)) fail('Unrecognized mail evidence needs service review before backup.');
      }
    };
    for (const path of ['company-installation/private', 'vault/properties', 'vault/owners', 'vault/decisions', 'vault/workflow-inputs']) await walk(path, 0);
    await walk('vault/workflow-support', 1);
    for (const root of PRIVATE_PACK_HISTORY_ROOTS) await walk(root, 1);
    return [...paths].sort();
  }
  protected async guards(): Promise<void> {
    for (const path of privateBackupSourcePaths().guardedPaths) {
      const file = await this.file(path);
      if (!file) this.include(['guard', path, 'absent']);
      else {
        this.consume(file.data.length);
        this.include(['guard', path, statIdentity(file.stat), createHash('sha256').update(file.data).digest('hex')]);
        file.data.fill(0); // Guarded credentials never enter a logical catalog.
      }
    }
    const company = 'company-installation';
    for (const name of await this.directory(company)) {
      if (['workspace.json', 'private'].includes(name)) continue;
      const stat = await this.stat(join(this.root, company, name));
      if (!stat) changed();
      if (stat!.isSymbolicLink() || !stat!.isDirectory() && !stat!.isFile()) fail('The office installation contains a linked or invalid entry.');
      this.include(['company-directory', name, stat!.isDirectory() ? 'directory' : 'file', statIdentity(stat!)]);
    }
    await this.progress('guards');
  }
  protected async noDatabaseSidecars(): Promise<void> {
    for (const suffix of ['-wal', '-shm', '-journal']) {
      if (await this.stat(join(this.root, `${DATABASE}${suffix}`))) {
        fail('The workflow database has unfinished journal or WAL state. Recover it before private backup or restore.', 409, 'database-journal');
      }
    }
  }
  async targetPaths(): Promise<string[]> {
    await this.noDatabaseSidecars();
    const paths = await this.paths(), database = await this.stat(join(this.root, DATABASE));
    if (database) { checkFile(database); paths.push(DATABASE); }
    this.check(); return paths.sort();
  }
  async targetGuard(): Promise<string> {
    await this.noDatabaseSidecars();
    this.include(['private-target-guard', 1]);
    await this.guards(); this.check(); return this.fingerprint.digest('hex');
  }
}

class CaptureReader extends CaptureFilesystem {
  private capture: PrivateCaptureOptions;
  private key: Buffer;
  constructor(options: PrivateCaptureOptions, writing: boolean) {
    super(options, writing);
    if (!Buffer.isBuffer(options.key) || options.key.length !== 32 || !uuid(options.workspaceId) || typeof options.assertLease !== 'function') fail('The private capture identity or protected key is invalid.', 400);
    this.capture = options; this.key = Buffer.from(options.key);
  }
  private logicalFile(path: string, data: Buffer): CatalogFile {
    if (path === 'desk.json' || path.startsWith(PRIVATE_PREFIX)) {
      const envelope = parseJson(data);
      if (!isEncryptedEnvelope(envelope)) fail('Protected private source data needs recovery.', 503);
      let plain: Buffer;
      try { plain = decryptBytes(this.key, envelope); } catch { return fail('Protected private source data does not open with this installation key.', 503); }
      try {
        // Reuse parsed logical values without sorting their keys. Existing mail
        // origin fingerprints depend on JSON.stringify property/array order.
        return { path, encoding: 'json', data: Buffer.from(JSON.stringify(parseJson(plain))) };
      } finally { plain.fill(0); }
    }
    if (path.endsWith('.json')) parseJson(data);
    return { path, encoding: 'bytes', data };
  }
  private async records(): Promise<boolean> {
    const path = join(this.root, DATABASE);
    await this.ancestors(dirname(path));
    await this.noDatabaseSidecars();
    const before = await this.stat(path);
    if (!before) { this.include(['database', 'absent']); return false; }
    checkFile(before);
    await this.checked(() => windowsFilePrivacy(path, 'file'));
    this.check();
    const headerHandle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      this.check();
      const opened = await this.checked(() => headerHandle.stat());
      if (!sameStat(before, opened)) changed();
      const header = Buffer.alloc(100), read = await this.checked(() => headerHandle.read(header, 0, header.length, 0));
      if (read.bytesRead !== 100 || header.subarray(0, 16).toString('ascii') !== 'SQLite format 3\0') fail('The workflow source header needs recovery.', 503);
      // Opening a clean WAL-mode database can itself create WAL/SHM sidecars.
      // This workspace uses DELETE journaling, so reject that unsupported mode
      // before SQLite opens the source, rather than changing its storage state.
      if (header[18] !== 1 || header[19] !== 1) fail('Recover the workflow database to its supported rollback-journal mode before capture.', 503);
      const after = await this.checked(() => headerHandle.stat());
      if (!sameStat(before, after)) changed();
    } finally { await headerHandle.close(); }
    this.check();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA cache_size=-2048; BEGIN;');
      const version = db.prepare('PRAGMA user_version').get();
      const schema = db.prepare("SELECT type,name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 2").all();
      if (version?.user_version !== 1 || schema.length !== 1 || schema[0].type !== 'table' || schema[0].name !== 'workflow_records') fail('The workflow source schema needs a compatible backup version.', 503);
      const columns = db.prepare('PRAGMA table_info(workflow_records)').all();
      const expected = [['id', 'TEXT', 0, 1], ['kind', 'TEXT', 1, 0], ['revision', 'INTEGER', 1, 0], ['payload', 'TEXT', 1, 0]];
      if (columns.length !== 4 || columns.some((column, index) =>
        JSON.stringify([column.name, column.type, column.notnull, column.pk]) !== JSON.stringify(expected[index]) || column.dflt_value !== null)) fail('The workflow source columns need a compatible backup version.', 503);
      const count = Number(db.prepare('SELECT count(*) AS count FROM workflow_records').get()!.count);
      if (!integer(count) || count > this.limit.maxRecords) fail('The workflow source exceeds the declared capture record capacity.', 413);
      this.include(['database', 'present', before.dev, before.ino, version.user_version]);
      let previous = 0;
      const query = db.prepare(`SELECT rowid AS sequence,id,kind,revision,length(payload) AS bytes,
        CASE WHEN typeof(payload)='text' AND length(payload)<=${WORKFLOW_MAX_ENCRYPTED_RECORD_LENGTH} THEN payload ELSE NULL END AS payload
        FROM workflow_records ORDER BY rowid`);
      for (const row of query.iterate()) {
        this.check();
        if (!integer(row.sequence, 1) || row.sequence <= previous || typeof row.payload !== 'string') fail('A retained workflow record is invalid or exceeds its encrypted entity limit.', 503);
        previous = row.sequence;
        const bytes = Buffer.byteLength(row.payload); this.consume(bytes);
        const envelope = parseJson(Buffer.from(row.payload));
        if (!isEncryptedEnvelope(envelope)) fail('A retained workflow envelope needs recovery.', 503);
        let plain: Buffer;
        try { plain = decryptBytes(this.key, envelope); } catch { return fail('Retained workflow data does not open with this installation key.', 503); }
        try {
          const record = validatePrivateLogicalRecord({ id: row.id, kind: row.kind, revision: row.revision, value: parseJson(plain) });
          this.include(['record', row.sequence, record.id, record.kind, record.revision, createHash('sha256').update(row.payload).digest('hex')]);
          this.check(); if (this.writing) this.capture.catalog.addRecord(record);
        } finally { plain.fill(0); }
        this.recordCount++;
        if (this.recordCount % 50 === 0) { await this.progress('records'); await this.checked(() => setImmediate()); }
      }
      if (this.recordCount !== count) changed();
      db.exec('COMMIT');
    } finally { db.close(); }
    const after = await this.stat(path);
    await this.noDatabaseSidecars();
    await this.ancestors(dirname(path));
    if (!after || !sameStat(before, after)) changed();
    this.check(); await this.progress('records'); return true;
  }
  async run(): Promise<Fingerprint> {
    try {
      this.check();
      this.include(['private-source-capture', 1, this.capture.workspaceId]);
      for (const path of await this.paths()) {
        const file = await this.file(path, path.startsWith(PRIVATE_PREFIX) ? 2_000_000 : MAX_FILE);
        if (!file) changed();
        const found = file!; this.consume(found.data.length);
        this.include(['file', path, statIdentity(found.stat), createHash('sha256').update(found.data).digest('hex')]);
        const logical = this.logicalFile(path, found.data);
        this.check(); if (this.writing) this.capture.catalog.addFile(logical);
        this.fileCount++; await this.progress('files');
      }
      const databasePresent = await this.records();
      await this.guards(); this.check();
      return { databasePresent, sourceDigest: this.fingerprint.digest('hex'), fileCount: this.fileCount,
        recordCount: this.recordCount, sourceBytes: this.sourceBytes, directoryEntries: this.directoryEntries };
    } finally { this.key.fill(0); }
  }
}

export async function capturePrivateWorkspace(options: PrivateCaptureOptions): Promise<PrivateCaptureReceipt> {
  const before = options.catalog.summary();
  if (before.sealed || before.entries !== 0 || before.workspaceId !== options.workspaceId) fail('Source capture requires a new provisional catalog for this workspace.', 409);
  const captured = await new CaptureReader(options, true).run(), after = options.catalog.summary();
  options.assertLease();
  if (after.sealed || after.entries !== captured.fileCount + captured.recordCount) changed();
  return Object.freeze({ version: 1, workspaceId: options.workspaceId, catalogId: after.catalogId,
    catalogDigest: after.digest, catalogEntries: after.entries, ...captured });
}

/** Mandatory second bounded source read while the same host lease remains held.
 * The caller releases its lease only after this resolves; graph validation/seal
 * may then run against the immutable captured entries without pausing work. */
export async function verifyPrivateWorkspaceCapture(options: PrivateCaptureOptions, receipt: PrivateCaptureReceipt): Promise<void> {
  if (!receipt || Object.keys(receipt).length !== 11 || receipt.version !== 1 || receipt.workspaceId !== options.workspaceId || !uuid(receipt.catalogId) ||
      !hex(receipt.catalogDigest) || !hex(receipt.sourceDigest) || typeof receipt.databasePresent !== 'boolean' ||
      ![receipt.catalogEntries, receipt.fileCount, receipt.recordCount, receipt.sourceBytes, receipt.directoryEntries].every(value => integer(value))) fail('The private source capture receipt is invalid.', 400);
  const assertCatalog = () => {
    const current = options.catalog.summary();
    if (current.catalogId !== receipt.catalogId || current.workspaceId !== receipt.workspaceId || current.digest !== receipt.catalogDigest || current.entries !== receipt.catalogEntries) changed();
  };
  assertCatalog();
  const current = await new CaptureReader(options, false).run();
  if (Object.entries(current).some(([key, value]) => receipt[key as keyof PrivateCaptureReceipt] !== value)) changed();
  options.assertLease(); assertCatalog();
}

/** Bounded names only; cold restore hashes/materializes content separately. */
export async function privateBackupTargetPaths(directory: string, options: PrivateTargetReadOptions = {}): Promise<string[]> {
  return new CaptureFilesystem({ directory, ...options }, false).targetPaths();
}
/** Authority guards stay separate from business files that a cold apply changes. */
export async function privateBackupTargetGuard(directory: string, options: PrivateTargetReadOptions = {}): Promise<string> {
  return new CaptureFilesystem({ directory, ...options }, false).targetGuard();
}
