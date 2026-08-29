import { describe, expect, it } from "vitest";

import { deskCopyPulse, RECHECK_GRAPH_LINGER_MS, recheckBeatMs, recheckButtonLabel, recheckLandCaption, recheckLandRevealed } from "./desk-motion";

describe("Desk motion cues", () => {
  it("pulses Copy after the wording is copied, not after Allow", () => {
    expect(deskCopyPulse("Wording copied")).toBe(true);
    expect(deskCopyPulse("Wording allowed")).toBe(false);
    expect(deskCopyPulse("Recheck finished")).toBe(false);
    expect(deskCopyPulse("")).toBe(false);
  });

  it("names Recheck as Checking while the book is being checked", () => {
    expect(recheckButtonLabel(false)).toBe("Recheck");
    expect(recheckButtonLabel(true)).toBe("Checking…");
  });

  it("lingers the Recheck graph long enough to see the fill complete", () => {
    expect(RECHECK_GRAPH_LINGER_MS).toBeGreaterThanOrEqual(500);
  });

  it("reveals known properties during Recheck instead of waiting for the bar to finish", () => {
    expect(recheckBeatMs(6)).toBe(480);
    expect(recheckLandRevealed({ count: 6, elapsedMs: 0, durationMs: 480, done: false })).toBe(0);
    expect(recheckLandRevealed({ count: 6, elapsedMs: 80, durationMs: 480, done: false })).toBe(1);
    expect(recheckLandRevealed({ count: 6, elapsedMs: 480, durationMs: 480, done: false })).toBe(6);
    expect(recheckLandRevealed({ count: 6, elapsedMs: 10, durationMs: 480, done: true })).toBe(6);
    expect(recheckLandCaption("12 Oak St", 1, 6, false)).toBe("Checking 12 Oak St");
    expect(recheckLandCaption("12 Oak St", 6, 6, true)).toBe("6 checked");
  });
});
