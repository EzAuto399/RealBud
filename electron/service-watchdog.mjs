// Bringing a crashed office service back while RealBud is running: with its
// window open, in the background after the window closed, or as the sign-in
// host (see unattended-host.mjs for when a windowless RealBud stays running).
//
// Why: the office service runs DETACHED so it outlives the window
// (`startDetachedService` in service-lifecycle.mjs). The in-app supervisor only
// ever managed a development child, so when the detached service crashed nothing
// noticed: the office stayed down until someone found "Start the office service"
// on You.
//
// What must never happen: two services on one data directory. So this module
// only DECIDES, from observations, and the one thing it may ask for is the same
// `startOrAdoptOfficeService()` a person's click uses, which adopts first and
// re-checks the recorded handle before it spawns anything. It never signals a
// process, never reads a pid as authority, and never picks a port.
//
// A restart is considered only when every observation agrees the service is
// gone: a handle is recorded for this data directory, its process is not alive,
// nothing of this installation answers /api/health (on any of its ports, or on
// the recorded port), nobody asked for it to stop, no start is already in flight
// and the app is not quitting. A live process that does not answer may be a slow
// start or a hang; starting beside it is the exact duplicate this design exists
// to prevent, so that case is left to the person and the existing banner.
//
// Bounded: 5 s, 30 s, then 2 min between attempts (a minimum; the check runs on
// a fixed tick), and no more than 5 attempts in any hour. After that the banner
// and its Start button are in charge again.

export const WATCHDOG_DEFAULTS = Object.freeze({
  /** How often main checks the office service. */
  tickMs: 10_000,
  /** Minimum wait before the 1st, 2nd and every later attempt in the budget window. */
  backoffMs: Object.freeze([5_000, 30_000, 120_000]),
  /** Attempts allowed inside `windowMs` before automatic restarts pause. */
  maxRestarts: 5,
  windowMs: 60 * 60_000,
});

/** @typedef {typeof WATCHDOG_DEFAULTS} WatchdogLimits */

/** @typedef {object} WatchdogObservation
 * @property {boolean} quitting The app is on its way out.
 * @property {boolean} stopRequested The person deliberately stopped the service in this session.
 * @property {boolean} startInFlight A start or adopt is already running.
 * @property {number | null} answeringPort Port on which this installation's service answers, or null.
 * @property {number} currentPort The port the window loads.
 * @property {boolean} recorded A service handle is recorded for this data directory.
 * @property {boolean} recordedAlive The recorded service process is alive.
 * @property {boolean} recordedPortAnswers The recorded port answers with this installation's identity.
 */

/** @typedef {object} WatchdogHistory
 * @property {readonly number[]} attempts Start times of automatic restart attempts.
 * @property {number | null} downSince When the current outage was first observed.
 */

/** @typedef {'none' | 'wait' | 'adopt' | 'restart'} WatchdogAction */
/** @typedef {'quitting' | 'stopped-deliberately' | 'start-in-flight' | 'healthy' | 'answering-elsewhere' | 'no-record' | 'process-alive' | 'recorded-port-answers' | 'exhausted' | 'backoff' | 'service-down'} WatchdogReason */

/** @type {WatchdogHistory} */
export const EMPTY_WATCHDOG_HISTORY = Object.freeze({ attempts: Object.freeze([]), downSince: null });

/**
 * Decide what to do about the office service right now. Pure: the next history
 * is returned, never stored.
 *
 * @param {WatchdogObservation} observation
 * @param {WatchdogHistory} [history]
 * @param {number} [now]
 * @param {WatchdogLimits} [limits]
 * @returns {{ action: WatchdogAction, reason: WatchdogReason, retryAt?: number, history: WatchdogHistory }}
 */
export function decideServiceRestart(observation, history = EMPTY_WATCHDOG_HISTORY, now = Date.now(), limits = WATCHDOG_DEFAULTS) {
  const attempts = history.attempts.filter((at) => at > now - limits.windowMs && at <= now);
  /** @param {number | null} downSince */
  const keep = (downSince) => ({ attempts, downSince });

  if (observation.quitting) return { action: "none", reason: "quitting", history: keep(null) };
  // The person's decision outranks every observation. Their Start clears it.
  if (observation.stopRequested) return { action: "none", reason: "stopped-deliberately", history: keep(null) };
  // Someone is already starting it; an attempt here would be counted but add nothing.
  if (observation.startInFlight) return { action: "none", reason: "start-in-flight", history: keep(history.downSince) };

  if (observation.answeringPort !== null) {
    if (observation.answeringPort === observation.currentPort) return { action: "none", reason: "healthy", history: keep(null) };
    // Ours, but on a port this window does not use: another session started it.
    // Adopt it; starting one here would be the second service.
    return { action: "adopt", reason: "answering-elsewhere", history: keep(null) };
  }

  // Without a record there is no evidence a service of ours was running here: a
  // deliberate stop clears it, and so does a start that exited while booting.
  if (!observation.recorded) return { action: "none", reason: "no-record", history: keep(null) };
  // Alive but silent: still opening the company database, or hung. Never start beside it.
  if (observation.recordedAlive) return { action: "none", reason: "process-alive", history: keep(null) };
  // Something of ours serves the recorded port under another process. Starting
  // would pick a second port for a second service.
  if (observation.recordedPortAnswers) return { action: "none", reason: "recorded-port-answers", history: keep(null) };

  const downSince = history.downSince ?? now;
  if (attempts.length >= limits.maxRestarts) return { action: "none", reason: "exhausted", history: keep(downSince) };
  const delay = limits.backoffMs[Math.min(attempts.length, limits.backoffMs.length - 1)];
  const lastAttempt = attempts.length ? attempts[attempts.length - 1] : -Infinity;
  const retryAt = Math.max(downSince, lastAttempt) + delay;
  if (now < retryAt) return { action: "wait", reason: "backoff", retryAt, history: keep(downSince) };
  // Counted before it is attempted, so a start that hangs or fails still spends budget.
  return { action: "restart", reason: "service-down", history: { attempts: [...attempts, now], downSince } };
}

/** @param {number} a @param {number} b */
function sameLocalDay(a, b) {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** @type {Partial<Record<WatchdogReason, string>>} */
const TRANSITION_LOG = {
  "stopped-deliberately": "the office service was stopped deliberately; not restarting it automatically",
  "no-record": "no office service is recorded for this computer; not restarting one automatically",
  "process-alive": "the office service process is alive but not answering; not starting another beside it",
  "recorded-port-answers": "another office service of this installation holds the recorded port; not starting another",
  backoff: "the office service is not answering and its process has ended; restarting it automatically after the backoff",
  exhausted: "automatic restarts of the office service have paused after reaching the hourly limit; the Start button is in charge",
};

/**
 * The stateful half: one check at a time, bounded history, a status for You.
 *
 * @param {object} options
 * @param {() => Promise<WatchdogObservation>} options.observe Gather the facts. May throw; a failed check does nothing.
 * @param {() => Promise<boolean>} options.startOrAdopt Main's single-authority start. Resolves true when a service of ours answers.
 * @param {(port: number) => void} [options.adopt] Record a service of ours answering on another port.
 * @param {(line: string) => void} [options.log]
 * @param {() => number} [options.now]
 * @param {WatchdogLimits} [options.limits]
 */
export function createServiceWatchdog({ observe, startOrAdopt, adopt = () => {}, log = () => {}, now = Date.now, limits = WATCHDOG_DEFAULTS }) {
  /** @type {WatchdogHistory} */
  let history = EMPTY_WATCHDOG_HISTORY;
  let checking = false;
  let restarting = false;
  let stopped = false;
  /** Successful automatic restarts, kept for two days so "today" is always answerable. */
  /** @type {number[]} */
  let restarted = [];
  /** @type {{ at: number | null, result: 'started' | 'failed' | null, reason: WatchdogReason | null }} */
  let last = { at: null, result: null, reason: null };
  /** @type {ReturnType<typeof decideServiceRestart> | null} */
  let lastDecision = null;

  /** @param {unknown} error */
  const message = (error) => (error instanceof Error ? error.message : String(error));

  /** Run one check. Overlapping calls return null instead of queueing. */
  async function tick() {
    if (stopped || checking) return null;
    checking = true;
    try {
      const observation = await observe();
      if (stopped) return null;
      const at = now();
      const decision = decideServiceRestart(observation, history, at, limits);
      const previous = lastDecision?.reason ?? null;
      history = decision.history;
      lastDecision = decision;
      if (decision.reason !== previous) {
        const line = TRANSITION_LOG[decision.reason];
        if (line) log(line);
        else if (decision.reason === "healthy" && previous !== null && previous !== "start-in-flight") log("the office service is answering again");
      }
      if (decision.action === "adopt" && observation.answeringPort !== null) {
        log(`the office service of this installation is answering on port ${observation.answeringPort}; adopting it rather than starting another`);
        adopt(observation.answeringPort);
      }
      if (decision.action === "restart") {
        const attempt = decision.history.attempts.length;
        last = { at, result: null, reason: decision.reason };
        log(`the office service stopped unexpectedly; restarting it automatically (attempt ${attempt} of ${limits.maxRestarts} this hour)`);
        restarting = true;
        let ok = false;
        try {
          ok = (await startOrAdopt()) === true;
        } catch (error) {
          log(`the automatic restart failed: ${message(error)}`);
        } finally {
          restarting = false;
        }
        last = { ...last, result: ok ? "started" : "failed" };
        if (ok) {
          restarted = [...restarted.filter((t) => t > now() - 2 * 86_400_000), at];
          log("the office service was restarted automatically");
        } else {
          log("the automatic restart did not bring the office service back");
        }
      }
      return decision;
    } catch (error) {
      log(`the office service check failed: ${message(error)}`);
      return null;
    } finally {
      checking = false;
    }
  }

  /** What You shows: restarts today, and whether automatic recovery is pending or paused. */
  function status() {
    const at = now();
    return {
      today: restarted.filter((t) => sameLocalDay(t, at)).length,
      lastAt: last.at,
      lastResult: last.result,
      lastReason: lastDecision?.reason === "exhausted" ? "exhausted" : last.reason,
      pending: restarting || lastDecision?.action === "wait",
      exhausted: lastDecision?.reason === "exhausted",
    };
  }

  /** Stop for good (the app is quitting). An in-flight check finishes without acting. */
  function stop() {
    stopped = true;
  }

  return { tick, status, stop };
}
