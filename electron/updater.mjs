// In-app auto-updater (electron-updater): checks and downloads by itself in
// the background, and keeps checking while an update waits so the newest
// release replaces an older download. A downloaded update installs when the
// person clicks "Restart now", or by itself at a safe moment: nobody at the
// keyboard for 5 minutes (or the screen locked), no unsaved work, the office
// idle and no approval waiting (docs/UPDATES-2026-10-10.md). One state object
// is broadcast to the renderer on every transition; the renderer just renders it.
//
// Only runs in the packaged, signed+notarized app (mac auto-update requires
// signing). In dev it's a no-op so the browser/dev shell is unaffected.
// electron-updater is vendored (electron/vendor/electron-updater.cjs) because
// the packaged app ships no node_modules.
import { app, powerMonitor } from "electron";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { runUpdaterAction } from "./updater-action.mjs";
import { serviceIdentity } from "./service-instance.mjs";
import { prepareServiceForUpdate, readServiceActivity } from "./update-service-handoff.mjs";
import { windowsKeyPrivacyAsync } from "./desk-key-custody.mjs";
import {
  AWAY_SECONDS, COUNTDOWN_MS, LATER_MS, SCHEDULE_FILE,
  clampSchedule, countdownInterrupted, decideRestart, deferredEnded, handoffAbort, launchOutcome, loadSchedule,
  manualRetryAllowed, requiredState, restartState, saveSchedule, scheduleForDownload,
} from "./update-schedule.mjs";

const require = createRequire(import.meta.url);

let autoUpdater = null;
// The window to tell about update state: a getter, so a window reopened after
// the first was closed still hears it.
let liveWindow = () => null;
// Main's single start path for the office service (adopt first, never a second
// one). An install that stopped the service and then did not go ahead starts it
// again through this; without it the office stays stopped until someone starts it.
/** @type {null | (() => Promise<unknown>)} */
let startService = null;
// status: idle | checking | available | downloading | downloaded | error
let state = { status: "idle" };
// Whether the in-flight check came from the user's button. Background checks
// fail for reasons that are none of the user's business — no feed published
// for this platform yet, offline, a GitHub blip — and a popup for those on
// every launch is pure noise. Only a check the user asked for may surface an
// error; automatic ones fall back to idle.
let userInitiated = false;

function currentWindow() {
  try {
    const target = liveWindow();
    return target && !target.isDestroyed() ? target : null;
  } catch {
    return null; // window gone
  }
}

function setState(patch) {
  state = { ...state, ...patch };
  try {
    currentWindow()?.webContents.send("update:state", state);
  } catch {
    /* window gone */
  }
}

function check(manual = false) {
  if (!autoUpdater) return;
  // A download in progress finishes first, and an install under way is not
  // raced: a newer download replaces the installer it is about to run. A
  // downloaded update keeps checking, so a newer release replaces it.
  if (state.status === "downloading" || installing) return;
  userInitiated = manual;
  runUpdaterAction(() => autoUpdater.checkForUpdates(), reportError);
}

function reportError(e) {
  installWhenDownloaded = false;
  // The installer could not start: install() says so and brings the office back.
  if (startingInstaller) {
    installerFailure = { error: e };
    return;
  }
  // A failed check leaves the update already on disk ready to install.
  if (state.status === "downloaded") return;
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
  // No argument reaches install(): only the safe-moment loop installs without asking the window.
  ipc.handle("update:install", () => restartNow());
  ipc.handle("update:later", () => holdRestart());
  ipc.handle("update:cancel-countdown", () => {
    // Also stops an install that is already stopping the office service, at its last look.
    clicks.notNow = Date.now();
    if (!countdown && !installing) return;
    clearCountdown();
    publishRestart({ action: "wait-away" });
  });
  ipc.handle("update:dismiss-note", () => {
    installWhenDownloaded = false;
    setState({ updatedFrom: undefined, installFailed: undefined });
  });
  ipc.handle("update:unsaved-reply", (_event, id, reply) => answerUnsaved(id, reply));
}

// ── Unsaved work ──
// quitAndInstall starts the installer before the window can refuse to close,
// so the window is asked first. It answers from the same checks as beforeunload.
const UNSAVED_TIMEOUT_MS = 2_000;
const unsavedQueries = new Map();

/** true, false, or null when the window did not answer in time. No window holds no unsaved work. */
function askUnsaved() {
  const target = currentWindow();
  if (!target) return Promise.resolve(false);
  // RealBud's own error and waiting pages hold no drafts and never answer.
  let url = "";
  try { url = target.webContents.getURL(); } catch { /* a closing window holds nothing */ }
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) return Promise.resolve(false);
  const id = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { unsavedQueries.delete(id); resolve(null); }, UNSAVED_TIMEOUT_MS);
    timer.unref?.();
    unsavedQueries.set(id, (unsaved) => { clearTimeout(timer); unsavedQueries.delete(id); resolve(unsaved); });
    try {
      target.webContents.send("update:query-unsaved", id);
    } catch {
      /* answered by the timeout */
    }
  });
}

/** Anything but an explicit `{ unsaved: false }` keeps the work. */
function answerUnsaved(id, reply) {
  const settle = unsavedQueries.get(id);
  if (!settle) return false;
  settle(reply?.unsaved !== false);
  return true;
}

// ── What main keeps on disk (<userData>/update-schedule.json) ──
let scheduleFile = null;
/** @type {import('./update-schedule.mjs').UpdateSchedule} */
let schedule = {};
// From the newest feed; below it, "Later" goes away.
let minimumVersion;

/** Kept in memory either way, so this launch still honours it; true once it is on disk. */
function recordSchedule(next) {
  schedule = next;
  if (!scheduleFile) return true;
  try {
    saveSchedule(scheduleFile, next);
  } catch {
    return false;
  }
  if (state.deferred === "cannot-record") setState({ deferred: undefined, message: undefined });
  return true;
}

function noteMinimumVersion(info) {
  minimumVersion = typeof info?.minimumVersion === "string" ? info.minimumVersion : undefined;
}

function requiredNow(now) {
  const downloadedAt = schedule.version === state.version ? schedule.downloadedAt : undefined;
  return requiredState({ now, downloadedAt, appVersion: app.getVersion(), minimumVersion });
}

// When the person last chose "Restart now", "Later" or the countdown's "Not now".
// An install compares them with the moment it was chosen: the latest click wins.
/** @type {{ restartNow?: number, later?: number, notNow?: number }} */
const clicks = {};

function holdRestart() {
  if (state.status !== "downloaded") return false;
  const now = Date.now();
  if (requiredNow(now).required) return false;
  clicks.later = now;
  clearCountdown();
  recordSchedule({ ...schedule, laterUntil: now + LATER_MS });
  publishRestart({ action: "hold" }, now);
  return true;
}

// ── Install ──
// The detached office service would otherwise keep running the old version
// under the new window. Install only once it is idle and provably stopped;
// while Bud is working, wait and try again by itself.
const DEFER_RETRY_MS = 30_000;
let installing = null;
let deferTimer = null;
let cannotStopTries = 0;
let startingInstaller = false;
/** @type {null | { error: unknown }} */
let installerFailure = null;
const DEFERRED = {
  busy: "Bud is still working. RealBud will restart to update when the work finishes.",
  "cannot-stop": "RealBud could not stop the office service for this update. Stop it in Settings & help, then restart to update.",
  "still-running": "The office service is still stopping. RealBud will try the update again shortly.",
  "cannot-record": "RealBud could not save its update record, so it will not restart by itself. Choose Restart now to update.",
};
const CANNOT_STOP_RETRYING = "RealBud could not stop the office service yet. It will try the update again shortly.";
const UNSAVED_FIRST = "Save or discard your open draft first, then restart to update.";

// "Restart now" (or "Try again" after a failed install) with nothing on disk yet,
// as on a fresh launch: fetch it, then install the moment it lands. One-shot;
// an error or dismissing the note drops it.
let installWhenDownloaded = false;
function restartNow() {
  if (!autoUpdater) return;
  // Also makes an automatic install already under way the person's own.
  clicks.restartNow = Date.now();
  if (state.status === "downloaded") return install();
  installWhenDownloaded = true;
  check(true);
}

/** Brings the office service back when an install stopped it and then did not go ahead. */
async function resumeService(handoff) {
  if (!handoff?.stopped || !startService) return;
  try {
    await startService();
  } catch {
    /* main's own banner offers to start it */
  }
}

/** The restart state an install that did not go ahead returns to. */
function putOff(reason) {
  if (reason === "cannot-record") setState({ deferred: reason, message: DEFERRED[reason] });
  // The person changed their mind: what the last attempt waited for no longer applies.
  if (reason === "later" || reason === "not-now") setState({ deferred: undefined, message: undefined });
  publishRestart(reason === "later" ? { action: "hold" } : reason === "unsaved" ? { action: "wait", blockedBy: ["unsaved"] } : { action: "wait-away" });
}

/**
 * `automatic` comes only from the safe-moment loop, which has just asked the
 * window and retries by itself; "Restart now" asks the window here. `since` is
 * when the install was chosen: the loop's decision, or the person's click.
 */
function install({ automatic = false, since = automatic ? Date.now() : clicks.restartNow ?? Date.now() } = {}) {
  if (installing) return installing;
  installing = (async () => {
    if (!autoUpdater || state.status !== "downloaded") return;
    clearTimeout(deferTimer);
    const version = state.version;
    /** @param {boolean | null} unsaved */
    const look = (unsaved) => handoffAbort({
      automatic, since, now: Date.now(), downloaded: state.status === "downloaded" && state.version === version,
      clicks, unsaved, idleSeconds: idleSeconds(), locked: screenLocked(),
    });
    // "Restart now" after the loop chose this install makes it the person's.
    const personChose = () => !automatic || (clicks.restartNow ?? -Infinity) >= since;
    // No answer in time: the person chose to restart, so it goes ahead.
    if (!automatic && (await askUnsaved()) === true) {
      setState({ deferred: "unsaved", message: UNSAVED_FIRST });
      return;
    }
    const early = look(false);
    if (early) return putOff(early);
    // Without the marker a failed install goes unnoticed and the loop would stop
    // the office service for it again and again, so an automatic install proves
    // the schedule saves before it stops anything.
    if (!personChose() && !recordSchedule(schedule)) return putOff("cannot-record");
    // Same rule as realbudDataDir() in main.mjs: the service identity is its data directory.
    const dataDirectory = officeDataDirectory();
    const handoff = await prepareServiceForUpdate({ dataDirectory, identity: serviceIdentity(dataDirectory), verifyWindowsPrivacy: windowsKeyPrivacyAsync });
    if (!handoff.ready) return handoffRefused(handoff.reason, !personChose());
    cannotStopTries = 0;
    // Stopping the service can take 15 s: look again, and bring the office back for anything that changed.
    const abort = look(await askUnsaved());
    if (abort) {
      // The person's "Restart now" outlives a newer release replacing the installer: it installs when that lands.
      if (abort === "newer" && personChose()) installWhenDownloaded = true;
      if (abort === "unsaved" && personChose()) setState({ deferred: "unsaved", message: UNSAVED_FIRST });
      await resumeService(handoff);
      return putOff(abort);
    }
    if (!recordSchedule({ ...schedule, version, attemptedAt: Date.now(), fromVersion: app.getVersion() }) && !personChose()) {
      await resumeService(handoff);
      return putOff("cannot-record");
    }
    installerFailure = null;
    startingInstaller = true;
    try {
      // isSilent, isForceRunAfter — relaunch straight into the new version
      autoUpdater.quitAndInstall(true, true);
    } catch (error) {
      installerFailure = { error };
    } finally {
      startingInstaller = false;
    }
    if (!installerFailure) return;
    // The installer did not start, so nothing quits: say so, keep the office
    // running, and leave this version to the person's "Try again".
    const { error } = installerFailure;
    installerFailure = null;
    const { attemptedAt: _a, fromVersion: _f, ...waiting } = schedule;
    recordSchedule({ ...waiting, installFailed: { version } });
    setState({ status: "error", message: String(/** @type {any} */ (error)?.message ?? error), restart: undefined });
    await resumeService(handoff);
  })().catch((e) => { installWhenDownloaded = false; setState({ status: "error", message: String(e?.message ?? e), restart: undefined }); })
    .finally(() => {
      installing = null;
      // "Restart now" met a newer release while the service stopped, and it has landed since.
      if (installWhenDownloaded && state.status === "downloaded") {
        installWhenDownloaded = false;
        void install();
      }
    });
  return installing;
}

/** The office service was not ready to hand over; nothing was stopped. */
function handoffRefused(reason, automatic) {
  if (automatic) {
    setState({ deferred: reason, message: DEFERRED[reason] });
    publishRestart(reason === "busy" ? { action: "wait", blockedBy: ["busy"] } : { action: "wait-away" });
    return;
  }
  // A service it could not stop gets one more try by itself; after that the
  // person stops it, and their next "Restart to update" starts afresh. Busy or
  // still stopping: try every 30 s for 10 minutes from the click, then the
  // safe-moment loop takes over, which also waits for the person to be away.
  cannotStopTries = reason === "cannot-stop" ? cannotStopTries + 1 : 0;
  const retry = reason === "cannot-stop" ? cannotStopTries < 2 : manualRetryAllowed({ now: Date.now(), requestedAt: clicks.restartNow ?? -Infinity });
  if (!retry && reason !== "cannot-stop") return setState({ deferred: undefined, message: undefined });
  setState({ deferred: reason, message: retry && reason === "cannot-stop" ? CANNOT_STOP_RETRYING : DEFERRED[reason] });
  if (!retry) {
    cannotStopTries = 0;
    return;
  }
  deferTimer = setTimeout(() => void install(), DEFER_RETRY_MS);
  deferTimer.unref?.();
}

function officeDataDirectory() {
  return process.env.REALBUD_DATA_DIR || process.env.OMB_DATA_DIR || join(app.getPath("home"), ".realbud");
}

// ── The safe moment ──
const SAFE_MOMENT_MS = 60_000;
let countdown = null;
let considering = false;

function publishRestart(decision, now = Date.now()) {
  if (state.status !== "downloaded") return;
  // A version whose install failed waits for the person's "Try again": promise no restart by itself.
  if (schedule.installFailed?.version === state.version) {
    if (state.restart) setState({ restart: undefined });
    return;
  }
  const { required, requiredReason } = requiredNow(now);
  const restart = restartState(decision, { now, laterUntil: schedule.laterUntil, required, requiredReason, at: countdown?.at });
  if (JSON.stringify(restart) !== JSON.stringify(state.restart)) setState({ restart });
}

function idleSeconds() {
  try { return powerMonitor.getSystemIdleTime(); } catch { return 0; }
}
function screenLocked() {
  try { return powerMonitor.getSystemIdleState(AWAY_SECONDS) === "locked"; } catch { return false; }
}

async function serviceActivity() {
  try {
    return await readServiceActivity({ identity: serviceIdentity(officeDataDirectory()) });
  } catch {
    return { running: true, busy: true, waitingApprovals: 0 };
  }
}

/**
 * The cheap facts first; the window and the office service are asked only when
 * those allow a restart, or when a put-off install's line may have gone stale.
 */
async function evaluate() {
  const now = Date.now();
  const base = { now, idleSeconds: idleSeconds(), locked: screenLocked(), laterUntil: schedule.laterUntil, required: requiredNow(now).required };
  const first = decideRestart(base);
  const deferred = state.deferred;
  const askWindow = first.action === "wait" || deferred === "unsaved";
  const askService = first.action === "wait" || deferred === "busy" || deferred === "cannot-stop" || deferred === "still-running";
  if (!askWindow && !askService) return { decision: first, now };
  const [unsaved, activity] = await Promise.all([askWindow ? askUnsaved() : undefined, askService ? serviceActivity() : undefined]);
  if (deferred && state.deferred === deferred && !installing && deferredEnded(deferred, { unsaved, activity })) {
    setState({ deferred: undefined, message: undefined });
  }
  if (first.action !== "wait" || !activity) return { decision: first, now };
  // Nothing of ours answering: nothing to be busy, and the handoff still proves the port free.
  const decision = decideRestart({ ...base, unsaved, busy: activity.running ? activity.busy : false, approvals: activity.running ? activity.waitingApprovals : 0 });
  return { decision, now };
}

/** Every minute while an update waits. `countdownDone`: the countdown ran out with nobody touching anything. */
async function considerRestart(countdownDone = false) {
  if (!autoUpdater || state.status !== "downloaded" || countdown || installing || considering) return;
  // An install of this version did not start, or reopened the old version: the person chooses "Try again".
  if (schedule.installFailed?.version === state.version) return;
  considering = true;
  try {
    const { decision, now } = await evaluate();
    // The state may have moved on while the window and the service answered.
    if (state.status !== "downloaded" || countdown || installing) return;
    if (decision.action === "install" || (countdownDone && decision.action === "countdown")) return void install({ automatic: true, since: now });
    if (decision.action === "countdown") return startCountdown();
    publishRestart(decision, now);
  } finally {
    considering = false;
  }
}

function startCountdown() {
  const startedAt = Date.now();
  // Any keyboard or mouse use cancels it; the next minute starts afresh.
  const poll = setInterval(() => {
    if (!countdownInterrupted({ idleSeconds: idleSeconds(), elapsedMs: Date.now() - startedAt })) return;
    clearCountdown();
    publishRestart({ action: "wait-away" });
  }, 1_000);
  const end = setTimeout(() => {
    clearCountdown();
    void considerRestart(true);
  }, COUNTDOWN_MS);
  poll.unref?.();
  end.unref?.();
  countdown = { at: startedAt + COUNTDOWN_MS, poll, end };
  publishRestart({ action: "countdown" }, startedAt);
}

function clearCountdown() {
  if (!countdown) return;
  clearInterval(countdown.poll);
  clearTimeout(countdown.end);
  countdown = null;
}

/**
 * @param {unknown} mainWindow The office window, or a getter for it.
 * @param {{ startService?: () => Promise<unknown> }} [options] `startService`: main's
 *   start-or-adopt path for the office service, used after an install stopped it and did not go ahead.
 */
export function startUpdater(mainWindow, { startService: start } = {}) {
  liveWindow = typeof mainWindow === "function" ? mainWindow : () => mainWindow;
  startService = typeof start === "function" ? start : null;
  // dev / unsigned builds can't auto-update — leave the banner dormant
  if (!app.isPackaged) {
    setState({ status: "idle" });
    return;
  }
  // What the last launch left: an install that landed, or one that did not.
  // Times a clock change pushed out of reach are pulled back and saved, so a
  // relaunch cannot stretch them again.
  scheduleFile = join(app.getPath("userData"), SCHEDULE_FILE);
  const stored = loadSchedule(scheduleFile);
  const outcome = launchOutcome(clampSchedule(stored, Date.now()), app.getVersion());
  if (JSON.stringify(outcome.schedule) !== JSON.stringify(stored)) recordSchedule(outcome.schedule);
  else schedule = stored;
  if (outcome.updatedFrom) setState({ updatedFrom: outcome.updatedFrom });
  if (outcome.installFailed) setState({ installFailed: outcome.installFailed });
  try {
    ({ autoUpdater } = require("./vendor/electron-updater.cjs"));
  } catch {
    setState({ status: "error", message: "updater unavailable" });
    return;
  }
  autoUpdater.autoDownload = true; // fetch a new version as soon as a check finds it
  autoUpdater.autoInstallOnAppQuit = false; // RealBud picks the moment: "Restart now" or a safe one
  autoUpdater.logger = null;

  autoUpdater.on("checking-for-update", () => {
    if (state.status !== "downloaded") setState({ status: "checking" });
  });
  autoUpdater.on("update-available", (info) => {
    noteMinimumVersion(info);
    // The hourly check found the update already waiting: it stays ready to install.
    if (state.status === "downloaded" && info?.version === state.version) return;
    clearCountdown();
    setState({ status: "available", version: info?.version, message: undefined, deferred: undefined, restart: undefined });
  });
  autoUpdater.on("update-not-available", () => {
    // A "Restart now" or "Try again" that found nothing is over; a later download waits for a safe moment.
    installWhenDownloaded = false;
    if (state.status !== "downloaded") setState({ status: "idle" });
  });
  autoUpdater.on("download-progress", (p) => {
    clearCountdown();
    setState({ status: "downloading", percent: Math.round(p?.percent ?? 0), restart: undefined });
  });
  autoUpdater.on("update-downloaded", (info) => {
    noteMinimumVersion(info);
    const version = info?.version;
    const next = scheduleForDownload(schedule, version, Date.now());
    if (next !== schedule) recordSchedule(next);
    if (!(state.status === "downloaded" && state.version === version)) {
      setState({ status: "downloaded", version, deferred: undefined, message: undefined });
      publishRestart({ action: "wait-away" });
    }
    // The person asked to restart before it had downloaded: their install,
    // unsaved-work question included. An install still under way picks it up when it ends.
    if (!installWhenDownloaded || installing) return void considerRestart();
    installWhenDownloaded = false;
    void install();
  });
  autoUpdater.on("error", reportError);

  // first check ~15s after launch (let the app settle), then hourly — both
  // silent on failure, hence the arrow: a bare `check` would receive the
  // timer's argument as `manual` and start reporting errors again.
  setTimeout(() => check(), 15_000).unref?.();
  setInterval(() => check(), 60 * 60 * 1000).unref?.();
  setInterval(() => void considerRestart(), SAFE_MOMENT_MS).unref?.();
  // A wake or a lock changes the answer before the next minute comes round.
  powerMonitor.on("resume", () => { check(); void considerRestart(); });
  powerMonitor.on("lock-screen", () => void considerRestart());
  powerMonitor.on("unlock-screen", () => void considerRestart());
}
