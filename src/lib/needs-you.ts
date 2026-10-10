import { useEffect, useSyncExternalStore } from 'react';
import { api } from '@/state/store';
import { parseNeedsYouSnapshot, type NeedsYouSnapshot } from '@shared/needs-you';

/** Window event: something Needs you projects may have changed (a job run, a Desk change, a decision in an area). */
export const NEEDS_YOU_STALE = 'realbud:needs-you-stale';
const REFRESH_MS = 120_000;
const CHECK_ERROR = 'Needs you could not be checked. Refresh to try again.';

/** The last good snapshot stays on screen after a failed read, with the error beside it. */
export type NeedsYouState = { snapshot: NeedsYouSnapshot | null; error: string | null; checking: boolean };
let state: NeedsYouState = { snapshot: null, error: null, checking: false };
const listeners = new Set<() => void>();
let flight: Promise<void> | null = null;
let again = false;

const publish = (next: Partial<NeedsYouState>) => { state = { ...state, ...next }; listeners.forEach(listener => listener()); };
export const getNeedsYou = () => state;
export function subscribeNeedsYou(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

/** One read at a time. A request during a read runs once more after it, so the latest change is never missed. */
export function refreshNeedsYou(): Promise<void> {
  if (flight) { again = true; return flight; }
  publish({ checking: true });
  flight = api('/api/needs-you').then(
    body => publish({ snapshot: parseNeedsYouSnapshot(body), error: null }),
    error => publish({ error: error instanceof Error && error.message ? error.message : CHECK_ERROR }),
  ).catch(() => publish({ error: CHECK_ERROR })).finally(() => {
    flight = null;
    publish({ checking: false });
    if (again) { again = false; void refreshNeedsYou(); }
  });
  return flight;
}

/** Desk and its tabs share one read: on show, on focus, when a Desk event marks it stale, and every two minutes while visible. */
export function useNeedsYou(active = true): NeedsYouState {
  useEffect(() => {
    if (!active) return;
    const wake = () => { if (document.visibilityState !== 'hidden') void refreshNeedsYou(); };
    wake();
    const timer = setInterval(wake, REFRESH_MS);
    window.addEventListener('focus', wake);
    window.addEventListener(NEEDS_YOU_STALE, wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', wake);
      window.removeEventListener(NEEDS_YOU_STALE, wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [active]);
  return useSyncExternalStore(subscribeNeedsYou, getNeedsYou, getNeedsYou);
}
