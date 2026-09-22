import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Recipe } from '../shared/contracts.ts';
import { austinCustomerPack } from './customer-pack-definition.ts';
import { createCustomerPackService, validateCustomerPack } from './customer-packs.ts';
import { privateTempRoot, removeFixture } from './testing/private-fixture.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeFixture(root); });
async function fixture() {
  const root = privateTempRoot(join(realpathSync(tmpdir()), 'rb-customer-pack-')); roots.push(root);
  let recipes: Recipe[] = [];
  const active: string[] = [];
  const saveRecipes = vi.fn((inputs: unknown[]) => {
    recipes.push(...inputs.map(raw => ({ ...(raw as object), revision: 1, createdAt: 1, updatedAt: 1, planApprovedAt: null, approvedRevision: null, attachment: null, submitAcknowledgedAt: null } as Recipe)));
    return recipes;
  });
  const resetRecipeApprovals = vi.fn((expected: { id: string; revision: number }[]) => {
    for (const item of expected) if (!recipes.some(recipe => recipe.id === item.id && recipe.revision === item.revision)) throw new Error('Stale recipe');
    recipes = recipes.map(recipe => expected.some(item => item.id === recipe.id) ? { ...recipe, revision: recipe.revision + 1, status: 'shadow', schedule: null, planApprovedAt: null, approvedRevision: null } : recipe);
  });
  const options = { directory: root, profileDirectory: () => join(root, 'profile'), workroomDirectory: () => join(root, 'vault'), listRecipes: () => recipes, saveRecipes, resetRecipeApprovals, activeRecipeIds: () => active, learningStatus: () => ({ supported: true, policyReady: true, enabled: true }), readiness: async () => ({ worker: { label: 'Worker', state: 'needed' as const, detail: 'Not installed', nextAction: 'Install through setup' } }) };
  const service = createCustomerPackService(options);
  return { root, service, options, saveRecipes, resetRecipeApprovals, active, recipes: () => recipes };
}
const nativePath = (root: string) => join(root, 'profile/skills/realbud-austin-office-email-inbox-triage/SKILL.md');
async function stage(root: string, content: string, payload: object = {}, id = '1234abcd') {
  const folder = join(root, 'profile/pending/skills'); await mkdir(folder, { recursive: true });
  const file = join(folder, `${id}.json`);
  // Exact v0.21.3 skill_manage gate shape: false is retained, only None is omitted.
  await writeFile(file, JSON.stringify({ id, subsystem: 'skills', action: 'edit', summary: 'Review clearer source coverage', origin: 'background_review', created_at: '2026-09-21T00:00:00Z', payload: { action: 'edit', name: 'realbud-austin-office-email-inbox-triage', content, replace_all: false, ...payload } }));
  return file;
}
async function installedFixture() {
  const f = await fixture(), pack = austinCustomerPack(), preview = await f.service.preview(pack); await f.service.install(pack, preview.digest);
  const baseline = await readFile(nativePath(f.root), 'utf8'); return { ...f, pack, preview, baseline };
}
async function revertRequest(service:ReturnType<typeof createCustomerPackService>,packId:string,skillId:string,revision=1){
 const page=await service.skillHistory(packId,skillId,{}),target=page.revisions.find(v=>v.revision===revision)!;
 const review=await service.skillRevertPreview(packId,skillId,{installationRevision:page.installationRevision,head:page.head,sourceDigest:page.sourceDigest,revision:target.revision,digest:target.digest});
 return {packId,skillId,...review.selection,expectedReviewDigest:review.reviewDigest};
}
describe('portable customer pack lifecycle', () => {
  it('bundles the three Austin outcomes, existing typed recipes and actual text dependency', () => {
    const pack = validateCustomerPack(austinCustomerPack());
    expect(pack.workflows).toHaveLength(3); expect(pack.recipes).toHaveLength(4);
    expect(pack.skills[0].instructions).toContain('name: email-inbox-triage');
    expect(pack.recipes.every(recipe => recipe.schedule === null && recipe.allowedOrigins.length === 0)).toBe(true);
  });
  it('previews without mutation, installs instruction files and leaves plans unapproved and accounts unverified', async () => {
    const f = await fixture(), pack = austinCustomerPack();
    const preview = await f.service.preview(pack); expect(f.saveRecipes).not.toHaveBeenCalled();
    const saved = await f.service.install(pack, preview.digest);
    expect(saved.localReady).toBe(true); expect(saved.checks.find(check => check.id === 'worker')?.state).toBe('needed');
    expect(saved.checks.find(check => check.id === 'workflow-acceptance')?.state).toBe('unknown');
    expect(f.recipes().every(recipe => recipe.status === 'shadow' && recipe.schedule === null && recipe.approvedRevision === null)).toBe(true);
    expect(await readFile(join(f.root, 'vault/workflow-support/email-inbox-triage/SKILL.md'), 'utf8')).toBe(pack.skills[0].instructions);
    expect(await readFile(join(f.root, 'profile/skills/realbud-austin-office-email-inbox-triage/SKILL.md'), 'utf8')).toContain('permissions or schedules');
  });
  it('names every unobserved prerequisite in human words and never as a raw id', async () => {
    const f = await installedFixture(), saved = (await f.service.list()).installations;
    const entry = saved.find(item => item.id === f.pack.id)!;
    const required = [...new Set(f.pack.workflows.flatMap(workflow => workflow.checks))];
    expect(required).toEqual(expect.arrayContaining(['worker', 'mail-account', 'browser-account', 'bank-mapping', 'bill-register', 'input-coverage', 'timezone', 'workflow-acceptance']));
    for (const id of required) {
      const check = entry.checks.find(item => item.id === id)!;
      expect(check, id).toBeDefined();
      expect(check.label).not.toBe(id);
      expect(check.label).not.toBe(id.replaceAll('-', ' '));
      expect(check.label).toMatch(/^[A-Z]/);
    }
    // 'worker' is the one observed check in the fixture; the rest fall back.
    const fallbacks = required.filter(id => id !== 'worker').map(id => entry.checks.find(item => item.id === id)!);
    expect(fallbacks.every(check => check.state === 'unknown')).toBe(true);
    expect(fallbacks.filter(check => !/has not been (checked|accepted) on this computer/.test(check.detail))).toEqual([]);
    expect(new Set(fallbacks.map(check => check.label)).size).toBe(fallbacks.length);
    expect(entry.checks.find(item => item.id === 'timezone')!.label).toBe('Office timezone');
    expect(entry.checks.find(item => item.id === 'browser-account')!.label).toBe('Bank or portal sign-in');
    expect(entry.checks.find(item => item.id === 'workflow-acceptance')!.nextAction).toContain('supervised run');
    expect(entry.checks.find(item => item.id === 'worker')!.label).toBe('Worker');
  });
  it('restarts and repeats without losing local plan edits or enabling recurrence', async () => {
    const f = await fixture(), pack = austinCustomerPack(), preview = await f.service.preview(pack);
    await f.service.install(pack, preview.digest);
    f.recipes()[0].title = 'My reviewed local title';
    const restarted = createCustomerPackService(f.options);
    expect((await restarted.list()).installations[0].localReady).toBe(true);
    await restarted.install(pack, preview.digest);
    expect(f.recipes()).toHaveLength(4); expect(f.recipes()[0].title).toBe('My reviewed local title');
  });
  it('refuses conflicting existing plans before installing files or changing other recipes', async () => {
    const f = await fixture(), pack = austinCustomerPack();
    f.saveRecipes([{ ...pack.recipes[0], title: 'Existing custom plan' }]);
    const preview = await f.service.preview(pack); expect(preview.canInstall).toBe(false);
    await expect(f.service.install(pack, preview.digest)).rejects.toThrow(/conflicts/);
    expect(f.recipes()).toHaveLength(1);
  });
  it('requires fresh approval when an existing matching plan first gains a pack instruction dependency', async () => {
    const f = await fixture(), pack = austinCustomerPack(); f.saveRecipes([pack.recipes[0]]);
    Object.assign(f.recipes()[0], { status: 'active', planApprovedAt: 2, approvedRevision: 1 });
    const preview = await f.service.preview(pack); expect(preview.kept).toContain(pack.recipes[0].id);
    await f.service.install(pack, preview.digest);
    expect(f.recipes()[0]).toMatchObject({ revision: 2, status: 'shadow', planApprovedAt: null, approvedRevision: null, schedule: null });
    expect(f.resetRecipeApprovals).toHaveBeenCalledTimes(1);
    await f.service.install(pack, preview.digest); expect(f.resetRecipeApprovals).toHaveBeenCalledTimes(1);
  });
  it('rolls back only new instructions on failed recipe commit and repairs after restart', async () => {
    const f = await fixture(), pack = austinCustomerPack(), preview = await f.service.preview(pack);
    f.saveRecipes.mockImplementationOnce(() => { throw new Error('Synthetic disk failure'); });
    await expect(f.service.install(pack, preview.digest)).rejects.toThrow('Synthetic disk failure');
    await expect(readFile(join(f.root, 'vault/workflow-support/email-inbox-triage/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    const restarted = createCustomerPackService(f.options);
    expect((await restarted.list()).installations[0].state).toBe('recovery-required');
    expect((await restarted.handle('/api/customer-packs/austin-office/repair', 'POST', { expectedDigest: preview.digest }))?.status).toBe(200);
    expect(f.recipes()).toHaveLength(4);
  });
  it('persists import intent before pausing a host clock, holds on failure and skips completed retry', async () => {
    const f = await fixture(), pack = austinCustomerPack(), preview = await f.service.preview(pack);
    let refuse = true;
    const pauseSchedules = vi.fn(async (packId: string) => {
      expect(packId).toBe(pack.id);
      const journal = JSON.parse(await readFile(join(f.root, 'customer-packs.json'), 'utf8'));
      expect(journal.installs[pack.id].phase).toBe('installing');
      await expect(readFile(nativePath(f.root))).rejects.toMatchObject({ code: 'ENOENT' });
      if (refuse) { expect(f.saveRecipes).not.toHaveBeenCalled(); throw new Error('Synthetic clock persistence failure'); }
    });
    const service = createCustomerPackService({ ...f.options, pauseSchedules });
    await expect(service.install(pack, preview.digest)).rejects.toThrow('Synthetic clock persistence failure');
    expect((await service.list()).installations[0].localReady).toBe(false);
    expect(f.resetRecipeApprovals).not.toHaveBeenCalled(); expect(f.recipes()).toEqual([]);
    refuse = false;
    const reopened = createCustomerPackService({ ...f.options, pauseSchedules });
    expect(await reopened.install(pack, preview.digest)).toMatchObject({ localReady: true });
    expect(pauseSchedules).toHaveBeenCalledTimes(2);
    await reopened.install(pack, preview.digest); expect(pauseSchedules).toHaveBeenCalledTimes(2);
    await rm(nativePath(f.root));
    expect(await reopened.install(pack, preview.digest)).toMatchObject({ localReady: true });
    expect(pauseSchedules).toHaveBeenCalledTimes(3);
  });
  it('repairs missing instructions but refuses changed files and stale review digests', async () => {
    const f = await fixture(), pack = austinCustomerPack(), preview = await f.service.preview(pack);
    await expect(f.service.install(pack, '0'.repeat(64))).rejects.toThrow(/changed/);
    await f.service.install(pack, preview.digest);
    const file = join(f.root, 'vault/workflow-support/email-inbox-triage/SKILL.md');
    await rm(file); await f.service.install(pack, preview.digest);
    expect(await readFile(file, 'utf8')).toBe(pack.skills[0].instructions);
    await writeFile(file, 'Local edit');
    await expect(f.service.install(pack, preview.digest)).rejects.toThrow(/conflicts/);
    expect(await readFile(file, 'utf8')).toBe('Local edit');
  });
  it('rejects instruction directory links without following them', async () => {
    const f = await fixture(); await symlink(f.root, join(f.root, 'profile'));
    await expect(f.service.preview(austinCustomerPack())).rejects.toThrow(/linked/);
    expect(f.saveRecipes).not.toHaveBeenCalled();
  });
  it.each(['../escape', '/tmp/escape', 'C:\\escape', 'a/b'])('rejects uploaded skill paths %s', id => {
    const pack = austinCustomerPack(); pack.skills[0].id = id;
    expect(() => validateCustomerPack(pack)).toThrow();
  });
  it('matches the pinned Hermes native skill name limit at 64 characters', () => {
    const pack = austinCustomerPack(); pack.id = 'a'.repeat(36); pack.skills[0].id = 'b'.repeat(19);
    expect(`realbud-${pack.id}-${pack.skills[0].id}`).toHaveLength(64);
    expect(() => validateCustomerPack(pack)).not.toThrow();
    pack.skills[0].id += 'b'; expect(() => validateCustomerPack(pack)).toThrow(/at most 64/);
  });
  it('rejects duplicate IDs, secret-bearing content, executable asset fields and enabled clocks', () => {
    const duplicate = austinCustomerPack(); duplicate.recipes.push(duplicate.recipes[0]); expect(() => validateCustomerPack(duplicate)).toThrow(/Duplicate/);
    const secret = austinCustomerPack(); secret.skills[0].instructions += '\napi_key=not-a-real-secret-123456789'; expect(() => validateCustomerPack(secret)).toThrow(/credentials/);
    const executable = austinCustomerPack(); Object.assign(executable.skills[0], { path: '../../config.yaml', command: 'execute' }); expect(() => validateCustomerPack(executable)).toThrow(/Unsupported/);
    const clock = austinCustomerPack(); clock.recipes[0].schedule = { time: '09:00', weekdays: [1] }; expect(() => validateCustomerPack(clock)).toThrow(/on-demand/);
  });
  it.each([`rbc_${'a'.repeat(64)}`, `ak_${'A1'.repeat(16)}`, `ck_${'B2'.repeat(16)}`])('rejects a scoped or vendor credential in imported text: %s', credential => {
    const pack = austinCustomerPack(); pack.skills[0].instructions += `\n${credential}\n`;
    expect(() => validateCustomerPack(pack)).toThrow(/credential/);
    const guidance = austinCustomerPack(); guidance.skills[0].instructions += '\nKeep rbc_…, ak_… and ck_… values in settings, never in this document.';
    expect(() => validateCustomerPack(guidance)).not.toThrow();
  });
  it('does not expose or approve credentials in native pending proposal text', async () => {
    const f = await installedFixture();
    for (const credential of [`rbc_${'b'.repeat(64)}`, `ak_${'C3'.repeat(16)}`, `ck_${'D4'.repeat(16)}`]) {
      await stage(f.root, `${f.baseline}\n${credential}\n`);
      const review = await f.service.proposals(); expect(review.proposals[0].state).toBe('unsupported'); expect(review.proposals[0].proposed).toBeNull();
      expect(JSON.stringify(review)).not.toContain(credential);
    }
    expect(f.resetRecipeApprovals).not.toHaveBeenCalled(); expect(await readFile(nativePath(f.root), 'utf8')).toBe(f.baseline);
  });
  it('exports only distributable content, independent of local custom plans and account observations', async () => {
    const f = await fixture(); f.saveRecipes([{ ...austinCustomerPack().recipes[0], title: 'Private edited title' }]);
    const exported = await f.service.handle('/api/customer-packs/austin-office/export', 'GET');
    expect(JSON.stringify(exported)).not.toContain('Private edited title'); expect(JSON.stringify(exported)).not.toContain(f.root);
  });
  it('applies reviewed native text, retains baseline, clears every dependent approval, and reverts as a new revision', async () => {
    const f = await installedFixture(), improved = `${f.baseline}\nList source coverage before priority recommendations.\n`;
    f.recipes().forEach(recipe => { recipe.status = 'active'; recipe.planApprovedAt = 4; recipe.approvedRevision = recipe.revision; recipe.schedule = { time: '09:00', weekdays: [1] }; });
    await stage(f.root, improved);
    const proposal = (await f.service.proposals()).proposals[0]; expect(proposal.state).toBe('reviewable'); expect(proposal.origin).toBe('Background review');
    await f.service.reviewProposal({ id: proposal.id, pendingDigest: proposal.pendingDigest, currentDigest: proposal.currentDigest, decision: 'approve' });
    expect(await readFile(nativePath(f.root), 'utf8')).toBe(improved);
    expect(f.recipes().every(recipe => recipe.status === 'shadow' && recipe.planApprovedAt === null && recipe.approvedRevision === null && recipe.schedule === null && recipe.revision === 2)).toBe(true);
    expect(await f.service.instructionContext(f.pack.recipes[0].id)).toContain(improved);
    let history = await f.service.proposals(); expect(history.proposals).toHaveLength(0); expect(history.revisions.map(item => item.revision)).toEqual([1, 2]);
    expect(history.revisions[0]).not.toHaveProperty('content');
    const restarted = createCustomerPackService(f.options); await restarted.install(f.pack, f.preview.digest);
    expect(await readFile(nativePath(f.root), 'utf8')).toBe(improved);
    await restarted.revertSkill(await revertRequest(restarted,f.pack.id,f.pack.skills[0].id));
    history = await restarted.proposals(); expect(history.revisions.at(-1)?.revision).toBe(3); expect(history.revisions.at(-1)?.active).toBe(true);
    expect(await readFile(nativePath(f.root), 'utf8')).toBe(f.baseline); expect(f.recipes().every(recipe => recipe.revision === 3 && recipe.approvedRevision === null && recipe.schedule === null)).toBe(true);
    const journal = JSON.parse(await readFile(join(f.root, 'customer-packs.json'), 'utf8')); expect(journal.installs[f.pack.id].pack.skills[0].instructions).toBe(f.pack.skills[0].instructions);
  });
  it('rejects stale pending/base digests and a queued run without applying any text', async () => {
    const f = await installedFixture(); await stage(f.root, `${f.baseline}\nFirst suggestion.\n`);
    const proposal = (await f.service.proposals()).proposals[0];
    await stage(f.root, `${f.baseline}\nChanged suggestion.\n`);
    await expect(f.service.reviewProposal({ id: proposal.id, pendingDigest: proposal.pendingDigest, currentDigest: proposal.currentDigest, decision: 'approve' })).rejects.toThrow(/proposal changed/);
    const next = (await f.service.proposals()).proposals[0], request = { id: next.id, pendingDigest: next.pendingDigest, currentDigest: next.currentDigest, decision: 'approve' };
    await expect(f.service.reviewProposal({ ...request, currentDigest: '0'.repeat(64) })).rejects.toThrow(/active skill changed/);
    f.active.push(f.pack.recipes[0].id); await expect(f.service.reviewProposal(request)).rejects.toThrow(/queued or running/);
    expect(await readFile(nativePath(f.root), 'utf8')).toBe(f.baseline); expect(f.resetRecipeApprovals).not.toHaveBeenCalled();
  });
  it('serializes duplicate approvals and rejects safely without modifying active instructions', async () => {
    const f = await installedFixture(); await stage(f.root, `${f.baseline}\nSuggestion.\n`);
    const item = (await f.service.proposals()).proposals[0], request = { id: item.id, pendingDigest: item.pendingDigest, currentDigest: item.currentDigest, decision: 'approve' };
    const results = await Promise.allSettled([f.service.reviewProposal(request), f.service.reviewProposal(request)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(f.resetRecipeApprovals).toHaveBeenCalledTimes(1);
    const activeText = await readFile(nativePath(f.root), 'utf8'); await stage(f.root, `${activeText}\nRejected addition.\n`, {}, 'ab12cd34');
    const rejected = (await f.service.proposals()).proposals[0]; await f.service.reviewProposal({ id: rejected.id, pendingDigest: rejected.pendingDigest, currentDigest: rejected.currentDigest, decision: 'reject' });
    expect(await readFile(nativePath(f.root), 'utf8')).toBe(activeText); expect((await f.service.proposals()).proposals).toHaveLength(0);
  });
  it('holds interrupted instruction changes across restart and finishes without resetting plans twice', async () => {
    const f = await installedFixture(), improved = `${f.baseline}\nRecoverable improvement.\n`; await stage(f.root, improved);
    const reset = f.options.resetRecipeApprovals;
    const failing = createCustomerPackService({ ...f.options, resetRecipeApprovals: expected => { reset(expected); throw new Error('Synthetic interruption after durable plan reset'); } });
    const item = (await failing.proposals()).proposals[0]; await expect(failing.reviewProposal({ id: item.id, pendingDigest: item.pendingDigest, currentDigest: item.currentDigest, decision: 'approve' })).rejects.toThrow(/interruption/);
    const restarted = createCustomerPackService(f.options);
    await expect(restarted.assertReadyForRecipe(f.pack.recipes[0].id)).rejects.toThrow(/recovery/);
    expect((await restarted.proposals()).pendingUpgrades).toHaveLength(1);
    expect((await restarted.handle('/api/customer-packs/austin-office/recover-instructions', 'POST', { expectedDigest: f.preview.digest }))?.status).toBe(200);
    expect(await readFile(nativePath(f.root), 'utf8')).toBe(improved); expect(f.resetRecipeApprovals).toHaveBeenCalledTimes(1);
    await expect(restarted.assertReadyForRecipe(f.pack.recipes[0].id)).resolves.toBeUndefined();
  });
  it.each(['proposal', 'revert'] as const)('pauses the host clock before a reviewed skill %s and holds failed pause for explicit recovery', async action => {
    const f = await installedFixture(), improved = `${f.baseline}\nReview source coverage.\n`; await stage(f.root, improved);
    const item = (await f.service.proposals()).proposals[0];
    const decision = { id: item.id, pendingDigest: item.pendingDigest, currentDigest: item.currentDigest, decision: 'approve' };
    if (action === 'revert') await f.service.reviewProposal(decision);
    const original = await readFile(nativePath(f.root)), before = structuredClone(f.recipes());
    f.resetRecipeApprovals.mockClear();
    let refuse = true;
    const pauseSchedules = vi.fn(async (packId: string) => {
      expect(packId).toBe(f.pack.id);
      expect(JSON.parse(await readFile(join(f.root, 'customer-packs.json'), 'utf8')).installs[packId].upgrade).toBeDefined();
      expect(await readFile(nativePath(f.root))).toEqual(original); expect(f.recipes()).toEqual(before);
      expect(f.resetRecipeApprovals).not.toHaveBeenCalled();
      if (refuse) throw new Error('Synthetic clock persistence failure');
    });
    const service = createCustomerPackService({ ...f.options, pauseSchedules });
    const revert=action==='revert'?await revertRequest(service,f.pack.id,f.pack.skills[0].id):null;
    const mutate = () => action === 'proposal' ? service.reviewProposal(decision) : service.revertSkill(revert);
    await expect(mutate()).rejects.toThrow('Synthetic clock persistence failure');
    expect((await service.list()).installations[0].localReady).toBe(false);
    refuse = false;
    const restarted = createCustomerPackService({ ...f.options, pauseSchedules });
    expect(await restarted.handle('/api/customer-packs/austin-office/recover-instructions', 'POST', { expectedDigest: f.preview.digest })).toMatchObject({ status: 200 });
    expect(await readFile(nativePath(f.root), 'utf8')).toBe(action === 'proposal' ? improved : f.baseline);
    expect(pauseSchedules).toHaveBeenCalledTimes(2); expect(f.resetRecipeApprovals).toHaveBeenCalledTimes(1);
    if(action==='revert')await expect(mutate()).resolves.toMatchObject({localReady:true});else await expect(mutate()).rejects.toThrow(); expect(pauseSchedules).toHaveBeenCalledTimes(2);
  });
  it('preflights both pending and retained history size before an instruction change touches plans or files', async () => {
    const f = await installedFixture(), improved = `${f.baseline}\nList source coverage first.\n`; await stage(f.root, improved);
    const item = (await f.service.proposals()).proposals[0], file = join(f.root, 'customer-packs.json');
    const journal = JSON.parse(await readFile(file, 'utf8')), entry = journal.installs[f.pack.id]; entry.receipt.note = '';
    const target = { revision: 2, digest: createHash('sha256').update(improved).digest('hex'), content: improved, createdAt: new Date().toISOString(), reason: 'Reviewed native proposal 1234abcd' };
    const pending = { ...entry, upgrade: { skillId: item.skillId, fromDigest: item.currentDigest, target, recipes: f.recipes().map(({ id, revision }) => ({ id, revision })), pendingId: item.id, pendingDigest: item.pendingDigest } };
    const baseline = { revision: 1, digest: item.currentDigest, content: f.baseline, createdAt: entry.installedAt, reason: 'Published pack baseline' };
    const complete = { ...entry, overrides: { [item.skillId!]: { activeRevision: 2, versions: [baseline, target] } }, proposalReceipts: [{ id: item.id, digest: item.pendingDigest, outcome: 'applied', at: target.createdAt }] };
    const size = (install: unknown) => Buffer.byteLength(JSON.stringify({ version: 1, installs: { [f.pack.id]: install } }));
    const headroom = Math.floor(((size(pending) - size(entry)) + (size(complete) - size(entry))) / 2);
    expect(size(complete)).toBeGreaterThan(size(pending));
    entry.receipt.note = 'x'.repeat(2_000_000 - headroom - size(entry));
    pending.receipt = entry.receipt; complete.receipt = entry.receipt;
    expect(size(pending)).toBeLessThanOrEqual(2_000_000); expect(size(complete)).toBeGreaterThan(2_000_000);
    const before = JSON.stringify(journal); await writeFile(file, before);
    await expect(f.service.reviewProposal({ id: item.id, pendingDigest: item.pendingDigest, currentDigest: item.currentDigest, decision: 'approve' })).rejects.toMatchObject({ status: 409 });
    expect(await readFile(file, 'utf8')).toBe(before); expect(await readFile(nativePath(f.root), 'utf8')).toBe(f.baseline); expect(f.resetRecipeApprovals).not.toHaveBeenCalled();
    expect((await f.service.proposals()).pendingUpgrades).toHaveLength(0);
    const extra = austinCustomerPack(); extra.id = 'other-office';
    const mapping = new Map(extra.recipes.map(recipe => [recipe.id, `${recipe.id}-extra`]));
    extra.recipes = extra.recipes.map(recipe => ({ ...recipe, id: mapping.get(recipe.id)! })); extra.workflows = extra.workflows.map(workflow => ({ ...workflow, recipeIds: workflow.recipeIds.map(id => mapping.get(id)!) }));
    const preview = await f.service.preview(extra); await expect(f.service.install(extra, preview.digest)).rejects.toThrow(/storage limit/);
    expect(await readFile(file, 'utf8')).toBe(before); expect(f.recipes()).toHaveLength(4);
    await expect(readFile(join(f.root, 'profile/skills/realbud-other-office-email-inbox-triage/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('keeps unsupported paths, core targets, scripts, secret text and linked records blocked', async () => {
    const f = await installedFixture();
    for (const payload of [{ file_path: '../../config.yaml' }, { name: 'core' }, { action: 'delete' }, { replace_all: true }, { operations: [{ action: 'edit' }] }, { content: `${f.baseline}\napi_key=not-a-real-secret-123456789` }, { content: f.baseline.replace('description: ', 'tools: terminal\ndescription: ') }]) {
      await stage(f.root, f.baseline, payload); expect((await f.service.proposals()).proposals[0].state).toBe('unsupported');
    }
    const pending = await stage(f.root, f.baseline); await rm(pending); await symlink(nativePath(f.root), pending);
    expect((await f.service.proposals()).proposals[0].state).toBe('unsupported');
    await expect(f.service.reviewProposal({ id: '../escape', pendingDigest: '0'.repeat(64), currentDigest: '', decision: 'approve' })).rejects.toThrow(/identifier/);
    expect(await readFile(nativePath(f.root), 'utf8')).toBe(f.baseline); expect(f.resetRecipeApprovals).not.toHaveBeenCalled();
  });
});
