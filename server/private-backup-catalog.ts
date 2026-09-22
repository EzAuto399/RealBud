/** Internally created, target-key encrypted logical backup catalog.
 * This module accepts logical entries only. It never accepts an uploaded SQLite
 * file or an uploaded schema, and never stores a source/archive key. */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decryptBytes, decryptJson, encryptBytes, encryptJson, isEncryptedEnvelope } from './desk-crypto.ts';
import { windowsFilePrivacy } from './windows-file-privacy.ts';
import { fsyncDir } from './atomic.ts';
import { WORKFLOW_MAX_ENCRYPTED_RECORD_LENGTH } from './workflow-database.ts';
import { decodeDeskPlain } from './desk-v3-decode.ts';
import { isPrivateBackupPath, validatePrivateBusinessFile, validatePrivateLogicalRecord, validatePrivateWorkspaceIdentity, validatePrivatePackHistoryFiles } from './private-workspace-backup.ts';
import { validateSourceBillGraph, type BillLookup, type BillLookupStore } from './source-bill-graph.ts';
import { validateExecutionGraph } from './execution-history-backup.ts';
import { validateBackupMailGraph } from './private-backup-mail-validation.ts';
import { validateSavedBillReviewDraft, validateBillReviewDraftProposalLink } from './bill-review-drafts.ts';
import { validateBankReviewLinks } from './bank-reference-validation.ts';
import { validateWebsiteWorkGraph } from './website-work-backup.ts';
import { validateDepartmentWorkGraph } from './department-work-backup.ts';

export interface CatalogFile { path: string; encoding: 'bytes' | 'json'; data: Buffer }
export interface CatalogRecord { id: string; kind: string; revision: number; value: unknown }
export interface CatalogLimits { maxEntries: number; maxBytes: number; maxStorageBytes?: number }
export interface CatalogIdentity { catalogId: string; workspaceId: string }
export interface CatalogSummary extends CatalogIdentity {
  entries: number; files: number; records: number; plainBytes: number; digest: string; sealed: boolean;
}
interface Header extends CatalogSummary { version: 1; limits: CatalogLimits }
interface EntryMetadata {
  version: 1; entryId: string; sequence: number; category: 'file' | 'record';
  identity: string; kind: string; revision: number; encoding: 'bytes' | 'json';
  bytes: number; sha256: string;
}
interface StoredEntry { sequence: number; entry_id: string; category: string; lookup: string; kind: string; metadata: string; payload: string }
const FILE_NAME = 'catalog.sqlite';
const WORKSPACE = 'company-installation/workspace.json';
const PRIVATE = 'company-installation/private/';
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const EMPTY_DIGEST = createHash('sha256').update('realbud-private-catalog-v1').digest('hex');
const PAGE_BYTES = 4096;
/** Documented upper bound for one catalog SQLite file. Not aggregate quota or free disk. */
const MAX_CATALOG_STORAGE_BYTES = 64 * 1024 ** 3;
const BILL_LOOKUP_STORAGE_BYTES = 64 * 1024 ** 2;
const MAX_SECTOR_BYTES = 65_536;
const HEADER_PAYLOAD_MAX = 16 * 1024;
const METADATA_PAYLOAD_MAX = 16 * 1024;
const ENTRY_PAYLOAD_MAX = 16 * 1024 * 1024;
const PER_ENTRY_STORAGE_OVERHEAD = 16 * 1024;
const PAYLOAD_STORAGE_EXPANSION = 2;
const CATALOG_FIXED_STORAGE_BYTES = 64 * PAGE_BYTES;
const TABLES = {
  catalog_header: 'CREATE TABLE catalog_header (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)',
  catalog_entries: 'CREATE TABLE catalog_entries (sequence INTEGER PRIMARY KEY, entry_id TEXT NOT NULL UNIQUE, category TEXT NOT NULL, lookup TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, metadata TEXT NOT NULL, payload TEXT NOT NULL)',
};
const INDEX = 'CREATE INDEX catalog_entries_kind ON catalog_entries(category,kind,sequence)';
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) < Number.MAX_SAFE_INTEGER;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
function invalid(message = 'The private backup catalog needs recovery. Its original files were preserved.', status = 400): never {
  throw Object.assign(new Error(message), { status });
}
function jsonBytes(data: Buffer): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); }
  catch { return invalid('A logical backup JSON entry is malformed.'); }
}
function expectedEncoding(path: string): CatalogFile['encoding'] {
  return path === 'desk.json' || path.startsWith(PRIVATE) ? 'json' : 'bytes';
}
function checkKey(key: Buffer): void { if (!Buffer.isBuffer(key) || key.length !== 32) invalid('A protected installation key is required.'); }
function checkLimits(limits: CatalogLimits): void {
  if (!integer(limits.maxEntries, 1) || limits.maxEntries > 1_000_000 || !integer(limits.maxBytes, 1) || limits.maxBytes > 16 * 1024 ** 3) invalid('The backup catalog limits are invalid.');
  if (limits.maxStorageBytes !== undefined && (!integer(limits.maxStorageBytes, 65_536) || limits.maxStorageBytes > MAX_CATALOG_STORAGE_BYTES || limits.maxStorageBytes % PAGE_BYTES !== 0)) invalid('The backup catalog limits are invalid.');
}
function readLimits(value: unknown): CatalogLimits {
  if (!object(value)) invalid();
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'maxBytes,maxEntries' && keys !== 'maxBytes,maxEntries,maxStorageBytes') invalid();
  const limits: CatalogLimits = { maxEntries: value.maxEntries as number, maxBytes: value.maxBytes as number };
  if (keys === 'maxBytes,maxEntries,maxStorageBytes') limits.maxStorageBytes = value.maxStorageBytes as number;
  checkLimits(limits);
  return limits;
}
function defaultMaxStorageBytes(limits: { maxEntries: number; maxBytes: number }): number {
  const derived = CATALOG_FIXED_STORAGE_BYTES + limits.maxEntries * PER_ENTRY_STORAGE_OVERHEAD + limits.maxBytes * PAYLOAD_STORAGE_EXPANSION;
  if (!Number.isSafeInteger(derived) || derived > MAX_CATALOG_STORAGE_BYTES) return MAX_CATALOG_STORAGE_BYTES;
  return Math.ceil(derived / PAGE_BYTES) * PAGE_BYTES;
}
function resolvedStorageBytes(limits: CatalogLimits): number {
  return limits.maxStorageBytes ?? defaultMaxStorageBytes(limits);
}
function rollbackBudget(databaseBytes: number): number {
  const pages = Math.max(1, Math.floor(databaseBytes / PAGE_BYTES));
  // Main-database spilling is disabled: one journal segment, at most one
  // preimage per page, eight record bytes, and conservative sector padding.
  // This formula must not be reused for a connection with spilling enabled.
  return 2 * MAX_SECTOR_BYTES + pages * (PAGE_BYTES + 8);
}
/** Conservative coordinator charge for this catalog file plus a DELETE-mode rollback journal.
 * Does not enforce aggregate quota or remaining disk space. */
export function catalogStorageBudget(limits: CatalogLimits): { databaseBytes: number; rollbackBytes: number; totalBytes: number } {
  checkLimits(limits);
  const databaseBytes = resolvedStorageBytes(limits);
  const rollbackBytes = rollbackBudget(databaseBytes);
  return { databaseBytes, rollbackBytes, totalBytes: databaseBytes + rollbackBytes };
}
function isSqliteError(error: unknown): error is { code: string; errcode?: number; message?: string } {
  return !!error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' && (error as { code: string }).code.startsWith('ERR_SQLITE');
}
function isSqliteFull(error: unknown): boolean {
  return isSqliteError(error) && (error.errcode === 13 || /SQLITE_FULL/.test(String(error.message ?? '')));
}
function rollbackQuietly(db: DatabaseSync): void {
  try { db.exec('ROLLBACK'); } catch { /* SQLITE_FULL auto-rollback must not replace the original error. */ }
}
function rethrowTransaction(error: unknown): never {
  if (isSqliteFull(error)) invalid('The private backup catalog reached its declared capacity. No partial backup is valid.', 413);
  if (isSqliteError(error)) invalid('The catalog contains a duplicate identity or could not save this entry.');
  throw error;
}
function configure(db: DatabaseSync, storageBytes: number, mode: 'create' | 'open'): void {
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-2048; PRAGMA cache_spill=OFF; PRAGMA busy_timeout=1500;');
  if (db.prepare('PRAGMA journal_mode=DELETE').get()?.journal_mode !== 'delete') invalid();
  if (db.prepare('PRAGMA page_size').get()?.page_size !== PAGE_BYTES || db.prepare('PRAGMA cache_spill').get()?.cache_spill !== 0) invalid();
  const maxPages = Math.floor(storageBytes / PAGE_BYTES);
  if (!integer(maxPages, 1)) invalid('The backup catalog limits are invalid.');
  const applied = Number(db.prepare(`PRAGMA max_page_count=${maxPages}`).get()?.max_page_count);
  if (applied !== maxPages) {
    if (mode === 'create') invalid('The private backup catalog reached its declared capacity. No partial backup is valid.', 413);
    invalid();
  }
}
function rejectTempSort(db: DatabaseSync): void {
  const plans = [
    db.prepare('EXPLAIN QUERY PLAN SELECT sequence FROM catalog_entries NOT INDEXED WHERE category=? ORDER BY sequence').all('file'),
    db.prepare('EXPLAIN QUERY PLAN SELECT sequence FROM catalog_entries INDEXED BY catalog_entries_kind WHERE category=? AND kind=? ORDER BY sequence').all('record', 'fixture'),
  ];
  if (plans.flat().some(row => /TEMP B-TREE/i.test(String(row.detail)))) invalid();
}
async function safeAncestors(path: string): Promise<void> {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) invalid('Private backup storage contains a linked or invalid folder.');
  }
}
async function checkOwnedDirectory(directory: string): Promise<void> {
  await safeAncestors(directory);
  const stat = await lstat(directory);
  if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || typeof process.getuid === 'function' && stat.uid !== process.getuid())) invalid('Private backup storage permissions need recovery.');
  await windowsFilePrivacy(directory, 'directory');
}

export class PrivateBackupCatalog {
  readonly directory: string;
  readonly catalogId: string;
  readonly workspaceId: string;
  private db: DatabaseSync;
  private key: Buffer;
  private closed = false;

  private constructor(directory: string, key: Buffer, db: DatabaseSync, identity: CatalogIdentity) {
    this.directory = directory; this.key = Buffer.from(key); this.db = db;
    this.catalogId = identity.catalogId; this.workspaceId = identity.workspaceId;
  }

  static async create(options: { directory: string; key: Buffer; workspaceId: string } & CatalogLimits): Promise<PrivateBackupCatalog> {
    checkKey(options.key); checkLimits(options);
    if (!uuid(options.workspaceId)) invalid('The backup workspace identity is invalid.');
    const directory = resolve(options.directory);
    await safeAncestors(dirname(directory));
    await mkdir(directory, { mode: 0o700 }); // Existing paths are never repaired or overwritten.
    await windowsFilePrivacy(directory, 'directory', true);
    const handle = await open(join(directory, FILE_NAME), 'wx', 0o600);
    await handle.close();
    await windowsFilePrivacy(join(directory, FILE_NAME), 'file', true);
    const storage = options.maxStorageBytes ?? defaultMaxStorageBytes(options);
    let db: DatabaseSync | undefined, catalog: PrivateBackupCatalog | undefined;
    try {
      db = new DatabaseSync(join(directory, FILE_NAME));
      db.exec(`PRAGMA page_size=${PAGE_BYTES}`);
      configure(db, storage, 'create');
      db.exec(`${TABLES.catalog_header}; ${TABLES.catalog_entries}; ${INDEX}; PRAGMA user_version=1;`);
      rejectTempSort(db);
      catalog = new PrivateBackupCatalog(directory, options.key, db, { catalogId: randomUUID(), workspaceId: options.workspaceId });
      const header: Header = { version: 1, catalogId: catalog.catalogId, workspaceId: catalog.workspaceId,
        entries: 0, files: 0, records: 0, plainBytes: 0, digest: EMPTY_DIGEST, sealed: false,
        limits: { maxEntries: options.maxEntries, maxBytes: options.maxBytes, maxStorageBytes: storage } };
      db.prepare('INSERT INTO catalog_header VALUES (1,?)').run(JSON.stringify(encryptJson(catalog.key, header)));
      await fsyncDir(directory);
      await fsyncDir(dirname(directory));
      return catalog;
    } catch (error) { if (catalog) catalog.close(); else db?.close(); if (isSqliteFull(error)) invalid('The private backup catalog reached its declared capacity. No partial backup is valid.', 413); throw error; }
  }

  /** The caller supplies an owned internal directory and its saved catalog ID.
   * No browser path or archive-provided database is accepted by this API. */
  static async open(options: { directory: string; key: Buffer; catalogId: string; workspaceId: string }): Promise<PrivateBackupCatalog> {
    checkKey(options.key);
    if (!uuid(options.catalogId) || !uuid(options.workspaceId)) invalid();
    const directory = resolve(options.directory);
    await checkOwnedDirectory(directory);
    const names = await readdir(directory);
    if (!names.includes(FILE_NAME) || names.some(name => ![FILE_NAME, `${FILE_NAME}-journal`].includes(name))) invalid();
    for (const name of await readdir(directory)) {
      const path = join(directory, name), stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || typeof process.getuid === 'function' && stat.uid !== process.getuid())) invalid();
      // Older internal writers allowed spill segments. Admit their bounded
      // journal for SQLite recovery; the new connection never produces them.
      const legacyJournalMax = MAX_CATALOG_STORAGE_BYTES / PAGE_BYTES * (PAGE_BYTES + 8 + 2 * MAX_SECTOR_BYTES) + 2 * MAX_SECTOR_BYTES;
      if (stat.size > (name === `${FILE_NAME}-journal` ? legacyJournalMax : MAX_CATALOG_STORAGE_BYTES)) invalid();
      await windowsFilePrivacy(path, 'file');
    }
    let db: DatabaseSync | undefined, catalog: PrivateBackupCatalog | undefined;
    try {
      db = new DatabaseSync(join(directory, FILE_NAME));
      configure(db, MAX_CATALOG_STORAGE_BYTES, 'open');
      const version = db.prepare('PRAGMA user_version').get();
      const schema = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 5").all();
      if (version?.user_version !== 1 || schema.length !== 3 || schema.some(row =>
        row.name === 'catalog_entries_kind' ? row.type !== 'index' || row.sql !== INDEX :
          row.type !== 'table' || !(String(row.name) in TABLES) || row.sql !== TABLES[row.name as keyof typeof TABLES])) invalid();
      rejectTempSort(db);
      catalog = new PrivateBackupCatalog(directory, options.key, db, options);
      const header = catalog.header();
      const storage = resolvedStorageBytes(header.limits);
      if ((await lstat(join(directory, FILE_NAME))).size > storage) invalid();
      const journal = await lstat(join(directory, `${FILE_NAME}-journal`)).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
      if (journal && journal.size > rollbackBudget(storage)) invalid();
      configure(db, storage, 'open');
      return catalog;
    } catch (error) { if (catalog) catalog.close(); else db?.close(); if (isSqliteFull(error)) invalid('The private backup catalog reached its declared capacity. No partial backup is valid.', 413); throw error; }
  }

  private ready(): void { if (this.closed) invalid('The private backup catalog is closed.', 409); }
  private index(category: string, identity: string): string {
    return createHmac('sha256', this.key).update(JSON.stringify([this.catalogId, category, identity])).digest('hex');
  }
  private header(): Header {
    this.ready();
    try {
      const rows = this.db.prepare("SELECT id,CASE WHEN typeof(payload)='text' AND length(CAST(payload AS BLOB))<=? THEN payload END AS payload FROM catalog_header LIMIT 2").all(HEADER_PAYLOAD_MAX);
      if (rows.length !== 1 || rows[0].id !== 1 || typeof rows[0].payload !== 'string') invalid();
      const row = rows[0];
      const header = decryptJson(this.key, JSON.parse(String(row?.payload))) as Header;
      if (!object(header) || Object.keys(header).length !== 10 || header.version !== 1 || header.catalogId !== this.catalogId || header.workspaceId !== this.workspaceId ||
          ![header.entries, header.files, header.records, header.plainBytes].every(value => integer(value)) || header.entries !== header.files + header.records || !hex(header.digest) || typeof header.sealed !== 'boolean') invalid();
      header.limits = readLimits(header.limits);
      if (header.entries > header.limits.maxEntries || header.plainBytes > header.limits.maxBytes) invalid();
      return header;
    } catch { invalid(); }
  }
  summary(): CatalogSummary {
    const { version: _version, limits: _limits, ...summary } = this.header();
    return summary;
  }
  countRecords(kind?: string): number { return this.count('record', kind); }
  countFiles(): number { return this.count('file'); }
  private count(category: 'file' | 'record', kind?: string): number {
    this.ready();
    const row = kind === undefined
      ? this.db.prepare('SELECT count(*) AS count FROM catalog_entries WHERE category=?').get(category)
      : this.db.prepare('SELECT count(*) AS count FROM catalog_entries WHERE category=? AND kind=?').get(category, this.index('kind', kind));
    return Number(row!.count);
  }
  private entry(sequence: number): StoredEntry | undefined {
    // Bounds and values share one SQL statement, including outside validation's
    // transaction. Corrupt payloads never enter JS just to check their length.
    const row = this.db.prepare(`SELECT sequence,
      CASE WHEN length(entry_id)<=36 THEN entry_id END AS entry_id,
      CASE WHEN length(category)<=6 THEN category END AS category,
      CASE WHEN length(lookup)<=64 THEN lookup END AS lookup,
      CASE WHEN length(kind)<=64 THEN kind END AS kind,
      CASE WHEN typeof(metadata)='text' AND length(CAST(metadata AS BLOB))<=? THEN metadata END AS metadata,
      CASE WHEN typeof(payload)='text' AND length(CAST(payload AS BLOB))<=? THEN payload END AS payload
      FROM catalog_entries WHERE sequence=?`).get(METADATA_PAYLOAD_MAX, ENTRY_PAYLOAD_MAX, sequence);
    if (!row) return undefined;
    if (['entry_id', 'category', 'lookup', 'kind', 'metadata', 'payload'].some(key => typeof row[key] !== 'string')) invalid();
    return row as unknown as StoredEntry;
  }
  private metadata(row: StoredEntry): EntryMetadata {
    try {
      const value = decryptJson(this.key, JSON.parse(row.metadata)) as EntryMetadata;
      if (!object(value) || Object.keys(value).length !== 10 || value.version !== 1 || !uuid(value.entryId) || value.entryId !== row.entry_id || value.sequence !== row.sequence ||
          !integer(value.sequence, 1) || value.category !== row.category || !['file', 'record'].includes(value.category) || typeof value.identity !== 'string' || typeof value.kind !== 'string' ||
          !integer(value.revision) || !['bytes', 'json'].includes(value.encoding) || !integer(value.bytes) || value.bytes > MAX_ENTRY_BYTES || !hex(value.sha256) ||
          row.lookup !== this.index(value.category, value.category === 'file' ? value.identity.toLowerCase() : value.identity) || row.kind !== this.index('kind', value.kind)) invalid();
      if (value.category === 'file' && (!isPrivateBackupPath(value.identity) || value.encoding !== expectedEncoding(value.identity) || value.kind !== '' || value.revision !== 0)) invalid();
      if (value.category === 'record' && (value.encoding !== 'json' || !integer(value.revision, 1))) invalid();
      return value;
    } catch { invalid(); }
  }
  private body(row: StoredEntry, meta: EntryMetadata): Buffer {
    try {
      if (meta.category === 'record' && row.payload.length > WORKFLOW_MAX_ENCRYPTED_RECORD_LENGTH) invalid('A workflow record exceeds its encrypted entity limit.', 413);
      const envelope: unknown = JSON.parse(row.payload);
      if (!isEncryptedEnvelope(envelope)) invalid();
      const bytes = decryptBytes(this.key, envelope);
      if (bytes.length !== meta.bytes || digest(bytes) !== meta.sha256) invalid();
      return bytes;
    } catch { invalid(); }
  }
  private insert(category: 'file' | 'record', identity: string, kind: string, revision: number, encoding: CatalogFile['encoding'], data: Buffer): void {
    this.ready();
    if (data.length > MAX_ENTRY_BYTES) invalid('A backup entry exceeds its entity limit.', 413);
    const payload = JSON.stringify(encryptBytes(this.key, data));
    if (category === 'record' && payload.length > WORKFLOW_MAX_ENCRYPTED_RECORD_LENGTH) invalid('A workflow record exceeds its encrypted entity limit.', 413);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const header = this.header();
      if (header.sealed) invalid('The backup catalog is sealed. Create a new catalog to capture different data.', 409);
      if (header.entries >= header.limits.maxEntries || header.plainBytes + data.length > header.limits.maxBytes) invalid('The private backup catalog reached its declared capacity. No partial backup is valid.', 413);
      const meta: EntryMetadata = { version: 1, entryId: randomUUID(), sequence: header.entries + 1, category, identity, kind, revision, encoding, bytes: data.length, sha256: digest(data) };
      this.db.prepare('INSERT INTO catalog_entries VALUES (?,?,?,?,?,?,?)').run(meta.sequence, meta.entryId, category,
        this.index(category, category === 'file' ? identity.toLowerCase() : identity), this.index('kind', kind), JSON.stringify(encryptJson(this.key, meta)), payload);
      header.entries++; header[category === 'file' ? 'files' : 'records']++; header.plainBytes += data.length;
      header.digest = digest(JSON.stringify([header.digest, meta]));
      this.db.prepare('UPDATE catalog_header SET payload=? WHERE id=1').run(JSON.stringify(encryptJson(this.key, header)));
      this.db.exec('COMMIT');
    } catch (error) {
      rollbackQuietly(this.db);
      rethrowTransaction(error);
    }
  }
  addFile(file: CatalogFile): void {
    if (!isPrivateBackupPath(file.path) || file.encoding !== expectedEncoding(file.path) || !Buffer.isBuffer(file.data)) invalid('The logical backup file is invalid.');
    this.validateFile(file);
    this.insert('file', file.path, '', 0, file.encoding, file.data);
  }
  addRecord(record: CatalogRecord): void {
    validatePrivateLogicalRecord(record);
    if (record.kind === 'bill-review-draft') validateSavedBillReviewDraft(record.id, record.revision, record.value, this.workspaceId);
    this.insert('record', record.id, record.kind, record.revision, 'json', Buffer.from(JSON.stringify(record.value)));
  }
  private *rows(category: 'file' | 'record', kind?: string): Iterable<StoredEntry> {
    this.ready();
    // The unfiltered-kind path walks the rowid tree; the kind-filtered path
    // uses the covering index. Neither sorts or loads unrelated payloads.
    const statement = kind === undefined
      ? this.db.prepare('SELECT sequence FROM catalog_entries NOT INDEXED WHERE category=? ORDER BY sequence')
      : this.db.prepare('SELECT sequence FROM catalog_entries INDEXED BY catalog_entries_kind WHERE category=? AND kind=? ORDER BY sequence');
    for (const id of (kind === undefined ? statement.iterate(category) : statement.iterate(category, this.index('kind', kind)))) {
      const row = this.entry(Number(id.sequence)); if (!row) invalid(); yield row;
    }
  }
  private find(category: 'file' | 'record', identity: string): StoredEntry | undefined {
    this.ready();
    const bound = this.db.prepare('SELECT sequence FROM catalog_entries WHERE category=? AND lookup=?').get(category, this.index(category, category === 'file' ? identity.toLowerCase() : identity));
    if (!bound) return undefined;
    if (!integer(bound.sequence, 1)) invalid();
    const row = this.entry(Number(bound.sequence));
    if (!row) invalid();
    return row;
  }
  getFile(path: string): CatalogFile | undefined {
    const row = this.find('file', path);
    if (!row) return undefined;
    const meta = this.metadata(row);
    if (meta.identity !== path) return undefined;
    return { path: meta.identity, encoding: meta.encoding, data: this.body(row, meta) };
  }
  *filePaths(): Iterable<string> {
    this.ready();
    // Only encrypted metadata enters JS; business bodies remain on disk.
    for (const row of this.db.prepare(`SELECT sequence,
      CASE WHEN length(entry_id)<=36 THEN entry_id END AS entry_id,
      category,
      CASE WHEN length(lookup)<=64 THEN lookup END AS lookup,
      CASE WHEN length(kind)<=64 THEN kind END AS kind,
      CASE WHEN typeof(metadata)='text' AND length(CAST(metadata AS BLOB))<=? THEN metadata END AS metadata
      FROM catalog_entries NOT INDEXED WHERE category='file' ORDER BY sequence`).iterate(METADATA_PAYLOAD_MAX)) {
      if (typeof row.metadata !== 'string') invalid();
      yield this.metadata(row as unknown as StoredEntry).identity;
    }
  }
  *iterateFiles(): Iterable<CatalogFile> {
    for (const row of this.rows('file')) { const meta = this.metadata(row); yield { path: meta.identity, encoding: meta.encoding, data: this.body(row, meta) }; }
  }
  getRecord(kind: string, id: string): CatalogRecord | undefined {
    const row = this.find('record', id);
    if (!row) return undefined;
    const meta = this.metadata(row);
    if (meta.kind !== kind || meta.identity !== id) return undefined;
    return { id, kind, revision: meta.revision, value: jsonBytes(this.body(row, meta)) };
  }
  *iterateRecords(kind?: string): Iterable<CatalogRecord> {
    for (const row of this.rows('record', kind)) {
      const meta = this.metadata(row);
      yield { id: meta.identity, kind: meta.kind, revision: meta.revision, value: jsonBytes(this.body(row, meta)) };
    }
  }
  private validateFile(file: CatalogFile): void {
    if (file.data.length > MAX_ENTRY_BYTES) invalid('A backup file exceeds its entity limit.', 413);
    if (!file.path.endsWith('.json')) return;
    let value: unknown;
    value = jsonBytes(file.data);
    if (file.path === WORKSPACE) validatePrivateWorkspaceIdentity(value, this.workspaceId);
    else if (file.path === 'desk.json') decodeDeskPlain(value, { properties: [], ledger: [] }, 'UTC');
    else if (file.path.startsWith(PRIVATE)) {
      if (!object(value) || Object.keys(value).sort().join(',') !== 'name,value' || value.name !== file.path.split('/').at(-1)!.slice(0, -5) || !object(value.value)) invalid('Saved mail evidence has an invalid identity.');
      if (JSON.stringify(encryptJson(this.key, value)).length > 2_000_000) invalid('Saved legacy mail evidence exceeds its entity limit.', 413);
    } else if (['agency-setup.json', 'workspace-views/tabs.json'].includes(file.path) && (!object(value) || value.workspaceId !== this.workspaceId)) invalid('Saved settings belong to another workspace.');
    validatePrivateBusinessFile(file.path, value);
  }
  /** Full integrity and business graph admission. No trusted preview should be
   * issued from individual add calls or counts alone. All reads share a snapshot. */
  validate(): CatalogSummary { return this.validateAndSeal(false); }
  /** The authenticated seal is committed in the same transaction as graph
   * validation. Independent/reopened writers must read it before every insert. */
  seal(): CatalogSummary { return this.validateAndSeal(true); }
  private validateAndSeal(seal: boolean): CatalogSummary {
    this.ready();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const header = this.header();
      if (Number(this.db.prepare('SELECT count(*) AS count FROM catalog_entries').get()?.count) !== header.entries) invalid();
      let count = 0, files = 0, records = 0, plainBytes = 0, chain = EMPTY_DIGEST;
      for (let sequence = 1; sequence <= header.entries; sequence++) {
        const stored = this.entry(sequence);
        if (!stored) invalid();
        const meta = this.metadata(stored), data = this.body(stored, meta);
        if (meta.sequence !== ++count) invalid();
        plainBytes += data.length; chain = digest(JSON.stringify([chain, meta]));
        if (meta.category === 'file') { files++; this.validateFile({ path: meta.identity, encoding: meta.encoding, data }); }
        else {
          records++;
          const value = jsonBytes(data);
          validatePrivateLogicalRecord({ id: meta.identity, kind: meta.kind, revision: meta.revision, value });
          if (meta.kind === 'bank') validateBankReviewLinks({id:meta.identity,revision:meta.revision,value},id=>this.getRecord('bank',id));
          if (meta.kind === 'bill-review-draft') {
            const draft = validateSavedBillReviewDraft(meta.identity, meta.revision, value, this.workspaceId);
            const request = draft.proposalRequest;
            validateBillReviewDraftProposalLink(draft, request ? this.getRecord('bill-proposal', `bill-proposal:${request.requestId}`) : undefined);
          }
        }
      }
      if (count !== header.entries || files !== header.files || records !== header.records || plainBytes !== header.plainBytes || chain !== header.digest) invalid();
      if (!this.getFile(WORKSPACE) || !this.getFile('desk.json')) invalid('The backup must include its workspace identity and Desk book.');
      validatePrivatePackHistoryFiles({ get: path => this.getFile(path)?.data, paths: () => this.filePaths() });
      const reader = { get: (kind: string, id: string) => this.getRecord(kind, id), iterate: (kind: string) => this.iterateRecords(kind) };
      validateBackupMailGraph(reader, { get: path => this.getFile(path), paths: () => this.filePaths() }, this.workspaceId);
      // Derived graph lookups do not grow the sealed catalog or its rollback
      // journal. Their separate 64 MiB in-memory database has a hard page cap.
      const lookups = new DatabaseSync(':memory:');
      try {
        lookups.exec(`PRAGMA page_size=${PAGE_BYTES}; PRAGMA max_page_count=${BILL_LOOKUP_STORAGE_BYTES / PAGE_BYTES}; CREATE TABLE catalog_bill_lookups (id TEXT PRIMARY KEY, payload TEXT NOT NULL);`);
        if (lookups.prepare('PRAGMA page_size').get()?.page_size !== PAGE_BYTES || lookups.prepare('PRAGMA max_page_count').get()?.max_page_count !== BILL_LOOKUP_STORAGE_BYTES / PAGE_BYTES) invalid();
        validateSourceBillGraph(reader, this.billLookups(lookups));
      } finally { lookups.close(); }
      const history: Record<string, string> = {};
      for (const path of ['job-runs.json', 'loops.json']) {
        const file = this.getFile(path);
        if (file) history[path] = file.data.toString('utf8');
      }
      validateExecutionGraph(reader, history);
      validateWebsiteWorkGraph(reader, this.workspaceId);
      validateDepartmentWorkGraph(reader, this.workspaceId);
      if (seal && !header.sealed) {
        header.sealed = true;
        this.db.prepare('UPDATE catalog_header SET payload=? WHERE id=1').run(JSON.stringify(encryptJson(this.key, header)));
      }
      this.db.exec('COMMIT');
      return { catalogId: this.catalogId, workspaceId: this.workspaceId, entries: count, files, records, plainBytes, digest: chain, sealed: header.sealed };
    } catch (error) { rollbackQuietly(this.db); rethrowTransaction(error); }
  }
  private billLookups(db: DatabaseSync): BillLookupStore {
    // Every derived lookup must correspond to a retained physical record.
    // A hostile head cannot expand scratch beyond the admitted catalog count.
    const maximum = this.countRecords();
    let count = 0;
    return {
      get: id => {
        const row = db.prepare('SELECT payload FROM catalog_bill_lookups WHERE id=?').get(this.index('bill-lookup', id));
        if (!row) return undefined;
        const saved = decryptJson(this.key, JSON.parse(String(row.payload))) as { id: string; lookup: BillLookup };
        if (saved.id !== id) invalid();
        return saved.lookup;
      },
      set: (id, lookup) => {
        const identity = this.index('bill-lookup', id);
        const exists = db.prepare('SELECT 1 FROM catalog_bill_lookups WHERE id=?').get(identity);
        if (!exists && count >= maximum) invalid('The derived bill graph exceeds its retained catalog identities.');
        db.prepare('INSERT INTO catalog_bill_lookups VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload')
          .run(identity, JSON.stringify(encryptJson(this.key, { id, lookup })));
        if (!exists) count++;
      },
      count: () => count,
    };
  }
  close(): void {
    if (this.closed) return;
    this.db.close(); this.key.fill(0); this.closed = true;
  }
}
