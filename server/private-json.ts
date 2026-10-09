import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, type Stats } from 'node:fs';
import { lstat, mkdir, readFile, open, rename, rmdir, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { windowsFilePrivacy } from './windows-file-privacy.ts';
import { admitPrivateObject } from './windows-private-admission.ts';
import { fsyncDir, renameReplacing } from './atomic.ts';

const admitting = new Map<string, Promise<void>>();
/** Folder roles named at startup, so a later refusal says which folder. */
const folderRoles = new Map<string, string>();

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
  const role = folderRoles.get(resolve(path)) ?? 'A RealBud storage folder';
  await tightenOwnerOnly(path, await lstat(path), 'directory', role);
  // An existing folder that only inherits private grants is protected and
  // admitted (windows-private-admission.ts); any other ACL refusal stands.
  if (!created) await admitPrivateObject(path, 'directory', role);
}

/** A refusal whose message is plain and path-free, so callers may show it. */
export class PrivateStorageError extends Error {
  readonly status = 503;
  readonly code = 'private_storage_refused';
  constructor(message: string) { super(message); this.name = 'PrivateStorageError'; }
}

type PrivateKind = 'directory' | 'file';
const OWNER_ONLY: Record<PrivateKind, number> = { directory: 0o700, file: 0o600 };

/** POSIX owner-only admission. A real folder, or single-link regular file,
 * owned by this account whose only problem is group/other access (copied,
 * restored, migrated from a legacy folder, loosened by an IT tool) is
 * tightened and admitted; a too-open file is refused (see below). Links, foreign owners and wrong types stay refused.
 * Windows ACLs are checked by admitPrivateObject instead, which applies the
 * same rule to an owned object that only inherits private grants. Returns the mode to
 * set, or undefined when nothing needs changing. */
function ownerOnlyRepair(stat: Stats, kind: PrivateKind, role: string): number | undefined {
  if (stat.isSymbolicLink()) throw new PrivateStorageError(`${role} is a shortcut to another location, so RealBud will not use it. Replace it with the real ${kind === 'directory' ? 'folder' : 'file'}.`);
  if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) throw new PrivateStorageError(`${role} is not a ${kind === 'directory' ? 'folder' : 'regular file'}, so RealBud will not use it.`);
  if (process.platform === 'win32') return undefined;
  if (stat.uid !== process.getuid?.()) throw new PrivateStorageError(`${role} belongs to another account on this Mac, so RealBud will not use it. Sign in as that account or give the ${kind === 'directory' ? 'folder' : 'file'} back to this account.`);
  if (kind === 'file' && stat.nlink !== 1) throw new PrivateStorageError(`${role} has another name linked to it, so RealBud will not use it.`);
  if ((stat.mode & 0o077) === 0) return undefined;
  // ponytail: only folders self-repair. A file other accounts could read may
  // hold secrets that were already seen (keys, tokens), so it stays refused
  // and needs a person; tightening it would hide the exposure.
  if (kind === 'file') throw new Error('Private state file needs recovery.');
  return OWNER_ONLY[kind];
}

const sameObject = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const noFollow = (kind: PrivateKind) => constants.O_RDONLY | constants.O_NOFOLLOW | (kind === 'directory' ? constants.O_DIRECTORY : 0);
const tightened = (role: string) => console.warn(`[storage] ${role} was open to other accounts; RealBud limited it to this account.`);

/** chmod through a no-follow descriptor of the same object lstat saw, so a
 * swapped-in link is never what gets changed. */
async function tightenOwnerOnly(path: string, stat: Stats, kind: PrivateKind, role: string): Promise<void> {
  const mode = ownerOnlyRepair(stat, kind, role);
  if (mode === undefined) return;
  const handle = await open(path, noFollow(kind));
  try {
    if (!sameObject(stat, await handle.stat())) throw new PrivateStorageError(`${role} changed while RealBud was checking it. Try again.`);
    await handle.chmod(mode);
  } finally { await handle.close(); }
  tightened(role);
}

/** Startup check for one private folder: tighten an owned, only-too-open
 * folder; anything else is reported as a plain refusal. */
export function admitPrivateDirectorySync(path: string, role: string): void {
  folderRoles.set(resolve(path), role);
  const stat = lstatSync(path), mode = ownerOnlyRepair(stat, 'directory', role);
  if (mode === undefined) return;
  const fd = openSync(path, noFollow('directory'));
  try {
    if (!sameObject(stat, fstatSync(fd))) throw new PrivateStorageError(`${role} changed while RealBud was checking it. Try again.`);
    fchmodSync(fd, mode);
  } finally { closeSync(fd); }
  tightened(role);
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

/** Privacy refusals (links, foreign owner, too-open file, Windows ACL) throw
 * first; only a file that passes them and is past `maxBytes` is marked as
 * damaged content, which a last-good restore may replace. */
async function readPrivateText(path: string, maxBytes: number, repair = true): Promise<string | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Private state file needs recovery.');
    await tightenOwnerOnly(path, stat, 'file', 'A RealBud storage file');
    // Unlike a too-open POSIX file, a file that only inherits grants of this
    // account, SYSTEM and Administrators was never open to anyone else. A file
    // RealBud does not own (an operator's download) is only checked.
    if (repair) await admitPrivateObject(path, 'file', 'A RealBud storage file');
    else await windowsFilePrivacy(path, 'file');
    if (stat.size > maxBytes) throw Object.assign(new Error('Private state file needs recovery.'), { damaged: true });
    return await readFile(path, 'utf8');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

/** `repair: false` for a file outside RealBud's storage: its Windows
 * permissions are checked, never changed. */
export async function readPrivateJson(path: string, maxBytes = 64_000, options: { repair?: boolean } = {}): Promise<unknown | undefined> {
  const text = await readPrivateText(path, maxBytes, options.repair ?? true);
  return text === undefined ? undefined : JSON.parse(text) as unknown;
}

/** Like readPrivateJson, but a main file whose content is damaged (unparseable,
 * past `maxBytes`, or failing `validate`) is renamed to `.damaged-<time>`, never
 * deleted, and replaced by its `.prev` last good copy when that copy passes the
 * same privacy checks and `validate`. Privacy refusals never fall back. Use only
 * with writes that pass `keepPrevious`. */
export async function readPrivateJsonWithFallback(path: string, maxBytes: number, validate: (value: unknown) => void): Promise<unknown | undefined> {
  let damage: unknown;
  try {
    const text = await readPrivateText(path, maxBytes);
    if (text === undefined) return undefined;
    try { const value = JSON.parse(text) as unknown; validate(value); return value; } catch (error) { damage = error; }
  } catch (error) { if (!(error as { damaged?: boolean }).damaged) throw error; damage = error; }
  let previous: string | undefined, value: unknown;
  try {
    previous = await readPrivateText(`${path}.prev`, maxBytes);
    if (previous === undefined) throw damage;
    value = JSON.parse(previous) as unknown; validate(value);
  } catch { throw damage; }
  await rename(path, `${path}.damaged-${Date.now()}`);
  await replaceAtomically(path, previous);
  console.warn('[storage] A RealBud storage file was damaged; RealBud restored its last good copy and kept the damaged file.');
  return value;
}

/** Drops the oldest rows `droppable` allows, in array order, until the rows
 * serialize under `budget` bytes. Other rows always stay; if they alone are
 * too large, the write guard refuses the save instead. */
export function trimOldestToBytes<T>(rows: T[], budget: number, droppable: (row: T) => boolean): T[] {
  const sizes = rows.map(row => Buffer.byteLength(JSON.stringify(row)) + 1);
  let total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= budget) return rows;
  const dropped = new Set<number>();
  for (let index = 0; index < rows.length && total > budget; index++) {
    if (droppable(rows[index])) { dropped.add(index); total -= sizes[index]; }
  }
  return rows.filter((_, index) => !dropped.has(index));
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

export const STORE_TOO_LARGE_MESSAGE = 'This list has grown too large to save; older items need archiving. Nothing was changed.';

/** A save the next read would refuse as too large. Refused before writing, so
 * the saved file stays readable and the store never flips into recovery. */
export class StoreTooLargeError extends Error {
  readonly status = 507;
  readonly code = 'store_too_large';
  constructor() { super(STORE_TOO_LARGE_MESSAGE); this.name = 'StoreTooLargeError'; }
}

/** `maxBytes` must be the cap the store reads with. `keepPrevious` keeps the
 * replaced version as `<file>.prev` for readPrivateJsonWithFallback. */
type ExistingAdmission = { maxBytes: number; validate: (value: unknown) => void; keepPrevious?: boolean };

export async function writePrivateJson(path: string, value: unknown, existingAdmission?: ExistingAdmission, format: 'compact' | 'readable' = 'compact'): Promise<void> {
  try { await writePrivateJsonOnce(path, value, existingAdmission, format); }
  catch (error) { throw isDiskFull(error) && !(error instanceof DiskFullError) ? new DiskFullError(error) : error; }
}

async function writePrivateJsonOnce(path: string, value: unknown, existingAdmission: ExistingAdmission | undefined, format: 'compact' | 'readable'): Promise<void> {
  const maxBytes = existingAdmission?.maxBytes ?? 2_000_000;
  const text = JSON.stringify(value, null, format === 'readable' ? 2 : undefined);
  // Only a caller that names its read cap is checked: without one the reader's cap is unknown.
  if (existingAdmission && Buffer.byteLength(text) > maxBytes) throw new StoreTooLargeError();
  await privateDirectory(dirname(path));
  // Validate an existing destination's privacy, including before replacement.
  const before = await readPrivateText(path, maxBytes);
  const existing = before === undefined ? undefined : JSON.parse(before) as unknown;
  if (existing !== undefined && existingAdmission) existingAdmission.validate(existing);
  if (existingAdmission?.keepPrevious) {
    const previous = `${path}.prev`;
    if (before !== undefined) await replaceAtomically(previous, before);
    // A copy left from before the main file went missing is set aside, never deleted or restored.
    else await rename(previous, `${previous}-${Date.now()}`).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
  await replaceAtomically(path, text);
}

/** temp (0600) → fsync → rename over `path`; rename replaces a link itself, never its target. */
async function replaceAtomically(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await windowsFilePrivacy(temporary, 'file', true);
    await file.writeFile(text); await file.sync(); await file.close();
    await renameReplacing(temporary, path); fsyncDir(dirname(path));
  } finally { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}

export async function removePrivateJson(path: string): Promise<void> {
  if (await readPrivateJson(path, 2_000_000) === undefined) return;
  await unlink(path); fsyncDir(dirname(path));
}
