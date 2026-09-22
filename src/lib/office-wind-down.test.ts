import { describe, expect, it } from "vitest";

import {
  advanceWindDown,
  daysSinceClosed,
  destructionEligibility,
  openWindDown,
  windDownSummary,
  type WindDownState,
} from "./office-wind-down";
import { MAX_RETENTION_DAYS, MIN_RETENTION_DAYS } from "../../shared/office";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

/** Walk a fresh office to a stage, asserting each step is accepted. */
function windDownTo(stage: "stopped" | "exported" | "archived" | "destroyed", retentionDays: number | null) {
  let state = openWindDown();
  const path = (["stopped", "exported", "archived", "destroyed"] as const).slice(
    0,
    (["stopped", "exported", "archived", "destroyed"] as const).indexOf(stage) + 1,
  );
  for (const next of path) {
    const result = advanceWindDown(state, next, NOW);
    if (!result.ok) throw new Error(result.error);
    state = result.state;
  }
  return { ...state, retentionDays };
}

describe("office wind-down", () => {
  it("starts open with no closing date", () => {
    const state = openWindDown();
    expect(state.stage).toBe("open");
    expect(state.closedAt).toBeNull();
    expect(daysSinceClosed(state, NOW)).toBeNull();
  });

  it("records the closing date when the office stops, and keeps it", () => {
    const stopped = advanceWindDown(openWindDown(), "stopped", NOW);
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) return;
    expect(stopped.state.closedAt).toBe(NOW);
    const later = advanceWindDown(stopped.state, "exported", NOW + DAY);
    expect(later.ok).toBe(true);
    if (!later.ok) return;
    // Closing date is when work stopped, not when the last stage ran.
    expect(later.state.closedAt).toBe(NOW);
  });

  it("refuses to skip a stage", () => {
    // Skipping would let an operator report "archived" for a book never exported.
    const result = advanceWindDown(openWindDown(), "archived", NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/never done/);
  });

  it("refuses to rewind", () => {
    const archived = windDownTo("archived", 90);
    const result = advanceWindDown(archived, "exported", NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/cannot go back/);
  });

  it("refuses to repeat the current stage", () => {
    const result = advanceWindDown(windDownTo("exported", 90), "exported", NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/already/);
  });

  it("refuses to destroy the key before the book is archived", () => {
    // The safety property: no amount of elapsed time substitutes for archiving.
    const exported = windDownTo("exported", 7);
    const eligibility = destructionEligibility(exported, NOW + 365 * DAY);
    expect(eligibility.allowed).toBe(false);
    expect(eligibility.reason).toMatch(/archived/);
  });

  it("refuses to destroy the key before the retention window has elapsed", () => {
    const archived = windDownTo("archived", 90);
    const eligibility = destructionEligibility(archived, NOW + 89 * DAY);
    expect(eligibility.allowed).toBe(false);
    expect(eligibility.daysRemaining).toBeGreaterThan(0);
    expect(eligibility.eligibleAt).toBe(NOW + 90 * DAY);
  });

  it("allows destruction once the window has elapsed", () => {
    const archived = windDownTo("archived", 90);
    expect(destructionEligibility(archived, NOW + 90 * DAY).allowed).toBe(true);
    expect(destructionEligibility(archived, NOW + 900 * DAY).allowed).toBe(true);
  });

  it("never destroys a book that is kept until a person decides", () => {
    const archived = windDownTo("archived", null);
    const eligibility = destructionEligibility(archived, NOW + 100 * MAX_RETENTION_DAYS * DAY);
    expect(eligibility.allowed).toBe(false);
    expect(eligibility.eligibleAt).toBeNull();
    expect(eligibility.reason).toMatch(/until a person decides/);
  });

  it("fails closed when the recorded window is unusable", () => {
    // A corrupt or absurd value must not read as "no retention, destroy now".
    for (const bad of [0, -1, 6, MAX_RETENTION_DAYS + 1, 90.5, Number.NaN]) {
      const eligibility = destructionEligibility(windDownTo("archived", bad as number), NOW + 100 * 365 * DAY);
      expect(eligibility.allowed, `retention ${bad} must not permit destruction`).toBe(false);
    }
  });

  it("does not permit destruction twice", () => {
    const destroyed = windDownTo("destroyed", 7);
    const eligibility = destructionEligibility(destroyed, NOW + 100 * DAY);
    expect(eligibility.allowed).toBe(false);
    expect(eligibility.reason).toMatch(/already been destroyed/);
  });

  it("treats a closing date in the future as unmeasurable rather than elapsed", () => {
    const archived: WindDownState = { stage: "archived", closedAt: NOW + DAY, retentionDays: MIN_RETENTION_DAYS };
    expect(daysSinceClosed(archived, NOW)).toBeNull();
    expect(destructionEligibility(archived, NOW).allowed).toBe(false);
  });

  it("describes each stage in one readable line", () => {
    expect(windDownSummary(openWindDown(), NOW)).toMatch(/still working/);
    const archived = windDownTo("archived", 90);
    expect(windDownSummary(archived, NOW + DAY)).toMatch(/Stage: archived/);
    expect(windDownSummary(archived, NOW + 90 * DAY)).toMatch(/may now be destroyed/);
    expect(windDownSummary(windDownTo("destroyed", 90), NOW + 900 * DAY)).toMatch(/no longer readable/);
  });
});
