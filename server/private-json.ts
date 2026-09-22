import { lstat, mkdir, readFile, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { windowsFilePrivacy } from './windows-file-privacy.ts';
import { fsyncDir } from './atomic.ts';

/** Private product state. Never follow links or silently replace damaged data. */
export async function privateDirectory(path: string): Promise<void> {
  const created = await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' &&
      ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error('Private state directory needs recovery.');
  await windowsFilePrivacy(path, 'directory', created !== undefined);
}

export async function readPrivateJson(path: string, maxBytes = 64_000): Promise<unknown | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes ||
      (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error('Private state file needs recovery.');
    await windowsFilePrivacy(path, 'file');
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

export async function writePrivateJson(path: string, value: unknown, existingAdmission?: { maxBytes: number; validate: (value: unknown) => void }): Promise<void> {
  await privateDirectory(dirname(path));
  // Validate an existing destination's privacy, including before replacement.
  const existing = await readPrivateJson(path, existingAdmission?.maxBytes ?? 2_000_000);
  if (existing !== undefined && existingAdmission) existingAdmission.validate(existing);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await windowsFilePrivacy(temporary, 'file', true);
    await file.writeFile(JSON.stringify(value)); await file.sync(); await file.close();
    await rename(temporary, path); fsyncDir(dirname(path));
  } finally { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}

export async function removePrivateJson(path: string): Promise<void> {
  if (await readPrivateJson(path, 2_000_000) === undefined) return;
  await unlink(path); fsyncDir(dirname(path));
}
