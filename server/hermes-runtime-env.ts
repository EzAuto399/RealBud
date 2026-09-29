import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { runtimeCli } from "./hermes-paths.ts";
import { selectedHermesCli } from "./hermes-runtime-selection.ts";
import { WORKER_MODEL_ENV_NAMES, workerModelGrant } from "./worker-model-access.ts";
import { MANAGED_MODEL_API_MODE, MANAGED_MODEL_KEY_ENV, MANAGED_MODEL_PROVIDER, managedModelProfile } from "./hermes-pack.ts";

/**
 * Put the installation's model gateway access into one worker launch.
 *
 * Call this AFTER the adapter has stripped ambient provider keys: the whole
 * point of that strip is that only a grant RealBud resolved may route a turn.
 * The key exists in the child's environment and the private vault, nowhere
 * else — never config.json, the oplog, a report or `/api/config`.
 *
 * Empty access adds nothing: an unpaired installation has no model access,
 * and the adapter has already stripped every ambient provider key.
 */
export function applyWorkerModelAccessEnv(env: NodeJS.ProcessEnv, access: Record<string, string>): void {
  for (const name of WORKER_MODEL_ENV_NAMES) {
    const value = access[name];
    if (typeof value === "string" && value) env[name] = value;
  }
}

/** Office copy for a worker launch that has no usable managed model access. */
export const MANAGED_ACCESS_UNPAIRED = "Bud has no AI access on this computer yet. Pair this computer from realbud.app, then try again.";
export const MANAGED_ACCESS_WITHDRAWN = "This computer's AI access was withdrawn. Your records are kept. Ask RealBud support to restore access.";
export const MANAGED_ACCESS_MISMATCH = "Bud's private setup does not match this computer's AI access. Open Bud setup and choose Repair Bud, then try again.";
export const MANAGED_ACCESS_REFUSALS = [MANAGED_ACCESS_UNPAIRED, MANAGED_ACCESS_WITHDRAWN, MANAGED_ACCESS_MISMATCH] as const;

/** Gateway URLs compare without trailing slashes or surrounding space. */
export function normalizedGatewayUrl(value: unknown): string {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

/**
 * Why a model-using worker launch must not run, or null when it may.
 *
 * The profile's `config.yaml` sits in storage the worker itself can write, so
 * it is never trusted on its own: the key may only travel when the profile
 * names exactly the managed provider, key variable and wire, a valid choice,
 * no shadowing `.env` key, and the endpoint the vendor granted. Without an
 * active grant nothing may reason — an old profile's own `.env` key included.
 */
export function managedModelLaunchRefusal(root?: string): string | null {
  const grant = workerModelGrant();
  if (grant.state === "withdrawn") return MANAGED_ACCESS_WITHDRAWN;
  if (grant.state !== "active") return MANAGED_ACCESS_UNPAIRED;
  const profile = managedModelProfile(root);
  const matches = profile.provider === MANAGED_MODEL_PROVIDER && profile.keyEnv === MANAGED_MODEL_KEY_ENV &&
    profile.apiMode === MANAGED_MODEL_API_MODE && profile.choice !== null && !profile.envKeyPresent &&
    profile.baseUrl !== null && normalizedGatewayUrl(profile.baseUrl) === normalizedGatewayUrl(grant.baseUrl);
  return matches ? null : MANAGED_ACCESS_MISMATCH;
}

/**
 * The one place every worker launch receives the granted key. Call it AFTER
 * the adapter's strip. The key is added only when `managedModelLaunchRefusal`
 * passes for the profile this launch uses; otherwise nothing is added and the
 * refusal is returned for the caller to show instead of launching.
 */
export function applyManagedModelLaunchEnv(env: NodeJS.ProcessEnv, root?: string): string | null {
  const refusal = managedModelLaunchRefusal(root);
  if (refusal) return refusal;
  applyWorkerModelAccessEnv(env, workerModelAccessSnapshot());
  return null;
}

/**
 * The adapter's env hook is synchronous, while resolving the grant reads the
 * vault. The composition refreshes this snapshot at boot and whenever a grant
 * is applied, withdrawn or cleared; the hook only copies it. An empty snapshot
 * means no vendor provisioning, so the worker gets no model key.
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
