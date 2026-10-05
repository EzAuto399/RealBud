// Durable custody of the worker process groups RealBud starts. A group is
// recorded when tracked and released only once its stop is confirmed, so a
// group whose cleanup was never proved (RealBud died, or a stop timed out)
// is still on record after a restart. While such a group from an earlier run
// is alive, or its liveness cannot be read, every new worker launch is
// refused with a repair message instead of overlapping it.
//
// This contains the risk; it does not prove descendant termination. POSIX
// checks the process group (`kill(-pgid, 0)`), so a descendant that left the
// group with setsid is not seen; Windows checks the Job Object supervisor,
// whose exit ends its job. A recycled id reads as alive and keeps the hold
// (safe direction); a person can release it after checking.
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirPrivateSync, readPrivateFileSync, writeFileAtomic } from "./atomic.ts";

export const WORKER_CUSTODY_HELD =
  "Bud may still have work running from before RealBud last closed, so new work was not started. Restart this computer, then try again.";
export const WORKER_CUSTODY_UNSAVED = "Bud couldn't save its record of running work, so new work was not started. Free some disk space, then try again.";
export const WORKER_CUSTODY_DAMAGED = "Bud's record of running work needs recovery, so new work was not started. Contact RealBud support.";

type Entry = { pid: number; boot: string; at: string };

// One id per server process: a restarted server can reuse the old pid.
const BOOT = randomUUID();
const own = new Map<number, Entry>();
let earlier: Entry[] | undefined;
let damaged = false;
let unsaved = false;

// Resolved at call time: the vitest setup imports the sandbox module before it
// points HOME at a throwaway folder (see server/config.ts DATA_DIR).
const dataDir = () => process.env.REALBUD_DATA_DIR ?? process.env.OMB_DATA_DIR ?? join(homedir(), ".realbud");
const file = () => join(dataDir(), "worker-custody.json");

function load(): Entry[] {
  if (earlier) return earlier;
  try {
    const text = readPrivateFileSync(file(), 1_000_000);
    const value = text === null ? { version: 1, entries: [] } : JSON.parse(text);
    if (value?.version !== 1 || !Array.isArray(value.entries) || !value.entries.every((e: Entry) =>
      Number.isSafeInteger(e?.pid) && e.pid > 0 && typeof e.boot === "string" && typeof e.at === "string")) throw new Error("unsupported");
    earlier = value.entries.filter((e: Entry) => e.boot !== BOOT);
  } catch {
    // Kept as it is and never overwritten: a person repairs or removes it.
    damaged = true;
    earlier = [];
  }
  return earlier!;
}

function save(): void {
  if (damaged) return;
  try {
    mkdirPrivateSync(dataDir(), 0o700);
    writeFileAtomic(file(), JSON.stringify({ version: 1, entries: [...earlier!, ...own.values()] }), 0o600);
    unsaved = false;
  } catch { unsaved = true; /* fails closed: launches stay held until a save lands */ }
}

function alive(pid: number): boolean {
  try { process.kill(process.platform === "win32" ? pid : -pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Record a started worker group (its leader pid) before anything else can lose it. */
export function recordWorkerCustody(pid: number): void {
  load();
  own.set(pid, { pid, boot: BOOT, at: new Date().toISOString() });
  save();
}

/** Release a group only after its stop was confirmed. */
export function releaseWorkerCustody(pid: number): void {
  load();
  if (own.delete(pid)) save();
}

/** The refusal for a new worker launch, or null when none is held: a group
 * from an earlier run may still be alive, or custody could not be read or
 * saved. Groups now confirmed gone are released first. */
export function workerCustodyRefusal(): string | null {
  const before = load().length;
  earlier = earlier!.filter(entry => alive(entry.pid));
  if (earlier.length !== before || unsaved) save();
  return damaged ? WORKER_CUSTODY_DAMAGED : unsaved ? WORKER_CUSTODY_UNSAVED : earlier.length ? WORKER_CUSTODY_HELD : null;
}

/** A person checked and accepts that earlier work is gone. A damaged record
 * is not cleared here; it needs recovery. */
export function resolveWorkerCustody(): void {
  load();
  if (damaged) throw new Error("Bud's worker record needs recovery before it can be cleared.");
  earlier = [];
  save();
}
