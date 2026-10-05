// Durable custody of the worker process groups RealBud starts. Each group has
// its own record file, written and fsynced before the tracker returns (so
// before the caller hands the worker any work) and removed only once its stop
// is confirmed. A crash before removal leaves the record, never the reverse,
// so a group whose cleanup was never proved (RealBud died, or a stop timed
// out) is still on record after a restart. While such a group from an earlier
// run is alive, or its liveness cannot be read, every new worker launch is
// refused with a repair message instead of overlapping it.
//
// This contains the risk; it does not prove descendant termination. POSIX
// checks the process group (`kill(-pgid, 0)`), so a descendant that left the
// group with setsid is not seen; Windows checks the Job Object supervisor,
// whose exit ends its job. A recycled id reads as alive and keeps the hold
// (safe direction); a person can release it after checking.
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fsyncDir, mkdirPrivateSync, readPrivateFileSync } from "./atomic.ts";

export const WORKER_CUSTODY_HELD =
  "Bud may still have work running from before RealBud last closed, so new work was not started. Restart this computer, then try again.";
export const WORKER_CUSTODY_UNSAVED = "Bud couldn't save its record of running work, so new work was not started. Free some disk space, then try again.";
export const WORKER_CUSTODY_DAMAGED = "Bud's record of running work needs recovery, so new work was not started. Contact RealBud support.";

type Entry = { version: 1; pid: number; boot: string; at: string };

// One id per server process: a restarted server can reuse the old pid.
const BOOT = randomUUID();
let earlier: Array<Entry & { path: string }> | undefined;
let damaged = false;
let unsaved = false;
/** Record files whose removal failed; removed again before launches resume. */
const leftover = new Set<string>();

// Resolved at call time: the vitest setup imports the sandbox module before it
// points HOME at a throwaway folder (see server/config.ts DATA_DIR).
const folder = () => join(process.env.REALBUD_DATA_DIR ?? process.env.OMB_DATA_DIR ?? join(homedir(), ".realbud"), "worker-custody");
const recordPath = (boot: string, pid: number) => join(folder(), `${boot}-${pid}.json`);
const ignoreMissing = (error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; };

/** Disk operations, replaceable by tests to inject failures. A record is a new
 * file in the private folder, so it carries that folder's owner-only ACL and
 * Windows starts no PowerShell per record; it holds only a process id. */
export const custodyIo = {
  create(path: string, text: string): void {
    mkdirPrivateSync(folder(), 0o700);
    const fd = openSync(path, "wx", 0o600);
    try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    fsyncDir(folder());
  },
  remove: (path: string): Promise<void> => unlink(path).catch(ignoreMissing),
};

function load(): Array<Entry & { path: string }> {
  if (earlier) return earlier;
  earlier = [];
  let names: string[];
  try { names = readdirSync(folder()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") damaged = true; return earlier; }
  for (const name of names) {
    if (name.endsWith(".tmp")) continue;
    const path = join(folder(), name);
    try {
      const value = JSON.parse(readPrivateFileSync(path, 4_096) ?? "null") as Entry;
      if (value?.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.boot !== "string" ||
        typeof value.at !== "string" || name !== `${value.boot}-${value.pid}.json`) throw new Error("unsupported");
      if (value.boot !== BOOT) earlier.push({ ...value, path });
    } catch { damaged = true; /* a torn or foreign file is kept for a person to repair */ }
  }
  return earlier;
}

function alive(pid: number): boolean {
  try { process.kill(process.platform === "win32" ? pid : -pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Off the stop path; until a removal lands, the record (and so the hold
 * after a crash) stays. A failed removal holds launches until it is retried. */
function removeLater(path: string): Promise<void> {
  return custodyIo.remove(path).then(() => { leftover.delete(path); }, () => { leftover.add(path); unsaved = true; });
}

/** Durably record a started worker group (its leader pid). False when the
 * record could not be saved: the caller must stop that worker, and launches
 * stay held until saving works again. */
export function recordWorkerCustody(pid: number): boolean {
  load();
  try {
    custodyIo.create(recordPath(BOOT, pid), JSON.stringify({ version: 1, pid, boot: BOOT, at: new Date().toISOString() }));
    return true;
  } catch { unsaved = true; return false; }
}

/** Forget a group; call only after its stop was confirmed. */
export function releaseWorkerCustody(pid: number): Promise<void> {
  return removeLater(recordPath(BOOT, pid));
}

/** The refusal for a new worker launch, or null when none is held: a group
 * from an earlier run may still be alive, or custody could not be read or
 * saved. Earlier groups now confirmed gone are released first. */
export function workerCustodyRefusal(): string | null {
  load();
  earlier = earlier!.filter(entry => alive(entry.pid) || (void removeLater(entry.path), false));
  if (unsaved && !damaged) {
    // Saving works again once a probe record lands and every leftover is gone.
    try {
      const probe = join(folder(), `${BOOT}-probe.tmp`);
      custodyIo.create(probe, "");
      unlinkSync(probe);
      for (const path of leftover) { try { unlinkSync(path); } catch (error) { ignoreMissing(error); } leftover.delete(path); }
      unsaved = false;
    } catch { /* still held */ }
  }
  return damaged ? WORKER_CUSTODY_DAMAGED : unsaved ? WORKER_CUSTODY_UNSAVED : earlier.length ? WORKER_CUSTODY_HELD : null;
}

/** A person checked and accepts that earlier work is gone. A damaged record
 * is not cleared here; it needs recovery. */
export async function resolveWorkerCustody(): Promise<void> {
  load();
  if (damaged) throw new Error("Bud's worker record needs recovery before it can be cleared.");
  for (const entry of [...earlier!]) { await custodyIo.remove(entry.path); earlier = earlier!.filter(e => e !== entry); }
}
