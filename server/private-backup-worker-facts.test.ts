/** Bud's learning across a private backup restored into a different installation key. Synthetic data only. */
import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { emptyV3 } from '../shared/desk-v3.ts';
import { encryptJson } from './desk-crypto.ts';
import { createPrivateWorkspaceBackup, applyStagedPrivateRestore } from './private-workspace-backup.ts';
import { PrivateBackupCatalog } from './private-backup-catalog.ts';
import { capturePrivateWorkspace, verifyPrivateWorkspaceCapture } from './private-backup-capture.ts';
import { encodeBackupCatalog, decodeBackupCatalog } from './private-backup-archive.ts';
import { transformPrivateBackupCatalog } from './private-backup-restore-catalog.ts';
import { PrivateBackupPreparedStore } from './private-backup-prepared.ts';
import { preparePrivateBackupRestore } from './private-backup-prepare.ts';
import { stagePrivateRestoreV2, applyStagedPrivateRestoreV2 } from './private-backup-cold-restore.ts';
import { plantPrivateFile, privateTempRoot, removeFixture, privateDir } from './testing/private-fixture.ts';
import { createHermesMemoryReviewService, type MemoryReviewContext } from './hermes-memory-review.ts';
import { OWNED_MEMORY_RUNTIME } from './hermes-memory-owned.ts';
import { MEMORY_LEARNING_API, MEMORY_REVIEW_API as api, type MemoryLearningState, type MemoryReviewPage, type MemoryReviewPreview } from '../shared/hermes-memory-review.ts';
import { MEMORY_RECOVERY_API } from '../shared/hermes-memory-recovery.ts';

const roots: string[] = [], catalogs: PrivateBackupCatalog[] = [], stores: PrivateBackupPreparedStore[] = [], services: ReturnType<typeof createHermesMemoryReviewService>[] = [];
const phrase = 'Fictional learning backup phrase', createdAt = '2026-10-08T00:00:00.000Z';
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
  for (const store of stores.splice(0)) await store.close();
  for (const catalog of catalogs.splice(0)) catalog.close();
  await Promise.all(roots.splice(0).map(path => removeFixture(path)));
});
const sorted = (v: Record<string, unknown>) => `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${JSON.stringify(v[k])}`).join(',')}}`;
const staged = (id: string, content: string) => JSON.stringify({ id, subsystem: 'memory', action: 'add', summary: 'Fictional', origin: 'background_review', created_at: 1_790_000_000, payload: { action: 'add', target: 'memory', content } });

async function installation(workspaceId = randomUUID()) {
  const directory = privateTempRoot(join(realpathSync(tmpdir()), 'RealBud learning backup ')); roots.push(directory);
  const key = randomBytes(32), plant = (path: string, data: string | Buffer) => plantPrivateFile(join(directory, path), Buffer.from(data));
  plant('company-installation/workspace.json', JSON.stringify({ version: 1, id: workspaceId, workerMemberKey: null }));
  plant('desk.json', JSON.stringify(encryptJson(key, emptyV3({ name: 'Fictional learning office', timezone: 'UTC', jurisdictions: [] }))));
  const backup = createPrivateWorkspaceBackup({ directory, key: () => key, workspaceId, epoch: () => 'fictional-idle', assertIdle() {}, assertFresh() {} });
  return { directory, key, workspaceId, backup, plant };
}
function service(at: Awaited<ReturnType<typeof installation>>, workspaceId: string) {
  const context: MemoryReviewContext = { profileDirectory: join(at.directory, 'hermes/profiles/property'), runtimeDirectory: '', workspaceId, profileId: 'property', runtimeId: OWNED_MEMORY_RUNTIME, python: '' };
  const created = createHermesMemoryReviewService({ context: () => context, key: () => at.key, dataDirectory: at.directory, autoReviewIntervalMs: 0 }); services.push(created);
  const decide = async (id: string, decision: 'approve' | 'reject') => {
    const review = (await created.handle(`${api}/${id}`, 'GET'))!.body as MemoryReviewPreview;
    return created.handle(`${api}/${id}/decision`, 'POST', { expectedDigest: review.reviewDigest, decision });
  };
  const list = async () => ((await created.handle(api, 'GET'))!.body as MemoryReviewPage).items.map(item => [item.id, item.state]).sort();
  const propose = () => created.proposalIntegration('fictional-chat', () => true)!.propose({ requestId: 'fictional-request', payload: { target: 'user', action: 'add', content: 'Fictional manager prefers calls.' } }, new AbortController().signal);
  return { service: created, decide, list, propose };
}
async function populate() {
  const source = await installation(), profile = 'hermes/profiles/property';
  source.plant(`${profile}/config.yaml`, 'memory:\n  write_approval: true\n'); source.plant(`${profile}/memories/MEMORY.md`, 'Prefers concise updates.');
  source.plant(`${profile}/pending/memory/0000000a.json`, staged('0000000a', 'Prefers weekly summaries.'));
  source.plant(`${profile}/pending/memory/0000000b.json`, staged('0000000b', 'Prefers fax.'));
  // A worker-planted secret: never stored, only fingerprinted, and named on the backup receipt.
  source.plant(`${profile}/pending/memory/0000000e.json`, staged('0000000e', 'Use api_key = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD"'));
  // A helper-era interrupted proposal journal, signed with this installation's derived key.
  const signing = createHmac('sha256', source.key).update(`realbud-memory-review-v1\0${source.workspaceId}\0property`).digest(), journalKey = `cccc0001${'d'.repeat(56)}`;
  source.plant(`${profile}/.realbud-memory-reviews/proposals/${journalKey}.json`, sorted({ ...JSON.parse(sorted({ version: 1, state: 'prepared', id: 'cccc0001', workspaceId: source.workspaceId, profileId: 'property', runtimeId: 'f97608f178d1ffeca59860195ab7da295f7c8e5f-fictional',
    scopeId: 'e'.repeat(64), requestKey: journalKey, requestDigest: 'f'.repeat(64), pendingDigest: '9'.repeat(64), createdAt: 1_790_000_000_000 })),
    mac: createHmac('sha256', signing).update(`realbud-memory-propose-v1\0${sorted({ version: 1, state: 'prepared', id: 'cccc0001', workspaceId: source.workspaceId, profileId: 'property', runtimeId: 'f97608f178d1ffeca59860195ab7da295f7c8e5f-fictional',
      scopeId: 'e'.repeat(64), requestKey: journalKey, requestDigest: 'f'.repeat(64), pendingDigest: '9'.repeat(64), createdAt: 1_790_000_000_000 })}`).digest('hex') }));
  const s = service(source, source.workspaceId);
  expect(await s.decide('0000000a', 'approve')).toMatchObject({ status: 200 }); expect(await s.decide('0000000b', 'reject')).toMatchObject({ status: 200 });
  const proposed = await s.propose();
  // An automatically kept learning that the restored office will undo.
  source.plant(`${profile}/pending/memory/0000000c.json`, staged('0000000c', 'Prefers a friendly sign-off'));
  expect((await s.service.handle(MEMORY_LEARNING_API, 'POST', { autoKeep: true }))?.status).toBe(200);
  await s.list();
  expect(((await s.service.handle(MEMORY_LEARNING_API, 'GET'))!.body as MemoryLearningState).kept).toHaveLength(1);
  return { source, proposed: proposed.id, journalKey, expected: [['0000000a', 'applied'], ['0000000b', 'rejected'], ['0000000c', 'applied'], [proposed.id, 'pending']].sort() };
}
async function restoreV2(source: Awaited<ReturnType<typeof installation>>, target: Awaited<ReturnType<typeof installation>>) {
  const scratch = privateTempRoot(join(realpathSync(tmpdir()), 'RealBud learning scratch ')); roots.push(scratch);
  const catalog = async (name: string, key: Buffer) => { const value = await PrivateBackupCatalog.create({ directory: join(scratch, name), key, workspaceId: source.workspaceId, maxEntries: 200, maxBytes: 32 * 1024 * 1024 }); catalogs.push(value); return value; };
  const captured = await catalog('captured', source.key), options = { directory: source.directory, key: source.key, workspaceId: source.workspaceId, catalog: captured, assertLease() {} };
  const capture = await capturePrivateWorkspace(options); await verifyPrivateWorkspaceCapture(options, capture);
  const parts: Buffer[] = []; for await (const part of encodeBackupCatalog(captured, { passphrase: phrase, createdAt, databasePresent: capture.databasePresent })) parts.push(Buffer.from(part));
  const archive = Buffer.concat(parts);
  async function* chunks() { for (let offset = 0; offset < archive.length; offset += 701) yield archive.subarray(offset, offset + 701); }
  const decoded = await decodeBackupCatalog(chunks(), { directory: join(scratch, 'decoded'), key: target.key, passphrase: phrase, expectedArchiveDigest: createHash('sha256').update(archive).digest('hex') });
  catalogs.push(decoded.catalog);
  const transformed = await catalog('transformed', target.key); transformPrivateBackupCatalog({ source: decoded.catalog, destination: transformed, at: 2000 });
  const directoryId = randomUUID(), parent = join(target.directory, 'private-backup-v2', 'prepared'); privateDir(parent);
  const prepared = await PrivateBackupPreparedStore.create({ directory: join(parent, directoryId), key: target.key, workspaceId: source.workspaceId }); stores.push(prepared);
  const summary = await preparePrivateBackupRestore({ directory: target.directory, key: target.key, source: transformed, prepared, databasePresent: capture.databasePresent, assertLease() {} }); await prepared.close();
  const stage = { directory: target.directory, key: target.key, directoryId, storeId: summary.storeId, workspaceId: source.workspaceId, expectedPreparedDigest: summary.digest,
    receipt: decoded.receipt, assertFresh() {}, assertIdle() {}, epoch: () => 'fictional-idle' };
  await stagePrivateRestoreV2(stage); expect((await applyStagedPrivateRestoreV2(stage)).restored).toBe(true);
  return decoded.receipt;
}

describe('learning restored into another installation key', () => {
  it.each(['v1', 'v2'] as const)('%s keeps decisions, history, pending work, interrupted journals and undo verifiable', async version => {
    const { source, proposed, journalKey, expected } = await populate(), target = await installation();
    expect(target.key.equals(source.key)).toBe(false);
    let excluded: string[];
    if (version === 'v1') {
      const { backup, receipt } = await source.backup.exportBackup(phrase); excluded = receipt.excluded;
      await target.backup.stageRestore({ backup, passphrase: phrase, expectedDigest: receipt.digest });
      expect((await applyStagedPrivateRestore({ directory: target.directory, key: target.key })).restored).toBe(true);
    } else excluded = (await restoreV2(source, target)).excluded;
    expect(excluded).toContain('1 item of Bud’s learning withheld: they looked like credentials, were unsafe or exceeded the storage limit, and only their fingerprints were kept');
    // The worker folder is never restored; no worker runtime is needed to review.
    const t = service(target, source.workspaceId);
    expect(await t.list()).toEqual(expected);
    expect(((await t.service.handle(MEMORY_RECOVERY_API, 'GET'))!.body as { items: { key: string; state: string }[] }).items).toEqual([expect.objectContaining({ key: journalKey, state: 'interrupted' })]);
    expect(await t.propose()).toMatchObject({ id: proposed });
    const kept = ((await t.service.handle(MEMORY_LEARNING_API, 'GET'))!.body as MemoryLearningState).kept; expect(kept).toHaveLength(1);
    expect(await t.service.handle(`${MEMORY_LEARNING_API}/${kept[0].reviewDigest}/undo`, 'POST', {})).toMatchObject({ status: 200, body: { result: 'undone' } });
    expect(await t.decide(proposed, 'approve')).toMatchObject({ status: 200, body: { state: 'applied' } });
    // The carried signing keys are re-encrypted for this installation and are never stored as plain text.
    const signing = await readFile(join(target.directory, 'company-installation/private/memory-signing.json'), 'utf8');
    expect(JSON.parse(signing)).not.toHaveProperty('keys');
  }, 60_000);
});

