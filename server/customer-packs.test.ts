import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Recipe } from '../shared/contracts.ts';
import type { CustomerPack, CustomerPackChangePreview } from '../shared/customer-packs.ts';
import { DATA_DIR } from './config.ts';
import { austinCustomerPack } from './customer-pack-definition.ts';
import { admitPack, createCustomerPackService as createPackService, validateCustomerPack } from './customer-packs.ts';
import { BUILT_IN_MISMATCH_MESSAGE } from './pack-signing.ts';
import { getRecipe } from './recipes.ts';
import { workerScope } from './worker-state.ts';
import { LoopManager } from './routines.ts';
import { FICTIONAL_PACK_KEYS, withFictionalPublisher } from './testing/pack-publisher.ts';
import { privateTempRoot, removeFixture } from './testing/private-fixture.ts';
import { createWorkLedger } from './work-ledger.ts';
const createCustomerPackService = withFictionalPublisher(createPackService);

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
describe('unsigned built-in pack admission', () => {
  const crlf = (pack: CustomerPack): CustomerPack => ({ ...pack, skills: pack.skills.map(skill => ({ ...skill, instructions: skill.instructions.replace(/\n/g, '\r\n') })) });
  it('accepts a CRLF copy of the built-in pack and keeps its LF text', () => {
    const builtIn = austinCustomerPack();
    expect(builtIn.skills.some(skill => skill.instructions.includes('\n'))).toBe(true);
    const copy = crlf(builtIn);
    expect(copy.skills.some(skill => skill.instructions.includes('\r\n'))).toBe(true);
    expect(admitPack(copy, []).skills).toEqual(builtIn.skills);
  });
  it('still refuses a changed byte, with or without CRLF', () => {
    const builtIn = austinCustomerPack();
    const changed = { ...builtIn, skills: builtIn.skills.map((skill, i) => i ? skill : { ...skill, instructions: `${skill.instructions}.` }) };
    expect(() => admitPack(changed, [])).toThrow(BUILT_IN_MISMATCH_MESSAGE);
    expect(() => admitPack(crlf(changed), [])).toThrow(BUILT_IN_MISMATCH_MESSAGE);
  });
});

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
  it('counts an install in progress as working for an update restart until it settles, and a refused one not after', async () => {
    const f = await fixture(), pack = austinCustomerPack(), ledger = createWorkLedger();
    let release!: () => void; const paused = new Promise<void>(resolve => { release = resolve; });
    let reached!: () => void; const pausing = new Promise<void>(resolve => { reached = resolve; });
    const service = createCustomerPackService({ ...f.options, workLedger: ledger, pauseSchedules: async () => { reached(); await paused; } });
    const preview = await service.preview(pack);
    expect(ledger.snapshot()).toEqual({ working: 0, waiting: 0, byKind: {} });
    const installing = service.install(pack, preview.digest);
    expect(ledger.snapshot()).toEqual({ working: 1, waiting: 0, byKind: { 'pack-change': { working: 1, waiting: 0 } } });
    await pausing;
    expect(ledger.snapshot().working).toBe(1);
    release(); expect((await installing).localReady).toBe(true);
    expect(ledger.snapshot()).toEqual({ working: 0, waiting: 0, byKind: {} });
    await expect(service.install(pack, 'f'.repeat(64))).rejects.toThrow(/changed/);
    expect(ledger.snapshot().working).toBe(0);
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
    const pack = austinCustomerPack(); pack.skills = pack.skills.slice(0, 1); pack.id = 'a'.repeat(36); pack.skills[0].id = 'b'.repeat(19);
    expect(`realbud-${pack.id}-${pack.skills[0].id}`).toHaveLength(64);
    expect(() => validateCustomerPack(pack)).not.toThrow();
    pack.skills[0].id += 'b'; expect(() => validateCustomerPack(pack)).toThrow(/at most 64/);
  });
  it('rejects duplicate IDs, secret-bearing content, executable asset fields and enabled clocks', () => {
    const duplicate = austinCustomerPack(); duplicate.recipes.push(duplicate.recipes[0]); expect(() => validateCustomerPack(duplicate)).toThrow(/Duplicate/);
    const secret = austinCustomerPack(); secret.skills[0].instructions += '\napi_key=not-a-real-secret-123456789'; expect(() => validateCustomerPack(secret)).toThrow(/credentials/);
    const executable = austinCustomerPack(); Object.assign(executable.skills[0], { path: '../../config.yaml', command: 'execute' }); expect(() => validateCustomerPack(executable)).toThrow(/Unsupported/);
    // A plan's own clock installs paused for plan review ('pack plan clocks' below); a loop that arrives switched on is refused.
    const clock = austinCustomerPack(); clock.files = { 'office/settings.json': JSON.stringify({ version: 1, kind: 'office-settings', loops: [{ id: 'weekly-bills', enabled: true, schedule: { type: 'daily', time: '09:00', weekdays: [1] } }] }) };
    expect(() => validateCustomerPack(clock)).toThrow(/arrive switched off/);
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
    const originalBinding = await f.service.packRecipeBinding(f.pack.id, f.pack.recipes[0].id);
    const originalContext = await f.service.instructionContext(f.pack.recipes[0].id);
    f.recipes().forEach(recipe => { recipe.status = 'active'; recipe.planApprovedAt = 4; recipe.approvedRevision = recipe.revision; recipe.schedule = { time: '09:00', weekdays: [1] }; });
    await stage(f.root, improved);
    const proposal = (await f.service.proposals()).proposals[0]; expect(proposal.state).toBe('reviewable'); expect(proposal.origin).toBe('Background review');
    await f.service.reviewProposal({ id: proposal.id, pendingDigest: proposal.pendingDigest, currentDigest: proposal.currentDigest, decision: 'approve' });
    expect(await readFile(nativePath(f.root), 'utf8')).toBe(improved);
    expect(f.recipes().every(recipe => recipe.status === 'shadow' && recipe.planApprovedAt === null && recipe.approvedRevision === null && recipe.schedule === null && recipe.revision === 2)).toBe(true);
    expect(await f.service.instructionContext(f.pack.recipes[0].id)).toContain(improved);
    let history = await f.service.proposals(); expect(history.proposals).toHaveLength(0); const triage = () => history.revisions.filter(item => item.skillId === f.pack.skills[0].id);
    expect(triage().map(item => item.revision)).toEqual([1, 2]);
    expect(history.revisions[0]).not.toHaveProperty('content');
    const restarted = createCustomerPackService(f.options); await restarted.install(f.pack, f.preview.digest);
    expect(await readFile(nativePath(f.root), 'utf8')).toBe(improved);
    await restarted.revertSkill(await revertRequest(restarted,f.pack.id,f.pack.skills[0].id));
    history = await restarted.proposals(); expect(triage().at(-1)?.revision).toBe(3); expect(triage().at(-1)?.active).toBe(true);
    expect(await readFile(nativePath(f.root), 'utf8')).toBe(f.baseline); expect(f.recipes().every(recipe => recipe.revision === 3 && recipe.approvedRevision === null && recipe.schedule === null)).toBe(true);
    // Legacy pack identity retains its established revision-bound contract.
    expect(await restarted.packRecipeBinding(f.pack.id, f.pack.recipes[0].id)).not.toBe(originalBinding);
    expect(await restarted.instructionContext(f.pack.recipes[0].id)).not.toBe(originalContext);
    expect(await restarted.instructionContext(f.pack.recipes[0].id)).toContain(', revision 3, SHA-256 ');
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
    // The second identical approval returns the saved result; the change is applied once.
    const results = await Promise.allSettled([f.service.reviewProposal(request), f.service.reviewProposal(request)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2); expect(f.resetRecipeApprovals).toHaveBeenCalledTimes(1);
    await expect(f.service.reviewProposal({ ...request, decision: 'reject' })).rejects.toMatchObject({ status: 409 });
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
    await expect(mutate()).resolves.toMatchObject({localReady:true}); expect(pauseSchedules).toHaveBeenCalledTimes(2);
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

describe('worker folder deleted or replaced', () => {
  const scoped = (f: Awaited<ReturnType<typeof installedFixture>>, workspaceId: string, profile = join(f.root, 'profile')) =>
    ({ ...f.options, profileDirectory: () => profile, workerScope: () => workerScope(workspaceId, 'property', profile) });
  it('resumes an approved, interrupted instruction change from RealBud’s saved record and stable binding', async () => {
    const f = await installedFixture(), workspaceId = randomUUID(), improved = `${f.baseline}\nRecoverable improvement.\n`; await stage(f.root, improved);
    const reset = f.options.resetRecipeApprovals;
    const failing = createCustomerPackService({ ...scoped(f, workspaceId), resetRecipeApprovals: expected => { reset(expected); throw new Error('Synthetic interruption after durable plan reset'); } });
    const item = (await failing.proposals()).proposals[0];
    await expect(failing.reviewProposal({ id: item.id, pendingDigest: item.pendingDigest, currentDigest: item.currentDigest, decision: 'approve' })).rejects.toThrow(/interruption/);
    const saved = JSON.parse(await readFile(join(f.root, 'customer-packs.json'), 'utf8')).installs[f.pack.id].upgrade;
    expect(saved.binding).toEqual({ workspaceId, scopeId: expect.stringMatching(/^[a-f0-9]{32}$/), packId: f.pack.id, logicalArtifact: `skills/realbud-${f.pack.id}-${f.pack.skills[0].id}/SKILL.md` });
    await rm(join(f.root, 'profile'), { recursive: true });
    const gone = createCustomerPackService(scoped(f, workspaceId));
    expect((await gone.proposals()).pendingUpgrades).toHaveLength(1);
    await expect(gone.handle('/api/customer-packs/austin-office/recover-instructions', 'POST', { expectedDigest: f.preview.digest })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Set up Bud again/) });
    await expect(gone.assertReadyForRecipe(f.pack.recipes[0].id)).rejects.toThrow(/recovery/);
    // A replacement worker folder at another location: the stable binding still matches; the paths do not.
    const replacement = join(f.root, 'profile-replacement'); await mkdir(replacement, { recursive: true, mode: 0o700 });
    const restored = createCustomerPackService(scoped(f, workspaceId, replacement));
    expect(await restored.handle('/api/customer-packs/austin-office/recover-instructions', 'POST', { expectedDigest: f.preview.digest })).toMatchObject({ status: 200 });
    expect(await readFile(join(replacement, 'skills/realbud-austin-office-email-inbox-triage/SKILL.md'), 'utf8')).toBe(improved);
    expect(f.resetRecipeApprovals).toHaveBeenCalledTimes(1);
    // The decided proposal stays closed although only RealBud's copy remains.
    expect((await restored.proposals()).proposals).toEqual([]);
  });
  it('migrates a path-bound intent once under the same trusted roots, keeping its approval binding, and refuses it after relocation', async () => {
    const f = await installedFixture(), workspaceId = randomUUID(), improved = `${f.baseline}\nLegacy improvement.\n`; await stage(f.root, improved);
    const reset = f.options.resetRecipeApprovals;
    const legacy = createCustomerPackService({ ...f.options, resetRecipeApprovals: expected => { reset(expected); throw new Error('Synthetic interruption after durable plan reset'); } });
    const item = (await legacy.proposals()).proposals[0];
    await expect(legacy.reviewProposal({ id: item.id, pendingDigest: item.pendingDigest, currentDigest: item.currentDigest, decision: 'approve' })).rejects.toThrow(/interruption/);
    const journal = () => readFile(join(f.root, 'customer-packs.json'), 'utf8').then(text => JSON.parse(text).installs[f.pack.id].upgrade);
    const original = await journal(); expect(original.binding).toBeUndefined();
    const moved = join(f.root, 'profile-moved'); await mkdir(moved, { recursive: true, mode: 0o700 });
    await expect(createCustomerPackService(scoped(f, workspaceId, moved)).handle('/api/customer-packs/austin-office/recover-instructions', 'POST', { expectedDigest: f.preview.digest })).rejects.toMatchObject({ status: 409 });
    expect((await journal()).binding).toBeUndefined();
    let pause = true;
    const same = createCustomerPackService({ ...scoped(f, workspaceId), pauseSchedules: async () => { if (pause) throw new Error('Synthetic pause failure'); } });
    await expect(same.handle('/api/customer-packs/austin-office/recover-instructions', 'POST', { expectedDigest: f.preview.digest })).rejects.toThrow('Synthetic pause failure');
    const migrated = await journal();
    expect(migrated).toMatchObject({ scope: original.scope, migratedFrom: original.scope, pendingDigest: original.pendingDigest, binding: { workspaceId, packId: f.pack.id } });
    pause = false;
    expect(await same.handle('/api/customer-packs/austin-office/recover-instructions', 'POST', { expectedDigest: f.preview.digest })).toMatchObject({ status: 200 });
    expect(await readFile(nativePath(f.root), 'utf8')).toBe(improved);
  });
  it('keeps a rejected proposal closed although RealBud’s copy outlives the worker file: approve after reject is refused', async () => {
    const f = await installedFixture(), service = createCustomerPackService(scoped(f, randomUUID()));
    await stage(f.root, `${f.baseline}\nRejected addition.\n`);
    const item = (await service.proposals()).proposals[0], request = { id: item.id, pendingDigest: item.pendingDigest, currentDigest: item.currentDigest };
    await service.reviewProposal({ ...request, decision: 'reject' });
    await expect(service.reviewProposal({ ...request, decision: 'approve' })).rejects.toMatchObject({ status: 409 });
    await expect(service.reviewProposal({ ...request, decision: 'reject' })).resolves.toMatchObject({ localReady: true });
    expect(await readFile(nativePath(f.root), 'utf8')).toBe(f.baseline); expect(f.resetRecipeApprovals).not.toHaveBeenCalled();
  });
  it('lists an open proposal behind 100 decided ones', async () => {
    const f = await installedFixture(), service = createCustomerPackService(scoped(f, randomUUID()));
    const ids = Array.from({ length: 101 }, (_, i) => i.toString(16).padStart(8, '0'));
    for (const id of ids) await stage(f.root, `${f.baseline}\nSuggestion ${id}.\n`, {}, id);
    const journal = JSON.parse(await readFile(join(f.root, 'customer-packs.json'), 'utf8'));
    journal.installs[f.pack.id].proposalReceipts = await Promise.all(ids.slice(0, 100).map(async id => ({ id, outcome: 'rejected', at: '2026-10-08T00:00:00.000Z',
      digest: createHash('sha256').update(await readFile(join(f.root, 'profile/pending/skills', `${id}.json`), 'utf8')).digest('hex') })));
    await writeFile(join(f.root, 'customer-packs.json'), JSON.stringify(journal));
    const listed = await service.proposals();
    expect(listed.proposals.map(item => item.id)).toEqual([ids[100]]); expect(listed.hasMore).toBe(false);
  });
  it('lists the one open proposal behind 2,000 decided ones', async () => {
    const f = await installedFixture(), service = createCustomerPackService(scoped(f, randomUUID()));
    const ids = Array.from({ length: 2001 }, (_, i) => i.toString(16).padStart(8, '0')), receipts: { id: string; digest: string; outcome: string; at: string }[] = [];
    for (const id of ids) {
      const file = await stage(f.root, `${f.baseline}\nSuggestion ${id}.\n`, {}, id);
      if (id !== ids[2000]) receipts.push({ id, outcome: 'rejected', at: '2026-10-08T00:00:00.000Z', digest: createHash('sha256').update(await readFile(file, 'utf8')).digest('hex') });
    }
    const journal = JSON.parse(await readFile(join(f.root, 'customer-packs.json'), 'utf8')); journal.installs[f.pack.id].proposalReceipts = receipts;
    await writeFile(join(f.root, 'customer-packs.json'), JSON.stringify(journal));
    const listed = await service.proposals();
    expect(listed.proposals.map(item => item.id)).toEqual([ids[2000]]); expect(listed.hasMore).toBe(false);
  }, 60_000);
  it('never resumes from a worker copy that changed after approval', async () => {
    const f = await installedFixture(), workspaceId = randomUUID(), improved = `${f.baseline}\nApproved text.\n`; const file = await stage(f.root, improved);
    const reset = f.options.resetRecipeApprovals;
    const failing = createCustomerPackService({ ...scoped(f, workspaceId), resetRecipeApprovals: expected => { reset(expected); throw new Error('Synthetic interruption after durable plan reset'); } });
    const item = (await failing.proposals()).proposals[0];
    await expect(failing.reviewProposal({ id: item.id, pendingDigest: item.pendingDigest, currentDigest: item.currentDigest, decision: 'approve' })).rejects.toThrow(/interruption/);
    await writeFile(file, JSON.stringify({ changed: true }));
    await expect(createCustomerPackService(scoped(f, workspaceId)).handle('/api/customer-packs/austin-office/recover-instructions', 'POST', { expectedDigest: f.preview.digest })).rejects.toMatchObject({ status: 409 });
    expect(await readFile(nativePath(f.root), 'utf8')).toBe(f.baseline);
  });
});

describe('planted entries in pending/skills', () => {
  it('never follows a symlink, alias or FIFO staged under a proposal name, and still reviews a plain proposal', async () => {
    const { link, mkdir: mkdirAsync } = await import('node:fs/promises');
    const { execFileSync } = await import('node:child_process');
    const f = await installedFixture(), improved = `${f.baseline}\nList source coverage before priority recommendations.\n`;
    const folder = join(f.root, 'profile/pending/skills'); await mkdirAsync(folder, { recursive: true });
    const protectedFile = join(f.root, 'protected.json');
    await writeFile(protectedFile, JSON.stringify({ id: 'aaaa1111', subsystem: 'skills', action: 'edit', summary: 'planted', origin: 'background_review', created_at: '2026-09-21T00:00:00Z', payload: {} }));
    await symlink(protectedFile, join(folder, 'aaaa1111.json'));
    await link(protectedFile, join(folder, 'bbbb2222.json'));
    // FIFOs are POSIX-only; Windows still proves the link and the alias.
    const fifo = process.platform !== 'win32', planted = fifo ? ['aaaa1111', 'bbbb2222', 'cccc3333'] : ['aaaa1111', 'bbbb2222'];
    if (fifo) execFileSync('mkfifo', [join(folder, 'cccc3333.json')]);
    await stage(f.root, improved);
    const started = Date.now();
    const review = await f.service.proposals();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(review.proposals.map(item => [item.id, item.state])).toEqual([['1234abcd', 'reviewable'], ...planted.map(id => [id, 'unsupported'])]);
    for (const item of review.proposals.slice(1)) expect(item.proposed).toBeNull();
    for (const id of planted) await expect(f.service.reviewProposal({ id, pendingDigest: 'x', currentDigest: 'x', decision: 'reject' })).rejects.toThrow();
    const proposal = review.proposals[0];
    await f.service.reviewProposal({ id: proposal.id, pendingDigest: proposal.pendingDigest, currentDigest: proposal.currentDigest, decision: 'approve' });
    expect(await readFile(nativePath(f.root), 'utf8')).toBe(improved);
    // The planted entries and their target are untouched; the reviewed record is gone.
    expect(await readFile(protectedFile, 'utf8')).toContain('"planted"');
    const { lstat } = await import('node:fs/promises');
    expect((await lstat(join(folder, 'aaaa1111.json'))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(folder, 'bbbb2222.json'))).nlink).toBe(2);
    await expect(lstat(join(folder, '1234abcd.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('pack plan clocks', () => {
  const clockedPack = (revision = 1): CustomerPack => ({ format: 'realbud-customer-pack', version: 1, id: 'fixture-clock', revision, title: 'Fictional clocked office',
    recipes: [{ id: 'wf-fixture-clock-weekly', title: 'Weekly review', description: 'Review the supplied fictional sources each week.', steps: ['Read the supplied fictional sources.'], evidence: 'Source references.',
      capabilities: ['read-files', 'analyse', 'draft'], limits: { maxRuntimeMinutes: 2, maxTurns: 6 }, siteNotes: null, schedule: { time: '08:00', weekdays: [1] }, allowedOrigins: [] }],
    workflows: [{ id: 'weekly', title: 'Weekly review', recipeIds: ['wf-fixture-clock-weekly'], checks: ['input-coverage'] }],
    skills: [{ id: 'fixture-guidance', name: 'Fictional guidance', description: 'Review fictional supplied sources.', instructions: '# Fictional guidance\nRead the source first.\n', license: 'Fictional test license.' }],
    dependencies: { runtime: 'hermes-property', mode: 'supplied-source-preparation', schedules: 'off', permissions: 'local-review-required' } });
  const loopId = 'recipe-wf-fixture-clock-weekly';

  it('imports a signed plan with its clock as a shadow that waits for plan approval', async () => {
    const f = await fixture(), pack = clockedPack();
    // A clock rides only on a RealBud-signed pack.
    await expect(createPackService({ ...f.options, trustedKeys: FICTIONAL_PACK_KEYS }).preview(pack)).rejects.toThrow(/isn't signed by RealBud/);
    await f.service.install(pack, (await f.service.preview(pack)).digest);
    const saved = f.recipes()[0];
    expect(saved).toMatchObject({ id: 'wf-fixture-clock-weekly', status: 'shadow', schedule: { time: '08:00', weekdays: [1] }, planApprovedAt: null, approvedRevision: null });
    const now = Date.UTC(2026, 9, 7, 0, 0), calls: string[] = [];
    const clock = new LoopManager({ file: join(f.root, 'loops.json'), now: () => now, hostTimezone: 'Australia/Brisbane', listRecipes: () => f.recipes(),
      execute: async loop => { calls.push(loop.id); return { ok: true, detail: 'done' }; } });
    try {
      const loop = () => clock.listLoops().find(item => item.id === loopId);
      expect(loop()).toMatchObject({ waitingForPlan: true, enabled: false, nextRunAt: null, evaluatorId: 'recipe', schedule: { time: '08:00', weekdays: [1] } });
      await clock.tick();
      expect(calls).toEqual([]);
      // Only a person's plan approval puts it on the clock.
      Object.assign(saved, { status: 'active', planApprovedAt: now, approvedRevision: saved.revision });
      expect(loop()).toMatchObject({ waitingForPlan: false, enabled: true, nextRunAt: expect.any(Number) });
    } finally { clock.close(); }
  });

  it('refuses a malformed plan clock, and a clocked plan keeps the file-preparation capability limit', () => {
    const variant = (schedule: unknown, capabilities: string[] = ['read-files', 'analyse', 'draft']) => () => {
      const pack = clockedPack(); Object.assign(pack.recipes[0], { schedule, capabilities }); return validateCustomerPack(pack);
    };
    expect(variant({ time: '25:00', weekdays: [1] })).toThrow(/plan schedule in this pack is not valid/);
    expect(variant({ time: '08:00', weekdays: [] })).toThrow(/plan schedule in this pack is not valid/);
    expect(variant({ time: '08:00', weekdays: [1], timezone: 'UTC' })).toThrow(/Unsupported pack fields/);
    expect(variant(undefined)).toThrow();
    expect(variant({ time: '08:00', weekdays: [1] }, ['read-files', 'read-book'])).toThrow(/without website or external-action access/);
    expect(validateCustomerPack(clockedPack()).recipes[0].schedule).toEqual({ time: '08:00', weekdays: [1] });
  });

  it('clears the plan clock on a reviewed upgrade and on rollback', async () => {
    await rm(join(DATA_DIR, 'recipes.json'), { force: true });
    const root = privateTempRoot(join(realpathSync(tmpdir()), 'rb-customer-pack-clock-')); roots.push(root);
    // The real recipe store, so approval resets and pack writes are the production ones.
    const service = createCustomerPackService({ directory: root, profileDirectory: () => join(root, 'profile'), workroomDirectory: () => join(root, 'vault'),
      activeRecipeIds: () => [], learningStatus: () => ({ supported: true, policyReady: true, enabled: true }) });
    const initial = clockedPack(), id = initial.recipes[0].id;
    await service.install(initial, (await service.preview(initial)).digest);
    expect(getRecipe(id)).toMatchObject({ status: 'shadow', schedule: { time: '08:00', weekdays: [1] } });
    const request = (preview: CustomerPackChangePreview) => ({ pack: preview.pack, expectedInstalledDigest: preview.installedDigest,
      expectedInstalledRevision: preview.installedRevision, expectedDigest: preview.digest, expectedPreviewDigest: preview.previewDigest });
    const next = clockedPack(2); next.recipes[0].steps = ['Read the sources and name missing facts.'];
    await service.upgrade(request(await service.previewUpgrade(next)));
    expect(getRecipe(id)).toMatchObject({ status: 'shadow', schedule: null, steps: next.recipes[0].steps, approvedRevision: null });
    // The saved configuration remembers the clock; rolling back to it still arrives without one.
    const rollback = (await service.handle(`/api/customer-packs/${initial.id}/rollback-preview`, 'POST', { installationRevision: 1 }))!.body as CustomerPackChangePreview;
    expect(rollback.canApply).toBe(true);
    const { pack: _pack, ...expected } = request(rollback);
    await service.rollback({ ...expected, packId: initial.id, installationRevision: 1 });
    expect(getRecipe(id)).toMatchObject({ status: 'shadow', schedule: null, steps: initial.recipes[0].steps, approvedRevision: null });
  });
});
