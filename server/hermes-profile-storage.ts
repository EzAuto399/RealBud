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
  writeProfileFiles([{ path, bytes: content, overwrite, expected }]);
}

/** One file of a publication. `expected` is the caller's snapshot, as before. */
export type ProfileFileWrite = {
  path: string;
  bytes: string | Buffer;
  /** Default true, matching `writeProfileFile`. */
  overwrite?: boolean;
  expected?: Buffer | null;
};

/**
 * What each entry actually ended up as. `published` means renamed AND verified;
 * `renamed-unverified` means the bytes are at the destination but this call
 * never got its own admission back for that path, so nothing may trust it.
 */
export type ProfileWriteOutcome = {
  path: string;
  state: 'published' | 'renamed-unverified' | 'staged' | 'absent';
};

type Pending = {
  path: string; data: Buffer; overwrite: boolean; expected?: Buffer | null;
  directory: string; chain: Chain; before: BigIntStats | null;
  previous: Buffer | null; existing: BigIntStats | null;
  temporary: string; fd: number; created: BigIntStats | null;
  state: ProfileWriteOutcome['state'];
};

/**
 * Publish many files in three PowerShell processes instead of three per file.
 * The per-file guarantees are the ones `writeProfileFile` has always made:
 * no byte reaches a stage before that stage's own restrict has returned, no
 * published file is reported before its own verification has returned, and a
 * refusal at any index leaves earlier entries published and later ones staged
 * or absent — never a silent partial success. The returned outcomes say which
 * is which, and a thrown error carries the same list as `profileWriteOutcomes`.
 *
 * What is batched is only what does not gate the next step: the destination
 * directories and the files already published in them (one process), then every
 * empty stage's restrict (one), then every published path's verify (one). A
 * list longer than the script's cap splits across processes, still in phase.
 */
export function writeProfileFiles(entries: ProfileFileWrite[]): ProfileWriteOutcome[] {
  const pending: Pending[] = [];
  try {
    return checked(() => publishAll(entries, pending));
  } catch (error) {
    // Never let a failure be read as "nothing happened": say it per file.
    if (error instanceof Error) Object.assign(error, { profileWriteOutcomes: outcomes(pending) });
    throw error;
  }
}

function outcomes(pending: Pending[]): ProfileWriteOutcome[] {
  return pending.map(item => ({ path: item.path, state: item.state }));
}

function publishAll(entries: ProfileFileWrite[], pending: Pending[]): ProfileWriteOutcome[] {
  if (!Array.isArray(entries)) fail();
  for (const entry of entries) {
    const bytes = entry?.bytes;
    const data = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
    if (!Buffer.isBuffer(data) || data.length > MAX_BYTES) fail();
    pathCheck(entry.path);
    pending.push({
      path: entry.path, data, overwrite: entry.overwrite !== false, expected: entry.expected,
      directory: dirname(entry.path), chain: [], before: null, previous: null, existing: null,
      temporary: '', fd: -1, created: null, state: 'absent',
    });
  }
  if (!pending.length) return [];
  const directories: string[] = [];
  try {
    // 1. Admit every destination directory and every file already published in
    //    one of them. None of these gates another, and all of them gate what
    //    follows, so they share one process and all settle before it.
    const staged = new Map<string, { chain: Chain; before: BigIntStats }>();
    const operations: WindowsFilePrivacyOperation[] = [];
    for (const item of pending) {
      if (!staged.has(item.directory)) {
        staged.set(item.directory, stageDirectory(item.directory));
        directories.push(item.directory);
        operations.push({ path: item.directory, kind: 'directory', action: 'verify' });
      }
      const target = stageFile(item.path);
      item.chain = target.chain; item.before = target.before;
      if (target.before) operations.push({ path: item.path, kind: 'file', action: 'verify' });
    }
    admit(operations);
    for (const directory of directories) {
      const entry = staged.get(directory)!;
      settleDirectory(directory, entry.chain, entry.before);
    }
    for (const item of pending) {
      if (item.before) {
        const snapshot = readAdmittedFile(item.path, item.chain, item.before);
        item.previous = snapshot.data; item.existing = snapshot.stat;
      } else recheckParents(item.chain);
      if (item.expected !== undefined && ((item.expected === null) !== (item.previous === null) ||
          item.expected && !item.expected.equals(item.previous!))) fail();
      if (!item.overwrite && item.previous !== null) fail();
    }
    // 2. Exclusively create every stage empty, then restrict them together.
    for (const item of pending) {
      item.temporary = join(item.directory, `.realbud-profile-${randomUUID()}.tmp`);
      item.fd = openSync(item.temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
      item.state = 'staged';
      const created = fstatSync(item.fd, { bigint: true }); ordinary(created, false);
      if (created.size !== 0n) fail();
      item.created = created;
    }
    admit(pending.map((item): WindowsFilePrivacyOperation => ({ path: item.temporary, kind: 'file', action: 'restrict' })));
    for (const item of pending) {
      const restricted = lstatSync(item.temporary, { bigint: true }); ordinary(restricted, false);
      if (!same(item.created!, restricted) || restricted.size !== 0n || !same(restricted, fstatSync(item.fd, { bigint: true }))) fail();
      recheckParents(item.chain);
    }
    // 3. Only now, with every stage restricted, do any bytes get written.
    for (const item of pending) {
      writeFileSync(item.fd, item.data); fsyncSync(item.fd);
      const written = fstatSync(item.fd, { bigint: true }); ordinary(written, false);
      const named = lstatSync(item.temporary, { bigint: true }); ordinary(named, false);
      if (!unchanged(written, named) || written.size !== BigInt(item.data.length)) fail();
    }
    // 4. Last-moment drift check against every destination, in one process.
    const current = readProfileFiles(pending.map(item => item.path));
    pending.forEach((item, index) => {
      const now = current[index] ?? null;
      const currentStat = optionalStat(item.path);
      if ((item.previous === null) !== (now === null) || item.previous && !item.previous.equals(now!) ||
          item.existing && (!currentStat || !unchanged(item.existing, currentStat))) fail();
      recheckParents(item.chain);
    });
    // 5. Publish. CREATE_NEW publication cannot overwrite a competing first
    //    creation. Both names refer to our already-private complete stage.
    for (const item of pending) {
      if (item.existing === null) { linkSync(item.temporary, item.path); unlinkSync(item.temporary); }
      else renameSync(item.temporary, item.path);
      const published = lstatSync(item.path, { bigint: true }); ordinary(published, false);
      if (!same(item.created!, published) || published.size !== BigInt(item.data.length)) fail();
      item.state = 'renamed-unverified';
    }
    // 6. Nothing is reported published before its own verification returns.
    admit(pending.map((item): WindowsFilePrivacyOperation => ({ path: item.path, kind: 'file', action: 'verify' })));
    for (const item of pending) { recheckParents(item.chain); item.state = 'published'; }
    for (const item of pending) { closeSync(item.fd); item.fd = -1; }
    for (const directory of directories) fsyncDir(directory);
    return outcomes(pending);
  } finally {
    for (const item of pending) {
      // Delete only our still-single-linked stage. Uncertain aliases survive.
      // One entry's cleanup must not hide the refusal or skip the next entry.
      try { if (item.fd >= 0) { closeSync(item.fd); item.fd = -1; } } catch { /* already closed */ }
      if (!item.created || !item.temporary) continue;
      try {
        const remains = optionalStat(item.temporary);
        if (remains && !remains.isSymbolicLink() && remains.nlink === 1n && same(item.created, remains)) {
          unlinkSync(item.temporary);
          if (item.state === 'staged') item.state = 'absent';
        }
      } catch { /* leave an uncertain stage in place and reported */ }
    }
  }
}
