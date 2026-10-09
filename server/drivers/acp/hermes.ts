// Unmodified Hermes Agent as a verified ACP worker (`hermes -p property acp`).
// RealBud selects a reviewed release per process, never upstream main.
import { existsSync, lstatSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

import { hermesCli, hermesInstallCommand } from "../../hermes-pin.ts";
import { baseWorkerProfile, currentWorkerProfile } from "../../hermes-profile.ts";
import { BUD_WORK_FOLDER, seedVault, vaultDir } from "../../vault.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import { BUD_IDENTITY } from "../../../shared/bud-identity.ts";
import { isolateGithubLogin, stripServiceSecrets } from "../../service-child-env.ts";
import { hermesHome, runtimeCli } from "../../hermes-paths.ts";
import { releaseHome, runtimeCommit } from "../../hermes-runtime-selection.ts";
import { selectedWindowsRuntimeHome, windowsHermesRuntimeEnv } from "../../hermes-runtime-env.ts";
import { applyAskModelRelayEnv, ASK_MODEL_RELAY_OVERLAY_ENV, askModelRelayPort } from "../../ask-model-relay.ts";
import { DATA_DIR } from "../../config.ts";
import { assertWorkerIsolation, ensurePrivateRoot, NETWORK_ISOLATION_UNAVAILABLE, SANDBOX_TEST_WRITABLE, sandboxedLaunch, trustedPath, type SandboxDeps, type SandboxedLaunch } from "../../worker-network-sandbox.ts";
import { ownedRuntimeHome } from "../../hermes-document-deps.ts";

// Keep ACP's explicit per-session tools separate from configured discovery.
// The startup skip flag alone does not cover discovery restarted by an agent
// (0.21.5 starts it again before every agent build:
// hermes_cli/mcp_startup.py `ensure_mcp_discovery_before_agent_build`).
export const HERMES_CONFIGURED_MCP_FILTER = `realbud_explicit_${randomUUID().replaceAll("-", "")}`;

/** Model-provider credentials and endpoints, including the managed grant's
 * own name. Tool keys (search, browser) are left to their own rules. */
export const AMBIENT_MODEL_ENV = /^(?:REALBUD_MODEL_API_KEY|OPENAI_(?:API_KEY|BASE_URL|API_BASE)|(?:OPENROUTER|KIMI|MOONSHOT|MODELVIA|DEEPSEEK|ANTHROPIC|XAI|GROQ|MISTRAL|GEMINI|GOOGLE|OLLAMA|NOUS|HERMES)_API_KEY|ANTHROPIC_(?:AUTH_TOKEN|BASE_URL))$/i;

const HERMES_BROWSER_ENV = /^(?:AGENT_BROWSER_\w*|BROWSER_CDP_URL|CAMOFOX_URL|PLAYWRIGHT_BROWSERS_PATH)$/i;

export function hardenHermesChildEnv(env: Record<string, string | undefined>): void {
  // Upstream does not understand RealBud's data/profile variables. Resolve
  // the child environment here so ACP and one-shot work use the same home.
  env.HERMES_HOME = hermesHome(undefined, env);
  if (process.platform === "win32") {
    const runtime = selectedWindowsRuntimeHome(env.HERMES_HOME);
    if (runtime) {
      const prepared = windowsHermesRuntimeEnv(runtime, env);
      for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
      Object.assign(env, prepared);
    }
  } else {
    // Bud's terminal resolves `python3` from PATH. Put the selected runtime's
    // own venv first so scripts use its reviewed document libraries, not the
    // computer's system Python (Windows does this in windowsHermesRuntimeEnv).
    const runtime = ownedRuntimeHome(env.HERMES_HOME);
    const venvBin = runtime ? join(runtime, "hermes-agent", "venv", "bin") : null;
    if (venvBin && existsSync(venvBin)) env.PATH = [venvBin, env.PATH].filter(Boolean).join(":");
  }
  stripServiceSecrets(env);
  // The property profile owns its model and only RealBud's grant may carry
  // its key. Ambient provider keys can silently reroute a turn or stand in for
  // the grant (upstream's host-derived fallback reads `<VENDOR>_API_KEY`), so
  // none reaches the worker process; the grant is placed afterwards.
  for (const key of Object.keys(env)) if (AMBIENT_MODEL_ENV.test(key)) delete env[key];
  // An ambient managed-scope overlay would win over the profile at the leaf
  // (hermes_cli/managed_scope.py). Only RealBud's Ask relay sets one, per launch.
  for (const key of Object.keys(env)) if (key.toUpperCase() === "HERMES_MANAGED_DIR") delete env[key];
  // No ambient GitHub/Copilot login reaches upstream's credential pool.
  isolateGithubLogin(env);
  delete env.COMPOSIO_KEY;
  delete env.REALBUD_CUA_CONTROL_TOKEN;
  delete env.REALBUD_CUA_CONTROL_URL;
  delete env.REALBUD_DESK_KEY;
  // Ask and its subagents get no Hermes browser; RealBud's fenced browser is
  // the only one. Hermes' availability check (tools/browser_tool_install.py
  // `check_browser_requirements`, which also gates the credential vault) reads
  // these to attach to a running browser, choose Camofox or an engine, or find
  // a Chromium. The profile policy pins the matching config keys.
  for (const key of Object.keys(env)) if (HERMES_BROWSER_ENV.test(key)) delete env[key];
  // RealBud is the capability broker. Globally configured MCP servers must
  // not appear in Ask; only per-turn servers explicitly mounted by RealBud do.
  // Four independent layers: this startup skip, safe mode below (configured
  // servers read as none), the `--toolsets` server filter in spawnArgs, and
  // the profile's `platform_toolsets.acp: [..., no_mcp]` (0.21.5).
  env.HERMES_ACP_SKIP_CONFIGURED_MCP = "1";
  // Upstream safe mode suppresses configured MCP, plugins, shell hooks and
  // outbound webhooks. Native tools/skills/memory and explicit ACP MCP remain
  // available. Use its supported switch; never monkey-patch Hermes modules.
  env.HERMES_SAFE_MODE = "1";
  // Ask keeps execute_code (0.21.3's fixed hermes-acp bundle; 0.21.5's
  // platform_toolsets.acp, server/hermes-pack.ts WORKER_ACP_TOOLSETS), which
  // can otherwise spawn arbitrary local Python without asking ACP. Upstream ask-mode routes whole-script approval through ACP's
  // existing callback; a missing callback keeps the script blocked.
  env.HERMES_EXEC_ASK = "1";
  // No tirith scanner: with none on PATH, upstream downloads tirith's unpinned
  // "latest" GitHub release at run time (0.21.5 tools/tirith_security.py
  // `_install_tirith`), which no reviewed runtime pins. The macOS sandbox
  // refuses that download and Windows has no build, so command checks were
  // already Hermes' pattern guards plus RealBud's approvals; this stops the
  // attempt. The env switch outranks config and any ambient TIRITH_BIN.
  env.TIRITH_ENABLED = "0";
  // Hermes defaults small Codex requests to a 12-second SSE idle cutoff.
  // Allow a slower response within RealBud's existing overall run deadline;
  // retain an explicitly configured watchdog (including 0 to disable it).
  if (!env.HERMES_CODEX_EVENT_STALE_TIMEOUT_SECONDS?.trim()) {
    env.HERMES_CODEX_EVENT_STALE_TIMEOUT_SECONDS = "60";
  }
}

/** What a launch is for. `ask` is the ACP worker, `cli` a one-shot `chat`
 * job in the workroom, `diagnostic` a `--version` or install check that
 * writes nothing but its temp folder and reaches no network. */
export type HermesWorkerJob = "ask" | "cli" | "diagnostic";

/** Inside the worker's profile: the folders Hermes 0.21.3 writes during
 * ordinary ACP and CLI turns, found by running it under a deny-everything
 * write rule with denial logging. The policy files (`config.yaml`, `.env`,
 * `auth.json`, `SOUL.md`), the pack's skills, `bin`, `hooks` and `cron` stay
 * read-only. */
const PROFILE_STATE_DIRS = ["sessions", "logs", "cache", "runtime", "pending/memory", "pending/skills", "image_cache", "audio_cache"] as const;
/** Files at the profile root Hermes writes (with the temp names its atomic
 * writes use beside them): its SQLite state, locks and model caches. Not the
 * skills prompt snapshot (below) and not `memories/`. */
const PROFILE_STATE_FILES = ["state\\.db", "auth\\.lock", "update_check", "provider_models_cache", "context_length_cache", "models_dev_cache", "ollama_cloud_models_cache"] as const;

/** Hermes trusts this cache's skill entries once its mtime manifest matches
 * (agent/prompt_builder.py `_load_skills_snapshot`), so a worker-written one
 * could put text into every prompt. It stays read-only, and any copy a
 * worker left is removed before a launch so Hermes rebuilds from the
 * read-only skills folder. `memories/` is not writable either: memory
 * changes reach MEMORY.md/USER.md only through RealBud's review. */
const SKILLS_PROMPT_SNAPSHOT = ".skills_prompt_snapshot.json";

/** Release commits whose private-cache layout was reviewed: each keeps the
 * skills prompt cache at exactly `<profile>/.skills_prompt_snapshot.json`
 * (agent/prompt_builder.py `_skills_prompt_snapshot_path`, read in each tag's
 * tree on 2026-10-08) and no other instruction-bearing cache in the profile.
 * Upstream has no supported switch to turn that cache off, so RealBud removes
 * it before every launch. An owned release missing here has an unreviewed
 * layout: its launch is refused rather than cleaned blindly. Adding a release
 * to hermes-releases.ts fails hermes-env.test.ts until it is reviewed here. */
export const REVIEWED_PROFILE_CACHE_RELEASES: ReadonlySet<string> = new Set([
  "7339f5f160db5c96657a3bab60151227cc61f66c", // 0.20.3
  "29112bef099274229cadff79cdff7bf7b99c4b77", // 0.21.0
  "939e45c91d751fadd94dcd1b873ac3cb44846213", // 0.21.2
  "345cd2b057a452236de401d3534b8502a7465e8d", // 0.21.3
  "f97608f178d1ffeca59860195ab7da295f7c8e5f", // 0.21.5
]);
export const UNREVIEWED_WORKER_RELEASE = "This version of Bud's engine hasn't been reviewed for RealBud, so Bud was not started. Update RealBud, or contact RealBud support.";

/** False only for an owned release (`<home>/runtimes/<id>`) that is not the
 * release's own CLI or whose cache layout was not reviewed. A legacy owned
 * runtime or a development CLI records no release in its path and keeps the
 * reviewed snapshot removal. */
export function reviewedCacheLayout(home: string, command: string): boolean {
  const inside = relative(join(home, "runtimes"), command);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) return true;
  const id = inside.split(sep)[0]!;
  try { return command === runtimeCli(releaseHome(home, id)) && REVIEWED_PROFILE_CACHE_RELEASES.has(runtimeCommit(id)!); }
  catch { return false; }
}

/** The folders Hermes refuses to start without (hermes_cli/config.py
 * `_HERMES_HOME_SUBDIRS`). RealBud makes them before a launch so the worker
 * never needs to create `cron`, `hooks` or `skills`, which stay read-only. */
const PROFILE_SKELETON = ["cron", "sessions", "logs", "logs/curator", "memories", "pairing", "hooks", "image_cache", "audio_cache", "skills", "pending",
  // Hermes' terminal backend makes `bin` before every command (its scanner
  // lives there); made by RealBud, read-only and exec-allowed for the worker.
  "bin"] as const;

/** Make the skeleton in an existing profile folder: the profile's ancestry is
 * resolved first (a planted link refuses the launch), each folder is created
 * one level at a time and verified as a real owner-only folder of ours, and
 * any other outcome refuses the launch. An absent profile is left absent. */
export function ensureProfileSkeleton(profile: string): void {
  const trusted = trustedPath(profile);
  let stat;
  try { stat = lstatSync(trusted); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error(NETWORK_ISOLATION_UNAVAILABLE); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(NETWORK_ISOLATION_UNAVAILABLE);
  // The profile root itself: ours and owner-only, like every root under it.
  ensurePrivateRoot(trusted);
  for (const name of PROFILE_SKELETON) ensurePrivateRoot(join(trusted, name));
  // Only the plain file the reviewed releases write is removed; a link, folder
  // or anything else there is not that cache, so the launch is refused instead.
  const snapshot = join(trusted, SKILLS_PROMPT_SNAPSHOT);
  try { if (lstatSync(snapshot).isFile()) unlinkSync(snapshot); else throw new Error(NETWORK_ISOLATION_UNAVAILABLE); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(NETWORK_ISOLATION_UNAVAILABLE); }
}

/** The profile a launch names (`-p` / `--profile`), else the current one. */
function launchProfile(args: readonly string[]): string {
  const at = args.findIndex(arg => arg === "-p" || arg === "--profile");
  return at >= 0 && args[at + 1] ? args[at + 1]! : currentWorkerProfile().profile;
}

/**
 * The sandbox for one Hermes worker launch (server/worker-network-sandbox.ts).
 * Network: the loopback ports given plus, when `applyAskModelRelayEnv` put
 * the relay into this env, the relay's port from this process's own memory,
 * never from the overlay file. Writes: the workroom's `bud-work` folder and
 * the profile's own state (memory and skill staging, read back by RealBud
 * through no-follow descriptors only) for `ask`
 * and `cli`, nothing for `diagnostic`; every job also gets a
 * private temp folder. Reads: the person's credential stores and RealBud's
 * data folder are hidden, except the workroom, the Hermes home (runtime,
 * this profile, never another seat's), and the relay overlay. A development
 * CLI (`REALBUD_HERMES_CLI`, a test's `cli`) may write its own folder; the
 * owned runtime never is written.
 */
export function hermesWorkerSandbox(job: HermesWorkerJob, command: string, args: readonly string[], env: Record<string, string | undefined>, loopbackPorts: readonly number[], deps?: SandboxDeps): SandboxedLaunch {
  assertWorkerIsolation(deps?.platform ?? process.platform);
  const home = hermesHome(undefined, env);
  const profile = join(home, "profiles", launchProfile(args));
  if (job !== "diagnostic" && !reviewedCacheLayout(home, command)) throw new Error(UNREVIEWED_WORKER_RELEASE);
  // The workroom exists before any worker starts (seeding is idempotent).
  const workroom = job === "diagnostic" ? vaultDir() : seedVault();
  // Profile state is granted only when the profile exists as a real folder
  // of ours; its skeleton is then made and verified before any rule names it.
  let hasProfile = false;
  if (job !== "diagnostic") { ensureProfileSkeleton(profile); try { hasProfile = lstatSync(trustedPath(profile)).isDirectory(); } catch { /* absent */ } }
  // Of the workroom only Bud's own folder is writable; the book, decisions,
  // uploads, inputs and reference sheets stay read-only to the worker, so
  // nothing RealBud later reads there can be planted or replaced.
  const writable = job === "diagnostic" ? [] : [join(workroom, BUD_WORK_FOLDER), ...(hasProfile ? PROFILE_STATE_DIRS.map(name => join(profile, name)) : [])];
  const writablePatterns = job === "diagnostic" || !hasProfile ? [] : [`^${trustedPath(profile).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.?\\.?(${PROFILE_STATE_FILES.join("|")})[^/]*$`];
  // Hermes 0.21.5 refuses to open state.db (so session_search has no index)
  // unless `access(profile, W_OK)` passes (hermes_state_repair.py
  // `preflight_db_writability`). The profile folder's own node answers
  // writable; only the state files above can still be made in it.
  const writableFolderNodes = job === "diagnostic" || !hasProfile ? [] : [profile];
  // Test-only roots come from the explicit hook alone (server/testing/setup.ts
  // fills it); production never sets it and grants nothing beyond the above.
  if (job !== "diagnostic") writable.push(...SANDBOX_TEST_WRITABLE);
  const overlay = env[ASK_MODEL_RELAY_OVERLAY_ENV];
  const reads: Array<readonly ["allow" | "deny", string]> = [
    ["deny", DATA_DIR], ["allow", workroom], ["allow", home],
    ["deny", join(home, "profiles")], ["allow", profile],
    ["deny", join(home, "auth.json")], ["deny", join(home, ".env")],
    ...(overlay ? [["allow", overlay] as const] : []),
  ];
  const relay = overlay ? askModelRelayPort() : null;
  return sandboxedLaunch(command, args, env, {
    loopbackPorts: relay ? [...loopbackPorts, relay] : [...loopbackPorts],
    writable, writablePatterns, writableFolderNodes, executable: [join(profile, "bin")], reads,
  }, deps);
}

/** Ask's worker (and every command it runs) reaches only the broker gateway
 * and the model relay on loopback; see server/worker-network-sandbox.ts. */
export function hermesNetworkSandbox(command: string, args: string[], env: Record<string, string | undefined>, loopbackPorts: number[], job: "ask" | "diagnostic" = "ask", deps?: SandboxDeps): SandboxedLaunch {
  return hermesWorkerSandbox(job, command, args, env, loopbackPorts, deps);
}

const support: AcpSupport = {
  driverKind: "hermesAgent",
  displayName: "Hermes",
  models: {
    default: "default",
    options: [{ id: "default", label: "Hermes profile default" }],
  },
  defaultCli: "hermes",
  nativeSource: "hermes.acp",
  privateWorkspace: true,
  // Hermes owns the authoritative path check: edits inside the
  // private workroom (and temporary files) proceed without prompts, while
  // .env/.ssh/.git and paths outside the workroom still ask.
  defaultSessionMode: "accept_edits",
  // Product Ask already starts its complete turn policy with this identity.
  // Keep that policy byte for byte; only omit the redundant wrapper prefix.
  buildPromptText: turn => [turn.system?.startsWith(BUD_IDENTITY) ? undefined : BUD_IDENTITY, turn.system, turn.text].filter(Boolean).join("\n\n"),
  // Hermes ACP session ids live inside the current ACP process. Keep that
  // process warm; after a real restart, replay RealBud's durable transcript
  // instead of spending up to two minutes loading an impossible cursor.
  resumeAcrossProcesses: false,
  loginNote: "Bud is not ready. Open You → Bud to finish setup, or pair this computer from realbud.app.",

  install: {
    command: {
      darwin: hermesInstallCommand("darwin") ?? "",
      linux: hermesInstallCommand("linux") ?? "",
    },
    docsUrl: "https://hermes-agent.nousresearch.com/docs/",
    signInCommand: `hermes -p ${baseWorkerProfile()} model`,
  },

  spawnArgs(config, turn) {
    // A multi-seat office host installs `workerProfile` so this session gets the
    // seat's own profile; without it every seat would share one memory, skills
    // store and session database. The resolver is fixed at construction — this
    // path never accepts a caller-supplied profile name.
    const profile = support.workerProfile?.(config, turn) ?? currentWorkerProfile().profile;
    return [
      "-p",
      profile,
      "--toolsets", HERMES_CONFIGURED_MCP_FILTER,
      ...(turn.model && turn.model !== "default" ? ["-m", turn.model] : []),
      "acp",
    ];
  },

  // A leftover provider key can reroute Hermes; globally configured MCP
  // servers would bypass RealBud's explicit connection boundary.
  // Strip first, then point Ask at RealBud's loopback model relay, and only
  // while the profile still names the granted endpoint. The worker gets the
  // relay's execution-scoped token, never the office key; the relay holds the key
  // and applies the office's reasoning effort (server/ask-model-relay.ts).
  // A custom (development) CLI never refuses here; it simply gets no access.
  transformEnv: (env) => {
    hardenHermesChildEnv(env);
    applyAskModelRelayEnv(env, env.HERMES_HOME);
  },

  // macOS: sandbox-exec. Windows runs the ACP core's raw launch by owner
  // decision (worker-network-sandbox.ts file note). Any other platform goes
  // through the sandbox, which holds it. The host department loop has no child.
  networkSandbox: process.platform === "win32" ? undefined : hermesNetworkSandbox,

  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: (env) => {
    const home = env.HERMES_HOME || join(env.HOME || homedir(), ".hermes");
    return existsSync(join(home, "config.yaml")) || existsSync(join(home, ".env"));
  },
};

const base = createAcpDriver(support);
/** The RealBud-selected worker: a launch with no usable managed access is
 * refused with office copy before any process starts, so an unpaired or
 * tampered profile can never reach a model — including through an old
 * profile's own `.env` key. */
const managed = createAcpDriver({
  ...support,
  transformEnv: (env) => {
    hardenHermesChildEnv(env);
    const refusal = applyAskModelRelayEnv(env, env.HERMES_HOME);
    if (refusal) throw new Error(refusal);
  },
});

export const HermesAgentDriver = {
  ...base,
  create: (input: Parameters<typeof base.create>[0]) => {
    // Before ACP allocates any broker ports or builds a private child profile.
    assertWorkerIsolation();
    if (input.config.cli && input.config.cli !== "hermes" && input.config.cli !== hermesCli()) return base.create(input);
    // A first install can finish after the registry was created. Existing
    // workers keep their process selection throughout a staged update.
    return managed.create({ ...input, config: { ...input.config, get cli() { return hermesCli(); } } });
  },
  decodeConfig: (raw: unknown) => {
    const decoded = base.decodeConfig(raw);
    return { ...decoded, cli: !decoded.cli || decoded.cli === "hermes" ? hermesCli() : decoded.cli, workspace: decoded.workspace || seedVault() };
  },
  defaultConfig: () => ({ ...base.decodeConfig({}), cli: hermesCli(), workspace: seedVault() }),
};
