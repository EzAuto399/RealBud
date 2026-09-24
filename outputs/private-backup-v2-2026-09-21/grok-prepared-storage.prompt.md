Bounded code proposal. Own ONLY server/private-backup-prepared.ts and server/private-backup-prepared.test.ts. No tools or external actions; return final JSON {summary:string,patch:string,risks:string[]}. You are not alone: Codex is building a separate public backup coordinator/HTTP integration; do not change its files. Supply maintainable focused changes, not a new framework, and do not weaken existing validation, exact bytes, rollback or large-file support.

Problem: prepared main SQLite caps at 3 GiB but its spilling DELETE rollback journal and temp_store=FILE are unaccounted. Whole-file transactions can reach 1 GiB; do NOT disable cache_spill for an entire file, since that makes memory grow with the database. Keep current atomic file transaction/retry contract and existing schema/header compatibility. Need a host-callable conservative preparedStorageBudget(limits?: Partial<PreparedLimits>) -> {databaseBytes:number,rollbackBytes:number,totalBytes:number}; call same limitsCheck used by create. Main fixed page4096. For current guarded writer budget rollback <= pages*(4096+8)+2*4096*(pages+1)+1MiB bootstrap allowance. databaseBytes is actual page ceiling floor(sqliteBytes/4096)*4096. Sector guard MUST make this formula true for each connection/transaction, not just an advisory option. No savepoints/ATTACH. Keep old headers working.

Suggested constrained mechanism: configure verifies DELETE and fixed4096pages and sets temp_store=MEMORY. Before substantial body writes in each transaction, read current logical header, rewrite only that bounded encrypted header (fresh nonce, same logical fields) to force initial journal publication, then synchronously/bounded-read the actual journal header's page-size and sector-size fields at24/20 with safe file checks. Require sector to be a power of two in512..4096 and page4096. Refuse before big writes if unsupported/unreadable; rollback keeps old logical state. Accept that SQLite's initial unsynced magic can be zero; inspect declared fields, not valid-hot-magic as a condition. No memory-only journal policy. Bootstrap/priming before sector admission is covered by explicit1MiB allowance (bounded metadata/schema writes). Return typed503 unsupported filesystem,413 actualSQLiteFULL. Verify every transaction; never trust a persisted claim about a relocated volume.

Primary evidence checked by Codex: SQLite fileformat.html#the_rollback_journal says an original database page occurs at most once per transaction journal; a record is page size+8; each segment can add sector padding and a sector header. pager.c syncJournal clears page NEED_SYNC flags and may append next header when journal was extended. There are at most pages+1 such headers for these no-savepoint writes. VFS sector size must actually be checked to use4096 in a budget. This design should be audited, do not blindly implement if unworkable; report exact concern. Raw main size alone or PRAGMA journal_size_limit does NOT bound a live journal.

ownedFiles() must distinguish main and rollback ceilings, including reopen after an interrupted write; don't reject your own valid journal simply for exceeding main cap. Startup physical inventory under retained reservations remains Codex's coordinator duty before opening historical journal state. Prepared component can't claim aggregate startup enforcement. Keep zeroized buffers, immutable sealing, origin/key/path bounds, cancellation and closed incomplete records. Existing prepared header max4096 protects priming; verify actual limits in source. Tests should meaningfully cover real journal mode/sector observation during transaction, invalid sector/refusal rollback with current source unchanged, actual main cap/full behavior, and a generated large streamed file (existing52MiB case) still passing without full-file buffering. Do not add huge fixtures or arbitrary sleeps. Return a scoped two-file diff; all source provided below.

### server/private-backup-prepared.ts
/** Exact, already-prepared destination bytes for a future cold restore.
 * This private database is created by RealBud, never supplied by an archive.
 * A completed read and full validate() are required before publishing files.
 * This store does not interpret business ciphertext or apply a restore. */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { fsyncDir } from './atomic.ts';
import { windowsFilePrivacy } from './windows-file-privacy.ts';
import { isPrivateBackupPath } from './private-workspace-backup.ts';

export const PRIVATE_BACKUP_PREPARED_CHUNK_BYTES = 1024 * 1024;
export const PRIVATE_BACKUP_PREPARED_LIMITS = Object.freeze({
  bytes: 1024 ** 3, fileBytes: 8 * 1024 ** 2, entries: 100_001, sqliteBytes: 3 * 1024 ** 3,
});
export interface PreparedLimits { bytes: number; fileBytes: number; entries: number; sqliteBytes: number }
export interface PreparedEntry {
  sequence: number; path: string; beforeHash: string | null; intendedHash: string | null; bytes: number;
}
export interface PreparedSummary {
  storeId: string; workspaceId: string; entries: number; bytes: number; digest: string; sealed: boolean;
}
interface Header extends PreparedSummary { version: 1; limits: PreparedLimits }
interface Metadata extends PreparedEntry { version: 1; entryId: string; chunks: number }
interface EntryRow { sequence: number; entry_id: string; lookup: string; payload: Uint8Array }
interface OperationOptions { signal?: AbortSignal }
const FILE = 'prepared.sqlite';
const DATABASE = 'workflow-state.sqlite';
const CHUNK = PRIVATE_BACKUP_PREPARED_CHUNK_BYTES;
const OVERHEAD = 29; // version + nonce + GCM tag
const META_BYTES = 4096;
const PAGE_BYTES = 4096;
const TABLES = {
  prepared_header: 'CREATE TABLE prepared_header (id INTEGER PRIMARY KEY CHECK(id=1), payload BLOB NOT NULL) STRICT',
  prepared_entries: 'CREATE TABLE prepared_entries (sequence INTEGER PRIMARY KEY, entry_id TEXT NOT NULL UNIQUE, lookup TEXT NOT NULL UNIQUE, payload BLOB NOT NULL) STRICT',
  prepared_chunks: 'CREATE TABLE prepared_chunks (entry_id TEXT NOT NULL, ordinal INTEGER NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(entry_id,ordinal)) STRICT',
};
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const nullableHash = (v: unknown): v is string | null => v === null || hex(v);
const integer = (v: unknown, min = 0): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function exact(v: unknown, keys: string[]): v is Record<string, unknown> {
  return object(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
}
function fail(message = 'The prepared backup needs recovery. Its original files were preserved.', status = 503): never {
  throw Object.assign(new Error(message), { status });
}
function validPath(path: unknown): path is string { return path === DATABASE || isPrivateBackupPath(path); }
function keyCheck(key: Buffer): void { if (!Buffer.isBuffer(key) || key.length !== 32) fail('A protected installation key is required.', 400); }
function limitsCheck(value: unknown): asserts value is PreparedLimits {
  if (!exact(value, ['bytes', 'fileBytes', 'entries', 'sqliteBytes']) ||
      !Object.entries(PRIVATE_BACKUP_PREPARED_LIMITS).every(([k, max]) => integer(value[k], k === 'sqliteBytes' ? 65_536 : 1) && Number(value[k]) <= max)) {
    fail('The prepared backup limits are invalid.', 400);
  }
}
function aborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw Object.assign(new Error('Preparing the private backup was cancelled.'), { name: 'AbortError', status: 409 });
}
async function next<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  aborted(signal);
  return new Promise((resolve, reject) => {
    const cancel = () => { try { aborted(signal); } catch (error) { reject(error); } };
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve().then(() => { aborted(signal); return iterator.next(); }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', cancel));
  });
}
async function ancestors(directory: string): Promise<void> {
  const root = parse(directory).root;
  let current = root;
  for (const part of directory.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Prepared backup storage contains a linked or invalid folder.');
  }
}
async function privateDirectory(directory: string): Promise<void> {
  await ancestors(directory);
  const stat = await lstat(directory);
  if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail('Prepared backup storage permissions need recovery.');
  await windowsFilePrivacy(directory, 'directory');
}
async function ownedFiles(directory: string, maxBytes: number): Promise<void> {
  await privateDirectory(directory);
  const names = await readdir(directory);
  if (!names.includes(FILE) || names.some(name => name !== FILE && name !== `${FILE}-journal`)) fail();
  for (const name of names) {
    const path = join(directory, name), stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes ||
        process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail();
    await windowsFilePrivacy(path, 'file');
  }
}
function configure(db: DatabaseSync, maxBytes: number): void {
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048; PRAGMA busy_timeout=0;');
  const page = db.prepare('PRAGMA page_size').get()?.page_size;
  if (page !== PAGE_BYTES) fail();
  const max = Math.floor(maxBytes / PAGE_BYTES);
  if (db.prepare(`PRAGMA max_page_count=${max}`).get()?.max_page_count !== max) fail('Prepared backup storage has reached its capacity.', 413);
}
function schemaCheck(db: DatabaseSync): void {
  const rows = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 4").all();
  if (db.prepare('PRAGMA user_version').get()?.user_version !== 1 || rows.length !== 3 ||
      rows.some(row => row.type !== 'table' || !Object.hasOwn(TABLES, String(row.name)) || row.sql !== TABLES[row.name as keyof typeof TABLES])) fail();
}

export class PrivateBackupPreparedStore {
  readonly directory: string;
  readonly storeId: string;
  readonly workspaceId: string;
  private readonly db: DatabaseSync;
  private readonly key: Buffer;
  private closed = false;
  private closing = false;
  private operation: { done: Promise<unknown>; controller: AbortController } | undefined;
  private closingPromise: Promise<void> | undefined;

  private constructor(directory: string, key: Buffer, db: DatabaseSync, storeId: string, workspaceId: string) {
    this.directory = directory; this.key = Buffer.from(key); this.db = db;
    this.storeId = storeId; this.workspaceId = workspaceId;
  }
  static async create(options: { directory: string; key: Buffer; workspaceId: string; limits?: Partial<PreparedLimits> }): Promise<PrivateBackupPreparedStore> {
    keyCheck(options.key);
    if (!uuid(options.workspaceId)) fail('The prepared backup workspace is invalid.', 400);
    const limits = { ...PRIVATE_BACKUP_PREPARED_LIMITS, ...options.limits }; limitsCheck(limits);
    const directory = resolve(options.directory);
    await ancestors(dirname(directory));
    await mkdir(directory, { mode: 0o700 });
    await windowsFilePrivacy(directory, 'directory', true);
    const file = await open(join(directory, FILE), 'wx', 0o600); await file.close();
    await windowsFilePrivacy(join(directory, FILE), 'file', true);
    let db: DatabaseSync | undefined, store: PrivateBackupPreparedStore | undefined;
    try {
      db = new DatabaseSync(join(directory, FILE));
      db.exec(`PRAGMA page_size=${PAGE_BYTES}`); configure(db, limits.sqliteBytes);
      db.exec(`${TABLES.prepared_header}; ${TABLES.prepared_entries}; ${TABLES.prepared_chunks}; PRAGMA user_version=1;`);
      store = new PrivateBackupPreparedStore(directory, options.key, db, randomUUID(), options.workspaceId);
      store.saveHeader({ version: 1, storeId: store.storeId, workspaceId: store.workspaceId,
        entries: 0, bytes: 0, digest: store.emptyDigest(), sealed: false, limits }, true);
      fsyncDir(directory); fsyncDir(dirname(directory));
      return store;
    } catch (error) { if (store) await store.close(); else db?.close(); throw error; }
  }
  /** Only an internally generated store directory and trusted saved identity may be opened. */
  static async open(options: { directory: string; key: Buffer; storeId: string; workspaceId: string }): Promise<PrivateBackupPreparedStore> {
    keyCheck(options.key);
    if (!uuid(options.storeId) || !uuid(options.workspaceId)) fail();
    const directory = resolve(options.directory);
    await ownedFiles(directory, PRIVATE_BACKUP_PREPARED_LIMITS.sqliteBytes);
    let db: DatabaseSync | undefined, store: PrivateBackupPreparedStore | undefined;
    try {
      db = new DatabaseSync(join(directory, FILE));
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0;');
      schemaCheck(db); configure(db, PRIVATE_BACKUP_PREPARED_LIMITS.sqliteBytes);
      store = new PrivateBackupPreparedStore(directory, options.key, db, options.storeId, options.workspaceId);
      const header = store.header(); configure(db, header.limits.sqliteBytes);
      return store;
    } catch (error) { if (store) await store.close(); else db?.close(); throw error; }
  }
  private ready(): void { if (this.closed || this.closing) fail('The prepared backup store is closed.', 409); }
  private idle(): void { this.ready(); if (this.operation) fail('The prepared backup store is busy.', 409); }
  private emptyDigest(): string { return hash(JSON.stringify(['realbud-prepared-v1', this.storeId, this.workspaceId])); }
  private aad(purpose: string, ...bindings: (string | number)[]): Buffer {
    return Buffer.from(JSON.stringify(['realbud-prepared-v1', this.storeId, this.workspaceId, purpose, ...bindings]));
  }
  private encrypt(plain: Buffer, aad: Buffer): Buffer {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), body]);
  }
  private decrypt(payload: unknown, aad: Buffer, maxBytes: number): Buffer {
    try {
      if (!(payload instanceof Uint8Array) || payload.byteLength < OVERHEAD || payload.byteLength > maxBytes + OVERHEAD || payload[0] !== 1) fail();
      const bytes = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
      const cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(1, 13));
      cipher.setAAD(aad); cipher.setAuthTag(bytes.subarray(13, OVERHEAD));
      return Buffer.concat([cipher.update(bytes.subarray(OVERHEAD)), cipher.final()]);
    } catch { return fail(); }
  }
  private decode(payload: unknown, aad: Buffer): unknown {
    const plain = this.decrypt(payload, aad, META_BYTES);
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)); }
    catch { return fail(); } finally { plain.fill(0); }
  }
  private encryptedJson(value: unknown, aad: Buffer): Buffer {
    const plain = Buffer.from(JSON.stringify(value));
    try { if (plain.length > META_BYTES) fail(); return this.encrypt(plain, aad); }
    finally { plain.fill(0); }
  }
  private lookup(path: string): string {
    return createHmac('sha256', this.key).update(this.aad('path', path.toLowerCase())).digest('hex');
  }
  private header(): Header {
    if (this.closed) fail('The prepared backup store is closed.', 409);
    const rows = this.db.prepare('SELECT id,length(payload) AS size FROM prepared_header LIMIT 2').all();
    if (rows.length !== 1 || rows[0].id !== 1 || !integer(rows[0].size) || rows[0].size > META_BYTES + OVERHEAD) fail();
    const value = this.decode(this.db.prepare('SELECT payload FROM prepared_header WHERE id=1').get()?.payload, this.aad('header'));
    if (!exact(value, ['version', 'storeId', 'workspaceId', 'entries', 'bytes', 'digest', 'sealed', 'limits']) ||
        value.version !== 1 || value.storeId !== this.storeId || value.workspaceId !== this.workspaceId ||
        !integer(value.entries) || !integer(value.bytes) || !hex(value.digest) || typeof value.sealed !== 'boolean') fail();
    limitsCheck(value.limits);
    if (value.entries > value.limits.entries || value.bytes > value.limits.bytes) fail();
    return value as unknown as Header;
  }
  private saveHeader(header: Header, initial = false): void {
    const payload = this.encryptedJson(header, this.aad('header'));
    this.db.prepare(initial ? 'INSERT INTO prepared_header VALUES (1,?)' : 'UPDATE prepared_header SET payload=? WHERE id=1').run(payload);
  }
  private publicSummary(header: Header): PreparedSummary {
    const { version: _version, limits: _limits, ...summary } = header; return summary;
  }
  summary(): PreparedSummary { this.idle(); return this.publicSummary(this.header()); }
  private row(sequence: number): EntryRow | undefined {
    const bounds = this.db.prepare('SELECT length(payload) AS size FROM prepared_entries WHERE sequence=?').get(sequence);
    if (!bounds) return undefined;
    if (!integer(bounds.size) || bounds.size > META_BYTES + OVERHEAD) fail();
    return this.db.prepare('SELECT * FROM prepared_entries WHERE sequence=?').get(sequence) as unknown as EntryRow;
  }
  private metadata(row: EntryRow, header: Header): Metadata {
    if (!integer(row.sequence, 1) || row.sequence > header.entries || !uuid(row.entry_id) || !hex(row.lookup)) fail();
    const value = this.decode(row.payload, this.aad('entry', row.entry_id, row.sequence));
    if (!exact(value, ['version', 'entryId', 'sequence', 'path', 'beforeHash', 'intendedHash', 'bytes', 'chunks']) ||
        value.version !== 1 || value.entryId !== row.entry_id || value.sequence !== row.sequence || !validPath(value.path) ||
        !nullableHash(value.beforeHash) || !nullableHash(value.intendedHash) || !integer(value.bytes) || !integer(value.chunks) ||
        row.lookup !== this.lookup(value.path) || value.bytes > (value.path === DATABASE ? header.limits.bytes : header.limits.fileBytes) ||
        value.chunks !== Math.ceil(value.bytes / CHUNK) || value.intendedHash === null && (value.bytes !== 0 || value.chunks !== 0)) fail();
    return value as unknown as Metadata;
  }
  private manifest(previous: string, entry: Metadata): string { return hash(JSON.stringify([previous, entry])); }
  private publicEntry(entry: Metadata): PreparedEntry {
    const { version: _version, entryId: _entryId, chunks: _chunks, ...result } = entry; return result;
  }
  private run<T>(task: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> {
    try { this.idle(); aborted(external); } catch (error) { return Promise.reject(error); }
    const controller = new AbortController(), cancel = () => controller.abort();
    external?.addEventListener('abort', cancel, { once: true });
    const done = Promise.resolve().then(() => task(controller.signal)).finally(() => {
      external?.removeEventListener('abort', cancel); this.operation = undefined;
    });
    this.operation = { controller, done }; return done;
  }
  private async transaction<T>(signal: AbortSignal, body: (header: Header) => Promise<T>): Promise<T> {
    aborted(signal);
    await ownedFiles(this.directory, PRIVATE_BACKUP_PREPARED_LIMITS.sqliteBytes);
    aborted(signal);
    let began = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); began = true;
      const result = await body(this.header());
      aborted(signal); this.db.exec('COMMIT'); began = false;
      return result;
    } catch (error) {
      if (began) { try { this.db.exec('ROLLBACK'); } catch { /* SQLite may already have rolled back a full disk transaction. */ } }
      const code = (error as { code?: unknown; errcode?: unknown }).code;
      if (typeof code === 'string' && code.startsWith('ERR_SQLITE')) {
        if ((error as { errcode?: number }).errcode === 5) fail('The prepared backup store is busy.', 409);
        if ((error as { errcode?: number }).errcode === 13) fail('Prepared backup storage has reached its capacity.', 413);
        fail();
      }
      throw error;
    }
  }
  private admit(path: string, beforeHash: string | null, header: Header): void {
    if (!validPath(path) || !nullableHash(beforeHash)) fail('The prepared backup file identity is invalid.', 400);
    if (header.sealed) fail('The prepared backup is sealed. Prepare a new store to change its files.', 409);
    if (header.entries >= header.limits.entries) fail('The prepared backup reached its entry capacity.', 413);
    if (this.db.prepare('SELECT 1 FROM prepared_entries WHERE lookup=?').get(this.lookup(path))) fail('The prepared backup contains a duplicate file identity.', 409);
  }
  private commitEntry(entry: Metadata, header: Header): void {
    this.db.prepare('INSERT INTO prepared_entries VALUES (?,?,?,?)').run(entry.sequence, entry.entryId, this.lookup(entry.path), this.encryptedJson(entry, this.aad('entry', entry.entryId, entry.sequence)));
    header.entries++; header.bytes += entry.bytes; header.digest = this.manifest(header.digest, entry); this.saveHeader(header);
  }
  addFile(path: string, beforeHash: string | null, data: AsyncIterable<Uint8Array>, options: OperationOptions = {}): Promise<PreparedEntry> {
    return this.run(signal => this.transaction(signal, async header => {
      this.admit(path, beforeHash, header);
      if (!data || typeof data[Symbol.asyncIterator] !== 'function') fail('Prepared file bytes must be a stream.', 400);
      const iterator = data[Symbol.asyncIterator](), entry: Metadata = { version: 1, entryId: randomUUID(), sequence: header.entries + 1, path, beforeHash, intendedHash: '', bytes: 0, chunks: 0 };
      const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(CHUNK);
      const maxBytes = Math.min(header.limits.bytes - header.bytes, path === DATABASE ? header.limits.bytes : header.limits.fileBytes);
      let used = 0, finished = false, empty = 0;
      const save = () => {
        const chunk = buffer.subarray(0, used); digest.update(chunk);
        this.db.prepare('INSERT INTO prepared_chunks VALUES (?,?,?)').run(entry.entryId, entry.chunks, this.encrypt(chunk, this.aad('chunk', entry.entryId, entry.sequence, entry.chunks)));
        entry.chunks++; used = 0;
      };
      try {
        while (true) {
          const result = await next(iterator, signal); aborted(signal);
          if (result.done) { finished = true; break; }
          const value = result.value;
          if (!(value instanceof Uint8Array) || value.byteLength > CHUNK) fail('Prepared file bytes must use chunks up to 1 MiB.', 400);
          if (value.byteLength === 0) { if (++empty > 1024) fail('Prepared file stream made no progress.', 400); continue; }
          empty = 0;
          if (value.byteLength > maxBytes - entry.bytes) fail('The prepared backup reached its file or total byte capacity.', 413);
          entry.bytes += value.byteLength;
          for (let offset = 0; offset < value.byteLength;) {
            aborted(signal);
            const count = Math.min(CHUNK - used, value.byteLength - offset);
            buffer.set(value.subarray(offset, offset + count), used); used += count; offset += count;
            if (used === CHUNK) { save(); if (entry.chunks % 8 === 0) await yieldTurn(); }
          }
        }
        if (used) save();
        entry.intendedHash = digest.digest('hex'); this.commitEntry(entry, header);
        return this.publicEntry(entry);
      } finally {
        buffer.fill(0);
        // A stuck producer must not keep close()/rollback waiting indefinitely.
        if (!finished) { try { void Promise.resolve(iterator.return?.()).catch(() => undefined); } catch { /* Producer cleanup cannot make an incomplete entry visible. */ } }
      }
    }), options.signal);
  }
  addRemoval(path: string, beforeHash: string | null, options: OperationOptions = {}): Promise<PreparedEntry> {
    return this.run(signal => this.transaction(signal, async header => {
      this.admit(path, beforeHash, header);
      const entry: Metadata = { version: 1, entryId: randomUUID(), sequence: header.entries + 1, path, beforeHash, intendedHash: null, bytes: 0, chunks: 0 };
      this.commitEntry(entry, header); return this.publicEntry(entry);
    }), options.signal);
  }
  private sealed(): Header {
    const header = this.header(); if (!header.sealed) fail('The prepared backup has not been sealed.', 409); return header;
  }
  private *manifestEntries(header: Header): Iterable<Metadata> {
    let digest = this.emptyDigest(), bytes = 0;
    if (this.db.prepare('SELECT count(*) AS n FROM prepared_entries').get()?.n !== header.entries) fail();
    for (let sequence = 1; sequence <= header.entries; sequence++) {
      const row = this.row(sequence); if (!row) fail();
      const entry = this.metadata(row, header); bytes += entry.bytes; digest = this.manifest(digest, entry); yield entry;
    }
    if (bytes !== header.bytes || digest !== header.digest) fail();
  }
  /** Exhaust the iterator before trusting the complete ordered manifest. */
  *entries(): Iterable<PreparedEntry> {
    this.idle(); const header = this.sealed();
    for (const entry of this.manifestEntries(header)) { this.idle(); yield this.publicEntry(entry); }
  }
  private chunk(entry: Metadata, ordinal: number): Buffer {
    const bound = this.db.prepare('SELECT length(payload) AS size FROM prepared_chunks WHERE entry_id=? AND ordinal=?').get(entry.entryId, ordinal);
    const length = Math.min(CHUNK, entry.bytes - ordinal * CHUNK);
    if (bound?.size !== length + OVERHEAD) fail();
    const row = this.db.prepare('SELECT payload FROM prepared_chunks WHERE entry_id=? AND ordinal=?').get(entry.entryId, ordinal);
    const bytes = this.decrypt(row?.payload, this.aad('chunk', entry.entryId, entry.sequence, ordinal), CHUNK);
    if (bytes.length !== length) { bytes.fill(0); fail(); } return bytes;
  }
  private async checkContents(entry: Metadata, signal: AbortSignal): Promise<void> {
    if (this.db.prepare('SELECT count(*) AS n FROM prepared_chunks WHERE entry_id=?').get(entry.entryId)?.n !== entry.chunks) fail();
    if (entry.intendedHash === null) return;
    const digest = createHash('sha256');
    for (let ordinal = 0; ordinal < entry.chunks; ordinal++) {
      aborted(signal); const bytes = this.chunk(entry, ordinal);
      try { digest.update(bytes); } finally { bytes.fill(0); }
      if (ordinal % 8 === 7) await yieldTurn();
    }
    if (digest.digest('hex') !== entry.intendedHash) fail();
  }
  private async inspect(header: Header, signal: AbortSignal): Promise<PreparedSummary> {
    schemaCheck(this.db);
    let chunks = 0;
    for (const entry of this.manifestEntries(header)) {
      aborted(signal); await this.checkContents(entry, signal); chunks += entry.chunks;
      if (entry.sequence % 100 === 0) await yieldTurn();
    }
    if (this.db.prepare('SELECT count(*) AS n FROM prepared_chunks').get()?.n !== chunks) fail();
    return this.publicSummary(header);
  }
  seal(options: OperationOptions = {}): Promise<PreparedSummary> {
    return this.run(signal => this.transaction(signal, async header => {
      await this.inspect(header, signal);
      if (!header.sealed) { header.sealed = true; this.saveHeader(header); }
      return this.publicSummary(header);
    }), options.signal);
  }
  /** Reauthenticates every sealed entry, chunk, before hash and ordered manifest. */
  validate(options: OperationOptions = {}): Promise<PreparedSummary> {
    return this.run(signal => this.transaction(signal, async header => {
      if (!header.sealed) fail('The prepared backup has not been sealed.', 409);
      return this.inspect(header, signal);
    }), options.signal);
  }
  /** Each chunk is authenticated before yield. Exhaust to verify full hash/EOF.
   * Already yielded bytes must remain provisional until this iterator completes. */
  async *readFile(path: string, options: OperationOptions = {}): AsyncIterable<Buffer> {
    this.idle(); aborted(options.signal); const header = this.sealed();
    if (!validPath(path)) fail('The prepared backup file identity is invalid.', 400);
    const found = this.db.prepare('SELECT sequence FROM prepared_entries WHERE lookup=?').get(this.lookup(path));
    if (!found || !integer(found.sequence, 1)) fail('The prepared backup file was not found.', 404);
    const row = this.row(found.sequence); if (!row) fail();
    const entry = this.metadata(row, header);
    if (entry.path !== path || entry.intendedHash === null) fail('The prepared backup file was not found.', 404);
    const digest = createHash('sha256');
    for (let ordinal = 0; ordinal < entry.chunks; ordinal++) {
      this.idle(); aborted(options.signal);
      const bytes = this.chunk(entry, ordinal);
      try { digest.update(bytes); yield bytes; } finally { bytes.fill(0); }
    }
    this.idle(); aborted(options.signal);
    if (this.db.prepare('SELECT count(*) AS n FROM prepared_chunks WHERE entry_id=?').get(entry.entryId)?.n !== entry.chunks || digest.digest('hex') !== entry.intendedHash) fail();
  }
  close(): Promise<void> {
    if (this.closingPromise) return this.closingPromise;
    this.closing = true; this.operation?.controller.abort();
    this.closingPromise = (async () => {
      await this.operation?.done.catch(() => undefined);
      try { this.db.close(); } finally { this.key.fill(0); this.closed = true; }
    })(); return this.closingPromise;
  }
}

### server/private-backup-prepared.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, readFileSync, symlinkSync, linkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { PrivateBackupPreparedStore, PRIVATE_BACKUP_PREPARED_CHUNK_BYTES as CHUNK } from './private-backup-prepared.ts';

const roots: string[] = [], stores: PrivateBackupPreparedStore[] = [];
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
async function fixture(limits?: Parameters<typeof PrivateBackupPreparedStore.create>[0]['limits']) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'RealBud prepared Ω ')); roots.push(root);
  const directory = join(root, 'prepared'), key = randomBytes(32), workspaceId = randomUUID();
  const store = await PrivateBackupPreparedStore.create({ directory, key, workspaceId, limits }); stores.push(store);
  const options = { directory, key, workspaceId, storeId: store.storeId }; return { root, store, options };
}
async function reopen(options: Parameters<typeof PrivateBackupPreparedStore.open>[0]) { const store = await PrivateBackupPreparedStore.open(options); stores.push(store); return store; }
async function* bytes(value: Buffer | string) { const buffer = Buffer.from(value); for (let offset = 0; offset < buffer.length; offset += CHUNK) yield buffer.subarray(offset, offset + CHUNK); }
async function digest(input: AsyncIterable<Buffer>) { const h = createHash('sha256'); let count = 0; for await (const b of input) { expect(b.length).toBeLessThanOrEqual(CHUNK); h.update(b); count += b.length; } return { digest: h.digest('hex'), bytes: count }; }
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('exact encrypted prepared restore artifacts', () => {
  it('streams a database beyond the v1 48 MiB limit and reopens exact bytes with immutable removal metadata', async () => {
    const f = await fixture(), total = 52 * CHUNK + 17, h = createHash('sha256');
    async function* generated() { for (let offset = 0; offset < total; offset += CHUNK) { const b = Buffer.alloc(Math.min(CHUNK, total - offset), Math.floor(offset / CHUNK) % 251); h.update(b); yield b; } }
    await f.store.addFile('workflow-state.sqlite', null, generated()); const expected = h.digest('hex');
    await f.store.addRemoval('vault/USER.md', sha('fictional before'));
    expect(() => [...f.store.entries()]).toThrow(/sealed/);
    const summary = await f.store.seal(); await f.store.close();
    const opened = await reopen(f.options); expect(await opened.validate()).toEqual(summary);
    expect(await digest(opened.readFile('workflow-state.sqlite'))).toEqual({ digest: expected, bytes: total });
    expect([...opened.entries()][1]).toMatchObject({ path: 'vault/USER.md', beforeHash: sha('fictional before'), intendedHash: null, bytes: 0 });
    await expect(opened.addFile('vault/README.md', null, bytes('changed'))).rejects.toThrow(/sealed/);
    await expect(opened.readFile('vault/USER.md')[Symbol.asyncIterator]().next()).rejects.toThrow(/not found/);
  }, 30_000);

  it('authenticates owned identity and does not persist plaintext names, content or keys', async () => {
    const f = await fixture(), text = 'Fictional secret content Ω';
    await f.store.addFile('vault/USER.md', null, bytes(text)); await f.store.seal(); await f.store.close();
    const disk = readFileSync(join(f.options.directory, 'prepared.sqlite'));
    for (const needle of [Buffer.from(text), Buffer.from('vault/USER.md'), f.options.key]) expect(disk.includes(needle)).toBe(false);
    await expect(reopen({ ...f.options, key: randomBytes(32) })).rejects.toThrow();
    await expect(reopen({ ...f.options, workspaceId: randomUUID() })).rejects.toThrow();
    await expect(reopen({ ...f.options, storeId: randomUUID() })).rejects.toThrow();
  });

  it.each(['chunk', 'ordinal', 'orphan', 'schema'])('refuses %s corruption before a complete artifact is accepted', async attack => {
    const f = await fixture(); await f.store.addFile('vault/USER.md', null, bytes(Buffer.alloc(CHUNK + 1, 3))); await f.store.seal(); await f.store.close();
    const db = new DatabaseSync(join(f.options.directory, 'prepared.sqlite'));
    try {
      if (attack === 'chunk') db.exec('UPDATE prepared_chunks SET payload=zeroblob(length(payload)) WHERE ordinal=0');
      if (attack === 'ordinal') db.exec('UPDATE prepared_chunks SET ordinal=ordinal+10');
      if (attack === 'orphan') db.exec("INSERT INTO prepared_chunks VALUES ('unowned',0,X'00')");
      if (attack === 'schema') db.exec('CREATE TABLE injected (value TEXT)');
    } finally { db.close(); }
    await expect((async () => { const s = await reopen(f.options); await s.validate(); })()).rejects.toThrow(/recovery/);
  });

  it('rolls back partial producers and capacity failures without exposing entries', async () => {
    const f = await fixture({ bytes: 1024, fileBytes: 512 });
    await expect(f.store.addFile('vault/USER.md', null, (async function* () { yield Buffer.from('partial'); throw new Error('fictional producer'); })())).rejects.toThrow('fictional producer');
    expect(f.store.summary().entries).toBe(0);
    await expect(f.store.addFile('vault/USER.md', null, bytes(Buffer.alloc(513)))).rejects.toMatchObject({ status: 413 });
    expect(f.store.summary().entries).toBe(0);
    await f.store.addFile('vault/USER.md', null, bytes('complete')); await f.store.seal();
    expect(await digest(f.store.readFile('vault/USER.md'))).toEqual({ digest: sha('complete'), bytes: 8 });
  });

  it('aborts a stuck producer, drains its transaction on close and leaves a reusable empty store', async () => {
    const f = await fixture(); let started!: () => void, finish!: (value: IteratorResult<Uint8Array>) => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const source: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]() { return { next() { started(); return new Promise(resolve => { finish = resolve; }); }, async return() { return { done: true, value: undefined }; } }; } };
    const active = f.store.addFile('vault/USER.md', null, source); const rejected = expect(active).rejects.toThrow(/cancelled/);
    await entered; await expect(f.store.addRemoval('vault/README.md', null)).rejects.toThrow(/busy/);
    await f.store.close(); await rejected; finish({ done: false, value: Buffer.from('late bytes') });
    const opened = await reopen(f.options); expect(opened.summary().entries).toBe(0);
    await opened.addFile('vault/USER.md', null, bytes('fresh')); await opened.seal();
    expect(await digest(opened.readFile('vault/USER.md'))).toEqual({ digest: sha('fresh'), bytes: 5 });
  });

  it('rejects case aliases and stale open-handle writes after another handle seals', async () => {
    const f = await fixture(), other = await reopen(f.options);
    await f.store.addFile('vault/properties/Case.md', null, bytes('one'));
    await expect(other.addFile('vault/properties/case.md', null, bytes('two'))).rejects.toThrow(/duplicate/);
    await f.store.seal(); await expect(other.addRemoval('vault/USER.md', null)).rejects.toThrow(/sealed/);
  });

  it.each(['symlink', 'hardlink', 'permissions'])('refuses %s storage', async attack => {
    const f = await fixture(); await f.store.close(); const file = join(f.options.directory, 'prepared.sqlite');
    if (attack === 'symlink') { const alias = join(f.root, 'alias'); symlinkSync(f.options.directory, alias); await expect(reopen({ ...f.options, directory: alias })).rejects.toThrow(); }
    if (attack === 'hardlink') { linkSync(file, join(f.root, 'linked.sqlite')); await expect(reopen(f.options)).rejects.toThrow(); }
    if (attack === 'permissions' && process.platform !== 'win32') { chmodSync(file, 0o644); await expect(reopen(f.options)).rejects.toThrow(); }
  });
});
