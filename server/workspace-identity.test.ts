import { afterEach, describe, expect, it } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkspaceIdentity } from './workspace-identity.ts';
import { plantPrivateFile, privateTempRoot, removeFixture } from './testing/private-fixture.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeFixture(root); });
// The data folder and a saved seat stand in for what the product itself creates.
async function root() { const dir = privateTempRoot(join(tmpdir(), 'rb-workspace-')); roots.push(dir); return dir; }
describe('stable private workspace', () => {
  it('keeps the solo worker when joining and restarting, without copying credentials', async () => {
    const dir = await root(); const initial = await loadWorkspaceIdentity(dir);
    expect(initial.workerMemberKey).toBeNull();
    plantPrivateFile(join(dir, 'seat.json'), JSON.stringify({ version: 1, memberId: 'new-member-123' }));
    expect(await loadWorkspaceIdentity(dir)).toEqual(initial);
  });
  it('adopts an existing member profile once and retains it after detachment', async () => {
    const dir = await root(); plantPrivateFile(join(dir, 'seat.json'), JSON.stringify({ version: 1, memberId: 'legacy-member-123' }));
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
    const dir = await root(); plantPrivateFile(join(dir, 'seat.json'), '{"version":999}');
    await expect(loadWorkspaceIdentity(dir)).rejects.toThrow(/needs recovery/);
  });
});
