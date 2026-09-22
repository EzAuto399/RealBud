import { lstat, mkdir, readFile, open, rename, rmdir, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { windowsFilePrivacy } from './windows-file-privacy.ts';
import { fsyncDir } from './atomic.ts';

const admitting = new Map<string, Promise<void>>();

/** Private product state. Never follow links or silently replace damaged data.
 * Concurrent first use in one process shares one admission: on Windows the
 * creator restricts the new directory while a second caller would otherwise
 * verify it before that restriction lands. */
export function privateDirectory(path: string): Promise<void> {
  const pending = admitting.get(path);
  if (pending) return pending;
  const admission = admitDirectory(path).finally(() => { admitting.delete(path); });
  admitting.set(path, admission);
  return admission;
}

async function admitDirectory(path: string): Promise<void> {
  const created = await mkdirPrivate(path);
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' &&
      ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error('Private state directory needs recovery.');
  if (!created) await windowsFilePrivacy(path, 'directory');
}

/** Create `path` and its missing parents top-down; each level this call creates
 * gets its own protected Windows descriptor before anything is created inside
 * it, and an existing level is never touched. The missing levels are listed
 * first (walking up while absent), never inferred from mkdir's return value,
 * which Windows can report in its \\?\ form. On a refusal the empty levels
 * made here are removed so a retry creates them again. Resolves true when the
 * requested folder itself was created by this call. */
export async function mkdirPrivate(path: string, mode = 0o700): Promise<boolean> {
  const leaf = resolve(path), missing: string[] = [];
  for (let at = leaf; ; at = dirname(at)) {
    try { await lstat(at); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    missing.unshift(at);
    if (dirname(at) === at) break;
  }
  // Nothing missing: keep mkdir's own answer for a non-folder at the path.
  if (!missing.length) { await mkdir(leaf, { recursive: true, mode }); return false; }
  const created: string[] = [];
  try {
    for (const folder of missing) {
      try { await mkdir(folder, { mode }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error; }
      created.push(folder);
      await windowsFilePrivacy(folder, 'directory', true);
    }
  } catch (error) {
    for (const folder of created.reverse()) await rmdir(folder).catch(() => {});
    throw error;
  }
  return created.at(-1) === leaf;
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

export const DISK_FULL_MESSAGE = 'This computer is out of disk space. Free some space, then try again.';

/** A full disk or an exhausted quota is not damage: the saved file is intact
 * and the same write can succeed once space is freed. It gets its own error so
 * it is never reported, or held, as a file that needs recovery. */
export class DiskFullError extends Error {
  readonly status = 507;
  readonly code = 'disk_full';
  constructor(cause: unknown) { super(DISK_FULL_MESSAGE, { cause }); this.name = 'DiskFullError'; }
}

export function isDiskFull(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return error instanceof DiskFullError || code === 'ENOSPC' || code === 'EDQUOT';
}

export async function writePrivateJson(path: string, value: unknown, existingAdmission?: { maxBytes: number; validate: (value: unknown) => void }): Promise<void> {
  try { await writePrivateJsonOnce(path, value, existingAdmission); }
  catch (error) { throw isDiskFull(error) && !(error instanceof DiskFullError) ? new DiskFullError(error) : error; }
}

async function writePrivateJsonOnce(path: string, value: unknown, existingAdmission?: { maxBytes: number; validate: (value: unknown) => void }): Promise<void> {
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
