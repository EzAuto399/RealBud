// Durable, atomic file replace: write to a sibling temp file, fsync it, then
// rename over the target. rename(2) is atomic on the same filesystem, so a
// crash or power loss mid-write can never leave a truncated file behind — a
// reader always sees either the complete old contents or the complete new
// ones. Without this, an interrupted writeFileSync produces half-written JSON
// that fails to parse on next boot and is silently treated as empty state.
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type AtomicWriteDisposition = "not-landed" | "landed-uncertain";

/** A failed atomic replace is materially different before and after rename.
 * Callers may safely restore their working copy only when the candidate is
 * proven not to have landed. Once rename may have happened, they must fail
 * closed and reconcile the durable file on restart. */
export class AtomicWriteError extends Error {
  readonly disposition: AtomicWriteDisposition;
  readonly code = "atomic-write-failed";

  constructor(disposition: AtomicWriteDisposition, cause?: unknown) {
    super(
      disposition === "not-landed"
        ? "atomic replace did not reach the destination"
        : "atomic replace reached the destination but final durability is uncertain",
      { cause },
    );
    this.name = "AtomicWriteError";
    this.disposition = disposition;
  }
}

export function fsyncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function writeFileFsynced(path: string, data: string | Buffer): void {
  const fd = openSync(path, "w", 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  let renamed = false;
  try {
    // RealBud's atomic writer is used only for local app state, which can
    // contain PM messages, evidence, configuration or encrypted credentials.
    // New and replacement files are private by default; Windows ignores POSIX
    // mode bits and relies on the user's profile ACL.
    fd = openSync(tmp, "w", 0o600);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
    renamed = true;
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
    if (renamed) throw new AtomicWriteError("landed-uncertain", e);

    // rename(2) normally has an unambiguous result, but a runtime or
    // filesystem error can obscure it. Exact readback makes retry decisions
    // deterministic without logging or decrypting the payload.
    try {
      if (readFileSync(path, "utf8") === data) {
        throw new AtomicWriteError("landed-uncertain", e);
      }
      throw new AtomicWriteError("not-landed", e);
    } catch (readError) {
      if (readError instanceof AtomicWriteError) throw readError;
      const code = (readError as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT" || code === "EISDIR") throw new AtomicWriteError("not-landed", e);
      throw new AtomicWriteError("landed-uncertain", e);
    }
  }
}
