import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { privateFixtureRoot, writePrivateFixtureFile, WINDOWS_PROFILE_TEST_OPTIONS } from './testing/private-profile-fixture.ts';
import type { CustomerPack, CustomerPackChangePreview } from '../shared/customer-packs.ts';

const environment = vi.hoisted(() => {
  const previous = process.env.REALBUD_DATA_DIR;
  const directory = `${process.env.TMPDIR ?? '/tmp'}/rb-pack-independent-recipes-${process.pid}-${Date.now()}`;
  process.env.REALBUD_DATA_DIR = directory;
  return { previous, directory };
});
const { createCustomerPackService, validateCustomerPack } = await import('./customer-packs.ts');
const { getRecipe, patchRecipe, resetRecipeApprovalsAtomically, saveRecipe } = await import('./recipes.ts');
const roots: string[] = [];
beforeEach(async () => { await mkdir(environment.directory, { recursive: true }); await rm(join(environment.directory, 'recipes.json'), { force: true }); });
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
afterAll(async () => {
  await rm(environment.directory, { recursive: true, force: true });
  if (environment.previous === undefined) delete process.env.REALBUD_DATA_DIR;
  else process.env.REALBUD_DATA_DIR = environment.previous;
});

function pack(id: string, recipeIds: string[]): CustomerPack {
  return {
    format: 'realbud-customer-pack', version: 1, id, revision: 1, title: 'Fictional ownership review',
    recipes: recipeIds.map(id => ({ id, title: 'Review supplied sources', description: '', steps: ['Review fictional supplied sources.'], evidence: 'Source references.',
      capabilities: ['read-files', 'analyse', 'draft'], limits: { maxRuntimeMinutes: 2, maxTurns: 6 }, siteNotes: null, schedule: null, allowedOrigins: [] })),
    workflows: [{ id: 'fictional-review', title: 'Fictional review', recipeIds, checks: ['input-coverage'] }],
    skills: [], dependencies: { runtime: 'hermes-property', mode: 'supplied-source-preparation', schedules: 'off', permissions: 'local-review-required' },
  };
}
const request = (preview: CustomerPackChangePreview) => ({ pack: preview.pack, expectedInstalledDigest: preview.installedDigest,
  expectedInstalledRevision: preview.installedRevision, expectedDigest: preview.digest, expectedPreviewDigest: preview.previewDigest });
function fixture() {
  const directory = privateFixtureRoot(join(tmpdir(), 'rb-pack-independent-')); roots.push(directory);
  const options = { directory, profileDirectory: () => join(directory, 'profile'), workroomDirectory: () => join(directory, 'vault') };
  return { directory, options, service: createCustomerPackService(options) };
}
async function refuseWithoutChanges(service: ReturnType<typeof createCustomerPackService>, directory: string, other: CustomerPack) {
  const journal = await readFile(join(directory, 'customer-packs.json'));
  const recipes = await readFile(join(environment.directory, 'recipes.json'));
  const preview = await service.preview(other);
  expect(preview.canInstall, 'A new import must reserve every existing or pending pack’s plan ownership').toBe(false);
  await expect(service.install(other, preview.digest)).rejects.toMatchObject({ status: 409 });
  expect(await readFile(join(directory, 'customer-packs.json'))).toEqual(journal);
  expect(await readFile(join(environment.directory, 'recipes.json'))).toEqual(recipes);
}

it('refuses a new pack taking another pack’s retired plan before it can deadlock reviewed rollback', WINDOWS_PROFILE_TEST_OPTIONS, async () => {
  const { directory, service } = fixture();
  const original = pack('fictional-first', ['wf-fictional-current', 'wf-fictional-retired']);
  await service.install(original, (await service.preview(original)).digest);
  const next = pack(original.id, ['wf-fictional-current']); next.revision = 2;
  await service.upgrade(request(await service.previewUpgrade(next)));
  await expect(service.assertReadyForRecipe('wf-fictional-retired')).rejects.toThrow(/retired/);

  const other = pack('fictional-second', ['wf-fictional-retired']);
  await refuseWithoutChanges(service, directory, other);
  const rollback = (await service.handle(`/api/customer-packs/${original.id}/rollback-preview`, 'POST', { installationRevision: 1 }))!.body as CustomerPackChangePreview;
  expect(rollback.canApply).toBe(true);
  const { pack: _pack, ...reviewed } = request(rollback);
  expect(await service.rollback({ ...reviewed, packId: original.id, installationRevision: 1 })).toMatchObject({ localReady: true, revision: 1 });
  await expect(service.assertReadyForRecipe('wf-fictional-retired')).resolves.toBeUndefined();
});

it('refuses a new pack taking an existing current plan even with identical plan bytes', WINDOWS_PROFILE_TEST_OPTIONS, async () => {
  const { directory, service } = fixture();
  const original = pack('fictional-first', ['wf-fictional-current']);
  await service.install(original, (await service.preview(original)).digest);
  await refuseWithoutChanges(service, directory, pack('fictional-second', ['wf-fictional-current']));
  await expect(service.assertReadyForRecipe('wf-fictional-current')).resolves.toBeUndefined();
});

it('reserves a pending target’s new plan ID before its recipe exists, preserving exact resume', WINDOWS_PROFILE_TEST_OPTIONS, async () => {
  const { directory, service, options } = fixture();
  const original = pack('fictional-first', ['wf-fictional-current']);
  await service.install(original, (await service.preview(original)).digest);
  const next = pack(original.id, ['wf-fictional-current', 'wf-fictional-added']); next.revision = 2;
  const reviewed = request(await service.previewUpgrade(next));
  const interrupted = createCustomerPackService({ ...options, resetRecipeApprovals: expected => {
    resetRecipeApprovalsAtomically(expected);
    throw new Error('Fictional crash after real approval reset');
  } });
  await expect(interrupted.upgrade(reviewed)).rejects.toThrow(/Fictional crash/);
  const saved = JSON.parse(await readFile(join(environment.directory, 'recipes.json'), 'utf8'));
  expect(saved.recipes.some((recipe: { id: string }) => recipe.id === 'wf-fictional-added')).toBe(false);
  await refuseWithoutChanges(service, directory, pack('fictional-second', ['wf-fictional-added']));
  const installed = (await service.list()).installations[0];
  const resumed = await service.handle(`/api/customer-packs/${original.id}/resume-change`, 'POST', {
    expectedInstalledDigest: installed.digest, expectedInstalledRevision: installed.installationRevision,
    expectedPreviewDigest: installed.pendingChange!.previewDigest,
  });
  expect(resumed).toMatchObject({ status: 200, body: { localReady: true, revision: 2 } });
  await expect(service.assertReadyForRecipe('wf-fictional-added')).resolves.toBeUndefined();
});

it('holds legacy duplicate owners in status and every instruction admission without repairing their journal', WINDOWS_PROFILE_TEST_OPTIONS, async () => {
  const { directory, service } = fixture();
  const original = pack('fictional-first', ['wf-fictional-current']);
  await service.install(original, (await service.preview(original)).digest);
  const path = join(directory, 'customer-packs.json');
  const journal = JSON.parse(await readFile(path, 'utf8'));
  // The old importer admitted an identical manual/existing plan into a second
  // pack. Preserve that historical on-disk shape as a compatibility fixture;
  // current APIs must refuse to create it and must hold it when reopening.
  const other = validateCustomerPack(pack('fictional-second', ['wf-fictional-current']));
  journal.installs[other.id] = { ...structuredClone(journal.installs[original.id]), pack: other,
    digest: createHash('sha256').update(JSON.stringify(other)).digest('hex'),
    receipt: { addedRecipes: [], installedSkills: [], preservedRecipes: ['wf-fictional-current'], note: 'Fictional legacy identical-plan adoption.' } };
  writePrivateFixtureFile(path, JSON.stringify(journal));
  const before = await readFile(path), recipes = await readFile(join(environment.directory, 'recipes.json'));
  const installations = (await service.list()).installations;
  expect(installations).toHaveLength(2);
  expect(installations.every(entry => !entry.localReady && entry.state === 'recovery-required')).toBe(true);
  await expect(service.assertReadyForRecipe('wf-fictional-current')).rejects.toThrow(/ownership|claims|one imported pack/i);
  await expect(service.instructionContext('wf-fictional-current')).rejects.toThrow(/ownership|claims|one imported pack/i);
  for (const id of [original.id, other.id]) await expect(service.packRecipeBinding(id, 'wf-fictional-current')).rejects.toMatchObject({ status: 409 });
  await expect(service.install(original, journal.installs[original.id].digest)).rejects.toMatchObject({ status: 409 });
  expect(await readFile(path)).toEqual(before);
  expect(await readFile(join(environment.directory, 'recipes.json'))).toEqual(recipes);
});

it('still adopts an unowned identical manual plan and permits its own repair without resetting later staff choices', WINDOWS_PROFILE_TEST_OPTIONS, async () => {
  const { service } = fixture(), original = pack('fictional-first', ['wf-fictional-current']);
  const id = original.recipes[0].id;
  saveRecipe({ ...original.recipes[0], status: 'active', expectedRevision: 0 });
  patchRecipe(id, { planApproved: true, expectedRevision: getRecipe(id)!.revision });
  const manualRevision = getRecipe(id)!.revision;
  const preview = await service.preview(original); expect(preview.canInstall).toBe(true);
  expect(await service.install(original, preview.digest)).toMatchObject({ localReady: true });
  expect(getRecipe(id)).toMatchObject({ revision: manualRevision + 1, status: 'shadow', planApprovedAt: null, approvedRevision: null });
  saveRecipe({ ...getRecipe(id)!, description: 'Staff choice after adoption.', expectedRevision: getRecipe(id)!.revision });
  patchRecipe(id, { planApproved: true, expectedRevision: getRecipe(id)!.revision });
  const recipes = await readFile(join(environment.directory, 'recipes.json'));
  const repaired = await service.handle(`/api/customer-packs/${original.id}/repair`, 'POST', { expectedDigest: preview.digest });
  expect(repaired).toMatchObject({ status: 200, body: { localReady: true } });
  expect(await readFile(join(environment.directory, 'recipes.json'))).toEqual(recipes);
  await expect(service.assertReadyForRecipe(id)).resolves.toBeUndefined();
});
