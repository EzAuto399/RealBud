/** Canonical worker facts: import, projection and preservation. Synthetic profiles only. */
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { capturePendingSkill, importLegacyProfileFacts, memoryHeldForLaunch, projectProfileFacts, readPendingSkill, readWorkerState, retireRepairedArtifacts,
  updateWorkerState, workerScope, workerScopeId, workerStateFile, WORKER_SCOPE_BYTES, WORKER_STATE_MAX_BYTES } from './worker-state.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'realbud-worker-state-'))); roots.push(root);
  const profile = join(root, 'hermes', 'profiles', 'property'), data = join(root, 'data');
  await mkdir(join(profile, 'memories'), { recursive: true, mode: 0o700 }); await mkdir(join(profile, 'skills', 'office-notes'), { recursive: true, mode: 0o700 });
  await mkdir(join(profile, 'skills', 'realbud-pack-skill'), { recursive: true, mode: 0o700 }); await mkdir(join(profile, 'pending', 'skills'), { recursive: true, mode: 0o700 });
  const write = (rel: string, text: string) => writeFile(join(profile, ...rel.split('/')), text, { mode: 0o600 });
  await write('memories/MEMORY.md', 'Prefers concise updates.'); await write('SOUL.md', 'Office voice.\n'); await write('skills/office-notes/SKILL.md', '# Notes\n');
  await write('skills/realbud-pack-skill/SKILL.md', '# Pack-owned\n'); await write('config.yaml', 'memory:\n  write_approval: true\n'); await write('.env', 'FICTIONAL_ONLY=1\n');
  await write('pending/skills/0000abcd.json', '{"id":"0000abcd","subsystem":"skills"}');
  const scope = workerScope(randomUUID(), 'property', profile);
  return { root, profile, data, scope, write, read: (rel: string) => readFile(join(profile, ...rel.split('/')), 'utf8'),
    state: () => readWorkerState(scope, data), canonical: async (key: string) => { const row = (await readWorkerState(scope, data)).artifacts[key]; return row ? Buffer.from(row.base64, 'base64').toString() : undefined; } };
}

describe('worker scope', () => {
  it('derives only from workspace and member profile, and refuses anything else', () => {
    const id = workerScopeId('11111111-2222-4333-8444-555555555555', 'property');
    expect(id).toMatch(/^[a-f0-9]{32}$/); expect(workerScopeId('11111111-2222-4333-8444-555555555555', 'property-member')).not.toBe(id);
    expect(() => workerScopeId('../escape', 'property')).toThrow(); expect(() => workerScopeId('11111111-2222-4333-8444-555555555555', '../property')).toThrow();
    expect(workerStateFile({ workspaceId: '11111111-2222-4333-8444-555555555555', scopeId: id }, '/synthetic/data')).toBe(join('/synthetic/data', 'worker-state', '11111111-2222-4333-8444-555555555555', id, 'state.json'));
  });
});

describe('legacy import', () => {
  it('copies facts, skips credentials files and pack-owned skills, never deletes the worker copy, and is idempotent', async () => {
    const f = await fixture();
    const [first] = await importLegacyProfileFacts([f.scope], { dataDir: f.data, shipped: { has: () => false } });
    expect(first).toMatchObject({ complete: true, skipped: false });
    const state = await f.state();
    expect(Object.keys(state.artifacts).sort()).toEqual(['SOUL.md', 'memories/MEMORY.md', 'pending/skills/0000abcd.json', 'skills/office-notes/SKILL.md']);
    expect(state.migration).toMatchObject({ complete: true }); expect(state.projected['memories/MEMORY.md']).toBe(sha('Prefers concise updates.'));
    expect(await f.read('memories/MEMORY.md')).toBe('Prefers concise updates.'); expect(await f.read('.env')).toBe('FICTIONAL_ONLY=1\n');
    const again = await importLegacyProfileFacts([f.scope], { dataDir: f.data });
    expect(again[0]).toMatchObject({ skipped: true }); expect((await f.state()).revision).toBe(state.revision);
  });

  it('keeps newer canonical data and preserves a differing worker copy beside it', async () => {
    const f = await fixture();
    await updateWorkerState(f.scope, null, draft => { draft.artifacts['memories/MEMORY.md'] = { digest: sha('RealBud copy.'), base64: Buffer.from('RealBud copy.').toString('base64'), source: 'realbud', at: 1 }; }, f.data);
    await importLegacyProfileFacts([f.scope], { dataDir: f.data });
    const state = await f.state();
    expect(await f.canonical('memories/MEMORY.md')).toBe('RealBud copy.');
    expect(state.preserved).toEqual([expect.objectContaining({ key: 'memories/MEMORY.md', reason: 'import-differs', digest: sha('Prefers concise updates.') })]);
  });

  it('never captures credential-bearing bytes and holds unsafe links, recording only a digest', async () => {
    const f = await fixture();
    await f.write('skills/office-notes/SKILL.md', 'Use api_key = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD" here.\n');
    await rm(join(f.profile, 'SOUL.md')); await writeFile(join(f.root, 'outside.md'), 'Outside.', { mode: 0o600 }); await link(join(f.root, 'outside.md'), join(f.profile, 'SOUL.md'));
    await importLegacyProfileFacts([f.scope], { dataDir: f.data });
    const state = await f.state(), text = JSON.stringify(state);
    expect(state.artifacts['skills/office-notes/SKILL.md']).toBeUndefined(); expect(state.artifacts['SOUL.md']).toBeUndefined();
    expect(state.held.map(row => [row.key, row.reason]).sort()).toEqual([['SOUL.md', 'unsafe'], ['skills/office-notes/SKILL.md', 'credential']]);
    expect(text).not.toContain('sk-proj'); expect(text).not.toContain('Outside');
  });
});

describe('projection', () => {
  it('regenerates a deleted worker folder from canonical facts and leaves shipped bytes to the pack', async () => {
    const f = await fixture(); await importLegacyProfileFacts([f.scope], { dataDir: f.data });
    await rm(join(f.root, 'hermes'), { recursive: true });
    expect(await projectProfileFacts(f.scope, { dataDir: f.data })).toMatchObject({ skipped: 'profile-missing' });
    // A fresh install writes the shipped SOUL; RealBud restores the office edit over it.
    await mkdir(f.profile, { recursive: true, mode: 0o700 }); await f.write('SOUL.md', 'Shipped.\n');
    const result = await projectProfileFacts(f.scope, { dataDir: f.data, shipped: { has: (key, digest) => key === 'SOUL.md' && digest === sha('Shipped.\n') } });
    expect(result.written.sort()).toEqual(['SOUL.md', 'memories/MEMORY.md', 'skills/office-notes/SKILL.md']);
    expect(await f.read('SOUL.md')).toBe('Office voice.\n'); expect(await f.read('memories/MEMORY.md')).toBe('Prefers concise updates.');
    expect(await f.read('skills/office-notes/SKILL.md')).toBe('# Notes\n');
  });

  it('never promotes a worker-created skill or worker-changed SOUL; both are held for review and not re-projected', async () => {
    const f = await fixture(); await importLegacyProfileFacts([f.scope], { dataDir: f.data });
    await mkdir(join(f.profile, 'skills', 'worker-made'), { recursive: true, mode: 0o700 });
    await f.write('skills/worker-made/SKILL.md', '# Worker-made\n'); await f.write('SOUL.md', 'Worker rewrote the voice.\n');
    const result = await projectProfileFacts(f.scope, { dataDir: f.data });
    expect(result.held.sort()).toEqual(['SOUL.md', 'skills/worker-made/SKILL.md']); expect(result.written).toEqual([]);
    const state = await f.state();
    expect(state.artifacts['skills/worker-made/SKILL.md']).toBeUndefined(); expect(await f.canonical('SOUL.md')).toBe('Office voice.\n');
    expect(state.preserved.map(row => [row.key, row.reason]).sort()).toEqual([['SOUL.md', 'worker-changed'], ['skills/worker-made/SKILL.md', 'worker-changed']]);
    // Repeating the turn stores nothing new; a regenerated worker folder gets only canonical facts.
    await projectProfileFacts(f.scope, { dataDir: f.data }); expect((await f.state()).preserved).toHaveLength(2);
    await rm(join(f.root, 'hermes'), { recursive: true }); await mkdir(f.profile, { recursive: true, mode: 0o700 });
    await projectProfileFacts(f.scope, { dataDir: f.data });
    expect(await f.read('SOUL.md')).toBe('Office voice.\n'); await expect(f.read('skills/worker-made/SKILL.md')).rejects.toThrow();
  });

  it('keeps an explicit Repair: the replaced office SOUL is preserved and not restored', async () => {
    const f = await fixture(); await importLegacyProfileFacts([f.scope], { dataDir: f.data });
    await retireRepairedArtifacts(f.scope, ['SOUL.md'], { dataDir: f.data });
    await f.write('SOUL.md', 'Shipped.\n');
    await projectProfileFacts(f.scope, { dataDir: f.data, shipped: { has: (key, digest) => key === 'SOUL.md' && digest === sha('Shipped.\n') } });
    expect(await f.read('SOUL.md')).toBe('Shipped.\n');
    expect((await f.state()).preserved).toEqual([expect.objectContaining({ key: 'SOUL.md', reason: 'repair-replaced', digest: sha('Office voice.\n') })]);
  });
  it('turns a worker-side memory edit into a proposal and returns the worker copy to the approved memory', async () => {
    const f = await fixture(); await importLegacyProfileFacts([f.scope], { dataDir: f.data });
    await f.write('memories/MEMORY.md', 'Prefers concise updates.\n§\nWorker added this itself.');
    const result = await projectProfileFacts(f.scope, { dataDir: f.data });
    expect(result).toMatchObject({ held: ['memories/MEMORY.md'], written: ['memories/MEMORY.md'] });
    expect(await f.canonical('memories/MEMORY.md')).toBe('Prefers concise updates.'); expect(await f.read('memories/MEMORY.md')).toBe('Prefers concise updates.');
    const staged = Object.entries((await f.state()).artifacts).filter(([key]) => key.startsWith('pending/memory/'));
    expect(staged).toHaveLength(1);
    expect(JSON.parse(Buffer.from(staged[0][1].base64, 'base64').toString()).payload).toEqual({ action: 'add', target: 'memory', content: 'Worker added this itself.' });
  });

  it('does nothing before the trusted import completes, and the import never runs twice', async () => {
    const f = await fixture();
    expect(await projectProfileFacts(f.scope, { dataDir: f.data })).toMatchObject({ skipped: 'migration-incomplete' });
    await importLegacyProfileFacts([f.scope], { dataDir: f.data });
    await f.write('skills/office-notes/SKILL.md', '# Worker rewrite\n');
    expect(await importLegacyProfileFacts([f.scope], { dataDir: f.data })).toMatchObject([{ skipped: true }]);
    expect(await f.canonical('skills/office-notes/SKILL.md')).toBe('# Notes\n');
  });
});

describe('shared caps', () => {
  it('keeps 1,000 planted files and one huge file out of the store as digest-only holds', async () => {
    const f = await fixture(), filler = 'x'.repeat(20_000);
    for (let i = 0; i < 1000; i++) {
      await mkdir(join(f.profile, 'skills', `planted-${i}`), { recursive: true, mode: 0o700 });
      await f.write(`skills/planted-${i}/SKILL.md`, `${i} ${filler}`);
    }
    await f.write('skills/office-notes/SKILL.md', 'y'.repeat(3 * 1024 * 1024));
    await importLegacyProfileFacts([f.scope], { dataDir: f.data });
    const state = await f.state(), size = (await readFile(workerStateFile(f.scope, f.data))).length;
    const content = [...Object.entries(state.artifacts).filter(([key]) => !key.startsWith('memories/')).map(([, row]) => row.base64), ...state.preserved.map(row => row.base64)]
      .reduce((total, base64) => total + Buffer.from(base64, 'base64').length, 0);
    expect(content).toBeLessThanOrEqual(WORKER_SCOPE_BYTES); expect(size).toBeLessThan(WORKER_STATE_MAX_BYTES);
    expect(state.held.find(row => row.key === 'skills/office-notes/SKILL.md')).toMatchObject({ reason: 'capacity', bytes: 3 * 1024 * 1024 });
    expect(state.held.filter(row => row.reason === 'capacity').length).toBeGreaterThan(100);
    for (const row of state.held) expect(Object.keys(row).sort()).toEqual(['at', 'bytes', 'digest', 'key', 'reason']);
    // Every later turn reads a capped list and stores nothing new beyond the cap.
    for (let i = 0; i < 3; i++) await projectProfileFacts(f.scope, { dataDir: f.data });
    expect((await readFile(workerStateFile(f.scope, f.data))).length).toBeLessThan(WORKER_STATE_MAX_BYTES);
    expect((await f.state()).preserved.length).toBeLessThanOrEqual(200);
  }, 60_000);
});

describe('pending skills', () => {
  it('reads a captured record after the worker copy is gone and never replaces a different one', async () => {
    const f = await fixture(); const bytes = Buffer.from('{"id":"0000beef","subsystem":"skills"}');
    expect(await capturePendingSkill(f.scope, '0000beef', bytes, { dataDir: f.data })).toBe(sha(bytes.toString()));
    await rm(join(f.root, 'hermes'), { recursive: true });
    expect(await readPendingSkill(f.scope, '0000beef', f.data)).toEqual({ bytes, digest: sha(bytes.toString()) });
    await expect(capturePendingSkill(f.scope, '0000beef', Buffer.from('{"changed":true}'), { dataDir: f.data })).rejects.toMatchObject({ code: 'conflict' });
    expect((await readPendingSkill(f.scope, '0000beef', f.data))?.bytes).toEqual(bytes);
    expect(await readPendingSkill(f.scope, '../escape', f.data)).toBeNull();
    // A refusal is explicit to the caller and recorded as a digest-only hold.
    await expect(capturePendingSkill(f.scope, '0000cafe', Buffer.from('{"note":"token = \\"sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD\\""}'), { dataDir: f.data })).rejects.toMatchObject({ code: 'credential', status: 409 });
    expect(await readPendingSkill(f.scope, '0000cafe', f.data)).toBeNull(); expect(JSON.stringify(await f.state())).not.toContain('sk-proj');
    expect((await f.state()).held).toEqual([expect.objectContaining({ key: 'pending/skills/0000cafe.json', reason: 'credential' })]);
  });
});

describe('one bad file never blocks the scope', () => {
  it('restores the last good saved scope when the current file is damaged', async () => {
    const f = await fixture(); await importLegacyProfileFacts([f.scope], { dataDir: f.data });
    await projectProfileFacts(f.scope, { dataDir: f.data });
    await writeFile(workerStateFile(f.scope, f.data), '{"damaged":', { mode: 0o600 });
    expect(await f.canonical('memories/MEMORY.md')).toBe('Prefers concise updates.');
  });

  it('holds only the file whose worker folder is unusable during projection', async () => {
    const f = await fixture(); await importLegacyProfileFacts([f.scope], { dataDir: f.data });
    await rm(join(f.profile, 'memories', 'MEMORY.md'));
    await mkdir(join(f.root, 'elsewhere'), { recursive: true, mode: 0o700 });
    await rm(join(f.profile, 'skills', 'office-notes'), { recursive: true }); await symlink(join(f.root, 'elsewhere'), join(f.profile, 'skills', 'office-notes'));
    const result = await projectProfileFacts(f.scope, { dataDir: f.data });
    expect(result.written).toEqual(['memories/MEMORY.md']); expect(result.held).toContain('skills/office-notes/SKILL.md');
    expect(await f.read('memories/MEMORY.md')).toBe('Prefers concise updates.');
    expect((await f.state()).held.some(row => row.key === 'skills/office-notes/SKILL.md' && row.reason === 'unsafe')).toBe(true);
  });

  it('completes the import when worker-planted refusals overflow the bounded hold list', async () => {
    const f = await fixture();
    for (let i = 0; i < 1200; i++) await f.write(`pending/skills/${i.toString(16).padStart(8, '0')}.json`, `{"note":"token = \\"sk-proj-${'a'.repeat(30)}${i}\\""}`);
    expect(await importLegacyProfileFacts([f.scope], { dataDir: f.data })).toMatchObject([{ complete: true }]);
    const state = await f.state();
    expect(state.held.length).toBeLessThanOrEqual(1000); expect(await f.canonical('memories/MEMORY.md')).toBe('Prefers concise updates.');
  }, 30_000);
});

describe('capped listings are recorded', () => {
  it('notes a capped skill discovery as a hold instead of silently skipping files', async () => {
    const f = await fixture(); await importLegacyProfileFacts([f.scope], { dataDir: f.data });
    for (let i = 0; i < 70; i++) { await mkdir(join(f.profile, 'skills', `extra-${i}`), { recursive: true, mode: 0o700 }); await f.write(`skills/extra-${i}/SKILL.md`, `# ${i}\n`); }
    const result = await projectProfileFacts(f.scope, { dataDir: f.data });
    expect(result.discoveryCapped).toBe(true);
    expect((await f.state()).held).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'skills', reason: 'capacity' })]));
  });
});

describe('a cap never destroys the only copy', () => {
  const fill = async (f: Awaited<ReturnType<typeof fixture>>, entries: number) => updateWorkerState(f.scope, null, draft => {
    for (let i = 0; draft.preserved.length + Object.keys(draft.artifacts).length < entries; i++) draft.artifacts[`skills/filler-${i}/SKILL.md`] = { digest: createHash('sha256').update(`f${i}`).digest('hex'), base64: Buffer.from(`f${i}`).toString('base64'), source: 'office', at: 1 };
  }, f.data);
  it('leaves an unkept worker memory edit in place at 3,000 entries, held and blocking launch', async () => {
    // 3,000 stored entries besides the memory file: the cap is reached.
    const f = await fixture(); await importLegacyProfileFacts([f.scope], { dataDir: f.data }); await fill(f, 3001);
    await f.write('memories/MEMORY.md', 'Prefers concise updates.\n§\nEdit RealBud could not keep.');
    const result = await projectProfileFacts(f.scope, { dataDir: f.data, keys: ['memories/MEMORY.md'] });
    expect(result.written).toEqual([]); expect(result.blocking).toEqual(['memories/MEMORY.md']);
    expect(await f.read('memories/MEMORY.md')).toBe('Prefers concise updates.\n§\nEdit RealBud could not keep.');
    expect((await f.state()).held).toEqual(expect.arrayContaining([expect.objectContaining({ key: expect.stringMatching(/^pending\/memory\//), reason: 'capacity' })]));
    expect(await memoryHeldForLaunch(f.scope, f.data)).toEqual(['memories/MEMORY.md']);
    await f.write('memories/MEMORY.md', 'Prefers concise updates.'); expect(await memoryHeldForLaunch(f.scope, f.data)).toEqual([]);
  });
  it('blocks launch while a memory file is unsafe or too large to read', async () => {
    const f = await fixture(); await importLegacyProfileFacts([f.scope], { dataDir: f.data });
    await f.write('memories/USER.md', 'x'.repeat(200 * 1024));
    expect((await projectProfileFacts(f.scope, { dataDir: f.data })).blocking).toEqual(['memories/USER.md']);
    expect(await memoryHeldForLaunch(f.scope, f.data)).toEqual(['memories/USER.md']);
  });
  it('keeps the office SOUL canonical when Repair cannot preserve it (200 preserved copies)', async () => {
    const f = await fixture(); await importLegacyProfileFacts([f.scope], { dataDir: f.data });
    await updateWorkerState(f.scope, null, draft => { for (let i = 0; draft.preserved.length < 200; i++) draft.preserved.push({ key: `skills/old-${i}/SKILL.md`, digest: createHash('sha256').update(`p${i}`).digest('hex'), base64: Buffer.from(`p${i}`).toString('base64'), reason: 'worker-changed', at: 1 }); }, f.data);
    expect(await retireRepairedArtifacts(f.scope, ['SOUL.md'], { dataDir: f.data })).toEqual({ retired: [], kept: ['SOUL.md'] });
    expect(await f.canonical('SOUL.md')).toBe('Office voice.\n');
    expect((await f.state()).held).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'SOUL.md', reason: 'capacity' })]));
  });
});
