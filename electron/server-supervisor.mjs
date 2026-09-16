// Supervises the realbud server child process for the desktop app.
//
// Why this exists: the server was forked once at boot and never watched. If it
// exited — crash, OOM, a port stolen by another process, a failed upgrade — the
// window kept pointing at a dead port and the office silently stopped serving
// shared work until somebody quit and reopened RealBud. That is the failure this
// module makes bounded and visible.
//
// What this deliberately does NOT do: keep the office running after RealBud
// quits. That needs an OS service (launchd on macOS, a Windows service or
// scheduled task), which is a separate, larger change — see H05 in
// docs/REALBUD-CORE-EXECUTION-2026-09-14.md.
//
// Restart safety:
// - Never restarts while a stop is in progress, so quitting cannot race a restart.
// - Bounded attempts in a rolling window, so a permanently broken install does
//   not spin forever.
// - Exponential backoff, so a failing child cannot saturate the machine.
// - Only one start in flight at a time.
export const DEFAULT_SUPERVISION = {
  /** Restart attempts allowed inside `windowMs` before giving up and surfacing failure. */
  maxRestarts: 3,
  /** Rolling window the attempt budget is measured over. */
  windowMs: 10 * 60_000,
  /** First retry delay; doubles per consecutive failure. */
  baseDelayMs: 1_000,
  /** Ceiling for the backoff delay. */
  maxDelayMs: 30_000,
};

/**
 * @param {object} options
 * @param {() => Promise<object|null>} options.start   Fork and wait for readiness; resolves the child, or null if it could not start.
 * @param {(child: object) => void} [options.kill]      Terminate a child that must be replaced.
 * @param {(status: object) => void} [options.onStatus] Observe lifecycle transitions (for logs and UI).
 * @param {(ms: number) => Promise<void>} [options.wait] Injectable timer.
 * @param {() => number} [options.now]                  Injectable clock.
 * @param {object} [options.supervision]                Override the bounds above.
 */
export function createServerSupervisor({
  start,
  kill = (child) => child?.kill?.(),
  onStatus = () => {},
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  supervision = {},
}) {
  const limits = { ...DEFAULT_SUPERVISION, ...supervision };
  /** @type {object|null} */
  let child = null;
  /** A stop is in progress; restarting is still possible afterwards. */
  let stopping = false;
  /**
   * The supervisor has been shut down for good (the app is quitting).
   *
   * This is separate from `stopping` because `restart()` must not be able to
   * revive supervision once shutdown has begun: a renderer click arriving during
   * quit would otherwise fork an orphaned service holding the office database.
   */
  let shutdown = false;
  let startInFlight = false;
  /** Timestamps of recent fork attempts, for the rolling window and backoff. */
  let attempts = [];
  let status = { state: "idle", restarts: 0, lastExitCode: null, exhausted: false };

  function publish(next) {
    status = { ...status, ...next };
    try {
      onStatus(status);
    } catch {
      /* observation must never break supervision */
    }
  }

  function withinWindow() {
    const cutoff = now() - limits.windowMs;
    attempts = attempts.filter((at) => at > cutoff);
    return attempts.length;
  }

  /**
   * Start the service, or restart it after an unexpected exit. Concurrent calls
   * share one attempt. Resolves true when a child is serving.
   *
   * Every start beyond the first is counted against the rolling budget before it
   * is attempted, so a child that dies repeatedly converges on `exhausted`
   * instead of looping forever.
   */
  async function ensureStarted() {
    if (stopping || shutdown) return false;
    if (child) return true;
    if (startInFlight) return startInFlight;

    // Every fork counts, including the first. Counting only restarts let a
    // service that failed to start at all retry indefinitely.
    if (withinWindow() >= limits.maxRestarts) {
      publish({ state: "exhausted", exhausted: true, restarts: attempts.length });
      return false;
    }
    const isRestart = attempts.length > 0;
    attempts.push(now());

    startInFlight = (async () => {
      publish({ state: isRestart ? "restarting" : "starting" });
      const next = await start();
      if (stopping || shutdown) {
        // A stop arrived while we were forking: do not adopt a child we must not keep.
        if (next) kill(next);
        return false;
      }
      if (!next) {
        publish({ state: "failed", restarts: attempts.length });
        scheduleRetry();
        return false;
      }
      child = next;
      publish({ state: "running", restarts: attempts.length, lastExitCode: null, exhausted: false });
      return true;
    })();

    try {
      return await startInFlight;
    } finally {
      startInFlight = false;
    }
  }

  function scheduleRetry() {
    if (stopping || shutdown) return;
    // Backoff is derived from how many forks have been spent, not from a
    // separate failure counter, so a failed start and an unexpected exit cannot
    // each advance the delay and overshoot the intended ceiling.
    const delay = Math.min(limits.baseDelayMs * 2 ** Math.max(0, attempts.length - 1), limits.maxDelayMs);
    void wait(delay).then(() => {
      if (stopping || child) return;
      void ensureStarted();
    });
  }

  /**
   * Report an unexpected exit. Returns true when a retry was scheduled. Ignored
   * once the supervisor is stopping, which is what keeps quit deterministic.
   *
   * The retry itself is counted by `ensureStarted`, so a child that never comes
   * up burns the budget and a child that dies repeatedly converges on exhaustion.
   */
  function notifyExit(code = null) {
    child = null;
    if (stopping || shutdown) return false;
    publish({ state: "exited", lastExitCode: code });
    if (withinWindow() >= limits.maxRestarts) {
      publish({ state: "exhausted", exhausted: true, restarts: attempts.length });
      return false;
    }
    scheduleRetry();
    return true;
  }

  /** Stop supervision and terminate the child. Idempotent; never restarts after. */
  async function stop() {
    stopping = true;
    // Terminal: nothing may revive supervision after this point.
    shutdown = true;
    const current = child;
    child = null;
    publish({ state: "stopped" });
    if (current) {
      try {
        kill(current);
      } catch {
        /* the process may already be gone */
      }
    }
  }

  /**
   * Explicit recovery after the budget is spent: clear the attempt history and
   * try once more. Returns true when the service is serving again.
   *
   * Refuses while a child is running so a retry can never fork a second service
   * alongside a healthy one — two authorities on one office database is worse
   * than the outage being recovered from.
   */
  async function restart() {
    if (child) return true;
    if (shutdown) return false;
    stopping = false;
    attempts = [];
    publish({ state: "retrying", restarts: 0, exhausted: false });
    // Allow one attempt past the usual ceiling: this is an explicit human action.
    return ensureStarted();
  }

  return {
    ensureStarted,
    notifyExit,
    stop,
    restart,
    /** Current child handle, or null. */
    current: () => child,
    getStatus: () => ({ ...status }),
    /** True when no further restart will be attempted without a fresh ensureStarted. */
    isStopping: () => stopping,
  };
}
