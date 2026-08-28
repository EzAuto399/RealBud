import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { WORKER_HOME } from "./config.ts";
import {
  applyPropertyPack,
  approvalsAreManual,
  packInstalled,
  propertyProfileDir,
  yamlBlock,
  withYamlBlock,
} from "./hermes-pack.ts";
import { workerProvider } from "../shared/worker-providers.ts";

const ISOLATED_HOME_NAME = ".worker-home";

function profileError(message: string): Error & { status: number; code: string } {
  return Object.assign(new Error(message), { status: 409, code: "selected-file-profile-unavailable" });
}

function safeModelBlock(config: string): string {
  const source = yamlBlock(config, "model");
  const provider = source ? /^[ \t]+provider:\s*(\S+)\s*$/m.exec(source)?.[1] : null;
  const model = source ? /^[ \t]+default:\s*(\S+)\s*$/m.exec(source)?.[1] : null;
  if (!provider || !workerProvider(provider) || !model || !/^[A-Za-z0-9~][A-Za-z0-9._:/@+~-]{0,199}$/.test(model)) {
    throw profileError("Bud's model profile is invalid. Open You → Worker and save it again.");
  }

  const rawBaseUrl = source ? /^[ \t]+base_url:\s*(.*?)\s*$/m.exec(source)?.[1] ?? "''" : "''";
  let baseUrl = "";
  if (rawBaseUrl !== "''" && rawBaseUrl !== '""') {
    try {
      const decoded = JSON.parse(rawBaseUrl) as unknown;
      if (typeof decoded !== "string" || decoded.length > 2_048) throw new Error("invalid");
      const parsed = new URL(decoded);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("unsafe");
      baseUrl = decoded;
    } catch {
      throw profileError("Bud's model endpoint is invalid. Open You → Worker and save it again.");
    }
  }

  // Reconstruct the only three supported non-secret fields. Never copy an
  // unknown model key from a hand-edited or legacy worker config.
  return `model:\n  default: ${model}\n  provider: ${provider}\n  base_url: ${baseUrl ? JSON.stringify(baseUrl) : "''"}\n`;
}

/**
 * Build a fresh worker home inside one selected-file workspace. Only the
 * code-owned property pack and the non-secret model selection cross this
 * boundary. Sessions, memories, channel state, browser state, dotenv files,
 * auth files and encrypted credentials remain in the long-lived worker home.
 */
export function stageSelectedFileWorkerHome(
  workspaceDirectory: string,
  options: { workerHome?: string } = {},
): string {
  if (!isAbsolute(workspaceDirectory)) throw profileError("the selected-file workspace is invalid");
  try {
    if (!lstatSync(workspaceDirectory).isDirectory()) throw new Error("not a directory");
  } catch {
    throw profileError("the selected-file workspace is unavailable");
  }

  const isolatedHome = join(workspaceDirectory, ISOLATED_HOME_NAME);
  if (existsSync(isolatedHome)) throw profileError("the selected-file worker context already exists");
  mkdirSync(isolatedHome, { mode: 0o700 });

  const workerHome = options.workerHome ?? WORKER_HOME;
  let sourceConfig: string;
  try {
    sourceConfig = readFileSync(join(propertyProfileDir(workerHome), "config.yaml"), "utf8");
  } catch {
    throw profileError("Bud's model profile is unavailable. Open You → Worker and finish setup.");
  }
  const model = safeModelBlock(sourceConfig);

  try {
    applyPropertyPack(isolatedHome);
    const isolatedConfigPath = join(propertyProfileDir(isolatedHome), "config.yaml");
    const isolatedConfig = readFileSync(isolatedConfigPath, "utf8");
    writeFileSync(isolatedConfigPath, withYamlBlock(isolatedConfig, "model", model), { mode: 0o600 });
    chmodSync(isolatedConfigPath, 0o600);
  } catch {
    throw profileError("RealBud could not prepare the private selected-file worker context");
  }

  if (!packInstalled(isolatedHome) || !approvalsAreManual(isolatedHome)) {
    throw profileError("the private selected-file worker context failed its safety check");
  }
  return isolatedHome;
}
