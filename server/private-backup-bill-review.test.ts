import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { createPrivateWorkspaceBackup, applyStagedPrivateRestore, PRIVATE_RESTORE_STAGE_FILE } from './private-workspace-backup.ts';
import { encryptJson, decryptJson, type EncryptedEnvelope } from './desk-crypto.ts';
import { emptyV3 } from '../shared/desk-v3.ts';
import { WorkflowDatabase } from './workflow-database.ts';
import { BillReviewDraftStore, BILL_REVIEW_DRAFT_KIND } from './bill-review-drafts.ts';
import { proposalBackupFixture } from './testing/proposal-backup-fixture.ts';
import { readBillProposal } from './bill-proposals.ts';
import type { BillReviewDraftValue } from '../shared/bill-review-drafts.ts';

const roots: string[] = [], phrase = 'Fictional encrypted review recovery phrase';
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(realpathSync(tmpdir()), 'RealBud draft backup ')); roots.push(directory);
  const key = randomBytes(32), workspaceId = randomUUID();
  await mkdir(join(directory, 'company-installation'), { mode: 0o700 });
  await writeFile(join(directory, 'company-installation/workspace.json'), JSON.stringify({ version: 1, id: workspaceId, workerMemberKey: null }), { mode: 0o600 });
  await writeFile(join(directory, 'desk.json'), JSON.stringify(encryptJson(key, emptyV3({ name: 'Fictional office', timezone: 'UTC', jurisdictions: [] }))), { mode: 0o600 });
  return { directory, key, workspaceId, service: createPrivateWorkspaceBackup({ directory, key: () => key, workspaceId, epoch: () => 'fixture', assertIdle: () => {}, assertFresh: () => {} }) };
}
function value(workspaceId: string): BillReviewDraftValue {
  return { workspaceId, state: 'saved', billId: null, billRevision: null, itemId: null, messageId: null, sourceDigest: null,
    fields: { propertyId: '', kind: 'Water', vendor: 'Fictional utilities', amount: '12.', invoiceDate: '2026-', dueDate: '', note: 'Unfinished 私人 notes\nKeep exact spacing.  ' },
    billState: 'hold', reason: 'Need the original invoice', seriesId: '', arrivalDate: '', proposalRequest: null };
}

describe('encrypted bill review recovery through private backup', () => {
  it('preserves unfinished fields, pre-dispatch IDs, historical intents and closed reviews across a different-key restore', async () => {
    const from = await fixture(), to = await fixture(), db = new WorkflowDatabase({ dir: from.directory, key: from.key });
    try {
      const drafts = new BillReviewDraftStore(db, { workspaceId: from.workspaceId });
      const ordinary = drafts.create(randomUUID(), null, value(from.workspaceId));
      const seed = await proposalBackupFixture(db, from.directory);
      const pending = drafts.create(randomUUID(), null, { ...value(from.workspaceId), itemId: seed.request.itemId, messageId: seed.request.messageId,
        sourceDigest: seed.request.expectedSourceDigest, proposalRequest: seed.request });
      const unsent = drafts.create(randomUUID(), null, { ...value(from.workspaceId), itemId: seed.request.itemId, messageId: seed.request.messageId,
        sourceDigest: seed.request.expectedSourceDigest, proposalRequest: { ...seed.request, requestId: randomUUID() } });
      const closed = drafts.update(ordinary.id, ordinary.revision, { ...value(from.workspaceId), state: 'discarded' });
      const { backup, receipt } = await from.service.exportBackup(phrase);
      expect(receipt.recordCount).toBe(4);
      await to.service.stageRestore({ backup, passphrase: phrase, expectedDigest: receipt.digest });
      await applyStagedPrivateRestore({ directory: to.directory, key: to.key });
      expect(to.key).not.toEqual(from.key);
      const restored = new WorkflowDatabase({ dir: to.directory, key: to.key });
      try {
        const store = new BillReviewDraftStore(restored, { workspaceId: from.workspaceId });
        for (const before of [pending, unsent, closed]) expect(store.get(before.id)).toEqual(before);
        expect(store.page().items.map(row => row.id).sort()).toEqual([pending.id, unsent.id].sort());
        expect(store.page({ filter: 'all' }).total).toBe(3);
        expect(readBillProposal({ database: () => restored, runs: () => [] }, pending.proposalRequest!.requestId)).toMatchObject({ state: 'intent-recorded', run: null, historical: true });
        expect(readBillProposal({ database: () => restored, runs: () => [] }, unsent.proposalRequest!.requestId)).toMatchObject({ state: 'not-recorded', run: null, historical: true });
        expect(restored.count('execution-job')).toBe(0);
        expect(restored.get('bill-proposal', seed.id)).toEqual(seed.record);
      } finally { restored.close(); }
    } finally { db.close(); }
  });

  it.each(['foreign workspace', 'extra approval', 'request binding', 'recomputed request binding', 'revision mismatch', 'array state', 'array bill state'])('rejects %s in a forged encrypted draft before preview or staging', async attack => {
    const from = await fixture(), to = await fixture(), db = new WorkflowDatabase({ dir: from.directory, key: from.key });
    try {
      const seed = await proposalBackupFixture(db, from.directory);
      new BillReviewDraftStore(db, { workspaceId: from.workspaceId }).create(randomUUID(), null, { ...value(from.workspaceId),
        itemId: seed.request.itemId, messageId: seed.request.messageId, sourceDigest: seed.request.expectedSourceDigest, proposalRequest: seed.request });
      const { backup } = await from.service.exportBackup(phrase);
      const passKey = scryptSync(phrase, Buffer.from(backup.salt, 'hex'), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      let forged;
      try {
        const snapshot = decryptJson(passKey, backup.payload) as { records: { kind: string; payload: EncryptedEnvelope }[] };
        const row = snapshot.records.find(row => row.kind === BILL_REVIEW_DRAFT_KIND)!;
        const saved = decryptJson(from.key, row.payload) as BillReviewDraftValue & { revision: number; sourceConfirmed?: boolean };
        if (attack === 'foreign workspace') saved.workspaceId = randomUUID();
        else if (attack === 'extra approval') saved.sourceConfirmed = true;
        else if (attack === 'revision mismatch') saved.revision++;
        else if (attack === 'array state') Object.assign(saved, { state: ['accepted'] });
        else if (attack === 'array bill state') Object.assign(saved, { billState: ['hold'] });
        else { saved.sourceDigest = 'f'.repeat(64); saved.proposalRequest!.expectedSourceDigest = saved.sourceDigest; }
        if (attack === 'recomputed request binding') {
          const intentRow = snapshot.records.find(record => record.kind === 'bill-proposal')!;
          const intent = decryptJson(from.key, intentRow.payload) as { payloadDigest: string };
          const request = saved.proposalRequest!;
          intent.payloadDigest = createHash('sha256').update(JSON.stringify([request.itemId, request.messageId, request.expectedSourceDigest])).digest('hex');
          intentRow.payload = encryptJson(from.key, intent);
        }
        row.payload = encryptJson(from.key, saved);
        forged = { ...backup, payload: encryptJson(passKey, snapshot) };
      } finally { passKey.fill(0); }
      const before = await readFile(join(to.directory, 'desk.json'));
      await expect(to.service.previewBackup(forged, phrase)).rejects.toThrow(/draft|review|recovery/i);
      const digest = createHash('sha256').update(JSON.stringify(forged)).digest('hex');
      await expect(to.service.stageRestore({ backup: forged, passphrase: phrase, expectedDigest: digest })).rejects.toThrow(/draft|review|recovery/i);
      expect(await readFile(join(to.directory, 'desk.json'))).toEqual(before);
      await expect(readFile(join(to.directory, PRIVATE_RESTORE_STAGE_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { db.close(); }
  });
});
