import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { createBackupOperationStore, type BackupOperationStore } from './private-backup-operations.ts';
import { createBackupResourceRuntime } from './private-backup-resource-runtime.ts';
import { plantPrivateFile, privateDir, privateTempRoot, removeFixture, windowsAdmissionTimeout } from './testing/private-fixture.ts';

const roots: string[] = [], catalogs: PrivateBackupCatalog[] = [], prepared: PrivateBackupPreparedStore[] = [];
const journals: BackupOperationStore[] = [], runtimes: ReturnType<typeof createBackupResourceRuntime>[] = [];
const phrase = 'Fictional legacy compatibility passphrase';
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
async function root() { const dir = privateTempRoot(join(realpathSync(tmpdir()), 'RealBud legacy Ω ')); roots.push(dir); return dir; }
async function write(directory: string, path: string, bytes: Buffer | string) { plantPrivateFile(join(directory, path), bytes); }
async function* input(bytes: Buffer) { for (let offset = 0; offset < bytes.length; offset += 503) yield bytes.subarray(offset, offset + 503); }
async function fixture(large = false) {
  const directory = await root(), key = randomBytes(32), workspaceId = randomUUID();
  const book = emptyV3({ name: 'Fictional legacy agency', timezone: 'Australia/Brisbane', jurisdictions: [] });
  await write(directory, 'company-installation/workspace.json', JSON.stringify({ version: 1, id: workspaceId, workerMemberKey: null }));
  await write(directory, 'desk.json', JSON.stringify(encryptJson(key, book)));
  const csv = Buffer.from('\uFEFFDate,Amount,Description,Reference\r\n21/09/2026,12.00,"Fictional café 🏡",old\r\n');
  await write(directory, 'vault/workflow-inputs/bank.csv', csv);
  if (large) await write(directory, 'vault/properties/retained.md', 'Fictional retained property notes '.repeat(20_000));
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
afterEach(async () => { vi.restoreAllMocks(); for (const runtime of runtimes.splice(0)) await runtime.close(); for (const journal of journals.splice(0)) journal.close(); for (const p of prepared.splice(0)) await p.close(); for (const c of catalogs.splice(0)) c.close(); for (const dir of roots.splice(0)) await removeFixture(dir); });

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
  it('restores converted legacy data through the existing transform, preparation and cold-restore implementation', windowsAdmissionTimeout(106), async () => {
    const f = await fixture(), directory = await root(), key = randomBytes(32), decoded = await decode(f.bytes, { key });
    await write(directory, 'company-installation/workspace.json', JSON.stringify({ version: 1, id: randomUUID(), workerMemberKey: null }));
    await write(directory, 'desk.json', JSON.stringify(encryptJson(key, emptyV3({ name: 'Fresh fixture', timezone: 'UTC', jurisdictions: [] }))));
    const preview = await PrivateBackupCatalog.create({ directory: join(await root(), 'preview'), key, workspaceId: f.workspaceId, maxEntries: 100, maxBytes: 1024 ** 2 }); catalogs.push(preview);
    transformPrivateBackupCatalog({ source: decoded.catalog, destination: preview, at: 1000 });
    privateDir(join(directory, 'private-backup-v2', 'prepared'));
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
  it('binds legacy import to actual cold completion, then cleans the prior workspace allocations without exposing its history', windowsAdmissionTimeout(166), async () => {
    const f = await fixture(), directory = await root(), key = randomBytes(32), previousWorkspaceId = randomUUID(), id = randomUUID();
    await write(directory, 'company-installation/workspace.json', JSON.stringify({ version: 1, id: previousWorkspaceId, workerMemberKey: null }));
    await write(directory, 'desk.json', JSON.stringify(encryptJson(key, emptyV3({ name: 'Fresh fixture', timezone: 'UTC', jurisdictions: [] }))));
    const resourceDirectory = join(directory, 'private-backup-v2'), settings = { directory: join(resourceDirectory, 'operations'), key, workspaceId: previousWorkspaceId };
    const journal = await createBackupOperationStore(settings); journals.push(journal);
    const runtime = createBackupResourceRuntime({ journal, directory: resourceDirectory, key }); runtimes.push(runtime);
    const reservation = 16 * 1024 * 1024, ownedPaths: string[] = [];
    journal.create({ version: 2, id, workspaceId: previousWorkspaceId, kind: 'upload', phase: 'uploading', createdAt: 10, updatedAt: 10, expiresAt: null,
      progress: { completedBytes: 0, totalBytes: f.bytes.length }, receivedBytes: 0, prefixCommitment: sha('[]'), canCancel: true, requiresPassphrase: false }, reservation, { trackResources: true });
    await runtime.run(id, async context => {
      const imported = await context.claim('decoded', 4 * 1024 * 1024); ownedPaths.push(imported.directory);
      const decoded = await decode(f.bytes, { directory: imported.directory, key, signal: context.signal, catalogMaxStorageBytes: 2 * 1024 * 1024 }); context.own(() => decoded.catalog.close());
      let record = journal.get(id);
      record = journal.update(id, record.revision, next => { next.operation.phase = 'uploaded'; next.operation.receivedBytes = f.bytes.length; next.operation.progress.completedBytes = f.bytes.length; next.operation.artifact = { archiveBytes: f.bytes.length, archiveDigest: decoded.archiveDigest }; });
      journal.update(id, record.revision, next => { next.operation.phase = 'checking'; });
      const previewClaim = await context.claim('preview', 4 * 1024 * 1024); ownedPaths.push(previewClaim.directory);
      const preview = await PrivateBackupCatalog.create({ directory: previewClaim.directory, key, workspaceId: f.workspaceId, maxEntries: 100, maxBytes: 1024 * 1024, maxStorageBytes: 2 * 1024 * 1024 }); context.own(() => preview.close());
      const previewSummary = transformPrivateBackupCatalog({ source: decoded.catalog, destination: preview, at: 1000 });
      journal.update(id, journal.get(id).revision, next => {
        next.operation.phase = 'reviewed'; next.operation.preview = decoded.receipt;
        next.references.preview = { directoryId: previewClaim.binding.allocation.id, catalogId: preview.catalogId, workspaceId: f.workspaceId, digest: previewSummary.digest, createdAt: decoded.metadata.createdAt, databasePresent: true };
      });
      const preparedClaim = await context.claim('prepared', 4 * 1024 * 1024), build = await context.claim('build', 2 * 1024 * 1024); ownedPaths.push(preparedClaim.directory, build.directory);
      const store = await PrivateBackupPreparedStore.create({ directory: preparedClaim.directory, key, workspaceId: f.workspaceId, limits: { bytes: 1024 * 1024, fileBytes: 1024 * 1024, entries: 100, sqliteBytes: 2 * 1024 * 1024 } }); context.own(() => store.close());
      const summary = await preparePrivateBackupRestore({ directory, key, source: preview, prepared: store, databasePresent: true, assertLease() {}, signal: context.signal, databaseBytes: 1024 * 1024, buildDirectoryId: build.binding.allocation.id });
      await store.close();
      record = journal.update(id, journal.get(id).revision, next => {
        next.operation.phase = 'staging'; next.operation.canCancel = false; next.restoreHeld = true;
        next.references.prepared = { directoryId: preparedClaim.binding.allocation.id, storeId: summary.storeId, workspaceId: f.workspaceId, digest: summary.digest };
      });
      await stagePrivateRestoreV2({ directory, key, directoryId: preparedClaim.binding.allocation.id, storeId: summary.storeId, workspaceId: f.workspaceId, expectedPreparedDigest: summary.digest,
        receipt: decoded.receipt, operation: { operationId: id, previousWorkspaceId }, assertFresh() {}, assertIdle() {}, epoch: () => 'fixture' });
      journal.update(id, record.revision, next => { next.operation.phase = 'staged'; });
    });
    await expect(runtime.cancel(id)).rejects.toThrow('retain'); expect(journal.usage().reservedBytes).toBe(reservation);
    await runtime.close(); journal.close(); await applyStagedPrivateRestoreV2({ directory, key });
    const reopened = await createBackupOperationStore({ ...settings, workspaceId: f.workspaceId, restoreDirectory: directory }); journals.push(reopened);
    expect(() => reopened.get(id)).toThrow('not found'); expect(reopened.list().items).toEqual([]); expect(reopened.usage().reservedBytes).toBe(reservation);
    const recovered = createBackupResourceRuntime({ journal: reopened, directory: resourceDirectory, key }); runtimes.push(recovered);
    expect(await recovered.recover()).toEqual({ cleaned: 1, held: 0 }); expect(reopened.usage().reservedBytes).toBe(0);
    for (const path of ownedPaths) expect(existsSync(path)).toBe(false);
    expect(await readFile(join(directory, 'vault/workflow-inputs/bank.csv'))).toEqual(f.csv);
    const db = new WorkflowDatabase({ dir: directory, key }); try { expect(new BankReferenceStore(db).get(f.bank.id)).toEqual(f.bank); } finally { db.close(); }
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
  it('enforces the actual catalog page ceiling, preserves the source and permits a fresh retry', async () => {
    const f = await fixture(true), directory = join(await root(), 'limited'), original = Buffer.from(f.bytes);
    await expect(decode(f.bytes, { directory, catalogMaxStorageBytes: 65_536 })).rejects.toMatchObject({ status: 413 });
    expect(existsSync(join(directory, 'catalog.sqlite'))).toBe(true); expect(f.bytes).toEqual(original);
    const result = await decode(f.bytes, { catalogMaxStorageBytes: 4 * 1024 * 1024 });
    expect(result.catalog.getFile('vault/properties/retained.md')!.data).toEqual(await readFile(join(f.directory, 'vault/properties/retained.md')));
  });
  it('bounds raw uploads before JSON decoding or creating any catalog', async () => {
    const directory = join(await root(), 'oversized'), chunk = Buffer.alloc(1024 * 1024, 32); let pulled = 0;
    async function* oversized() { for (; pulled < 98; pulled++) yield chunk; }
    await expect(decodeLegacyBackupCatalog(oversized(), { directory, key: randomBytes(32), passphrase: phrase, expectedArchiveDigest: 'a'.repeat(64) })).rejects.toMatchObject({ status: 413 });
    expect(pulled).toBe(96); expect(existsSync(directory)).toBe(false); expect(chunk[0]).toBe(32);
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
  it('awaits the input iterator cleanup when cancellation is observed during reading', async () => {
    const controller = new AbortController(); let returned = false, settled = false, release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { started = resolve; });
    const stream: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]() { return {
      async next() { controller.abort(); return { done: false, value: Buffer.from('fixture') }; },
      async return() { returned = true; started(); await gate; return { done: true, value: undefined }; },
    }; } };
    const directory = join(await root(), 'cancelled');
    const result = decodeLegacyBackupCatalog(stream, { directory, key: randomBytes(32), passphrase: phrase, expectedArchiveDigest: 'a'.repeat(64), signal: controller.signal }).catch(error => { settled = true; return error; });
    await ready; expect(returned).toBe(true); expect(settled).toBe(false); release();
    expect(await result).toBeInstanceOf(Error); expect(existsSync(directory)).toBe(false);
  });
  it('clears borrowed plaintext buffers when the awaited visitor fails', async () => {
    const f = await fixture(); let borrowed: Buffer | undefined;
    await expect(visitLegacyPrivateBackup(f.exported.backup, phrase, { begin() {}, async file(file) { borrowed = file.data; await Promise.resolve(); throw new Error('Fixture visitor failure'); }, record() {} })).rejects.toThrow('Fixture visitor failure');
    expect(borrowed?.some(byte => byte !== 0)).toBe(false);
  });
});
