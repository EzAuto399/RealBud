const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const CUA_PIN = "0.19.3";
const POLICY_VERSION = 2;
const MAX_ORIGINS = 8;
const MAX_TTL_SECONDS = 60 * 60;
const MAX_IDLE_SECONDS = 15 * 60;

// These are Cua Driver 0.19.3's origin-aware browser adapters. Generic
// desktop/window observation or input is intentionally absent: Cua refuses
// to start an origin-scoped policy if one of those bypass routes is present.
const TYPED_BROWSER_TOOLS = Object.freeze([
  "start_session",
  "end_session",
  "browser_prepare",
  "get_browser_state",
  "browser_navigate",
  "browser_click",
  "browser_type",
]);

const SETUP_TOOLS = Object.freeze(["check_permissions"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

function boundedInteger(name, value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is outside the supported boundary`);
  }
  return value;
}

function boundedId(name, value) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function normalizeOrigin(value, { allowLoopbackHttp = false } = {}) {
  if (typeof value !== "string" || value.length > 512) throw new Error("browser origin is invalid");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("browser origin is invalid");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== value
  ) {
    throw new Error("browser origin must be an exact credential-free origin");
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(allowLoopbackHttp && loopback && parsed.protocol === "http:")) {
    throw new Error("browser origin must use HTTPS");
  }
  return parsed.origin;
}

function exactTools(value, expected) {
  if (!Array.isArray(value) || value.length !== expected.length) return false;
  return value.every((tool, index) => tool === expected[index]);
}

function createBrowserPolicy(input) {
  const origins = Array.isArray(input?.origins) ? input.origins : [];
  if (origins.length < 1 || origins.length > MAX_ORIGINS) {
    throw new Error("browser policy requires a bounded origin list");
  }
  const normalized = origins.map((origin) => normalizeOrigin(origin, input));
  if (new Set(normalized).size !== normalized.length) throw new Error("browser policy origins must be unique");
  const ttlSeconds = boundedInteger("browser policy lifetime", input.ttlSeconds, 60, MAX_TTL_SECONDS);
  const idleSeconds = boundedInteger("browser policy idle timeout", input.idleSeconds, 30, MAX_IDLE_SECONDS);
  if (idleSeconds > ttlSeconds) throw new Error("browser policy idle timeout exceeds its lifetime");
  boundedId("work item id", input.workItemId);
  boundedId("recipe id", input.recipeId);
  boundedInteger("recipe version", input.recipeVersion, 1, 1_000_000);
  if (input.profileKind !== "isolated") throw new Error("RealBud browser work requires an isolated profile");

  return Object.freeze({
    version: POLICY_VERSION,
    mode: "bounded",
    expires_after: `${ttlSeconds}s`,
    idle_timeout: `${idleSeconds}s`,
    allow: Object.freeze({ tools: TYPED_BROWSER_TOOLS }),
    resources: Object.freeze({
      browser: Object.freeze({
        profiles: Object.freeze([Object.freeze({ kind: "isolated" })]),
        origins: Object.freeze(normalized),
      }),
      desktop: Object.freeze({ display: false }),
    }),
  });
}

function createSetupPolicy() {
  return Object.freeze({
    version: POLICY_VERSION,
    mode: "bounded",
    expires_after: "1h",
    idle_timeout: "15m",
    allow: Object.freeze({ tools: SETUP_TOOLS }),
    resources: Object.freeze({ desktop: Object.freeze({ display: false }) }),
  });
}

function yamlScalar(value) {
  return JSON.stringify(value);
}

function serializePolicy(policy) {
  if (!policy || policy.version !== POLICY_VERSION || policy.mode !== "bounded" || !Array.isArray(policy.allow?.tools)) {
    throw new Error("CUA capability policy is invalid");
  }
  const lines = [
    `version: ${POLICY_VERSION}`,
    'mode: "bounded"',
    `expires_after: ${yamlScalar(policy.expires_after)}`,
    `idle_timeout: ${yamlScalar(policy.idle_timeout)}`,
    "",
    "allow:",
    "  tools:",
    ...policy.allow.tools.map((tool) => `    - ${yamlScalar(tool)}`),
    "",
    "resources:",
  ];
  if (policy.resources?.browser) {
    lines.push(
      "  browser:",
      "    profiles:",
      ...policy.resources.browser.profiles.map((profile) => `      - kind: ${yamlScalar(profile.kind)}`),
      "    origins:",
      ...policy.resources.browser.origins.map((origin) => `      - ${yamlScalar(origin)}`),
  );
  }
  lines.push("  desktop:", `    display: ${policy.resources?.desktop?.display === true ? "true" : "false"}`, "");
  return lines.join("\n");
}

function policyRoot(userData) {
  if (typeof userData !== "string" || !path.isAbsolute(userData)) throw new Error("CUA user data path is invalid");
  return path.join(userData, "cua", "policies");
}

function persistPolicy({ userData, label, policy, fileSystem = fs, processId = process.pid }) {
  const safeLabel = boundedId("policy label", label);
  const body = serializePolicy(policy);
  const digest = crypto.createHash("sha256").update(body).digest("hex");
  const root = policyRoot(userData);
  fileSystem.mkdirSync(root, { recursive: true, mode: 0o700 });
  fileSystem.chmodSync?.(root, 0o700);
  const target = path.join(root, `${safeLabel}-${digest.slice(0, 16)}.yaml`);
  const temporary = `${target}.${processId}.${crypto.randomUUID()}.tmp`;
  try {
    fileSystem.writeFileSync(temporary, body, { mode: 0o600, flag: "wx" });
    fileSystem.chmodSync?.(temporary, 0o600);
    fileSystem.renameSync(temporary, target);
    fileSystem.chmodSync?.(target, 0o600);
  } catch (error) {
    try {
      fileSystem.unlinkSync(temporary);
    } catch {}
    throw error;
  }
  return Object.freeze({ path: target, sha256: digest, body });
}

function removePolicy({ userData, policyPath, fileSystem = fs }) {
  if (typeof policyPath !== "string" || !path.isAbsolute(policyPath)) return false;
  const root = policyRoot(userData);
  const relative = path.relative(root, policyPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !/^[A-Za-z0-9._-]+\.yaml$/.test(relative)) {
    return false;
  }
  try {
    fileSystem.unlinkSync(policyPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    return false;
  }
}

module.exports = {
  CUA_PIN,
  POLICY_VERSION,
  SETUP_TOOLS,
  TYPED_BROWSER_TOOLS,
  createBrowserPolicy,
  createSetupPolicy,
  exactTools,
  normalizeOrigin,
  persistPolicy,
  removePolicy,
  serializePolicy,
};
