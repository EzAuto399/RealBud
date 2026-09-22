You are a bounded implementation specialist for RealBud. Work only from supplied source. No tools, no external actions, no secrets. The user explicitly prefers Grok 4.6 xhigh. Codex owns integration and testing. Supply a concrete unified diff for ONLY server/private-backup-catalog.ts and server/private-backup-catalog.test.ts. You are not alone in the codebase: preserve unrelated changes. Do not change other files. Return JSON with summary, patch (unified diff string), and risks. Do not return full unchanged files.

Task: close the logical-catalog physical SQLite storage gap before public resumable backup coordination. Existing logical limits maxEntries/maxBytes must remain compatible. Add optional persisted maxStorageBytes to CatalogLimits, validated and defaulted compatibly on old headers. Set and verify page_size/max_page_count for creation and every open BEFORE writes; bound physical DB and rollback admission on reopen. Declare exported helper catalogStorageBudget(limits): {databaseBytes:number, rollbackBytes:number, totalBytes:number}; the coordinator will charge that conservative budget. Use a safe default based on logical bytes and entries plus row/encryption/index overhead; cap explicit limits to a documented upper bound and allow tiny explicit test caps to exercise real SQLITE_FULL. Old logical header records with only maxEntries/maxBytes must still open. Don't pretend this per-component bound enforces aggregate quota or disk free space. Account for rollback journal record overhead, not just DB bytes. Avoid unrestricted SQLite temp files; inspect query plans/order to avoid memory sort surprises. Existing graph validation uses transaction snapshots and bounded iteration.

Fix unrestricted header payload SELECT to bound it before JS allocation. Preserve transaction original errors if SQLite auto-rolled back on SQLITE_FULL and return a typed 413 for capacity. No partial inserts or changed seal after failure. Retain exact identity/order and all business checks. Tests should actually hit SQLite page limits, reopen and validate previous entries, reject oversized physical files, check legacy header compatibility and page limit reapplication. Avoid tests that only assert the helper formula.

Be especially alert that max_page_count is a connection setting and a schema/header migration must not weaken existing admission. There are concurrent independent writers tests already. The coordinator is not built yet. Do not propose changing customer archive format or deleting damaged catalogs. Output concise code plus important residuals, no vague checklist.


### server/private-backup-catalog.ts
```typescript
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
import { isPrivateBackupPath, validatePrivateBusinessFile, validatePrivateLogicalRecord, validatePrivateWorkspaceIdentity } from './private-workspace-backup.ts';
import { validateSourceBillGraph, type BillLookup, type BillLookupStore } from './source-bill-graph.ts';
import { validateExecutionGraph } from './execution-history-backup.ts';
import { validateBackupMailGraph } from './private-backup-mail-validation.ts';
import { validateSavedBillReviewDraft, validateBillReviewDraftProposalLink } from './bill-review-drafts.ts';

export interface CatalogFile { path: string; encoding: 'bytes' | 'json'; data: Buffer }
export interface CatalogRecord { id: string; kind: string; revision: number; value: unknown }
export interface CatalogLimits { maxEntries: number; maxBytes: number }
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
    let db: DatabaseSync | undefined, catalog: PrivateBackupCatalog | undefined;
    try {
      db = new DatabaseSync(join(directory, FILE_NAME));
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048; PRAGMA busy_timeout=1500;');
      db.exec(`${TABLES.catalog_header}; ${TABLES.catalog_entries}; ${INDEX}; PRAGMA user_version=1;`);
      catalog = new PrivateBackupCatalog(directory, options.key, db, { catalogId: randomUUID(), workspaceId: options.workspaceId });
      const header: Header = { version: 1, catalogId: catalog.catalogId, workspaceId: catalog.workspaceId,
        entries: 0, files: 0, records: 0, plainBytes: 0, digest: EMPTY_DIGEST, sealed: false,
        limits: { maxEntries: options.maxEntries, maxBytes: options.maxBytes } };
      db.prepare('INSERT INTO catalog_header VALUES (1,?)').run(JSON.stringify(encryptJson(catalog.key, header)));
      await fsyncDir(directory);
      await fsyncDir(dirname(directory));
      return catalog;
    } catch (error) { if (catalog) catalog.close(); else db?.close(); throw error; }
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
      await windowsFilePrivacy(path, 'file');
    }
    let db: DatabaseSync | undefined, catalog: PrivateBackupCatalog | undefined;
    try {
      db = new DatabaseSync(join(directory, FILE_NAME));
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048; PRAGMA busy_timeout=1500;');
      const version = db.prepare('PRAGMA user_version').get();
      const schema = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 5").all();
      if (version?.user_version !== 1 || schema.length !== 3 || schema.some(row =>
        row.name === 'catalog_entries_kind' ? row.type !== 'index' || row.sql !== INDEX :
          row.type !== 'table' || !(String(row.name) in TABLES) || row.sql !== TABLES[row.name as keyof typeof TABLES])) invalid();
      catalog = new PrivateBackupCatalog(directory, options.key, db, options);
      catalog.header();
      return catalog;
    } catch (error) { if (catalog) catalog.close(); else db?.close(); throw error; }
  }

  private ready(): void { if (this.closed) invalid('The private backup catalog is closed.', 409); }
  private index(category: string, identity: string): string {
    return createHmac('sha256', this.key).update(JSON.stringify([this.catalogId, category, identity])).digest('hex');
  }
  private header(): Header {
    this.ready();
    try {
      const row = this.db.prepare('SELECT payload FROM catalog_header WHERE id=1').get();
      const header = decryptJson(this.key, JSON.parse(String(row?.payload))) as Header;
      if (!object(header) || Object.keys(header).length !== 10 || header.version !== 1 || header.catalogId !== this.catalogId || header.workspaceId !== this.workspaceId ||
          ![header.entries, header.files, header.records, header.plainBytes].every(value => integer(value)) || header.entries !== header.files + header.records || !hex(header.digest) || typeof header.sealed !== 'boolean' || !object(header.limits)) invalid();
      checkLimits(header.limits);
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
      this.db.exec('ROLLBACK');
      if ((error as { code?: string }).code?.startsWith('ERR_SQLITE')) invalid('The catalog contains a duplicate identity or could not save this entry.');
      throw error;
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
    const statement = kind === undefined
      ? this.db.prepare('SELECT * FROM catalog_entries WHERE category=? ORDER BY sequence')
      : this.db.prepare('SELECT * FROM catalog_entries WHERE category=? AND kind=? ORDER BY sequence');
    for (const row of (kind === undefined ? statement.iterate(category) : statement.iterate(category, this.index('kind', kind)))) yield row as unknown as StoredEntry;
  }
  private find(category: 'file' | 'record', identity: string): StoredEntry | undefined {
    this.ready();
    return this.db.prepare('SELECT * FROM catalog_entries WHERE category=? AND lookup=?').get(category, this.index(category, category === 'file' ? identity.toLowerCase() : identity)) as unknown as StoredEntry | undefined;
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
    // Legacy graph discovery needs names only, so large encrypted file bodies
    // never enter the JavaScript heap merely to enumerate the archived view.
    for (const row of this.db.prepare("SELECT sequence,entry_id,category,lookup,kind,metadata FROM catalog_entries WHERE category='file' ORDER BY sequence").iterate()) {
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
      let count = 0, files = 0, records = 0, plainBytes = 0, chain = EMPTY_DIGEST;
      for (const row of this.db.prepare('SELECT * FROM catalog_entries ORDER BY sequence').iterate()) {
        const stored = row as unknown as StoredEntry, meta = this.metadata(stored), data = this.body(stored, meta);
        if (meta.sequence !== ++count) invalid();
        plainBytes += data.length; chain = digest(JSON.stringify([chain, meta]));
        if (meta.category === 'file') { files++; this.validateFile({ path: meta.identity, encoding: meta.encoding, data }); }
        else {
          records++;
          const value = jsonBytes(data);
          validatePrivateLogicalRecord({ id: meta.identity, kind: meta.kind, revision: meta.revision, value });
          if (meta.kind === 'bill-review-draft') {
            const draft = validateSavedBillReviewDraft(meta.identity, meta.revision, value, this.workspaceId);
            const request = draft.proposalRequest;
            validateBillReviewDraftProposalLink(draft, request ? this.getRecord('bill-proposal', `bill-proposal:${request.requestId}`) : undefined);
          }
        }
      }
      if (count !== header.entries || files !== header.files || records !== header.records || plainBytes !== header.plainBytes || chain !== header.digest) invalid();
      if (!this.getFile(WORKSPACE) || !this.getFile('desk.json')) invalid('The backup must include its workspace identity and Desk book.');
      const reader = { get: (kind: string, id: string) => this.getRecord(kind, id), iterate: (kind: string) => this.iterateRecords(kind) };
      validateBackupMailGraph(reader, { get: path => this.getFile(path), paths: () => this.filePaths() }, this.workspaceId);
      this.db.exec('CREATE TABLE catalog_bill_lookups (id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
      try { validateSourceBillGraph(reader, this.billLookups()); }
      finally { this.db.exec('DROP TABLE catalog_bill_lookups'); }
      const history: Record<string, string> = {};
      for (const path of ['job-runs.json', 'loops.json']) {
        const file = this.getFile(path);
        if (file) history[path] = file.data.toString('utf8');
      }
      validateExecutionGraph(reader, history);
      if (seal && !header.sealed) {
        header.sealed = true;
        this.db.prepare('UPDATE catalog_header SET payload=? WHERE id=1').run(JSON.stringify(encryptJson(this.key, header)));
      }
      this.db.exec('COMMIT');
      return { catalogId: this.catalogId, workspaceId: this.workspaceId, entries: count, files, records, plainBytes, digest: chain, sealed: header.sealed };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private billLookups(): BillLookupStore {
    // Every derived lookup must correspond to a retained physical record.
    // A hostile head cannot expand scratch beyond the admitted catalog count.
    const maximum = this.countRecords();
    let count = 0;
    return {
      get: id => {
        const row = this.db.prepare('SELECT payload FROM catalog_bill_lookups WHERE id=?').get(this.index('bill-lookup', id));
        if (!row) return undefined;
        const saved = decryptJson(this.key, JSON.parse(String(row.payload))) as { id: string; lookup: BillLookup };
        if (saved.id !== id) invalid();
        return saved.lookup;
      },
      set: (id, lookup) => {
        const identity = this.index('bill-lookup', id);
        const exists = this.db.prepare('SELECT 1 FROM catalog_bill_lookups WHERE id=?').get(identity);
        if (!exists && count >= maximum) invalid('The derived bill graph exceeds its retained catalog identities.');
        this.db.prepare('INSERT INTO catalog_bill_lookups VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload')
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

```

### server/private-backup-catalog.test.ts
```typescript
import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, link, chmod } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { PrivateBackupCatalog, type CatalogRecord, type CatalogFile } from './private-backup-catalog.ts';
import { emptyV3 } from '../shared/desk-v3.ts';
import { encryptJson, decryptJson } from './desk-crypto.ts';
import { WorkflowDatabase } from './workflow-database.ts';
import { SourceBillRegister, previewBillSource } from './source-bills.ts';
import { validateSourceBillRecords } from './source-bill-graph.ts';
import { JobRunStore } from './job-runs.ts';
import { validateExecutionRecords } from './execution-history-backup.ts';
import { BillReviewDraftStore } from './bill-review-drafts.ts';
import { BankReferenceStore } from './bank-reference-store.ts';
import { proposalBackupFixture } from './testing/proposal-backup-fixture.ts';
import { legacyMailBackupFixture } from './testing/mail-backup-fixture.ts';
import { createPrivateVault } from './private-vault.ts';
import { MailStorage } from './mail-storage.ts';
import type { BillMailSource } from '../shared/source-bills.ts';
import type { BillReviewDraftValue } from '../shared/bill-review-drafts.ts';
import type { Recipe } from '../shared/contracts.ts';

const roots: string[] = [], catalogs: PrivateBackupCatalog[] = [];
afterEach(async () => {
  for (const catalog of catalogs.splice(0)) catalog.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(options: { workspaceId?: string; maxEntries?: number; maxBytes?: number; base?: boolean } = {}) {
  const root = await mkdtemp(join(realpathSync(tmpdir()), 'RealBud encrypted catalog ')); roots.push(root);
  const key = randomBytes(32), workspaceId = options.workspaceId ?? randomUUID();
  const catalog = await PrivateBackupCatalog.create({ directory: join(root, 'catalog'), key, workspaceId,
    maxEntries: options.maxEntries ?? 20_000, maxBytes: options.maxBytes ?? 512 * 1024 * 1024 }); catalogs.push(catalog);
  if (options.base !== false) {
    catalog.addFile({ path: 'company-installation/workspace.json', encoding: 'bytes', data: Buffer.from(JSON.stringify({ version: 1, id: workspaceId, workerMemberKey: null })) });
    catalog.addFile({ path: 'desk.json', encoding: 'json', data: Buffer.from(JSON.stringify(emptyV3({ name: 'Fictional catalog office', timezone: 'UTC', jurisdictions: [] }))) });
  }
  return { root, key, workspaceId, catalog, reopen: async () => {
    catalog.close();
    const reopened = await PrivateBackupCatalog.open({ directory: catalog.directory, key, catalogId: catalog.catalogId, workspaceId }); catalogs.push(reopened); return reopened;
  } };
}
const handoff = (id = 'handoff:retained', revision = 7, detail = 'Fictional retained private evidence'): CatalogRecord => ({ id, kind: 'handoff', revision,
  value: { version: 1, runId: 'run', threadId: 'thread', botId: 'bot', detail, jobRevision: 1, reason: 'login', state: 'closed' } });
function* savedRecords(directory: string, key: Buffer): Iterable<CatalogRecord> {
  const db = new DatabaseSync(join(directory, 'workflow-state.sqlite'), { readOnly: true });
  try { for (const row of db.prepare('SELECT id,kind,revision,payload FROM workflow_records ORDER BY rowid').iterate()) {
    yield { id: String(row.id), kind: String(row.kind), revision: Number(row.revision), value: decryptJson(key, JSON.parse(String(row.payload))) };
  } } finally { db.close(); }
}
async function loadRecords(f: Awaited<ReturnType<typeof fixture>>, populate: (db: WorkflowDatabase, directory: string, key: Buffer) => unknown | Promise<unknown>) {
  const directory = join(f.root, 'source'), sourceKey = randomBytes(32), db = new WorkflowDatabase({ dir: directory, key: sourceKey });
  try { await populate(db, directory, sourceKey); } finally { db.close(); }
  return { directory, sourceKey, records: [...savedRecords(directory, sourceKey)] };
}
function draftInput(workspaceId: string): BillReviewDraftValue {
  return { workspaceId, state: 'editing', billId: null, billRevision: null, itemId: null, messageId: null, sourceDigest: null,
    fields: { propertyId: '', kind: 'Water', vendor: '', amount: '1.', invoiceDate: '2026-0', dueDate: '', note: 'Fictional unfinished review 保留' },
    billState: 'hold', reason: '', seriesId: '', arrivalDate: '', proposalRequest: null };
}
const billSource = (n: number): BillMailSource => ({ accountId: 'catalog-mail', receiptId: `receipt-${n}`, threadId: `thread-${n}`,
  message: { id: `message-${n}`, at: Date.parse('2026-09-01T00:00:00Z'), from: 'fictional@example.invalid', subject: 'Fictional bill', body: `Retained source ${n}`, attachments: [] } });
const billReview = (source: BillMailSource) => ({ expectedSourceDigest: previewBillSource(source).digest, sourceReviewed: true,
  facts: { propertyId: 'fictional-property', kind: 'Water', vendor: 'Fictional Water', amountCents: 123, currency: 'AUD', invoiceDate: '2026-09-01', dueDate: '2026-09-21', note: 'Checked' }, reviewReason: 'Fictional human review' });
async function billFixture(f: Awaited<ReturnType<typeof fixture>>) {
  return loadRecords(f, (db, directory) => {
    const store = new SourceBillRegister(db, { dataDir: directory }), source = billSource(1);
    const bill = store.accept(billReview(source), source, f.workspaceId);
    const series = store.approveSeries({ occurrenceId: bill.id, expectedOccurrenceRevision: bill.revision, intervalMonths: 1,
      anchorDate: '2026-09-01', windowBeforeDays: 0, windowAfterDays: 0, timeZone: 'UTC', reviewReason: 'Fictional observed pattern' }, f.workspaceId);
    store.reviseSeries(series.id, { intervalMonths: series.intervalMonths, anchorDate: series.anchorDate, windowBeforeDays: series.windowBeforeDays, windowAfterDays: series.windowAfterDays, timeZone: series.timeZone, expectedRevision: series.revision, active: false, reviewReason: 'Pattern paused; retain reservation history' }, f.workspaceId);
    const corrected = billSource(2);
    store.correct(bill.id, { ...billReview(corrected), expectedRevision: bill.revision, state: 'hold', reviewReason: 'Fictional source corrected' }, corrected, f.workspaceId);
  });
}
async function mailFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const legacy = legacyMailBackupFixture(f.workspaceId, Date.parse('2026-09-21T00:00:00Z'));
  const saved = [['mail-workspace', legacy.state], [`mail-scan-${legacy.receipt.id}`, legacy.source], ['mail-prepared-input', legacy.prepared]] as const;
  const source = await loadRecords(f, async (db, directory, key) => {
    const vault = createPrivateVault(directory, key);
    for (const [name, value] of saved) await vault.write(name, value);
    await mkdir(join(directory, 'vault/workflow-inputs'), { recursive: true, mode: 0o700 });
    await writeFile(join(directory, 'vault/workflow-inputs/accounts-inbox.json'), JSON.stringify(legacy.input), { mode: 0o600 });
    const storage = new MailStorage({ directory, key, workspaceId: f.workspaceId, workroomDirectory: join(directory, 'vault'), database: db });
    await storage.ready();
  });
  const files: CatalogFile[] = saved.map(([name, value]) => ({ path: `company-installation/private/${name}.json`, encoding: 'json', data: Buffer.from(JSON.stringify({ name, value })) }));
  files.push({ path: 'vault/workflow-inputs/accounts-inbox.json', encoding: 'bytes', data: Buffer.from(JSON.stringify(legacy.input)) });
  return { ...source, files, legacy };
}

describe('target-key encrypted private backup catalog', () => {
  it('preserves exact ordinary bytes, logical ordering, revision and insertion order across restart and a different key', async () => {
    const f = await fixture(), original = Buffer.from('\uFEFFDate,Description,Reference\r\n2026-09-21,"保留, exact",0012\r\n');
    f.catalog.addFile({ path: 'vault/workflow-inputs/original.csv', encoding: 'bytes', data: original });
    const first = handoff('handoff:first', 17), second = handoff('handoff:second', 2);
    f.catalog.addRecord(first); f.catalog.addRecord(second);
    const before = f.catalog.validate();
    const other = await fixture({ workspaceId: f.workspaceId, base: false });
    for (const file of f.catalog.iterateFiles()) other.catalog.addFile(file);
    for (const record of f.catalog.iterateRecords()) other.catalog.addRecord(record);
    expect(other.catalog.validate()).toMatchObject({ files: before.files, records: before.records, plainBytes: before.plainBytes });
    const restarted = await other.reopen();
    expect(restarted.getFile('vault/workflow-inputs/original.csv')!.data).toEqual(original);
    expect([...restarted.iterateRecords()]).toEqual([first, second]);
    expect(restarted.getRecord('bank', first.id)).toBeUndefined();
    expect(restarted.countRecords('handoff')).toBe(2);
    const bytes = await readFile(join(restarted.directory, 'catalog.sqlite'));
    expect(bytes.includes(Buffer.from('Fictional retained private evidence'))).toBe(false);
    expect(bytes.includes(Buffer.from(first.id))).toBe(false);
    expect(bytes.includes(f.key)).toBe(false); expect(bytes.includes(other.key)).toBe(false);
  });
  it('does not trust a collection missing required identity or Desk records', async () => {
    const f = await fixture({ base: false });
    expect(() => f.catalog.validate()).toThrow(/identity and Desk/);
  });
  it.each(['../config.json', '/tmp/payload', 'C:\\payload', 'vault/workflow-inputs/CON.json', 'workflow-state.sqlite', 'config.json'])('rejects unapproved file identity %s', async path => {
    const f = await fixture();
    expect(() => f.catalog.addFile({ path, encoding: 'bytes', data: Buffer.from('{}') })).toThrow();
    expect(f.catalog.validate().files).toBe(2);
  });
  it('rejects duplicate/case-folded file paths and global workflow identities atomically', async () => {
    const f = await fixture();
    f.catalog.addFile({ path: 'vault/properties/Fictional.md', encoding: 'bytes', data: Buffer.from('Original') });
    const before = f.catalog.summary();
    expect(() => f.catalog.addFile({ path: 'vault/properties/fictional.md', encoding: 'bytes', data: Buffer.from('Changed') })).toThrow(/duplicate/);
    expect(f.catalog.summary()).toEqual(before);
    f.catalog.addRecord(handoff('source-bills'));
    expect(() => f.catalog.addRecord({ id: 'source-bills', kind: 'bill-register', revision: 1, value: { version: 1, occurrences: [], series: [] } })).toThrow(/duplicate/);
    expect(f.catalog.countRecords()).toBe(1);
  });
  it('enforces encoding, workspace and declared capacity without partial admission', async () => {
    const f = await fixture({ maxEntries: 3 });
    expect(() => f.catalog.addFile({ path: 'desk.json', encoding: 'bytes', data: Buffer.from('{}') })).toThrow();
    expect(() => f.catalog.addFile({ path: 'agency-setup.json', encoding: 'json', data: Buffer.from('{}') })).toThrow();
    expect(() => f.catalog.addFile({ path: 'company-installation/workspace.json', encoding: 'bytes', data: Buffer.from(JSON.stringify({ version: 1, id: randomUUID(), workerMemberKey: null })) })).toThrow();
    f.catalog.addRecord(handoff());
    expect(() => f.catalog.addRecord(handoff('handoff:later'))).toThrow(/capacity/);
    expect(f.catalog.validate().entries).toBe(3);
    const small = await fixture({ base: false, maxBytes: 12 });
    expect(() => small.catalog.addRecord(handoff())).toThrow(/capacity/);
    expect(small.catalog.summary().entries).toBe(0);
  });
  it('refuses unknown kinds, invalid revisions and closed oversized drafts before insertion', async () => {
    const f = await fixture();
    expect(() => f.catalog.addRecord({ ...handoff(), kind: 'unknown' })).toThrow();
    expect(() => f.catalog.addRecord({ ...handoff(), revision: 0 })).toThrow();
    const source = await loadRecords(f, db => new BillReviewDraftStore(db, { workspaceId: f.workspaceId }).create(randomUUID(), null, { ...draftInput(f.workspaceId), state: 'discarded' }));
    const row = source.records[0], value = structuredClone(row.value) as any;
    // Legal individual string lengths can still exceed the encrypted 64 KiB
    // envelope through JSON's surrogate escaping and base64 expansion.
    value.fields.note = '\ud800'.repeat(8000); value.reason = 'x'.repeat(1000);
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(65_536);
    expect(Buffer.byteLength(JSON.stringify(encryptJson(f.key, value)))).toBeGreaterThan(65_536);
    expect(() => f.catalog.addRecord({ ...row, value })).toThrow();
    expect(f.catalog.countRecords()).toBe(0);
  });
  it('retains exact bank original and reviewed artifact bytes', async () => {
    const f = await fixture(), original = Buffer.from('\uFEFFDate,Amount,Description,Reference\r\n2026-09-21,10.00,"Fictional rent, 保留",0012\r\n');
    const source = await loadRecords(f, db => {
      const bank = new BankReferenceStore(db), saved = bank.create({ source: { filename: 'original.csv', bytesBase64: original.toString('base64') }, columns: { date: 'Date', amount: 'Amount', narrative: 'Description', reference: 'Reference' }, dateFormat: 'YYYY-MM-DD', rules: [] });
      bank.review(saved.id, saved.revision, [{ rowId: saved.value.batch.rows[0].id, action: 'keep', reason: 'Human checked exact reference' }]);
    });
    for (const row of source.records) f.catalog.addRecord(row);
    f.catalog.validate();
    expect([...f.catalog.iterateRecords('bank')]).toEqual(source.records);
    expect(Buffer.from(JSON.stringify(source.records)).includes(Buffer.from(original.toString('base64')))).toBe(true);
  });
  it('requires the owned identity and unchanged installation key on reopen', async () => {
    const f = await fixture(); f.catalog.close();
    for (const change of [{ key: randomBytes(32) }, { catalogId: randomUUID() }, { workspaceId: randomUUID() }]) {
      await expect(PrivateBackupCatalog.open({ directory: f.catalog.directory, key: f.key, catalogId: f.catalog.catalogId, workspaceId: f.workspaceId, ...change })).rejects.toThrow();
    }
    expect((await f.reopen()).validate().files).toBe(2);
  });
  it('seals atomically and refuses mutations from a stale independent worker and reopened handle', async () => {
    const f = await fixture(), barrier = new SharedArrayBuffer(4), state = new Int32Array(barrier);
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { PrivateBackupCatalog } = await import(workerData.module);
        const catalog = await PrivateBackupCatalog.open({ ...workerData.options, key: Buffer.from(workerData.key) });
        parentPort.postMessage({ ready: true });
        Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
        try { catalog.addRecord(workerData.record); parentPort.postMessage({ status: 200 }); }
        catch (error) { parentPort.postMessage({ status: error.status, sealed: catalog.summary().sealed }); }
        finally { catalog.close(); }
      })().catch(error => { parentPort.postMessage({ failure: error.message }); process.exitCode = 1; });
    `, { eval: true, workerData: {
      module: new URL('./private-backup-catalog.ts', import.meta.url).href, key: f.key, barrier, record: handoff(),
      options: { directory: f.catalog.directory, catalogId: f.catalog.catalogId, workspaceId: f.workspaceId },
    } });
    try {
      await new Promise<void>((resolve, reject) => {
        worker.once('message', message => message.ready ? resolve() : reject(new Error(message.failure ?? 'Worker failed before admission')));
        worker.once('error', reject);
      });
      const sealed = f.catalog.seal(); expect(sealed.sealed).toBe(true);
      const answered = new Promise<any>((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
      Atomics.store(state, 0, 1); Atomics.notify(state, 0);
      expect(await answered).toEqual({ status: 409, sealed: true });
      expect(f.catalog.seal()).toEqual(sealed);
      const restarted = await f.reopen();
      expect(restarted.validate()).toEqual(sealed);
      expect(() => restarted.addRecord(handoff())).toThrow(/sealed/);
      expect(() => restarted.addFile({ path: 'vault/properties/later.md', encoding: 'bytes', data: Buffer.from('Later') })).toThrow(/sealed/);
    } finally { await worker.terminate(); }
  });
  it('does not publish a seal for an incomplete graph and rejects invalid UTF-8 JSON', async () => {
    const f = await fixture({ base: false });
    expect(() => f.catalog.seal()).toThrow(); expect(f.catalog.summary().sealed).toBe(false);
    const malformed = Buffer.concat([Buffer.from('{"note":"'), Buffer.from([0xff]), Buffer.from('"}')]);
    expect(() => f.catalog.addFile({ path: 'vault/workflow-inputs/bad.json', encoding: 'bytes', data: malformed })).toThrow(/malformed/);
    f.catalog.addFile({ path: 'vault/workflow-inputs/arbitrary.csv', encoding: 'bytes', data: malformed });
    expect(f.catalog.getFile('vault/workflow-inputs/arbitrary.csv')!.data).toEqual(malformed);
  });
  it('refuses preexisting directories, links and unrecognized internal schema', async () => {
    const f = await fixture();
    await expect(PrivateBackupCatalog.create({ directory: f.catalog.directory, key: f.key, workspaceId: f.workspaceId, maxEntries: 10, maxBytes: 1000 })).rejects.toThrow();
    const linked = join(f.root, 'linked'); await symlink(f.catalog.directory, linked);
    await expect(PrivateBackupCatalog.open({ directory: linked, key: f.key, catalogId: f.catalog.catalogId, workspaceId: f.workspaceId })).rejects.toThrow(/linked/);
    f.catalog.close();
    const db = new DatabaseSync(join(f.catalog.directory, 'catalog.sqlite'));
    db.exec('CREATE TABLE unexpected (data TEXT)'); db.close();
    await expect(f.reopen()).rejects.toThrow(/recovery/);
  });
  it('refuses hardlinked or broadened catalog permissions without repairing them', async () => {
    const f = await fixture(); f.catalog.close();
    const path = join(f.catalog.directory, 'catalog.sqlite'), alias = join(f.root, 'hardlink'); await link(path, alias);
    await expect(f.reopen()).rejects.toThrow(); await rm(alias);
    if (process.platform !== 'win32') {
      await chmod(path, 0o644); await expect(f.reopen()).rejects.toThrow();
      await chmod(path, 0o600);
    }
    expect((await f.reopen()).validate().files).toBe(2);
  });
  it.each(['delete', 'payload-swap', 'metadata-swap'])('detects authenticated entry corruption: %s', async attack => {
    const f = await fixture(); f.catalog.addRecord(handoff('handoff:a')); f.catalog.addRecord(handoff('handoff:b', 2, 'Other original')); f.catalog.close();
    const db = new DatabaseSync(join(f.catalog.directory, 'catalog.sqlite'));
    if (attack === 'delete') db.exec('DELETE FROM catalog_entries WHERE sequence=4');
    else { const column = attack === 'payload-swap' ? 'payload' : 'metadata'; db.exec(`UPDATE catalog_entries SET ${column}=(SELECT ${column} FROM catalog_entries WHERE sequence=3) WHERE sequence=4`); }
    db.close();
    const reopened = await f.reopen(); expect(() => reopened.validate()).toThrow(/recovery/);
  });
});

describe('complete bounded business graph validation', () => {
  it('retains historical bill aliases, inactive patterns and reservations, using the same v1 invariant', async () => {
    const f = await fixture(), source = await billFixture(f);
    expect(() => validateSourceBillRecords(source.records)).not.toThrow();
    for (const row of source.records) f.catalog.addRecord(row);
    expect(f.catalog.validate().records).toBe(source.records.length);
    expect([...f.catalog.iterateRecords()]).toEqual(source.records);
  });
  it.each(['bill-source-alias', 'bill-pattern-slot', 'bill-arrival-slot', 'bill-origin', 'bill-occurrence', 'bill-register'])('rejects an individually readable bill graph missing %s', async kind => {
    const f = await fixture(), source = await billFixture(f);
    const omitted = source.records.find(row => row.kind === kind); expect(omitted).toBeDefined();
    for (const row of source.records) if (row !== omitted) f.catalog.addRecord(row);
    expect(() => f.catalog.validate()).toThrow(/recovery/);
  });
  it('validates normalized and inert legacy mail with exact origin-era ordering and prepared input', async () => {
    const f = await fixture(), source = await mailFixture(f);
    for (const file of source.files) f.catalog.addFile(file);
    for (const row of source.records) f.catalog.addRecord(row);
    expect(f.catalog.validate().records).toBe(source.records.length);
    const restored = await fixture({ workspaceId: f.workspaceId, base: false });
    for (const file of f.catalog.iterateFiles()) restored.catalog.addFile(file);
    for (const row of f.catalog.iterateRecords()) restored.catalog.addRecord(row);
    expect(restored.catalog.validate().records).toBe(source.records.length);
    expect(restored.catalog.getFile(`company-installation/private/mail-scan-${source.legacy.receipt.id}.json`)!.data).toEqual(source.files[1].data);
  });
  it.each(['all-legacy', 'mail-source', 'mail-receipt', 'mail-item', 'ordered-origin'])('holds missing/conflicting mail evidence: %s', async attack => {
    const f = await fixture(), source = await mailFixture(f);
    for (const file of source.files) {
      if (attack === 'all-legacy' && file.path.startsWith('company-installation/private/')) continue;
      if (attack === 'ordered-origin' && file.path.endsWith('mail-workspace.json')) {
        const value = JSON.parse(file.data.toString('utf8'));
        value.value = Object.fromEntries(Object.entries(value.value).reverse());
        f.catalog.addFile({ ...file, data: Buffer.from(JSON.stringify(value)) });
      } else f.catalog.addFile(file);
    }
    for (const row of source.records) if (row.kind !== attack) f.catalog.addRecord(row);
    expect(() => f.catalog.validate()).toThrow(/mail evidence.*recovery/i);
  });
  it('accepts an unrelated workroom input without inventing mail state', async () => {
    const f = await fixture();
    f.catalog.addFile({ path: 'vault/workflow-inputs/accounts-inbox.json', encoding: 'bytes', data: Buffer.from('{"manual":"fixture"}') });
    expect(f.catalog.validate().records).toBe(0);
  });
  it('preserves every draft state and checks optional-present proposal links before preview', async () => {
    const f = await fixture();
    const source = await loadRecords(f, async (db, directory) => {
      const proposal = await proposalBackupFixture(db, directory), store = new BillReviewDraftStore(db, { workspaceId: f.workspaceId, now: () => 100 });
      for (const state of ['editing', 'saved', 'accepted', 'discarded'] as const) {
        store.create(randomUUID(), null, { ...draftInput(f.workspaceId), state });
      }
      store.create(randomUUID(), null, { ...draftInput(f.workspaceId), itemId: proposal.request.itemId, messageId: proposal.request.messageId,
        sourceDigest: proposal.request.expectedSourceDigest, proposalRequest: proposal.request });
      store.create(randomUUID(), null, { ...draftInput(f.workspaceId), itemId: 'a'.repeat(64), messageId: 'ab12', sourceDigest: 'b'.repeat(64),
        proposalRequest: { requestId: randomUUID(), itemId: 'a'.repeat(64), messageId: 'ab12', expectedSourceDigest: 'b'.repeat(64) } });
    });
    for (const row of source.records) f.catalog.addRecord(row);
    expect(f.catalog.validate().records).toBe(source.records.length);
    expect([...f.catalog.iterateRecords('bill-review-draft')].map(row => (row.value as any).fields.amount)).toEqual(Array(6).fill('1.'));
    const bad = await fixture({ workspaceId: f.workspaceId });
    for (const row of source.records) {
      const value = structuredClone(row.value) as any;
      if (row.kind === 'bill-review-draft' && value.proposalRequest?.requestId === (source.records.find(r => r.kind === 'bill-proposal')!.id.slice(14))) {
        value.sourceDigest = 'c'.repeat(64); value.proposalRequest.expectedSourceDigest = value.sourceDigest;
      }
      bad.catalog.addRecord({ ...row, value });
    }
    expect(() => bad.catalog.validate()).toThrow(/recovery/);
  });
  it('retains permanent execution/request/checkpoint bindings and rejects missing retry receipts', async () => {
    const f = await fixture();
    const source = await loadRecords(f, (db, directory) => {
      const store = new JobRunStore({ file: join(directory, 'job-runs.json'), database: db });
      const recipe: Recipe = { id: 'fictional', revision: 1, createdAt: 1, updatedAt: 1, title: 'Fictional plan', description: 'Review', steps: ['Review'], evidence: 'Evidence', allowedOrigins: [], capabilities: ['analyse'], limits: { maxRuntimeMinutes: 2, maxTurns: 3 }, status: 'shadow', schedule: null, planApprovedAt: null, approvedRevision: null, attachment: null, submitAcknowledgedAt: null };
      const saved = store.enqueue(recipe, { mode: 'shadow', trigger: 'manual', idempotencyKey: 'retained-request' });
      store.start(saved.run.id); store.settle(saved.run.id, { status: 'completed', detail: 'Fictional completed work' }); store.close();
    });
    const file: CatalogFile = { path: 'job-runs.json', encoding: 'bytes', data: await readFile(join(source.directory, 'job-runs.json')) };
    expect(() => validateExecutionRecords(source.records, { 'job-runs.json': file.data.toString('utf8') })).not.toThrow();
    f.catalog.addFile(file); for (const row of source.records) f.catalog.addRecord(row);
    expect(f.catalog.validate().records).toBe(source.records.length);
    const bad = await fixture({ workspaceId: f.workspaceId }); bad.catalog.addFile(file);
    for (const row of source.records) if (row.kind !== 'execution-request') bad.catalog.addRecord(row);
    expect(() => bad.catalog.validate()).toThrow(/Execution history needs recovery/);
  });
  it('retains more than 5,000 records and 96 MiB without full-history record reads', async () => {
    const f = await fixture(), detail = `Fictional multilingual retained evidence ${'保留完整紀錄'.repeat(1100)}`;
    for (let i = 0; i < 5_101; i++) f.catalog.addRecord(handoff(`handoff:retained-${i}`, i + 1, detail));
    const summary = f.catalog.validate();
    expect(summary.records).toBe(5_101); expect(summary.plainBytes).toBeGreaterThan(96 * 1024 * 1024);
    expect(f.catalog.getRecord('handoff', 'handoff:retained-0')?.revision).toBe(1);
    expect(f.catalog.getRecord('handoff', 'handoff:retained-5100')?.revision).toBe(5_101);
    const restarted = await f.reopen();
    expect(restarted.validate()).toEqual(summary);
    let count = 0; for (const row of restarted.iterateRecords('handoff')) { expect(row.revision).toBe(++count); }
    expect(count).toBe(5_101);
  }, 60_000);
  it('admits more than the v1 3,000-file ceiling and enumerates names without dropping any file', async () => {
    const f = await fixture(), data = Buffer.from('Fictional retained property note 保留');
    for (let i = 0; i < 3_101; i++) f.catalog.addFile({ path: `vault/properties/retained-${i}.md`, encoding: 'bytes', data });
    expect(f.catalog.seal()).toMatchObject({ files: 3_103, records: 0, sealed: true });
    let count = 0; for (const _path of f.catalog.filePaths()) count++;
    expect(count).toBe(3_103);
    expect(f.catalog.getFile('vault/properties/retained-3100.md')!.data).toEqual(data);
  });
});

```

### server/private-backup-prepared.ts
```typescript
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

```
