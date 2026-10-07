// The day's REI Cloud sign-in (GET/POST /api/rei/sign-in, server/rei-sign-in.ts): one shared
// read behind Desk's card and the status bar. A malformed or failed read is "not read", never a
// sign-in fact. "Sign in to REI" opens REI's own sign-in page in the work browser; the person
// types their password there, so nothing here touches a password.
import { useEffect, useSyncExternalStore } from "react";
import { api, useStore } from "@/state/store";
import { DESIGN_PREVIEW_REASON } from "@/lib/design-preview";

export interface ReiSignIn {
  state: "needed" | "signed_in" | "unknown";
  at: number | null;
  waiting: Array<{ loopId: string; name: string }>;
  used: boolean;
  /** REI's sign-in page is open in the work browser now, waiting for the person. */
  signingIn: boolean;
}

export function parseReiSignIn(value: unknown): ReiSignIn | null {
  const raw = value as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object" || !["needed", "signed_in", "unknown"].includes(raw.state as string) || typeof raw.used !== "boolean" || typeof raw.signingIn !== "boolean") return null;
  if (!(raw.at === null || (typeof raw.at === "number" && Number.isFinite(raw.at)))) return null;
  if (!Array.isArray(raw.waiting) || !raw.waiting.every(item => item && typeof item === "object" && typeof item.loopId === "string" && typeof item.name === "string")) return null;
  return { state: raw.state as ReiSignIn["state"], at: raw.at as number | null, used: raw.used, signingIn: raw.signingIn,
    waiting: (raw.waiting as ReiSignIn["waiting"]).slice(0, 6).map(item => ({ loopId: item.loopId, name: item.name.slice(0, 80) })) };
}

/** "Bud is waiting to finish Bank reference review and REI morning refresh." */
export function reiWaitingLine(view: ReiSignIn): string {
  const names = view.waiting.map(item => item.name);
  if (!names.length) return "REI signed you out. Sign in so Bud can read REI today.";
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Bud is waiting to finish ${list}.`;
}

export interface ReiSignInStore {
  view: ReiSignIn | null;
  /** The POST is in flight: shown at once, before the work browser answers. */
  opening: boolean;
  /** REI's sign-in page was opened (or brought forward) from here. */
  opened: boolean;
  /** Seen signed in after REI needed a sign-in, until dismissed. */
  justSignedIn: boolean;
  error: string;
}

let current: ReiSignInStore = { view: null, opening: false, opened: false, justSignedIn: false, error: "" };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
const set = (next: Partial<ReiSignInStore>) => { current = { ...current, ...next }; for (const listener of listeners) listener(); };

function accept(view: ReiSignIn | null) {
  // Seen going from "sign in needed" (or opened from here) to signed in: say so once, until dismissed.
  const signedInNow = view?.state === "signed_in" && (current.opened || current.view?.state === "needed");
  set({ view, ...(signedInNow ? { justSignedIn: true, opened: false } : {}) });
}

/** One read now; while REI needs signing in (or the page was just opened) it reads again every 3 s, else every minute. */
export function refreshReiSignIn(): void {
  if (DESIGN_PREVIEW_REASON || !listeners.size) return;
  const request = ++generation;
  clearTimeout(timer);
  void api("/api/rei/sign-in", undefined, { timeoutMs: 10_000 })
    .then(parseReiSignIn, () => null)
    .then(view => {
      if (request !== generation) return;
      accept(view);
      if (!listeners.size) return;
      const soon = current.opening || current.opened || view?.state === "needed";
      timer = setTimeout(refreshReiSignIn, soon ? 3_000 : 60_000);
    });
}

/** Desk's one action: open REI's sign-in page in the work browser, or bring the one already open forward. */
export async function startReiSignIn(): Promise<void> {
  if (current.opening) return;
  generation++;
  set({ opening: true, error: "", justSignedIn: false });
  try {
    accept(parseReiSignIn(await api("/api/rei/sign-in", { method: "POST", body: "{}" }, { timeoutMs: 30_000 })));
    set({ opening: false, opened: current.view?.state !== "signed_in" });
  } catch (cause) {
    set({ opening: false, error: cause instanceof Error ? cause.message : "REI's sign-in page could not be opened. Try again." });
  }
  refreshReiSignIn();
}

export function dismissReiSignedIn(): void { set({ justSignedIn: false }); }

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) refreshReiSignIn();
  return () => { listeners.delete(listener); if (!listeners.size) clearTimeout(timer); };
}

/** The shared REI line; re-read when a loop run changes (a run starting to wait at REI sign-in shows at once). */
export function useReiSignIn(): ReiSignInStore {
  const { state } = useStore();
  const value = useSyncExternalStore(subscribe, () => current, () => current);
  useEffect(() => { if (state.connected) refreshReiSignIn(); }, [state.connected, state.loopRuns]);
  return value;
}
