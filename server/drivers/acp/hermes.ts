// Hermes Agent as a pinned ACP worker (`hermes -p property acp`).
// Not the product name. Version is HERMES_PIN — we do not follow upstream main.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { HERMES_PIN, hermesInstallCommand } from "../../hermes-pin.ts";
import { seedVault } from "../../vault.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

export function hardenHermesChildEnv(env: Record<string, string | undefined>): void {
  // The property profile owns its model. Ambient provider keys can silently
  // reroute a turn, so they never reach the worker process.
  delete env.OPENAI_API_KEY;
  delete env.OPENROUTER_API_KEY;
  delete env.KIMI_API_KEY;
  delete env.MOONSHOT_API_KEY;
  // RealBud is the capability broker. Globally configured MCP servers must
  // not appear in Ask; only per-turn servers explicitly mounted by RealBud do.
  env.HERMES_ACP_SKIP_CONFIGURED_MCP = "1";
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
