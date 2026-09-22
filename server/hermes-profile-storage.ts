// Provisioning/config I/O, separate from the unadmitted native memory journal.
// Existing ACLs are verify-only. New empty objects become private before bytes.
import { randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readSync, renameSync, unlinkSync, writeFileSync, type BigIntStats,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fsyncDir } from './atomic.ts';
import { windowsFilePrivacyBatchSync, windowsFilePrivacySync } from './windows-file-privacy.ts';

const MAX_BYTES = 2 * 1024 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

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
  checked(() => {
    pathCheck(path);
    const missing: string[] = [];
    for (let cursor = path; !optionalStat(cursor); cursor = dirname(cursor)) {
      if (dirname(cursor) === cursor) fail();
      missing.push(cursor);
    }
    for (const candidate of missing.reverse()) {
      const chain = parents(candidate);
      let created = false;
      try { mkdirSync(candidate, { mode: 0o700 }); created = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const before = lstatSync(candidate, { bigint: true }); ordinary(before, true);
      windowsFilePrivacySync(candidate, 'directory', created);
      const after = lstatSync(candidate, { bigint: true }); ordinary(after, true);
      if (!same(before, after)) fail();
      recheckParents(chain);
    }
    if (!missing.length) verifyProfileDirectory(path);
  });
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

function readProfileSnapshot(path: string): { data: Buffer; stat: BigIntStats } | null {
  return checked(() => {
    const { chain, before } = stageFile(path);
    if (!before) { recheckParents(chain); return null; }
    windowsFilePrivacySync(path, 'file');
    return readAdmittedFile(path, chain, before);
  });
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
  return readProfileSnapshot(path)?.data ?? null;
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
