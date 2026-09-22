import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkspaceIdentity } from './workspace-identity.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const dir = await mkdtemp(join(tmpdir(), 'rb-workspace-')); roots.push(dir); return dir; }
describe('stable private workspace', () => {
  it('keeps the solo worker when joining and restarting, without copying credentials', async () => {
    const dir = await root(); const initial = await loadWorkspaceIdentity(dir);
    expect(initial.workerMemberKey).toBeNull();
    await writeFile(join(dir, 'seat.json'), JSON.stringify({ version: 1, memberId: 'new-member-123' }), { mode: 0o600 });
    expect(await loadWorkspaceIdentity(dir)).toEqual(initial);
  });
  it('adopts an existing member profile once and retains it after detachment', async () => {
    const dir = await root(); await writeFile(join(dir, 'seat.json'), JSON.stringify({ version: 1, memberId: 'legacy-member-123' }), { mode: 0o600 });
    const identity = await loadWorkspaceIdentity(dir); expect(identity.workerMemberKey).toBe('legacy-member-123');
    await rm(join(dir, 'seat.json')); expect(await loadWorkspaceIdentity(dir)).toEqual(identity);
  });
  it('refuses corruption and a changed operator override instead of falling back', async () => {
    const dir = await root(); await loadWorkspaceIdentity(dir, 'first-person');
    await expect(loadWorkspaceIdentity(dir, 'other-person')).rejects.toThrow(/does not match/);
    await writeFile(join(dir, 'workspace.json'), 'null');
    await expect(loadWorkspaceIdentity(dir)).rejects.toThrow(/needs recovery/);
  });
  it('does not overwrite malformed legacy identity', async () => {
    const dir = await root(); await writeFile(join(dir, 'seat.json'), '{"version":999}', { mode: 0o600 });
    await expect(loadWorkspaceIdentity(dir)).rejects.toThrow(/needs recovery/);
  });
});
