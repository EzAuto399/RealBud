// Keeping the office supervised after the last RealBud window closes.
//
// Why: on Windows, closing the last window used to quit the app. That released
// the keep-awake hold and stopped the crash watchdog, while the detached office
// service kept running with nobody watching it: a crash overnight, or the
// computer going to sleep, meant a missed morning run. The sign-in host
// (`--service`) had the same gap from the other side: it exited as soon as the
// service died instead of bringing it back.
//
// This module only DECIDES; main carries the decisions out. It never starts a
// service: recovery stays with the one watchdog (`service-watchdog.mjs`) and the
// one start-or-adopt path it calls, so staying in the background adds no second
// supervision loop and no second way to put two services on one data folder.
//
// What it promises: while RealBud is running in the background on a computer
// that is signed in, awake and plugged in, a crashed office service comes back
// on the same bounded schedule as with the window open. What it does not: a
// sign-out, a shutdown or a closed Mac lid still stops RealBud, and a deliberate
// Stop is never undone. Quitting RealBud (from its menu or notification-area
// icon) is still an explicit way to end supervision.

/**
 * Has the person asked for work to happen while nobody is looking?
 *
 * Any one of the three counts: starting the office service at sign-in, keeping
 * this computer awake for schedules, or an enabled schedule (which only runs if
 * something is there to run it). A deliberate Stop in this session outranks all
 * of them: there is nothing to supervise, and staying behind to watch a service
 * the person stopped would be the first step to undoing their decision.
 *
 * @param {object} state
 * @param {boolean} state.startOfficeServiceAtLogin
 * @param {boolean} state.keepAwakeForSchedules
 * @param {boolean} state.scheduleEnabled Last schedule state a window reported.
 * @param {boolean} state.stopRequested The person stopped the office service in this session.
 * @returns {boolean}
 */
export function unattendedWorkWanted({ startOfficeServiceAtLogin, keepAwakeForSchedules, scheduleEnabled, stopRequested }) {
  if (stopRequested === true) return false;
  return startOfficeServiceAtLogin === true || keepAwakeForSchedules === true || scheduleEnabled === true;
}

/**
 * What to do when the last window closes.
 *
 *  - `stay`: keep running as today (macOS keeps apps in the dock; the sign-in
 *    host never had a window). Supervision and keep-awake continue.
 *  - `background`: Windows with unattended work wanted — keep the process, its
 *    watchdog and its keep-awake hold, show a notification-area icon to reopen
 *    or quit.
 *  - `quit`: as before. A development build and a smoke run have no watchdog to
 *    keep; Linux has no login item or reliable tray, so it claims nothing.
 *
 * @param {object} state
 * @param {string} state.platform `process.platform`.
 * @param {boolean} state.serviceMode This process is the `--service` host.
 * @param {boolean} state.packaged `app.isPackaged`.
 * @param {boolean} state.smoke A packaged smoke run.
 * @param {boolean} state.quitting A quit is already under way.
 * @param {boolean} state.unattended `unattendedWorkWanted(...)`.
 * @returns {{ action: "stay" | "background" | "quit", reason: "service-host" | "mac" | "quitting" | "smoke" | "development" | "platform" | "not-opted-in" | "unattended-work" }}
 */
export function windowsClosedAction({ platform, serviceMode, packaged, smoke, quitting, unattended }) {
  if (serviceMode === true) return { action: "stay", reason: "service-host" };
  if (platform === "darwin") return { action: "stay", reason: "mac" };
  if (quitting === true) return { action: "quit", reason: "quitting" };
  if (smoke === true) return { action: "quit", reason: "smoke" };
  if (packaged !== true) return { action: "quit", reason: "development" };
  if (platform !== "win32") return { action: "quit", reason: "platform" };
  if (unattended !== true) return { action: "quit", reason: "not-opted-in" };
  return { action: "background", reason: "unattended-work" };
}

/**
 * Should a windowless RealBud (the sign-in host, or a window process running in
 * the background) end now, given the watchdog's latest decision?
 *
 * Only when there is provably nothing of ours left to supervise: no service is
 * answering and none is recorded for this data folder (a deliberate Stop clears
 * the record; so does a start that died while booting), or a deliberate Stop in
 * this process. Every other outcome — healthy, waiting out a backoff, a live but
 * silent process, the hourly limit reached — keeps supervising, because the
 * budget refills and the service may come back. A check that failed (`null`)
 * decides nothing.
 *
 * @param {{ reason: string } | null | undefined} decision From `watchdog.tick()`.
 * @returns {boolean}
 */
export function headlessHostShouldExit(decision) {
  if (!decision) return false;
  return decision.reason === "no-record" || decision.reason === "stopped-deliberately";
}

/**
 * What a second launch means to the process that holds the single-instance lock.
 *
 *  - A sign-in (`--service`) launch never steals focus or opens a window: this
 *    process is already running and supervising, so it is simply ignored.
 *  - A window exists: focus it.
 *  - No window, and this is the sign-in host: hand the lock to a window process
 *    (relaunch and quit), exactly as before.
 *  - No window, and this process is running in the background: open one here.
 *    Starting a second process would mean two supervisors deciding about one
 *    service; the office service itself is adopted, never started again.
 *
 * @param {object} state
 * @param {boolean} state.serviceMode This process is the `--service` host.
 * @param {boolean} state.incomingServiceMode The new launch carried `--service`.
 * @param {boolean} state.hasWindow This process has a window open.
 * @returns {"ignore" | "focus" | "hand-over" | "open-window"}
 */
export function secondInstanceAction({ serviceMode, incomingServiceMode, hasWindow }) {
  if (incomingServiceMode === true) return "ignore";
  if (hasWindow === true) return "focus";
  if (serviceMode === true) return "hand-over";
  return "open-window";
}
