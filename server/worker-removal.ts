/**
 * Supported worker removal (owner decision, 8 Oct): reboot-required.
 *
 * A worker can detach into another process group, and no process scan proves
 * every descendant stopped (never substitute one). An OS restart does. So a
 * removal is requested now and carried out on the first RealBud start after a
 * verified reboot: a different boot id, the worker-state migration complete,
 * and exclusive lifecycle admission (no install in this process, the
 * cross-process installer lock). The same or an unknown boot keeps every file.
 *
 * Between request and completion the request lives in `D/worker-control`,
 * outside the worker home: worker launches are held (in this process and
 * again after any app restart) and setup, Repair, update and rollback refuse.
 * Only the worker's code is deleted (`runtimes/`, a legacy `hermes-agent/`);
 * profiles, office data and RealBud's own records stay. Afterwards the
 * selection is empty, so a linked office's automatic setup installs a fresh
 * worker: removable and replaceable.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { installInFlight } from "./hermes-bridge.ts";
import { hermesHome, isInsideHermesHome } from "./hermes-pack.ts";
import { clearRuntimeIntegrity } from "./hermes-runtime-check.ts";
import { commitRuntimeSelection } from "./hermes-runtime-selection.ts";
import { clearHermesVersionCache } from "./hermes-status.ts";
import { removePrivateJson } from "./private-json.ts";
import { acquireWorkerSetupLock } from "./worker-bootstrap.ts";
import { controlPath, mutateControl, readControlSync, removalRequested, WorkerControlDamaged, writeControl } from "./worker-control.ts";
import { setWorkerLaunchesHeld } from "./worker-network-sandbox.ts";

/**
 * The OS boot session, or null when this computer does not say. Same sources
 * as `systemBootId` in `electron/service-lifecycle.mjs`, which the packaged
 * server cannot import (Electron's files live inside the app archive).
 */
let cachedBootId: string | null | undefined;
export function systemBootId(platform: NodeJS.Platform = process.platform, run = (file: string, args: string[]) => execFileSync(file, args, { encoding: "utf8", timeout: 3_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })): string | null {
  const cache = platform === process.platform && arguments.length < 2;
  if (cache && cachedBootId !== undefined) return cachedBootId;
  let id: string | null = null;
  try {
    if (platform === "darwin") {
      const value = run("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]).trim();
      if (/^[0-9A-Fa-f-]{36}$/.test(value)) id = `darwin:${value.toLowerCase()}`;
    } else if (platform === "linux") {
      const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (/^[0-9a-f-]{36}$/.test(value)) id = `linux:${value}`;
    } else if (platform === "win32") {
      // BootId counts boots; it is not a clock.
      const reg = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
      const out = run(reg, ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters", "/v", "BootId"]);
      const match = /BootId\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out);
      if (match) id = `win32:${parseInt(match[1], 16)}`;
    }
  } catch { id = null; }
  if (cache) cachedBootId = id;
  return id;
}

interface RemovalRecord {
  version: 1; purpose: "worker-removal"; phase: "awaiting-reboot";
  requestedBootId: string; requestedAt: string;
  /** Worker-state projection revision at request time, when known. */
  projectionRevision: number | null;
}
function validateRemoval(value: unknown): asserts value is RemovalRecord {
  const row = value as Record<string, unknown> | null;
  if (!row || typeof row !== "object" || Array.isArray(row) ||
    Object.keys(row).sort().join(",") !== "phase,projectionRevision,purpose,requestedAt,requestedBootId,version" ||
    row.version !== 1 || row.purpose !== "worker-removal" || row.phase !== "awaiting-reboot" ||
    typeof row.requestedBootId !== "string" || !/^[\w:.-]{1,80}$/.test(row.requestedBootId) || typeof row.requestedAt !== "string" ||
    !(row.projectionRevision === null || Number.isSafeInteger(row.projectionRevision))) {
    throw new WorkerControlDamaged("Bud’s removal request needs recovery. Bud stays paused and your files are kept; contact RealBud support.");
  }
}
function readRemoval(home: string): RemovalRecord | undefined {
  const value = readControlSync(controlPath(home, "removal"));
  if (value === undefined) return undefined;
  validateRemoval(value);
  return value;
}

export type WorkerRemovalStatus =
  | { phase: "none" }
  | { phase: "awaiting-reboot"; requestedAt: string | null; detail: string }
  | { phase: "removed"; detail: string };
const AWAITING = "Restart this computer to finish removing Bud’s private setup. Bud is paused until then; your files are kept.";
const awaiting = (record: RemovalRecord | null, detail = AWAITING): WorkerRemovalStatus => ({ phase: "awaiting-reboot", requestedAt: record?.requestedAt ?? null, detail });
const refuse = (message: string) => Object.assign(new Error(message), { status: 409 });

/** Read-only: for status and the removal route. */
export function workerRemovalStatus(root?: string): WorkerRemovalStatus {
  const home = hermesHome(root);
  if (!removalRequested(home)) return { phase: "none" };
  try { return awaiting(readRemoval(home) ?? null); } catch (error) { return awaiting(null, (error as Error).message); }
}
export const workerRemovalPending = (root?: string): boolean => removalRequested(hermesHome(root));

/** Record the request and hold launches. Nothing is deleted now. */
export async function requestWorkerRemoval(opts: { root?: string; bootId?: string | null; projectionRevision?: number | null } = {}): Promise<WorkerRemovalStatus> {
  if (process.env.REALBUD_HERMES_CLI?.trim()) throw refuse("This installation uses a custom agent path. Remove that installation separately.");
  if (installInFlight()) throw refuse("Let Bud setup finish or stop it before removing its private setup.");
  const bootId = opts.bootId === undefined ? systemBootId() : opts.bootId;
  if (!bootId) throw refuse("This computer can’t confirm when it restarts, so Bud’s private setup has been kept. Use Repair to fix setup.");
  const home = hermesHome(opts.root), path = controlPath(home, "removal");
  return mutateControl(path, async () => {
    const existing = readRemoval(home);
    if (existing) { setWorkerLaunchesHeld(true); return awaiting(existing); }
    const record: RemovalRecord = { version: 1, purpose: "worker-removal", phase: "awaiting-reboot", requestedBootId: bootId,
      requestedAt: new Date().toISOString(), projectionRevision: opts.projectionRevision ?? null };
    await writeControl(path, record, validateRemoval);
    // Nothing new starts from now; whatever is running stops with the restart.
    setWorkerLaunchesHeld(true);
    return awaiting(record);
  });
}

/** Keep Bud: withdraw a request that has not been carried out. */
export async function cancelWorkerRemoval(opts: { root?: string } = {}): Promise<WorkerRemovalStatus> {
  const home = hermesHome(opts.root), path = controlPath(home, "removal");
  return mutateControl(path, async () => {
    if (!readRemoval(home)) return { phase: "none" };
    await removePrivateJson(path);
    setWorkerLaunchesHeld(false);
    return { phase: "none" };
  });
}

/** Never follows a link: a planted link is removed, its target untouched. */
function removeRuntimeFolder(home: string, folder: string): void {
  let stat;
  try { stat = lstatSync(folder); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (stat.isSymbolicLink()) { unlinkSync(folder); return; }
  if (!isInsideHermesHome(folder, home)) throw new Error("refusing to delete a path outside the worker home");
  rmSync(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

/**
 * Boot, before any worker can start: re-hold launches for a pending request,
 * and carry it out only after a verified reboot, a complete worker-state
 * migration and exclusive lifecycle admission. Anything short of that keeps
 * every file and the hold; a failed deletion is retried on the next start.
 */
export async function completeWorkerRemoval(opts: { root?: string; bootId?: string | null; migrationComplete: () => Promise<boolean> }): Promise<WorkerRemovalStatus> {
  const home = hermesHome(opts.root), path = controlPath(home, "removal");
  if (!removalRequested(home)) return { phase: "none" };
  setWorkerLaunchesHeld(true);
  return mutateControl(path, async () => {
    let record: RemovalRecord | undefined;
    try { record = readRemoval(home); } catch (error) { return awaiting(null, (error as Error).message); }
    if (!record) { setWorkerLaunchesHeld(false); return { phase: "none" }; }
    const bootId = opts.bootId === undefined ? systemBootId() : opts.bootId;
    if (!bootId || bootId === record.requestedBootId) return awaiting(record);
    if (!(await opts.migrationComplete()) || installInFlight()) return awaiting(record);
    let unlock: () => void;
    try { unlock = acquireWorkerSetupLock(join(home, ".runtime-install")); } catch { return awaiting(record); }
    try {
      for (const folder of [join(home, "runtimes"), join(home, "hermes-agent")]) removeRuntimeFolder(home, folder);
      await commitRuntimeSelection(home, { version: 1, selected: null, previous: null, previousAvailable: false }, "removed");
    } catch {
      console.warn(`[${new Date().toISOString()}] Bud's private setup could not be fully removed; RealBud will finish at the next start.`);
      return awaiting(record, "Bud’s private setup could not be fully removed yet. RealBud will finish at its next start; your files are kept.");
    } finally { unlock(); }
    clearRuntimeIntegrity(); clearHermesVersionCache();
    await removePrivateJson(path);
    setWorkerLaunchesHeld(false);
    return { phase: "removed", detail: "Bud’s private setup was removed. Your files and settings are kept." };
  });
}
