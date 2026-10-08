/** Canonical worker facts: import, projection and preservation. Synthetic profiles only. */
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { capturePendingSkill, importLegacyProfileFacts, projectProfileFacts, readPendingSkill, readWorkerState, retireRepairedArtifacts,
  updateWorkerState, workerScope, workerScopeId, workerStateFile } from './worker-state.ts';

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

  it('captures an office edit made after the last projection, and preserves a worker copy that conflicts with a RealBud change', async () => {
    const f = await fixture(); await importLegacyProfileFacts([f.scope], { dataDir: f.data });
    await f.write('skills/office-notes/SKILL.md', '# Notes v2\n');
    expect((await projectProfileFacts(f.scope, { dataDir: f.data })).captured).toEqual(['skills/office-notes/SKILL.md']);
    expect(await f.canonical('skills/office-notes/SKILL.md')).toBe('# Notes v2\n');
    // RealBud changes memory canonically; the worker copy also changed meanwhile.
    await updateWorkerState(f.scope, null, draft => { draft.artifacts['memories/MEMORY.md'] = { digest: sha('RealBud decision.'), base64: Buffer.from('RealBud decision.').toString('base64'), source: 'realbud', at: 2 }; }, f.data);
    await f.write('memories/MEMORY.md', 'Worker wrote this directly.');
    const result = await projectProfileFacts(f.scope, { dataDir: f.data });
    expect(result.preserved).toEqual(['memories/MEMORY.md']); expect(await f.read('memories/MEMORY.md')).toBe('Worker wrote this directly.');
    expect((await f.state()).preserved).toEqual([expect.objectContaining({ key: 'memories/MEMORY.md', reason: 'worker-changed', digest: sha('Worker wrote this directly.') })]);
    // Once the worker copy is back to what RealBud last projected, the RealBud change lands.
    await f.write('memories/MEMORY.md', 'Prefers concise updates.');
    expect((await projectProfileFacts(f.scope, { dataDir: f.data })).written).toEqual(['memories/MEMORY.md']);
    expect(await f.read('memories/MEMORY.md')).toBe('RealBud decision.');
  });

  it('keeps an explicit Repair: the replaced office SOUL is preserved and not restored', async () => {
    const f = await fixture(); await importLegacyProfileFacts([f.scope], { dataDir: f.data });
    await retireRepairedArtifacts(f.scope, ['SOUL.md'], { dataDir: f.data });
    await f.write('SOUL.md', 'Shipped.\n');
    await projectProfileFacts(f.scope, { dataDir: f.data, shipped: { has: (key, digest) => key === 'SOUL.md' && digest === sha('Shipped.\n') } });
    expect(await f.read('SOUL.md')).toBe('Shipped.\n');
    expect((await f.state()).preserved).toEqual([expect.objectContaining({ key: 'SOUL.md', reason: 'repair-replaced', digest: sha('Office voice.\n') })]);
  });
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
    await capturePendingSkill(f.scope, '0000cafe', Buffer.from('{"note":"token = \\"sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD\\""}'), { dataDir: f.data });
    expect(await readPendingSkill(f.scope, '0000cafe', f.data)).toBeNull(); expect(JSON.stringify(await f.state())).not.toContain('sk-proj');
  });
});
