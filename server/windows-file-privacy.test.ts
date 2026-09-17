import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { windowsFilePrivacy } from './windows-file-privacy.ts';
import { writeNewPrivateFile } from './private-file.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'realbud-native-acl-')); roots.push(root); await windowsFilePrivacy(root, 'directory', true); return root; }

it.skipIf(process.platform === 'win32')('does not run Windows ACL operations on another OS', async () => {
  await expect(windowsFilePrivacy('/no-file-is-accessed', 'file')).resolves.toBeUndefined();
});

describe.skipIf(process.platform !== 'win32')('native Windows privacy admission', () => {
  it('admits a newly protected directory and a file protected before content is written', async () => {
    const root = await fixture(); const path = join(root, 'secret.txt');
    await writeNewPrivateFile(path, 'fictional credential');
    await expect(windowsFilePrivacy(root, 'directory')).resolves.toBeUndefined();
    await expect(windowsFilePrivacy(path, 'file')).resolves.toBeUndefined();
    expect(await readFile(path, 'utf8')).toBe('fictional credential');
  });
  it('rejects an inherited, unprotected existing file without repairing it', async () => {
    const root = await fixture(); const path = join(root, 'inherited.txt'); await writeFile(path, 'preserved');
    await expect(windowsFilePrivacy(path, 'file')).rejects.toThrow('could not be verified');
    expect(await readFile(path, 'utf8')).toBe('preserved');
    await expect(windowsFilePrivacy(path, 'file')).rejects.toThrow('could not be verified');
  });
  it('rejects kind mismatch and relative paths', async () => {
    const root = await fixture();
    await expect(windowsFilePrivacy(root, 'file')).rejects.toThrow('could not be verified');
    await expect(windowsFilePrivacy('relative', 'directory')).rejects.toThrow('could not be verified');
  });
  it('rejects a junction and an ancestor junction without touching the target', async () => {
    const root = await fixture(); const target = join(root, 'actual'); await mkdir(target); await windowsFilePrivacy(target, 'directory', true);
    const path = join(target, 'secret.txt'); await writeNewPrivateFile(path, 'preserved');
    const junction = join(root, 'linked'); await symlink(target, junction, 'junction');
    await expect(windowsFilePrivacy(junction, 'directory', true)).rejects.toThrow('could not be verified');
    await expect(windowsFilePrivacy(join(junction, 'secret.txt'), 'file', true)).rejects.toThrow('could not be verified');
    expect(await readFile(path, 'utf8')).toBe('preserved');
    await expect(windowsFilePrivacy(path, 'file')).resolves.toBeUndefined();
  });
});
