// Hermes Agent as a pinned ACP worker (`hermes -p property acp`).
// Not the product name. Version is HERMES_PIN — we do not follow upstream main.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { HERMES_PIN, hermesInstallCommand } from "../../hermes-pin.ts";
import { applyWorkerRuntimeEnv, WORKER_CLI, WORKER_HOME, WORKER_RUNTIME_DIR } from "../../config.ts";
import { modelCredentialEnvironment, modelStatus } from "../../hermes-bridge.ts";
import { seedVault } from "../../vault.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

const support: AcpSupport = {
  driverKind: "hermesAgent",
  displayName: "Worker",
  models: {
    default: "default",
    options: [{ id: "default", label: "Property profile default" }],
  },
  defaultCli: WORKER_CLI,
  nativeSource: "hermes.acp",
  loginNote: "The worker is not ready — finish setup in You → Worker.",

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
  transformEnv: (env, turn) => {
    // Shell keys from a personal setup must never silently fund or reroute
    // Bud. RealBud decrypts only the selected profile credential at spawn.
    const profileHome = turn?.executionPolicy?.isolatedProfileHome ?? WORKER_HOME;
    applyWorkerRuntimeEnv(env, profileHome, env.PATH, WORKER_RUNTIME_DIR);
    Object.assign(env, modelCredentialEnvironment(WORKER_HOME));
  },

  pickAuthMethod: () => null,
  authFailure: "continue",
  supportsIsolatedProfileHome: true,
  // Hermes 0.20.3 serializes `load_session -> None` as `{}`. Treating that
  // as a loaded cursor makes the next prompt return `refusal` with no text.
  // Successful Hermes loads include their model/mode response fields.
  sessionLoadSucceeded: (result) =>
    Boolean(result && typeof result === "object" && Object.keys(result as Record<string, unknown>).length > 0),
  isAuthenticated: (env) => {
    const home = env.HERMES_HOME;
    if (!home) return false;
    const profile = join(home, "profiles", HERMES_PIN.profile);
    const model = modelStatus(home);
    return existsSync(join(profile, "config.yaml")) && Boolean(model.provider && model.model && model.keyPresent);
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
