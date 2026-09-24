import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { createPrivateWorkspaceBackup, applyStagedPrivateRestore } from './private-workspace-backup.ts';
import { encryptJson, decryptJson, type EncryptedEnvelope } from './desk-crypto.ts';
import { emptyV3 } from '../shared/desk-v3.ts';
import { WorkflowDatabase } from './workflow-database.ts';
import { BankReferenceStore, type SavedBankBatch } from './bank-reference-store.ts';
import { bankDigest, createBankReferenceBatch, type BankReferenceUpload } from './bank-reference.ts';
import { plantPrivateFiles, privateTempRoot, removeFixture } from './testing/private-fixture.ts';

const roots: string[] = [], phrase = 'Fictional bank retention backup phrase';
afterEach(async () => { await Promise.all(roots.splice(0).map(root => removeFixture(root))); });
async function fixture() {
  const directory = privateTempRoot(join(realpathSync(tmpdir()), 'RealBud bank backup ')); roots.push(directory);
  const key = randomBytes(32), workspaceId = randomUUID();
  plantPrivateFiles([
    [join(directory, 'company-installation/workspace.json'), JSON.stringify({ version: 1, id: workspaceId, workerMemberKey: null })],
    [join(directory, 'desk.json'), JSON.stringify(encryptJson(key, emptyV3({ name: 'Fictional bank retention office', timezone: 'UTC', jurisdictions: [] })))],
  ]);
  return { directory, key, service: createPrivateWorkspaceBackup({ directory, key: () => key, workspaceId, epoch: () => 'fixture', assertIdle: () => {}, assertFresh: () => {} }) };
}
function upload(index: number): BankReferenceUpload {
  const csv = `\uFEFFDate,Amount,Description,Reference,Extra\r\n21/09/2026,120.00,"Fictional café 🏡 ${index}","old",保留\r\n`;
  return { source: { filename: `fictional-${index}.csv`, bytesBase64: Buffer.from(csv).toString('base64') }, columns: { date: 'Date', amount: 'Amount', narrative: 'Description', reference: 'Reference' }, dateFormat: 'DD/MM/YYYY', rules: [{ propertyId: 'fictional-property', reference: '00012', aliases: ['Fictional'] }] };
}

describe('retained bank history through private backup', () => {
  it('retains the actual legacy quoted-reference output without rewriting its historical bytes', async () => {
    const from = await fixture(), to = await fixture();
    const database = new WorkflowDatabase({ dir: from.directory, key: from.key });
    try {
      const { source, ...mapping } = upload(0), csv = Buffer.from(source.bytesBase64, 'base64').toString('utf8');
      const batch = createBankReferenceBatch({ ...mapping, csv });
      // The pre-byte-capture v1 writer (checked-in HEAD) removed original
      // reference quotes when the replacement itself did not need quoting.
      const prepared = csv.replace('"old"', '00012');
      const id = `bank:${batch.originalDigest}`;
      database.create('bank', id, { version: 1, createdAt: 1, batch });
      database.update('bank', id, 1, value => ({ ...(value as object), reviewedAt: 2, result: { csv: prepared, originalDigest: batch.originalDigest, outputDigest: bankDigest(prepared), changes: [{ rowId: batch.rows[0].id, from: 'old', to: '00012', reason: 'Fictional legacy review' }] } }));
      const { backup, receipt } = await from.service.exportBackup(phrase);
      await to.service.stageRestore({ backup, passphrase: phrase, expectedDigest: receipt.digest });
      await applyStagedPrivateRestore({ directory: to.directory, key: to.key });
      const restoredDatabase = new WorkflowDatabase({ dir: to.directory, key: to.key });
      try {
        const artifact = new BankReferenceStore(restoredDatabase).export(id);
        expect(artifact.originalBytesCaptured).toBe(false);
        expect(Buffer.from(artifact.bytesBase64, 'base64')).toEqual(Buffer.from(prepared));
        expect(artifact.digest).toBe(bankDigest(prepared));
      } finally { restoredDatabase.close(); }
    } finally { database.close(); }
  });

  it.each(['saved row facts', 'prepared non-reference bytes'])('rejects forged %s before restore despite matching uploaded hashes', async kind => {
    const from = await fixture(), to = await fixture();
    const database = new WorkflowDatabase({ dir: from.directory, key: from.key });
    try {
      const bank = new BankReferenceStore(database), batch = bank.create(upload(0));
      bank.review(batch.id, batch.revision, [{ rowId: batch.value.batch.rows[0].id, action: 'assign', propertyId: 'fictional-property', reason: 'Fictional review' }]);
      const { backup, receipt } = await from.service.exportBackup(phrase);
      const passKey = scryptSync(phrase, Buffer.from(backup.salt, 'hex'), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      let forged;
      try {
        const snapshot = decryptJson(passKey, backup.payload) as { records: { kind: string; payload: EncryptedEnvelope }[] };
        const row = snapshot.records.find(row => row.kind === 'bank')!;
        const saved = decryptJson(from.key, row.payload) as SavedBankBatch;
        if (kind === 'saved row facts') saved.batch.rows[0].amount = '999.00';
        else {
          const csv = saved.result!.csv.replace('120.00', '999.00'), bytes = Buffer.from(csv);
          saved.result = { ...saved.result!, csv, bytesBase64: bytes.toString('base64'), byteLength: bytes.length, outputDigest: bankDigest(bytes) };
        }
        row.payload = encryptJson(from.key, saved);
        forged = { ...backup, payload: encryptJson(passKey, snapshot) };
      } finally { passKey.fill(0); }
      const before = await readFile(join(to.directory, 'desk.json'));
      await expect(to.service.previewBackup(forged, phrase)).rejects.toThrow(/bank|source|prepared|integrity|recovery/i);
      await expect(to.service.stageRestore({ backup: forged, passphrase: phrase, expectedDigest: receipt.digest })).rejects.toThrow(/bank|source|prepared|integrity|recovery/i);
      expect(await readFile(join(to.directory, 'desk.json'))).toEqual(before);
      await expect(readFile(join(to.directory, 'private-workspace-restore.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { database.close(); }
  });

  it('restores 501 retained batch identities and exact old reviewed bytes under a different key', async () => {
    const from = await fixture(), to = await fixture();
    const database = new WorkflowDatabase({ dir: from.directory, key: from.key });
    try {
      const bank = new BankReferenceStore(database), oldest = bank.create(upload(0));
      const reviewed = bank.review(oldest.id, oldest.revision, [{ rowId: oldest.value.batch.rows[0].id, action: 'assign', propertyId: 'fictional-property', reason: 'Fictional original transaction and property confirmed' }]);
      // Commit the synthetic history before exercising the real backup and restore paths.
      database.transaction(() => { for (let index = 1; index < 501; index++) bank.create(upload(index)); });
      expect(database.count('bank')).toBe(501);
      const original = bank.export(oldest.id, true), prepared = bank.export(oldest.id);
      expect(Buffer.from(prepared.bytesBase64, 'base64')).toEqual(Buffer.from(Buffer.from(upload(0).source.bytesBase64, 'base64').toString('utf8').replace('"old"', '"00012"')));
      const { backup, receipt } = await from.service.exportBackup(phrase);
      expect(receipt.recordCount).toBe(501);
      await to.service.stageRestore({ backup, passphrase: phrase, expectedDigest: receipt.digest });
      await applyStagedPrivateRestore({ directory: to.directory, key: to.key });
      const restoredDatabase = new WorkflowDatabase({ dir: to.directory, key: to.key });
      try {
        const restored = new BankReferenceStore(restoredDatabase);
        expect(restoredDatabase.count('bank')).toBe(501);
        expect(restored.get(oldest.id)).toEqual(reviewed);
        expect(restored.export(oldest.id, true)).toEqual(original);
        expect(restored.export(oldest.id)).toEqual(prepared);
        expect(restored.create(upload(0))).toEqual(reviewed);
        expect(restoredDatabase.count('bank')).toBe(501);
        expect(() => restored.create({ ...upload(0), rules: [] })).toThrow(/different mapping/);
        expect(() => restored.review(oldest.id, oldest.revision, [])).toThrow(/changed/);
        expect(restored.get(oldest.id)).toEqual(reviewed);
      } finally { restoredDatabase.close(); }
    } finally { database.close(); }
  }, 30_000);
});
