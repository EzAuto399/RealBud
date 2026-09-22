import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { runtimeCli } from "./hermes-paths.ts";
import { selectedHermesCli } from "./hermes-runtime-selection.ts";
import { WORKER_MODEL_ENV_NAMES } from "./worker-model-access.ts";

/**
 * Put the installation's model gateway access into one worker launch.
 *
 * Call this AFTER the adapter has stripped ambient provider keys: the whole
 * point of that strip is that only a grant RealBud resolved may route a turn.
 * The key exists in the child's environment and the private vault, nowhere
 * else — never config.json, the oplog, a report or `/api/config`.
 *
 * Empty access leaves the environment exactly as it was, so a manually
 * attached model keeps working on an installation with no vendor provisioning.
 */
export function applyWorkerModelAccessEnv(env: NodeJS.ProcessEnv, access: Record<string, string>): void {
  for (const name of WORKER_MODEL_ENV_NAMES) {
    const value = access[name];
    if (typeof value === "string" && value) env[name] = value;
  }
}

/**
 * The adapter's env hook is synchronous, while resolving the grant reads the
 * vault. The composition refreshes this snapshot at boot and whenever a grant
 * is applied, withdrawn or cleared; the hook only copies it. An empty snapshot
 * means no vendor provisioning, so nothing changes for a manually attached model.
 */
let workerModelAccessCurrent: Record<string, string> = {};
export function setWorkerModelAccessSnapshot(access: Record<string, string>): void {
  workerModelAccessCurrent = { ...access };
}
export function workerModelAccessSnapshot(): Record<string, string> {
  return { ...workerModelAccessCurrent };
}

/** Runtime dependencies live beside the installed engine, not in a staff
 * profile. Installer PATH changes never refresh a running Electron parent. */
export function windowsHermesRuntimeEnv(home: string, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  const originalPath = env.PATH ?? Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
  const dirs = [join(home, "hermes-agent", "venv", "Scripts"), join(home, "node"), join(home, "bin"),
    join(home, "git", "cmd"), join(home, "git", "usr", "bin"), join(home, "git", "bin")].filter(existsSync);
  env.PATH = [...dirs, originalPath].filter(Boolean).join(";");
  const bash = [join(home, "git", "usr", "bin", "bash.exe"), join(home, "git", "bin", "bash.exe")].find(existsSync);
  if (bash) env.HERMES_GIT_BASH_PATH = bash;
  env.PYTHONIOENCODING = "utf-8"; env.PYTHONUTF8 = "1";
  return env;
}

export function windowsHermesGit(home: string): string {
  const owned = join(home, "git", "cmd", "git.exe");
  return existsSync(owned) ? owned : "git";
}

/** Resolve the process-cached CLI, so a staged update cannot redirect a live
 * worker's dependencies to the next release or to a personal Hermes home. */
export function selectedWindowsRuntimeHome(home: string): string | null {
  const cli = selectedHermesCli(home, "win32");
  if (cli === runtimeCli(home, "win32")) return home;
  const candidate = dirname(dirname(dirname(dirname(cli))));
  return dirname(candidate) === join(home, "runtimes") && /^[a-f0-9]{40}(?:-[a-f0-9]{12})?$/.test(basename(candidate)) &&
    cli === runtimeCli(candidate, "win32") ? candidate : null;
}
