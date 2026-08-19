// Hermes Agent as a pinned ACP worker (`hermes -p property acp`).
// Not the product name. Version is HERMES_PIN — we do not follow upstream main.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { HERMES_PIN, hermesInstallCommand } from "../../hermes-pin.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

const support: AcpSupport = {
  driverKind: "hermesAgent",
  displayName: "Hermes",
  models: {
    default: "default",
    options: [{ id: "default", label: "Hermes profile default" }],
  },
  defaultCli: "hermes",
  nativeSource: "hermes.acp",
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

  // A leftover OPENAI_API_KEY makes Hermes auto-resolve to OpenRouter.
  // The property profile owns the model. Taken from OpenMausBot #177 family.
  transformEnv: (env) => {
    delete env.OPENAI_API_KEY;
    delete env.OPENROUTER_API_KEY;
  },

  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: (env) => {
    const home = env.HERMES_HOME || join(env.HOME || homedir(), ".hermes");
    return existsSync(join(home, "config.yaml")) || existsSync(join(home, ".env"));
  },
};

export const HermesAgentDriver = createAcpDriver(support);
