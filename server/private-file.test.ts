import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { windowsFilePrivacy } from './windows-file-privacy.ts';
import { admitPrivateObject } from './windows-private-admission.ts';
import { writeNewPrivateFile } from './private-file.ts';

vi.mock('./windows-file-privacy.ts', () => ({ windowsFilePrivacy: vi.fn(async () => {}) }));
// The folder goes through the shared admission (verify, or repair an
// inherited-only descriptor: windows-private-admission.test.ts).
vi.mock('./windows-private-admission.ts', () => ({ admitPrivateObject: vi.fn(async () => false) }));
const roots: string[] = [];
afterEach(async () => { vi.mocked(windowsFilePrivacy).mockReset(); vi.mocked(admitPrivateObject).mockReset(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function target() { const root = await mkdtemp(join(tmpdir(), 'realbud-private-write-')); roots.push(root); return join(root, 'secret'); }

it('checks the containing directory, then protects an empty file before writing its content', async () => {
  const path = await target();
  vi.mocked(windowsFilePrivacy).mockImplementation(async (candidate, kind, restrict) => {
    expect(candidate).toBe(path); expect(kind).toBe('file'); expect(restrict).toBe(true); expect(await readFile(path, 'utf8')).toBe('');
  });
  await writeNewPrivateFile(path, 'fictional test secret');
  expect(await readFile(path, 'utf8')).toBe('fictional test secret');
  expect(admitPrivateObject).toHaveBeenCalledExactlyOnceWith(dirname(path), 'directory', 'A RealBud storage folder');
  expect(windowsFilePrivacy).toHaveBeenCalledTimes(1);
  if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
});

it('never creates a file if the containing directory fails privacy verification', async () => {
  const path = await target(); vi.mocked(admitPrivateObject).mockRejectedValue(new Error('private directory required'));
  await expect(writeNewPrivateFile(path, 'must not be written')).rejects.toThrow('private directory required');
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('removes its empty new file if file privacy fails without writing the secret', async () => {
  const path = await target();
  vi.mocked(windowsFilePrivacy).mockImplementation(async (_, kind) => { if (kind === 'file') { expect(await readFile(path, 'utf8')).toBe(''); throw new Error('ACL verification failed'); } });
  vi.mocked(admitPrivateObject).mockResolvedValue(false);
  await expect(writeNewPrivateFile(path, 'must not be written')).rejects.toThrow('ACL verification failed');
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses an existing file without changing its content or ACL', async () => {
  const path = await target(); await writeFile(path, 'preserve this', { mode: 0o600 });
  await expect(writeNewPrivateFile(path, 'replacement')).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(path, 'utf8')).toBe('preserve this');
  expect(admitPrivateObject).toHaveBeenCalledTimes(1);
  expect(windowsFilePrivacy).not.toHaveBeenCalled();
});
