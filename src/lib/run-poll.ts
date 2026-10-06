// Polling for a server-owned run (the bank import, Refresh from REI) while Bud
// works or waits. A failed read keeps polling with a bounded backoff, so a
// service blip never freezes a panel on its last answer: the next read that
// works shows the server's real state again.
import { useEffect } from "react";

export const POLL_MAX_MS = 5_000;

/** Calls `load` every `intervalMs` until stopped; after failures it waits longer, up to POLL_MAX_MS. One read at a time. */
export function startRunPoll(load: () => Promise<unknown>, intervalMs: number): () => void {
  let stopped = false, failures = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    try { await load(); failures = 0; } catch { failures++; }
    if (!stopped) timer = setTimeout(tick, Math.min(intervalMs * 2 ** failures, POLL_MAX_MS));
  };
  timer = setTimeout(tick, intervalMs);
  return () => { stopped = true; clearTimeout(timer); };
}

/** Polls while `active`. `load` must be stable (useCallback) and update the caller's state. */
export function useRunPoll(active: boolean, load: () => Promise<unknown>, intervalMs: number) {
  useEffect(() => active ? startRunPoll(load, intervalMs) : undefined, [active, load, intervalMs]);
}
