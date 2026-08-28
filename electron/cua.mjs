// CUA computer-use wiring for the Electron main process.
//
// RealBud always spawns its own embedded daemon via EmbeddedCuaDriverHost so
// TCC grants attribute to RealBud and a personal CuaDriver daemon/profile is
// never inspected or reused. Development uses only an explicit override or
// this checkout's prepared dist-native binary.
//
// Agents never talk to the daemon socket directly — they spawn the official
// stdio MCP proxy: `cua-driver mcp [--embedded --socket <path>]`. The proxy
// executes nothing; the host-owned daemon does.
//
// The resulting connection descriptor is written to
// <userData>/cua-connection.json for the harness server to hand to drivers.

import { app, ipcMain } from "electron";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { createCuaConnectionStore } = require("./cua-connection.cjs");
const { createCuaPreferenceStore, resolveCuaRuntime } = require("./cua-runtime.cjs");
const {
  CUA_PIN,
  TYPED_BROWSER_TOOLS,
  createBrowserPolicy,
  createSetupPolicy,
  exactTools,
  persistPolicy,
  removePolicy,
} = require("./cua-policy.cjs");

const HOST_BUNDLE_ID = "com.realbud.app";

let embeddedHost = null; // EmbeddedCuaDriverHost | null
let activePolicyPath = null;
let hostTransition = Promise.resolve();
const connectionStore = createCuaConnectionStore({
  getUserData: () => app.getPath("userData"),
});
const preferenceStore = createCuaPreferenceStore({
  getUserData: () => app.getPath("userData"),
});

function resolvedRuntime() {
  return resolveCuaRuntime({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    overridePath: process.env.CUA_DRIVER_PATH,
    developmentDriver: path.resolve(__dirname, "../dist-native/cua-driver"),
    exists: fs.existsSync,
  });
}

export function resolveDriverBinary() {
  return resolvedRuntime()?.path ?? null;
}

export function cuaRuntimeStatus() {
  return resolvedRuntime()?.runtime ?? "none";
}

export function cuaWasEnabled() {
  return preferenceStore.enabled();
}

async function loadEmbeddedSdk() {
  if (!app.isPackaged) {
    const [embedded, permissions] = await Promise.all([
      import("@trycua/cua-driver/embedded"),
      import("@trycua/cua-driver/electron"),
    ]);
    return { ...embedded, ...permissions };
  }
  process.env.OPENMAUSBOT_CUA_SDK_LIBRARY = path.join(
    process.resourcesPath,
    "cua-sdk",
    "native",
    "libcua_driver_sdk.dylib",
  );
  return import(pathToFileURL(path.join(process.resourcesPath, "cua-sdk", "cua-sdk.mjs")).href);
}

function policyMetadata(policy, bounded) {
  return {
    authorizationMode: "bounded",
    bounded: {
      ...bounded,
      driverVersion: CUA_PIN,
      policyVersion: policy.policy.version,
      policyPath: policy.path,
      policySha256: policy.sha256,
    },
  };
}

function connectionFromEmbedded(conn, binary, runtime, policy, bounded) {
  return {
    mode: "embedded",
    runtime,
    socketPath: conn.socketPath,
    mcpCommand: binary,
    mcpArgs: ["mcp", "--embedded", "--socket", conn.socketPath],
    mcpEnv: { CUA_DRIVER_EMBEDDED: "1", CUA_DRIVER_HOST_BUNDLE_ID: HOST_BUNDLE_ID },
    ...policyMetadata(policy, bounded),
  };
}

async function startEmbedded(binary, runtime, policy, bounded) {
  // Import from the staged Resources tree in production. The app intentionally
  // excludes general node_modules, so a bare package import only works in dev.
  const sdk = await loadEmbeddedSdk();
  // CUA's embedding contract requires grants before the child daemon starts;
  // these SDK calls execute in Electron main so macOS attributes them to
  // RealBud rather than to a terminal or helper process.
  const permissionStatus = sdk.requestMacOSPermissions();
  if (!sdk.hasRequiredMacOSPermissions(permissionStatus)) {
    const missing = [
      !permissionStatus.accessibility && "Accessibility",
      !permissionStatus.screenRecording && "Screen Recording",
    ].filter(Boolean).join(" and ");
    throw new Error(`${missing || "macOS permissions"} required; grant access in System Settings and restart RealBud`);
  }
  const host = sdk.EmbeddedCuaDriverHost.withOptions({
    binaryPath: binary,
    hostBundleId: HOST_BUNDLE_ID,
    permissionMode: sdk.EmbeddedPermissionMode.Bounded,
    sessionPolicyPath: policy.path,
    approveSessionPolicy: true,
    dangerouslyBypassApprovals: false,
    environment: [],
    inheritStderr: false,
  });
  embeddedHost = host;
  activePolicyPath = policy.path;
  try {
    const conn = await host.start();
    return connectionFromEmbedded(conn, binary, runtime, policy, bounded);
  } catch (error) {
    if (embeddedHost === host) embeddedHost = null;
    if (activePolicyPath === policy.path) activePolicyPath = null;
    await host.stop().catch(() => {});
    host.uniffiDestroy?.();
    throw error;
  }
}

async function stopEmbedded() {
  const host = embeddedHost;
  const policyPath = activePolicyPath;
  embeddedHost = null;
  activePolicyPath = null;
  let stopError = null;
  if (host) {
    try {
      await host.stop();
    } catch (error) {
      stopError = error;
    } finally {
      host.uniffiDestroy?.();
    }
  }
  if (policyPath) {
    removePolicy({ userData: app.getPath("userData"), policyPath });
  }
  if (stopError) throw stopError;
}

async function startSetupOnce() {
  const resolved = resolvedRuntime();
  if (!resolved) {
    return connectionStore.persist({ mode: "unavailable", runtime: "none", reason: "cua-driver binary not found" });
  }
  const { path: binary, runtime } = resolved;
  const policy = persistPolicy({
    userData: app.getPath("userData"),
    label: "setup",
    policy: createSetupPolicy(),
  });
  try {
    const nextConnection = await startEmbedded(binary, runtime, policy, {
      kind: "setup",
      tools: ["check_permissions"],
      expiresAt: Date.now() + 60 * 60_000,
      idleTimeoutMs: 15 * 60_000,
    });
    return connectionStore.persist(nextConnection);
  } catch (err) {
    removePolicy({ userData: app.getPath("userData"), policyPath: policy.path });
    return connectionStore.persist({
      mode: "unavailable",
      runtime,
      reason: `embedded host failed: ${err?.message ?? err}`,
    });
  }
}

function serializeHostTransition(operation) {
  const next = hostTransition.then(operation, operation);
  hostTransition = next.catch(() => {});
  return next;
}

async function ensureSetupHost() {
  const current = connectionStore.get();
  if (
    embeddedHost &&
    current?.mode === "embedded" &&
    current?.bounded?.kind === "setup" &&
    Number.isSafeInteger(current.bounded.expiresAt) &&
    current.bounded.expiresAt > Date.now()
  ) return current;
  // Revoke the old descriptor before touching the host. If stop fails, the
  // server must see unavailable rather than a stale socket/policy grant.
  connectionStore.persist({ mode: "unavailable", runtime: current?.runtime, reason: "desktop-host-restarting" });
  await stopEmbedded();
  return startSetupOnce();
}

export function startCua() {
  return serializeHostTransition(ensureSetupHost);
}

export function enableCua() {
  // The renderer disables the button while a request is running, but the
  // authoritative owner must also tolerate duplicate/retried IPC calls. Keep
  // the preference write and host transition in the same serialized lane so
  // two clicks cannot race the atomic preference temporary file or start two
  // permission hosts.
  return serializeHostTransition(async () => {
    preferenceStore.enable();
    return ensureSetupHost();
  });
}

/** Explicit PM-owned revocation. It turns off future auto-start, publishes an
 * unavailable descriptor before teardown and removes the active policy. */
export function disableCua() {
  return serializeHostTransition(async () => {
    preferenceStore.disable();
    const current = connectionStore.get();
    connectionStore.persist({ mode: "unavailable", runtime: current?.runtime, reason: "not-enabled" });
    await stopEmbedded();
    return connectionStore.persist({ mode: "unavailable", runtime: current?.runtime, reason: "not-enabled" });
  });
}

/** Start one immutable Cua 0.19.3 browser runtime for an already-admitted
 * RealBud work item. The native driver, not model prose or this descriptor,
 * enforces the exact origins, typed tools, profile kind and lifetimes. */
export function startBoundedSession(manifest) {
  return serializeHostTransition(async () => {
    if (!manifest || manifest.mode !== "bounded" || manifest.version !== CUA_PIN) {
      throw new Error(`browser work requires a bounded Cua ${CUA_PIN} session`);
    }
    if (!exactTools(manifest.tools, TYPED_BROWSER_TOOLS)) {
      throw new Error("browser work requires the exact typed Cua tool set");
    }
    if (!cuaWasEnabled()) throw new Error("computer use has not been set up by the PM");
    const now = Date.now();
    const remainingMs = manifest.expiresAt - now;
    if (!Number.isSafeInteger(remainingMs) || remainingMs < 60_000 || remainingMs > 60 * 60_000) {
      throw new Error("bounded browser session expiry is invalid");
    }
    if (
      !Number.isSafeInteger(manifest.idleTimeoutMs) ||
      manifest.idleTimeoutMs < 30_000 ||
      manifest.idleTimeoutMs > Math.min(15 * 60_000, remainingMs)
    ) {
      throw new Error("bounded browser idle timeout is invalid");
    }
    const policyTtlSeconds = Math.ceil(remainingMs / 1_000);
    const policyIdleSeconds = Math.ceil(manifest.idleTimeoutMs / 1_000);
    const policyBody = createBrowserPolicy({
      origins: manifest.origins,
      profileKind: manifest.profileKind,
      ttlSeconds: policyTtlSeconds,
      idleSeconds: policyIdleSeconds,
      workItemId: manifest.workItemId,
      recipeId: manifest.recipeId,
      recipeVersion: manifest.recipeVersion,
      allowLoopbackHttp:
        !app.isPackaged &&
        process.env.OMB_TEST_FLEET === "1" &&
        manifest.origins.every((origin) => /^http:\/\/(127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(origin)),
    });
    const resolved = resolvedRuntime();
    if (!resolved) throw new Error("RealBud's Cua runtime is unavailable");
    connectionStore.persist({ mode: "unavailable", runtime: resolved.runtime, reason: "bounded-session-starting" });
    await stopEmbedded();
    const policy = persistPolicy({
      userData: app.getPath("userData"),
      label: `work-${manifest.workItemId}`,
      policy: policyBody,
    });
    try {
      const next = await startEmbedded(resolved.path, resolved.runtime, policy, {
        kind: "workflow",
        mode: "bounded",
        profileKind: "isolated",
        origins: [...policyBody.resources.browser.origins],
        tools: [...TYPED_BROWSER_TOOLS],
        startedAt: now,
        expiresAt: manifest.expiresAt,
        idleTimeoutMs: manifest.idleTimeoutMs,
        policyTtlSeconds,
        policyIdleSeconds,
        workItemId: manifest.workItemId,
        recipeId: manifest.recipeId,
        recipeVersion: manifest.recipeVersion,
      });
      return connectionStore.persist(next);
    } catch (error) {
      removePolicy({ userData: app.getPath("userData"), policyPath: policy.path });
      connectionStore.persist({ mode: "unavailable", runtime: resolved.runtime, reason: "bounded-session-start-failed" });
      throw error;
    }
  });
}

export const persistBoundedSession = startBoundedSession;

export function endBoundedSession(workItemId) {
  return serializeHostTransition(async () => {
    const current = connectionStore.get();
    if (current?.bounded?.kind !== "workflow" || current.bounded.workItemId !== workItemId) {
      throw new Error("bounded browser session does not match this work item");
    }
    connectionStore.persist({ mode: "unavailable", runtime: current.runtime, reason: "bounded-session-ending" });
    await stopEmbedded();
    return startSetupOnce();
  });
}

export async function stopCua() {
  const current = connectionStore.get();
  connectionStore.persist({ mode: "unavailable", runtime: current?.runtime, reason: "desktop-host-stopping" });
  await stopEmbedded().catch(() => {});
}

export function registerCuaIpc() {
  ipcMain.handle("cua:connection", () => connectionStore.get());
}
