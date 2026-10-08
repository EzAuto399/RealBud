// In-app auto-updater (electron-updater): checks and downloads by itself in
// the background; the only thing staff see is "Restart to update" once a new
// version is on disk, and quitAndInstall waits for that click. One state object is broadcast to the
// renderer on every transition; the renderer just renders it.
//
// Only runs in the packaged, signed+notarized app (mac auto-update requires
// signing). In dev it's a no-op so the browser/dev shell is unaffected.
// electron-updater is vendored (electron/vendor/electron-updater.cjs) because
// the packaged app ships no node_modules.
import { app } from "electron";
import { createRequire } from "node:module";
import { join } from "node:path";
import { runUpdaterAction } from "./updater-action.mjs";
import { serviceIdentity } from "./service-instance.mjs";
import { prepareServiceForUpdate } from "./update-service-handoff.mjs";
import { windowsKeyPrivacyAsync } from "./desk-key-custody.mjs";

const require = createRequire(import.meta.url);

let autoUpdater = null;
// The window to tell about update state: a getter, so a window reopened after
// the first was closed still hears it.
let liveWindow = () => null;
// status: idle | checking | available | downloading | downloaded | error
let state = { status: "idle" };
// Whether the in-flight check came from the user's button. Background checks
// fail for reasons that are none of the user's business — no feed published
// for this platform yet, offline, a GitHub blip — and a popup for those on
// every launch is pure noise. Only a check the user asked for may surface an
// error; automatic ones fall back to idle.
let userInitiated = false;

function setState(patch) {
  state = { ...state, ...patch };
  try {
    const target = liveWindow();
    if (target && !target.isDestroyed()) target.webContents.send("update:state", state);
  } catch {
    /* window gone */
  }
}

function check(manual = false) {
  if (!autoUpdater) return;
  // A downloading or downloaded update waits for its restart: the library would
  // announce it as "available" again and the card would ask to download twice.
  if (state.status === "downloading" || state.status === "downloaded") return;
  userInitiated = manual;
  runUpdaterAction(() => autoUpdater.checkForUpdates(), reportError);
}

function reportError(e) {
  if (!userInitiated) return setState({ status: "idle" });
  setState({ status: "error", message: String(e?.message ?? e) });
}

/** `ipc` is main's guarded wrapper: only the office window may call. */
export function registerUpdaterIpc(ipc) {
  ipc.handle("update:get-state", () => state);
  ipc.handle("update:check", () => check(true));
  ipc.handle("update:download", () => {
    runUpdaterAction(
      () => autoUpdater?.downloadUpdate(),
      (e) => setState({ status: "error", message: String(e?.message ?? e) }),
    );
  });
  ipc.handle("update:install", () => install());
}

// The detached office service would otherwise keep running the old version
// under the new window. Install only once it is idle and provably stopped;
// while Bud is working, wait and try again by itself.
const DEFER_RETRY_MS = 30_000;
let installing = null;
let deferTimer = null;
let cannotStopTries = 0;
const DEFERRED = {
  busy: "Bud is still working. RealBud will restart to update when the work finishes.",
  "cannot-stop": "RealBud could not stop the office service for this update. Stop it in Settings & help, then restart to update.",
  "still-running": "The office service is still stopping. RealBud will try the update again shortly.",
};
const CANNOT_STOP_RETRYING = "RealBud could not stop the office service yet. It will try the update again shortly.";
function install() {
  if (installing) return installing;
  installing = (async () => {
    if (!autoUpdater) return;
    clearTimeout(deferTimer);
    // Same rule as realbudDataDir() in main.mjs: the service identity is its data directory.
    const dataDirectory = process.env.REALBUD_DATA_DIR || process.env.OMB_DATA_DIR || join(app.getPath("home"), ".realbud");
    const handoff = await prepareServiceForUpdate({ dataDirectory, identity: serviceIdentity(dataDirectory), verifyWindowsPrivacy: windowsKeyPrivacyAsync });
    cannotStopTries = !handoff.ready && handoff.reason === "cannot-stop" ? cannotStopTries + 1 : 0;
    if (!handoff.ready) {
      const retrying = handoff.reason === "cannot-stop" && cannotStopTries < 2;
      setState({ status: "downloaded", deferred: handoff.reason, message: retrying ? CANNOT_STOP_RETRYING : DEFERRED[handoff.reason] });
      // A service it could not stop gets one more try by itself; after that the
      // person stops it, and their next "Restart to update" starts afresh.
      if (cannotStopTries < 2) {
        deferTimer = setTimeout(() => void install(), DEFER_RETRY_MS);
        deferTimer.unref?.();
      } else cannotStopTries = 0;
      return;
    }
    // isSilent, isForceRunAfter — relaunch straight into the new version
    autoUpdater.quitAndInstall(true, true);
  })().catch((e) => setState({ status: "error", message: String(e?.message ?? e) }))
    .finally(() => { installing = null; });
  return installing;
}

export function startUpdater(mainWindow) {
  liveWindow = typeof mainWindow === "function" ? mainWindow : () => mainWindow;
  // dev / unsigned builds can't auto-update — leave the banner dormant
  if (!app.isPackaged) {
    setState({ status: "idle" });
    return;
  }
  try {
    ({ autoUpdater } = require("./vendor/electron-updater.cjs"));
  } catch {
    setState({ status: "error", message: "updater unavailable" });
    return;
  }
  autoUpdater.autoDownload = true; // fetch a new version as soon as a check finds it
  autoUpdater.autoInstallOnAppQuit = false; // button-driven install
  autoUpdater.logger = null;

  autoUpdater.on("checking-for-update", () => setState({ status: "checking" }));
  autoUpdater.on("update-available", (info) =>
    setState({ status: "available", version: info?.version, message: undefined }),
  );
  autoUpdater.on("update-not-available", () => setState({ status: "idle" }));
  autoUpdater.on("download-progress", (p) =>
    setState({ status: "downloading", percent: Math.round(p?.percent ?? 0) }),
  );
  autoUpdater.on("update-downloaded", (info) =>
    setState({ status: "downloaded", version: info?.version, deferred: undefined, message: undefined }),
  );
  autoUpdater.on("error", reportError);

  // first check ~15s after launch (let the app settle), then hourly — both
  // silent on failure, hence the arrow: a bare `check` would receive the
  // timer's argument as `manual` and start reporting errors again.
  setTimeout(() => check(), 15_000).unref?.();
  setInterval(() => check(), 60 * 60 * 1000).unref?.();
}
