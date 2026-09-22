import { registerDesktopShutdown } from "./shutdown.mjs";
import { createServerSupervisor } from "./server-supervisor.mjs";
import { findRunningService, probeService, serviceIdentity } from "./service-instance.mjs";
import { abandonSpawnedService, availableServicePort, clearServiceHandle, ownsRunningService, requestServiceStop, readServiceHandle, SERVICE_WAIT_INTERVAL_MS, serviceWaitTicks, shouldRestartServiceWait, shouldStartService, spawnedServiceState, startDetachedService, systemBootedAt } from "./service-lifecycle.mjs";
import { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, powerMonitor, powerSaveBlocker, safeStorage, session, shell, systemPreferences, utilityProcess } from "electron";
import { SERVICE_MODE_FLAG, keepAwakeDecision, parseServiceModeArgs, planStartupRegistration, startupRegistrationSupport } from "./service-persistence.mjs";
import { resolveDeskKey } from "./desk-key-custody.mjs";
import { configureLogDirectory } from "./log-directory.mjs";
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
const {
  mergeDesktopSettings,
  privacySettingsUrls,
  readDesktopSettings,
  readScheduleFact,
  serializeDesktopSettings,
  serializeScheduleFact,
} = require("./perm-settings.cjs");
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
// The login item (when the customer turns it on) launches this same binary with
// --service: no window, just a host that starts or adopts the office service and
// keeps it company. See electron/service-persistence.mjs for what that does and
// does not promise.
const serviceMode = parseServiceModeArgs(process.argv);
if (!smokeMode && !app.requestSingleInstanceLock()) {
  app.quit();
} else if (!smokeMode) {
  app.on("second-instance", (_event, argv) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      return;
    }
    // No window to focus: this process is the headless service host the login
    // item started, and someone has just opened RealBud. Holding the lock must
    // not make their double-click do nothing — and both processes deciding to
    // start a service would put two of them on one company database. So hand
    // the lock over: relaunch as an ordinary window and quit. The office
    // service is detached, so it keeps serving across the swap.
    if (serviceMode && !parseServiceModeArgs(argv)) {
      slog("a window launch arrived while running as the sign-in service host; handing over");
      app.relaunch({ args: [] });
      app.quit();
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
// A port an abandoned child of ours may still hold. Remembered across start
// attempts so a later retry cannot scan past it while it is still dying.
let abandonedServicePort = null;

// The packaged app has no terminal: everything about the server child's life
// goes to server.log in the OS log dir (~/Library/Logs/RealBud on macOS,
// Console.app-visible; %APPDATA%\RealBud\logs on Windows), which is also
// why stdio is piped, not inherited — under a Finder/Explorer launch the
// parent's stdio leads nowhere and a failed boot is otherwise undiagnosable.
const LOG_DIR = configureLogDirectory(app);
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

/** The key selector preserves recovery evidence and refuses missing custody. */
function deskKeyForChild() {
  return resolveDeskKey({ directory: realbudDataDir(), safeStorage, environmentKey: process.env.REALBUD_DESK_KEY, smoke: smokeMode });
}

async function startServerOn(port) {
  const entry = path.join(process.resourcesPath, "server", "bootstrap.js");
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
    `<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#070707;color:#fcfcfc;font:15px -apple-system,system-ui"><div style="text-align:center;max-width:380px"><div style="font-size:40px">🏠</div><h2 style="font-weight:600;margin:12px 0 6px">Waiting for the office service</h2><p style="color:#fcfcfc99;line-height:1.5">RealBud keeps checking for the office service for the next few minutes and opens the desk as soon as it answers. A first start can be slow while the company database opens.</p><p style="color:#fcfcfc99;line-height:1.5">If this page stays, reopen RealBud, or ask your administrator to check its service log and saved workspace key. Keep the existing workspace files for recovery — they are what the office is restored from.</p></div></body>`,
  );

// Shown when the bounded wait above runs out. A page that still promises to keep
// checking after it has stopped checking is worse than no page: staff wait for
// something that is never going to happen.
const WAIT_ENDED_PAGE =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    `<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#070707;color:#fcfcfc;font:15px -apple-system,system-ui"><div style="text-align:center;max-width:380px"><div style="font-size:40px">🏠</div><h2 style="font-weight:600;margin:12px 0 6px">The office service did not start</h2><p style="color:#fcfcfc99;line-height:1.5">RealBud has stopped checking. Reopen RealBud to try again, or ask your administrator to check its service log and saved workspace key.</p><p style="color:#fcfcfc99;line-height:1.5">Keep the existing workspace files for recovery — they are what the office is restored from. Nothing has been lost by this.</p></div></body>`,
  );

let cuaReady = Promise.resolve({ mode: "unavailable", reason: "not-started" });
let cuaControl;

/** Wait for a promise to settle, but never longer than `ms`. Returns whether it
 * settled in time; a rejection counts as settled, because the point is only that
 * the work is no longer in flight. */
async function settledWithin(promise, ms, what) {
  let timer;
  const expiry = new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  try {
    const settled = await Promise.race([Promise.resolve(promise).then(() => true, () => true), expiry]);
    if (!settled) slog(`${what} did not finish within ${ms}ms; continuing without it`);
    return settled;
  } finally {
    clearTimeout(timer);
  }
}

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
        // Let computer use finish starting before asking the app to quit.
        //
        // `startCua()` is deliberately not awaited at startup so a slow or broken
        // driver cannot delay the window. The shutdown hook's `stopCua()` only
        // sees a host once that start has ASSIGNED one, so a start still in
        // flight is invisible to it: the host then finishes after cleanup, and
        // nothing ever stops it or the daemon it spawns. The window opens before
        // the driver is ready often enough — a cold first launch of a freshly
        // signed bundle — that the clean-exit proof cannot be left to that race.
        // Smoke mode owns its own shutdown ordering, so it waits here. Bounded,
        // because a driver that never settles must still not hang the smoke.
        await settledWithin(cuaReady, 10_000, "computer use start");
        if (smokeMode && serviceHandle) {
          await requestServiceStop(serviceHandle, serviceIdentity(realbudDataDir()));
        }
        win.close();
        if (smokeMode) app.quit();
      }
    });
  }

  if (app.isPackaged) {
    // A slow-but-successful start used to leave staff on a dead page until they
    // quit: the service answered a few seconds after the window gave up, and
    // nothing ever looked again. So the recovery page is a WAIT, not a verdict —
    // bounded, because a wait that never ends hides a service that is not coming
    // back. The decision logic lives in service-lifecycle.mjs, where it can be
    // tested; the window only carries it out.
    let waitTimer = null;
    let lastRestartAt = null;
    const stopWait = () => {
      if (waitTimer) clearTimeout(waitTimer);
      waitTimer = null;
    };
    const waitForOfficeService = () => {
      if (waitTimer || win.isDestroyed()) return;
      let remaining = serviceWaitTicks();
      const look = async () => {
        waitTimer = null;
        if (win.isDestroyed()) return;
        let found = null;
        try {
          found = await findRunningService(serviceIdentity(realbudDataDir()));
        } catch {
          found = null;
        }
        if (win.isDestroyed()) return;
        if (found) {
          SERVER_PORT = found.port;
          serverReady = true;
          serverEverStarted = true;
          slog(`the office service answered on port ${found.port}; opening the desk`);
          win.loadURL(`http://127.0.0.1:${found.port}`);
          return;
        }
        if (--remaining <= 0) {
          slog("stopped waiting for the office service; showing the give-up page");
          win.loadURL(WAIT_ENDED_PAGE);
          return;
        }
        waitTimer = setTimeout(look, SERVICE_WAIT_INTERVAL_MS);
      };
      waitTimer = setTimeout(look, SERVICE_WAIT_INTERVAL_MS);
    };
    // Closing the window must not leave a timer polling a service nobody is
    // watching. The office service itself deliberately keeps running.
    win.on("closed", stopWait);
    // A service that dies while the desk is open drops the renderer to a browser
    // error page with no way back. Treat that as the same wait.
    win.webContents.on("did-fail-load", (_event, errorCode, _description, failedUrl, isMainFrame) => {
      // A load can fail as the window is going away (the smoke stops the service
      // before closing). `loadURL` on a destroyed window throws, and an uncaught
      // throw here would land in the middle of the quit sequence.
      if (win.isDestroyed()) return;
      const restart = shouldRestartServiceWait({
        mainFrame: isMainFrame,
        errorCode,
        url: typeof failedUrl === "string" ? failedUrl : "",
        appOrigin: `http://127.0.0.1:${SERVER_PORT}`,
        waiting: waitTimer !== null,
        lastRestartAt,
        now: Date.now(),
      });
      if (!restart) return;
      lastRestartAt = Date.now();
      serverReady = false;
      slog(`the desk failed to load (${errorCode} ${failedUrl}); waiting for the office service`);
      win.loadURL(ERROR_PAGE);
      waitForOfficeService();
    });
    if (serverReady) {
      win.loadURL(`http://127.0.0.1:${SERVER_PORT}`);
    } else {
      win.loadURL(ERROR_PAGE);
      waitForOfficeService();
    }
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
  const manageable = ownsRunningService(handle, running, identity);
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
  if (before) {
    // Already answering. Record the port, so a window created after this (macOS
    // re-activate) loads the app rather than the recovery page.
    SERVER_PORT = before.port;
    serverEverStarted = true;
    serverReady = true;
    return { ok: true, status: await officeServiceStatus() };
  }
  const ok = await startOrAdoptOfficeService();
  if (ok) serverReady = true;
  return { ok, status: await officeServiceStatus() };
});
// Explicitly stop the office service. Closing the window never does this.
ipcMain.handle("service:stop", async () => {
  const dataDirectory = realbudDataDir();
  const identity = serviceIdentity(dataDirectory);
  const handle = serviceHandle ?? readServiceHandle(dataDirectory, identity.instanceId);
  if (!await requestServiceStop(handle, identity)) {
    return { ok: false, status: await officeServiceStatus() };
  }
  // Wait for the port to be released so the next start is not racing a dying service.
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!(await findRunningService(identity))) {
      clearServiceHandle(dataDirectory);
      serviceHandle = null;
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

// ---------------------------------------------------------------------------
// Help and support: one plain-text file the person saves where they choose.
//
// The renderer gets neither a path nor the contents, only the outcome. Only the
// office service runs RealBud's redactor, so the tail of server.log is posted
// to it with a session this process fetches itself, from the service whose
// identity matches this data directory, and the masked report it returns is
// what gets saved. When the office service does not answer, nothing can mask
// its [out]/[err] output, so the file keeps only lines this process wrote
// itself, and drops any of those that carry a key-like word or a long
// token-shaped run; everything left out is counted, never silently lost.
const SUPPORT_DESKTOP_LOG_BYTES = 192 * 1024;
const SUPPORT_REPORT_MAX_BYTES = 512 * 1024;
const SUPPORT_OWN_LINE = /^\[\d{4}-\d{2}-\d{2}T[0-9:.]+Z\] (?!\[out\]|\[err\])/;
const SUPPORT_UNSAFE_LINE = /[A-Za-z0-9_+=-]{20,}|token|secret|passw|bearer|authori[sz]|api[_-]?key|private key|cookie|credential/i;
let supportSaveInFlight = false;

function desktopLogTail() {
  let fd = null;
  try {
    const file = path.join(LOG_DIR, "server.log");
    if (!fs.lstatSync(file).isFile()) return "";
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, SUPPORT_DESKTOP_LOG_BYTES);
    const buffer = Buffer.alloc(length);
    const text = buffer.subarray(0, fs.readSync(fd, buffer, 0, length, size - length)).toString("utf8");
    if (length === size) return text;
    // A tail that starts mid-line can start mid-secret; drop that partial line.
    const cut = text.indexOf("\n");
    return cut === -1 ? "" : text.slice(cut + 1);
  } catch {
    return "";
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

async function officeSupportReport(desktopLog) {
  const running = await findRunningService(serviceIdentity(realbudDataDir())).catch(() => null);
  if (!running) return null;
  const base = `http://127.0.0.1:${running.port}`;
  try {
    const sessionResponse = await fetch(`${base}/api/session`, { signal: AbortSignal.timeout(5_000) });
    const token = sessionResponse.ok ? (await sessionResponse.json().catch(() => null))?.token : null;
    if (typeof token !== "string" || !token) return null;
    const response = await fetch(`${base}/api/support/bundle`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-realbud-session": token },
      body: JSON.stringify({ desktopLog }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const report = await response.text();
    return report.startsWith("RealBud support file\n") && Buffer.byteLength(report, "utf8") <= SUPPORT_REPORT_MAX_BYTES ? report : null;
  } catch {
    return null;
  }
}

function desktopOnlySupportReport(desktopLog) {
  const kept = [];
  let omitted = 0;
  for (const line of desktopLog.split(/\r?\n/)) {
    if (!line) continue;
    if (SUPPORT_OWN_LINE.test(line) && !SUPPORT_UNSAFE_LINE.test(line) && line.length <= 2_000) kept.push(line);
    else omitted++;
  }
  return [
    "RealBud support file",
    `Created: ${new Date().toISOString()}`,
    `RealBud version: ${app.getVersion()}`,
    `System: ${process.platform} ${process.arch} ${process.getSystemVersion?.() ?? ""}`.trimEnd(),
    "Office service: did not answer, so its log is not included.",
    "",
    "Contains: RealBud's version, this computer's system type and the desktop app's own recent log lines. Documents, mail, saved credentials and business records are never read for this file.",
    "",
    "== Desktop app log (server.log) ==",
    ...(omitted ? [`[${omitted} lines were left out because only the office service can check them for keys and passwords.]`] : []),
    ...kept,
    "",
  ].join("\n");
}

ipcMain.handle("support:save", async (event) => {
  if (supportSaveInFlight) return { ok: false, error: "A support file is already being saved." };
  supportSaveInFlight = true;
  try {
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const options = {
      title: "Save support file",
      defaultPath: path.join(app.getPath("downloads"), `realbud-support-${day}.txt`),
      filters: [{ name: "Text", extensions: ["txt"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    };
    const owner = BrowserWindow.fromWebContents(event.sender);
    const choice = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
    if (choice.canceled || !choice.filePath) return { ok: false, canceled: true };
    const desktopLog = desktopLogTail();
    const office = await officeSupportReport(desktopLog);
    const report = office ?? desktopOnlySupportReport(desktopLog);
    // Only a file this call opened is removed after a failed write, so a
    // partial report is never left looking complete and nothing else is touched.
    const handle = await fs.promises.open(choice.filePath, "w", 0o600);
    try {
      await handle.writeFile(report, "utf8");
      await handle.close();
    } catch (error) {
      await handle.close().catch(() => {});
      await fs.promises.unlink(choice.filePath).catch(() => {});
      throw error;
    }
    slog(`saved a support file (${office ? "with" : "without"} the office service report)`);
    return { ok: true, officeReport: office !== null };
  } catch (error) {
    const code = error?.code;
    slog(`the support file could not be saved: ${typeof code === "string" ? code : "error"}`);
    return {
      ok: false,
      error: code === "ENOSPC" || code === "EDQUOT"
        ? "This computer is out of disk space. Free some space, then try again."
        : "The support file could not be saved. Try again, or choose another folder.",
    };
  } finally {
    supportSaveInFlight = false;
  }
});

// ---------------------------------------------------------------------------
// Being there for scheduled work.
//
// A detached office service outlives the window but not a sign-out, and nothing
// kept this computer awake to reach a scheduled time. Two settings, both off
// until the customer asks: start the service after they sign in, and hold this
// computer awake while there is scheduled work. The DECISIONS are pure and
// tested in service-persistence.mjs; this is the only place that touches the
// login item store and the power manager.
//
// What it still does not do, and what the interface says: a sign-in is not a
// power-on, and nothing here survives a closed lid or a shutdown. A missed
// occurrence must stay visible on the schedule instead.
const desktopSettingsPath = () => path.join(app.getPath("userData"), "desktop-settings.json");
const scheduleFactPath = () => path.join(app.getPath("userData"), "schedule-fact.json");

let desktopSettings = null;
// A file we could not read is not a customer who never asked for anything. The
// defaults still apply in memory (nothing is held, nothing is claimed), but the
// login item already registered on this computer is left alone rather than
// removed to match a value we failed to read.
let desktopSettingsUnreadable = false;
function loadDesktopSettings() {
  if (desktopSettings) return desktopSettings;
  let raw = null;
  try { raw = fs.readFileSync(desktopSettingsPath(), "utf8"); }
  catch (error) {
    if (error?.code !== "ENOENT") {
      desktopSettingsUnreadable = true;
      slog(`desktop settings could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  desktopSettings = readDesktopSettings(raw);
  return desktopSettings;
}

/** Persist a settings patch. Reports whether it reached disk: a setting that
 * could not be saved must not be shown as saved, because the next launch will
 * read the old value and undo the OS registration to match it. */
function saveDesktopSettings(patch) {
  const current = loadDesktopSettings();
  const next = mergeDesktopSettings(current, patch);
  desktopSettings = next;
  if (next.startOfficeServiceAtLogin === current.startOfficeServiceAtLogin
    && next.keepAwakeForSchedules === current.keepAwakeForSchedules) {
    // Nothing to write — unless the stored file could not be read in the first
    // place, in which case "unchanged" is not the same as "on disk".
    return { settings: next, saved: !desktopSettingsUnreadable };
  }
  try {
    const file = desktopSettingsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, serializeDesktopSettings(next));
    // The file is now what the customer just chose, so it is safe to act on again.
    desktopSettingsUnreadable = false;
    slog(`desktop settings saved: login=${next.startOfficeServiceAtLogin} keepAwake=${next.keepAwakeForSchedules}`);
    return { settings: next, saved: true };
  } catch (error) {
    slog(`desktop settings could not be saved: ${error instanceof Error ? error.message : String(error)}`);
    return { settings: next, saved: false };
  }
}

// The office's schedule belongs to the office: a window reads it from the same
// API the Schedule screen uses and reports it here, rather than main opening a
// second, differently-authenticated reader of the same fact. The last report is
// cached so a sign-in launch with no window can still tell whether there is
// anything to stay awake for.
let scheduleFact = null;
function loadScheduleFact() {
  if (scheduleFact) return scheduleFact;
  let raw = null;
  try { raw = fs.readFileSync(scheduleFactPath(), "utf8"); }
  catch { /* never reported yet: nothing to stay awake for */ }
  scheduleFact = readScheduleFact(raw);
  return scheduleFact;
}
function recordScheduleFact(scheduleEnabled) {
  // Same answer as last time: keep the stored report rather than rewriting the
  // file on every refresh a window makes.
  if (loadScheduleFact().scheduleEnabled === scheduleEnabled) return scheduleFact;
  scheduleFact = { scheduleEnabled, reportedAt: Date.now() };
  try {
    const file = scheduleFactPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, serializeScheduleFact(scheduleFact));
  } catch (error) {
    slog(`the reported schedule state could not be saved: ${error instanceof Error ? error.message : String(error)}`);
  }
  return scheduleFact;
}

/** Register or remove the login item, only from a packaged build and only when
 * the plan says something actually changes. Never throws: a login item that
 * cannot be written must not stop RealBud from opening. */
function applyStartupRegistration() {
  const support = startupRegistrationSupport({ platform: process.platform, packaged: app.isPackaged });
  if (!support.supported) return support;
  const settings = loadDesktopSettings();
  if (desktopSettingsUnreadable) {
    slog("leaving the sign-in start registration untouched: this computer's settings could not be read");
    return support;
  }
  try {
    const current = app.getLoginItemSettings({ args: [SERVICE_MODE_FLAG] })?.openAtLogin;
    const plan = planStartupRegistration({
      desired: settings.startOfficeServiceAtLogin,
      current,
      platform: process.platform,
      packaged: app.isPackaged,
    });
    if (plan) {
      app.setLoginItemSettings(plan);
      slog(`sign-in start ${plan.openAtLogin ? "registered" : "removed"}`);
    }
  } catch (error) {
    slog(`sign-in start could not be updated: ${error instanceof Error ? error.message : String(error)}`);
  }
  return support;
}

let keepAwakeBlockerId = null;
function onBatteryPower() {
  try { return powerMonitor.isOnBatteryPower() === true; }
  catch { return false; }
}

/** Hold or release the power blocker to match the current decision. Only
 * prevent-app-suspension: the screen is never kept alight. */
function applyKeepAwake() {
  const decision = keepAwakeDecision({
    optedIn: loadDesktopSettings().keepAwakeForSchedules,
    scheduleEnabled: loadScheduleFact().scheduleEnabled,
    onBattery: onBatteryPower(),
  });
  try {
    if (decision.hold && keepAwakeBlockerId === null) {
      keepAwakeBlockerId = powerSaveBlocker.start(decision.type);
      slog(`holding this computer awake for scheduled work (${decision.type})`);
    } else if (!decision.hold && keepAwakeBlockerId !== null) {
      powerSaveBlocker.stop(keepAwakeBlockerId);
      keepAwakeBlockerId = null;
      slog(`released the keep-awake hold (${decision.state})`);
    }
  } catch (error) {
    keepAwakeBlockerId = null;
    slog(`keep-awake could not be changed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return decision;
}

function releaseKeepAwake() {
  if (keepAwakeBlockerId === null) return;
  try { powerSaveBlocker.stop(keepAwakeBlockerId); }
  catch { /* the process is going away anyway */ }
  keepAwakeBlockerId = null;
}

function servicePersistenceState() {
  const settings = loadDesktopSettings();
  const startup = startupRegistrationSupport({ platform: process.platform, packaged: app.isPackaged });
  const fact = loadScheduleFact();
  const keepAwake = keepAwakeDecision({
    optedIn: settings.keepAwakeForSchedules,
    scheduleEnabled: fact.scheduleEnabled,
    onBattery: onBatteryPower(),
  });
  return {
    settings,
    startup: { supported: startup.supported, reason: startup.reason, explanation: startup.explanation },
    // `holding` is what is actually held right now, not what was decided: the
    // power manager can refuse, and the card must not claim a hold that failed.
    keepAwake: { holding: keepAwakeBlockerId !== null, state: keepAwake.state, explanation: keepAwake.explanation },
    scheduleEnabled: fact.scheduleEnabled,
  };
}

/** Both settings, what they can do on this build, and what is held right now. */
ipcMain.handle("service:persistence:get", () => servicePersistenceState());
ipcMain.handle("service:persistence:set", (_event, patch) => {
  const request = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
  // scheduleEnabled is a report, not a setting: it never becomes consent.
  if (typeof request.scheduleEnabled === "boolean") recordScheduleFact(request.scheduleEnabled);
  const { saved } = saveDesktopSettings(request);
  applyStartupRegistration();
  applyKeepAwake();
  return { ...servicePersistenceState(), saved };
});

/** Read the settings once the app is ready, apply them, and follow the power
 * source: unplugging is exactly when an unattended hold should be let go. */
function startServicePersistence() {
  loadDesktopSettings();
  loadScheduleFact();
  applyStartupRegistration();
  try {
    powerMonitor.on("on-ac", () => { applyKeepAwake(); });
    powerMonitor.on("on-battery", () => { applyKeepAwake(); });
  } catch { /* power-source events are a refinement; the setting still applies */ }
  applyKeepAwake();
}

/**
 * The headless sign-in launch: no window, no computer use, no updater — start or
 * adopt the office service through the same single-authority path a window uses,
 * then stay only as long as it is serving.
 */
const SERVICE_HOST_POLL_MS = 15_000;
let serviceHostWatch = null;
async function runServiceHost() {
  if (process.platform === "darwin") { try { app.dock?.hide(); } catch { /* no dock */ } }
  if (!app.isPackaged) {
    // A development build has no server in resourcesPath to start, and its login
    // item is never registered in the first place.
    slog("service mode is only meaningful in an installed build; exiting");
    app.quit();
    return;
  }
  startServicePersistence();
  let ok = false;
  try { ok = await startOrAdoptOfficeService(); }
  catch (error) { slog(`service mode could not start the office service: ${error instanceof Error ? error.message : String(error)}`); }
  if (!ok) {
    slog("service mode: no office service is running and one could not be started; exiting");
    app.quit();
    return;
  }
  // Exit when the office stops. An invisible process that outlives the thing it
  // was hosting is worse than no process: it holds the single-instance lock and
  // whatever the power manager gave it, while hosting nothing.
  const identity = serviceIdentity(realbudDataDir());
  serviceHostWatch = setInterval(() => {
    void (async () => {
      if (await findRunningService(identity)) return;
      slog("the office service has stopped; the sign-in service host is exiting");
      if (serviceHostWatch) { clearInterval(serviceHostWatch); serviceHostWatch = null; }
      app.quit();
    })();
  }, SERVICE_HOST_POLL_MS);
}

/**
 * Adopt this installation's running office service, or start one detached.
 *
 * Adopting first is not an optimisation — it is the single-authority guard. A
 * service that outlives the app is still serving when RealBud relaunches, and
 * starting a second one would put two services on one company database.
 */
let serviceStart = null;
function startOrAdoptOfficeService() {
  if (serviceStart) return serviceStart;
  serviceStart = startOrAdoptOfficeServiceOnce().finally(() => { serviceStart = null; });
  return serviceStart;
}
async function startOrAdoptOfficeServiceOnce() {
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

  // Nothing of ours ANSWERED. That is not the same as nothing of ours EXISTING,
  // and the difference is the whole guard: a service still opening the company
  // database holds its port without publishing health, so choosing a port now
  // would skip it and put a SECOND service on the same database.
  //
  // First settle a child THIS session spawned and never heard from.
  if (serviceHandle) {
    const state = spawnedServiceState(serviceHandle);
    if (state === "running") {
      // One more look at its own port: it may have finished opening the book
      // between the timeout and now.
      const late = await probeService(serviceHandle.port);
      if (ownsRunningService(serviceHandle, late, identity)) {
        SERVER_PORT = serviceHandle.port;
        serverEverStarted = true;
        slog(`the office service this session started answered late on port ${serviceHandle.port}`);
        return true;
      }
      const abandonedPort = serviceHandle.port;
      const abandonedPid = serviceHandle.pid;
      const killed = abandonSpawnedService(serviceHandle, dataDirectory);
      slog(
        `abandoned the silent office service this session started (port ${abandonedPort} pid=${abandonedPid}, stop ${killed ? "sent" : "not possible"}) rather than start a second one beside it`,
      );
      serviceHandle = null;
      // Wait for the abandoned child to release its port, for the same reason
      // "Stop the office service" waits: until it does, it may still be holding
      // the company database open. Closing Postgres can take longer than a
      // couple of seconds, so this is bounded at ten.
      let released = false;
      for (let settle = 0; settle < 40; settle++) {
        if ((await availableServicePort([abandonedPort])) !== null) { released = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      // Still held: STOP. Scanning on would skip this port and start a second
      // service over the same data directory — the exact outcome this whole path
      // exists to prevent. The window's bounded wait, or a later retry, picks it
      // up once the port is actually free.
      if (!released) {
        slog(`the abandoned office service (port ${abandonedPort} pid=${abandonedPid}) still holds its port; refusing to scan past it`);
        abandonedServicePort = abandonedPort;
        return false;
      }
    } else if (state === "exited") {
      clearServiceHandle(dataDirectory);
      slog(`the office service this session started (pid=${serviceHandle.pid}) has exited; starting a fresh one`);
      serviceHandle = null;
    }
  }

  // Then a handle recorded by an earlier session. A live pid still holding its
  // recorded port is a silent service of this installation; a live pid with a
  // free port is an unrelated process that reused the number, and a stale record
  // after a reboot must never brick the launch.
  if (!serviceHandle) {
    const recorded = readServiceHandle(dataDirectory, identity.instanceId);
    const recordedPortFree = recorded ? (await availableServicePort([recorded.port])) !== null : true;
    const decision = shouldStartService({ adopted: false, recorded, recordedPortFree, bootedAt: systemBootedAt() });
    if (!decision.start) {
      slog(`not starting an office service (${decision.reason}): pid=${recorded?.pid} still holds port ${recorded?.port}`);
      return false;
    }
    if (decision.reason === "recorded-before-boot") {
      // Written before this boot, so it cannot be a live service of ours: the
      // pid and the port belong to something else now. Forget it, or the next
      // launch reads the same record and hesitates again.
      clearServiceHandle(dataDirectory);
      slog(`discarded a pre-boot office service record (pid=${recorded?.pid} port=${recorded?.port}); it cannot be ours`);
    }
  }

  // A port abandoned on an earlier attempt stays off limits until it is free:
  // the child that held it may still be closing the company database.
  if (abandonedServicePort !== null) {
    if ((await availableServicePort([abandonedServicePort])) === null) {
      slog(`the abandoned office service still holds port ${abandonedServicePort}; not starting another beside it`);
      return false;
    }
    abandonedServicePort = null;
  }
  const port = await availableServicePort(serverEverStarted ? [SERVER_PORT] : identity.ports);
  if (port === null) { slog("no office service port is available"); return false; }
  SERVER_PORT = port;
  const deskKey = deskKeyForChild();
  const entry = path.join(process.resourcesPath, "server", "bootstrap.js");
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

  // Match this installation and process capability before adopting the child.
  for (let attempt = 0; attempt < 40; attempt++) {
    const probe = await probeService(port);
    if (ownsRunningService(handle, probe, identity)) {
      serverEverStarted = true;
      slog(`started the office service detached on port ${port} pid=${handle.pid}`);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  // Out of patience, not out of options. Keep the handle unless the child is
  // already gone: it is the ONLY thing that lets a later retry (or the window's
  // bounded wait) adopt this child or stop it, instead of forking a second
  // service over the same company database.
  if (spawnedServiceState(handle) === "exited") {
    clearServiceHandle(dataDirectory);
    serviceHandle = null;
    slog(`the detached office service on port ${port} exited during startup`);
  } else {
    slog(`the detached office service did not answer on port ${port} yet; keeping pid=${handle.pid} for retry`);
  }
  return false;
}

app.whenReady().then(async () => {
  // Started by the login item: host the office service, never a window.
  if (serviceMode) return runServiceHost();
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
    try { serverReady = await startOrAdoptOfficeService(); }
    catch (error) { serverReady = false; slog(`office service requires recovery: ${error instanceof Error ? error.message : String(error)}`); }
  }
  // After the service decision, because applying the settings reads the office's
  // last reported schedule state and must not delay the window.
  startServicePersistence();
  const win = createWindow();
  // in-app auto-update (packaged only) — checks GitHub releases, downloads on
  // the user's click, installs on "Restart to update"
  startUpdater(win);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // The sign-in service host never opened a window, so this cannot fire for it —
  // but if it ever did, closing a window must not end the host.
  if (!serviceMode && process.platform !== "darwin") app.quit();
});

// Defer final quit for bounded helper cleanup, after every window accepts close.
registerDesktopShutdown(app, {
  // Stop supervision, which only ever owned a development child. The office
  // service deliberately keeps running: quitting the window must not take the
  // company database, the clock and every peer's connection with it. Stopping it
  // is an explicit action on You ("Stop the office service").
  stopServer: async () => {
    await serverSupervisor?.stop();
    serverProc = null;
    // Give this computer its sleep settings back. The office service keeps
    // running, but nothing in this process should still be holding the machine
    // awake once the process is gone.
    releaseKeepAwake();
    if (serviceHostWatch) { clearInterval(serviceHostWatch); serviceHostWatch = null; }
  },
  stopSpeech,
  closeControl: () => cuaControl?.close(),
  // Wait for an in-flight computer-use start before stopping it. `stopCua()`
  // can only stop a host that has already been assigned, so quitting while the
  // driver is still starting used to leave the finished host and its daemon
  // running with nobody to stop them. The outer will-quit race still bounds
  // this, so a driver that never settles cannot hold the quit open.
  stopComputer: async () => {
    await settledWithin(cuaReady, 2_000, "computer use start");
    await stopCua();
  },
});
