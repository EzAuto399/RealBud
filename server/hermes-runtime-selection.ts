import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { hermesHome, runtimeCli } from "./hermes-paths.ts";

export interface RuntimeSelection { version: 1; selected: string | null; previous: string | null; previousAvailable?: boolean }
const validCommit = (value: unknown): value is string | null => value === null || (typeof value === "string" && /^[a-f0-9]{40}(?:-[a-f0-9]{12})?$/.test(value));
export const runtimeCommit = (id: string | null): string | null => id?.split("-")[0] ?? null;
export function readRuntimeSelection(home: string): RuntimeSelection {
  try {
    const value = JSON.parse(readFileSync(join(home, "realbud-runtime.json"), "utf8"));
    if (value.version !== 1 || !validCommit(value.selected) || !validCommit(value.previous)) throw new Error();
    if (value.previousAvailable !== undefined && typeof value.previousAvailable !== "boolean") throw new Error();
    return { version: 1, selected: value.selected, previous: value.previous, previousAvailable: value.previousAvailable ?? value.previous !== null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, selected: null, previous: null };
    throw Object.assign(new Error("Bud’s runtime selection could not be read. Your files have been kept; repair the selection before updating."), { status: 409 });
  }
}
export const releaseHome = (home: string, commit: string): string => {
  if (!validCommit(commit) || !commit) throw new Error("Invalid runtime release");
  return join(home, "runtimes", commit);
};
export function saveRuntimeSelection(home: string, selection: RuntimeSelection): void {
  if (selection.version !== 1 || !validCommit(selection.selected) || !validCommit(selection.previous)) throw new Error("Invalid runtime selection");
  if (selection.previousAvailable !== undefined && typeof selection.previousAvailable !== "boolean") throw new Error("Invalid runtime selection");
  writeFileAtomic(join(home, "realbud-runtime.json"), JSON.stringify(selection), 0o600);
}

// An update changes the next app launch. All calls in this process continue
// using one executable, including warm ACP sessions and the RealBud clock.
const processSelections = new Map<string, string>();
export function selectedHermesCli(root = hermesHome(), platform = process.platform): string {
  const override = process.env.REALBUD_HERMES_CLI?.trim();
  if (override) return override;
  const key = `${root}\0${platform}`;
  const cached = processSelections.get(key);
  if (cached) return cached;
  const selection = readRuntimeSelection(root);
  const owned = runtimeCli(root, platform);
  const cli = selection.selected ? runtimeCli(releaseHome(root, selection.selected), platform) : existsSync(owned) ? owned : "hermes";
  processSelections.set(key, cli);
  return cli;
}
export function resetRuntimeSelectionForTests(): void { processSelections.clear(); }
/** Only used after a verified first install, when no working worker existed. */
export function adoptFirstRuntime(root: string): void { processSelections.delete(`${root}\0${process.platform}`); }
