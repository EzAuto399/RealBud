// Zero-terminal worker bridge: RealBud takes the PM's input and delivers it
// to the pinned Hermes worker programmatically. The user never sees a
// terminal and never runs the hermes CLI.
//
// Model attach recipe (proven against the pinned worker's own source):
//   - API keys live in RealBud's encrypted worker secret store and are
//     injected only into the selected provider child process
//     (hermes resolves key-provider secrets from that dotenv first).
//   - The default model lives in the profile `config.yaml` model block:
//       model:
//         default: <model-id>
//         provider: <provider-id>
//         base_url: ''
// Install runs the pinned installer as a spawned child with streamed
// output — same command the terminal used to run, no terminal.
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

import {
  WORKER_PROVIDERS,
  workerProvider,
  type WorkerProviderOption,
} from "../shared/worker-providers.ts";
import { augmentedPath } from "./env-path.ts";
import { fsyncDir, writeFileAtomic } from "./atomic.ts";
import { workerCli, workerCliForRuntime, workerInstallDirForRuntime } from "./config.ts";
import { HERMES_PIN } from "./hermes-pin.ts";
import { hermesHome, propertyProfileDir, withYamlBlock, yamlBlock } from "./hermes-pack.ts";
import { hermesStatus } from "./hermes-status.ts";
import { killCliTree } from "./procs.ts";
import { SecretStore } from "./secret-store.ts";
import {
  activateStagedWorkerRuntime,
  commitActivatedWorkerRuntime,
  discardWorkerRuntimeStage,
  prepareWorkerRuntimeStage,
  rollbackActivatedWorkerRuntime,
  type WorkerRuntimeSlot,
} from "./worker-runtime.ts";

export type ProviderOption = WorkerProviderOption;

/** Curated key providers (ids/env vars mirror the worker's own registry). */
export const PROVIDER_OPTIONS: readonly ProviderOption[] = WORKER_PROVIDERS;

export interface PreflightEntry {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PreflightResult {
  ok: boolean;
  deps: PreflightEntry[];
}

/**
 * A pinned private worker currently occupies roughly 1.6 GiB. Installation
 * writes a complete inactive runtime before activation, so reserve enough for
 * that staged copy plus installer caches and a bounded safety margin.
 */
export const MIN_WORKER_INSTALL_FREE_BYTES = 3n * 1024n * 1024n * 1024n;

export interface WorkerStorageSnapshot {
  availableBlocks: bigint;
  blockSize: bigint;
}

export type WorkerStorageProbe = (path: string) => WorkerStorageSnapshot;

const defaultWorkerStorageProbe: WorkerStorageProbe = (path) => {
  const stats = statfsSync(path, { bigint: true });
  return { availableBlocks: stats.bavail, blockSize: stats.bsize };
};

function nearestExistingAncestor(path: string): string {
  let candidate = path;
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return candidate;
}

function gibibytes(bytes: bigint): string {
  const mib = bytes / (1024n * 1024n);
  return `${(Number(mib) / 1024).toFixed(1)} GB`;
}

/** Read-only capacity gate. It runs before staging removes or creates any
 * runtime slot, so a low-space refusal leaves the active worker untouched. */
export function workerStoragePreflight(
  root = hermesHome(),
  probe: WorkerStorageProbe = defaultWorkerStorageProbe,
): PreflightEntry {
  try {
    const snapshot = probe(nearestExistingAncestor(root));
    const available = snapshot.availableBlocks * snapshot.blockSize;
    if (available < MIN_WORKER_INSTALL_FREE_BYTES) {
      return {
        name: "storage",
        ok: false,
        detail: `${gibibytes(available)} free; Bud needs ${gibibytes(MIN_WORKER_INSTALL_FREE_BYTES)} to prepare safely`,
      };
    }
    return { name: "storage", ok: true, detail: `${gibibytes(available)} free` };
  } catch {
    return { name: "storage", ok: false, detail: "free space could not be verified" };
  }
}

function whichOne(bin: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: 8_000, env: { ...process.env, PATH: augmentedPath() } }, (err, stdout) => {
      resolve({ ok: !err, detail: err ? "not found" : String(stdout).trim().split("\n")[0]?.slice(0, 80) ?? "" });
    });
  });
}

export async function preflight(
  root = hermesHome(),
  storageProbe: WorkerStorageProbe = defaultWorkerStorageProbe,
): Promise<PreflightResult> {
  const [curl, git, py] = await Promise.all([whichOne("curl"), whichOne("git"), whichOne("python3")]);
  const deps: PreflightEntry[] = [
    { name: "curl", ok: curl.ok, detail: curl.detail },
    { name: "git", ok: git.ok, detail: git.detail },
    { name: "python3", ok: py.ok, detail: py.detail },
    workerStoragePreflight(root, storageProbe),
  ];
  return { ok: deps.every((d) => d.ok), deps };
}

// ── install job (singleton: one worker install at a time) ────────────────

export interface InstallJob {
  state: "idle" | "preflight" | "running" | "verifying" | "activating" | "rolling-back" | "done" | "failed";
  lines: string[];
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  rollback: "available" | "restored" | null;
}

const installJob: InstallJob = {
  state: "idle",
  lines: [],
  startedAt: null,
  finishedAt: null,
  error: null,
  rollback: null,
};
let installProc: ChildProcess | null = null;
let installTimedOut = false;

export function installStatus(): InstallJob {
  return { ...installJob, lines: installJob.lines.slice(-40) };
}

export function workerInstallInProgress(): boolean {
  return ["preflight", "running", "verifying", "activating", "rolling-back"].includes(installJob.state);
}

export function startInstall(
  command: string,
  opts?: { timeoutMs?: number; root?: string; storageProbe?: WorkerStorageProbe },
): InstallJob {
  if (workerInstallInProgress()) {
    return installStatus();
  }
  installJob.state = "preflight";
  installJob.lines = [];
  installJob.startedAt = Date.now();
  installJob.finishedAt = null;
  installJob.error = null;
  installJob.rollback = null;
  installTimedOut = false;

  const root = hermesHome(opts?.root);
  const storage = workerStoragePreflight(root, opts?.storageProbe ?? defaultWorkerStorageProbe);
  if (!storage.ok) {
    installJob.state = "failed";
    installJob.error = storage.detail === "free space could not be verified"
      ? "RealBud could not verify enough free storage to prepare Bud safely. Try again after checking this Mac's storage; nothing was changed."
      : `Bud cannot be prepared safely: ${storage.detail}. Free space and try again; nothing was changed.`;
    installJob.finishedAt = Date.now();
    return installStatus();
  }
  installJob.state = "running";

  const push = (line: string) => {
    for (const part of String(line).split(/\r?\n/)) {
      const trimmed = part.trim();
      if (trimmed) installJob.lines.push(trimmed.slice(0, 200));
    }
    if (installJob.lines.length > 400) installJob.lines.splice(0, installJob.lines.length - 400);
  };

  let stageSlot: WorkerRuntimeSlot;
  let runtimeHome: string;
  let installDir: string;
  let cli: string;
  try {
    const paths = prepareWorkerRuntimeStage(root);
    stageSlot = paths.slot;
    runtimeHome = paths.staged;
    installDir = workerInstallDirForRuntime(runtimeHome);
    cli = workerCliForRuntime(runtimeHome);
  } catch {
    installJob.state = "failed";
    installJob.error = "RealBud could not prepare a private worker update. Check available disk space and retry.";
    installJob.finishedAt = Date.now();
    return installStatus();
  }
  let child: ChildProcess;
  try {
    mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
    try { chmodSync(runtimeHome, 0o700); } catch { /* best effort */ }
    // The upstream installer helpfully invokes host package managers for
    // optional tools. That is unacceptable inside an application-owned
    // install: a missing rg/ffmpeg may degrade, but it must never mutate the
    // PM's Homebrew/apt state or ask for sudo. Install-only guards fail those
    // commands while leaving normal tools available on the inherited PATH.
    const guardDir = join(runtimeHome, ".install-guard", "bin");
    mkdirSync(guardDir, { recursive: true, mode: 0o700 });
    for (const name of ["brew", "apt", "apt-get", "dnf", "yum", "pacman", "apk", "pkg", "sudo", "ssh"]) {
      const guard = join(guardDir, name);
      writeFileSync(guard, "#!/bin/sh\nexit 126\n", { mode: 0o700 });
      try { chmodSync(guard, 0o700); } catch { /* best effort */ }
    }
    // RealBud owns the bounded browser and CUA runtimes. The pinned upstream
    // installer otherwise downloads a second Node runtime and roughly 1 GB of
    // browser/TUI workspace dependencies even with --skip-browser. Deny only
    // that optional nodejs.org bootstrap; the unchanged upstream script then
    // follows its supported Node-unavailable path and installs the Python
    // worker. GitHub, PyPI and its normal network probes still use system curl.
    const systemCurl = ["/usr/bin/curl", "/usr/local/bin/curl"].find((candidate) => existsSync(candidate));
    if (systemCurl) {
      const curlGuard = join(guardDir, "curl");
      writeFileSync(
        curlGuard,
        `#!/bin/sh\nfor arg in "$@"; do\n  case "$arg" in *nodejs.org/dist/*) exit 22;; esac\ndone\nexec ${JSON.stringify(systemCurl)} "$@"\n`,
        { mode: 0o700 },
      );
      try { chmodSync(curlGuard, 0o700); } catch { /* best effort */ }
    }
    // Present an intentionally old toolchain during the installer's probe so
    // it takes its own private Node download path. Once downloaded, upstream
    // prepends runtime/node/bin and these install-only shims are bypassed.
    for (const name of ["node", "npm", "npx"]) {
      const guard = join(guardDir, name);
      const version = name === "node" ? "v0.0.0" : "0.0.0";
      writeFileSync(
        guard,
        `#!/bin/sh\ncase "$1" in --version|-v) echo "${version}"; exit 0;; esac\nexit 126\n`,
        { mode: 0o700 },
      );
      try { chmodSync(guard, 0o700); } catch { /* best effort */ }
    }
    const installEnv: NodeJS.ProcessEnv = {
      ...process.env,
      // The upstream installer writes ~/.local/bin launchers and may create
      // caches/shell files. Point every one of those writes at RealBud's
      // private runtime, never the PM's home or personal Hermes tree.
      HOME: runtimeHome,
      // Install-time Hermes data (managed uv/node and checkout support files)
      // belongs to the runtime too. Worker processes switch HERMES_HOME back
      // to `root` when they launch so the property profile stays separate.
      HERMES_HOME: runtimeHome,
      HERMES_INSTALL_DIR: installDir,
      XDG_CACHE_HOME: join(runtimeHome, ".cache"),
      XDG_CONFIG_HOME: join(runtimeHome, ".config"),
      XDG_DATA_HOME: join(runtimeHome, ".local", "share"),
      XDG_STATE_HOME: join(runtimeHome, ".local", "state"),
      CARGO_HOME: join(runtimeHome, ".cargo"),
      NPM_CONFIG_CACHE: join(runtimeHome, ".cache", "npm"),
      NPM_CONFIG_PREFIX: join(runtimeHome, ".local"),
      PIP_CACHE_DIR: join(runtimeHome, ".cache", "pip"),
      PLAYWRIGHT_BROWSERS_PATH: join(runtimeHome, ".cache", "playwright"),
      UV_CACHE_DIR: join(runtimeHome, ".cache", "uv"),
      UV_PYTHON_BIN_DIR: join(runtimeHome, "bin"),
      UV_PYTHON_INSTALL_DIR: join(runtimeHome, "python"),
      UV_PYTHON_PREFERENCE: "only-managed",
      // Never consult personal Git config, credential helpers or SSH agents.
      // The installer tries SSH first; /bin/false makes it fall through to its
      // public HTTPS clone without touching personal keys.
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_SSH_COMMAND: "/usr/bin/false",
      GIT_TERMINAL_PROMPT: "0",
      PATH: [
        guardDir,
        join(runtimeHome, ".local", "bin"),
        join(runtimeHome, "bin"),
        join(runtimeHome, "node", "bin"),
        join(runtimeHome, ".cargo", "bin"),
        augmentedPath(),
      ].join(delimiter),
    };
    delete installEnv.SSH_AUTH_SOCK;
    delete installEnv.GH_TOKEN;
    delete installEnv.GITHUB_TOKEN;
    for (const provider of WORKER_PROVIDERS) {
      delete installEnv[provider.envVar];
      for (const alias of provider.alternateEnvVars) delete installEnv[alias];
    }
    child = spawn("/bin/bash", ["-c", command], {
      env: installEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(process.platform === "win32" ? {} : { detached: true }),
    });
  } catch {
    try { discardWorkerRuntimeStage(root, stageSlot); } catch { /* boot recovery will retry */ }
    installProc = null;
    installJob.state = "failed";
    installJob.error = "The private worker installer could not start. The active worker was unchanged.";
    installJob.finishedAt = Date.now();
    return installStatus();
  }
  installProc = child;
  child.stdout?.on("data", (c) => push(String(c)));
  child.stderr?.on("data", (c) => push(String(c)));
  const timeout = setTimeout(() => {
    if (installProc === child) {
      installTimedOut = true;
      killCliTree(child);
    }
  }, opts?.timeoutMs ?? 10 * 60_000);

  child.on("close", async (code) => {
    clearTimeout(timeout);
    if (installProc !== child) return;
    installProc = null;
    if (code !== 0) {
      try { discardWorkerRuntimeStage(root, stageSlot); } catch { /* boot recovery will retry */ }
      installJob.state = "failed";
      installJob.error = installTimedOut
        ? "The private worker install timed out. The active worker was unchanged."
        : code == null
          ? "The private worker install was interrupted. The active worker was unchanged."
          : `The private worker installer exited ${code}. The active worker was unchanged.`;
      installJob.finishedAt = Date.now();
      return;
    }
    installJob.state = "verifying";
    const verified = await hermesStatus({ root, cli, runtimeDir: runtimeHome });
    const version = verified.cli.versionText;
    if (version && verified.cli.matchesPin) {
      // A successful staged install/update gets a fresh opaque identity. UI
      // hands guidance tied to the prior private runtime must be re-tested.
      try {
        const receipt = join(runtimeHome, ".realbud-install-id");
        writeFileSync(receipt, `${randomUUID()}\n`, { mode: 0o600 });
        chmodSync(receipt, 0o600);
      } catch {
        try { discardWorkerRuntimeStage(root, stageSlot); } catch { /* boot recovery will retry */ }
        installJob.state = "failed";
        installJob.error = "The staged worker could not store its private verification receipt. The active worker was unchanged.";
        installJob.finishedAt = Date.now();
        return;
      }
      installJob.state = "activating";
      let previousAvailable = false;
      try {
        previousAvailable = activateStagedWorkerRuntime(root, stageSlot).previousAvailable;
      } catch {
        try { discardWorkerRuntimeStage(root, stageSlot); } catch { /* boot recovery will retry */ }
        installJob.state = "failed";
        installJob.error = "The verified worker could not be activated. The prior worker was restored.";
        installJob.finishedAt = Date.now();
        return;
      }

      const active = await hermesStatus({ root, cli: workerCli(root) });
      if (!active.cli.versionText || !active.cli.matchesPin) {
        installJob.state = "rolling-back";
        const restored = rollbackActivatedWorkerRuntime(root);
        installJob.state = "failed";
        installJob.rollback = restored ? "restored" : null;
        installJob.error = restored
          ? "The new worker failed its activation check, so RealBud restored the prior worker."
          : "The new worker failed its activation check and automatic rollback needs attention in You → Worker.";
        installJob.finishedAt = Date.now();
        return;
      }

      try {
        commitActivatedWorkerRuntime(root);
      } catch {
        installJob.state = "rolling-back";
        const restored = rollbackActivatedWorkerRuntime(root);
        installJob.state = "failed";
        installJob.rollback = restored ? "restored" : null;
        installJob.error = restored
          ? "RealBud could not commit the worker health receipt, so it restored the prior worker."
          : "RealBud could not commit the worker health receipt. Recovery needs attention in You → Worker.";
        installJob.finishedAt = Date.now();
        return;
      }

      installJob.state = "done";
      installJob.rollback = previousAvailable ? "available" : null;
      installJob.lines.push(`verified ${version.trim().slice(0, 60)}`);
      installJob.lines.push(previousAvailable ? "activated; previous worker retained for rollback" : "activated private worker");
    } else {
      try { discardWorkerRuntimeStage(root, stageSlot); } catch { /* boot recovery will retry */ }
      installJob.state = "failed";
      installJob.error = version
        ? `The staged worker did not match RealBud's v${HERMES_PIN.product} pin. The active worker was unchanged.`
        : "The installer did not create a worker in RealBud's private staging runtime. The active worker was unchanged.";
    }
    installJob.finishedAt = Date.now();
  });
  child.on("error", () => {
    clearTimeout(timeout);
    if (installProc !== child) return;
    installProc = null;
    try { discardWorkerRuntimeStage(root, stageSlot); } catch { /* boot recovery will retry */ }
    installJob.state = "failed";
    installJob.error = "The private worker installer could not start. The active worker was unchanged.";
    installJob.finishedAt = Date.now();
  });
  return installStatus();
}

/** Reap the complete installer pipeline on app shutdown. The upstream
 * command is a curl-to-bash pipeline whose clone/build children otherwise
 * outlive the first shell. */
export function stopInstall(): void {
  if (installProc) killCliTree(installProc);
}

// ── model attach ─────────────────────────────────────────────────────────

export function providerOption(providerId: string): ProviderOption | null {
  return workerProvider(providerId);
}

function providerEnvVars(option: ProviderOption): readonly string[] {
  return [option.envVar, ...option.alternateEnvVars];
}

function envValue(body: string, envVar: string): string | null {
  const match = new RegExp(`^${envVar}=([^\r\n]+)$`, "m").exec(body);
  return match?.[1]?.trim() || null;
}

function workerSecretStore(root?: string): SecretStore {
  return new SecretStore({ dir: hermesHome(root) });
}

function credentialName(option: ProviderOption): string {
  return `worker.${option.envVar}`;
}

/** Move credentials left by older builds out of profile dotenv. The
 * encrypted write lands and reads back before plaintext is scrubbed. */
function migrateProfileCredentials(root?: string): void {
  const profile = propertyProfileDir(root);
  const envPath = join(profile, ".env");
  if (!existsSync(envPath)) return;
  const original = readFileSync(envPath, "utf8");
  let migrated = false;
  const secrets = workerSecretStore(root);
  for (const option of PROVIDER_OPTIONS) {
    const candidate = providerEnvVars(option)
      .map((envVar) => envValue(original, envVar))
      .find((value): value is string => Boolean(value));
    if (!candidate) continue;
    if (!secrets.has(credentialName(option))) secrets.set(credentialName(option), candidate);
    if (secrets.get(credentialName(option)) !== candidate) throw new Error("worker credential migration verification failed");
    migrated = true;
  }
  if (!migrated) return;

  const names = new Set(PROVIDER_OPTIONS.flatMap((option) => providerEnvVars(option)));
  const clean = original
    .split(/\r?\n/)
    .filter((line) => {
      const key = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1];
      return !key || !names.has(key);
    })
    .filter((line, index, lines) => line || index < lines.length - 1)
    .join("\n")
    .replace(/\n*$/, "\n");
  writeFileAtomic(envPath, clean);
  try {
    chmodSync(envPath, 0o600);
  } catch {
    // Windows has no POSIX mode bits.
  }
  const checked = readFileSync(envPath, "utf8");
  if (PROVIDER_OPTIONS.some((option) => providerEnvVars(option).some((name) => envValue(checked, name)))) {
    throw new Error("worker credential plaintext cleanup failed");
  }
}

export interface AttachModelInput {
  providerId: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export interface ModelStatus {
  provider: string | null;
  model: string | null;
  keyPresent: boolean;
  /** masked credential hint, e.g. "sk-a…9f2" — never the key itself */
  keyHint: string | null;
}

/** Model ids for a provider, from the worker's own cache (same data the
 * interactive picker shows). Empty when the cache has nothing — the UI keeps
 * free-text entry as the fallback. */
export function listModels(providerId: string, root?: string): string[] {
  try {
    const cache = JSON.parse(readFileSync(join(hermesHome(root), "models_dev_cache.json"), "utf8")) as Record<
      string,
      { models?: Record<string, unknown> } | undefined
    >;
    const entry = cache[providerId]?.models;
    if (!entry || typeof entry !== "object") return [];
    return Object.keys(entry)
      .filter((id) => !/imagine|video|image/i.test(id))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export function modelStatus(root?: string): ModelStatus {
  const configPath = join(propertyProfileDir(root), "config.yaml");
  const mask = (value: string): string =>
    value.length <= 8 ? `${value.slice(0, 2)}…` : `${value.slice(0, 4)}…${value.slice(-4)}`;
  let provider: string | null = null;
  let model: string | null = null;
  try {
    const block = yamlBlock(readFileSync(configPath, "utf8"), "model");
    provider = block ? /^[ \t]+provider:\s*(\S+)/m.exec(block)?.[1] ?? null : null;
    model = block ? /^[ \t]+default:\s*(\S+)/m.exec(block)?.[1] ?? null : null;
  } catch { /* no config yet */ }
  let keyPresent = false;
  let keyHint: string | null = null;
  try {
    migrateProfileCredentials(root);
    const secrets = workerSecretStore(root);
    const candidates = provider ? [providerOption(provider)].filter(Boolean) as ProviderOption[] : [...PROVIDER_OPTIONS];
    for (const option of candidates) {
      const value = secrets.get(credentialName(option));
      if (value) {
        keyPresent = true;
        keyHint = `${option.envVar} ${mask(value)}`;
        break;
      }
    }
  } catch { /* ignore */ }
  return { provider, model, keyPresent, keyHint };
}

/** Decrypt only the selected provider credential immediately before a Bud
 * process starts. Callers first scrub ambient keys with applyWorkerRuntimeEnv. */
export function modelCredentialEnvironment(root?: string): Record<string, string> {
  migrateProfileCredentials(root);
  const configPath = join(propertyProfileDir(root), "config.yaml");
  let provider: string | null = null;
  try {
    const block = yamlBlock(readFileSync(configPath, "utf8"), "model");
    provider = block ? /^[ \t]+provider:\s*(\S+)/m.exec(block)?.[1] ?? null : null;
  } catch {
    return {};
  }
  const option = provider ? providerOption(provider) : null;
  if (!option) return {};
  const value = workerSecretStore(root).get(credentialName(option));
  return value ? { [option.envVar]: value } : {};
}

function applyModelAttachment(input: AttachModelInput, opts?: { root?: string }): ModelStatus {
  const option = providerOption(input.providerId);
  if (!option) throw Object.assign(new Error("unknown provider"), { status: 400 });
  const model = String(input.model ?? "").trim();
  if (!model) throw Object.assign(new Error("model id is required"), { status: 400 });
  if (!/^[A-Za-z0-9~][A-Za-z0-9._:/@+~-]{0,199}$/.test(model)) {
    throw Object.assign(new Error("model id contains unsupported characters"), { status: 400 });
  }
  const key = String(input.apiKey ?? "").trim();
  if (key.length > 8_192 || /[\r\n\0]/.test(key)) {
    throw Object.assign(new Error("api key is not valid"), { status: 400 });
  }
  const requestedBaseUrl = String(input.baseUrl ?? "").trim();
  if (requestedBaseUrl) {
    if (requestedBaseUrl.length > 2_048) {
      throw Object.assign(new Error("base URL is too long"), { status: 400 });
    }
    try {
      const parsed = new URL(requestedBaseUrl);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("unsafe");
    } catch {
      throw Object.assign(new Error("base URL must be an http(s) URL without embedded credentials"), { status: 400 });
    }
  }

  const profileDir = propertyProfileDir(opts?.root);
  if (!existsSync(join(profileDir, "SOUL.md"))) {
    throw Object.assign(new Error("the worker pack is not installed — apply the pack first"), { status: 409 });
  }

  // An empty key means "keep the current credential" for this provider.
  // Older dotenv credentials are migrated before this check.
  migrateProfileCredentials(opts?.root);
  const secrets = workerSecretStore(opts?.root);
  const existingCredential = secrets.get(credentialName(option));
  if (!key && !existingCredential) {
    throw Object.assign(new Error(`an api key is required for ${option.label}`), { status: 400 });
  }
  if (key) secrets.set(credentialName(option), key);

  const configPath = join(profileDir, "config.yaml");
  const existingConfig = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const block =
    `model:\n  default: ${model}\n  provider: ${option.id}\n  base_url: ${requestedBaseUrl ? JSON.stringify(requestedBaseUrl) : "''"}\n`;
  writeFileAtomic(configPath, withYamlBlock(existingConfig, "model", block));

  const status = modelStatus(opts?.root);
  return { ...status, keyPresent: true };
}

interface ModelAttachmentTransaction {
  version: 1;
  id: string;
  before: { config: string | null; secrets: string | null };
}

export interface StagedModelAttachment {
  transactionId: string;
  status: ModelStatus;
}

export interface ModelAttachmentRecovery {
  action: "none" | "restored-previous" | "attention";
  detail: string;
}

function modelTransactionPath(root?: string): string {
  return join(hermesHome(root), "model-transaction.json");
}

function modelConfigPath(root?: string): string {
  return join(propertyProfileDir(root), "config.yaml");
}

function decodeModelTransaction(raw: string): ModelAttachmentTransaction {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid model transaction");
  const tx = parsed as Partial<ModelAttachmentTransaction>;
  if (
    tx.version !== 1 ||
    typeof tx.id !== "string" ||
    !/^[A-Za-z0-9-]{1,80}$/.test(tx.id) ||
    !tx.before ||
    (tx.before.config !== null && typeof tx.before.config !== "string") ||
    (tx.before.secrets !== null && typeof tx.before.secrets !== "string")
  ) {
    throw new Error("invalid model transaction");
  }
  return tx as ModelAttachmentTransaction;
}

function readModelTransaction(root?: string): ModelAttachmentTransaction | null {
  try {
    return decodeModelTransaction(readFileSync(modelTransactionPath(root), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
    throw error;
  }
}

function removeModelTransaction(root?: string): void {
  const path = modelTransactionPath(root);
  try {
    unlinkSync(path);
    fsyncDir(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
  }
}

function restoreModelTransaction(tx: ModelAttachmentTransaction, root?: string): void {
  const configPath = modelConfigPath(root);
  if (tx.before.config === null) {
    try {
      unlinkSync(configPath);
      fsyncDir(dirname(configPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
    }
  } else {
    writeFileAtomic(configPath, tx.before.config);
  }
  workerSecretStore(root).restoreRaw(tx.before.secrets);
  removeModelTransaction(root);
}

/** Startup recovery always rolls back an untested candidate. A model is not
 * active until the API has observed a successful live ping and committed it. */
export function recoverPendingModelAttachment(root?: string): ModelAttachmentRecovery {
  if (!existsSync(modelTransactionPath(root))) {
    return { action: "none", detail: "No interrupted model change was found." };
  }
  try {
    const tx = readModelTransaction(root);
    if (!tx) return { action: "none", detail: "No interrupted model change was found." };
    restoreModelTransaction(tx, root);
    return {
      action: "restored-previous",
      detail: "RealBud restored the previous model because an interrupted candidate was never verified.",
    };
  } catch {
    return {
      action: "attention",
      detail: "An interrupted model change needs recovery. Bud will not start with an unverified candidate.",
    };
  }
}

export function beginModelAttachment(input: AttachModelInput, opts?: { root?: string }): StagedModelAttachment {
  const prior = recoverPendingModelAttachment(opts?.root);
  if (prior.action === "attention") {
    throw Object.assign(new Error(prior.detail), { status: 409, code: "model-recovery-required" });
  }
  // Complete one-time plaintext migration before taking the rollback
  // snapshot; otherwise rollback could remove the migrated credential.
  migrateProfileCredentials(opts?.root);
  const secrets = workerSecretStore(opts?.root);
  const tx: ModelAttachmentTransaction = {
    version: 1,
    id: randomUUID(),
    before: {
      config: existsSync(modelConfigPath(opts?.root)) ? readFileSync(modelConfigPath(opts?.root), "utf8") : null,
      secrets: secrets.snapshotRaw(),
    },
  };
  mkdirSync(hermesHome(opts?.root), { recursive: true });
  writeFileAtomic(modelTransactionPath(opts?.root), JSON.stringify(tx));
  try {
    return { transactionId: tx.id, status: applyModelAttachment(input, opts) };
  } catch (error) {
    restoreModelTransaction(tx, opts?.root);
    throw error;
  }
}

export function commitModelAttachment(transactionId: string, opts?: { root?: string }): void {
  const tx = readModelTransaction(opts?.root);
  if (!tx || tx.id !== transactionId) {
    throw Object.assign(new Error("model change receipt is stale"), { status: 409, code: "stale-model-change" });
  }
  removeModelTransaction(opts?.root);
}

export function rollbackModelAttachment(transactionId: string, opts?: { root?: string }): void {
  const tx = readModelTransaction(opts?.root);
  if (!tx || tx.id !== transactionId) {
    throw Object.assign(new Error("model change receipt is stale"), { status: 409, code: "stale-model-change" });
  }
  restoreModelTransaction(tx, opts?.root);
}

/** Synchronous internal/test convenience. Product setup uses begin + live
 * ping + commit so a failed candidate never becomes the selected model. */
export function attachModel(input: AttachModelInput, opts?: { root?: string }): ModelStatus {
  const staged = beginModelAttachment(input, opts);
  commitModelAttachment(staged.transactionId, opts);
  return staged.status;
}
