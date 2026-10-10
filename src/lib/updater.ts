// Shared hook over the preload's updater bridge. Returns null in the
// browser / when the bridge is absent (dev) — callers render nothing then.
// onState emits the current state immediately on subscribe, so a component
// mounted after the download finished still sees "downloaded".
// The words for a downloaded update live here so the card, the status bar and
// the rail say the same thing (docs/UPDATES-2026-10-10.md).
import { useEffect, useState } from "react";
import { fmtTimeOfDay } from "@/lib/au";
import type { UpdaterState } from "@/types/ogb";

export type { UpdaterState };

const bridge = () => (typeof window === "undefined" ? undefined : window.ogb?.updater);

export function useUpdaterState(): UpdaterState | null {
  const [state, setState] = useState<UpdaterState | null>(null);
  useEffect(() => bridge()?.onState(setState), []);
  return bridge() ? state : null;
}

/** The countdown's end (epoch ms) while one runs. */
export function countdownAt(s: UpdaterState | null): number | undefined {
  const at = s?.restart?.mode === "countdown" ? s.restart.at : undefined;
  return typeof at === "number" && Number.isFinite(at) ? at : undefined;
}

/** Whole seconds until `at`, re-read each second while it is set; null without one. */
export function useSecondsLeft(at: number | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [at]);
  return at === undefined ? null : Math.max(0, Math.ceil((at - now) / 1_000));
}

const BUSY = "Bud is still working. RealBud will restart to update when the work finishes.";

/** What holds a waiting restart, in the person's words; null when nothing does. */
export function updateWaitingLine(s: UpdaterState): string | null {
  const blocked = s.restart?.mode === "waiting" ? s.restart.blockedBy ?? [] : [];
  if (blocked.includes("unsaved")) return "Save or discard your open draft first.";
  if (blocked.includes("approval")) return "Bud is waiting for you to answer or finish a step. RealBud restarts after that.";
  // Main's own sentence for a busy, stopping or unstoppable service, or a draft "Restart now" met.
  if (s.deferred && s.message) return s.message;
  if (s.deferred === "unsaved") return "Save or discard your open draft first.";
  if (s.deferred || blocked.includes("busy")) return BUSY;
  return null;
}

/** The one line under "{version} is ready". */
export function updateReadyLine(s: UpdaterState, now = Date.now()): string {
  const waiting = updateWaitingLine(s);
  if (waiting) return waiting;
  const restart = s.restart;
  // An older main never restarts by itself, so keep its plain instruction.
  if (!restart) return "Restart to finish updating.";
  if (restart.required) {
    if (restart.requiredReason === "unsupported") return "This version is no longer supported. RealBud restarts to update as soon as you’re away.";
    if (restart.requiredReason === "waited") return "This update has waited a day. RealBud restarts as soon as you’re away.";
    return "RealBud restarts to update as soon as you’re away.";
  }
  if (typeof restart.laterUntil === "number" && restart.laterUntil > now) return `Restarts after ${fmtTimeOfDay(restart.laterUntil)} when you’re away.`;
  return "RealBud restarts by itself when you’re away. Your work is kept.";
}

/** The status bar's and rail's short words for a downloaded update. */
export function updateStatusLine(s: UpdaterState, secondsLeft: number | null): string {
  if (s.restart?.mode === "countdown") return secondsLeft === null ? "Restarting to update" : `Restarting in ${secondsLeft} s`;
  if (s.deferred === "unsaved" || (s.restart?.mode === "waiting" && s.restart.blockedBy?.includes("unsaved"))) return "Update needs you";
  return s.restart ? "Update ready · restarts when you’re away" : "Update ready";
}
