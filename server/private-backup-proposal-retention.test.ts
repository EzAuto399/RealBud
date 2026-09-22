import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { createPrivateWorkspaceBackup, applyStagedPrivateRestore, PRIVATE_RESTORE_STAGE_FILE } from './private-workspace-backup.ts';
import { encryptJson, decryptJson, type EncryptedEnvelope } from './desk-crypto.ts';
import { emptyV3 } from '../shared/desk-v3.ts';
import { WorkflowDatabase } from './workflow-database.ts';
import { createBillProposals } from './bill-proposals.ts';
import { proposalBackupFixture } from './testing/proposal-backup-fixture.ts';

const roots: string[] = [], phrase = 'Fictional proposal retention backup phrase';
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(realpathSync(tmpdir()), 'RealBud proposal backup ')); roots.push(directory);
  const key = randomBytes(32), workspaceId = randomUUID();
  await mkdir(join(directory, 'company-installation'), { mode: 0o700 });
  await writeFile(join(directory, 'company-installation/workspace.json'), JSON.stringify({ version: 1, id: workspaceId, workerMemberKey: null }), { mode: 0o600 });
  await writeFile(join(directory, 'desk.json'), JSON.stringify(encryptJson(key, emptyV3({ name: 'Fictional office', timezone: 'UTC', jurisdictions: [] }))), { mode: 0o600 });
  return { directory, key, service: createPrivateWorkspaceBackup({ directory, key: () => key, workspaceId, epoch: () => 'fixture', assertIdle: () => {}, assertFresh: () => {} }) };
}

describe('retained invoice intents through private backup', () => {
  it('preserves 1,001 encrypted request identities and holds an old unfinished intent after different-key restore', async () => {
    const from = await fixture(), to = await fixture(), db = new WorkflowDatabase({ dir: from.directory, key: from.key });
    try {
      const seed = await proposalBackupFixture(db, from.directory), ids = [seed.id];
      for (let i = 1; i < 1_001; i++) {
        const id = `bill-proposal:${randomUUID()}`; ids.push(id);
        db.create('bill-proposal', id, seed.record.value, null);
      }
      const { backup, receipt } = await from.service.exportBackup(phrase);
      expect(receipt.recordCount).toBe(1_001);
      await to.service.stageRestore({ backup, passphrase: phrase, expectedDigest: receipt.digest });
      await applyStagedPrivateRestore({ directory: to.directory, key: to.key });
      const restored = new WorkflowDatabase({ dir: to.directory, key: to.key });
      try {
        expect(to.key).not.toEqual(from.key);
        expect(restored.count('bill-proposal')).toBe(1_001);
        for (const id of ids) expect(restored.get('bill-proposal', id)?.value).toEqual(seed.record.value);
        expect(restored.get('bill-proposal', seed.id)).toEqual(seed.record);
        const execute = vi.fn(seed.options.execute);
        const retry = createBillProposals({ ...seed.options, database: () => restored, workroom: join(to.directory, 'vault'), execute });
        // Fictional source and authority callbacks establish domain replay only;
        // restore does not reconnect an account or approve its live setup.
        await expect(retry(seed.request)).rejects.toThrow(/earlier preparation stopped/);
        await expect(retry({ ...seed.request, messageId: 'ab13' })).rejects.toMatchObject({ status: 409 });
        expect(execute).not.toHaveBeenCalled();
        expect(restored.get('bill-proposal', seed.id)).toEqual(seed.record);
        await expect(readFile(join(to.directory, 'vault/workflow-inputs/accounts-invoices.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      } finally { restored.close(); }
    } finally { db.close(); }
  });

  it.each(['file scope', 'source binding', 'extra document'])('rejects a forged proposal %s before preview or staging without replacing target bytes', async attack => {
    const from = await fixture(), to = await fixture(), db = new WorkflowDatabase({ dir: from.directory, key: from.key });
    try {
      await proposalBackupFixture(db, from.directory);
      const { backup } = await from.service.exportBackup(phrase);
      const passKey = scryptSync(phrase, Buffer.from(backup.salt, 'hex'), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      let forged;
      try {
        const snapshot = decryptJson(passKey, backup.payload) as { records: { kind: string; payload: EncryptedEnvelope }[] };
        const row = snapshot.records.find(row => row.kind === 'bill-proposal')!;
        const saved = decryptJson(from.key, row.payload) as { input: { allowedAttachmentPaths: string[]; sourceReference: string; documents: unknown[] } };
        if (attack === 'file scope') saved.input.allowedAttachmentPaths = ['/fictional/outside-workspace.pdf'];
        else if (attack === 'source binding') saved.input.sourceReference = `realbud-bill:${'f'.repeat(64)}`;
        else saved.input.documents.push(structuredClone(saved.input.documents[0]));
        row.payload = encryptJson(from.key, saved);
        forged = { ...backup, payload: encryptJson(passKey, snapshot) };
      } finally { passKey.fill(0); }
      const before = await readFile(join(to.directory, 'desk.json'));
      await expect(to.service.previewBackup(forged, phrase)).rejects.toThrow(/invoice|proposal|receipt|recovery/i);
      const digest = createHash('sha256').update(JSON.stringify(forged)).digest('hex');
      await expect(to.service.stageRestore({ backup: forged, passphrase: phrase, expectedDigest: digest })).rejects.toThrow(/invoice|proposal|receipt|recovery/i);
      expect(await readFile(join(to.directory, 'desk.json'))).toEqual(before);
      await expect(readFile(join(to.directory, PRIVATE_RESTORE_STAGE_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { db.close(); }
  });
});
