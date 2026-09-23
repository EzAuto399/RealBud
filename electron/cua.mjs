// CUA computer-use wiring for the Electron main process.
//
// Two modes, per cua-driver's EMBEDDING.md:
//  - "embedded" (packaged app): spawn our own private daemon via
//    EmbeddedCuaDriverHost so TCC grants attribute to RealBud and the
//    driver inherits them. One prompt, named RealBud, out of the box.
//  - "standalone" (dev): attach to an already-installed CuaDriver.app daemon
//    (its own TCC identity, typically already granted on a dev machine).
//
// Agents never talk to the daemon socket directly — they spawn the official
// stdio MCP proxy: `cua-driver mcp [--embedded --socket <path>]`. The proxy
// executes nothing; the host-owned daemon does.
//
// The resulting connection descriptor is written to
// <userData>/cua-connection.json for the harness server to hand to drivers.

import { app, ipcMain } from "electron";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkCuaLogin } from "./cua-login-check.mjs";
import { createGrantedCuaHost, CUA_HOST_BUNDLE_ID } from "./cua-launcher.mjs";

const require = createRequire(import.meta.url);
const { createCuaConnectionStore } = require("./cua-connection.cjs");

const INSTALLED_DRIVER = "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";
const STANDALONE_SOCKET = path.join(
  app.getPath("home"),
  "Library/Caches/cua-driver/cua-driver.sock",
);

let embeddedHost = null; // EmbeddedCuaDriverHost | null
let embeddedStop = null; // One confirmed stop per host, including failed startup.
const pauseFile = () => path.join(app.getPath("userData"), "cua-human-pause.json");
const connectionStore = createCuaConnectionStore({
  getUserData: () => app.getPath("userData"),
});

export const currentCuaConnection = () => connectionStore.get();

async function stopEmbeddedHost() {
  const host = embeddedHost;
  if (!host) return;
  if (embeddedStop) return embeddedStop;
  const stopping = (async () => {
    await host.stop();
    host.uniffiDestroy?.();
    if (embeddedHost === host) embeddedHost = null;
  })();
  embeddedStop = stopping;
  try { await stopping; }
  finally { if (embeddedStop === stopping) embeddedStop = null; }
}

export function resolveDriverBinary() {
  if (process.env.CUA_DRIVER_PATH) return process.env.CUA_DRIVER_PATH;
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, process.platform === "win32" ? "cua-driver.exe" : "cua-driver");
    if (fs.existsSync(bundled)) return bundled;
  }
  if (process.platform === "darwin" && fs.existsSync(INSTALLED_DRIVER)) return INSTALLED_DRIVER;
  return null;
}

function socketAlive(sockPath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(sockPath)) return resolve(false);
    const s = net.createConnection(sockPath);
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    setTimeout(() => done(false), 1500).unref();
  });
}

async function loadEmbeddedSdk() {
  if (!app.isPackaged) {
    const [embedded, permissions] = await Promise.all([
      import("@trycua/cua-driver"),
      process.platform === "darwin" ? import("@trycua/cua-driver/electron") : Promise.resolve({}),
    ]);
    return { ...embedded, ...permissions };
  }
  process.env.OPENMAUSBOT_CUA_SDK_LIBRARY = path.join(
    process.resourcesPath,
    "cua-sdk",
    "native",
    process.platform === "win32" ? "cua_driver_sdk.dll" : "libcua_driver_sdk.dylib",
  );
  return import(pathToFileURL(path.join(process.resourcesPath, "cua-sdk", "cua-sdk.mjs")).href);
}

async function startEmbedded(binary, { checkingHumanSignIn = false } = {}) {
  // Import from the staged Resources tree in production. The app intentionally
  // excludes general node_modules, so a bare package import only works in dev.
  const sdk = await loadEmbeddedSdk();
  // CUA's embedding contract requires grants before the child daemon starts;
  // these SDK calls execute in Electron main so macOS attributes them to
  // RealBud rather than to a terminal or helper process.
  const permissionStatus = process.platform === "darwin" ? sdk.requestMacOSPermissions() : null;
  if (permissionStatus && !sdk.hasRequiredMacOSPermissions(permissionStatus)) {
    const missing = [
      !permissionStatus.accessibility && "Accessibility",
      !permissionStatus.screenRecording && "Screen Recording",
    ].filter(Boolean).join(" and ");
    throw new Error(`${missing || "macOS permissions"} required; grant access in System Settings and restart RealBud`);
  }
  // Loading the SDK crosses an async boundary: human release may have arrived
  // while it loaded. Never start behind the saved sign-in pause.
  if (fs.existsSync(pauseFile()) && !checkingHumanSignIn) throw new Error("Desktop control is paused for human sign-in.");
  if (embeddedHost) throw new Error("The previous desktop host has not been released.");
  const host = createGrantedCuaHost(sdk, binary, { userData: app.getPath("userData") });
  embeddedHost = host;
  let conn;
  try {
    conn = await host.start();
    if (embeddedHost !== host || (!checkingHumanSignIn && fs.existsSync(pauseFile()))) throw new Error("Desktop startup was stopped.");
  } catch (error) {
    if (embeddedHost === host) {
      try { await stopEmbeddedHost(); }
      catch { /* Keep the handle for explicit recovery; never publish it. */ }
    }
    throw error;
  }
  return {
    mode: "embedded",
    socketPath: conn.socketPath,
    // MCP proxy talks to the already-granted daemon; keep the real binary.
    mcpCommand: binary,
    mcpArgs: ["mcp", "--embedded", "--socket", conn.socketPath],
    mcpEnv: { CUA_DRIVER_EMBEDDED: "1", CUA_DRIVER_HOST_BUNDLE_ID: CUA_HOST_BUNDLE_ID },
  };
}

export async function startCua() {
  if (fs.existsSync(pauseFile())) return connectionStore.persist({ mode: "unavailable", reason: "human-signin-paused" });
  const binary = resolveDriverBinary();
  if (!binary) {
    return connectionStore.persist({
      mode: "unavailable",
      reason: "cua-driver binary not found",
    });
  }

  const wantEmbedded =
    app.isPackaged || process.env.OPENMAUSBOT_CUA_EMBEDDED === "1";
  let nextConnection;

  if (wantEmbedded) {
    try {
      nextConnection = await startEmbedded(binary);
    } catch (err) {
      nextConnection = {
        mode: "unavailable",
        reason: `embedded host failed: ${err?.message ?? err}`,
      };
    }
  } else if (process.platform === "darwin" && await socketAlive(STANDALONE_SOCKET)) {
    // Dev machine with CuaDriver.app's daemon already running.
    nextConnection = {
      mode: "standalone",
      socketPath: STANDALONE_SOCKET,
      mcpCommand: binary,
      mcpArgs: ["mcp"],
      mcpEnv: {},
    };
  } else {
    nextConnection = {
      mode: "unavailable",
      reason:
        "no running cua-driver daemon; run `cua-driver serve` or grant via `cua-driver permissions grant`",
    };
  }

  // Release can run between the async startup result and this publication.
  // The persisted human pause is authoritative at the final boundary too.
  if (fs.existsSync(pauseFile())) nextConnection = { mode: "unavailable", reason: "human-signin-paused" };
  return connectionStore.persist(nextConnection);
}

const FORBIDDEN_PORTAL_TOOLS = [
  "screenshot_desktop",
  "click_xy",
  "press_key",
  "type_enter",
  "javascript",
  "shell",
  "computer_exec",
  "computer_batch",
];

/** Persist a per-workflow bounded Cua 0.19.3 session. Portal work must never
 * fall back to an unrestricted host CUA descriptor. */
export function persistBoundedSession(manifest) {
  if (!manifest || manifest.mode !== "bounded" || manifest.version !== "0.19.3") {
    throw new Error("portal work requires a bounded Cua 0.19.3 session");
  }
  const tools = Array.isArray(manifest.tools) ? manifest.tools : [];
  if (tools.some((tool) => FORBIDDEN_PORTAL_TOOLS.includes(tool))) {
    throw new Error("bounded session mounted a forbidden tool");
  }
  const current = connectionStore.get();
  if (!current || current.mode === "unavailable") {
    throw new Error("no Cua host for a bounded portal session — do not fall back to unrestricted CUA");
  }
  return connectionStore.persist({
    ...current,
    bounded: {
      version: manifest.version,
      mode: "bounded",
      profile: manifest.profile,
      origins: manifest.origins,
      tools: manifest.tools,
      forbidden: manifest.forbidden ?? FORBIDDEN_PORTAL_TOOLS,
      expiresAt: manifest.expiresAt,
      idleTimeoutMs: manifest.idleTimeoutMs,
      workItemId: manifest.workItemId,
      recipeId: manifest.recipeId,
      recipeVersion: manifest.recipeVersion,
    },
  });
}

export function cuaPermissionsStatus() {
  const binary = resolveDriverBinary();
  if (!binary) return { available: false };
  const out = spawnSync(binary, ["permissions", "status", "--json"], {
    encoding: "utf8",
    timeout: 5000,
  });
  try {
    return { available: true, ...JSON.parse(out.stdout) };
  } catch {
    return { available: true, raw: out.stdout?.trim() };
  }
}

export async function stopCua() {
  if (embeddedHost) {
    try {
      await stopEmbeddedHost();
    } catch {
      // daemon holds a parent-liveness pipe; host death closes it anyway
    }
  }
  if (connectionStore.get()) {
    connectionStore.persist({ mode: "unavailable", reason: "desktop-host-stopped" });
  }
}

/** A human credential window needs confirmed release, unlike best-effort
 * app shutdown. Do not attach to or stop a separately owned CuaDriver app. */
export async function releaseCuaForHuman() {
  if (connectionStore.get()?.mode === "standalone") throw new Error("A private embedded desktop host is required for safe sign-in handover.");
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(pauseFile(), JSON.stringify({ version: 1, paused: true }), { mode: 0o600 });
  connectionStore.persist({ mode: "unavailable", reason: "human-signin-paused" });
  await stopEmbeddedHost();
}

export async function verifyCuaAfterHuman(binding, requestId) {
  if (!fs.existsSync(pauseFile()) || embeddedHost) throw new Error("Desktop must be released before a sign-in check.");
  const binary = resolveDriverBinary();
  if (!binary) throw new Error("The pinned desktop helper is unavailable.");
  let driver, timer;
  try {
    // Keep the public descriptor unavailable throughout this isolated read.
    const conn = await startEmbedded(binary, { checkingHumanSignIn: true });
    const sdk = await loadEmbeddedSdk();
    driver = await sdk.CuaDriver.connect(conn.socketPath);
    return await Promise.race([
      checkCuaLogin(driver, binding, requestId),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Sign-in check timed out.")), 12_000); }),
    ]);
  } finally {
    clearTimeout(timer);
    // Stop the daemon before destroying the client so timed-out reads cannot
    // continue behind the human's sign-in screen.
    await releaseCuaForHuman();
    driver?.uniffiDestroy?.();
  }
}

export async function restoreCuaAfterHuman() {
  if (embeddedHost) throw new Error("The previous desktop session has not been released.");
  fs.rmSync(pauseFile(), { force: true });
  const result = await startCua();
  if (result.mode !== "embedded") {
    await releaseCuaForHuman();
    throw new Error("The private desktop helper could not restart.");
  }
}

export function registerCuaIpc() {
  ipcMain.handle("cua:connection", () => connectionStore.get());
  ipcMain.handle("cua:permissions", () => cuaPermissionsStatus());
}
