import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { emptyV3 } from '../shared/desk-v3.ts';
import type { PrivateWorkspaceBackup } from '../shared/private-workspace-backup.ts';
import { encryptJson, decryptJson, type EncryptedEnvelope } from './desk-crypto.ts';
import { WorkflowDatabase } from './workflow-database.ts';
import { BankReferenceStore, type SavedBankBatch } from './bank-reference-store.ts';
import type { BankReferenceDecision, BankReferenceUpload } from './bank-reference.ts';
import { createPrivateWorkspaceBackup, applyStagedPrivateRestore, PRIVATE_RESTORE_STAGE_FILE } from './private-workspace-backup.ts';
import { PrivateBackupCatalog, type CatalogRecord } from './private-backup-catalog.ts';
import { encodeBackupCatalog, decodeBackupCatalog, type BackupArchiveReceipt } from './private-backup-archive.ts';
import { encodePrivateBackupV2 } from './private-backup-codec.ts';
import { transformPrivateBackupCatalog } from './private-backup-restore-catalog.ts';
import { PrivateBackupPreparedStore } from './private-backup-prepared.ts';
import { preparePrivateBackupRestore } from './private-backup-prepare.ts';
import { stagePrivateRestoreV2, applyStagedPrivateRestoreV2, PRIVATE_RESTORE_V2_STAGE_FILE } from './private-backup-cold-restore.ts';
import { plantPrivateFiles, privateDir, privateTempRoot, removeFixture, windowsAdmissionTimeout } from './testing/private-fixture.ts';

const roots: string[] = [], catalogs: PrivateBackupCatalog[] = [], preparedStores: PrivateBackupPreparedStore[] = [];
const phrase = 'Fictional amendment backup passphrase', createdAt = '2026-09-22T00:00:00.000Z';
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
afterEach(async () => {
  for (const store of preparedStores.splice(0)) await store.close();
  for (const catalog of catalogs.splice(0)) catalog.close();
  await Promise.all(roots.splice(0).map(path => removeFixture(path)));
});
async function fixture() {
  const directory = privateTempRoot(join(realpathSync(tmpdir()), 'RealBud bank amendments ')); roots.push(directory);
  const key = randomBytes(32), workspaceId = randomUUID();
  const book = emptyV3({ name: 'Fictional amendment backup office', timezone: 'UTC', jurisdictions: [] });
  plantPrivateFiles([
    [join(directory, 'company-installation/workspace.json'), JSON.stringify({ version: 1, id: workspaceId, workerMemberKey: null })],
    [join(directory, 'desk.json'), JSON.stringify(encryptJson(key, book))],
    [join(directory, 'desk.key'), key],
  ]);
  const service = createPrivateWorkspaceBackup({ directory, key: () => key, workspaceId, epoch: () => 'fictional-idle', assertIdle() {}, assertFresh() {} });
  return { directory, key, workspaceId, book, service };
}
const upload = (): BankReferenceUpload => ({
  source: { filename: 'Fictional captured bank.csv', bytesBase64: Buffer.from('\uFEFFDate,Amount,Narrative,Reference,Extra\r\n2026-09-21,500.00,"Fictional café 🏡","old",保留\n2026-09-21,-1.00,Fee,,保留\r\n').toString('base64') },
  columns: { date: 'Date', amount: 'Amount', narrative: 'Narrative', reference: 'Reference' }, dateFormat: 'YYYY-MM-DD',
  rules: [{ propertyId: 'fictional-property', reference: '00127', aliases: ['Fictional'] }],
});
function amendment(revision: number, reference: string) {
  const { source: _source, ...mapping } = upload(); mapping.rules[0]!.reference = reference;
  return { revision, mapping, reason: `Fictional directory correction to ${reference}.` };
}
function decisions(value: SavedBankBatch, reason: string): BankReferenceDecision[] {
  return value.batch.rows.map((row, index) => index
    ? { rowId: row.id, action: 'keep', reason: 'Fictional fee reviewed and left unchanged.' }
    : { rowId: row.id, action: 'assign', propertyId: 'fictional-property', reason });
}
function populate(database: WorkflowDatabase) {
  const bank = new BankReferenceStore(database), first = bank.create(upload());
  const firstDecisions = decisions(first.value, 'Fictional initial reference confirmed.');
  const reviewed = bank.review(first.id, first.revision, firstDecisions);
  const request = amendment(reviewed.revision, '00234'), corrected = bank.amend(first.id, request);
  const correctedDecisions = decisions(corrected.value, 'Fictional corrected reference checked again.');
  const second = bank.review(corrected.id, corrected.revision, correctedDecisions);
  const pending = bank.amend(second.id, amendment(second.revision, '00345'));
  const rows = [bank.get(first.id), bank.get(second.id), bank.get(pending.id)];
  const original = bank.export(first.id, true), originalPrepared = bank.export(first.id), correctedPrepared = bank.export(second.id);
  const bytes = Buffer.from(upload().source.bytesBase64, 'base64');
  expect(original.originalBytesCaptured).toBe(true);
  expect(Buffer.from(original.bytesBase64, 'base64')).toEqual(bytes);
  expect(Buffer.from(originalPrepared.bytesBase64, 'base64')).toEqual(Buffer.from(bytes.toString('utf8').replace('"old"', '"00127"')));
  expect(Buffer.from(correctedPrepared.bytesBase64, 'base64')).toEqual(Buffer.from(bytes.toString('utf8').replace('"old"', '"00234"')));
  return { rows, original, originalPrepared, correctedPrepared, firstDecisions, correctedDecisions, request };
}
function verifyRestored(directory: string, key: Buffer, expected: ReturnType<typeof populate>) {
  const database = new WorkflowDatabase({ dir: directory, key });
  try {
    const bank = new BankReferenceStore(database), [first, corrected, pending] = expected.rows;
    expect(database.count('bank')).toBe(3);
    expect(expected.rows.map(row => bank.get(row.id))).toEqual(expected.rows);
    expect(bank.export(first!.id)).toEqual(expected.originalPrepared);
    expect(bank.export(corrected!.id)).toEqual(expected.correctedPrepared);
    for (const row of expected.rows) expect(bank.export(row.id, true)).toEqual(expected.original);
    expect(bank.get(first!.id).value.decisions).toEqual(expected.firstDecisions);
    expect(bank.get(corrected!.id).value.decisions).toEqual(expected.correctedDecisions);
    expect(bank.get(pending!.id).value.decisions).toBeUndefined();
    expect(bank.get(pending!.id).value.result).toBeUndefined();
    expect(() => bank.export(pending!.id)).toThrow(/Review every/);
    expect(bank.get(first!.id).value.supersededBy?.id).toBe(corrected!.id);
    expect(bank.get(corrected!.id).value.amends?.id).toBe(first!.id);
    expect(bank.get(corrected!.id).value.supersededBy?.id).toBe(pending!.id);
    expect(bank.get(pending!.id).value.amends?.id).toBe(corrected!.id);
    expect(bank.amend(first!.id, expected.request)).toEqual(corrected);
    expect(database.count('bank')).toBe(3);
    expect(() => bank.review(first!.id, first!.revision, expected.firstDecisions)).toThrow(/changed/);
  } finally { database.close(); }
}
async function newCatalog(f: Awaited<ReturnType<typeof fixture>>, name: string, base = true) {
  const catalog = await PrivateBackupCatalog.create({ directory: join(f.directory, name), key: f.key, workspaceId: f.workspaceId, maxEntries: 100, maxBytes: 8 * 1024 * 1024 }); catalogs.push(catalog);
  if (base) {
    catalog.addFile({ path: 'company-installation/workspace.json', encoding: 'bytes', data: await readFile(join(f.directory, 'company-installation/workspace.json')) });
    catalog.addFile({ path: 'desk.json', encoding: 'json', data: Buffer.from(JSON.stringify(f.book)) });
  }
  return catalog;
}
async function* chunks(bytes: Buffer) { for (let offset = 0; offset < bytes.length; offset += 701) yield bytes.subarray(offset, offset + 701); }
async function collect(stream: AsyncIterable<Uint8Array>) { const parts: Buffer[] = []; for await (const part of stream) parts.push(Buffer.from(part)); return Buffer.concat(parts); }

const faults = ['missing parent', 'missing successor', 'parent request digest', 'successor reason'] as const;
function broken(rows: ReturnType<typeof populate>['rows'], fault: typeof faults[number]): CatalogRecord[] {
  const records = structuredClone(rows).map(row => ({ ...row, kind: 'bank' }));
  if (fault === 'missing parent') records.shift();
  else if (fault === 'missing successor') records.pop();
  else if (fault === 'parent request digest') records[0]!.value.supersededBy!.requestDigest = '0'.repeat(64);
  else records[2]!.value.amends!.reason = 'A different amendment reason, with valid individual fields.';
  return records;
}
function forgedV1(backup: PrivateWorkspaceBackup, key: Buffer, records: CatalogRecord[]) {
  const passwordKey = scryptSync(phrase, Buffer.from(backup.salt, 'hex'), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  try {
    const snapshot = decryptJson(passwordKey, backup.payload) as { records: { id: string; kind: string; revision: number; payload: EncryptedEnvelope }[] };
    snapshot.records = records.map(row => ({ id: row.id, kind: row.kind, revision: row.revision, payload: encryptJson(key, row.value) }));
    return { ...backup, payload: encryptJson(passwordKey, snapshot) };
  } finally { passwordKey.fill(0); }
}

describe('bank amendment graph backup boundaries', () => {
  it('v1 restores both exact reviewed artifacts, decisions and links plus the unfinished successor under a different key', async () => {
    const source = await fixture(), target = await fixture(), database = new WorkflowDatabase({ dir: source.directory, key: source.key });
    expect(source.key.equals(target.key)).toBe(false);
    try {
      const expected = populate(database), { backup, receipt } = await source.service.exportBackup(phrase);
      expect(receipt.recordCount).toBe(3);
      expect((await target.service.stageRestore({ backup, passphrase: phrase, expectedDigest: receipt.digest })).needsRestart).toBe(true);
      expect((await applyStagedPrivateRestore({ directory: target.directory, key: target.key })).restored).toBe(true);
      verifyRestored(target.directory, target.key, expected);
      expect(await readFile(join(target.directory, 'desk.key'))).toEqual(target.key);
      expect(expected.rows.map(row => new BankReferenceStore(database).get(row.id))).toEqual(expected.rows);
    } finally { database.close(); }
  });

  it('v2 validates, archives and cold-restores the complete amendment chain under a different key', windowsAdmissionTimeout(95), async () => {
    const source = await fixture(), target = await fixture(), scratch = await fixture();
    const database = new WorkflowDatabase({ dir: source.directory, key: source.key });
    let expected: ReturnType<typeof populate>;
    try { expected = populate(database); } finally { database.close(); }
    expect(source.key.equals(target.key)).toBe(false);
    const catalog = await newCatalog(source, 'catalog');
    for (const row of expected.rows) catalog.addRecord({ ...row, kind: 'bank' });
    expect(catalog.validate()).toMatchObject({ records: 3, sealed: false });
    let exported: BackupArchiveReceipt | undefined;
    const archive = await collect(encodeBackupCatalog(catalog, { passphrase: phrase, createdAt, databasePresent: true, onComplete: receipt => { exported = receipt; } }));
    const decoded = await decodeBackupCatalog(chunks(archive), { directory: join(scratch.directory, 'decoded'), key: target.key, passphrase: phrase, expectedArchiveDigest: sha(archive) }); catalogs.push(decoded.catalog);
    expect(decoded.receipt).toEqual(exported!.receipt);
    expect(decoded.catalog.summary()).toMatchObject({ records: 3, sealed: true });
    expect([...decoded.catalog.iterateRecords('bank')]).toEqual(expected.rows.map(row => ({ ...row, kind: 'bank' })));
    const transformed = await newCatalog({ ...scratch, key: target.key, workspaceId: source.workspaceId }, 'transformed', false);
    transformPrivateBackupCatalog({ source: decoded.catalog, destination: transformed, at: 1000 });
    const directoryId = randomUUID(), parent = join(target.directory, 'private-backup-v2', 'prepared');
    privateDir(parent);
    const prepared = await PrivateBackupPreparedStore.create({ directory: join(parent, directoryId), key: target.key, workspaceId: source.workspaceId }); preparedStores.push(prepared);
    const summary = await preparePrivateBackupRestore({ directory: target.directory, key: target.key, source: transformed, prepared, databasePresent: true, assertLease() {} }); await prepared.close();
    const stage = { directory: target.directory, key: target.key, directoryId, storeId: summary.storeId, workspaceId: source.workspaceId, expectedPreparedDigest: summary.digest, receipt: decoded.receipt, assertFresh() {}, assertIdle() {}, epoch: () => 'fictional-idle' };
    expect((await stagePrivateRestoreV2(stage)).needsRestart).toBe(true);
    expect((await applyStagedPrivateRestoreV2(stage)).restored).toBe(true);
    verifyRestored(target.directory, target.key, expected);
    expect(await readFile(join(target.directory, 'desk.key'))).toEqual(target.key);
    expect(existsSync(join(target.directory, PRIVATE_RESTORE_V2_STAGE_FILE))).toBe(false);
  });

  it.each(faults)('v1 rejects a graph with %s before publishing a restore stage', async fault => {
    const source = await fixture(), target = await fixture(), database = new WorkflowDatabase({ dir: source.directory, key: source.key });
    try {
      const expected = populate(database), { backup } = await source.service.exportBackup(phrase);
      const forged = forgedV1(backup, source.key, broken(expected.rows, fault));
      const original = await readFile(join(target.directory, 'desk.json'));
      await expect(target.service.previewBackup(forged, phrase)).rejects.toThrow(/bank.*integrity/i);
      // The uploaded envelope has its own matching transport digest. A stale
      // upload digest must not be the reason the broken graph is refused.
      await expect(target.service.stageRestore({ backup: forged, passphrase: phrase, expectedDigest: sha(JSON.stringify(forged)) })).rejects.toThrow(/bank.*integrity/i);
      expect(await readFile(join(target.directory, 'desk.json'))).toEqual(original);
      expect(existsSync(join(target.directory, PRIVATE_RESTORE_STAGE_FILE))).toBe(false);
      expect(existsSync(join(target.directory, 'workflow-state.sqlite'))).toBe(false);
      expect(expected.rows.map(row => new BankReferenceStore(database).get(row.id))).toEqual(expected.rows);
    } finally { database.close(); }
  });

  it.each(faults)('v2 rejects %s during catalog seal and authenticated archive decode', async fault => {
    const source = await fixture(), target = await fixture(), database = new WorkflowDatabase({ dir: source.directory, key: source.key });
    let expected: ReturnType<typeof populate>;
    try { expected = populate(database); } finally { database.close(); }
    const catalog = await newCatalog(source, 'broken-catalog'), records = broken(expected.rows, fault);
    // Each record is individually valid; only the cross-record graph is wrong.
    for (const row of records) expect(() => catalog.addRecord(row)).not.toThrow();
    const before = catalog.summary();
    expect(() => catalog.validate()).toThrow(/bank.*integrity/i);
    expect(() => catalog.seal()).toThrow(/bank.*integrity/i);
    expect(catalog.summary()).toEqual(before);
    expect(catalog.summary().sealed).toBe(false);
    let emitted = 0, completed = false;
    const publish = async () => {
      for await (const bytes of encodeBackupCatalog(catalog, { passphrase: phrase, createdAt, databasePresent: true, onComplete: () => { completed = true; } })) emitted += bytes.length;
    };
    await expect(publish()).rejects.toThrow(/bank.*integrity/i);
    expect(emitted).toBe(0); expect(completed).toBe(false);
    expect([...catalog.iterateRecords('bank')]).toEqual(records);

    // Bypass catalog encoding only to simulate an authenticated uploaded archive
    // from another installation. The production decoder must still refuse it.
    const entries = [
      { name: 'realbud:metadata', bytes: Buffer.from(JSON.stringify({ version: 2, createdAt, workspaceId: source.workspaceId, databasePresent: true })) },
      ...[...catalog.iterateFiles()].map(file => ({ name: `file:${file.encoding}:${file.path}`, bytes: file.data })),
      ...records.map(row => ({ name: `record:${row.id}`, bytes: Buffer.from(JSON.stringify(row)) })),
    ];
    const archive = await collect(encodePrivateBackupV2(entries.map(entry => ({ name: entry.name, size: entry.bytes.length, data: chunks(entry.bytes) })), { passphrase: phrase }));
    const destination = join(target.directory, 'provisional'), targetBook = await readFile(join(target.directory, 'desk.json'));
    await expect(decodeBackupCatalog(chunks(archive), { directory: destination, key: target.key, passphrase: phrase, expectedArchiveDigest: sha(archive) })).rejects.toThrow(/bank.*integrity/i);
    const provisional = new DatabaseSync(join(destination, 'catalog.sqlite'), { readOnly: true });
    try {
      const row = provisional.prepare('SELECT payload FROM catalog_header WHERE id=1').get()!;
      expect(decryptJson(target.key, JSON.parse(String(row.payload)))).toMatchObject({ sealed: false, records: records.length });
    } finally { provisional.close(); }
    expect(await readFile(join(target.directory, 'desk.json'))).toEqual(targetBook);
    expect(existsSync(join(target.directory, PRIVATE_RESTORE_V2_STAGE_FILE))).toBe(false);
    verifyRestored(source.directory, source.key, expected);
  });
});
