import { afterEach, describe, expect, it } from 'vitest';
import { createReadStream, mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrivateBackupCatalog } from './private-backup-catalog.ts';
import { PrivateBackupPreparedStore } from './private-backup-prepared.ts';
import { capturePrivateWorkspace, verifyPrivateWorkspaceCapture } from './private-backup-capture.ts';
import { encodeBackupCatalog, decodeBackupCatalog, type BackupArchiveReceipt } from './private-backup-archive.ts';
import { createBackupTransferStore, BACKUP_TRANSFER_CHUNK_BYTES } from './private-backup-transfer.ts';
import { transformPrivateBackupCatalog } from './private-backup-restore-catalog.ts';
import { preparePrivateBackupRestore } from './private-backup-prepare.ts';
import { stagePrivateRestoreV2, applyStagedPrivateRestoreV2 } from './private-backup-cold-restore.ts';
import { WorkflowDatabase } from './workflow-database.ts';
import { BankReferenceStore } from './bank-reference-store.ts';
import { encryptJson, decryptJson } from './desk-crypto.ts';
import { emptyV3 } from '../shared/desk-v3.ts';
import type { BillReviewDraft } from '../shared/bill-review-drafts.ts';
import { batchBackupFixture, verifyRestoredBatchReader } from './testing/batch-backup-fixture.ts';

const roots: string[] = [], catalogs: PrivateBackupCatalog[] = [], close: (() => unknown | Promise<unknown>)[] = [];
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function folder() { const value = mkdtempSync(join(realpathSync(tmpdir()), 'RealBud v2 integration Ω ')); roots.push(value); return value; }
function write(root: string, path: string, bytes: Buffer | string) { mkdirSync(dirname(join(root, path)), { recursive: true, mode: 0o700 }); writeFileSync(join(root, path), bytes, { mode: 0o600 }); }
async function catalog(parent: string, name: string, key: Buffer, workspaceId: string) { const value = await PrivateBackupCatalog.create({ directory: join(parent, name), key, workspaceId, maxEntries: 100_000, maxBytes: 1024 ** 3 }); catalogs.push(value); return value; }
afterEach(async () => { for (const work of close.splice(0).reverse()) await work(); for (const c of catalogs.splice(0)) c.close(); for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('actual filesystem v2 backup and restore pipeline', () => {
  it('captures, transfers, prepares and cold-restores over 5,000 records with exact bank bytes and a different destination key', async () => {
    const source = folder(), destination = folder(), scratch = folder();
    const sourceKey = randomBytes(32), targetKey = randomBytes(32), workspaceId = randomUUID(), targetWorkspace = randomUUID();
    const sourceBook = emptyV3({ name: 'Fictional full pipeline office', timezone: 'Australia/Brisbane', jurisdictions: [] });
    const targetBook = emptyV3({ name: 'Fictional fresh target', timezone: 'UTC', jurisdictions: [] });
    for (const [directory, key, id, book] of [[source, sourceKey, workspaceId, sourceBook], [destination, targetKey, targetWorkspace, targetBook]] as const) {
      write(directory, 'company-installation/workspace.json', JSON.stringify({ version: 1, id, workerMemberKey: null }));
      write(directory, 'desk.json', JSON.stringify(encryptJson(key, book))); write(directory, 'desk.key', key);
    }
    const csv = Buffer.from('\uFEFFDate,Amount,Description,Reference,Extra\r\n21/09/2026,120.00,"Fictional café 🏡","old",保留\r\n');
    const batchBytes = JSON.stringify(batchBackupFixture(), null, 2) + '\n'; write(source, 'work-batches.json', batchBytes);
    write(source, 'vault/workflow-inputs/original.csv', csv);
    const db = new WorkflowDatabase({ dir: source, key: sourceKey });
    let bankRecord: ReturnType<BankReferenceStore['review']>;
    const drafts: { id: string; value: BillReviewDraft }[] = [];
    try {
      const bank = new BankReferenceStore(db), first = bank.create({ source: { filename: 'fictional.csv', bytesBase64: csv.toString('base64') }, columns: { date: 'Date', amount: 'Amount', narrative: 'Description', reference: 'Reference' }, dateFormat: 'DD/MM/YYYY', rules: [{ propertyId: 'fictional-property', reference: '00012', aliases: ['Fictional'] }] });
      bankRecord = bank.review(first.id, first.revision, [{ rowId: first.value.batch.rows[0].id, action: 'assign', propertyId: 'fictional-property', reason: 'Fictional reviewed rule' }]);
      for (let index = 0; index < 5001; index++) {
        const id = randomUUID(), value: BillReviewDraft = { version: 1, id, revision: 1, createdAt: 1, updatedAt: 1, workspaceId, state: index % 2 ? 'saved' : 'discarded', billId: null, billRevision: null, itemId: null, messageId: null, sourceDigest: null,
          fields: { propertyId: '', kind: 'Water', vendor: 'Fictional', amount: '12.', invoiceDate: '2026-', dueDate: '', note: `Unfinished 私人 ${index}\n  ` }, billState: 'hold', reason: '', seriesId: '', arrivalDate: '', proposalRequest: null };
        const identity = `bill-review-draft:${id}`; db.create('bill-review-draft', identity, value, null);
        if (index === 0 || index === 5000) drafts.push({ id: identity, value });
      }
    } finally { db.close(); }
    let held = true;
    const captured = await catalog(scratch, 'captured', sourceKey, workspaceId);
    const captureOptions = { directory: source, key: sourceKey, workspaceId, catalog: captured, assertLease: () => { if (!held) throw new Error('lease released'); } };
    const capture = await capturePrivateWorkspace(captureOptions); await verifyPrivateWorkspaceCapture(captureOptions, capture); held = false;
    expect(readFileSync(join(source, 'work-batches.json'), 'utf8')).toBe(batchBytes);
    expect(captured.getFile('work-batches.json')?.data.toString()).toBe(batchBytes);
    expect(capture.recordCount).toBe(5002);
    let archiveReceipt: BackupArchiveReceipt | undefined; const buffers: Buffer[] = [];
    // Small generated fixture collection is test-only. Production transfer and
    // prepared-file paths below read/write bounded disk chunks.
    for await (const chunk of encodeBackupCatalog(captured, { passphrase: 'Fictional complete pipeline password', databasePresent: capture.databasePresent, createdAt: '2026-09-21T00:00:00.000Z', onComplete: value => { archiveReceipt = value; } })) buffers.push(Buffer.from(chunk));
    const archive = Buffer.concat(buffers), transfers = await createBackupTransferStore({ directory: join(destination, 'transfer-fixture'), key: targetKey, workspaceId: targetWorkspace }); close.push(() => transfers.close());
    const uploadId = randomUUID(), manifest: [number, number, string][] = [];
    await transfers.start(uploadId, archive.length);
    for (let offset = 0; offset < archive.length; offset += BACKUP_TRANSFER_CHUNK_BYTES) { const bytes = archive.subarray(offset, offset + BACKUP_TRANSFER_CHUNK_BYTES), digest = sha(bytes); await transfers.append(uploadId, offset, bytes, digest); manifest.push([offset, bytes.length, digest]); }
    await transfers.seal(uploadId, sha(JSON.stringify(manifest)));
    const artifact = await transfers.artifact(uploadId);
    const decoded = await decodeBackupCatalog(createReadStream(artifact.path, { highWaterMark: BACKUP_TRANSFER_CHUNK_BYTES }), { directory: join(scratch, 'decoded'), key: targetKey, passphrase: 'Fictional complete pipeline password', expectedArchiveDigest: artifact.digest }); catalogs.push(decoded.catalog);
    expect(decoded.receipt).toEqual(archiveReceipt!.receipt);
    const transformed = await catalog(scratch, 'transformed', targetKey, workspaceId);
    transformPrivateBackupCatalog({ source: decoded.catalog, destination: transformed, at: 1000 });
    const directoryId = randomUUID(), parent = join(destination, 'private-backup-v2', 'prepared'); mkdirSync(parent, { recursive: true, mode: 0o700 });
    const prepared = await PrivateBackupPreparedStore.create({ directory: join(parent, directoryId), key: targetKey, workspaceId }); close.push(() => prepared.close());
    const summary = await preparePrivateBackupRestore({ directory: destination, key: targetKey, source: transformed, prepared, databasePresent: decoded.metadata.databasePresent, assertLease() {} }); await prepared.close();
    const stage = { directory: destination, key: targetKey, directoryId, storeId: summary.storeId, workspaceId, expectedPreparedDigest: summary.digest, receipt: decoded.receipt, assertFresh() {}, assertIdle() {}, epoch: () => 'fixture-fresh-held' };
    await stagePrivateRestoreV2(stage); expect(readFileSync(join(destination, 'desk.key'))).toEqual(targetKey);
    await applyStagedPrivateRestoreV2(stage);
    expect(readFileSync(join(destination, 'vault/workflow-inputs/original.csv'))).toEqual(csv);
    const book = decryptJson(targetKey, JSON.parse(readFileSync(join(destination, 'desk.json'), 'utf8'))) as typeof sourceBook;
    expect(book.office).toEqual(sourceBook.office); expect(book.hands).toBe('held'); expect(book.revision).toBe(sourceBook.revision + 1);
    const restored = new WorkflowDatabase({ dir: destination, key: targetKey });
    try {
      expect(restored.get('bank', bankRecord!.id)).toEqual(bankRecord!);
      expect(restored.count('bill-review-draft')).toBe(5001);
      for (const draft of drafts) expect(restored.get('bill-review-draft', draft.id)?.value).toEqual(draft.value);
    } finally { restored.close(); }
    const clocks = JSON.parse(readFileSync(join(destination, 'loops.json'), 'utf8'));
    expect(Object.values(clocks.state).every(value => !(value as { enabled: boolean }).enabled)).toBe(true);
    expect(readFileSync(join(destination, 'desk.key'))).toEqual(targetKey);
    const recaptured = await catalog(scratch, 'recaptured', targetKey, workspaceId);
    const options = { directory: destination, workspaceId, key: targetKey, catalog: recaptured, assertLease() {} };
    const again = await capturePrivateWorkspace(options); await verifyPrivateWorkspaceCapture(options, again); expect(recaptured.seal().records).toBe(5002);
    expect(existsSync(join(destination, 'private-workspace-restore-v2.json'))).toBe(false);
    await verifyRestoredBatchReader(destination, targetKey);
  // The coverage job re-runs this under v8 instrumentation on a hosted runner, about three times slower.
  }, process.env.CI ? 360_000 : 120_000);
});
