import { afterEach, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { WorkflowDatabase } from './workflow-database.ts';
import { createPrivateWorkspaceBackup, applyStagedPrivateRestore } from './private-workspace-backup.ts';
import { encryptJson } from './desk-crypto.ts';
import { emptyV3 } from '../shared/desk-v3.ts';
import { latestRoutineResult, saveRoutineResult } from './routine-results.ts';
import type { RoutineResult } from '../shared/routine-result.ts';
import { plantPrivateFiles, privateTempRoot, removeFixture } from './testing/private-fixture.ts';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeFixture(root); });
function fixture() {
  const directory = privateTempRoot(join(realpathSync(tmpdir()), 'RealBud routine backup ')); roots.push(directory);
  const key = randomBytes(32), workspaceId = randomUUID();
  plantPrivateFiles([[join(directory, 'company-installation/workspace.json'), JSON.stringify({ version: 1, id: workspaceId, workerMemberKey: null })],
    [join(directory, 'desk.json'), JSON.stringify(encryptJson(key, emptyV3({ name: 'Fictional routine office', timezone: 'Australia/Brisbane', jurisdictions: [] })))]]);
  return { directory, key, service: createPrivateWorkspaceBackup({ directory, key: () => key, workspaceId, epoch: () => 'fixture', assertIdle: () => {}, assertFresh: () => {} }) };
}
it('restores the saved source scope, gaps and unchanged-result fingerprints under the destination encryption key', async () => {
  const from = fixture(), to = fixture(), phrase = 'Fictional routine recovery phrase';
  const original: RoutineResult = { version: 1, workflow: 'weekly-bills', runId: randomUUID(), accountId: 'fictional-mail', bindingRevision: 'fictional-binding',
    sourceReceiptId: randomUUID(), windowStartAt: 1, windowEndAt: 10, finishedAt: 20, status: 'partial',
    counts: { collected: 0, candidates: 0, prepared: 0, held: 0, pending: 0, changed: 1 }, findings: [], draftIds: [],
    gaps: ['Fictional provider coverage gap; this is not invoice absence.'], resultKey: 'a'.repeat(64), detail: 'Fictional saved internal review.', metrics: { elapsedMs: 3, modelCalls: 0 } };
  const db = new WorkflowDatabase({ dir: from.directory, key: from.key });
  try { saveRoutineResult(db, original); saveRoutineResult(db, { ...original, workflow: 'inbound-triage' }); } finally { db.close(); }
  const exported = await from.service.exportBackup(phrase);
  await to.service.stageRestore({ backup: exported.backup, passphrase: phrase, expectedDigest: exported.receipt.digest });
  await applyStagedPrivateRestore({ directory: to.directory, key: to.key });
  const restored = new WorkflowDatabase({ dir: to.directory, key: to.key });
  try {
    expect(latestRoutineResult(restored, 'weekly-bills')).toEqual(original);
    expect(latestRoutineResult(restored, 'inbound-triage')).toEqual({ ...original, workflow: 'inbound-triage' });
  } finally { restored.close(); }
});
