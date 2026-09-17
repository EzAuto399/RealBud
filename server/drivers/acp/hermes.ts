// Unmodified Hermes Agent as a verified ACP worker (`hermes -p property acp`).
// RealBud selects a reviewed release per process, never upstream main.
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { hermesCli, hermesInstallCommand } from "../../hermes-pin.ts";
import { baseWorkerProfile, hermesProfileFor } from "../../hermes-profile.ts";
import { seedVault } from "../../vault.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import { BUD_IDENTITY } from "../../../shared/bud-identity.ts";
import { stripServiceSecrets } from "../../service-child-env.ts";
import { hermesHome } from "../../hermes-paths.ts";

// Keep ACP's explicit per-session tools separate from configured discovery.
// The startup skip flag alone does not cover discovery restarted by an agent.
export const HERMES_CONFIGURED_MCP_FILTER = `realbud_explicit_${randomUUID().replaceAll("-", "")}`;

export function hardenHermesChildEnv(env: Record<string, string | undefined>): void {
  // Upstream does not understand RealBud's data/profile variables. Resolve
  // the child environment here so ACP and one-shot work use the same home.
  env.HERMES_HOME = hermesHome(undefined, env);
  stripServiceSecrets(env);
  // The property profile owns its model. Ambient provider keys can silently
  // reroute a turn, so they never reach the worker process.
  delete env.OPENAI_API_KEY;
  delete env.OPENROUTER_API_KEY;
  delete env.KIMI_API_KEY;
  delete env.MOONSHOT_API_KEY;
  delete env.COMPOSIO_KEY;
  delete env.REALBUD_CUA_CONTROL_TOKEN;
  delete env.REALBUD_CUA_CONTROL_URL;
  delete env.REALBUD_DESK_KEY;
  // RealBud is the capability broker. Globally configured MCP servers must
  // not appear in Ask; only per-turn servers explicitly mounted by RealBud do.
  env.HERMES_ACP_SKIP_CONFIGURED_MCP = "1";
  // Upstream safe mode suppresses configured MCP, plugins, shell hooks and
  // outbound webhooks. Native tools/skills/memory and explicit ACP MCP remain
  // available. Use its supported switch; never monkey-patch Hermes modules.
  env.HERMES_SAFE_MODE = "1";
  // ACP mounts Hermes' native bundle independently of the profile toolsets.
  // Its execute_code tool can otherwise spawn arbitrary local Python without
  // asking ACP. Upstream ask-mode routes whole-script approval through ACP's
  // existing callback; a missing callback keeps the script blocked.
  env.HERMES_EXEC_ASK = "1";
  // Hermes defaults small Codex requests to a 12-second SSE idle cutoff.
  // Allow a slower response within RealBud's existing overall run deadline;
  // retain an explicitly configured watchdog (including 0 to disable it).
  if (!env.HERMES_CODEX_EVENT_STALE_TIMEOUT_SECONDS?.trim()) {
    env.HERMES_CODEX_EVENT_STALE_TIMEOUT_SECONDS = "60";
  }
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
  buildPromptText: turn => [BUD_IDENTITY, turn.system, turn.text].filter(Boolean).join("\n\n"),
  // Hermes ACP session ids live inside the current ACP process. Keep that
  // process warm; after a real restart, replay RealBud's durable transcript
  // instead of spending up to two minutes loading an impossible cursor.
  resumeAcrossProcesses: false,
  loginNote: "Bud is not ready. Open You → Bud to install the agent or connect your model.",

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
    const profile = support.workerProfile?.(config, turn) ?? hermesProfileFor(baseWorkerProfile()).profile;
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
  transformEnv: hardenHermesChildEnv,

  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: (env) => {
    const home = env.HERMES_HOME || join(env.HOME || homedir(), ".hermes");
    return existsSync(join(home, "config.yaml")) || existsSync(join(home, ".env"));
  },
};

const base = createAcpDriver(support);

export const HermesAgentDriver = {
  ...base,
  create: (input: Parameters<typeof base.create>[0]) => {
    if (input.config.cli && input.config.cli !== "hermes" && input.config.cli !== hermesCli()) return base.create(input);
    // A first install can finish after the registry was created. Existing
    // workers keep their process selection throughout a staged update.
    return base.create({ ...input, config: { ...input.config, get cli() { return hermesCli(); } } });
  },
  decodeConfig: (raw: unknown) => {
    const decoded = base.decodeConfig(raw);
    return { ...decoded, cli: !decoded.cli || decoded.cli === "hermes" ? hermesCli() : decoded.cli, workspace: decoded.workspace || seedVault() };
  },
  defaultConfig: () => ({ ...base.decodeConfig({}), cli: hermesCli(), workspace: seedVault() }),
};
