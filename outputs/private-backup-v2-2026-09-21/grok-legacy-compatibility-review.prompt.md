Review this bounded v1-to-catalog compatibility change. No tools, no code edits, no external actions. Return only JSON {verdict: string, findings: [{severity: string,file: string,issue: string,fix: string}], limitations: string[]}. Report concrete correctness/security/data preservation errors, not speculative style comments. Full v1 authentication and business graph validation remains authoritative before any visitor callback. Catalog create validates private path, supplied 32 byte destination key, logical limits, fixed physical page cap; seal validates full graph. File buffers are encrypted synchronously by addFile before visitor returns; buffers can be cleared. Records validated/encrypted synchronously. Header IDs are generated internally. This source reader is not yet HTTP-wired and v1 retains bounded whole-JSON memory use; do not call it a streaming v2 parser. The adapter receipt intentionally replaces the legacy canonical-JSON digest with SHA256 of exact uploaded raw bytes. Existing source key must not leave the private legacy visitor seam. Review input limits, complete-graph-before-create, source/destination key scope, cancellation/drain, error cleanup and tests. No source scan is necessary or available.
Relevant existing + added v1 seam:
function validateSnapshot(value: unknown): Snapshot {
  const s = exact(value, ['version', 'createdAt', 'workspaceId', 'keyHex', 'files', 'databasePresent', 'records']);
  if (s.version !== 1 || !uuid(s.workspaceId) || !hex(s.keyHex) || typeof s.createdAt !== 'string' || !Number.isFinite(Date.parse(s.createdAt)) || !Array.isArray(s.files) || s.files.length > MAX_FILES || !Array.isArray(s.records) || s.records.length > PRIVATE_BACKUP_MAX_RECORDS || typeof s.databasePresent !== 'boolean' || !s.databasePresent && s.records.length) return fail('The private backup manifest is invalid.', 400);
  const files = s.files.map(f => decodeFile(f)), key = Buffer.from(s.keyHex, 'hex');
  try {
    const records = s.records.map(r => validateRecord(r, key));
    if (new Set(files.map(f => f.path.toLowerCase())).size !== files.length || new Set(records.map(r => r.id)).size !== records.length || files.reduce((sum, f) => sum + f.bytes, 0) > MAX_PLAIN) fail('The backup contains duplicate paths or excessive data.', 400);
    const identity = files.find(f => f.path === WORKSPACE), desk = files.find(f => f.path === 'desk.json');
    if (!identity || !desk) fail('The backup must contain its private workspace identity and Desk book.', 400);
    validatePrivateWorkspaceIdentity(parseJson(Buffer.from(identity.base64, 'base64')), s.workspaceId);
    for (const f of files) {
      if (!f.path.endsWith('.json')) continue;
      const value = parseJson(Buffer.from(f.base64, 'base64'));
      if (f.path === 'desk.json') {
        try { decodeDeskPlain(decryptJson(key, value as EncryptedEnvelope), { properties: [], ledger: [] }, 'UTC'); } catch { fail('The saved Desk book is damaged or does not match the backup key.', 400); }
      } else if (f.path.startsWith('company-installation/private/')) {
        let plain; try { plain = decryptJson(key, value as EncryptedEnvelope); } catch { fail('Saved mail evidence does not match its backup key.', 400); }
        const envelope = exact(plain, ['name', 'value']);
        if (envelope.name !== f.path.split('/').at(-1)!.slice(0, -5) || !object(envelope.value)) fail('Saved mail evidence has an invalid identity.', 400);
        if (f.path.endsWith('/mail-workspace.json') && envelope.value.workspaceId !== s.workspaceId) fail('Saved mail work belongs to another private workspace.', 400);
      } else if (['agency-setup.json', 'workspace-views/tabs.json'].includes(f.path) && (!object(value) || value.workspaceId !== s.workspaceId)) fail('Saved settings belong to another private workspace.', 400);
      validateBusinessFile(f.path, value);
    }
    const logicalRecords = records.map(r => ({ id: r.id, kind: r.kind, revision: r.revision, value: decryptJson(key, r.payload) }));
    for (const row of logicalRecords) {
      if (row.kind !== 'bill-review-draft') continue;
      const draft = validateSavedBillReviewDraft(row.id, row.revision, row.value, s.workspaceId as string);
      const request = draft.proposalRequest;
      if (request) {
        const intent = logicalRecords.find(record => record.kind === 'bill-proposal' && record.id === `bill-proposal:${request.requestId}`);
        validateBillReviewDraftProposalLink(draft, intent);
      }
    }
    validateBackupMail(files, key, s.workspaceId, logicalRecords);
    validateSourceBillRecords(logicalRecords);
    validateExecutionRecords(logicalRecords, executionFiles(files));
    return { ...s, files, records } as unknown as Snapshot;
  } finally { key.fill(0); }
}
async function passphraseKey(passphrase: unknown, salt: Buffer) {
  if (typeof passphrase !== 'string' || passphrase.length < PRIVATE_BACKUP_MIN_PASSPHRASE || passphrase.length > PRIVATE_BACKUP_MAX_PASSPHRASE) return fail('Use a backup passphrase of 16–256 characters.', 400);
  return new Promise<Buffer>((resolveKey, reject) => scrypt(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolveKey(key)));
}
function receipt(snapshot: Snapshot, digest: string): PrivateBackupReceipt {
  return { digest, createdAt: snapshot.createdAt, workspaceId: snapshot.workspaceId, fileCount: snapshot.files.length + Number(snapshot.databasePresent), recordCount: snapshot.records.length,
    plainBytes: snapshot.files.reduce((sum, f) => sum + f.bytes, 0) + Buffer.byteLength(json(snapshot.records)), included: INCLUDED, excluded: EXCLUDED, restoreChanges: CHANGES };
}
async function unpack(value: unknown, passphrase: unknown) {
  if (Buffer.byteLength(json(value) ?? '') > PRIVATE_BACKUP_MAX_BYTES) fail('Choose a private backup no larger than 96 MB.', 413);
  const b = exact(value, ['format', 'version', 'kdf', 'salt', 'payload']);
  if (b.format !== 'realbud-private-business' || b.version !== 1 || b.kdf !== 'scrypt-32768-8-1' || typeof b.salt !== 'string' || !/^[a-f0-9]{32}$/.test(b.salt) || !isEncryptedEnvelope(b.payload)) fail('This is not a supported private business backup.', 400);
  const key = await passphraseKey(passphrase, Buffer.from(b.salt, 'hex'));
  try {
    let value; try { value = decryptJson(key, b.payload); } catch { return fail('The backup passphrase or integrity check failed. Existing records were not changed.', 400); }
    if (Buffer.byteLength(json(value)) > MAX_PAYLOAD) fail('The decoded backup is too large.', 413);
    const snapshot = validateSnapshot(value); return { snapshot, receipt: receipt(snapshot, hash(json(b))) };
  } finally { key.fill(0); }
}

/** Internal v1 compatibility seam. Authenticate and validate the entire legacy
 * graph before visiting it; never return its embedded installation key. File
 * buffers are borrowed until each awaited visitor returns, then cleared. */
export async function visitLegacyPrivateBackup(value: unknown, passphrase: unknown, visitor: {
  begin(metadata: { createdAt: string; workspaceId: string; databasePresent: boolean }): void | Promise<void>;
  file(file: { path: string; encoding: 'bytes' | 'json'; data: Buffer }): void | Promise<void>;
  record(record: { id: string; kind: string; revision: number; value: unknown }): void | Promise<void>;
}, signal?: AbortSignal): Promise<PrivateBackupReceipt> {
  signal?.throwIfAborted();
  const decoded = await unpack(value, passphrase); signal?.throwIfAborted();
  const sourceKey = Buffer.from(decoded.snapshot.keyHex, 'hex');
  try {
    const s = decoded.snapshot;
    await visitor.begin({ createdAt: s.createdAt, workspaceId: s.workspaceId, databasePresent: s.databasePresent }); signal?.throwIfAborted();
    for (const file of s.files) {
      signal?.throwIfAborted(); const bytes = Buffer.from(file.base64, 'base64'); let logical = bytes;
      try {
        const protectedFile = file.path === 'desk.json' || file.path.startsWith('company-installation/private/');
        if (protectedFile) logical = Buffer.from(JSON.stringify(decryptJson(sourceKey, parseJson(bytes) as EncryptedEnvelope)));
        await visitor.file({ path: file.path, encoding: protectedFile ? 'json' : 'bytes', data: logical }); signal?.throwIfAborted();
      } finally { logical.fill(0); bytes.fill(0); }
    }
    for (const row of s.records) {
      signal?.throwIfAborted();
      await visitor.record({ id: row.id, kind: row.kind, revision: row.revision, value: decryptJson(sourceKey, row.payload) }); signal?.throwIfAborted();
    }
    return structuredClone(decoded.receipt);
  } finally { sourceKey.fill(0); }
}


### server/private-backup-legacy.ts
/** Authenticated v1 archives enter the same target-key catalog path as v2.
 * This is a bounded compatibility reader, not a second restore implementation. */
import { createHash } from 'node:crypto';
import { PrivateBackupCatalog, catalogStorageBudget } from './private-backup-catalog.ts';
import { visitLegacyPrivateBackup } from './private-workspace-backup.ts';
import { PRIVATE_BACKUP_MAX_BYTES, PRIVATE_BACKUP_MAX_FILES, PRIVATE_BACKUP_MAX_RECORDS } from '../shared/private-workspace-backup.ts';

function fail(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }
export async function decodeLegacyBackupCatalog(input: AsyncIterable<Uint8Array>, options: {
  directory: string; key: Buffer; passphrase: unknown; expectedArchiveDigest: string;
  catalogMaxStorageBytes?: number; signal?: AbortSignal;
}) {
  if (typeof options.expectedArchiveDigest !== 'string' || !/^[a-f0-9]{64}$/.test(options.expectedArchiveDigest)) fail('The uploaded backup digest is missing.');
  if (!Buffer.isBuffer(options.key) || options.key.length !== 32) fail('A protected installation key is required.');
  // Legacy validation bounds individual entries and file contents separately.
  // Keep this aggregate ceiling large enough for its bounded encrypted records.
  const limits = { maxEntries: PRIVATE_BACKUP_MAX_FILES + PRIVATE_BACKUP_MAX_RECORDS, maxBytes: PRIVATE_BACKUP_MAX_BYTES,
    maxStorageBytes: options.catalogMaxStorageBytes };
  catalogStorageBudget(limits);
  const chunks: Buffer[] = []; let bytes: Buffer | undefined, block: Buffer | undefined, used = 0, archiveBytes = 0, catalog: PrivateBackupCatalog | undefined;
  let metadata: { version: 1; createdAt: string; workspaceId: string; databasePresent: boolean } | undefined;
  try {
    options.signal?.throwIfAborted(); const hash = createHash('sha256');
    for await (const chunk of input) {
      options.signal?.throwIfAborted();
      if (!(chunk instanceof Uint8Array)) fail('The backup upload contains invalid bytes.');
      archiveBytes += chunk.byteLength;
      if (archiveBytes > PRIVATE_BACKUP_MAX_BYTES) fail('Choose a legacy private backup no larger than 96 MB.', 413);
      // Keep the retained buffer count bounded even for tiny input chunks.
      // The legacy format still requires its bounded JSON payload in memory.
      for (let offset = 0; offset < chunk.byteLength;) {
        if (!block) { block = Buffer.alloc(64 * 1024); chunks.push(block); used = 0; }
        const take = Math.min(block.length - used, chunk.byteLength - offset);
        block.set(chunk.subarray(offset, offset + take), used); hash.update(block.subarray(used, used + take));
        offset += take; used += take; if (used === block.length) block = undefined;
      }
    }
    options.signal?.throwIfAborted(); const archiveDigest = hash.digest('hex');
    if (archiveDigest !== options.expectedArchiveDigest) fail('The complete backup differs from the uploaded copy. Preview it again.');
    bytes = Buffer.concat(chunks, archiveBytes); for (const chunk of chunks) chunk.fill(0); chunks.length = 0;
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { fail('This is not a supported private business backup.'); }
    bytes.fill(0); bytes = undefined;
    const legacy = await visitLegacyPrivateBackup(value, options.passphrase, {
      async begin(meta) {
        options.signal?.throwIfAborted(); metadata = { version: 1, ...meta };
        // Await creation directly: cancellation cannot escape while an owned
        // catalog is still being created in the background.
        catalog = await PrivateBackupCatalog.create({ directory: options.directory, key: options.key, workspaceId: meta.workspaceId, ...limits });
        options.signal?.throwIfAborted();
      },
      file(file) { options.signal?.throwIfAborted(); catalog!.addFile(file); },
      record(record) { options.signal?.throwIfAborted(); catalog!.addRecord(record); },
    }, options.signal);
    options.signal?.throwIfAborted(); if (!catalog || !metadata) fail('The backup could not be checked.');
    const summary = catalog.seal();
    if (summary.files + Number(metadata.databasePresent) !== legacy.fileCount || summary.records !== legacy.recordCount) fail('The backup catalog is incomplete.');
    // v1's historical receipt hashed canonical JSON. A formatted upload can
    // contain the same archive but have different bytes: bind the actual file.
    return { formatVersion: 1 as const, catalog, metadata, archiveBytes, archiveDigest, receipt: { ...legacy, digest: archiveDigest } };
  } catch (error) { catalog?.close(); throw error; }
  finally { bytes?.fill(0); for (const chunk of chunks) chunk.fill(0); }
}


### server/private-backup-legacy.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { emptyV3 } from '../shared/desk-v3.ts';
import { encryptJson, decryptJson } from './desk-crypto.ts';
import { createPrivateWorkspaceBackup, visitLegacyPrivateBackup } from './private-workspace-backup.ts';
import { decodeLegacyBackupCatalog } from './private-backup-legacy.ts';
import { PrivateBackupCatalog } from './private-backup-catalog.ts';
import { WorkflowDatabase } from './workflow-database.ts';
import { BankReferenceStore } from './bank-reference-store.ts';
import { transformPrivateBackupCatalog } from './private-backup-restore-catalog.ts';
import { PrivateBackupPreparedStore } from './private-backup-prepared.ts';
import { preparePrivateBackupRestore } from './private-backup-prepare.ts';
import { stagePrivateRestoreV2, applyStagedPrivateRestoreV2 } from './private-backup-cold-restore.ts';

const roots: string[] = [], catalogs: PrivateBackupCatalog[] = [], prepared: PrivateBackupPreparedStore[] = [];
const phrase = 'Fictional legacy compatibility passphrase';
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
async function root() { const dir = await mkdtemp(join(realpathSync(tmpdir()), 'RealBud legacy Ω ')); roots.push(dir); return dir; }
async function write(directory: string, path: string, bytes: Buffer | string) { await mkdir(dirname(join(directory, path)), { recursive: true, mode: 0o700 }); await writeFile(join(directory, path), bytes, { mode: 0o600 }); }
async function* input(bytes: Buffer) { for (let offset = 0; offset < bytes.length; offset += 503) yield bytes.subarray(offset, offset + 503); }
async function fixture() {
  const directory = await root(), key = randomBytes(32), workspaceId = randomUUID();
  const book = emptyV3({ name: 'Fictional legacy agency', timezone: 'Australia/Brisbane', jurisdictions: [] });
  await write(directory, 'company-installation/workspace.json', JSON.stringify({ version: 1, id: workspaceId, workerMemberKey: null }));
  await write(directory, 'desk.json', JSON.stringify(encryptJson(key, book)));
  const csv = Buffer.from('\uFEFFDate,Amount,Description,Reference\r\n21/09/2026,12.00,"Fictional café 🏡",old\r\n');
  await write(directory, 'vault/workflow-inputs/bank.csv', csv);
  const db = new WorkflowDatabase({ dir: directory, key }); let bank;
  try { const store = new BankReferenceStore(db); bank = store.create({ source: { filename: 'fictional.csv', bytesBase64: csv.toString('base64') }, columns: { date: 'Date', amount: 'Amount', narrative: 'Description', reference: 'Reference' }, dateFormat: 'DD/MM/YYYY', rules: [{ propertyId: 'fictional', reference: '00012', aliases: ['Fictional'] }] }); }
  finally { db.close(); }
  const service = createPrivateWorkspaceBackup({ directory, key: () => key, workspaceId, epoch: () => 'fixture', assertIdle() {}, assertFresh() {} });
  const exported = await service.exportBackup(phrase), bytes = Buffer.from(JSON.stringify(exported.backup, null, 2) + '\n');
  return { directory, key, workspaceId, book, csv, bank: bank!, exported, bytes };
}
async function decode(bytes: Buffer, extra: Partial<Parameters<typeof decodeLegacyBackupCatalog>[1]> = {}) {
  const result = await decodeLegacyBackupCatalog(input(bytes), { directory: join(await root(), 'decoded'), key: randomBytes(32), passphrase: phrase, expectedArchiveDigest: sha(bytes), ...extra });
  catalogs.push(result.catalog); return result;
}
afterEach(async () => { vi.restoreAllMocks(); for (const p of prepared.splice(0)) await p.close(); for (const c of catalogs.splice(0)) c.close(); for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('legacy backup conversion into the durable catalog path', () => {
  it('binds formatted uploaded bytes and preserves real bank originals and exact ordinary files under a new key', async () => {
    const f = await fixture(), key = randomBytes(32), result = await decode(f.bytes, { key });
    expect(result.archiveDigest).toBe(sha(f.bytes)); expect(result.archiveDigest).not.toBe(f.exported.receipt.digest);
    expect(result.receipt).toEqual({ ...f.exported.receipt, digest: sha(f.bytes) });
    expect(result.catalog.summary()).toMatchObject({ sealed: true, records: 1 });
    expect(result.catalog.getRecord('bank', f.bank.id)).toEqual({ ...f.bank, kind: 'bank' });
    expect(result.catalog.getFile('vault/workflow-inputs/bank.csv')!.data).toEqual(f.csv);
    expect(JSON.parse(result.catalog.getFile('desk.json')!.data.toString())).toEqual(f.book);
    const stored = await readFile(join(result.catalog.directory, 'catalog.sqlite'));
    expect(stored.includes(f.key)).toBe(false); expect(stored.includes(Buffer.from(f.key.toString('hex')))).toBe(false);
    result.catalog.close();
    const reopened = await PrivateBackupCatalog.open({ directory: result.catalog.directory, key, workspaceId: f.workspaceId, catalogId: result.catalog.catalogId }); catalogs.push(reopened);
    expect(reopened.validate().records).toBe(1);
  });
  it('restores converted legacy data through the existing transform, preparation and cold-restore implementation', async () => {
    const f = await fixture(), directory = await root(), key = randomBytes(32), decoded = await decode(f.bytes, { key });
    await write(directory, 'company-installation/workspace.json', JSON.stringify({ version: 1, id: randomUUID(), workerMemberKey: null }));
    await write(directory, 'desk.json', JSON.stringify(encryptJson(key, emptyV3({ name: 'Fresh fixture', timezone: 'UTC', jurisdictions: [] }))));
    const preview = await PrivateBackupCatalog.create({ directory: join(await root(), 'preview'), key, workspaceId: f.workspaceId, maxEntries: 100, maxBytes: 1024 ** 2 }); catalogs.push(preview);
    transformPrivateBackupCatalog({ source: decoded.catalog, destination: preview, at: 1000 });
    await mkdir(join(directory, 'private-backup-v2', 'prepared'), { recursive: true, mode: 0o700 });
    const directoryId = randomUUID(), store = await PrivateBackupPreparedStore.create({ directory: join(directory, 'private-backup-v2', 'prepared', directoryId), key, workspaceId: f.workspaceId }); prepared.push(store);
    const summary = await preparePrivateBackupRestore({ directory, key, source: preview, prepared: store, databasePresent: true, assertLease() {} }); await store.close();
    const options = { directory, key, directoryId, storeId: summary.storeId, workspaceId: f.workspaceId, expectedPreparedDigest: summary.digest, receipt: decoded.receipt, assertFresh() {}, assertIdle() {}, epoch: () => 'fixture' };
    await stagePrivateRestoreV2(options); await applyStagedPrivateRestoreV2({ directory, key });
    expect(await readFile(join(directory, 'vault/workflow-inputs/bank.csv'))).toEqual(f.csv);
    const book = decryptJson(key, JSON.parse(await readFile(join(directory, 'desk.json'), 'utf8'))) as { hands: string };
    expect(book.hands).toBe('held');
    const db = new WorkflowDatabase({ dir: directory, key });
    try { expect(new BankReferenceStore(db).get(f.bank.id)).toEqual(f.bank); } finally { db.close(); }
    expect(JSON.parse(await readFile(join(directory, 'company-installation/workspace.json'), 'utf8')).id).toBe(f.workspaceId);
  });
  it.each(['digest', 'passphrase', 'utf8', 'trailing', 'authenticated graph'])('refuses invalid %s without creating a catalog', async attack => {
    const f = await fixture(), directory = join(await root(), 'refused'); let bytes = f.bytes, expectedArchiveDigest = sha(bytes), passphrase = phrase;
    if (attack === 'digest') expectedArchiveDigest = '0'.repeat(64);
    if (attack === 'passphrase') passphrase += 'wrong';
    if (attack === 'utf8') { bytes = Buffer.from([0xff]); expectedArchiveDigest = sha(bytes); }
    if (attack === 'trailing') { bytes = Buffer.concat([bytes, Buffer.from('junk')]); expectedArchiveDigest = sha(bytes); }
    if (attack === 'authenticated graph') {
      const k = scryptSync(phrase, Buffer.from(f.exported.backup.salt, 'hex'), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      try { const value = decryptJson(k, f.exported.backup.payload) as { files: unknown[] }; value.files = [];
        bytes = Buffer.from(JSON.stringify({ ...f.exported.backup, payload: encryptJson(k, value) })); expectedArchiveDigest = sha(bytes); }
      finally { k.fill(0); }
    }
    await expect(decode(bytes, { directory, expectedArchiveDigest, passphrase })).rejects.toThrow(); expect(existsSync(directory)).toBe(false);
  });
  it('refuses an invalid host capacity before consuming upload bytes', async () => {
    let pulled = false; async function* stream() { pulled = true; yield Buffer.from('fixture'); }
    const directory = join(await root(), 'invalid');
    await expect(decodeLegacyBackupCatalog(stream(), { directory, key: randomBytes(32), passphrase: phrase, expectedArchiveDigest: 'a'.repeat(64), catalogMaxStorageBytes: 4096 })).rejects.toMatchObject({ status: 400 });
    expect(pulled).toBe(false); expect(existsSync(directory)).toBe(false);
  });
  it('drains catalog creation on cancellation and closes provisional storage', async () => {
    const f = await fixture(), controller = new AbortController(), create = PrivateBackupCatalog.create.bind(PrivateBackupCatalog);
    let entered!: () => void, release!: () => void, owned: PrivateBackupCatalog | undefined, settled = false;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(PrivateBackupCatalog, 'create').mockImplementation(async options => { entered(); await gate; owned = await create(options); return owned; });
    const result = decode(f.bytes, { signal: controller.signal }).then(() => { settled = true; return null; }, e => { settled = true; return e; });
    await started; controller.abort(); await new Promise(resolve => setImmediate(resolve)); expect(settled).toBe(false); release();
    expect(await result).toBeInstanceOf(Error); expect(() => owned!.summary()).toThrow(/closed/);
  });
  it('clears borrowed plaintext buffers when the awaited visitor fails', async () => {
    const f = await fixture(); let borrowed: Buffer | undefined;
    await expect(visitLegacyPrivateBackup(f.exported.backup, phrase, { begin() {}, async file(file) { borrowed = file.data; await Promise.resolve(); throw new Error('Fixture visitor failure'); }, record() {} })).rejects.toThrow('Fixture visitor failure');
    expect(borrowed?.some(byte => byte !== 0)).toBe(false);
  });
});
