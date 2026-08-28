import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { ALLOWED_TOOLS, CUA_PIN } from "./cua-bounded.ts";

export type LocalComputerConnection = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

type ConnectionDescriptor = {
  mode?: string;
  runtime?: unknown;
  socketPath?: unknown;
  mcpCommand?: unknown;
  mcpArgs?: unknown;
  mcpEnv?: unknown;
  authorizationMode?: unknown;
  bounded?: unknown;
};

type WorkflowBoundary = {
  kind: "workflow";
  mode: "bounded";
  driverVersion: string;
  policyVersion: number;
  policyPath: string;
  policySha256: string;
  profileKind: "isolated";
  origins: string[];
  tools: string[];
  startedAt: number;
  expiresAt: number;
  idleTimeoutMs: number;
  policyTtlSeconds: number;
  policyIdleSeconds: number;
  workItemId: string;
  recipeId: string;
  recipeVersion: number;
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

function exactWorkflowBoundary(value: unknown, userData: string, now: number): value is WorkflowBoundary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const boundary = value as Record<string, unknown>;
  const keys = Object.keys(boundary).sort();
  const expected = [
    "driverVersion",
    "expiresAt",
    "idleTimeoutMs",
    "kind",
    "mode",
    "origins",
    "policyPath",
    "policySha256",
    "policyVersion",
    "profileKind",
    "policyIdleSeconds",
    "policyTtlSeconds",
    "recipeId",
    "recipeVersion",
    "startedAt",
    "tools",
    "workItemId",
  ].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return false;
  if (
    boundary.kind !== "workflow" ||
    boundary.mode !== "bounded" ||
    boundary.driverVersion !== CUA_PIN ||
    boundary.policyVersion !== 2 ||
    boundary.profileKind !== "isolated" ||
    typeof boundary.policyPath !== "string" ||
    !isAbsolute(boundary.policyPath) ||
    typeof boundary.policySha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(boundary.policySha256) ||
    !Number.isSafeInteger(boundary.startedAt) ||
    (boundary.startedAt as number) < 0 ||
    (boundary.startedAt as number) > now ||
    !Number.isSafeInteger(boundary.expiresAt) ||
    (boundary.expiresAt as number) <= now ||
    (boundary.expiresAt as number) > now + 60 * 60_000 ||
    !Number.isSafeInteger(boundary.idleTimeoutMs) ||
    (boundary.idleTimeoutMs as number) < 30_000 ||
    (boundary.idleTimeoutMs as number) > 15 * 60_000 ||
    !Number.isSafeInteger(boundary.policyTtlSeconds) ||
    (boundary.policyTtlSeconds as number) < 60 ||
    (boundary.policyTtlSeconds as number) > 60 * 60 ||
    !Number.isSafeInteger(boundary.policyIdleSeconds) ||
    (boundary.policyIdleSeconds as number) < 30 ||
    (boundary.policyIdleSeconds as number) > 15 * 60 ||
    (boundary.policyIdleSeconds as number) > (boundary.policyTtlSeconds as number) ||
    !SAFE_ID.test(String(boundary.workItemId ?? "")) ||
    !SAFE_ID.test(String(boundary.recipeId ?? "")) ||
    !Number.isSafeInteger(boundary.recipeVersion) ||
    (boundary.recipeVersion as number) < 1 ||
    (boundary.recipeVersion as number) > 1_000_000
  ) {
    return false;
  }
  const minimumExpiry = (boundary.startedAt as number) + ((boundary.policyTtlSeconds as number) - 1) * 1_000;
  const maximumExpiry = (boundary.startedAt as number) + (boundary.policyTtlSeconds as number) * 1_000;
  if ((boundary.expiresAt as number) <= minimumExpiry || (boundary.expiresAt as number) > maximumExpiry) return false;
  if (Math.ceil((boundary.idleTimeoutMs as number) / 1_000) !== boundary.policyIdleSeconds) return false;
  if (
    !Array.isArray(boundary.tools) ||
    boundary.tools.length !== ALLOWED_TOOLS.length ||
    !boundary.tools.every((tool, index) => tool === ALLOWED_TOOLS[index])
  ) {
    return false;
  }
  if (!Array.isArray(boundary.origins) || boundary.origins.length < 1 || boundary.origins.length > 8) return false;
  const origins = boundary.origins as unknown[];
  if (new Set(origins).size !== origins.length) return false;
  for (const origin of origins) {
    if (typeof origin !== "string" || origin.length > 512) return false;
    try {
      const parsed = new URL(origin);
      const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
      if (
        parsed.origin !== origin ||
        parsed.username ||
        parsed.password ||
        parsed.pathname !== "/" ||
        parsed.search ||
        parsed.hash ||
        (parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:"))
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }

  const policyRoot = resolve(userData, "cua", "policies");
  const policyPath = resolve(boundary.policyPath);
  const inside = relative(policyRoot, policyPath);
  if (!inside || inside.startsWith("..") || isAbsolute(inside) || !/^[A-Za-z0-9._-]+\.yaml$/.test(basename(policyPath))) {
    return false;
  }
  try {
    const rootStat = lstatSync(policyRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) !== 0) return false;
    const stat = lstatSync(policyPath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size < 1 ||
      stat.size > 64 * 1024
    ) return false;
    const realRoot = realpathSync(policyRoot);
    const realPolicy = realpathSync(policyPath);
    const realInside = relative(realRoot, realPolicy);
    if (!realInside || realInside.startsWith("..") || isAbsolute(realInside)) return false;
    const body = readFileSync(policyPath, "utf8");
    const expectedBody = [
      "version: 2",
      'mode: "bounded"',
      `expires_after: ${JSON.stringify(`${boundary.policyTtlSeconds}s`)}`,
      `idle_timeout: ${JSON.stringify(`${boundary.policyIdleSeconds}s`)}`,
      "",
      "allow:",
      "  tools:",
      ...(boundary.tools as string[]).map((tool) => `    - ${JSON.stringify(tool)}`),
      "",
      "resources:",
      "  browser:",
      "    profiles:",
      '      - kind: "isolated"',
      "    origins:",
      ...(boundary.origins as string[]).map((origin) => `      - ${JSON.stringify(origin)}`),
      "  desktop:",
      "    display: false",
      "",
    ].join("\n");
    if (body !== expectedBody) return false;
    const digest = createHash("sha256").update(body).digest("hex");
    if (digest !== boundary.policySha256) return false;
  } catch {
    return false;
  }
  return true;
}

function decodeDescriptor(
  value: ConnectionDescriptor,
  { userData, now, expectedDriver }: { userData: string; now: number; expectedDriver?: string },
): LocalComputerConnection | null {
  const descriptorKeys = Object.keys(value ?? {}).sort();
  const expectedDescriptorKeys = [
    "authorizationMode",
    "bounded",
    "mcpArgs",
    "mcpCommand",
    "mcpEnv",
    "mode",
    "runtime",
    "socketPath",
  ].sort();
  if (
    !value ||
    descriptorKeys.length !== expectedDescriptorKeys.length ||
    descriptorKeys.some((key, index) => key !== expectedDescriptorKeys[index]) ||
    value.mode !== "embedded" ||
    value.authorizationMode !== "bounded" ||
    (value.runtime !== "bundled" && value.runtime !== "development") ||
    typeof value.mcpCommand !== "string" ||
    !isAbsolute(value.mcpCommand) ||
    basename(value.mcpCommand) !== "cua-driver" ||
    typeof value.socketPath !== "string" ||
    !isAbsolute(value.socketPath) ||
    !exactWorkflowBoundary(value.bounded, userData, now)
  ) {
    return null;
  }
  if (expectedDriver !== undefined) {
    if (!isAbsolute(expectedDriver) || resolve(value.mcpCommand) !== resolve(expectedDriver)) return null;
  }
  try {
    const driver = lstatSync(value.mcpCommand);
    if (!driver.isFile() || driver.isSymbolicLink() || (driver.mode & 0o111) === 0) return null;
  } catch {
    return null;
  }
  if (value.mcpArgs !== undefined && !Array.isArray(value.mcpArgs)) return null;
  if (
    value.mcpEnv !== undefined &&
    (!value.mcpEnv || typeof value.mcpEnv !== "object" || Array.isArray(value.mcpEnv))
  ) {
    return null;
  }

  const args = value.mcpArgs ?? ["mcp"];
  if (!args.every((arg) => typeof arg === "string")) return null;
  // The current Cua host emits four arguments. Keep an exact shape so a
  // forged descriptor cannot add --direct, --grant, or another endpoint.
  if (
    args.length !== 4 ||
    args[0] !== "mcp" ||
    args[1] !== "--embedded" ||
    args[2] !== "--socket" ||
    args[3] !== value.socketPath
  ) {
    return null;
  }

  const env = (value.mcpEnv ?? {}) as Record<string, unknown>;
  if (!Object.values(env).every((entry) => typeof entry === "string")) return null;
  const envKeys = Object.keys(env).sort();
  if (
    envKeys.length !== 2 ||
    envKeys[0] !== "CUA_DRIVER_EMBEDDED" ||
    envKeys[1] !== "CUA_DRIVER_HOST_BUNDLE_ID" ||
    env.CUA_DRIVER_EMBEDDED !== "1" ||
    env.CUA_DRIVER_HOST_BUNDLE_ID !== "com.realbud.app"
  ) {
    return null;
  }

  return {
    command: value.mcpCommand,
    args,
    env: env as Record<string, string>,
  };
}

export function readCuaConnection({
  platform = process.platform,
  userData = process.env.OMB_USER_DATA,
  expectedDriver = process.env.OMB_CUA_DRIVER_PATH,
  home = homedir(),
  now = Date.now(),
}: {
  platform?: NodeJS.Platform;
  userData?: string;
  expectedDriver?: string;
  home?: string;
  now?: number;
} = {}): LocalComputerConnection | null {
  // Local computer work is a macOS-only pilot. Ignore even a forged or stale
  // descriptor on Linux/Windows until their installed CUA evidence exists.
  if (platform !== "darwin") return null;
  if (!Number.isSafeInteger(now) || now < 0) return null;

  const candidates = userData ? [join(userData, "cua-connection.json")] : [];
  if (!userData) {
    // Legacy/dev fallback. Packaged Electron passes its exact userData path.
    for (const dir of ["RealBud", "realbud"]) {
      candidates.push(join(home, "Library", "Application Support", dir, "cua-connection.json"));
    }
  }

  for (const file of [...new Set(candidates)]) {
    try {
      const stat = lstatSync(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size < 2 ||
        stat.size > 64 * 1024
      ) continue;
      const decoded = decodeDescriptor(JSON.parse(readFileSync(file, "utf8")), {
        userData: userData ?? resolve(file, ".."),
        now,
        expectedDriver,
      });
      if (decoded) return decoded;
    } catch {
      // Missing, invalid, or stale descriptors are simply unavailable.
    }
  }
  return null;
}
