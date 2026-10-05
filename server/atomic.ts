// Durable, atomic file replace: write to a sibling temp file, fsync it, then
// rename over the target. rename(2) is atomic on the same filesystem, so a
// crash or power loss mid-write can never leave a truncated file behind — a
// reader always sees either the complete old contents or the complete new
// ones. Without this, an interrupted writeFileSync produces half-written JSON
// that fails to parse on next boot and is silently treated as empty state.
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmdirSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { windowsFilePrivacyBatchSync } from "./windows-file-privacy.ts";

/** Office copy when a private file turns out to be a link or an alias: the
 * host never reads through one (a worker could point it at a protected file)
 * and never replaces one. */
export const UNSAFE_PRIVATE_FILE = "RealBud found a link where a private file should be and left it alone. Remove the link, then try again.";
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;
function unsafe(): never { throw Object.assign(new Error(UNSAFE_PRIVATE_FILE), { code: "EUNSAFE", status: 409 }); }
/** A plain file (one name, no link) or folder, owned by this process. */
export function assertOwnPrivate(stat: Stats, kind: "file" | "directory"): void {
  if (stat.isSymbolicLink()) unsafe();
  if (kind === "file" ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory()) unsafe();
  if (process.getuid && stat.uid !== process.getuid()) unsafe();
}
/** Open without following a final link, then check what was opened: the
 * descriptor is what the caller reads or writes, so a later swap cannot
 * redirect it. ENOENT passes through for the caller. */
export function openPrivateFileSync(path: string, flags: number = constants.O_RDONLY): number {
  // Windows has no O_NOFOLLOW: open follows a link and fstat then describes
  // its target. Refuse a link by name first, then require the descriptor to be
  // that same object. Our own atomic replace can swap the name in between, so
  // a mismatch looks again (a planted link is then seen by name) before refusing.
  for (let attempt = 0; ; attempt++) {
    const named = NOFOLLOW ? undefined : lstatSync(path, { bigint: true });
    if (named?.isSymbolicLink()) unsafe();
    // Non-blocking: a FIFO planted under the name must not hold this process
    // open; the descriptor's type is checked before anything is read.
    const fd = openSync(path, flags | NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    try {
      if (named) {
        const opened = fstatSync(fd, { bigint: true });
        if (opened.ino !== named.ino || opened.dev !== named.dev) { if (attempt < 2) { closeSync(fd); continue; } unsafe(); }
      }
      assertOwnPrivate(fstatSync(fd), "file");
      return fd;
    } catch (error) { closeSync(fd); throw error; }
  }
}
/** Largest private text file the host reads whole (notes, logs, reference sheets). */
export const PRIVATE_FILE_LIMIT = 16 * 1024 * 1024;
/** The file's text through a checked descriptor, or null when it does not
 * exist; a file past `limit` bytes is refused as unsafe. */
export function readPrivateFileSync(path: string, limit = PRIVATE_FILE_LIMIT): string | null {
  let fd: number;
  try { fd = openPrivateFileSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const size = fstatSync(fd).size;
    if (size > limit) unsafe();
    const chunks: Buffer[] = []; let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(1 << 20, limit + 1 - total));
      const got = readSync(fd, chunk, 0, chunk.length, null);
      if (!got) break;
      total += got; chunks.push(chunk.subarray(0, got));
      if (total > limit) unsafe();
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { closeSync(fd); }
}
/** Owner-only mode on the file itself, never on a link's target. */
export function keepPrivateFileSync(path: string, mode = 0o600): void {
  const fd = openPrivateFileSync(path);
  try { fchmodSync(fd, mode); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM" || process.platform !== "win32") throw error; } finally { closeSync(fd); }
}
/** Owner-only mode on the folder itself, which must be a real folder of ours. */
export function keepPrivateDirSync(path: string, mode = 0o700): void {
  if (!NOFOLLOW && lstatSync(path).isSymbolicLink()) unsafe(); // Windows: no O_NOFOLLOW (see openPrivateFileSync)
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW | DIRECTORY);
  try {
    assertOwnPrivate(fstatSync(fd), "directory");
    try { fchmodSync(fd, mode); } catch (error) { if (process.platform !== "win32") throw error; }
  } finally { closeSync(fd); }
}

/** A file or folder this process has just created and not yet written into. */
export type NewPrivateObject = { path: string; kind: "file" | "directory" };

// Windows admits a private object only when it carries its own protected
// descriptor; a new file or folder merely inherits its parent's. Give each
// object this process has just created, and only those, that descriptor before
// any content goes in, as POSIX gets 0600/0700 at creation. Existing objects are
// never passed here: they stay verify-only. One PowerShell process per call
// (split only past the helper's cap); a no-op on other systems. On a refusal
// the new, still-empty objects are removed so a retry creates them again.
export function restrictNewSync(created: readonly NewPrivateObject[]): void {
  if (!created.length) return;
  try {
    for (let at = 0; at < created.length; at += 64) {
      windowsFilePrivacyBatchSync(created.slice(at, at + 64).map(({ path, kind }) => ({ path: resolve(path), kind, action: "restrict" as const })));
    }
  } catch (error) {
    for (const { path, kind } of [...created].reverse()) {
      try {
        if (kind === "file") unlinkSync(path);
        else rmdirSync(path);
      } catch {
        /* never remove anything that is no longer empty */
      }
    }
    throw error;
  }
}

/** `mkdir -p` that returns only the folders this call created, outermost first. */
export function mkdirNewSync(path: string, mode?: number): string[] {
  const missing: string[] = [];
  for (let at = resolve(path); !existsSync(at); at = dirname(at)) {
    missing.unshift(at);
    if (dirname(at) === at) break;
  }
  const created: string[] = [];
  for (const folder of missing) {
    try {
      mkdirSync(folder, mode === undefined ? undefined : { mode });
      created.push(folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return created;
}

/** `mkdir -p` whose newly created levels get their own protected Windows descriptor. */
export function mkdirPrivateSync(path: string, mode?: number): void {
  restrictNewSync(mkdirNewSync(path, mode).map((folder) => ({ path: folder, kind: "directory" as const })));
}

/** Create an empty file exclusively; false when something already has the name. */
export function createEmptyFileSync(path: string, mode?: number): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  closeSync(fd);
  return true;
}

/** writeFileSync, except that a file this call creates is restricted while it
 * is still empty. An existing file is written in place and keeps its descriptor. */
export function writeFilePrivateSync(path: string, data: string | Buffer, mode?: number): void {
  let fd: number;
  try {
    fd = openSync(path, "wx", mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    writeFileSync(path, data, mode === undefined ? undefined : { mode });
    return;
  }
  try {
    restrictNewSync([{ path, kind: "file" }]);
    writeFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

// Windows refuses a rename onto a file that another process (antivirus, the
// search indexer, a backup agent) briefly holds open, with EPERM, EBUSY or
// EACCES. Only those, and only on Windows, retry the same rename with a short
// backoff for about a second in total. Nothing touches the temp file between
// attempts, so it keeps its protected descriptor, and the target stays the
// complete old file until one rename succeeds. Any other error, or the last
// refusal, is thrown unchanged for the caller's cleanup.
const REPLACE_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const REPLACE_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320, 370]; // 1 s in total

function replaceRetryDelay(error: unknown, attempt: number): number | undefined {
  if (process.platform !== "win32" || attempt >= REPLACE_RETRY_DELAYS_MS.length) return undefined;
  return REPLACE_RETRY_CODES.has(String((error as NodeJS.ErrnoException | null)?.code)) ? REPLACE_RETRY_DELAYS_MS[attempt] : undefined;
}

/** renameSync onto an existing file, riding out a brief hold by another process on Windows. */
export function renameReplacingSync(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const delay = replaceRetryDelay(error, attempt);
      if (delay === undefined) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
  }
}

/** rename onto an existing file, riding out a brief hold by another process on Windows. */
export async function renameReplacing(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const delay = replaceRetryDelay(error, attempt);
      if (delay === undefined) throw error;
      await sleep(delay);
    }
  }
}

export function fsyncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } catch (err) {
    // Windows (and some network FS) refuse directory fsync with EPERM.
    // The file itself was already fsynced before rename; skipping the
    // parent dir flush still leaves a complete old-or-new payload.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (process.platform === "win32" && (code === "EPERM" || code === "EINVAL")) return;
    throw err;
  } finally {
    closeSync(fd);
  }
}

export function writeFileFsynced(path: string, data: string | Buffer): void {
  let fd: number;
  let created = true;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    fd = openSync(path, "w");
    created = false;
  }
  try {
    if (created) restrictNewSync([{ path, kind: "file" }]);
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function writeFileAtomic(path: string, data: string, mode?: number): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    // Exclusive and never through a link; the name must be ours to take.
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, mode);
    // The replacement carries the temp file's descriptor through the rename.
    restrictNewSync([{ path: tmp, kind: "file" }]);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    // Only a plain private file of ours is replaced: a link or an alias in
    // the target's place is left as it is (the temp file is removed below).
    try { assertOwnPrivate(lstatSync(path), "file"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    renameReplacingSync(tmp, path);
    fsyncDir(dirname(path));
  } catch (e) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort cleanup */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw e;
  }
}
