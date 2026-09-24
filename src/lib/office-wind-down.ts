// Wind-down for a named office: the sequence that ends with the book being
// unreadable, and the guard that decides when that is allowed.
//
// The book is AES-256-GCM and its key is wrapped by the OS keychain
// (electron/main.mjs), so "the office has ended" is not a delete — it is the
// destruction of one key. That makes the timing the dangerous part: destroying
// the key early is unrecoverable, so eligibility is computed here, pure and
// testable, rather than left to whoever runs the tool.
//
// RealBud is not a lawyer and must never invent a statutory clock. The window
// below is the office's own recorded choice, and `null` means keep forever
// until a person decides.

import { parseRetentionDays } from "../../shared/office";

/** How far the wind-down has been taken. Ordered. */
export const WIND_DOWN_STAGES = ["open", "stopped", "exported", "archived", "destroyed"] as const;
export type WindDownStage = (typeof WIND_DOWN_STAGES)[number];

const ORDER: Record<WindDownStage, number> = {
  open: 0,
  stopped: 1,
  exported: 2,
  archived: 3,
  destroyed: 4,
};

export interface WindDownState {
  stage: WindDownStage;
  /** When the office stopped working (stage moved past "open"), ms epoch. */
  closedAt: number | null;
  retentionDays: number | null;
}

/** Default state for a live office. */
export function openWindDown(): WindDownState {
  return { stage: "open", closedAt: null, retentionDays: null };
}

export type AdvanceResult =
  | { ok: true; state: WindDownState }
  | { ok: false; error: string };

/**
 * Move one stage along the sequence. Stages cannot be skipped: a book must be
 * exported before it is archived, and archived before its key is destroyed.
 * Going backwards is refused rather than silent, because a wind-down that
 * appears to rewind would hide work that was already reported as done.
 */
export function advanceWindDown(state: WindDownState, to: WindDownStage, now: number): AdvanceResult {
  const from = state.stage;
  if (to === from) return { ok: false, error: `This office is already at "${from}".` };
  if (ORDER[to] < ORDER[from]) {
    return { ok: false, error: `A wind-down cannot go back from "${from}" to "${to}".` };
  }
  if (ORDER[to] > ORDER[from] + 1) {
    return { ok: false, error: `Skipping from "${from}" to "${to}" would claim work that was never done.` };
  }
  const closedAt = from === "open" ? now : state.closedAt;
  return { ok: true, state: { ...state, stage: to, closedAt } };
}

/** Days elapsed since the office stopped, or null while it is still open. */
export function daysSinceClosed(state: WindDownState, now: number): number | null {
  if (state.closedAt === null) return null;
  const elapsed = now - state.closedAt;
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  return Math.floor(elapsed / 86_400_000);
}

export interface DestructionEligibility {
  /** True only when destroying the key is permitted right now. */
  allowed: boolean;
  /** Why it is not yet allowed, in the words a person can act on. */
  reason: string;
  /** When it becomes allowed, ms epoch, or null when it never will by policy. */
  eligibleAt: number | null;
  daysRemaining: number | null;
}

/**
 * Whether this office's book key may be destroyed yet.
 *
 * Fails closed at every branch: unknown retention is not "no retention", an
 * unparseable window is not zero, and a book that was never archived is not
 * eligible however long ago it closed. The only way to reach `allowed` is a
 * recorded window that has actually elapsed on an archived book.
 */
export function destructionEligibility(state: WindDownState, now: number): DestructionEligibility {
  const notAllowed = (reason: string, eligibleAt: number | null = null, daysRemaining: number | null = null): DestructionEligibility =>
    ({ allowed: false, reason, eligibleAt, daysRemaining });

  if (state.stage === "destroyed") return notAllowed("This office's book key has already been destroyed.");
  if (state.stage !== "archived") {
    return notAllowed(`The book must be archived before its key can be destroyed. This office is at "${state.stage}".`);
  }
  if (state.closedAt === null) return notAllowed("This office has no recorded closing date, so no retention window can be measured.");

  const parsed = parseRetentionDays(state.retentionDays);
  if (!parsed.ok) return notAllowed(parsed.error);
  if (parsed.value === null) {
    // Keep-until-decided is deliberate: never destroy on a timer here.
    return notAllowed("This office keeps its book until a person decides. Destroying the key is a separate, manual decision.");
  }

  const eligibleAt = state.closedAt + parsed.value * 86_400_000;
  if (now < eligibleAt) {
    const daysRemaining = Math.ceil((eligibleAt - now) / 86_400_000);
    return notAllowed(
      `Retention runs for ${parsed.value} more day(s): only ${daysSinceClosed(state, now)} of ${parsed.value} have passed.`,
      eligibleAt,
      daysRemaining,
    );
  }
  return { allowed: true, reason: `Retention of ${parsed.value} days has elapsed.`, eligibleAt, daysRemaining: 0 };
}

/** One line an operator can read, whatever stage the office is at. */
export function windDownSummary(state: WindDownState, now: number): string {
  const days = daysSinceClosed(state, now);
  if (state.stage === "open") return "Open. This office is still working.";
  if (state.stage === "destroyed") return "Closed. The book key was destroyed and the book is no longer readable.";
  const parts = [`Stage: ${state.stage}.`];
  if (days !== null) parts.push(`Closed ${days} day(s) ago.`);
  const eligibility = destructionEligibility(state, now);
  parts.push(eligibility.allowed ? "The key may now be destroyed." : eligibility.reason);
  return parts.join(" ");
}
