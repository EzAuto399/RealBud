import { registerDesktopShutdown } from "./shutdown.mjs";
import { createServerSupervisor } from "./server-supervisor.mjs";
import { findRunningService, probeService, serviceIdentity } from "./service-instance.mjs";
import { clearServiceHandle, processAlive, readServiceHandle, shouldStartService, startDetachedService } from "./service-lifecycle.mjs";
import { app, BrowserWindow, clipboard, desktopCapturer, ipcMain, safeStorage, session, shell, systemPreferences, utilityProcess } from "electron";
import { createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startCua, stopCua, registerCuaIpc, releaseCuaForHuman, verifyCuaAfterHuman, restoreCuaAfterHuman, currentCuaConnection } from "./cua.mjs";
import { startCuaControl } from "./cua-control.mjs";
import { finishSpeech, speechSupported, startSpeech, stopSpeech } from "./speech.mjs";
import { openBlankTerminal } from "./terminal-launch.mjs";
import { startUpdater, registerUpdaterIpc } from "./updater.mjs";
import capabilitiesModule from "./capabilities.cjs";

const require = createRequire(import.meta.url);
const { privacySettingsUrls } = require("./perm-settings.cjs");
const { desktopCapabilities } = capabilitiesModule;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 127.0.0.1 explicitly — vite binds IPv4; a bare "localhost" here can
// resolve to ::1 and paint a black window
const DEV_URL = process.env.ELECTRON_START_URL ?? "http://127.0.0.1:5199";
let SERVER_PORT = 8799;
const APP_ICON = path.join(__dirname, "resources/app-icon.png");

// Electron otherwise presents the development binary as "Electron" in the
// macOS menu bar even though the product and packaged bundle are RealBud.
app.setName("RealBud");

// GNOME groups the window with its installed desktop entry only when both
// identities match. This must run before Electron becomes ready.
if (process.platform === "linux") app.setDesktopName("com.realbud.app.desktop");

// One desk, one app. A second launch would fork a second harness server over
// the same ~/.realbud — silent last-writer-wins on the book. Focus the
// existing window instead.
const smokeMode = process.env.OMB_SMOKE_TEST === "1";
if (!smokeMode && !app.requestSingleInstanceLock()) {
  app.quit();
} else if (!smokeMode) {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

// Packaged: the harness server ships in Resources (compiled JS, zero deps)
// and runs on Electron's own Node via utilityProcess. It serves the built
// UI too, so the window talks to one origin and there is no dev proxy.
// A stray server on the default port must not brick the app — fall back to
// alternate ports until one binds AND identifies as ours (the probe checks
// our API shape, not just a 200).
let serverProc = null;
let serverReady = true;
/** Supervises the service child so an unexpected exit is restarted, not ignored. */
let serverSupervisor = null;
/** False until the service has bound a port; afterwards restarts reuse that port. */
let serverEverStarted = false;
/** True when this app attached to a service that was already running. */
let serviceAdopted = false;
/** Handle for a service this app started, when it started one. */
let serviceHandle = null;

// The packaged app has no terminal: everything about the server child's life
// goes to server.log in the OS log dir (~/Library/Logs/RealBud on macOS,
// Console.app-visible; %APPDATA%\RealBud\logs on Windows), which is also
// why stdio is piped, not inherited — under a Finder/Explorer launch the
// parent's stdio leads nowhere and a failed boot is otherwise undiagnosable.
const LOG_DIR = app.getPath("logs");
let logStream = null;
function slog(line) {
  try {
    if (!logStream) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      logStream = fs.createWriteStream(path.join(LOG_DIR, "server.log"), { flags: "a" });
    }
    logStream.write(`[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* logging must never break startup */
  }
}

function realbudDataDir() {
  return process.env.REALBUD_DATA_DIR || process.env.OMB_DATA_DIR || path.join(app.getPath("home"), ".realbud");
}

/** Unwrap or create the book key. When safeStorage works, the plaintext
 * desk.key file is removed and the hex is passed to the server child. */
function deskEnvelopeOpens(hex, filePath) {
  try {
    const envelope = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!envelope || envelope.v !== 1 || envelope.alg !== "aes-256-gcm") return false;
    if (typeof envelope.iv !== "string" || typeof envelope.tag !== "string" || typeof envelope.ct !== "string") return false;
    const key = Buffer.from(hex, "hex");
    if (key.length !== 32) return false;
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    Buffer.concat([decipher.update(Buffer.from(envelope.ct, "base64")), decipher.final()]);
    return true;
  } catch {
    return false;
  }
}

function preferDeskKeyHex(dir, wrapHex, rawHex) {
  const quarantines = [];
  try {
    for (const name of fs.readdirSync(dir).filter((entry) => entry.startsWith("desk.json.quarantine-")).sort().reverse()) {
      quarantines.push(path.join(dir, name));
    }
  } catch {
    /* empty data dir */
  }
  const deskFile = path.join(dir, "desk.json");
  const keys = [rawHex, wrapHex].filter(Boolean);
  // Newest quarantine first, then each candidate key. A drifted wrap can still
  // decrypt older demo quarantines; the latest recoverable office book wins.
  for (const file of quarantines) {
    for (const hex of keys) {
      if (deskEnvelopeOpens(hex, file)) return hex;
    }
  }
  if (fs.existsSync(deskFile)) {
    for (const hex of keys) {
      if (deskEnvelopeOpens(hex, deskFile)) return hex;
    }
  }
  return wrapHex || rawHex;
}

function deskKeyForChild() {
  const dir = realbudDataDir();
  fs.mkdirSync(dir, { recursive: true });
  const rawPath = path.join(dir, "desk.key");
  const wrapPath = path.join(dir, "desk.key.wrap");
  const asHex = (raw) => {
    if (raw.length === 32) return Buffer.from(raw).toString("hex");
    const text = raw.toString("utf8").trim();
    return /^[0-9a-fA-F]{64}$/.test(text) ? text.toLowerCase() : null;
  };
  // A fresh macOS Keychain can synchronously request authorization on the
  // first safeStorage write. Package smoke has no user to answer that prompt,
  // and its disposable data directory does not need a durable wrapped key.
  if (smokeMode) return { hex: randomBytes(32).toString("hex"), production: false };
  if (safeStorage.isEncryptionAvailable()) {
    try {
      let wrapHex = null;
      if (fs.existsSync(wrapPath)) {
        const hex = safeStorage.decryptString(fs.readFileSync(wrapPath));
        if (/^[0-9a-fA-F]{64}$/.test(hex)) wrapHex = hex.toLowerCase();
      }
      const rawHex = fs.existsSync(rawPath) ? asHex(fs.readFileSync(rawPath)) : null;
      let hex = preferDeskKeyHex(dir, wrapHex, rawHex);
      if (!hex) hex = randomBytes(32).toString("hex");
      // Re-wrap the key that actually opens the book so wrap/file drift cannot
      // put the office into recovery on every launch.
      fs.writeFileSync(wrapPath, safeStorage.encryptString(hex), { mode: 0o600 });
      try {
        fs.unlinkSync(rawPath);
      } catch {
        /* leftover plaintext is best-effort */
      }
      return { hex, production: true };
    } catch (err) {
      slog(`desk key wrap failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { hex: process.env.REALBUD_DESK_KEY || null, production: false };
}

async function startServerOn(port) {
  const entry = path.join(process.resourcesPath, "server", "index.js");
  const deskKey = deskKeyForChild();
  slog(`fork ${entry} port=${port} key=${deskKey.production ? "wrapped" : "source"}`);
  const proc = utilityProcess.fork(entry, [], {
    env: {
      ...process.env,
      OMB_STATIC_DIR: path.join(process.resourcesPath, "ui"),
      OMB_PORT: String(port),
      OMB_USER_DATA: app.getPath("userData"),
      REALBUD_DATA_DIR: realbudDataDir(),
      // Service credentials require a separately provisioned administrator.
      REALBUD_MANAGED_SERVICE: "1",
      REALBUD_SERVICE_ENTITLEMENT_REQUIRED: "1",
      // Bud's hands live under RealBud's data dir — never share ~/.hermes
      // auth/memory with Hermes Desktop profiles (personal, property-manager, …).
      REALBUD_HERMES_HOME: path.join(realbudDataDir(), "hermes"),
      HERMES_HOME: path.join(realbudDataDir(), "hermes"),
      ...(cuaControl?.env ?? {}),
      ...(deskKey.hex ? { REALBUD_DESK_KEY: deskKey.hex } : {}),
      ...(deskKey.production ? { REALBUD_PRODUCTION: "1" } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", (d) => slog(`[out] ${String(d).trimEnd()}`));
  proc.stderr?.on("data", (d) => slog(`[err] ${String(d).trimEnd()}`));
  proc.once("spawn", () => slog(`spawned pid=${proc.pid}`));
  let exited = false;
  proc.once("exit", (code) => {
    exited = true;
    slog(`exited code=${code}`);
  });
  // wait for the port to answer (fresh machine: first boot writes data dirs).
  // Identity check is by PID: a dev harness server has the same API shape,
  // so only the child we actually forked (matching pid + static serving)
  // counts as ours.
  for (let i = 0; i < 40; i++) {
    if (exited) return null;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body?.app === "realbud" && body.pid === proc.pid && body.static) return proc;
        break; // someone else owns this port — try the next one
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  try {
    proc.kill();
  } catch {}
  return null;
}

async function startServerPackaged({ onlyPort = null } = {}) {
  // Restarts must land on the port the window already loaded, because the
  // renderer's origin is fixed at creation time. Scanning for a different port
  // would leave a live window pointing at nothing.
  const ports = onlyPort ? [onlyPort] : [8799, 18799, 28799];
  // two passes: a quit-and-reopen relaunch can race the dying instance's
  // server during teardown — one settle-and-retry covers it
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const port of ports) {
      const proc = await startServerOn(port);
      if (proc) {
        serverProc = proc;
        SERVER_PORT = port;
        return true;
      }
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  return false;
}

const ERROR_PAGE =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    `<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#070707;color:#fcfcfc;font:15px -apple-system,system-ui"><div style="text-align:center;max-width:360px"><div style="font-size:40px">🏠</div><h2 style="font-weight:600;margin:12px 0 6px">Couldn't start the desk service</h2><p style="color:#fcfcfc99;line-height:1.5">Something else is using its ports. Quit and reopen RealBud — if it keeps happening, restart your computer.</p></div></body>`,
  );

let cuaReady = Promise.resolve({ mode: "unavailable", reason: "not-started" });
let cuaControl;

function writeSmokeResult(payload) {
  const file = process.env.OMB_SMOKE_RESULT_FILE;
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(payload)}\n`);
  } catch (err) {
    slog(`smoke result write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function createWindow() {
  const isMac = process.platform === "darwin";
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    icon: APP_ICON,
    backgroundColor: "#070707",
    autoHideMenuBar: process.platform !== "darwin",
    // macOS keeps inset traffic lights, Windows keeps its custom overlay,
    // and Linux uses the native desktop title bar and window controls.
    ...(isMac
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 16 } }
      : process.platform === "win32"
        ? {
            titleBarStyle: "hidden",
            // height MUST match the ChatView/GroupView header strip (px-5 py-3
            // around a 36px control row = 60). Windows draws the caption buttons
            // to fill the overlay, so anything shorter leaves a dead band under
            // them and anything taller overhangs the header.
            titleBarOverlay: { color: "#070707", symbolColor: "#b5b5b5", height: 60 },
          }
        : {}),
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Packaged CI smoke hook. It validates the real renderer/preload bridge and
  // same-origin embedded server, then follows the normal window-close path.
  // No debugging port or sandbox override is needed.
  if (smokeMode) {
    win.webContents.once("did-finish-load", async () => {
      try {
        const result = await win.webContents.executeJavaScript(`
          (async () => {
            if (!window.ogb?.getCapabilities) throw new Error("desktop preload bridge is unavailable");
            const [capabilities, healthResponse] = await Promise.all([
              window.ogb.getCapabilities(),
              fetch("/api/health"),
            ]);
            if (!healthResponse.ok) {
              throw new Error(\`health request failed: \${healthResponse.status} \${healthResponse.statusText}\`);
            }
            const health = await healthResponse.json();
            const sessionResponse = await fetch("/api/session");
            if (!sessionResponse.ok) throw new Error("local desktop session is unavailable");
            const { token } = await sessionResponse.json();
            const companyResponse = await fetch("/api/company/status", { headers: { "x-realbud-session": token } });
            if (!companyResponse.ok) throw new Error("company setup status is unavailable");
            const company = await companyResponse.json();
            if (company.remoteJoinAvailable !== true) throw new Error("fresh installed desktop cannot join a company host");
            return { capabilities, health, company: { remoteJoinAvailable: company.remoteJoinAvailable, configured: company.configured }, location: window.location.href, title: document.title };
          })()
        `);
        const expectedLocation = `http://127.0.0.1:${SERVER_PORT}/`;
        if (result.location !== expectedLocation) {
          throw new Error(
            `unexpected packaged renderer URL: ${result.location} (expected ${expectedLocation})`,
          );
        }
        const payload = { ok: true, result };
        writeSmokeResult(payload);
        console.log(`[smoke] renderer-ready ${JSON.stringify(result)}`);
      } catch (error) {
        const message = error?.stack ?? String(error);
        writeSmokeResult({ ok: false, error: message });
        console.error(`[smoke] renderer-failed ${message}`);
      } finally {
        win.close();
        if (smokeMode) app.quit();
      }
    });
  }

  if (app.isPackaged) {
    win.loadURL(serverReady ? `http://127.0.0.1:${SERVER_PORT}` : ERROR_PAGE);
  } else {
    win.loadURL(DEV_URL);
  }
  return win;
}

// "This Mac" screen preview — served from the main process so the Screen
// Recording permission prompt attributes to the app, never the server
ipcMain.handle("screen:frame", async () => {
  if (process.platform !== "darwin") return null;
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 1280, height: 800 },
  });
  return sources[0]?.thumbnail.toDataURL() ?? null;
});

// Onboarding permission checks. Status reads are free; the mic request
// pops the real TCC prompt attributed to the app.
//
// Screen Recording deliberately has NO request path here. On macOS 15+
// every pre-grant mechanism is broken: getMediaAccessStatus("screen")
// wraps CGPreflightScreenCaptureAccess, which caches per-process (stays
// "denied" for the whole session after the user grants); a helper child
// binary gets TCC-attributed to ITSELF on macOS 26, not the app, and
// plain executables no longer appear in the Settings pane at all; and
// Sequoia+ re-prompts periodically regardless, so a pre-grant expires.
// The one reliable path is the first real in-process capture
// (screen:frame above / getDisplayMedia via the handler below) — macOS
// prompts then, attributed correctly, at the moment of actual use. The
// perm:open-settings deep link stays as the repair path for denials.
// Copy the engine command, then open a blank terminal. Renderer-controlled
// text must never become a process argument: the user reviews and pastes it.
// Returns false when the renderer should show the clipboard fallback.
ipcMain.handle("engine:open-terminal", async (_event, command) => {
  if (typeof command !== "string" || !command.trim()) return false;
  clipboard.writeText(command);
  return openBlankTerminal();
});

// Server-issued connection links arrive after an async broker call, so they
// cannot rely on a browser popup's user-gesture timing. Keep the bridge
// narrow: only HTTPS links can leave the app.
ipcMain.handle("external:open", async (_event, rawUrl) => {
  try {
    const url = new URL(String(rawUrl));
    if (url.protocol !== "https:") return false;
    await shell.openExternal(url.toString());
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle("perm:status", () => {
  if (process.platform === "darwin" || process.platform === "win32") {
    return {
      mic: systemPreferences.getMediaAccessStatus?.("microphone") ?? "unknown",
    };
  }
  return { mic: "unsupported" };
});
ipcMain.handle("perm:request-mic", async () => {
  if (process.platform === "darwin") {
    try {
      return await systemPreferences.askForMediaAccess("microphone");
    } catch {
      return false;
    }
  }
  if (process.platform === "win32") {
    const status = systemPreferences.getMediaAccessStatus?.("microphone") ?? "unknown";
    // Windows has no askForMediaAccess; the speech helper triggers the OS
    // prompt on first capture. Only hard-deny here when already blocked.
    return status !== "denied" && status !== "restricted";
  }
  return false;
});

// Denied permissions only reopen from System Settings / Windows Settings.
ipcMain.handle("perm:open-settings", async (_event, pane) => {
  const candidates = privacySettingsUrls(process.platform, pane);
  if (!candidates.length) return false;
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  for (const url of candidates) {
    if (process.platform === "darwin") {
      try {
        await execFileAsync("/usr/bin/open", [url]);
        return true;
      } catch {
        /* try shell next */
      }
    } else if (process.platform === "win32") {
      try {
        await execFileAsync("cmd", ["/c", "start", "", url], { windowsHide: true });
        return true;
      } catch {
        /* try shell next */
      }
    }
    try {
      await shell.openExternal(url);
      return true;
    } catch {
      /* try next scheme */
    }
  }
  return false;
});

ipcMain.handle("speech:start", (event, options) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (!speechSupported()) {
    win.webContents.send("speech:end", { code: 2, reason: "unsupported-platform" });
    return;
  }
  startSpeech(win, options);
});
ipcMain.handle("speech:stop", () => {
  if (speechSupported()) stopSpeech();
});
ipcMain.handle("speech:finish", () => {
  if (speechSupported()) finishSpeech();
});

ipcMain.handle("desktop:capabilities", async () =>
  desktopCapabilities({
    platform: process.platform,
    env: process.env,
    packaged: app.isPackaged,
    localConnection: currentCuaConnection() ?? await cuaReady,
  }),
);

// Service lifecycle for the renderer. This is intentionally IPC rather than an
// HTTP route: when the service is not running it cannot answer /api/*, so the
// only truthful source for "is my office running" is this process.
//
// Three distinct facts are reported, because they mean different things to
// staff: whether the office service is answering at all, whether this app
// adopted a service that was already running, and whether the app started one it
// can stop.
const unmanagedStatus = () => ({ state: "unmanaged", restarts: 0, lastExitCode: null, exhausted: false });

async function officeServiceStatus() {
  const dataDirectory = realbudDataDir();
  const identity = serviceIdentity(dataDirectory);
  const running = await findRunningService(identity);
  const handle = serviceHandle ?? readServiceHandle(dataDirectory, identity.instanceId);
  const manageable = Boolean(handle && running && handle.port === running.port && processAlive(handle.pid));
  return {
    ...(serverSupervisor?.getStatus() ?? unmanagedStatus()),
    // The office service is answering.
    running: Boolean(running),
    port: running?.port ?? null,
    // It was already running when this app launched.
    adopted: serviceAdopted,
    // This app started it in this or an earlier session, so it can stop it.
    manageable,
    // Running but not started by this installation's app: report it, do not own it.
    external: Boolean(running) && !manageable,
  };
}

ipcMain.handle("service:status", officeServiceStatus);
ipcMain.handle("service:retry", async () => {
  if (!app.isPackaged) return { ok: false, status: await officeServiceStatus() };
  const before = await findRunningService(serviceIdentity(realbudDataDir()));
  if (before) return { ok: true, status: await officeServiceStatus() };
  const ok = await startOrAdoptOfficeService();
  return { ok, status: await officeServiceStatus() };
});
// Explicitly stop the office service. Closing the window never does this.
ipcMain.handle("service:stop", async () => {
  const dataDirectory = realbudDataDir();
  const identity = serviceIdentity(dataDirectory);
  const handle = serviceHandle ?? readServiceHandle(dataDirectory, identity.instanceId);
  if (!handle || !processAlive(handle.pid)) {
    clearServiceHandle(dataDirectory);
    return { ok: false, status: await officeServiceStatus() };
  }
  try {
    process.kill(handle.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  // Wait for the port to be released so the next start is not racing a dying service.
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!(await findRunningService(identity))) {
      clearServiceHandle(dataDirectory);
      serverReady = false;
      return { ok: true, status: await officeServiceStatus() };
    }
  }
  return { ok: false, status: await officeServiceStatus() };
});
ipcMain.handle("service:start", async () => {
  if (!app.isPackaged) return { ok: false, status: await officeServiceStatus() };
  const ok = await startOrAdoptOfficeService();
  return { ok, status: await officeServiceStatus() };
});

/**
 * Adopt this installation's running office service, or start one detached.
 *
 * Adopting first is not an optimisation — it is the single-authority guard. A
 * service that outlives the app is still serving when RealBud relaunches, and
 * starting a second one would put two services on one company database.
 */
async function startOrAdoptOfficeService() {
  const dataDirectory = realbudDataDir();
  const identity = serviceIdentity(dataDirectory);

  const running = await findRunningService(identity);
  if (running) {
    SERVER_PORT = running.port;
    serverEverStarted = true;
    serviceAdopted = true;
    slog(`adopted the running office service on port ${running.port}`);
    return true;
  }

  const deskKey = deskKeyForChild();
  const entry = path.join(process.resourcesPath, "server", "index.js");
  const port = SERVER_PORT;
  let handle;
  try {
    handle = startDetachedService({
      entry,
      port,
      dataDirectory,
      instanceId: identity.instanceId,
      env: {
        ...process.env,
        OMB_STATIC_DIR: path.join(process.resourcesPath, "ui"),
        OMB_USER_DATA: app.getPath("userData"),
        REALBUD_MANAGED_SERVICE: "1",
        REALBUD_SERVICE_ENTITLEMENT_REQUIRED: "1",
        REALBUD_HERMES_HOME: path.join(dataDirectory, "hermes"),
        HERMES_HOME: path.join(dataDirectory, "hermes"),
        ...(deskKey.hex ? { REALBUD_DESK_KEY: deskKey.hex } : {}),
        ...(deskKey.production ? { REALBUD_PRODUCTION: "1" } : {}),
      },
    });
  } catch (error) {
    slog(`detached service start failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  serviceHandle = handle;

  // Wait for the service we just started to answer. Identity is the pid we
  // spawned, so a stranger holding the port is not mistaken for our service.
  for (let attempt = 0; attempt < 40; attempt++) {
    const probe = await probeService(port);
    const health = probe?.body ?? null;
    if (health && health.app === "realbud" && health.static === true && health.pid === handle.pid) {
      serverEverStarted = true;
      slog(`started the office service detached on port ${port} pid=${handle.pid}`);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  slog(`the detached office service did not answer on port ${port}`);
  return false;
}

app.whenReady().then(async () => {
  if (process.platform === "darwin") app.dock.setIcon(APP_ICON);
  // getDisplayMedia in the renderer → this handler → ScreenCaptureKit, all
  // inside the app's own processes — the one capture path macOS reliably
  // attributes to the app (registers it in the Screen Recording pane and
  // prompts). Used by the onboarding "Enable screen preview" button.
  if (process.platform === "darwin") {
    session.defaultSession.setDisplayMediaRequestHandler(
      (_request, callback) => {
        desktopCapturer
          .getSources({ types: ["screen"] })
          .then((sources) => callback(sources[0] ? { video: sources[0] } : {}))
          .catch(() => callback({}));
      },
      { useSystemPicker: false },
    );
  }
  registerCuaIpc();
  cuaControl = await startCuaControl({ release: releaseCuaForHuman, verify: verifyCuaAfterHuman, restore: restoreCuaAfterHuman });
  registerUpdaterIpc();
  // Start the CUA daemon before the window so the harness can pick up the
  // connection descriptor on first render. Never blocks window creation on
  // failure — computer use degrades to "unavailable", the rest still works.
  cuaReady =
    (process.platform === "darwin" || process.platform === "win32")
      ? startCua().catch((e) => {
          console.error("[cua] start failed:", e);
          return { mode: "unavailable", reason: String(e) };
        })
      : Promise.resolve({ mode: "unavailable", reason: "unsupported-platform" });
  // The office service must outlive this window: quitting RealBud must not take
  // the company database, the clock and every peer's connection with it.
  //
  // Order matters. First ADOPT a service already running for this installation —
  // otherwise a relaunch would fork a second one beside it, and two services on
  // one company database is the worst outcome in this design. Only when nothing
  // of ours is serving do we start one, as a DETACHED process so it is not tied
  // to this app's lifetime.
  //
  // The supervisor therefore only manages a service this app instance started in
  // development (a `utilityProcess` child). A detached office service is managed
  // through the explicit controls on You, not by quitting the window.
  serverSupervisor = createServerSupervisor({
    start: async () => {
      const bootPort = SERVER_PORT;
      const ok = await startServerPackaged({ onlyPort: serverEverStarted ? bootPort : null });
      if (!ok || !serverProc) return null;
      serverEverStarted = true;
      const proc = serverProc;
      proc.once("exit", (code) => {
        if (serverProc === proc) serverProc = null;
        serverSupervisor?.notifyExit(code ?? null);
      });
      return proc;
    },
    kill: (proc) => { try { proc?.kill(); } catch { /* already gone */ } },
    onStatus: (status) => slog(`service ${status.state} restarts=${status.restarts}${status.lastExitCode === null ? "" : ` exit=${status.lastExitCode}`}`),
  });
  if (app.isPackaged) {
    serverReady = await startOrAdoptOfficeService();
  }
  const win = createWindow();
  // in-app auto-update (packaged only) — checks GitHub releases, downloads on
  // the user's click, installs on "Restart to update"
  startUpdater(win);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Defer final quit for bounded helper cleanup, after every window accepts close.
registerDesktopShutdown(app, {
  // Stop supervision, which only ever owned a development child. The office
  // service deliberately keeps running: quitting the window must not take the
  // company database, the clock and every peer's connection with it. Stopping it
  // is an explicit action on You ("Stop the office service").
  stopServer: async () => { await serverSupervisor?.stop(); serverProc = null; },
  stopSpeech,
  closeControl: () => cuaControl?.close(),
  stopComputer: stopCua,
});
