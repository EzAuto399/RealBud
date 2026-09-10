// Hermes Agent as a pinned ACP worker (`hermes -p property acp`).
// Not the product name. Version is HERMES_PIN — we do not follow upstream main.
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { HERMES_PIN, hermesCli, hermesInstallCommand } from "../../hermes-pin.ts";
import { seedVault } from "../../vault.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import { BUD_IDENTITY } from "../../../shared/bud-identity.ts";

// Hermes 0.21 can restart configured MCP discovery while building an ACP
// session, after its startup skip flag has already been checked. Its CLI
// discovery filter applies to every restart. A per-host random name selects
// no configured servers; ACP's explicit per-session registration is separate.
export const HERMES_CONFIGURED_MCP_FILTER = `realbud_explicit_${randomUUID().replaceAll("-", "")}`;

export function hardenHermesChildEnv(env: Record<string, string | undefined>): void {
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
  defaultCli: hermesCli(),
  nativeSource: "hermes.acp",
  privateWorkspace: true,
  // Hermes 0.20.3 owns the authoritative path check: edits inside the
  // private workroom (and temporary files) proceed without prompts, while
  // .env/.ssh/.git and paths outside the workroom still ask.
  defaultSessionMode: "accept_edits",
  buildPromptText: turn => [BUD_IDENTITY, turn.system, turn.text].filter(Boolean).join("\n\n"),
  // Hermes ACP session ids live inside the current ACP process. Keep that
  // process warm; after a real restart, replay RealBud's durable transcript
  // instead of spending up to two minutes loading an impossible cursor.
  resumeAcrossProcesses: false,
  loginNote: `Hermes is not ready — install the pinned ${HERMES_PIN.product} worker, then run hermes -p ${HERMES_PIN.profile} model`,

  install: {
    command: {
      darwin: hermesInstallCommand("darwin") ?? "",
      linux: hermesInstallCommand("linux") ?? "",
    },
    docsUrl: "https://hermes-agent.nousresearch.com/docs/",
    signInCommand: `hermes -p ${HERMES_PIN.profile} model`,
  },

  spawnArgs: (_config, turn) => [
    "-p",
    HERMES_PIN.profile,
    "--toolsets", HERMES_CONFIGURED_MCP_FILTER,
    ...(turn.model && turn.model !== "default" ? ["-m", turn.model] : []),
    "acp",
  ],

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
  decodeConfig: (raw: unknown) => {
    const decoded = base.decodeConfig(raw);
    return { ...decoded, workspace: decoded.workspace || seedVault() };
  },
  defaultConfig: () => ({ ...base.decodeConfig({}), workspace: seedVault() }),
};
