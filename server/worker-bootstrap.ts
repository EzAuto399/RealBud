// Run only the reviewed upstream runtime stages. Never run its model wizard,
// messaging gateway or desktop app installer.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { restrictNewSync, writeFileAtomic } from "./atomic.ts";
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

// Retry only when the server said "later" or the connection dropped. A hash
// mismatch, size breach, redirect or any other 4xx is final: the pinned bytes
// cannot change on a second request.
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_BACKOFF_MS = [5_000, 15_000];
const MAX_RETRY_AFTER_MS = 60_000;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const CONNECTION_RESET = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);
const CONNECTION_FAILED = "Couldn’t download Bud setup. Check your connection, then try again.";
class RetryableDownload extends BootstrapError {
  readonly delayMs?: number;
  constructor(message: string, delayMs?: number) { super(message); this.delayMs = delayMs; }
}
function connectionReset(error: unknown): boolean {
  for (let cause = error, depth = 0; cause instanceof Object && depth < 4; cause = (cause as { cause?: unknown }).cause, depth++)
    if (CONNECTION_RESET.has(String((cause as { code?: unknown }).code))) return true;
  return false;
}
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const ms = /^\s*\d+\s*$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
  return ms > 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : undefined;
}
const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason);
  const stop = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
  signal.addEventListener("abort", stop, { once: true });
});

export async function downloadBootstrap(plan: { url: string; sha256: string }, signal: AbortSignal, request: typeof fetch = fetch): Promise<Uint8Array> {
  for (let attempt = 1; ; attempt++) {
    try { return await downloadBootstrapOnce(plan, signal, request); }
    catch (error) {
      if (!(error instanceof RetryableDownload) || attempt >= DOWNLOAD_ATTEMPTS) throw error;
      await pause(error.delayMs ?? DOWNLOAD_BACKOFF_MS[attempt - 1], signal);
    }
  }
}

async function downloadBootstrapOnce(plan: { url: string; sha256: string }, signal: AbortSignal, request: typeof fetch): Promise<Uint8Array> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  let response: Response;
  try { response = await request(plan.url, { signal: bounded, redirect: "error" }); }
  catch (error) { throw !signal.aborted && connectionReset(error) ? new RetryableDownload(CONNECTION_FAILED) : new BootstrapError(CONNECTION_FAILED); }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    if (RETRYABLE_STATUS.has(response.status)) throw new RetryableDownload(response.status === 429
      ? "The download server is busy (429). Try again in a few minutes."
      : `The download server is unavailable (${response.status}). Try again in a few minutes.`, retryAfterMs(response.headers.get("retry-after")));
    throw new BootstrapError("Bud setup could not be downloaded. Try again shortly.");
  }
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
  } catch (error) {
    if (!(error instanceof BootstrapError) && !signal.aborted && connectionReset(error)) throw new RetryableDownload(CONNECTION_FAILED);
    throw error;
  } finally { bounded.removeEventListener("abort", abortRead); await reader.cancel().catch(() => {}); }
  const bytes = Buffer.concat(chunks);
  if (createHash("sha256").update(bytes).digest("hex") !== plan.sha256) throw new BootstrapError("The setup download didn’t match the verified version. Nothing from it was run. Try again.");
  return bytes;
}

export function bootstrapStageEnv(home: string, source: NodeJS.ProcessEnv, platform: NodeJS.Platform, gitConfigFile?: string): NodeJS.ProcessEnv {
  let env: NodeJS.ProcessEnv = { ...source, HERMES_HOME: home, UV_NO_CONFIG: "1" };
  if (platform === "win32") {
    env = windowsHermesRuntimeEnv(home, env);
    // Setup and its nested installers use Windows PowerShell 5.1. Inheriting
    // PowerShell 7 module roots can make even Get-ExecutionPolicy fail to load.
    // Remove every spelling before pinning the case-insensitive Windows name.
    for (const key of Object.keys(env)) if (key.toLowerCase() === "psmodulepath") delete env[key];
    const systemRoot = source.SystemRoot ?? Object.entries(source).find(([key]) => key.toLowerCase() === "systemroot")?.[1] ?? "C:\\Windows";
    env.PSModulePath = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules");
    if (!gitConfigFile) throw new BootstrapError("Windows setup requires its private Git configuration.");
    // The pinned installer sets autocrlf only after cloning, when CRLF files
    // already appear modified. Apply it before every Git call, and direct the
    // installer's --global writes to our owned file rather than the user's.
    // Keep system configuration (including TLS/proxy settings) unchanged.
    for (const key of Object.keys(env)) if (/^GIT_CONFIG(?:$|_(?:GLOBAL|PARAMETERS|COUNT)$|_(?:KEY|VALUE)_\d+$)/i.test(key)) delete env[key];
    env.GIT_CONFIG_GLOBAL = gitConfigFile;
  }
  // Install stages need no provider credentials or personal Python overrides.
  for (const key of Object.keys(env)) if (/API_KEY$|_TOKEN$|_SECRET$|_PASSWORD$|^PYTHON(PATH|HOME)$|^VIRTUAL_ENV$/.test(key)) delete env[key];
  return env;
}

type StageRun = (invocation: { command: string; args: string[] }, home: string, signal: AbortSignal, recordHome?: string) => Promise<void>;
const startBootstrapStage = (invocation: Parameters<StageRun>[0], recordHome: string, signal: AbortSignal, env: NodeJS.ProcessEnv) => new Promise<void>((resolve, reject) => {
  signal.throwIfAborted();
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

export const runBootstrapStage: StageRun = async (invocation, home, signal, recordHome = home) => {
  signal.throwIfAborted();
  let gitConfigDirectory: string | undefined;
  let failed = false;
  try {
    let gitConfigFile: string | undefined;
    if (process.platform === "win32") {
      gitConfigDirectory = mkdtempSync(join(tmpdir(), "realbud-bootstrap-git-"));
      restrictNewSync([{ path: gitConfigDirectory, kind: "directory" }]);
      gitConfigFile = join(gitConfigDirectory, "config");
      writeFileAtomic(gitConfigFile, "[core]\n\tautocrlf = false\n", 0o600);
    }
    const env = bootstrapStageEnv(home, { ...process.env, PATH: augmentedPath() }, process.platform, gitConfigFile);
    await startBootstrapStage(invocation, recordHome, signal, env);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (gitConfigDirectory) {
      try { rmSync(gitConfigDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
      catch { if (!failed) throw new BootstrapError("Bud could not remove its temporary setup files. Check folder permissions before retrying."); }
    }
  }
};

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
