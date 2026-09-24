// Config + data dirs. One file, ~/.realbud/config.json, env fallbacks:
//   { "xai": {"key":"xai-…"}, "composio": {"key":"ak_…"}, "box": {"token":"…"},
//     "instances": { "<instanceId>": {"driver":"grok", …} } }
import { readFileSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { mkdirNewSync, mkdirPrivateSync, restrictNewSync, writeFileAtomic } from "./atomic.ts";
import type { InstanceConfigMap } from "./contracts.ts";

export interface AppConfig {
  xai?: { key?: string; url?: string };
  /** key = ak_… Platform project API key (Connected apps + session MCP);
   * apiKey = optional alias used by Gmail read-only setup / catalog;
   * userId = Platform user id for this office Mac (optional). */
  composio?: { key?: string; apiKey?: string; url?: string; userId?: string;
    /** Protected gateway access only; never an upstream Composio project key. */
    managed?: { endpoint: string; credential: string; profile: string };
    mode?: "consumer" | "gmail-readonly";
    officeApps?: string[];
    excludedApps?: string[];
    selectedAccounts?: Record<string, string>;
    /** Provider account ownership is created by RealBud, never supplied by Bud. */
    gmailReadOnly?: { authConfigId: string; userId: string; accountId?: string;
      pendingLink?: { url: string; expiresAt: string };
      /** Durable intent: never repeat link creation after an uncertain response. */
      linkUnknown?: { startedAt: string; previousAccountId?: string } };
  };
  box?: { token?: string };
  /** Voice (ElevenLabs). `key` is the credential and is never echoed back;
   * `voice` is the chosen voice id, which is a setting, not a secret. */
  tts?: { key?: string; voice?: string };
  /** The person using the app (collected in onboarding, shown in the
   * sidebar). Not a secret — echoed back by GET /api/config. */
  profile?: { name?: string; email?: string };
  instances?: InstanceConfigMap;
}

// OMB_DATA_DIR / REALBUD_DATA_DIR isolate test/soak rigs from the real fleet.
export const DATA_DIR =
  process.env.REALBUD_DATA_DIR ?? process.env.OMB_DATA_DIR ?? join(homedir(), ".realbud");

/**
 * Which seat this process is. Empty means single-seat, which is every install
 * today and keeps the shared base worker profile.
 *
 * REALBUD_DATA_DIR isolates one *office* from another; this isolates one *seat*
 * inside an office. A seat runs as its own process with its own data dir, so the
 * identity is a launch-time fact rather than something a request can assert.
 *
 * The value must be the seat's stable member id from the office host
 * (`realbud_company.members.id`, a uuid). That id is immutable and offboarding
 * sets `active = false` rather than reusing it — a natural key such as an email
 * or login name would be reassigned to a colleague and silently hand them the
 * previous holder's worker memory, skills and session history.
 */
export const MEMBER_KEY = (process.env.REALBUD_MEMBER ?? "").trim();

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
  // New folders must also satisfy the private JSON stores on POSIX. They get
  // their own protected Windows descriptor in one process; existing (or
  // migrated) folders are left to verify-only paths.
  const created = [DATA_DIR, EVENTS_DIR, NATIVE_DIR].flatMap((dir) => mkdirNewSync(dir, 0o700));
  restrictNewSync(created.map((path) => ({ path, kind: "directory" as const })));
}

export class ConfigRecoveryError extends Error {
  readonly status = 503;
  readonly code = "config_recovery_required";
  constructor() {
    super("Saved settings need recovery. The original file has been kept; restore or repair it before saving changes.");
    this.name = "ConfigRecoveryError";
  }
}

const configRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Only absence is a fresh installation. A failed read must never authorize
 * replacing saved credentials or settings with environment fallbacks. */
function readSavedConfig(): AppConfig & Record<string, unknown> {
  let raw: string;
  try { raw = readFileSync(join(DATA_DIR, "config.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new ConfigRecoveryError();
  }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new ConfigRecoveryError(); }
  if (!configRecord(value)) throw new ConfigRecoveryError();
  for (const key of ["xai", "composio", "box", "tts", "profile", "instances"]) {
    if (Object.hasOwn(value, key) && !configRecord(value[key])) throw new ConfigRecoveryError();
  }
  return value as AppConfig & Record<string, unknown>;
}

export function loadConfig(): AppConfig {
  const cfg = readSavedConfig();
  cfg.xai = { key: process.env.XAI_API_KEY, ...cfg.xai };
  cfg.composio = { key: process.env.COMPOSIO_KEY, ...cfg.composio };
  cfg.box = { token: process.env.BOX_TOKEN, ...cfg.box };
  cfg.tts = { key: process.env.OMB_TTS_KEY, ...cfg.tts };
  return cfg;
}

/** Merge a partial config into ~/.realbud/config.json (secrets never
 * echoed back — callers report configured-or-not booleans only). */
export function saveConfig(patch: Partial<AppConfig>): void {
  const p = join(DATA_DIR, "config.json");
  const disk = readSavedConfig();
  for (const key of ["xai", "composio", "box", "tts", "profile"] as const) {
    if (patch[key] && typeof patch[key] === "object") {
      disk[key] = { ...(disk[key] as object), ...patch[key] };
    }
  }
  mkdirPrivateSync(DATA_DIR);
  writeFileAtomic(p, JSON.stringify(disk, null, 2), 0o600);
}

// Default fleet: one instance per built-in driver (upstream
// defaultInstanceIdForDriver — instanceId defaults to the driver kind).
// Config-file keys are injected as per-instance environment so drivers
// see them without needing real process env vars.
export function instanceConfigs(cfg: AppConfig): InstanceConfigMap {
  // Licensee fleet is the pinned Hermes worker only. Models attach on that
  // profile (`hermes -p property model`), not as extra RealBud agents.
  const map: InstanceConfigMap =
    cfg.instances && Object.keys(cfg.instances).length
      ? cfg.instances
      : {
          hermes: { driver: "hermesAgent" },
        };
  for (const entry of Object.values(map)) {
    entry.environment = {
      ...(cfg.xai?.key ? { XAI_API_KEY: cfg.xai.key } : {}),
      ...(cfg.box?.token ? { BOX_TOKEN: cfg.box.token } : {}),
      ...entry.environment,
    };
  }
  return map;
}
