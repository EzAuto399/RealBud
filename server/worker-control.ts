// RealBud's own records about its worker: which runtime is selected, which
// downloads finished, which model each seat chose, and a pending removal.
// They live in `D/worker-control/`, outside the worker home, so deleting or
// replacing the worker (Hermes) keeps them. Writes go through private JSON
// with a `.prev` recovery copy; synchronous readers (`hermesCli()`,
// `modelStatus()`) read the same file through a checked descriptor.
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { readPrivateFileSync } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { writePrivateJson } from "./private-json.ts";
import { isManagedModelChoice, type ManagedModelChoiceId } from "../shared/managed-model-choices.ts";

/** `D/worker-control` beside the product's worker home `D/hermes` (every
 * process of an office shares it). Any other home (tests, a developer
 * override) gets its own folder under this data folder, still outside it. */
export function workerControlDir(home: string): string {
  const owned = resolve(home);
  if (basename(owned) === "hermes") return join(dirname(owned), "worker-control");
  return join(DATA_DIR, "worker-control", "homes", createHash("sha256").update(owned).digest("hex").slice(0, 16));
}
export const controlPath = (home: string, name: "runtime-selection" | "completed-runtime" | "model-choice" | "removal") =>
  join(workerControlDir(home), `${name}.json`);

export class WorkerControlDamaged extends Error {
  readonly status = 409;
  readonly code = "worker_control_needs_recovery";
}

/** The parsed record, or undefined when absent. A link, a foreign owner, a
 * second name or unreadable JSON is damage: kept on disk, never replaced. */
export function readControlSync(path: string, maxBytes = 64_000): unknown {
  let text: string | null;
  try { text = readPrivateFileSync(path, maxBytes); }
  catch { throw new WorkerControlDamaged("A RealBud worker record needs recovery."); }
  if (text === null) return undefined;
  try { return JSON.parse(text) as unknown; }
  catch { throw new WorkerControlDamaged("A RealBud worker record needs recovery."); }
}

const queues = new Map<string, Promise<unknown>>();
/** One read-modify-write at a time per record in this process. */
export function mutateControl<T>(path: string, work: () => Promise<T>): Promise<T> {
  const next = (queues.get(path) ?? Promise.resolve()).then(work);
  const settled = next.then(() => {}, () => {});
  queues.set(path, settled);
  void settled.finally(() => { if (queues.get(path) === settled) queues.delete(path); });
  return next;
}

/** temp → fsync → rename at 0600, keeping the replaced copy as `.prev`. An
 * existing record that fails `validate` is never overwritten. */
export function writeControl(path: string, value: unknown, validate: (value: unknown) => void, maxBytes = 64_000): Promise<void> {
  return writePrivateJson(path, value, { maxBytes, validate, keepPrevious: true });
}

// ── model choice (M1) ───────────────────────────────────────────────────
// The office's choice is canonical here; the worker profile is a projection
// of it. Keyed by worker profile name, which derives from the authenticated
// seat (`hermesProfileFor`), never from a request.

export type ModelChoiceSource = "profile" | "provisioning" | "default" | "office";
interface ModelChoiceEntry { choice: ManagedModelChoiceId; source: ModelChoiceSource; at: string }
interface ModelChoiceRecord {
  version: 1; purpose: "worker-model-choice";
  profiles: Record<string, ModelChoiceEntry>;
  history: Array<ModelChoiceEntry & { profile: string }>;
}
const SOURCES: readonly ModelChoiceSource[] = ["profile", "provisioning", "default", "office"];
const MAX_PROFILES = 64, MAX_HISTORY = 50;
const validEntry = (row: unknown): boolean => {
  const entry = row as Record<string, unknown> | null;
  return !!entry && typeof entry === "object" && isManagedModelChoice(entry.choice) &&
    SOURCES.includes(entry.source as ModelChoiceSource) && typeof entry.at === "string";
};
function validateModelChoices(value: unknown): void {
  const row = value as Record<string, unknown> | null;
  if (!row || typeof row !== "object" || row.version !== 1 || row.purpose !== "worker-model-choice" ||
    !row.profiles || typeof row.profiles !== "object" || Array.isArray(row.profiles) ||
    Object.keys(row.profiles).length > MAX_PROFILES || !Object.values(row.profiles).every(validEntry) ||
    !Array.isArray(row.history) || row.history.length > MAX_HISTORY ||
    !row.history.every(entry => validEntry(entry) && typeof (entry as { profile?: unknown }).profile === "string")) {
    throw new WorkerControlDamaged("Bud's saved model choice needs recovery. Your files are kept.");
  }
}
function modelChoices(home: string): ModelChoiceRecord | undefined {
  const value = readControlSync(controlPath(home, "model-choice"));
  if (value === undefined) return undefined;
  validateModelChoices(value);
  return value as ModelChoiceRecord;
}

/** The saved choice for one worker profile; null when none is saved or the
 * record needs recovery (readers then fall back to the profile itself). */
export function storedModelChoice(home: string, profile: string): ManagedModelChoiceId | null {
  try { return modelChoices(home)?.profiles[profile]?.choice ?? null; } catch { return null; }
}

/** Commit a choice before anything projects it into the worker. With
 * `ifAbsent`, an already saved choice wins and is returned (seeding). */
export function commitModelChoice(home: string, profile: string, choice: ManagedModelChoiceId, source: ModelChoiceSource, opts: { ifAbsent?: boolean } = {}): Promise<ManagedModelChoiceId> {
  const path = controlPath(home, "model-choice");
  return mutateControl(path, async () => {
    const current = modelChoices(home) ?? { version: 1, purpose: "worker-model-choice", profiles: {}, history: [] };
    const saved = current.profiles[profile];
    if (saved && (opts.ifAbsent || saved.choice === choice)) return saved.choice;
    if (!saved && Object.keys(current.profiles).length >= MAX_PROFILES) throw new WorkerControlDamaged("Too many saved model choices on this computer.");
    const entry: ModelChoiceEntry = { choice, source, at: new Date().toISOString() };
    await writeControl(path, {
      ...current, profiles: { ...current.profiles, [profile]: entry },
      history: [...current.history, { ...entry, profile }].slice(-MAX_HISTORY),
    }, validateModelChoices);
    return choice;
  });
}

// ── pending removal (M4) ────────────────────────────────────────────────

/** Anything at the removal path counts, including a damaged record: a
 * removal that cannot be read keeps launches and setup held. */
export function removalRequested(home: string): boolean {
  try { return readControlSync(controlPath(home, "removal")) !== undefined; } catch { return true; }
}
