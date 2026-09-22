// Provisioning/config I/O, separate from the unadmitted native memory journal.
// Existing ACLs are verify-only. New empty objects become private before bytes.
import { randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readSync, renameSync, unlinkSync, writeFileSync, type BigIntStats,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fsyncDir } from './atomic.ts';
import { windowsFilePrivacyBatchSync, windowsFilePrivacySync, type WindowsFilePrivacyOperation } from './windows-file-privacy.ts';

const MAX_BYTES = 2 * 1024 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
// windowsFilePrivacyBatchSync refuses a longer list, so a caller with more
// admissions than this pays for another process rather than being refused.
const MAX_ADMISSIONS = 64;

class ProfileStorageError extends Error {
  readonly status = 409;
  constructor() { super('Bud’s private profile needs recovery before it can be changed.'); }
}

function fail(): never { throw new ProfileStorageError(); }
function checked<T>(work: () => T): T {
  try { return work(); }
  catch (error) {
    if (error instanceof ProfileStorageError || error instanceof Error && error.name === 'WindowsFilePrivacyError') throw error;
    throw new ProfileStorageError();
  }
}
function pathCheck(path: string): void {
  if (!isAbsolute(path) || path.includes('\0')) fail();
}
function optionalStat(path: string): BigIntStats | null {
  try { return lstatSync(path, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function ordinary(stat: BigIntStats, directory: boolean): void {
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)) fail();
  if (process.platform !== 'win32' && process.getuid && stat.uid !== BigInt(process.getuid())) fail();
}
function same(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.isDirectory() === right.isDirectory();
}
function unchanged(left: BigIntStats, right: BigIntStats): boolean {
  return same(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.nlink === right.nlink;
}
function parents(path: string): Array<[string, BigIntStats]> {
  pathCheck(path);
  const result: Array<[string, BigIntStats]> = [];
  for (let cursor = dirname(path); ; cursor = dirname(cursor)) {
    const stat = lstatSync(cursor, { bigint: true });
    // Ancestors can be owned by the OS. They must be ordinary, existing paths.
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail();
    result.push([cursor, stat]);
    if (dirname(cursor) === cursor) break;
  }
  return result;
}
function recheckParents(chain: Array<[string, BigIntStats]>): void {
  for (const [path, before] of chain) {
    const after = lstatSync(path, { bigint: true });
    if (after.isSymbolicLink() || !after.isDirectory() || !same(before, after)) fail();
  }
}

/** Create missing owned directories one at a time; never repair existing ACLs. */
export function ensureProfileDirectory(path: string): void {
  checked(() => ensureDirectories([path], false));
}

/**
 * The same policy for a list, in one or two processes instead of one per
 * level. Existing directories in the list are admitted first, together, before
 * anything is created inside any of them: a foreign or unprotected one still
 * refuses with no descendant on disk. A directory created under a directory
 * this call has already admitted is private from birth — on Windows it
 * inherits the admitted root's protected DACL, on POSIX it is created 0700 —
 * so those restricts no longer have to gate each other and share one process.
 * Only the root of a chain whose parent this call has not admitted keeps its
 * own protect-before-create process.
 */
export function ensureProfileDirectories(paths: string[]): void {
  checked(() => ensureDirectories(paths, true));
}

function ensureDirectories(paths: string[], defer: boolean): void {
  if (!Array.isArray(paths)) fail();
  const wanted: string[] = [];
  for (const path of paths) { pathCheck(path); if (!wanted.includes(path)) wanted.push(path); }
  const present: string[] = [];
  const missing: string[] = [];
  for (const path of wanted) {
    const chain: string[] = [];
    for (let cursor = path; !optionalStat(cursor); cursor = dirname(cursor)) {
      if (dirname(cursor) === cursor) fail();
      chain.push(cursor);
    }
    if (!chain.length) { present.push(path); continue; }
    // Parents first, so a chain is created top down and never lists a child
    // before the directory it will be created in.
    for (const candidate of chain.reverse()) if (!missing.includes(candidate)) missing.push(candidate);
  }
  const admitted = new Set<string>();
  if (present.length) {
    const staged = present.map(path => ({ path, ...stageDirectory(path) }));
    admit(present.map((path): WindowsFilePrivacyOperation => ({ path, kind: 'directory', action: 'verify' })));
    for (const entry of staged) settleDirectory(entry.path, entry.chain, entry.before);
    for (const path of present) admitted.add(path);
  }
  const deferred: Array<{ path: string; chain: Chain; before: BigIntStats }> = [];
  for (const candidate of missing) {
    const chain = parents(candidate);
    let created = false;
    try { mkdirSync(candidate, { mode: 0o700 }); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const before = lstatSync(candidate, { bigint: true }); ordinary(before, true);
    if (defer && created && admitted.has(dirname(candidate))) deferred.push({ path: candidate, chain, before });
    else {
      admit([{ path: candidate, kind: 'directory', action: created ? 'restrict' : 'verify' }]);
      settleDirectory(candidate, chain, before);
    }
    admitted.add(candidate);
  }
  if (deferred.length) {
    admit(deferred.map((entry): WindowsFilePrivacyOperation => ({ path: entry.path, kind: 'directory', action: 'restrict' })));
    for (const entry of deferred) settleDirectory(entry.path, entry.chain, entry.before);
  }
}

/** One process per MAX_ADMISSIONS; an empty list never launches one. */
function admit(operations: WindowsFilePrivacyOperation[]): void {
  for (let index = 0; index < operations.length; index += MAX_ADMISSIONS) {
    windowsFilePrivacyBatchSync(operations.slice(index, index + MAX_ADMISSIONS));
  }
}

// A Windows admission is bracketed by identical stats taken before and after
// it. Splitting that bracket lets several admissions share one PowerShell
// process without changing which paths are admitted, in what order, or what is
// allowed to happen before an admission returns.
type Chain = Array<[string, BigIntStats]>;

function stageDirectory(path: string): { chain: Chain; before: BigIntStats } {
  const chain = parents(path);
  const before = lstatSync(path, { bigint: true }); ordinary(before, true);
  return { chain, before };
}
function settleDirectory(path: string, chain: Chain, before: BigIntStats): void {
  const after = lstatSync(path, { bigint: true }); ordinary(after, true);
  if (!same(before, after)) fail();
  recheckParents(chain);
}

export function verifyProfileDirectory(path: string): void {
  checked(() => {
    const { chain, before } = stageDirectory(path);
    windowsFilePrivacySync(path, 'directory');
    settleDirectory(path, chain, before);
  });
}

/** Missing means only a missing leaf under verified, existing ancestry. */
function stageFile(path: string): { chain: Chain; before: BigIntStats | null } {
  const chain = parents(path);
  const before = optionalStat(path);
  if (before) {
    ordinary(before, false);
    if (before.size > BigInt(MAX_BYTES)) fail();
  }
  return { chain, before };
}

/** Only ever called once the file's own admission has already returned. */
function readAdmittedFile(path: string, chain: Chain, before: BigIntStats): { data: Buffer; stat: BigIntStats } {
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const opened = fstatSync(fd, { bigint: true }); ordinary(opened, false);
    if (!unchanged(before, opened)) fail();
    const buffer = Buffer.alloc(Number(opened.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    const data = buffer.subarray(0, length);
    const after = fstatSync(fd, { bigint: true }); ordinary(after, false);
    const named = lstatSync(path, { bigint: true }); ordinary(named, false);
    if (!unchanged(opened, after) || !unchanged(after, named) || BigInt(data.length) !== after.size) fail();
    recheckParents(chain);
    return { data, stat: after };
  } finally { closeSync(fd); }
}

export function readProfileFile(path: string): Buffer | null {
  return readProfileFiles([path])[0] ?? null;
}

/**
 * Several existing files in one admission process. No read gates another, so
 * the whole list is admitted first; each file is still opened and read only
 * after its own admission has returned, and a missing file is still a missing
 * leaf under verified ancestry rather than an empty one.
 */
export function readProfileFiles(paths: string[]): Array<Buffer | null> {
  return checked(() => {
    if (!Array.isArray(paths)) fail();
    const staged = paths.map(path => { pathCheck(path); return { path, ...stageFile(path) }; });
    admit(staged.flatMap((entry): WindowsFilePrivacyOperation[] =>
      entry.before ? [{ path: entry.path, kind: 'file', action: 'verify' }] : []));
    return staged.map(entry => {
      if (!entry.before) { recheckParents(entry.chain); return null; }
      return readAdmittedFile(entry.path, entry.chain, entry.before).data;
    });
  });
}

/** Complete private stage, then publish; no truncation or copy fallback. */
export function writeProfileFile(path: string, content: string | Buffer, overwrite = true, expected?: Buffer | null): void {
  checked(() => {
    const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    if (!Buffer.isBuffer(data) || data.length > MAX_BYTES) fail();
    const directory = dirname(path);
    // The destination directory and any file already published in it are both
    // verify-only and neither gates the other, so one PowerShell process
    // admits both in that order. A cold powershell.exe costs seconds on a
    // Windows client, and provisioning a profile repeats this per file.
    const staged = stageDirectory(directory);
    const target = stageFile(path);
    windowsFilePrivacyBatchSync([
      { path: directory, kind: 'directory', action: 'verify' },
      ...(target.before ? [{ path, kind: 'file' as const, action: 'verify' as const }] : []),
    ]);
    settleDirectory(directory, staged.chain, staged.before);
    const chain = target.chain;
    let snapshot: { data: Buffer; stat: BigIntStats } | null = null;
    if (target.before) snapshot = readAdmittedFile(path, chain, target.before);
    else recheckParents(chain);
    const previous = snapshot?.data ?? null;
    if (expected !== undefined && ((expected === null) !== (previous === null) || expected && !expected.equals(previous!))) fail();
    if (!overwrite && previous !== null) fail();
    const existing = snapshot?.stat ?? null;
    const temporary = join(dirname(path), `.realbud-profile-${randomUUID()}.tmp`);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    let created: BigIntStats | undefined;
    let closed = false;
    try {
      created = fstatSync(fd, { bigint: true });
      ordinary(created, false);
      if (created.size !== 0n) fail();
      windowsFilePrivacySync(temporary, 'file', true);
      const restricted = lstatSync(temporary, { bigint: true }); ordinary(restricted, false);
      if (!same(created, restricted) || restricted.size !== 0n || !same(restricted, fstatSync(fd, { bigint: true }))) fail();
      recheckParents(chain);
      writeFileSync(fd, data); fsyncSync(fd);
      const written = fstatSync(fd, { bigint: true }); ordinary(written, false);
      const named = lstatSync(temporary, { bigint: true }); ordinary(named, false);
      if (!unchanged(written, named) || written.size !== BigInt(data.length)) fail();
      const current = readProfileFile(path);
      const currentStat = optionalStat(path);
      if ((previous === null) !== (current === null) || previous && !previous.equals(current!) ||
          existing && (!currentStat || !unchanged(existing, currentStat))) fail();
      recheckParents(chain);
      // CREATE_NEW publication cannot overwrite a competing first creation.
      // Both names refer to our already-private complete stage until unlink.
      if (existing === null) { linkSync(temporary, path); unlinkSync(temporary); }
      else renameSync(temporary, path);
      const published = lstatSync(path, { bigint: true }); ordinary(published, false);
      if (!same(created, published) || published.size !== BigInt(data.length)) fail();
      windowsFilePrivacySync(path, 'file');
      recheckParents(chain);
      closeSync(fd); closed = true;
      fsyncDir(dirname(path));
    } finally {
      if (!closed) closeSync(fd);
      // Delete only our still-single-linked stage. Uncertain aliases survive.
      const staged = optionalStat(temporary);
      if (created && staged && !staged.isSymbolicLink() && staged.nlink === 1n && same(created, staged)) unlinkSync(temporary);
    }
  });
}
