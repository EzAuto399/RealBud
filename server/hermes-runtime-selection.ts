import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { mkdirPrivateSync, writeFileAtomic } from "./atomic.ts";
import { hermesHome, runtimeCli } from "./hermes-paths.ts";
import { readPrivateJsonWithFallback } from "./private-json.ts";
import { controlPath, mutateControl, readControlSync, removalRequested, workerControlDir, writeControl } from "./worker-control.ts";

export interface RuntimeSelection { version: 1; selected: string | null; previous: string | null; previousAvailable?: boolean }
type SelectionEvent = "selected" | "restored" | "removed";
type HistoryEntry = { runtime: string | null; event: SelectionEvent; at: string };

/** The selection before it moved to `D/worker-control`. Still read until the
 * first boot imports it, and kept in step for older app versions and scripts. */
const LEGACY = "realbud-runtime.json";
const MAX_HISTORY = 20;
const SELECTION_NEEDS_RECOVERY = "Bud’s runtime selection could not be read. Your files have been kept; repair the selection before updating.";
const validCommit = (value: unknown): value is string | null => value === null || (typeof value === "string" && /^[a-f0-9]{40}(?:-[a-f0-9]{12})?$/.test(value));
const validHistory = (value: unknown) => {
  const row = value as Record<string, unknown> | null;
  return !!row && typeof row === "object" && validCommit(row.runtime) && ["selected", "restored", "removed"].includes(row.event as string) && typeof row.at === "string";
};
export const runtimeCommit = (id: string | null): string | null => id?.split("-")[0] ?? null;

function parsedSelection(value: unknown): RuntimeSelection & { history: HistoryEntry[] } {
  const row = value as Record<string, unknown> | null;
  if (!row || typeof row !== "object" || row.version !== 1 || !validCommit(row.selected) || !validCommit(row.previous)) throw new Error("Invalid runtime selection");
  if (row.previousAvailable !== undefined && typeof row.previousAvailable !== "boolean") throw new Error("Invalid runtime selection");
  if (row.history !== undefined && (!Array.isArray(row.history) || row.history.length > MAX_HISTORY || !row.history.every(validHistory))) throw new Error("Invalid runtime selection");
  return { version: 1, selected: row.selected, previous: row.previous, previousAvailable: (row.previousAvailable as boolean | undefined) ?? row.previous !== null, history: (row.history as HistoryEntry[] | undefined) ?? [] };
}
/** Refused by the boot admission (privacy or damage): held until restart. */
const refused = new Set<string>();
function readRecord(home: string): (RuntimeSelection & { history: HistoryEntry[] }) | undefined {
  const path = controlPath(home, "runtime-selection");
  try {
    if (refused.has(path)) throw new Error("refused");
    const value = readControlSync(path) ?? readControlSync(join(home, LEGACY));
    return value === undefined ? undefined : parsedSelection(value);
  } catch { throw Object.assign(new Error(SELECTION_NEEDS_RECOVERY), { status: 409 }); }
}

/** Throws a 409 when the selection needs recovery: callers that change the
 * worker refuse; readers that only report use `workerHold`. */
export function readRuntimeSelection(home: string): RuntimeSelection {
  const record = readRecord(home);
  if (!record) return { version: 1, selected: null, previous: null };
  return { version: 1, selected: record.selected, previous: record.previous, previousAvailable: record.previousAvailable };
}
const sameSelection = (a: RuntimeSelection, b: RuntimeSelection) =>
  a.selected === b.selected && a.previous === b.previous && Boolean(a.previousAvailable) === Boolean(b.previousAvailable);

export const releaseHome = (home: string, commit: string): string => {
  if (!validCommit(commit) || !commit) throw new Error("Invalid runtime release");
  return join(home, "runtimes", commit);
};

/** Boot: move a selection still held only in the worker home into
 * `D/worker-control`. Idempotent; a damaged main file is restored from its
 * last good copy; a damaged legacy file is kept and holds launches. */
export async function importRuntimeSelection(home = hermesHome()): Promise<"current" | "imported" | "absent" | "deferred" | "needs_recovery"> {
  const path = controlPath(home, "runtime-selection");
  const validate = (value: unknown) => { parsedSelection(value); };
  const needsRecovery = () => {
    console.warn(`[${new Date().toISOString()}] Bud's runtime selection needs recovery; Bud stays paused and the file is kept.`);
    return "needs_recovery" as const;
  };
  return mutateControl(path, async () => {
    // A record the private reader refuses (damage with no good copy, a link,
    // a file other accounts can read) stays refused for this process too.
    try { if (await readPrivateJsonWithFallback(path, 64_000, validate) !== undefined) return "current"; }
    catch { refused.add(path); return needsRecovery(); }
    let legacy: RuntimeSelection | undefined;
    try { const value = readControlSync(join(home, LEGACY)); legacy = value === undefined ? undefined : parsedSelection(value); }
    catch { return needsRecovery(); }
    if (!legacy) return "absent";
    // A failed copy (a full disk) is retried next start; the original still answers meanwhile.
    try { await writeControl(path, legacy, validate); return "imported"; } catch { return "deferred"; }
  });
}

/** Promote a selection. `expected` is compared inside the write, so another
 * setup's change is never overwritten. Awaited inside the installer lock. */
export function commitRuntimeSelection(home: string, next: RuntimeSelection, event: SelectionEvent, expected?: RuntimeSelection): Promise<void> {
  if (next.version !== 1 || !validCommit(next.selected) || !validCommit(next.previous)) throw new Error("Invalid runtime selection");
  const path = controlPath(home, "runtime-selection");
  return mutateControl(path, async () => {
    const current = readRecord(home);
    if (expected && !sameSelection(current ?? { version: 1, selected: null, previous: null }, expected)) {
      throw Object.assign(new Error("Another setup changed the selected agent. Your current selection is kept; retry the update."), { status: 409 });
    }
    const selection: RuntimeSelection = { version: 1, selected: next.selected, previous: next.previous, previousAvailable: next.previousAvailable ?? next.previous !== null };
    const history = [...current?.history ?? [], { runtime: next.selected, event, at: new Date().toISOString() }].slice(-MAX_HISTORY);
    await writeControl(path, { ...selection, history }, value => { parsedSelection(value); });
    // Older app versions and support scripts still read the worker-home copy.
    if (existsSync(home)) {
      try { writeFileAtomic(join(home, LEGACY), JSON.stringify(selection), 0o600); }
      catch { console.warn(`[${new Date().toISOString()}] Bud's runtime selection was saved; its compatibility copy was not.`); }
    }
  });
}

/** Synchronous write for tests and scripts. Product changes use `commitRuntimeSelection`. */
export function saveRuntimeSelection(home: string, selection: RuntimeSelection): void {
  parsedSelection(selection);
  mkdirPrivateSync(workerControlDir(home), 0o700);
  writeFileAtomic(controlPath(home, "runtime-selection"), JSON.stringify(selection), 0o600);
}

/** Why no worker may launch from this home, or null. */
export type WorkerHold = "removal_pending" | "selection_needs_recovery";
/** Office copy for a worker that may not launch. */
export const WORKER_HOLD_COPY: Record<WorkerHold, string> = {
  removal_pending: "Bud’s private setup will be removed after this computer restarts. Bud is paused until then; your files are kept. Cancel the removal to keep using Bud.",
  selection_needs_recovery: "Bud’s runtime selection needs recovery, so Bud is paused. Your files are kept. Save a support file and send it to RealBud support.",
};
/** Setup, Repair, update and rollback wait while a removal awaits the restart that proves no worker survived. */
export function assertNoRemovalPending(home: string): void {
  if (removalRequested(home)) throw Object.assign(new Error(WORKER_HOLD_COPY.removal_pending), { status: 409, code: "worker_removal_pending" });
}
export function workerHold(root = hermesHome()): WorkerHold | null {
  if (removalRequested(root)) return "removal_pending";
  try { readRecord(root); return null; } catch { return "selection_needs_recovery"; }
}
/** A path that never exists: a held home resolves here, so a launch finds nothing to run. */
export const heldHermesCli = (root: string, platform: NodeJS.Platform = process.platform) =>
  join(workerControlDir(root), "held", platform === "win32" ? "hermes.exe" : "hermes");

// An update changes the next app launch. All calls in this process continue
// using one executable, including warm ACP sessions and the RealBud clock.
const processSelections = new Map<string, string>();
export function selectedHermesCli(root = hermesHome(), platform = process.platform): string {
  const override = process.env.REALBUD_HERMES_CLI?.trim();
  if (override) return override;
  // Never throws: status, Desk and saved bot settings read this. A hold
  // resolves to nothing launchable; status says why.
  if (workerHold(root)) return heldHermesCli(root, platform);
  const key = `${root}\0${platform}`;
  const cached = processSelections.get(key);
  // A runtime deleted from disk is resolved again, never launched from memory.
  if (cached && (!isAbsolute(cached) || existsSync(cached))) return cached;
  const selection = readRuntimeSelection(root);
  const owned = runtimeCli(root, platform);
  // The product only runs its own private worker. A personal Hermes on PATH is
  // someone else's install: in production an absent private worker reads as
  // missing so automatic setup installs one, never as an unsupported release.
  const fallback = productionRuntime() ? owned : "hermes";
  const cli = selection.selected ? runtimeCli(releaseHome(root, selection.selected), platform) : existsSync(owned) ? owned : fallback;
  processSelections.set(key, cli);
  return cli;
}
function productionRuntime(): boolean {
  return process.env.REALBUD_PRODUCTION === "1" || process.env.REALBUD_MANAGED_SERVICE === "1";
}
export function resetRuntimeSelectionForTests(): void { processSelections.clear(); refused.clear(); }
/** Only used after a verified first install, when no working worker existed. */
export function adoptFirstRuntime(root: string): void { processSelections.delete(`${root}\0${process.platform}`); }
