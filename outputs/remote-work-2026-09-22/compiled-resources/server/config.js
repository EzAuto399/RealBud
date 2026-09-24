// Config + data dirs. One file, ~/.realbud/config.json, env fallbacks:
//   { "xai": {"key":"xai-…"}, "composio": {"key":"ak_…"}, "box": {"token":"…"},
//     "instances": { "<instanceId>": {"driver":"grok", …} } }
import { readFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
// OMB_DATA_DIR / REALBUD_DATA_DIR isolate test/soak rigs from the real fleet.
export const DATA_DIR = process.env.REALBUD_DATA_DIR ?? process.env.OMB_DATA_DIR ?? join(homedir(), ".realbud");
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
            if (!existsSync(legacy))
                continue;
            try {
                renameSync(legacy, DATA_DIR);
                break;
            }
            catch {
                /* cross-device or busy — fall through to a fresh dir */
            }
        }
    }
    for (const dir of [DATA_DIR, EVENTS_DIR, NATIVE_DIR])
        mkdirSync(dir, { recursive: true });
}
export function loadConfig() {
    let cfg = {};
    try {
        cfg = JSON.parse(readFileSync(join(DATA_DIR, "config.json"), "utf8"));
    }
    catch {
        /* first run — env fallbacks below */
    }
    cfg.xai = { key: process.env.XAI_API_KEY, ...cfg.xai };
    cfg.composio = { key: process.env.COMPOSIO_KEY, ...cfg.composio };
    cfg.box = { token: process.env.BOX_TOKEN, ...cfg.box };
    cfg.tts = { key: process.env.OMB_TTS_KEY, ...cfg.tts };
    return cfg;
}
/** Merge a partial config into ~/.realbud/config.json (secrets never
 * echoed back — callers report configured-or-not booleans only). */
export function saveConfig(patch) {
    const p = join(DATA_DIR, "config.json");
    let disk = {};
    try {
        disk = JSON.parse(readFileSync(p, "utf8"));
    }
    catch {
        /* first write */
    }
    for (const key of ["xai", "composio", "box", "tts", "profile"]) {
        if (patch[key] && typeof patch[key] === "object") {
            disk[key] = { ...disk[key], ...patch[key] };
        }
    }
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileAtomic(p, JSON.stringify(disk, null, 2), 0o600);
}
// Default fleet: one instance per built-in driver (upstream
// defaultInstanceIdForDriver — instanceId defaults to the driver kind).
// Config-file keys are injected as per-instance environment so drivers
// see them without needing real process env vars.
export function instanceConfigs(cfg) {
    // Licensee fleet is the pinned Hermes worker only. Models attach on that
    // profile (`hermes -p property model`), not as extra RealBud agents.
    const map = cfg.instances && Object.keys(cfg.instances).length
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
