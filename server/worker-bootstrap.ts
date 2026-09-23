// Run only the reviewed upstream runtime stages. Never run its model wizard,
// messaging gateway or desktop app installer.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { writeFileAtomic } from "./atomic.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERMES_RECOMMENDED, type HermesRelease } from "./hermes-releases.ts";
import { windowsHermesRuntimeEnv } from "./hermes-runtime-env.ts";
import { augmentedPath } from "./env-path.ts";
import { killCliTree, spawnCli } from "./procs.ts";

// The OS releases this transaction lock on process death. The durable child
// record separately prevents a retry from overlapping an orphaned installer.
export class BootstrapError extends Error {}
type SetupRecord = { version: 1; pending: boolean; childPid: number | null; spawning?: boolean };
const recordPath = (home: string) => join(home, ".realbud-bootstrap.json");
function readRecord(home: string): SetupRecord | null {
  if (!existsSync(recordPath(home))) return null;
  try {
    const record = JSON.parse(readFileSync(recordPath(home), "utf8"));
    if (record.version !== 1 || typeof record.pending !== "boolean" || !(record.childPid === null || (Number.isInteger(record.childPid) && record.childPid > 0))) throw new BootstrapError();
    return record;
  } catch { throw new BootstrapError("Bud’s previous setup record could not be read. Contact support before replacing it."); }
}
function saveRecord(home: string, record: SetupRecord) { writeFileAtomic(recordPath(home), JSON.stringify(record), 0o600); }
export function bootstrapPending(home: string): boolean {
  try { return readRecord(home)?.pending ?? false; } catch { return true; }
}
export function finishWorkerBootstrap(home: string) {
  if (readRecord(home)) saveRecord(home, { version: 1, pending: false, childPid: null });
}
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
export function bootstrapChildRunning(home: string): boolean {
  const record = readRecord(home);
  return Boolean(record?.spawning || (record?.childPid && (processAlive(record.childPid) || (process.platform !== "win32" && processAlive(-record.childPid)))));
}
/** Shared by installers and runtime selection changes across app processes. */
export function acquireWorkerSetupLock(home: string) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(join(home, ".realbud-bootstrap-lock.sqlite"));
  } catch { throw new BootstrapError("Bud could not save setup progress. Check available space and folder permissions."); }
  try {
    database.exec("BEGIN EXCLUSIVE");
    return () => { try { database.exec("ROLLBACK"); } finally { database.close(); } };
  } catch (error) {
    database.close();
    if ([5, 6].includes((error as { errcode?: number }).errcode ?? -1)) throw new BootstrapError("Bud setup is already running in another RealBud window. Let it finish before trying again.");
    throw new BootstrapError("Bud could not save setup progress. Check available space and folder permissions.");
  }
}
function acquireSetup(home: string) {
  const release = acquireWorkerSetupLock(home);
  try {
    const previous = readRecord(home);
    if (previous?.spawning) throw new BootstrapError("Setup was interrupted while starting a component. Contact support before retrying so a second installation cannot overlap it.");
    if (previous?.childPid && (processAlive(previous.childPid) || (process.platform !== "win32" && processAlive(-previous.childPid)))) throw new BootstrapError("An earlier setup is still finishing. Wait for it to stop, then try again.");
    if (!previous && existsSync(join(home, "hermes-agent"))) throw new BootstrapError("An existing installation was found and kept. Contact support to connect it without replacing its files.");
    saveRecord(home, { version: 1, pending: true, childPid: null });
    return release;
  } catch (error) {
    release();
    if (error instanceof BootstrapError) throw error;
    throw new BootstrapError("Bud could not save setup progress. Check available space and folder permissions.");
  }
}

export const BOOTSTRAP_STAGES = {
  unix: ["prerequisites", "repository", "venv", "python-deps", "node-deps", "path", "config", "complete"],
  // Managed Python lives inside the checkout. Clone first so the repository
  // stage cannot park a runtime-only directory and strand the interpreter.
  windows: ["uv", "git", "node", "system-packages", "repository", "python", "venv", "dependencies", "node-deps", "path", "config-templates", "platform-sdks", "bootstrap-marker"],
} as const;
export function bootstrapPlan(platform: NodeJS.Platform, release: HermesRelease = HERMES_RECOMMENDED, privateRuntime = false) {
  if (!["darwin", "linux", "win32"].includes(platform)) return null;
  const kind = platform === "win32" ? "windows" : "unix";
  const file = platform === "win32" ? "install.ps1" : "install.sh";
  const stages = privateRuntime ? BOOTSTRAP_STAGES[kind].filter(stage => stage !== "path") : BOOTSTRAP_STAGES[kind];
  return { file, sha256: release.installers[kind], stages, url: `https://raw.githubusercontent.com/NousResearch/hermes-agent/${release.commit}/scripts/${file}` };
}

export function bootstrapInvocation(platform: NodeJS.Platform, file: string, stage: string, home: string, release: HermesRelease = HERMES_RECOMMENDED, privateRuntime = false) {
  const plan = bootstrapPlan(platform, release, privateRuntime);
  if (!plan || !(plan.stages as readonly string[]).includes(stage)) throw new BootstrapError("Unsupported setup stage");
  // `-ExecutionPolicy Bypass` applies to this PowerShell process only and
  // changes no machine or user policy. It is safe here because the script is
  // already the sha256-verified bytes from `downloadBootstrap` — verification
  // happens before the spawn, so Bypass never widens what may run. Without it
  // a default Windows 11 client policy (`Restricted`) refuses any `.ps1`
  // passed to `-File`, and setup fails before the first stage.
  return platform === "win32"
    ? { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, "-Stage", stage, "-NonInteractive", "-SkipSetup", "-SkipComputerUse", "-Commit", release.commit, "-ForceCommit", "-HermesHome", home, "-InstallDir", join(home, "hermes-agent")] }
    : { command: "/bin/bash", args: [file, "--stage", stage, "--non-interactive", "--skip-setup", "--skip-computer-use", "--commit", release.commit, "--force-commit", "--hermes-home", home, "--dir", join(home, "hermes-agent")] };
}

export function bootstrapStageLabel(stage: string): string {
  if (["prerequisites", "uv", "python", "git", "node", "system-packages"].includes(stage)) return "Preparing this computer";
  if (stage === "repository") return "Downloading Bud";
  if (["venv", "python-deps", "dependencies", "node-deps", "platform-sdks"].includes(stage)) return "Installing Bud’s components";
  return "Finishing setup";
}

export async function downloadBootstrap(plan: { url: string; sha256: string }, signal: AbortSignal, request: typeof fetch = fetch): Promise<Uint8Array> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  let response: Response;
  try { response = await request(plan.url, { signal: bounded, redirect: "error" }); }
  catch { throw new BootstrapError("Couldn’t download Bud setup. Check your connection, then try again."); }
  if (!response.ok || !response.body) throw new BootstrapError("Bud setup could not be downloaded. Try again shortly.");
  const reader = response.body.getReader();
  const abortRead = () => { void reader.cancel().catch(() => {}); };
  bounded.addEventListener("abort", abortRead, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      bounded.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1_000_000) throw new BootstrapError("Unexpected setup download size");
      chunks.push(value);
    }
    bounded.throwIfAborted();
  } finally { bounded.removeEventListener("abort", abortRead); await reader.cancel().catch(() => {}); }
  const bytes = Buffer.concat(chunks);
  if (createHash("sha256").update(bytes).digest("hex") !== plan.sha256) throw new BootstrapError("The setup download didn’t match the verified version. Nothing from it was run. Try again.");
  return bytes;
}

export function bootstrapStageEnv(home: string, source: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  let env: NodeJS.ProcessEnv = { ...source, HERMES_HOME: home, UV_NO_CONFIG: "1" };
  if (platform === "win32") {
    env = windowsHermesRuntimeEnv(home, env);
    // Setup and its nested installers use Windows PowerShell 5.1. Inheriting
    // PowerShell 7 module roots can make even Get-ExecutionPolicy fail to load.
    // Remove every spelling before pinning the case-insensitive Windows name.
    for (const key of Object.keys(env)) if (key.toLowerCase() === "psmodulepath") delete env[key];
    const systemRoot = source.SystemRoot ?? Object.entries(source).find(([key]) => key.toLowerCase() === "systemroot")?.[1] ?? "C:\\Windows";
    env.PSModulePath = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules");
  }
  // Install stages need no provider credentials or personal Python overrides.
  for (const key of Object.keys(env)) if (/API_KEY$|_TOKEN$|_SECRET$|_PASSWORD$|^PYTHON(PATH|HOME)$|^VIRTUAL_ENV$/.test(key)) delete env[key];
  return env;
}

type StageRun = (invocation: { command: string; args: string[] }, home: string, signal: AbortSignal, recordHome?: string) => Promise<void>;
export const runBootstrapStage: StageRun = (invocation, home, signal, recordHome = home) => new Promise((resolve, reject) => {
  signal.throwIfAborted();
  const env = bootstrapStageEnv(home, { ...process.env, PATH: augmentedPath() }, process.platform);
  saveRecord(recordHome, { version: 1, pending: true, childPid: null, spawning: true });
  const child = spawnCli(invocation.command, invocation.args, { env, privateFiles: true, stdio: ["ignore", "pipe", "pipe"] });
  let recordFailed = false;
  try { saveRecord(recordHome, { version: 1, pending: true, childPid: child.pid ?? null }); }
  catch { recordFailed = true; }
  // Drain output without retaining paths, environment values or provider text.
  child.stdout?.resume(); child.stderr?.resume();
  let forceStop: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    killCliTree(child);
    if (!forceStop && process.platform !== "win32") forceStop = setTimeout(() => {
      if (!child.pid) return;
      try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
    }, 2000);
  };
  signal.addEventListener("abort", abort, { once: true });
  const cleanup = () => {
    signal.removeEventListener("abort", abort);
    if (forceStop) clearTimeout(forceStop);
    // Keep the PID until the next attempt: the process group may outlive its
    // leader after an unusual installer failure. A retry checks both.
  };
  child.once("error", () => { cleanup(); reject(new BootstrapError("This computer could not start setup. Your office’s installation policy may need attention.")); });
  child.once("close", code => {
    cleanup();
    if (recordFailed) reject(new BootstrapError("Bud could not save setup progress. Check available space and folder permissions before retrying."));
    else if (signal.aborted) reject(new BootstrapError("Setup stopped. You can try again when you’re ready."));
    else if (code !== 0) reject(new BootstrapError("Setup couldn’t finish this step. Check your connection, available space and any system installation prompt, then try again."));
    else resolve();
  });
  if (signal.aborted || recordFailed) abort();
});

export async function runWorkerBootstrap(options: {
  home: string; signal: AbortSignal; platform?: NodeJS.Platform;
  release?: HermesRelease; privateRuntime?: boolean; lockHome?: string;
  progress: (detail: string, step: number, total: number) => void;
  request?: typeof fetch; execute?: StageRun;
  finalize?: () => Promise<void>;
  download?: typeof downloadBootstrap;
}) {
  if (process.env.VITEST && !options.execute) throw new BootstrapError("Real installation is disabled in automated tests.");
  const platform = options.platform ?? process.platform;
  const plan = bootstrapPlan(platform, options.release, options.privateRuntime);
  if (!plan) throw new BootstrapError("Automatic Bud setup is not available on this computer yet.");
  const release = acquireSetup(options.lockHome ?? options.home);
  let temp: string | undefined;
  try {
    options.progress("Downloading verified setup", 0, plan.stages.length);
    const bytes = await (options.download ?? downloadBootstrap)(plan, options.signal, options.request);
    temp = mkdtempSync(join(tmpdir(), "realbud-bootstrap-"));
    const file = join(temp, plan.file);
    writeFileSync(file, bytes, { mode: 0o600 });
    for (const [index, stage] of plan.stages.entries()) {
      options.signal.throwIfAborted();
      options.progress(bootstrapStageLabel(stage), index + 1, plan.stages.length);
      await (options.execute ?? runBootstrapStage)(bootstrapInvocation(platform, file, stage, options.home, options.release, options.privateRuntime), options.home, options.signal, options.lockHome);
    }
    await options.finalize?.();
  } finally {
    try { if (temp) rmSync(temp, { recursive: true, force: true }); }
    finally { release(); }
  }
}
