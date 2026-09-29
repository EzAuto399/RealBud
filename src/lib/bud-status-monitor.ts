import { useEffect, useRef, useSyncExternalStore } from "react";

const CHECK_INTERVAL_MS = 15_000;
const MAX_RETRY_INTERVAL_MS = 60_000;
const CHECK_ERROR = "Bud's status could not be checked. Your draft is kept. Try again.";

export type BudStatusRefresh = (isCurrent: () => boolean) => Promise<void>;
export interface BudStatusMonitorSnapshot {
  pending: boolean;
  error: string | null;
  lastCheckedAt: number | null;
}

/** Observe local setup only. The callback must read status, never run a model,
 * repair setup or perform another mutation. Guard its publication with
 * `isCurrent()` so a result from a closed or disabled view cannot replace state. */
export function createBudStatusMonitor(options: {
  onRefresh: BudStatusRefresh;
  visible: () => boolean;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let enabled = false;
  let generation = 0;
  let failures = 0;
  let nextCheckAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flight: Promise<void> | null = null;
  let snapshot: BudStatusMonitorSnapshot = { pending: false, error: null, lastCheckedAt: null };
  const listeners = new Set<() => void>();

  const publish = (next: BudStatusMonitorSnapshot) => {
    snapshot = next;
    listeners.forEach(listener => listener());
  };
  const clearTimer = () => { clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    clearTimer();
    if (!enabled || flight || !options.visible()) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (options.visible()) void refresh();
    }, Math.max(0, nextCheckAt - now()));
  };
  function refresh(): Promise<void> {
    if (!enabled) return Promise.resolve();
    if (flight) return flight;
    clearTimer();
    const requestGeneration = generation;
    const isCurrent = () => enabled && generation === requestGeneration;
    // A pending retry is not evidence that an earlier failure recovered.
    publish({ ...snapshot, pending: true });
    const request = Promise.resolve().then(() => {
      if (isCurrent()) return options.onRefresh(isCurrent);
    }).then(() => {
      if (!isCurrent()) return;
      failures = 0;
      nextCheckAt = now() + CHECK_INTERVAL_MS;
      publish({ pending: false, error: null, lastCheckedAt: now() });
    }).catch(() => {
      if (!isCurrent()) return;
      failures += 1;
      nextCheckAt = now() + Math.min(CHECK_INTERVAL_MS * 2 ** Math.min(failures - 1, 2), MAX_RETRY_INTERVAL_MS);
      publish({ ...snapshot, pending: false, error: CHECK_ERROR });
    }).finally(() => {
      if (flight === request) flight = null;
      // Re-enabling while an old read finishes waits for that read; only the
      // new generation may publish, and only one request runs at a time.
      schedule();
    });
    flight = request;
    return request;
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setEnabled(next: boolean) {
      if (next === enabled) return;
      enabled = next;
      generation += 1;
      clearTimer();
      if (!next) {
        if (snapshot.pending) publish({ ...snapshot, pending: false });
        return;
      }
      nextCheckAt = 0;
      schedule();
    },
    /** Focus/online/visibility events respect the existing check and backoff
     * deadline. Repeated focus events cannot create a fast retry loop. */
    wake: schedule,
    invalidate() {
      generation += 1;
      nextCheckAt = 0;
      schedule();
    },
    refresh,
  };
}

/** Ask and the status panel share one read and one timer. If the view whose
 * callback owns a read leaves, retire it before another view publishes. */
export function createSharedBudStatusMonitor(options: {
  visible: () => boolean;
  listen?: (wake: () => void) => () => void;
}) {
  const callbacks = new Map<symbol, BudStatusRefresh>();
  let observerRevision = 0;
  let stopListening: (() => void) | undefined;
  const monitor = createBudStatusMonitor({
    visible: options.visible,
    onRefresh: isCurrent => {
      const callback = [...callbacks.values()].at(-1);
      return callback ? callback(isCurrent) : Promise.resolve();
    },
  });
  return {
    ...monitor,
    hasObservers: () => callbacks.size > 0,
    observerRevision: () => observerRevision,
    register(onRefresh: BudStatusRefresh) {
      const id = Symbol();
      callbacks.set(id, onRefresh);
      observerRevision += 1;
      if (callbacks.size === 1) {
        stopListening = options.listen?.(monitor.wake);
        monitor.setEnabled(true);
      }
      return () => {
        if (!callbacks.delete(id)) return;
        observerRevision += 1;
        if (!callbacks.size) {
          monitor.setEnabled(false);
          stopListening?.(); stopListening = undefined;
        } else monitor.invalidate();
      };
    },
  };
}

const sharedMonitor = createSharedBudStatusMonitor({
  visible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
  listen: wake => {
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  },
});

/** The store's legacy focus probe defers while an active status view owns it. */
export function hasBudStatusObservers() { return sharedMonitor.hasObservers(); }
export function budStatusObserverRevision() { return sharedMonitor.observerRevision(); }

/** Read shared health without starting another status observer. */
export function useBudStatusSnapshot() {
  return useSyncExternalStore(sharedMonitor.subscribe, sharedMonitor.getSnapshot, sharedMonitor.getSnapshot);
}

/** Cached hidden panels pass false. All active views receive the same result. */
export function useBudStatusMonitor({ enabled, onRefresh }: {
  enabled: boolean;
  onRefresh: BudStatusRefresh;
}) {
  const latest = useRef(onRefresh);
  latest.current = onRefresh;
  const snapshot = useBudStatusSnapshot();
  useEffect(() => {
    if (!enabled) return;
    return sharedMonitor.register(isCurrent => latest.current(isCurrent));
  }, [enabled]);
  return { ...snapshot, refresh: sharedMonitor.refresh };
}
