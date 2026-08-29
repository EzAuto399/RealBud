// Config + data dirs. Non-secret settings live in ~/.realbud/config.json.
// Credentials live in the encrypted secret store; packaged Electron supplies
// its wrapping key through the OS credential service.
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { WORKER_PROVIDERS } from "../shared/worker-providers.ts";
import { fsyncDir, writeFileAtomic } from "./atomic.ts";
import { PRODUCT_MODE } from "./product-mode.ts";
import { SecretStore } from "./secret-store.ts";
import {
  RecoveryRequiredError,
  deleteRecoverableFile,
  previousFile,
  readRecoverableFile,
  writeRecoverableFile,
} from "./recoverable-file.ts";
import type { InstanceConfigMap } from "./contracts.ts";
import type { WorkRoutingPreference } from "../shared/contracts.ts";

export interface AppConfig {
  xai?: { key?: string; url?: string };
  /** key = ck_… Connect consumer key (connections + agent tools);
   * apiKey = ak_… project API key — optional, unlocks the full toolkit
   * catalog with official logos in the plugins marketplace. */
  composio?: { key?: string; apiKey?: string; url?: string };
  box?: { token?: string };
  /** Voice (ElevenLabs). `key` is the credential and is never echoed back;
   * `voice` is the chosen voice id, which is a setting, not a secret. */
  tts?: { key?: string; voice?: string };
  /** PM-only mobile projection of Ask. Channel credentials are write-only
   * and encrypted; exact PM identities and listener settings are non-secret.
   * `key`/`enabled`/`allowedUserId` are the shipped Telegram v1 fields and
   * remain readable so upgrades preserve both credentials and replay state. */
  pocket?: {
    provider?: "telegram" | "whatsapp-cloud";
    key?: string;
    enabled?: boolean;
    allowedUserId?: string;
    telegramKey?: string;
    telegramEnabled?: boolean;
    telegramAllowedUserId?: string;
    whatsappCloudAccessToken?: string;
    whatsappCloudAppSecret?: string;
    whatsappCloudVerifyToken?: string;
    whatsappCloudEnabled?: boolean;
    whatsappCloudPhoneNumberId?: string;
    whatsappCloudAllowedUserId?: string;
    whatsappCloudWebhookPort?: number;
    whatsappCloudGraphVersion?: string;
  };
  /** The person using the app (collected in onboarding, shown in the
   * sidebar). Not a secret — echoed back by GET /api/config. */
  profile?: { name?: string; email?: string };
  /** A planning hint only. Capability admission, isolation, fallback and
   * approval remain code-owned regardless of this saved choice. */
  workRouting?: { preference?: WorkRoutingPreference; revision?: number };
  instances?: InstanceConfigMap;
}

// OMB_DATA_DIR / REALBUD_DATA_DIR isolate test/soak rigs from the real fleet.
export const DATA_DIR =
  process.env.REALBUD_DATA_DIR ?? process.env.OMB_DATA_DIR ?? join(homedir(), ".realbud");
/**
 * RealBud owns a dedicated worker home. Never fall back to the user's
 * personal ~/.hermes tree: an existing profile may have the same name and
 * applying the property pack would otherwise overwrite personal files.
 * An explicit process-level override exists only for bounded QA/development.
 */
export const WORKER_HOME = process.env.REALBUD_WORKER_HOME ?? join(DATA_DIR, "worker");
/** Private runtime root used as the worker process HOME. The upstream
 * installer may write launchers, caches and shell files beneath HOME, so it
 * must never receive the PM's real home directory. */
export function workerRuntimeDir(root = WORKER_HOME): string {
  return join(root, "runtime");
}

/** Absolute RealBud-owned launcher. Product code never resolves `hermes`
 * from PATH, which keeps an existing personal installation independent. */
export function workerCliForRuntime(runtime: string): string {
  return join(runtime, ".local", "bin", process.platform === "win32" ? "hermes.exe" : "hermes");
}

export function workerCli(root = WORKER_HOME): string {
  return workerCliForRuntime(workerRuntimeDir(root));
}

export function workerInstallDirForRuntime(runtime: string): string {
  return join(runtime, "hermes-agent");
}

export function workerInstallDir(root = WORKER_HOME): string {
  return workerInstallDirForRuntime(workerRuntimeDir(root));
}

export const WORKER_RUNTIME_DIR = workerRuntimeDir();
export const WORKER_CLI = workerCli();

/** Apply the process boundary shared by every Bud invocation. The selected
 * model key is decrypted only into that child process after this scrub;
 * ambient shell keys and personal config/cache locations never cross in. */
export function applyWorkerRuntimeEnv(
  env: Record<string, string | undefined>,
  root = WORKER_HOME,
  searchPath = env.PATH,
  runtime = workerRuntimeDir(root),
): Record<string, string | undefined> {
  env.HOME = runtime;
  env.HERMES_HOME = root;
  env.XDG_CACHE_HOME = join(runtime, ".cache");
  env.XDG_CONFIG_HOME = join(runtime, ".config");
  env.XDG_DATA_HOME = join(runtime, ".local", "share");
  env.XDG_STATE_HOME = join(runtime, ".local", "state");
  env.CARGO_HOME = join(runtime, ".cargo");
  env.NPM_CONFIG_CACHE = join(runtime, ".cache", "npm");
  env.NPM_CONFIG_PREFIX = join(runtime, ".local");
  env.PIP_CACHE_DIR = join(runtime, ".cache", "pip");
  env.PLAYWRIGHT_BROWSERS_PATH = join(runtime, ".cache", "playwright");
  env.UV_CACHE_DIR = join(runtime, ".cache", "uv");
  env.UV_PYTHON_BIN_DIR = join(runtime, "bin");
  env.UV_PYTHON_INSTALL_DIR = join(runtime, "python");
  env.UV_PYTHON_PREFERENCE = "only-managed";
  env.PATH = [
    dirname(workerCliForRuntime(runtime)),
    join(runtime, "bin"),
    join(runtime, "node", "bin"),
    join(runtime, ".cargo", "bin"),
    searchPath,
  ].filter(Boolean).join(delimiter);
  for (const provider of WORKER_PROVIDERS) {
    delete env[provider.envVar];
    for (const alias of provider.alternateEnvVars) delete env[alias];
  }
  // Bud gets only the selected provider credential added by the launch
  // adapter after this scrub. Personal shell, release, cloud and integration
  // credentials must not leak into a model or any tool it starts.
  const exactSecrets = new Set([
    "SSH_AUTH_SOCK",
    "GIT_ASKPASS",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "WIN_CSC_LINK",
    "WIN_CSC_KEY_PASSWORD",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "AZURE_CLIENT_SECRET",
  ]);
  for (const name of Object.keys(env)) {
    if (
      exactSecrets.has(name) ||
      /(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|COOKIES?)(?:$|_)/i.test(name)
    ) {
      delete env[name];
    }
  }
  // App wrapping keys belong only to the RealBud server. They must never be
  // inherited by the model worker or any tool it launches.
  delete env.REALBUD_DESK_KEY;
  delete env.REALBUD_SECRET_KEY;
  return env;
}

const LEGACY_DATA_DIRS = [join(homedir(), ".openmausbot"), join(homedir(), ".opengrokbot")];
export const EVENTS_DIR = join(DATA_DIR, "events");
export const NATIVE_DIR = join(DATA_DIR, "native");

export function ensureDirs() {
  // one-time migration from the pre-rename data dir — bots, transcripts,
  // config and keys all carry over
  if (!existsSync(DATA_DIR)) {
    for (const legacy of LEGACY_DATA_DIRS) {
      if (!existsSync(legacy)) continue;
      try {
        renameSync(legacy, DATA_DIR);
        break;
      } catch {
        /* cross-device or busy — fall through to a fresh dir */
      }
    }
  }
  for (const dir of [DATA_DIR, EVENTS_DIR, NATIVE_DIR]) mkdirSync(dir, { recursive: true });
}

/**
 * A packaged desktop launch unwraps its durable keys before it starts the
 * server. Starting the source server directly against that same directory
 * must fail before a development key can be generated and valid encrypted
 * state can be mistaken for corrupt data.
 */
export function assertSourceDataDirKeyBoundary(
  dir = DATA_DIR,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.REALBUD_PRODUCTION === "1") return;
  if (!existsSync(join(dir, "secure-keys.json"))) return;
  throw Object.assign(
    new Error(
      "This RealBud data directory uses OS-protected keys. Start the desktop app, or set REALBUD_DATA_DIR to an isolated development directory.",
    ),
    { code: "desktop-key-boundary" },
  );
}

export interface ConfigIoOptions {
  dir?: string;
  secretKey?: Buffer;
  production?: boolean;
  /** Fault injection used only by restart/recovery tests. */
  fault?: (point: "after-journal" | "after-secrets" | "after-config") => void;
}

export interface ConfigRecoveryStatus {
  active: boolean;
  action: "none" | "restored-previous" | "attention";
  detail: string;
}

let defaultConfigRecovery: ConfigRecoveryStatus = {
  active: false,
  action: "none",
  detail: "Configuration and encrypted credentials are protected.",
};

export function configRecoveryStatus(): ConfigRecoveryStatus {
  return { ...defaultConfigRecovery };
}

const CONFIG_SECRET_FIELDS = [
  { section: "xai", field: "key", name: "config.xai.key", env: "XAI_API_KEY" },
  { section: "composio", field: "key", name: "config.composio.key", env: "COMPOSIO_KEY" },
  { section: "composio", field: "apiKey", name: "config.composio.apiKey", env: null },
  { section: "box", field: "token", name: "config.box.token", env: "BOX_TOKEN" },
  { section: "tts", field: "key", name: "config.tts.key", env: "OMB_TTS_KEY" },
  { section: "pocket", field: "key", name: "config.pocket.key", env: null },
  { section: "pocket", field: "telegramKey", name: "config.pocket.telegramKey", env: null },
  { section: "pocket", field: "whatsappCloudAccessToken", name: "config.pocket.whatsappCloudAccessToken", env: null },
  { section: "pocket", field: "whatsappCloudAppSecret", name: "config.pocket.whatsappCloudAppSecret", env: null },
  { section: "pocket", field: "whatsappCloudVerifyToken", name: "config.pocket.whatsappCloudVerifyToken", env: null },
] as const;

function configPath(dir: string): string {
  return join(dir, "config.json");
}

function configTransactionPath(dir: string): string {
  return join(dir, "config-transaction.json");
}

function decodeConfig(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("configuration is invalid");
  return parsed as Record<string, unknown>;
}

interface ConfigTransaction {
  version: 1;
  before: { config: string | null; secrets: string | null };
  after: { configSha256: string; secretsSha256: string | null };
}

function sha256(raw: string | null): string | null {
  return raw === null ? null : createHash("sha256").update(raw).digest("hex");
}

function exactRaw(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
    throw error;
  }
}

function decodeConfigTransaction(raw: string): ConfigTransaction {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid config transaction");
  const tx = parsed as Partial<ConfigTransaction>;
  if (
    tx.version !== 1 ||
    !tx.before ||
    !tx.after ||
    (tx.before.config !== null && typeof tx.before.config !== "string") ||
    (tx.before.secrets !== null && typeof tx.before.secrets !== "string") ||
    typeof tx.after.configSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(tx.after.configSha256) ||
    !(tx.after.secretsSha256 === null || (typeof tx.after.secretsSha256 === "string" && /^[0-9a-f]{64}$/.test(tx.after.secretsSha256)))
  ) {
    throw new Error("invalid config transaction");
  }
  if (tx.before.config !== null) decodeConfig(tx.before.config);
  return tx as ConfigTransaction;
}

function updateDefaultConfigRecovery(opts: ConfigIoOptions | undefined, status: ConfigRecoveryStatus): void {
  if ((opts?.dir ?? DATA_DIR) === DATA_DIR) defaultConfigRecovery = status;
}

function removeConfigTransaction(path: string): void {
  try {
    unlinkSync(path);
    fsyncDir(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
  }
}

/** Resolve a crash between the encrypted and public halves. If both intended
 * generations landed, finish the commit; otherwise restore the exact prior
 * pair. The journal contains ciphertext only for credentials. */
function recoverConfigTransaction(opts?: ConfigIoOptions): boolean {
  const dir = opts?.dir ?? DATA_DIR;
  const transactionPath = configTransactionPath(dir);
  if (!existsSync(transactionPath)) return false;
  const tx = decodeConfigTransaction(readFileSync(transactionPath, "utf8"));
  const configCurrent = exactRaw(configPath(dir));
  const secrets = configSecretStore(opts);
  const secretsCurrent = secrets.snapshotRaw();
  const committed = sha256(configCurrent) === tx.after.configSha256 && sha256(secretsCurrent) === tx.after.secretsSha256;
  if (!committed) {
    if (tx.before.config === null) deleteRecoverableFile(configPath(dir));
    else writeFileAtomic(configPath(dir), tx.before.config);
    secrets.restoreRaw(tx.before.secrets);
  }
  removeConfigTransaction(transactionPath);
  return true;
}

function readConfigDisk(opts?: ConfigIoOptions): {
  disk: Record<string, unknown>;
  raw: string | null;
  blocked: boolean;
} {
  const dir = opts?.dir ?? DATA_DIR;
  try {
    recoverConfigTransaction(opts);
  } catch {
    updateDefaultConfigRecovery(opts, {
      active: true,
      action: "attention",
      detail: "Configuration recovery could not be completed. Connections and setup changes are paused.",
    });
    return { disk: {}, raw: null, blocked: true };
  }
  const loaded = readRecoverableFile(configPath(dir), decodeConfig);
  if (loaded.state === "blocked") {
    updateDefaultConfigRecovery(opts, {
      active: true,
      action: "attention",
      detail: "Configuration could not be verified. RealBud preserved it and paused setup changes.",
    });
    return { disk: {}, raw: null, blocked: true };
  }
  if (loaded.state === "restored") {
    updateDefaultConfigRecovery(opts, {
      active: false,
      action: "restored-previous",
      detail: "RealBud restored the last verified configuration. Review connections before relying on them.",
    });
  } else {
    updateDefaultConfigRecovery(opts, {
      active: false,
      action: "none",
      detail: "Configuration and encrypted credentials are protected.",
    });
  }
  return {
    disk: loaded.value ?? {},
    raw: loaded.state === "missing" ? null : readFileSync(configPath(dir), "utf8"),
    blocked: false,
  };
}

function configSecretStore(opts?: ConfigIoOptions): SecretStore {
  return new SecretStore({
    dir: opts?.dir ?? DATA_DIR,
    key: opts?.secretKey,
    production: opts?.production,
  });
}

export function appSecretStore(opts?: ConfigIoOptions): SecretStore {
  return configSecretStore(opts);
}

function commitConfigPair(
  disk: Record<string, unknown>,
  beforeConfigRaw: string | null,
  secretChanges: Record<string, string | null>,
  opts?: ConfigIoOptions,
): void {
  const dir = opts?.dir ?? DATA_DIR;
  const secrets = configSecretStore(opts);
  const prepared = secrets.prepareUpdate(secretChanges);
  const afterConfigRaw = JSON.stringify(disk, null, 2);
  const afterSecretsRaw = prepared.changed ? prepared.afterRaw : prepared.beforeRaw;
  const tx: ConfigTransaction = {
    version: 1,
    before: { config: beforeConfigRaw, secrets: prepared.beforeRaw },
    after: { configSha256: sha256(afterConfigRaw)!, secretsSha256: sha256(afterSecretsRaw) },
  };
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(configTransactionPath(dir), JSON.stringify(tx));
  opts?.fault?.("after-journal");
  secrets.commitPrepared(prepared);
  opts?.fault?.("after-secrets");
  writeRecoverableFile(configPath(dir), afterConfigRaw, decodeConfig);
  opts?.fault?.("after-config");
  removeConfigTransaction(configTransactionPath(dir));
}

/** Legacy releases could persist connector credentials in config.json. That
 * file is already plaintext when migration begins, so it must never be copied
 * into the normal transaction journal or retained as a recoverable previous
 * generation. Encrypt and verify the credentials first, then replace both
 * public generations with the scrubbed document. A crash before the final
 * replace leaves only the pre-existing plaintext current file and the next
 * startup safely repeats this idempotent migration. */
function migrateLegacyConfigSecrets(
  disk: Record<string, unknown>,
  secretChanges: Record<string, string | null>,
  opts?: ConfigIoOptions,
): void {
  const dir = opts?.dir ?? DATA_DIR;
  const secrets = configSecretStore(opts);
  const prepared = secrets.prepareUpdate(secretChanges);
  secrets.commitPrepared(prepared);
  for (const [name, expected] of Object.entries(secretChanges)) {
    if (expected !== null && secrets.get(name) !== expected) {
      throw new Error("encrypted settings migration could not be verified");
    }
  }
  opts?.fault?.("after-secrets");

  const scrubbed = JSON.stringify(disk, null, 2);
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(previousFile(configPath(dir)), scrubbed);
  writeFileAtomic(configPath(dir), scrubbed);
  opts?.fault?.("after-config");
}

function takeLegacyConfigSecrets(disk: Record<string, unknown>): Record<string, string | null> {
  const changes: Record<string, string | null> = {};
  for (const descriptor of CONFIG_SECRET_FIELDS) {
    const section = disk[descriptor.section];
    if (!section || typeof section !== "object" || Array.isArray(section)) continue;
    const fields = section as Record<string, unknown>;
    const plaintext = fields[descriptor.field];
    if (typeof plaintext !== "string" || !plaintext.trim()) continue;
    changes[descriptor.name] = plaintext.trim();
    delete fields[descriptor.field];
  }
  return changes;
}

export function loadConfig(opts?: ConfigIoOptions): AppConfig {
  const loaded = readConfigDisk(opts);
  if (loaded.blocked) return {};
  const disk = loaded.disk;

  const migrationChanges = takeLegacyConfigSecrets(disk);
  if (Object.keys(migrationChanges).length > 0) {
    migrateLegacyConfigSecrets(disk, migrationChanges, opts);
  }

  const secrets = configSecretStore(opts);
  const cfg = disk as AppConfig;
  try {
    for (const descriptor of CONFIG_SECRET_FIELDS) {
      const section = (cfg[descriptor.section] ?? {}) as Record<string, unknown>;
      const stored = secrets.get(descriptor.name);
      const fallback = descriptor.env ? process.env[descriptor.env] : undefined;
      const credential = stored ?? fallback;
      if (credential) section[descriptor.field] = credential;
      cfg[descriptor.section] = section as never;
    }
  } catch (error) {
    if (!(error instanceof RecoveryRequiredError)) throw error;
    updateDefaultConfigRecovery(opts, {
      active: true,
      action: "attention",
      detail: "Encrypted credentials could not be verified. Connections and model setup are paused.",
    });
    for (const descriptor of CONFIG_SECRET_FIELDS) {
      const section = cfg[descriptor.section] as Record<string, unknown> | undefined;
      if (section) delete section[descriptor.field];
    }
  }
  return cfg;
}

/** Merge a partial config. Credentials are encrypted separately and never
 * enter config.json or API responses. */
export function saveConfig(patch: Partial<AppConfig>, opts?: ConfigIoOptions): void {
  const loaded = readConfigDisk(opts);
  if (loaded.blocked) throw new RecoveryRequiredError("Configuration needs recovery before settings can change.");
  const disk = loaded.disk;
  let beforeConfigRaw = loaded.raw;
  const migrationChanges = takeLegacyConfigSecrets(disk);
  if (Object.keys(migrationChanges).length > 0) {
    migrateLegacyConfigSecrets(disk, migrationChanges, opts);
    beforeConfigRaw = exactRaw(configPath(opts?.dir ?? DATA_DIR));
  }
  const secretChanges: Record<string, string | null> = {};
  for (const descriptor of CONFIG_SECRET_FIELDS) {
    const section = patch[descriptor.section] as Record<string, unknown> | undefined;
    if (!section || !Object.hasOwn(section, descriptor.field)) continue;
    const value = section[descriptor.field];
    if (typeof value !== "string") throw new Error(`${descriptor.section}.${descriptor.field} must be a string`);
    secretChanges[descriptor.name] = value.trim() || null;
  }

  for (const key of ["xai", "composio", "box", "tts", "pocket", "profile", "workRouting"] as const) {
    if (patch[key] && typeof patch[key] === "object") {
      const next = { ...(disk[key] as object), ...patch[key] } as Record<string, unknown>;
      for (const descriptor of CONFIG_SECRET_FIELDS) {
        if (descriptor.section === key) delete next[descriptor.field];
      }
      disk[key] = next;
    }
  }
  commitConfigPair(disk, beforeConfigRaw, secretChanges, opts);
}

// Default fleet: one instance per built-in driver (upstream
// defaultInstanceIdForDriver — instanceId defaults to the driver kind).
// Config-file keys are injected as per-instance environment so drivers
// see them without needing real process env vars.
export function instanceConfigs(cfg: AppConfig): InstanceConfigMap {
  // Licensee fleet is the pinned Hermes worker only. Models attach on that
  // profile (`hermes -p property model`), not as extra RealBud agents.
  const map: InstanceConfigMap = PRODUCT_MODE
    ? {
        // Preserve benign display/config metadata from the one expected
        // instance, but never a persisted driver kind or extra instance id.
        hermes: {
          ...(cfg.instances?.hermes ?? {}),
          driver: "hermesAgent",
        },
      }
    : cfg.instances && Object.keys(cfg.instances).length
      ? cfg.instances
      : {
          hermes: { driver: "hermesAgent" },
        };
  for (const entry of Object.values(map)) {
    entry.environment = {
      ...(!PRODUCT_MODE && cfg.xai?.key ? { XAI_API_KEY: cfg.xai.key } : {}),
      ...(!PRODUCT_MODE && cfg.box?.token ? { BOX_TOKEN: cfg.box.token } : {}),
      ...entry.environment,
      // Authoritative isolation boundary. A persisted instance config may
      // not redirect Bud into somebody's personal worker home.
      HERMES_HOME: WORKER_HOME,
    };
    if (entry.driver === "hermesAgent") {
      const configured = entry.config && typeof entry.config === "object"
        ? entry.config as Record<string, unknown>
        : {};
      entry.config = {
        ...configured,
        // Neither persisted config nor PATH can redirect Bud to a personal
        // executable or enable the ACP driver's bypass-permissions mode.
        cli: WORKER_CLI,
        fullAuto: false,
      };
      entry.environment.HOME = WORKER_RUNTIME_DIR;
    }
  }
  return map;
}
