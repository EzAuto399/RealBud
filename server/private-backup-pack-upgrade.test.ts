import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import type { CustomerPack, CustomerPackChangePreview, CustomerPackArchivePreview, CustomerPackArchivedHistory } from '../shared/customer-packs.ts';
import type { PrivateWorkspaceBackup } from '../shared/private-workspace-backup.ts';
import { emptyV3 } from '../shared/desk-v3.ts';
import { encryptJson, decryptJson } from './desk-crypto.ts';
import { createPrivateWorkspaceBackup, applyStagedPrivateRestore, PRIVATE_RESTORE_STAGE_FILE } from './private-workspace-backup.ts';
import { PrivateBackupCatalog } from './private-backup-catalog.ts';
import { capturePrivateWorkspace, verifyPrivateWorkspaceCapture } from './private-backup-capture.ts';
import { encodeBackupCatalog, decodeBackupCatalog, type BackupArchiveReceipt } from './private-backup-archive.ts';
import { transformPrivateBackupCatalog } from './private-backup-restore-catalog.ts';
import { PrivateBackupPreparedStore } from './private-backup-prepared.ts';
import { preparePrivateBackupRestore } from './private-backup-prepare.ts';
import { stagePrivateRestoreV2, applyStagedPrivateRestoreV2, PRIVATE_RESTORE_V2_STAGE_FILE } from './private-backup-cold-restore.ts';

// The real recipe writer uses process-local DATA_DIR. Each simulated restart
// imports fresh modules with its own disposable installation path; persistence,
// approval resets and pack transitions are never mocked.
const environment = vi.hoisted(() => {
  const previous = process.env.REALBUD_DATA_DIR;
  process.env.REALBUD_DATA_DIR = `${process.env.TMPDIR ?? '/tmp'}/rb-pack-backup-unopened-${process.pid}-${Date.now()}`;
  return { previous, guard: process.env.REALBUD_DATA_DIR };
});
const roots: string[] = [], catalogs: PrivateBackupCatalog[] = [], preparedStores: PrivateBackupPreparedStore[] = [];
const phrase = 'Fictional pack history backup phrase', createdAt = '2026-09-22T00:00:00.000Z';
const mainId = 'wf-fictional-current', oldId = 'wf-fictional-retired', newId = 'wf-fictional-new';
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
afterEach(async () => {
  for (const store of preparedStores.splice(0)) await store.close();
  for (const catalog of catalogs.splice(0)) catalog.close();
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
afterAll(async () => {
  if (environment.previous === undefined) delete process.env.REALBUD_DATA_DIR;
  else process.env.REALBUD_DATA_DIR = environment.previous;
  await rm(environment.guard, { recursive: true, force: true });
});
async function privateFile(directory: string, path: string, data: string | Uint8Array) {
  await mkdir(dirname(join(directory, path)), { recursive: true, mode: 0o700 });
  await writeFile(join(directory, path), data, { mode: 0o600 });
}
async function fixture() {
  const directory = await mkdtemp(join(realpathSync(tmpdir()), 'RealBud pack backup Ω ')); roots.push(directory);
  const key = randomBytes(32), workspaceId = randomUUID();
  const book = emptyV3({ name: 'Fictional pack history office', timezone: 'Australia/Brisbane', jurisdictions: [] });
  book.bookProposals.push({ id: randomUUID(), kind: 'add-property', status: 'open', origin: 'manual',
    fields: { address: 'Fictional 12 Example Street', tenantName: 'Fictional resident', tenantPhone: '', weeklyRentCents: 45000 }, createdAt: 1000 });
  await privateFile(directory, 'company-installation/workspace.json', JSON.stringify({ version: 1, id: workspaceId, workerMemberKey: null }));
  await privateFile(directory, 'desk.json', JSON.stringify(encryptJson(key, book)));
  await privateFile(directory, 'desk.key', key);
  const backup = createPrivateWorkspaceBackup({ directory, key: () => key, workspaceId, epoch: () => 'fictional-idle', assertIdle() {}, assertFresh() {} });
  return { directory, key, workspaceId, book, backup };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function openPack(directory: string) {
  process.env.REALBUD_DATA_DIR = directory;
  vi.resetModules();
  const recipes = await import('./recipes.ts'), packs = await import('./customer-packs.ts');
  const options = { directory, profileDirectory: () => join(directory, 'profile'), workroomDirectory: () => join(directory, 'vault'),
    activeRecipeIds: () => [], learningStatus: () => ({ supported: true, policyReady: true, enabled: true }) };
  return { recipes, options, service: packs.createCustomerPackService(options), create: packs.createCustomerPackService };
}
function initialPack(): CustomerPack {
  const recipe: CustomerPack['recipes'][number] = { id: mainId, title: 'Fictional source review', description: 'Published operating note.',
    steps: ['Read the supplied fictional source.'], evidence: 'Source references.', capabilities: ['read-files', 'analyse', 'draft'],
    limits: { maxRuntimeMinutes: 2, maxTurns: 6 }, siteNotes: 'Published site note.', schedule: null, allowedOrigins: [] };
  const skill: CustomerPack['skills'][number] = { id: 'fictional-guidance', name: 'Fictional guidance', description: 'Review fictional supplied sources.',
    instructions: '# Fictional guidance\nRead the source first.\n', license: 'Fictional test license.' };
  return { format: 'realbud-customer-pack', version: 1, id: 'fictional-office', revision: 1, title: 'Fictional office workflow',
    recipes: [recipe, { ...recipe, id: oldId, title: 'Fictional earlier optional task' }],
    skills: [skill, { ...skill, id: 'earlier-guidance', name: 'Fictional earlier guidance' }],
    workflows: [{ id: 'sources', title: 'Review fictional source coverage', recipeIds: [mainId, oldId], checks: ['input-coverage'] }],
    dependencies: { runtime: 'hermes-property', mode: 'supplied-source-preparation', schedules: 'off', permissions: 'local-review-required' } };
}
const request = (preview: CustomerPackChangePreview) => ({ pack: preview.pack, expectedInstalledDigest: preview.installedDigest,
  expectedInstalledRevision: preview.installedRevision, expectedDigest: preview.digest, expectedPreviewDigest: preview.previewDigest });
const journalAt = async (directory: string) => JSON.parse(await readFile(join(directory, 'customer-packs.json'), 'utf8'));
const nativePath = (directory: string, skill = 'fictional-guidance') => join(directory, `profile/skills/realbud-fictional-office-${skill}/SKILL.md`);
async function populate(f: Fixture, interrupted = false) {
  const host = await openPack(f.directory), initial = initialPack(), first = await host.service.preview(initial);
  await host.service.install(initial, first.digest);
  const current = host.recipes.getRecipe(mainId)!;
  host.recipes.saveRecipe({ ...current, description: 'Staff note saved before upgrade.', expectedRevision: current.revision });
  const native = await readFile(nativePath(f.directory), 'utf8');
  const next = structuredClone(initial); next.revision = 2;
  next.recipes = [{ ...next.recipes[0], steps: ['Read the source and state missing facts.'], siteNotes: null },
    { ...next.recipes[0], id: newId, title: 'Fictional added optional task' }];
  next.workflows[0].recipeIds = [mainId, newId];
  next.skills = [next.skills[0]]; next.skills[0].instructions += 'Record uncertainty.\n';
  const preview = await host.service.previewUpgrade(next); expect(preview.canApply).toBe(true);
  if (interrupted) {
    const failing = host.create({ ...host.options, resetRecipeApprovals: expected => {
      host.recipes.resetRecipeApprovalsAtomically(expected);
      throw new Error('Fictional interruption after actual persisted approval reset');
    } });
    await expect(failing.upgrade(request(preview))).rejects.toThrow(/Fictional interruption/);
    expect(await readFile(nativePath(f.directory), 'utf8')).toBe(native);
  } else {
    expect(await host.service.upgrade(request(preview))).toMatchObject({ revision: 2, installationRevision: 2, localReady: true });
    const saved = host.recipes.getRecipe(mainId)!;
    host.recipes.saveRecipe({ ...saved, title: 'Latest staff title after upgrade', schedule: { time: '08:00', weekdays: [1] }, status: 'active', expectedRevision: saved.revision });
    host.recipes.patchRecipe(mainId, { planApproved: true, expectedRevision: host.recipes.getRecipe(mainId)!.revision });
    await expect(host.service.assertReadyForRecipe(oldId)).rejects.toThrow(/retired/);
  }
  const businessNote = Buffer.from('Fictional business evidence — 保留 exactly.\r\n');
  await privateFile(f.directory, 'vault/properties/fictional-property.md', businessNote);
  return { host, initial, next, native, journal: await journalAt(f.directory), recipes: host.recipes.loadRecipes(true), businessNote };
}
type Populated = Awaited<ReturnType<typeof populate>>;
async function catalog(f: Fixture, name: string, key = f.key, workspaceId = f.workspaceId) {
  const value = await PrivateBackupCatalog.create({ directory: join(f.directory, name), key, workspaceId, maxEntries: 100, maxBytes: 8 * 1024 * 1024 });
  catalogs.push(value); return value;
}
async function* chunks(bytes: Buffer) { for (let offset = 0; offset < bytes.length; offset += 701) yield bytes.subarray(offset, offset + 701); }
async function collect(stream: AsyncIterable<Uint8Array>) { const parts: Buffer[] = []; for await (const part of stream) parts.push(Buffer.from(part)); return Buffer.concat(parts); }
async function restoreV2(source: Fixture, target: Fixture, expected: Pick<Populated, 'journal'>) {
  const scratch = await fixture(), captured = await catalog(scratch, 'captured', source.key, source.workspaceId);
  const captureOptions = { directory: source.directory, key: source.key, workspaceId: source.workspaceId, catalog: captured, assertLease() {} };
  const capture = await capturePrivateWorkspace(captureOptions); await verifyPrivateWorkspaceCapture(captureOptions, capture);
  expect(JSON.parse(captured.getFile('customer-packs.json')!.data.toString())).toEqual(expected.journal);
  expect([...captured.iterateFiles()].every(file => !file.path.startsWith('profile/'))).toBe(true);
  let exported: BackupArchiveReceipt | undefined;
  const archive = await collect(encodeBackupCatalog(captured, { passphrase: phrase, createdAt, databasePresent: capture.databasePresent, onComplete: receipt => { exported = receipt; } }));
  const decoded = await decodeBackupCatalog(chunks(archive), { directory: join(scratch.directory, 'decoded'), key: target.key, passphrase: phrase, expectedArchiveDigest: sha(archive) });
  catalogs.push(decoded.catalog); expect(decoded.receipt).toEqual(exported!.receipt);
  const transformed = await catalog(scratch, 'transformed', target.key, source.workspaceId);
  transformPrivateBackupCatalog({ source: decoded.catalog, destination: transformed, at: 2000 });
  const directoryId = randomUUID(), parent = join(target.directory, 'private-backup-v2', 'prepared');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const prepared = await PrivateBackupPreparedStore.create({ directory: join(parent, directoryId), key: target.key, workspaceId: source.workspaceId }); preparedStores.push(prepared);
  const summary = await preparePrivateBackupRestore({ directory: target.directory, key: target.key, source: transformed, prepared, databasePresent: capture.databasePresent, assertLease() {} }); await prepared.close();
  const stage = { directory: target.directory, key: target.key, directoryId, storeId: summary.storeId, workspaceId: source.workspaceId,
    expectedPreparedDigest: summary.digest, receipt: decoded.receipt, assertFresh() {}, assertIdle() {}, epoch: () => 'fictional-idle' };
  expect((await stagePrivateRestoreV2(stage)).needsRestart).toBe(true);
  expect((await applyStagedPrivateRestoreV2(stage)).restored).toBe(true);
  expect(existsSync(join(target.directory, PRIVATE_RESTORE_V2_STAGE_FILE))).toBe(false);
}
async function verifyAndRollback(source: Fixture, target: Fixture, expected: Populated) {
  expect(await journalAt(target.directory)).toEqual(expected.journal);
  expect(await readFile(join(target.directory, 'desk.key'))).toEqual(target.key);
  expect(await readFile(join(target.directory, 'vault/properties/fictional-property.md'))).toEqual(expected.businessNote);
  const restoredBook = decryptJson(target.key, JSON.parse(await readFile(join(target.directory, 'desk.json'), 'utf8'))) as typeof source.book;
  expect(restoredBook).toEqual({ ...source.book, revision: source.book.revision + 1, hands: 'held',
    handsDetail: 'Private workspace restored. Reconnect sources and review work before running.' });
  const bookBytes = await readFile(join(target.directory, 'desk.json'));
  const restored = await openPack(target.directory), saved = restored.recipes.loadRecipes(true);
  expect(saved).toHaveLength(expected.recipes.length);
  for (const previous of expected.recipes) {
    const row = saved.find(recipe => recipe.id === previous.id)!;
    expect(row).toEqual({ ...previous, revision: previous.revision + 1, updatedAt: row.updatedAt, status: 'paused', schedule: null,
      planApprovedAt: null, approvedRevision: null, attachment: null, submitAcknowledgedAt: null });
  }
  const prior = expected.journal.installs[expected.initial.id].history[0];
  expect(prior.recipes.find((recipe: { id: string }) => recipe.id === mainId).description).toBe('Staff note saved before upgrade.');
  expect(saved.find(recipe => recipe.id === mainId)).toMatchObject({ title: 'Latest staff title after upgrade', description: 'Staff note saved before upgrade.' });
  expect(existsSync(join(target.directory, 'profile'))).toBe(false);
  expect((await restored.service.list()).installations[0]).toMatchObject({ revision: 2, installationRevision: 2, localReady: false, retiredRecipes: [oldId] });
  await expect(restored.service.assertReadyForRecipe(oldId)).rejects.toThrow(/retired/);
  // Native Hermes installations are deliberately excluded from the backup.
  // Recreate only the missing pack-owned instructions via the real repair path.
  const repaired = await restored.service.handle(`/api/customer-packs/${expected.initial.id}/repair`, 'POST', { expectedDigest: expected.journal.installs[expected.initial.id].digest });
  expect(repaired).toMatchObject({ status: 200, body: { localReady: true, revision: 2, installationRevision: 2 } });
  expect(restored.recipes.loadRecipes(true)).toEqual(saved);
  expect((await journalAt(target.directory)).installs[expected.initial.id].history).toEqual(expected.journal.installs[expected.initial.id].history);
  await expect(restored.service.assertReadyForRecipe(oldId)).rejects.toThrow(/retired/);
  const reply = await restored.service.handle(`/api/customer-packs/${expected.initial.id}/rollback-preview`, 'POST', { installationRevision: 1 });
  expect(reply?.status).toBe(200); const preview = reply!.body as CustomerPackChangePreview;
  expect(preview.canApply, preview.conflicts.join(' ')).toBe(true);
  expect(preview.recipes.find(recipe => recipe.id === mainId)?.after).toMatchObject({ title: 'Latest staff title after upgrade', description: 'Staff note saved before upgrade.' });
  const { pack: _pack, ...checked } = request(preview);
  const body = { ...checked, packId: expected.initial.id, installationRevision: 1 };
  const complete = await restored.service.rollback(body);
  expect(complete).toMatchObject({ revision: 1, installationRevision: 3, localReady: true, retiredRecipes: [newId] });
  expect(complete.history?.map(item => item.installationRevision)).toEqual([1, 2]);
  expect(restored.recipes.getRecipe(mainId)).toMatchObject({ title: 'Latest staff title after upgrade', description: 'Staff note saved before upgrade.',
    steps: expected.initial.recipes[0].steps, status: 'shadow', schedule: null, approvedRevision: null, planApprovedAt: null });
  await expect(restored.service.assertReadyForRecipe(newId)).rejects.toThrow(/retired/);
  await expect(restored.service.assertReadyForRecipe(oldId)).resolves.toBeUndefined();
  expect(restored.recipes.getRecipe(oldId)).toMatchObject({ status: 'shadow', schedule: null, approvedRevision: null });
  expect(restored.recipes.getRecipe(newId)).toMatchObject({ ...saved.find(recipe => recipe.id === newId)!,
    revision: saved.find(recipe => recipe.id === newId)!.revision + 1, updatedAt: expect.any(Number),
    status: 'shadow', schedule: null, approvedRevision: null, planApprovedAt: null });
  expect(restored.recipes.loadRecipes(true)).toHaveLength(expected.recipes.length);
  expect(await readFile(nativePath(target.directory), 'utf8')).toBe(expected.native);
  expect(await readFile(nativePath(target.directory, 'earlier-guidance'), 'utf8')).toContain('Pack fictional-office, revision 1.');
  expect(await readFile(join(target.directory, 'vault/workflow-support/earlier-guidance/SKILL.md'), 'utf8')).toBe(expected.initial.skills[1].instructions);
  const after = restored.recipes.loadRecipes(true), journal = await journalAt(target.directory);
  expect(journal.installs[expected.initial.id].history[0]).toEqual(prior);
  expect(journal.installs[expected.initial.id].history[1].recipes.find((recipe: { id: string }) => recipe.id === mainId).title).toBe('Latest staff title after upgrade');
  const reopened = await openPack(target.directory);
  expect(await reopened.service.rollback(body)).toEqual(complete);
  expect(reopened.recipes.loadRecipes(true)).toEqual(after); expect(await journalAt(target.directory)).toEqual(journal);
  expect(await readFile(join(target.directory, 'desk.json'))).toEqual(bookBytes);
  expect(await readFile(join(target.directory, 'vault/properties/fictional-property.md'))).toEqual(expected.businessNote);
  expect(await journalAt(source.directory)).toEqual(expected.journal);
  expect(JSON.parse(await readFile(join(source.directory, 'recipes.json'), 'utf8')).recipes).toEqual(expected.recipes);
}
function forgedHistory(backup: PrivateWorkspaceBackup, history: unknown) {
  const key = scryptSync(phrase, Buffer.from(backup.salt, 'hex'), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  try {
    const snapshot = decryptJson(key, backup.payload) as { files: { path: string; sha256: string; bytes: number; base64: string }[] };
    const file = snapshot.files.find(file => file.path === 'customer-packs.json')!, bytes = Buffer.from(JSON.stringify(history));
    Object.assign(file, { sha256: sha(bytes), bytes: bytes.length, base64: bytes.toString('base64') });
    return { ...backup, payload: encryptJson(key, snapshot) };
  } finally { key.fill(0); }
}

describe('actual completed pack upgrade history across private cold restore', () => {
  it.each(['v1', 'v2'] as const)('%s retains history, retired plans and staff edits, repairs omitted native files, then safely rolls back', async version => {
    const source = await fixture(), target = await fixture(), expected = await populate(source);
    expect(source.key.equals(target.key)).toBe(false);
    if (version === 'v1') {
      const { backup, receipt } = await source.backup.exportBackup(phrase);
      expect(receipt.excluded).toContain('Worker installation, authentication, conversations and memory');
      expect((await target.backup.stageRestore({ backup, passphrase: phrase, expectedDigest: receipt.digest })).needsRestart).toBe(true);
      expect((await applyStagedPrivateRestore({ directory: target.directory, key: target.key })).restored).toBe(true);
      expect(existsSync(join(target.directory, PRIVATE_RESTORE_STAGE_FILE))).toBe(false);
    } else await restoreV2(source, target, expected);
    await verifyAndRollback(source, target, expected);
  });

  it('refuses a real interrupted transition at v1 export and v2 catalog/capture admission without repairing it', async () => {
    const source = await fixture(), expected = await populate(source, true), entry = expected.journal.installs[expected.initial.id];
    expect(entry.transition).toMatchObject({ action: 'upgrade', fromGeneration: 1 });
    expect(entry.transition.target.pack.revision).toBe(2);
    await expect(source.backup.exportBackup(phrase)).rejects.toThrow(/Finish or recover/);
    const scratch = await fixture(), direct = await catalog(scratch, 'direct', source.key, source.workspaceId), before = direct.summary();
    expect(() => direct.addFile({ path: 'customer-packs.json', encoding: 'bytes', data: Buffer.from(JSON.stringify(expected.journal)) })).toThrow(/Finish or recover/);
    expect(direct.summary()).toEqual(before);
    const captured = await catalog(scratch, 'captured', source.key, source.workspaceId);
    await expect(capturePrivateWorkspace({ directory: source.directory, key: source.key, workspaceId: source.workspaceId, catalog: captured, assertLease() {} })).rejects.toThrow(/Finish or recover/);
    expect(captured.summary().sealed).toBe(false); expect(captured.getFile('customer-packs.json')).toBeUndefined();
    expect(await journalAt(source.directory)).toEqual(expected.journal);
    expect(expected.host.recipes.loadRecipes(true)).toEqual(expected.recipes);
    await expect(expected.host.service.assertReadyForRecipe(mainId)).rejects.toThrow(/recovery/);
  });

  it.each(['digest', 'generation', 'recipe', 'retired-path'] as const)('rejects corrupt prior %s in authenticated v1 restore and real v2 catalog admission', async fault => {
    const source = await fixture(), target = await fixture(), expected = await populate(source), { backup } = await source.backup.exportBackup(phrase);
    const invalid = structuredClone(expected.journal), entry = invalid.installs[expected.initial.id], prior = entry.history[0];
    if (fault === 'digest') prior.digest = '0'.repeat(64);
    else if (fault === 'generation') prior.generation = entry.generation;
    else if (fault === 'recipe') prior.recipes[0].id = 'wf-unowned';
    else prior.retiredRecipeIds.push('../outside');
    const forged = forgedHistory(backup, invalid), before = await readFile(join(target.directory, 'desk.json'));
    await expect(target.backup.previewBackup(forged, phrase)).rejects.toThrow(/history needs recovery/);
    await expect(target.backup.stageRestore({ backup: forged, passphrase: phrase, expectedDigest: sha(JSON.stringify(forged)) })).rejects.toThrow(/history needs recovery/);
    expect(await readFile(join(target.directory, 'desk.json'))).toEqual(before);
    expect(existsSync(join(target.directory, PRIVATE_RESTORE_STAGE_FILE))).toBe(false);
    const direct = await catalog(target, 'direct', target.key, source.workspaceId), summary = direct.summary();
    expect(() => direct.addFile({ path: 'customer-packs.json', encoding: 'bytes', data: Buffer.from(JSON.stringify(invalid)) })).toThrow(/history needs recovery/);
    expect(direct.summary()).toEqual(summary); expect(direct.getFile('customer-packs.json')).toBeUndefined();
    expect(await journalAt(source.directory)).toEqual(expected.journal);
    expect(expected.host.recipes.loadRecipes(true)).toEqual(expected.recipes);
  });
});


const packRoute = (action: string) => `/api/customer-packs/fictional-office/${action}`;
const archiveRequest = (preview: CustomerPackArchivePreview) => ({ expectedInstalledDigest: preview.installedDigest,
  expectedInstalledRevision: preview.installedRevision, expectedPreviewDigest: preview.previewDigest });
async function populateNineVersions(source: Fixture) {
  const expected = await populate(source);
  let next = expected.next;
  for (let revision = 3; revision <= 9; revision++) {
    next = structuredClone(next); next.revision = revision;
    next.recipes[0].steps = [`Read the fictional source with published revision ${revision}.`];
    const preview = await expected.host.service.previewUpgrade(next);
    expect(preview.canApply, preview.conflicts.join(' ')).toBe(true);
    expect(await expected.host.service.upgrade(request(preview))).toMatchObject({ revision, installationRevision: revision, localReady: true });
  }
  const row = expected.host.recipes.getRecipe(mainId)!;
  expected.host.recipes.saveRecipe({ ...row, schedule: { time: '08:00', weekdays: [1] }, status: 'active', expectedRevision: row.revision });
  expected.host.recipes.patchRecipe(mainId, { planApproved: true, expectedRevision: expected.host.recipes.getRecipe(mainId)!.revision });
  const tenth = structuredClone(next); tenth.revision = 10;
  tenth.recipes[0].steps = ['Read the fictional source with published revision 10.'];
  const blocked = await expected.host.service.previewUpgrade(tenth);
  expect(blocked.canApply).toBe(false); expect(blocked.conflicts.join(' ')).toMatch(/[Aa]rchive older history/);
  const result = await expected.host.service.handle(packRoute('archive-preview'), 'POST', {});
  expect(result?.status).toBe(200); const preview = result!.body as CustomerPackArchivePreview;
  expect(preview).toMatchObject({ canArchive: true, conflicts: [], installedRevision: 9, archivedConfigurations: 0 });
  expect(preview.archive.map(item => item.installationRevision)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(preview.keep.map(item => item.installationRevision)).toEqual([7, 8]);
  return { ...expected, next, tenth, archivePreview: preview, journal: await journalAt(source.directory), recipes: expected.host.recipes.loadRecipes(true) };
}
async function populateArchived(source: Fixture) {
  const expected = await populateNineVersions(source);
  const reply = await expected.host.service.handle(packRoute('archive'), 'POST', archiveRequest(expected.archivePreview));
  expect(reply).toMatchObject({ status: 200, body: { revision: 9, installationRevision: 9, localReady: true,
    archivedHistory: { batches: 1, configurations: 6, throughRevision: 6 } } });
  expect(expected.host.recipes.loadRecipes(true)).toEqual(expected.recipes);
  const archived = await journalAt(source.directory), entry = archived.installs[expected.initial.id];
  expect(entry.history.map((row: { generation: number }) => row.generation)).toEqual([7, 8]);
  const archivePath = `customer-pack-history/${expected.initial.id}/${entry.archiveHead.digest}.json`;
  const archiveBytes = await readFile(join(source.directory, archivePath));
  const archiveRecord = JSON.parse(archiveBytes.toString());
  expect(archiveRecord.snapshots.map((row: { generation: number }) => row.generation)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(archiveRecord.snapshots[0].recipes.find((row: { id: string }) => row.id === mainId).description).toBe('Staff note saved before upgrade.');
  // Archiving frees the bounded live journal without granting work authority.
  const ready = await expected.host.service.previewUpgrade(expected.tenth);
  expect(ready.canApply, ready.conflicts.join(' ')).toBe(true);
  expect(await expected.host.service.upgrade(request(ready))).toMatchObject({ revision: 10, installationRevision: 10, localReady: true });
  const current = expected.host.recipes.getRecipe(mainId)!;
  expected.host.recipes.saveRecipe({ ...current, status: 'active', schedule: { time: '08:00', weekdays: [1] }, expectedRevision: current.revision });
  expected.host.recipes.patchRecipe(mainId, { planApproved: true, expectedRevision: expected.host.recipes.getRecipe(mainId)!.revision });
  return { ...expected, archivePath, archiveBytes, archiveRecord, journal: await journalAt(source.directory),
    recipes: expected.host.recipes.loadRecipes(true), currentNative: await readFile(nativePath(source.directory), 'utf8') };
}
type Archived = Awaited<ReturnType<typeof populateArchived>>;
async function verifyArchivedRestore(source: Fixture, target: Fixture, expected: Archived) {
  expect(await journalAt(target.directory)).toEqual(expected.journal);
  expect(await readFile(join(target.directory, expected.archivePath))).toEqual(expected.archiveBytes);
  expect(await readFile(join(target.directory, 'desk.key'))).toEqual(target.key);
  expect(await readFile(join(target.directory, 'vault/properties/fictional-property.md'))).toEqual(expected.businessNote);
  const deskBytes = await readFile(join(target.directory, 'desk.json'));
  expect(decryptJson(target.key, JSON.parse(deskBytes.toString()))).toEqual({ ...source.book, revision: source.book.revision + 1, hands: 'held',
    handsDetail: 'Private workspace restored. Reconnect sources and review work before running.' });
  const restored = await openPack(target.directory), saved = restored.recipes.loadRecipes(true);
  expect(saved).toHaveLength(expected.recipes.length);
  for (const previous of expected.recipes) {
    const row = saved.find(recipe => recipe.id === previous.id)!;
    expect(row).toEqual({ ...previous, revision: previous.revision + 1, updatedAt: row.updatedAt, status: 'paused', schedule: null,
      planApprovedAt: null, approvedRevision: null, attachment: null, submitAcknowledgedAt: null });
  }
  expect(expected.recipes.find(row => row.id === mainId)).toMatchObject({ status: 'active', planApprovedAt: expect.any(Number), approvedRevision: expect.any(Number) });
  const status = (await restored.service.list()).installations[0];
  expect(status).toMatchObject({ localReady: false, revision: 10, installationRevision: 10, retiredRecipes: [oldId],
    archivedHistory: { batches: 1, configurations: 6, throughRevision: 6 } });
  expect(status.history?.map(row => row.installationRevision)).toEqual([7, 8, 9]);
  expect(existsSync(join(target.directory, 'profile'))).toBe(false);
  const browse = await restored.service.handle(packRoute('archived-history'), 'POST', {});
  expect(browse?.status).toBe(200); const page = browse!.body as CustomerPackArchivedHistory;
  expect(page).toMatchObject({ packId: expected.initial.id, head: status.archivedHistory!.head, cursor: status.archivedHistory!.head, nextCursor: null });
  expect(page.history.map(row => row.installationRevision)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(await restored.service.handle(packRoute('archived-history'), 'POST', { head: page.head, cursor: page.cursor })).toEqual(browse);
  expect(await restored.service.handle(packRoute('history-export'), 'POST', { installationRevision: 1 })).toEqual({ status: 200, body: expected.initial });
  await expect(restored.service.assertReadyForRecipe(oldId)).rejects.toThrow(/retired/);
  expect(await restored.service.handle(packRoute('repair'), 'POST', { expectedDigest: expected.journal.installs[expected.initial.id].digest }))
    .toMatchObject({ status: 200, body: { localReady: true, revision: 10, installationRevision: 10 } });
  expect(restored.recipes.loadRecipes(true)).toEqual(saved);
  expect(await readFile(nativePath(target.directory), 'utf8')).toBe(expected.currentNative);
  expect(await readFile(join(target.directory, expected.archivePath))).toEqual(expected.archiveBytes);
  const review = await restored.service.handle(packRoute('rollback-preview'), 'POST', { installationRevision: 1 });
  expect(review?.status).toBe(200); const preview = review!.body as CustomerPackChangePreview;
  expect(preview.canApply, preview.conflicts.join(' ')).toBe(true);
  const { pack: _pack, ...checked } = request(preview), body = { ...checked, packId: expected.initial.id, installationRevision: 1 };
  const complete = await restored.service.rollback(body);
  expect(complete).toMatchObject({ localReady: true, revision: 1, installationRevision: 11, retiredRecipes: [newId],
    archivedHistory: { batches: 1, configurations: 6, throughRevision: 6 } });
  expect(complete.history?.map(row => row.installationRevision)).toEqual([7, 8, 9, 10]);
  expect(restored.recipes.getRecipe(mainId)).toMatchObject({ title: 'Latest staff title after upgrade', description: 'Staff note saved before upgrade.',
    steps: expected.initial.recipes[0].steps, schedule: null, status: 'shadow', approvedRevision: null, planApprovedAt: null });
  await expect(restored.service.assertReadyForRecipe(newId)).rejects.toThrow(/retired/);
  await expect(restored.service.assertReadyForRecipe(oldId)).resolves.toBeUndefined();
  expect(restored.recipes.loadRecipes(true)).toHaveLength(expected.recipes.length);
  expect(await readFile(nativePath(target.directory), 'utf8')).toBe(expected.native);
  expect(await readFile(nativePath(target.directory, 'earlier-guidance'), 'utf8')).toContain('Pack fictional-office, revision 1.');
  expect(await readFile(join(target.directory, 'vault/workflow-support/earlier-guidance/SKILL.md'), 'utf8')).toBe(expected.initial.skills[1].instructions);
  const completedJournal = await journalAt(target.directory), completedRecipes = restored.recipes.loadRecipes(true);
  const restarted = await openPack(target.directory);
  expect(await restarted.service.rollback(body)).toEqual(complete);
  expect(await journalAt(target.directory)).toEqual(completedJournal); expect(restarted.recipes.loadRecipes(true)).toEqual(completedRecipes);
  expect(await restarted.service.handle(packRoute('history-export'), 'POST', { installationRevision: 1 })).toEqual({ status: 200, body: expected.initial });
  expect(await readFile(join(target.directory, expected.archivePath))).toEqual(expected.archiveBytes);
  expect(await readFile(join(target.directory, 'desk.json'))).toEqual(deskBytes);
  expect(await readFile(join(target.directory, 'vault/properties/fictional-property.md'))).toEqual(expected.businessNote);
  expect(await journalAt(source.directory)).toEqual(expected.journal);
  expect(await readFile(join(source.directory, expected.archivePath))).toEqual(expected.archiveBytes);
  expect(JSON.parse(await readFile(join(source.directory, 'recipes.json'), 'utf8')).recipes).toEqual(expected.recipes);
}
type SavedBackupFile = { path: string; sha256: string; bytes: number; base64: string };
function forgeFiles(backup: PrivateWorkspaceBackup, mutate: (files: SavedBackupFile[]) => SavedBackupFile[]) {
  const key = scryptSync(phrase, Buffer.from(backup.salt, 'hex'), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  try {
    const snapshot = decryptJson(key, backup.payload) as { files: SavedBackupFile[] };
    snapshot.files = mutate(snapshot.files); return { ...backup, payload: encryptJson(key, snapshot) };
  } finally { key.fill(0); }
}
function archiveFault(expected: Archived, fault: 'missing' | 'truncated' | 'wrong-pack' | 'orphan') {
  if (fault === 'missing') return { remove: true, path: expected.archivePath, bytes: undefined };
  if (fault === 'truncated') return { remove: false, path: expected.archivePath, bytes: expected.archiveBytes.subarray(0, expected.archiveBytes.length - 5) };
  const changed = structuredClone(expected.archiveRecord);
  if (fault === 'wrong-pack') changed.packId = 'foreign-office';
  else changed.archivedAt = '2026-09-21T00:00:00.000Z';
  const bytes = Buffer.from(JSON.stringify(changed)), path = `customer-pack-history/${expected.initial.id}/${sha(bytes)}.json`;
  return { remove: fault === 'wrong-pack', path, bytes };
}

describe('actual archived pack configurations across private cold restore', () => {
  it.each(['v1', 'v2'] as const)('%s restores exact archive bytes and live/retired plans, repairs instructions, then rolls back to archived generation one', async version => {
    const source = await fixture(), target = await fixture(), expected = await populateArchived(source);
    expect(source.key.equals(target.key)).toBe(false);
    if (version === 'v1') {
      const { backup, receipt } = await source.backup.exportBackup(phrase);
      expect((await target.backup.stageRestore({ backup, passphrase: phrase, expectedDigest: receipt.digest })).needsRestart).toBe(true);
      expect((await applyStagedPrivateRestore({ directory: target.directory, key: target.key })).restored).toBe(true);
      expect(existsSync(join(target.directory, PRIVATE_RESTORE_STAGE_FILE))).toBe(false);
    } else await restoreV2(source, target, expected);
    await verifyArchivedRestore(source, target, expected);
  });

  it.each(['missing', 'truncated', 'wrong-pack', 'orphan'] as const)('rejects authenticated %s archive at v1 import and v2 capture/catalog seal without changing the destination', async fault => {
    const source = await fixture(), target = await fixture(), scratch = await fixture(), expected = await populateArchived(source);
    const { backup } = await source.backup.exportBackup(phrase), changed = archiveFault(expected, fault);
    const forged = forgeFiles(backup, originals => {
      const files = originals.filter(file => !(changed.remove && file.path === expected.archivePath));
      if (changed.bytes) {
        const file = { path: changed.path, sha256: sha(changed.bytes), bytes: changed.bytes.length, base64: changed.bytes.toString('base64') };
        const index = files.findIndex(candidate => candidate.path === changed.path);
        if (index < 0) files.push(file); else files[index] = file;
      }
      return files;
    });
    const before = await readFile(join(target.directory, 'desk.json')), targetIdentity = await readFile(join(target.directory, 'company-installation/workspace.json'));
    await expect(target.backup.previewBackup(forged, phrase)).rejects.toThrow(/history|archiv|recover|record/i);
    await expect(target.backup.stageRestore({ backup: forged, passphrase: phrase, expectedDigest: sha(JSON.stringify(forged)) })).rejects.toThrow(/history|archiv|recover|record/i);
    expect(await readFile(join(target.directory, 'desk.json'))).toEqual(before);
    expect(await readFile(join(target.directory, 'company-installation/workspace.json'))).toEqual(targetIdentity);
    expect(existsSync(join(target.directory, PRIVATE_RESTORE_STAGE_FILE))).toBe(false);
    expect(existsSync(join(target.directory, 'customer-pack-history'))).toBe(false);

    // A real complete captured catalog is copied through public admission APIs.
    // Missing/orphan files are syntactically valid and must fail graph sealing.
    const valid = await catalog(scratch, 'valid', source.key, source.workspaceId);
    const captureOptions = { directory: source.directory, key: source.key, workspaceId: source.workspaceId, catalog: valid, assertLease() {} };
    const receipt = await capturePrivateWorkspace(captureOptions); await verifyPrivateWorkspaceCapture(captureOptions, receipt); valid.seal();
    const invalid = await catalog(scratch, 'invalid', source.key, source.workspaceId);
    const addAndSeal = () => {
      for (const file of valid.iterateFiles()) {
        if (file.path === expected.archivePath && changed.remove) continue;
        invalid.addFile(file.path === changed.path && changed.bytes ? { ...file, data: changed.bytes } : file);
      }
      if (changed.bytes && changed.path !== expected.archivePath) invalid.addFile({ path: changed.path, encoding: 'bytes', data: changed.bytes });
      for (const record of valid.iterateRecords()) invalid.addRecord(record);
      invalid.seal();
    };
    expect(addAndSeal).toThrow(/history|archiv|recover|record|json/i); expect(invalid.summary().sealed).toBe(false);
    if (fault === 'missing' || fault === 'orphan') {
      expect(invalid.getFile('customer-packs.json')).toBeDefined();
      if (fault === 'orphan') expect(invalid.getFile(changed.path)?.data).toEqual(changed.bytes);
    }

    // The source filesystem scan must reject the same fault before export admission.
    if (changed.remove) await rm(join(source.directory, expected.archivePath));
    if (changed.bytes) await privateFile(source.directory, changed.path, changed.bytes);
    try {
      await expect(source.backup.exportBackup(phrase)).rejects.toThrow(/history|archiv|recover|record/i);
      const captured = await catalog(scratch, 'invalid-source', source.key, source.workspaceId);
      const admission = async () => {
        const options = { directory: source.directory, key: source.key, workspaceId: source.workspaceId, catalog: captured, assertLease() {} };
        const receipt = await capturePrivateWorkspace(options); await verifyPrivateWorkspaceCapture(options, receipt); captured.seal();
      };
      await expect(admission()).rejects.toThrow(/history|archiv|recover|record|json/i);
      expect(captured.summary().sealed).toBe(false);
    } finally {
      if (changed.path !== expected.archivePath) await rm(join(source.directory, changed.path), { force: true });
      await privateFile(source.directory, expected.archivePath, expected.archiveBytes);
    }
    expect(await journalAt(source.directory)).toEqual(expected.journal);
    expect(expected.host.recipes.loadRecipes(true)).toEqual(expected.recipes);
    expect(await readFile(join(source.directory, 'vault/properties/fictional-property.md'))).toEqual(expected.businessNote);
  });

  it('refuses an actual interrupted archive in both backup formats and admits it only after explicit recovery', async () => {
    const source = await fixture(), expected = await populateNineVersions(source), block = join(source.directory, 'customer-pack-history');
    await privateFile(source.directory, 'customer-pack-history', 'Fictional filesystem obstruction');
    const body = archiveRequest(expected.archivePreview);
    await expect(expected.host.service.handle(packRoute('archive'), 'POST', body)).rejects.toThrow(/folder|directory/i);
    const pending = await journalAt(source.directory), entry = pending.installs[expected.initial.id];
    expect(entry.archiveIntent).toMatchObject({ fromGeneration: 9, fromDigest: expected.archivePreview.installedDigest, previewDigest: expected.archivePreview.previewDigest });
    expect(entry.history).toHaveLength(8); expect(entry.archiveHead).toBeUndefined();
    await rm(block); // Leave only the durable pending intent as the backup blocker.
    expect(expected.host.recipes.loadRecipes(true)).toEqual(expected.recipes);
    await expect(source.backup.exportBackup(phrase)).rejects.toThrow(/Finish or recover/);
    const scratch = await fixture(), direct = await catalog(scratch, 'direct', source.key, source.workspaceId), before = direct.summary();
    expect(() => direct.addFile({ path: 'customer-packs.json', encoding: 'bytes', data: Buffer.from(JSON.stringify(pending)) })).toThrow(/Finish or recover/);
    expect(direct.summary()).toEqual(before);
    const captured = await catalog(scratch, 'captured', source.key, source.workspaceId);
    await expect(capturePrivateWorkspace({ directory: source.directory, key: source.key, workspaceId: source.workspaceId, catalog: captured, assertLease() {} })).rejects.toThrow(/Finish or recover/);
    expect(captured.summary().sealed).toBe(false);
    expect(await journalAt(source.directory)).toEqual(pending);
    await expect(expected.host.service.assertReadyForRecipe(mainId)).rejects.toThrow(/recovery/);
    const reopened = await openPack(source.directory);
    expect(await reopened.service.handle(packRoute('resume-archive'), 'POST', body)).toMatchObject({ status: 200, body: { localReady: true, archivedHistory: { configurations: 6 } } });
    expect(reopened.recipes.loadRecipes(true)).toEqual(expected.recipes);
    await expect(source.backup.exportBackup(phrase)).resolves.toMatchObject({ backup: { format: 'realbud-private-business' } });
    const recovered = await catalog(scratch, 'recovered', source.key, source.workspaceId);
    const options = { directory: source.directory, key: source.key, workspaceId: source.workspaceId, catalog: recovered, assertLease() {} };
    const receipt = await capturePrivateWorkspace(options); await verifyPrivateWorkspaceCapture(options, receipt);
    expect(recovered.seal().sealed).toBe(true);
    expect(await readFile(join(source.directory, 'vault/properties/fictional-property.md'))).toEqual(expected.businessNote);
  });
});
