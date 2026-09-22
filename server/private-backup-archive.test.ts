import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrivateBackupCatalog } from './private-backup-catalog.ts';
import { encodeBackupCatalog, decodeBackupCatalog, type BackupArchiveReceipt } from './private-backup-archive.ts';
import { encodePrivateBackupV2, decodePrivateBackupV2 } from './private-backup-codec.ts';
import { emptyV3 } from '../shared/desk-v3.ts';
import { WorkflowDatabase } from './workflow-database.ts';
import { BankReferenceStore } from './bank-reference-store.ts';
import type { BillReviewDraft } from '../shared/bill-review-drafts.ts';

const roots: string[] = [], catalogs: PrivateBackupCatalog[] = [], phrase = 'Fictional bounded archive test passphrase';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const createdAt = '2026-09-21T00:00:00.000Z';
function root() { const path = mkdtempSync(join(realpathSync(tmpdir()), 'RealBud archive Ω ')); roots.push(path); return path; }
async function fixture() {
  const directory = root(), key = randomBytes(32), workspaceId = randomUUID();
  const catalog = await PrivateBackupCatalog.create({ directory: join(directory, 'catalog'), key, workspaceId, maxEntries: 100_000, maxBytes: 1024 ** 3 }); catalogs.push(catalog);
  catalog.addFile({ path: 'company-installation/workspace.json', encoding: 'bytes', data: Buffer.from(JSON.stringify({ version: 1, id: workspaceId, workerMemberKey: null })) });
  catalog.addFile({ path: 'desk.json', encoding: 'json', data: Buffer.from(JSON.stringify(emptyV3({ name: 'Fictional archive office', timezone: 'UTC', jurisdictions: [] }))) });
  return { directory, key, workspaceId, catalog };
}
async function* input(bytes: Buffer) { for (let offset = 0; offset < bytes.length; offset += 701) yield bytes.subarray(offset, offset + 701); }
async function collect(stream: AsyncIterable<Uint8Array>) { const buffers = []; for await (const bytes of stream) buffers.push(Buffer.from(bytes)); return Buffer.concat(buffers); }
async function encode(catalog: PrivateBackupCatalog, databasePresent = false) {
  let receipt: BackupArchiveReceipt | undefined;
  const bytes = await collect(encodeBackupCatalog(catalog, { passphrase: phrase, databasePresent, createdAt, onComplete: value => { receipt = value; } }));
  expect(receipt?.transport.archiveDigest).toBe(sha(bytes)); return { bytes, receipt: receipt! };
}
async function decode(bytes: Buffer, overrides: Partial<Parameters<typeof decodeBackupCatalog>[1]> = {}) {
  const result = await decodeBackupCatalog(input(bytes), { passphrase: phrase, directory: join(root(), 'import'), key: randomBytes(32), expectedArchiveDigest: sha(bytes), ...overrides });
  catalogs.push(result.catalog); return result;
}
afterEach(() => { vi.restoreAllMocks(); for (const c of catalogs.splice(0)) c.close(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('authenticated portable business catalog archives', () => {
  it('enforces the host catalog storage reservation through actual archive decode without losing the source', async () => {
    const f = await fixture(), retained = Buffer.from('Fictional capacity fixture '.repeat(20_000));
    f.catalog.addFile({ path: 'vault/properties/retained.md', encoding: 'bytes', data: retained });
    const { bytes, receipt } = await encode(f.catalog), original = Buffer.from(bytes);
    const directory = join(root(), 'limited');
    await expect(decode(bytes, { directory, catalogMaxStorageBytes: 65_536 })).rejects.toMatchObject({ status: 413 });
    expect(existsSync(join(directory, 'catalog.sqlite'))).toBe(true);
    expect(bytes).toEqual(original);
    expect(f.catalog.getFile('vault/properties/retained.md')!.data).toEqual(retained);
    const retry = await decode(bytes, { catalogMaxStorageBytes: 2 * 1024 * 1024 });
    expect(retry.receipt).toEqual(receipt.receipt);
    expect(retry.catalog.getFile('vault/properties/retained.md')!.data).toEqual(retained);
  });
  it('rejects invalid host catalog capacity before pulling input or creating an import directory', async () => {
    const directory = join(root(), 'invalid'); let pulled = false;
    async function* stream() { pulled = true; yield Buffer.from('fixture'); }
    await expect(decodeBackupCatalog(stream(), { directory, key: randomBytes(32), passphrase: phrase, expectedArchiveDigest: 'a'.repeat(64), catalogMaxStorageBytes: 4096 })).rejects.toMatchObject({ status: 400 });
    expect(pulled).toBe(false); expect(existsSync(directory)).toBe(false);
  });
  it('drains and closes in-flight catalog creation before returning cancellation', async () => {
    const f = await fixture(), { bytes } = await encode(f.catalog), controller = new AbortController();
    const create = PrivateBackupCatalog.create.bind(PrivateBackupCatalog);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let owned: PrivateBackupCatalog | undefined;
    const close = vi.spyOn(PrivateBackupCatalog.prototype, 'close');
    vi.spyOn(PrivateBackupCatalog, 'create').mockImplementation(async options => {
      entered(); await gate; owned = await create(options); return owned;
    });
    let settled = false;
    const result = decode(bytes, { signal: controller.signal }).then(() => { settled = true; return null; }, error => { settled = true; return error; });
    await started; controller.abort();
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false); release();
    expect(await result).toBeInstanceOf(Error);
    expect(owned).toBeDefined(); expect(close.mock.instances).toContain(owned);
    expect(() => owned!.summary()).toThrow(/closed/i);
  });
  it('preserves exact file bytes and actual reviewed bank records under a different installation key', async () => {
    const f = await fixture(), db = new WorkflowDatabase({ dir: join(f.directory, 'source'), key: f.key });
    const csv = Buffer.from('\uFEFFDate,Amount,Description,Reference,Extra\r\n21/09/2026,120.00,"Fictional café 🏡","old",保留\r\n');
    let saved;
    try {
      const bank = new BankReferenceStore(db), first = bank.create({ source: { filename: 'fictional.csv', bytesBase64: csv.toString('base64') }, columns: { date: 'Date', amount: 'Amount', narrative: 'Description', reference: 'Reference' }, dateFormat: 'DD/MM/YYYY', rules: [{ propertyId: 'fictional-property', reference: '00012', aliases: ['Fictional'] }] });
      saved = bank.review(first.id, first.revision, [{ rowId: first.value.batch.rows[0].id, action: 'assign', propertyId: 'fictional-property', reason: 'Fictional checked reference' }]);
      f.catalog.addRecord({ ...saved, kind: 'bank' });
    } finally { db.close(); }
    f.catalog.addFile({ path: 'vault/workflow-inputs/bank.csv', encoding: 'bytes', data: csv });
    const sourceKey = Buffer.from(f.key), targetKey = randomBytes(32), encoded = await encode(f.catalog, true);
    const result = await decode(encoded.bytes, { key: targetKey });
    expect(result.metadata.workspaceId).toBe(f.workspaceId); expect(result.receipt).toEqual(encoded.receipt.receipt);
    expect(result.catalog.getRecord('bank', saved!.id)).toEqual({ ...saved, kind: 'bank' });
    expect(result.catalog.getFile('vault/workflow-inputs/bank.csv')!.data).toEqual(csv);
    expect(result.catalog.summary().sealed).toBe(true); expect(result.catalog.catalogId).not.toBe(f.catalog.catalogId);
    expect(() => result.catalog.addFile({ path: 'vault/USER.md', encoding: 'bytes', data: Buffer.from('unexpected') })).toThrow(/seal|immutable/);
    const entryText: string[] = [];
    await decodePrivateBackupV2(input(encoded.bytes), { passphrase: phrase, visitor: { begin() {}, data(bytes) { entryText.push(Buffer.from(bytes).toString('utf8')); }, end() {} } });
    expect(entryText.join('')).not.toContain(sourceKey.toString('hex')); expect(entryText.join('')).not.toContain(targetKey.toString('hex'));
    expect(entryText.join('')).not.toContain('keyHex');
  });

  it('retains more than the v1 record cap, exact closed draft fields and insertion order', async () => {
    const f = await fixture(), expected: string[] = [];
    for (let index = 0; index < 5001; index++) {
      const id = randomUUID(); expected.push(`bill-review-draft:${id}`);
      const value: BillReviewDraft = { version: 1, id, revision: 2, createdAt: 1, updatedAt: 2, workspaceId: f.workspaceId, state: index % 2 ? 'saved' : 'discarded', billId: null, billRevision: null, itemId: null, messageId: null, sourceDigest: null,
        fields: { propertyId: '', kind: 'Water', vendor: 'Fictional', amount: '12.', invoiceDate: '2026-', dueDate: '', note: `Unfinished 私人 note ${index}\n  ` }, billState: 'hold', reason: '', seriesId: '', arrivalDate: '', proposalRequest: null };
      f.catalog.addRecord({ id: expected[index], kind: 'bill-review-draft', revision: 2, value });
    }
    const encoded = await encode(f.catalog, true), restored = await decode(encoded.bytes);
    expect(restored.receipt.recordCount).toBe(5001); expect([...restored.catalog.iterateRecords()].map(row => row.id)).toEqual(expected);
    for (const id of [expected[0], expected[5000]]) expect(restored.catalog.getRecord('bill-review-draft', id)).toEqual(f.catalog.getRecord('bill-review-draft', id));
  }, process.env.CI ? 120_000 : 30_000);

  it('keeps decoded entries provisional until exact EOF and the expected uploaded digest validate', async () => {
    const f = await fixture(), { bytes } = await encode(f.catalog), source = readFileSync(join(f.catalog.directory, 'catalog.sqlite'));
    for (const data of [bytes.subarray(0, bytes.length - 1), Buffer.concat([bytes, Buffer.from('trailing')])]) {
      let completed = false; await expect(decode(data).then(() => { completed = true; })).rejects.toThrow(); expect(completed).toBe(false);
    }
    await expect(decode(bytes, { expectedArchiveDigest: '0'.repeat(64) })).rejects.toThrow(/differs/);
    expect(readFileSync(join(f.catalog.directory, 'catalog.sqlite'))).toEqual(source);
  });

  it.each(['source key field', 'wrong encoding', 'extra record field', 'unknown path', 'no identity', 'no database flag', 'invalid UTF-8'])('rejects authenticated but invalid logical archives: %s', async attack => {
    const f = await fixture();
    const meta: Record<string, unknown> = { version: 2, createdAt, workspaceId: f.workspaceId, databasePresent: true };
    if (attack === 'source key field') meta.keyHex = f.key.toString('hex');
    if (attack === 'no database flag') meta.databasePresent = false;
    const entries = [{ name: 'realbud:metadata', bytes: Buffer.from(JSON.stringify(meta)) }, ...[...f.catalog.iterateFiles()].filter(row => attack !== 'no identity' || row.path === 'desk.json').map(row => ({ name: `file:${attack === 'wrong encoding' && row.path === 'desk.json' ? 'bytes' : row.encoding}:${row.path}`, bytes: row.data }))];
    if (attack === 'unknown path') entries.push({ name: 'file:bytes:../secret.txt', bytes: Buffer.from('fictional') });
    if (attack === 'invalid UTF-8') entries[0].bytes = Buffer.concat([Buffer.from('{"version":2,"createdAt":"'), Buffer.from([0xff]), Buffer.from('"}')]);
    if (['extra record field', 'no database flag'].includes(attack)) entries.push({ name: 'record:handoff:test', bytes: Buffer.from(JSON.stringify({ id: 'handoff:test', kind: 'handoff', revision: 1, value: { version: 1, runId: 'run', threadId: 'thread', botId: 'bud', detail: 'Fictional closed handoff', jobRevision: 1, reason: 'login', state: 'closed' }, ...(attack === 'extra record field' ? { approval: true } : {}) })) });
    const bytes = await collect(encodePrivateBackupV2(entries.map(e => ({ name: e.name, size: e.bytes.length, data: input(e.bytes) })), { passphrase: phrase }));
    await expect(decode(bytes)).rejects.toThrow();
    expect(existsSync(join(f.directory, 'private-workspace-restore.json'))).toBe(false);
  });
});
