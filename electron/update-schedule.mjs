// When a downloaded update may restart RealBud by itself, and what main keeps
// on disk between launches (docs/UPDATES-2026-10-10.md). Pure apart from the
// small file helpers, so tests import it without booting Electron.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { dirname } from "node:path";

export const SCHEDULE_FILE = "update-schedule.json";
/** No keyboard or mouse use for this long counts as away. */
export const AWAY_SECONDS = 300;
/** "Later" holds the automatic restart this long. */
export const LATER_MS = 4 * 60 * 60 * 1000;
/** An update that has waited this long can no longer be put off. */
export const REQUIRED_AFTER_MS = 24 * 60 * 60 * 1000;
export const COUNTDOWN_MS = 60_000;
/** "Restart now" while the office is busy tries again by itself for this long, then the safe-moment loop takes over. */
export const MANUAL_RETRY_MS = 10 * 60 * 1000;

const VERSION = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]{1,40}))?(?:\+[0-9A-Za-z.-]{1,40})?$/;

/** -1, 0 or 1 for two x.y.z versions (a prerelease sorts before its release);
 * null when either is not a version. */
export function compareVersions(a, b) {
  const x = VERSION.exec(String(a ?? "")), y = VERSION.exec(String(b ?? ""));
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d) return Math.sign(d);
  }
  if (!x[4] || !y[4]) return x[4] ? -1 : y[4] ? 1 : 0;
  return Math.sign(x[4].localeCompare(y[4], "en", { numeric: true }));
}

/**
 * @typedef {object} UpdateSchedule
 * @property {string} [version] The update waiting.
 * @property {number} [downloadedAt] When `version` first finished downloading, epoch ms.
 * @property {number} [laterUntil] "Later" holds the automatic restart until then.
 * @property {number} [attemptedAt] Written just before an install starts.
 * @property {string} [fromVersion] The version that started that install.
 * @property {{ version: string }} [installFailed] An install of this version did not start, or reopened
 *   the old version: the safe-moment loop leaves it to the person's "Try again". A newer download clears it.
 */

/** The stored schedule, or {} for a missing, corrupt or foreign file. */
export function parseSchedule(raw) {
  let value;
  try { value = JSON.parse(String(raw)); } catch { return {}; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  /** @type {UpdateSchedule} */
  const schedule = {};
  for (const key of ["version", "fromVersion"]) if (typeof value[key] === "string" && VERSION.test(value[key])) schedule[key] = value[key];
  for (const key of ["downloadedAt", "laterUntil", "attemptedAt"]) if (Number.isFinite(value[key]) && value[key] > 0) schedule[key] = value[key];
  const failed = value.installFailed?.version;
  if (typeof failed === "string" && VERSION.test(failed)) schedule.installFailed = { version: failed };
  return schedule;
}

/**
 * Times from the file that a clock change or a damaged file could push out of
 * reach: "Later" holds at most 4 hours from now, and nothing downloaded in the
 * future (or the 24-hour clock would never run out).
 * @param {UpdateSchedule} schedule @param {number} now @returns {UpdateSchedule}
 */
export function clampSchedule(schedule, now) {
  const clamped = { ...schedule };
  if (Number.isFinite(clamped.laterUntil) && /** @type {number} */ (clamped.laterUntil) > now + LATER_MS) clamped.laterUntil = now + LATER_MS;
  if (Number.isFinite(clamped.downloadedAt) && /** @type {number} */ (clamped.downloadedAt) > now) clamped.downloadedAt = now;
  return clamped;
}

/**
 * The schedule once `version` has finished downloading. A newer version replaces
 * the waiting one but keeps its earliest download time, so a stream of releases
 * cannot keep resetting the 24-hour clock; "Later" carries over, and a failed
 * install of the older version no longer applies. The same version changes nothing.
 * @param {UpdateSchedule} schedule @param {string | undefined} version @param {number} now @returns {UpdateSchedule}
 */
export function scheduleForDownload(schedule, version, now) {
  if (!version || schedule.version === version) return schedule;
  const waitingSince = schedule.version && Number.isFinite(schedule.downloadedAt) ? Math.min(/** @type {number} */ (schedule.downloadedAt), now) : now;
  return { version, downloadedAt: waitingSince, ...(schedule.laterUntil ? { laterUntil: schedule.laterUntil } : {}) };
}

/** @param {string} file @returns {UpdateSchedule} */
export function loadSchedule(file, fileSystem = fs) {
  try { return parseSchedule(fileSystem.readFileSync(file, "utf8")); } catch { return {}; }
}

/** Replace the file whole or not at all (temp → rename), like cua-connection.cjs. Throws on failure. */
export function saveSchedule(file, schedule, fileSystem = fs, temporaryId = randomUUID) {
  fileSystem.mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${temporaryId()}.tmp`;
  try {
    fileSystem.writeFileSync(temporary, `${JSON.stringify(schedule)}\n`);
    fileSystem.renameSync(temporary, file);
  } catch (error) {
    try { fileSystem.unlinkSync(temporary); } catch { /* never created or already renamed */ }
    throw error;
  }
}

/**
 * What this launch learns from the last one. An install that landed shows
 * "Updated from X" and clears the file; one that left the old version running
 * shows "didn't install", keeps the waiting update and remembers the failure so
 * the safe-moment loop does not stop the office service for it again; a waiting
 * update that is not newer than this version is gone.
 * @param {UpdateSchedule} schedule @param {string} running
 * @returns {{ schedule: UpdateSchedule, updatedFrom?: { from: string, to: string }, installFailed?: { version: string } }}
 */
export function launchOutcome(schedule, running) {
  const { version, fromVersion, attemptedAt } = schedule;
  if (fromVersion && version === running && fromVersion !== running) return { schedule: {}, updatedFrom: { from: fromVersion, to: running } };
  if (attemptedAt && version && fromVersion === running) {
    const { attemptedAt: _a, fromVersion: _f, ...waiting } = schedule;
    return { schedule: { ...waiting, installFailed: { version } }, installFailed: { version } };
  }
  if (version && (compareVersions(version, running) ?? 1) <= 0) return { schedule: {} };
  return { schedule };
}

/**
 * Whether "Later" is still allowed. Below the feed's minimumVersion wins over waiting.
 * @param {{ now: number, downloadedAt?: number, appVersion: string, minimumVersion?: unknown }} facts
 * @returns {{ required: boolean, requiredReason?: 'unsupported' | 'waited' }}
 */
export function requiredState({ now, downloadedAt, appVersion, minimumVersion }) {
  if (typeof minimumVersion === "string" && compareVersions(appVersion, minimumVersion) === -1) return { required: true, requiredReason: "unsupported" };
  if (Number.isFinite(downloadedAt) && now - /** @type {number} */ (downloadedAt) >= REQUIRED_AFTER_MS) return { required: true, requiredReason: "waited" };
  return { required: false };
}

/**
 * @typedef {{ action: 'hold' } | { action: 'wait-away' } | { action: 'wait', blockedBy: Array<'unsaved' | 'busy' | 'approval'> } | { action: 'countdown' } | { action: 'install' }} RestartDecision
 */

/**
 * May a downloaded update restart RealBud now? Every condition must hold, and a
 * fact nobody could establish (undefined or null) blocks like a bad one. The
 * caller passes the cheap facts first and asks the window and the office
 * service only when the answer is "wait".
 * @param {object} facts
 * @param {number} facts.now
 * @param {number} facts.idleSeconds Seconds since the last keyboard or mouse use.
 * @param {boolean} facts.locked
 * @param {boolean | null} [facts.unsaved]
 * @param {boolean | null} [facts.busy]
 * @param {number | null} [facts.approvals] Approval cards waiting.
 * @param {number} [facts.laterUntil]
 * @param {boolean} facts.required
 * @returns {RestartDecision}
 */
export function decideRestart({ now, idleSeconds, locked, unsaved, busy, approvals, laterUntil, required }) {
  if (!required && Number.isFinite(laterUntil) && /** @type {number} */ (laterUntil) > now) return { action: "hold" };
  if (locked !== true && !(idleSeconds >= AWAY_SECONDS)) return { action: "wait-away" };
  /** @type {Array<'unsaved' | 'busy' | 'approval'>} */
  const blockedBy = [];
  if (unsaved !== false) blockedBy.push("unsaved");
  if (busy !== false) blockedBy.push("busy");
  // A required update stops waiting on approvals, so a forgotten card can't keep a PC on an old version;
  // unsaved work and running work still hold it.
  if (!required && approvals !== 0) blockedBy.push("approval");
  if (blockedBy.length) return { action: "wait", blockedBy };
  return { action: locked === true ? "install" : "countdown" };
}

/** Any keyboard or mouse use since the countdown started resets the idle time below the time elapsed. */
export function countdownInterrupted({ idleSeconds, elapsedMs }) {
  return !(idleSeconds >= elapsedMs / 1000);
}

/**
 * The look an install takes before it stops the office service, and again just
 * before the installer starts: stopping the service can take 15 s. Clicks since
 * `since` (the safe-moment decision, or the person's "Restart now") count, and
 * the latest wins, so "Restart now" after "Later" still installs. An automatic
 * install also stops for anything that would have stopped its countdown: an
 * unsaved draft (or a window that did not answer) or keyboard and mouse use
 * while the screen is unlocked. Returns why it must not go ahead, or null.
 * @param {object} facts
 * @param {boolean} facts.automatic The safe-moment loop chose this install.
 * @param {number} facts.since
 * @param {number} facts.now
 * @param {boolean} facts.downloaded The same update is still the one on disk; false once a newer release replaces it.
 * @param {{ later?: number, notNow?: number, restartNow?: number }} [facts.clicks] When each was last clicked, epoch ms.
 * @param {boolean | null} [facts.unsaved]
 * @param {number} facts.idleSeconds
 * @param {boolean} facts.locked
 * @returns {null | 'newer' | 'later' | 'not-now' | 'unsaved' | 'returned'}
 */
export function handoffAbort({ automatic, since, now, downloaded, clicks = {}, unsaved, idleSeconds, locked }) {
  if (!downloaded) return "newer";
  const clicked = (/** @type {number | undefined} */ at) => (Number.isFinite(at) && /** @type {number} */ (at) >= since ? /** @type {number} */ (at) : -Infinity);
  const restartNow = clicked(clicks.restartNow), later = clicked(clicks.later), notNow = clicked(clicks.notNow);
  if (Math.max(later, notNow) > restartNow) return later >= notNow ? "later" : "not-now";
  // Never over unsaved work. The person's own restart goes ahead when the window can't answer,
  // and the click itself is input.
  if (unsaved === true) return "unsaved";
  if (!automatic || restartNow > -Infinity) return null;
  if (unsaved !== false) return "unsaved";
  if (locked !== true && countdownInterrupted({ idleSeconds, elapsedMs: now - since })) return "returned";
  return null;
}

/**
 * Whether the reason an install was put off has ended, from what was just
 * observed (undefined: not observed, so it stands). Its line then goes.
 * `cannot-record` ends when the schedule next saves.
 * @param {string | undefined} deferred
 * @param {{ unsaved?: boolean | null, activity?: { running: boolean, busy?: boolean } }} observed
 */
export function deferredEnded(deferred, { unsaved, activity }) {
  if (deferred === "unsaved") return unsaved === false;
  if (!activity) return false;
  if (deferred === "busy") return !(activity.running && activity.busy);
  // Stopped by the person: the next safe moment installs.
  if (deferred === "cannot-stop") return !activity.running;
  // Answering again: no longer on its way out, and the next attempt starts afresh.
  if (deferred === "still-running") return activity.running;
  return false;
}

/** "Restart now" while the office is busy keeps trying by itself for 10 minutes from the click. */
export function manualRetryAllowed({ now, requestedAt }) {
  return Number.isFinite(requestedAt) && now - requestedAt < MANUAL_RETRY_MS;
}

/**
 * The `restart` field of the updater state (docs/UPDATES-2026-10-10.md).
 * @param {RestartDecision} decision
 * @param {{ now: number, laterUntil?: number, required: boolean, requiredReason?: string, at?: number }} context
 */
export function restartState(decision, { now, laterUntil, required, requiredReason, at }) {
  /** @type {Record<string, unknown>} */
  const restart = { mode: decision.action === "wait" ? "waiting" : decision.action === "countdown" ? "countdown" : "when-away", required };
  if (decision.action === "countdown" && Number.isFinite(at)) restart.at = at;
  if (decision.action === "wait") restart.blockedBy = decision.blockedBy;
  if (!required && Number.isFinite(laterUntil) && /** @type {number} */ (laterUntil) > now) restart.laterUntil = laterUntil;
  if (required && requiredReason) restart.requiredReason = requiredReason;
  return restart;
}
