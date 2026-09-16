import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { windowsFilePrivacy } from './windows-file-privacy.ts';
import { writeNewPrivateFile } from './private-file.ts';

vi.mock('./windows-file-privacy.ts', () => ({ windowsFilePrivacy: vi.fn(async () => {}) }));
const roots: string[] = [];
afterEach(async () => { vi.mocked(windowsFilePrivacy).mockReset(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function target() { const root = await mkdtemp(join(tmpdir(), 'realbud-private-write-')); roots.push(root); return join(root, 'secret'); }

it('checks the containing directory, then protects an empty file before writing its content', async () => {
  const path = await target();
  vi.mocked(windowsFilePrivacy).mockImplementation(async (candidate, kind, restrict) => {
    if (kind === 'directory') { expect(candidate).toBe(dirname(path)); expect(restrict).toBeUndefined(); }
    else { expect(candidate).toBe(path); expect(restrict).toBe(true); expect(await readFile(path, 'utf8')).toBe(''); }
  });
  await writeNewPrivateFile(path, 'fictional test secret');
  expect(await readFile(path, 'utf8')).toBe('fictional test secret');
  expect(windowsFilePrivacy).toHaveBeenCalledTimes(2);
  if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
});

it('never creates a file if the containing directory fails privacy verification', async () => {
  const path = await target(); vi.mocked(windowsFilePrivacy).mockRejectedValue(new Error('private directory required'));
  await expect(writeNewPrivateFile(path, 'must not be written')).rejects.toThrow('private directory required');
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('removes its empty new file if file privacy fails without writing the secret', async () => {
  const path = await target();
  vi.mocked(windowsFilePrivacy).mockImplementation(async (_, kind) => { if (kind === 'file') { expect(await readFile(path, 'utf8')).toBe(''); throw new Error('ACL verification failed'); } });
  await expect(writeNewPrivateFile(path, 'must not be written')).rejects.toThrow('ACL verification failed');
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses an existing file without changing its content or ACL', async () => {
  const path = await target(); await writeFile(path, 'preserve this', { mode: 0o600 });
  await expect(writeNewPrivateFile(path, 'replacement')).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(path, 'utf8')).toBe('preserve this');
  expect(windowsFilePrivacy).toHaveBeenCalledTimes(1);
});
