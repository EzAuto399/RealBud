import { describe, expect, it } from "vitest";

import { deskCopyPulse, RECHECK_GRAPH_LINGER_MS, recheckButtonLabel } from "./desk-motion";

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
});
