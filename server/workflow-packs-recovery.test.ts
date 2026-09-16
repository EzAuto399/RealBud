import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
const diskFault = vi.hoisted(() => ({ fail: false }));
vi.mock('./atomic.ts', async (original) => {
  const actual = await original<typeof import('./atomic.ts')>();
  return { ...actual, writeFileAtomic: (...args: Parameters<typeof actual.writeFileAtomic>) => {
    if (diskFault.fail) throw Object.assign(new Error('simulated disk write failure'), { code: 'ENOSPC' });
    return actual.writeFileAtomic(...args);
  } };
});
const dataDir = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR || '/tmp'}/realbud-pack-recovery-${process.pid}-${Date.now()}`;
  process.env.REALBUD_DATA_DIR = dir;
  return dir;
});
const { getRecipe, saveRecipe, saveRecipesAtomically, patchRecipe, listRecipes, recipeClockRunnable } = await import('./recipes.ts');
const { installAustinPhase1Packs, installWorkflowPack, exportWorkflowPacks, importWorkflowPacks, listWorkflowPackStatus } = await import('./workflow-packs.ts');
const id = 'wf-austin-expected-bills';
const bytes = () => readFileSync(join(dataDir, 'recipes.json'), 'utf8');
beforeEach(() => { diskFault.fail = false; rmSync(dataDir, { recursive: true, force: true }); mkdirSync(dataDir, { recursive: true }); });
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
function editedPack() {
  installAustinPhase1Packs();
  saveRecipe({ ...getRecipe(id)!, title: 'Kevin reviewed this plan', schedule: { time: '10:15', weekdays: [2, 4] }, siteNotes: 'Only office-approved sources' });
  patchRecipe(id, { planApproved: true });
  return getRecipe(id)!;
}
describe('pack restore uses the real recipe store', () => {
  it('refresh preserves the complete edited and approved local plan', () => {
    const before = editedPack(); const disk = bytes();
    installAustinPhase1Packs();
    expect(getRecipe(id)).toEqual(before);
    expect(bytes()).toBe(disk);
  });
  it('restores fields but never imported approval, attachment or submit authority', () => {
    editedPack(); const snapshot = exportWorkflowPacks();
    snapshot.recipes[0].attachment = { attachedAt: Date.now(), acknowledged: 'human-login-and-submit' };
    snapshot.recipes[0].submitAcknowledgedAt = Date.now();
    rmSync(join(dataDir, 'recipes.json'));
    importWorkflowPacks(snapshot);
    const restored = getRecipe(id)!;
    expect(restored.schedule?.time).toBe('10:15');
    expect(restored.siteNotes).toBe('Only office-approved sources');
    expect(restored.status).toBe('shadow');
    expect(restored.planApprovedAt).toBeNull();
    expect(restored.approvedRevision).toBeNull();
    expect(restored.attachment).toBeNull();
    expect(restored.submitAcknowledgedAt).toBeNull();
    expect(recipeClockRunnable(restored)).toBe(false);
  });
  it('rejects a malformed later recipe without modifying any local recipe', () => {
    editedPack(); const snapshot = exportWorkflowPacks(); const disk = bytes();
    snapshot.recipes[0].title = 'Should not be saved';
    snapshot.recipes[1].steps = [];
    expect(() => importWorkflowPacks(snapshot)).toThrow();
    expect(bytes()).toBe(disk);
  });
  it('rejects an incomplete payload without installing anything', () => {
    expect(() => importWorkflowPacks({ version: 1 })).toThrow();
    expect(listRecipes()).toEqual([]);
  });
  it('rejects conflicting local edits instead of overwriting them', () => {
    editedPack(); const snapshot = exportWorkflowPacks(); const disk = bytes();
    snapshot.recipes[0].description += ' stale imported instruction';
    expect(() => importWorkflowPacks(snapshot)).toThrow(/conflict|differs|changed/i);
    expect(bytes()).toBe(disk);
  });
  it('restores custom exported wf jobs without installing unrelated packs', () => {
    installWorkflowPack('austin-expected-bills');
    saveRecipe({ ...getRecipe(id)!, id: 'wf-office-custom', title: 'Custom office work', schedule: null });
    const snapshot = exportWorkflowPacks(); rmSync(join(dataDir, 'recipes.json'));
    importWorkflowPacks(snapshot);
    expect(getRecipe('wf-office-custom')?.title).toBe('Custom office work');
    expect(listRecipes()).toHaveLength(2);
    expect(listWorkflowPackStatus().find(p => p.id === 'austin-payment-prep')?.installed).toBe(false);
  });
  it('leaves corrupt saved recipes intact for recovery', () => {
    writeFileSync(join(dataDir, 'recipes.json'), '{broken');
    expect(() => installAustinPhase1Packs()).toThrow(/recovery|read|repair/i);
    expect(bytes()).toBe('{broken');
  });
});


describe('restore boundaries and recovery', () => {
  it('repeated identical restore preserves local approval and exact bytes', () => {
    editedPack(); const snapshot = exportWorkflowPacks(); const before = bytes();
    importWorkflowPacks(snapshot); importWorkflowPacks(snapshot);
    expect(bytes()).toBe(before);
  });
  it.each([
    (s: any) => s.recipes.push(s.recipes[0]),
    (s: any) => s.recipes[0].id = '../recipes',
    (s: any) => s.recipes[0].schedule = { time: '25:99', weekdays: [8] },
    (s: any) => s.recipes[0].capabilities = ['pay'],
    (s: any) => s.recipes[0].allowedOrigins = ['invalid host'],
    (s: any) => s.recipes[0].limits.maxRuntimeMinutes = 999,
    (s: any) => s.recipes = Array.from({ length: 101 }, () => s.recipes[0]),
    (s: any) => s.recipes[0] = null,
  ])('rejects invalid rows without changing the saved office', mutate => {
    editedPack(); const snapshot = exportWorkflowPacks(); const before = bytes();
    mutate(snapshot);
    expect(() => importWorkflowPacks(snapshot)).toThrow();
    expect(bytes()).toBe(before);
  });
  it('ignores untrusted install metadata; derives status from actual jobs', () => {
    installWorkflowPack('austin-expected-bills'); const snapshot = exportWorkflowPacks();
    snapshot.installs = JSON.parse('{"__proto__":{"polluted":true},"austin-payment-prep":{"installedAt":99}}');
    rmSync(join(dataDir, 'recipes.json'));
    importWorkflowPacks(snapshot);
    expect(listWorkflowPackStatus().find(p => p.id === 'austin-payment-prep')?.installed).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it('survives a failed durable write and retries without partial recipes', () => {
    installWorkflowPack('austin-expected-bills'); const before = bytes();
    diskFault.fail = true;
    expect(() => installAustinPhase1Packs()).toThrow(/disk write/);
    expect(bytes()).toBe(before);
    diskFault.fail = false;
    expect(installAustinPhase1Packs().every(p => p.installed)).toBe(true);
    expect(listRecipes()).toHaveLength(2);
  });
  it('checks every saved revision before the atomic write', () => {
    editedPack(); const before = bytes(); const current = getRecipe(id)!;
    expect(() => saveRecipesAtomically([
      { ...current, id: 'wf-new-job', expectedRevision: 0 },
      { ...current, title: 'Stale edit', expectedRevision: current.revision - 1 },
    ])).toThrow(/changed elsewhere/);
    expect(bytes()).toBe(before);
  });
  it.each(['{}', '{"recipes":[{}]}'])('preserves invalid stored records (%s)', corrupt => {
    writeFileSync(join(dataDir, 'recipes.json'), corrupt);
    expect(() => installAustinPhase1Packs()).toThrow(/recovery/);
    expect(bytes()).toBe(corrupt);
  });
});
