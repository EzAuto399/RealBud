import { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, Notification, safeStorage, session, shell, systemPreferences, utilityProcess } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cuaRuntimeStatus, cuaWasEnabled, disableCua, enableCua, startCua, stopCua, registerCuaIpc } from "./cua.mjs";
import { finishSpeech, startSpeech, stopSpeech } from "./speech.mjs";
import { openBlankTerminal } from "./terminal-launch.mjs";
import { startUpdater, registerUpdaterIpc } from "./updater.mjs";
import capabilitiesModule from "./capabilities.cjs";
import routineRemindersModule from "./routine-reminders.cjs";
import secureStorageModule from "./secure-storage.cjs";
import packagedEnvironmentModule from "./packaged-environment.cjs";
import openHttpsModule from "./open-https.cjs";

const { desktopCapabilities, macPrivacySettingsUrl } = capabilitiesModule;
const { parseRoutineReminder, routineNotificationCopy } = routineRemindersModule;
const { prepareSecureRuntimeEnv } = secureStorageModule;
const { packagedServerEnvironment } = packagedEnvironmentModule;
const { openHttpsExternal } = openHttpsModule;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 127.0.0.1 explicitly — vite binds IPv4; a bare "localhost" here can
// resolve to ::1 and paint a black window
const DEV_URL = process.env.ELECTRON_START_URL ?? "http://127.0.0.1:5199";
let SERVER_PORT = 8799;
const APP_ICON = path.join(__dirname, "resources/app-icon.png");

// Package QA must never claim the real app's single-instance lock, Chromium
// profile, logs or session state. Both flags are required so production
// launches cannot redirect these paths through ambient environment alone.
if (process.env.OMB_SMOKE_TEST === "1" && process.env.REALBUD_USER_DATA_DIR) {
  const smokeUserData = path.resolve(process.env.REALBUD_USER_DATA_DIR);
  fs.mkdirSync(smokeUserData, { recursive: true });
  app.setPath("userData", smokeUserData);
  app.setPath("sessionData", path.join(smokeUserData, "session"));
  app.setPath("logs", path.join(smokeUserData, "logs"));
}

// Installed-package automation must not create, unlock or mutate a real
// login-keychain item on the developer/CI machine. Chromium's mock keychain
// is enabled only when both explicit package-smoke flags are present; normal
// development and every production launch continue to use macOS Keychain.
if (
  process.platform === "darwin" &&
  process.env.OMB_SMOKE_TEST === "1" &&
  process.env.REALBUD_USE_MOCK_KEYCHAIN_FOR_TEST === "1"
) {
  app.commandLine.appendSwitch("use-mock-keychain");
}

// GNOME groups the window with its installed desktop entry only when both
// identities match. This must run before Electron becomes ready.
if (process.platform === "linux") app.setDesktopName("com.realbud.app.desktop");

// One desk, one app. A second launch would fork a second harness server over
// the same ~/.realbud — silent last-writer-wins on the book. Focus the
// existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
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
let secureRuntimeEnv = {};
let serverBootFailure = "ports";

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

async function startServerOn(port) {
  const entry = path.join(process.resourcesPath, "server", "index.js");
  slog(`fork ${entry} port=${port}`);
  const proc = utilityProcess.fork(entry, [], {
    env: {
      ...packagedServerEnvironment(process.env),
      OMB_STATIC_DIR: path.join(process.resourcesPath, "ui"),
      OMB_PORT: String(port),
      OMB_USER_DATA: app.getPath("userData"),
      OMB_CUA_DRIVER_PATH: path.join(process.resourcesPath, "cua-driver"),
      REALBUD_APP_VERSION: app.getVersion(),
      ...secureRuntimeEnv,
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

async function startServerPackaged() {
  // two passes: a quit-and-reopen relaunch can race the dying instance's
  // server during teardown — one settle-and-retry covers it
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const port of [8799, 18799, 28799]) {
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

function errorPage() {
  const storage = serverBootFailure === "storage";
  const title = storage ? "Protected storage is unavailable" : "RealBud could not open its desk";
  const detail = storage
    ? "RealBud did not open the book because this computer's credential storage could not protect its keys. Quit and reopen RealBud. If it continues, check Keychain or your system password manager."
    : "Another RealBud process or local service may still be closing. Quit and reopen RealBud. If it continues, restart your computer.";
  return (
    "data:text/html;charset=utf-8," +
    encodeURIComponent(
      `<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#F3EFE5;color:#25231F;font:15px -apple-system,system-ui"><div style="text-align:center;max-width:430px;padding:32px"><h2 style="font-weight:600;margin:0 0 10px">${title}</h2><p style="color:#6F695E;line-height:1.55">${detail}</p><p style="color:#6F695E;font-size:12px">No book changes were made.</p></div></body>`,
    )
  );
}

let cuaReady = Promise.resolve({ mode: "unavailable", runtime: "none", reason: "not-started" });

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
    void openHttpsExternal(shell, url);
    return { action: "deny" };
  });

  // Packaged CI smoke hook. It validates the real renderer/preload bridge and
  // same-origin embedded server, then closes the window and explicitly quits
  // (macOS normally stays resident after its last window closes). app.quit()
  // still exercises the production server/CUA cleanup path below.
  if (process.env.OMB_SMOKE_TEST === "1") {
    win.webContents.once("did-finish-load", async () => {
      try {
        const result = await win.webContents.executeJavaScript(`
          (async () => {
            if (!window.ogb?.getCapabilities) throw new Error("desktop preload bridge is unavailable");
            const sessionResponse = await fetch("/api/session");
            if (!sessionResponse.ok) throw new Error("session bootstrap failed");
            const session = await sessionResponse.json();
            const headers = { "x-realbud-session": String(session.token || "") };
            const packResponse = await fetch("/api/hermes/apply-pack", {
              method: "POST",
              headers: { ...headers, "content-type": "application/json" },
              body: "{}",
            });
            if (!packResponse.ok) {
              throw new Error(\`property pack request failed: \${packResponse.status} \${packResponse.statusText}\`);
            }
            const [capabilities, healthResponse, deskResponse, workerResponse] = await Promise.all([
              window.ogb.getCapabilities(),
              fetch("/api/health"),
              fetch("/api/desk", { headers }),
              fetch("/api/hermes", { headers }),
            ]);
            for (const [name, response] of [["health", healthResponse], ["desk", deskResponse], ["worker", workerResponse]]) {
              if (!response.ok) throw new Error(\`\${name} request failed: \${response.status} \${response.statusText}\`);
            }
            const health = await healthResponse.json();
            const desk = await deskResponse.json();
            const worker = await workerResponse.json();
            return {
              capabilities,
              health,
              desk: {
                revision: desk.revision,
                properties: Array.isArray(desk.properties) ? desk.properties.length : -1,
                recovery: Boolean(desk.recovery?.active),
              },
              worker: {
                provider: worker.model?.provider ?? null,
                model: worker.model?.model ?? null,
                keyPresent: Boolean(worker.model?.keyPresent),
                packInstalled: Boolean(worker.pack?.installed),
                approvalsManual: Boolean(worker.pack?.approvalsManual),
              },
              location: window.location.href,
              title: document.title,
            };
          })()
        `);
        const expectedLocation = `http://127.0.0.1:${SERVER_PORT}/`;
        if (result.location !== expectedLocation) {
          throw new Error(
            `unexpected packaged renderer URL: ${result.location} (expected ${expectedLocation})`,
          );
        }
        console.log(`[smoke] renderer-ready ${JSON.stringify(result)}`);
      } catch (error) {
        console.error(`[smoke] renderer-failed ${error?.stack ?? error}`);
      } finally {
        win.close();
        app.quit();
      }
    });
  }

  if (app.isPackaged) {
    win.loadURL(serverReady ? `http://127.0.0.1:${SERVER_PORT}` : errorPage());
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

const MAX_SELECTED_FILES = 10;
const MAX_SELECTED_FILE_BYTES = 50 * 1024 * 1024;
ipcMain.handle("files:choose", async (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const result = owner
    ? await dialog.showOpenDialog(owner, { properties: ["openFile", "multiSelections"] })
    : await dialog.showOpenDialog({ properties: ["openFile", "multiSelections"] });
  if (result.canceled) return [];
  if (result.filePaths.length > MAX_SELECTED_FILES) {
    throw new Error(`Choose no more than ${MAX_SELECTED_FILES} files at once.`);
  }
  const files = [];
  const seen = new Set();
  for (const selectedPath of result.filePaths) {
    const filePath = fs.realpathSync(selectedPath);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error("Only regular files can be attached.");
    if (stat.size > MAX_SELECTED_FILE_BYTES) throw new Error("Each file must be 50 MB or smaller.");
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    files.push({ path: filePath, name: path.basename(filePath), size: stat.size });
  }
  return files;
});

// Routine reminders are a closed, privacy-safe desktop capability. The
// renderer sends only an opaque run id and one of two code-owned reasons;
// tenant names, properties, balances and model-written detail never reach a
// lock-screen notification. loops.json carries the durable notifiedAt receipt.
const shownRoutineReminderIds = new Set();
const liveRoutineNotifications = new Set();
ipcMain.handle("routine-reminder:show", (event, input) => {
  const reminder = parseRoutineReminder(input);
  if (!reminder) return { shown: false, reason: "invalid" };
  const { runId, kind } = reminder;
  if (!Notification.isSupported()) return { shown: false, reason: "unsupported" };
  if (shownRoutineReminderIds.has(runId)) return { shown: true, duplicate: true };

  const owner = BrowserWindow.fromWebContents(event.sender);
  const notification = new Notification(routineNotificationCopy(kind));
  shownRoutineReminderIds.add(runId);
  if (shownRoutineReminderIds.size > 2_000) shownRoutineReminderIds.delete(shownRoutineReminderIds.values().next().value);
  liveRoutineNotifications.add(notification);
  const release = () => liveRoutineNotifications.delete(notification);
  notification.once("close", release);
  notification.once("failed", (_event, error) => {
    shownRoutineReminderIds.delete(runId);
    release();
    slog(`routine reminder failed: ${String(error).slice(0, 160)}`);
  });
  notification.once("click", () => {
    if (owner && !owner.isDestroyed()) {
      if (owner.isMinimized()) owner.restore();
      owner.show();
      owner.focus();
      owner.webContents.send("routine-reminder:opened", { runId, kind });
    }
  });
  try {
    notification.show();
    return { shown: true };
  } catch (error) {
    shownRoutineReminderIds.delete(runId);
    release();
    slog(`routine reminder could not show: ${String(error).slice(0, 160)}`);
    return { shown: false, reason: "failed" };
  }
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
  // This IPC belongs to the generic development fleet, not RealBud. Hidden
  // UI is not an authority boundary: production/product mode refuses before
  // even copying renderer-controlled text to the clipboard.
  if (app.isPackaged || process.env.OMB_TEST_FLEET !== "1") return false;
  if (typeof command !== "string" || !command.trim()) return false;
  clipboard.writeText(command);
  return openBlankTerminal();
});

ipcMain.handle("perm:status", () => ({
  mic:
    process.platform === "darwin"
      ? systemPreferences.getMediaAccessStatus?.("microphone") ?? "unknown"
      : "unsupported",
}));
ipcMain.handle("perm:request-mic", async () => {
  if (process.platform !== "darwin") return false;
  try {
    return await systemPreferences.askForMediaAccess("microphone");
  } catch {
    return false;
  }
});

// macOS never re-prompts a denied permission — the only path is System
// Settings; deep-link straight to the right privacy pane.
ipcMain.handle("perm:open-settings", (_event, pane) => {
  if (process.platform !== "darwin") return false;
  const url = macPrivacySettingsUrl(pane);
  if (!url) return false;
  return shell.openExternal(url).then(() => true, () => false);
});

ipcMain.handle("shell:open-https", (_event, url) => openHttpsExternal(shell, url));

ipcMain.handle("speech:start", (event, options) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (process.platform !== "darwin") {
    win.webContents.send("speech:end", { code: 2, reason: "unsupported-platform" });
    return;
  }
  startSpeech(win, options);
});
ipcMain.handle("speech:stop", () => {
  if (process.platform === "darwin") stopSpeech();
});
ipcMain.handle("speech:finish", () => {
  if (process.platform === "darwin") finishSpeech();
});

ipcMain.handle("desktop:capabilities", async () =>
  desktopCapabilities({
    platform: process.platform,
    env: process.env,
    packaged: app.isPackaged,
    localConnection: await cuaReady,
  }),
);

ipcMain.handle("cua:enable", async () => {
  if (process.platform !== "darwin") {
    return desktopCapabilities({
      platform: process.platform,
      env: process.env,
      packaged: app.isPackaged,
      localConnection: { mode: "unavailable", runtime: "none", reason: "unsupported-platform" },
    });
  }
  cuaReady = enableCua().catch((error) => ({
    mode: "unavailable",
    runtime: cuaRuntimeStatus(),
    reason: String(error),
  }));
  return desktopCapabilities({
    platform: process.platform,
    env: process.env,
    packaged: app.isPackaged,
    localConnection: await cuaReady,
  });
});

ipcMain.handle("cua:disable", async () => {
  cuaReady = disableCua().catch((error) => ({
    mode: "unavailable",
    runtime: cuaRuntimeStatus(),
    reason: String(error),
  }));
  return desktopCapabilities({
    platform: process.platform,
    env: process.env,
    packaged: app.isPackaged,
    localConnection: await cuaReady,
  });
});

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
  registerUpdaterIpc();
  // CUA is bundled, but the first permission request follows an explicit setup
  // action in You. Once the PM opts in, subsequent launches restart only the
  // RealBud-owned host. Failure never blocks Desk/Ask/Schedule/You.
  const cuaDisabledForPackageSmoke =
    process.env.OMB_SMOKE_TEST === "1" && process.env.REALBUD_DISABLE_CUA_FOR_TEST === "1";
  const cuaEnabled = !cuaDisabledForPackageSmoke && process.platform === "darwin" && cuaWasEnabled();
  cuaReady =
    cuaEnabled
      ? startCua().catch((e) => {
          console.error("[cua] start failed:", e);
          return { mode: "unavailable", runtime: cuaRuntimeStatus(), reason: String(e) };
        })
      : Promise.resolve({
          mode: "unavailable",
          runtime: process.platform === "darwin" ? cuaRuntimeStatus() : "none",
          reason: cuaDisabledForPackageSmoke
            ? "package-smoke-disabled"
            : process.platform === "darwin"
              ? cuaRuntimeStatus() === "none"
                ? "cua-driver binary not found"
                : "not-enabled"
              : "unsupported-platform",
        });
  if (app.isPackaged) {
    try {
      const dataDir = process.env.REALBUD_DATA_DIR ?? process.env.OMB_DATA_DIR ?? path.join(app.getPath("home"), ".realbud");
      secureRuntimeEnv = await prepareSecureRuntimeEnv({
        safeStorage,
        dataDir,
        platform: process.platform,
        allowInsecureTest: process.env.REALBUD_ALLOW_INSECURE_TEST_KEYS === "1" && process.env.OMB_SMOKE_TEST === "1",
      });
      serverReady = await startServerPackaged();
    } catch (error) {
      serverReady = false;
      serverBootFailure = "storage";
      slog(`protected storage unavailable: ${error instanceof Error ? error.message.slice(0, 160) : "unknown error"}`);
    }
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

// EMBEDDING.md lifecycle rule: defer the first quit until the embedded
// daemon's async cleanup completes — it can't run after the host exits.
// Cap the defer so a wedged daemon cannot keep the app alive forever.
const CUA_STOP_TIMEOUT_MS = 2500;
let cuaCleanedUp = false;
app.on("before-quit", (e) => {
  if (cuaCleanedUp) return;
  e.preventDefault();
  try {
    serverProc?.kill();
  } catch {}
  // a live dictation session runs its own helper child that holds the mic —
  // stop it here so quitting never orphans a recording process
  stopSpeech();
  const cleanup = Promise.race([
    stopCua().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, CUA_STOP_TIMEOUT_MS).unref()),
  ]);
  cleanup.then(() => {
    cuaCleanedUp = true;
    app.quit();
  });
});
