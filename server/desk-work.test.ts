import { describe, expect, it } from "vitest";

import { assertTransition, canTransition, LEGAL_TRANSITIONS, occurrenceKey, proposalHash, workStateFromV1Draft } from "./desk-work.ts";
import type { WorkState } from "../shared/contracts.ts";

describe("work-state machine", () => {
  const legal: Array<[WorkState, WorkState]> = [
    ["proposed", "approved"],
    ["proposed", "denied"],
    ["proposed", "held"],
    ["approved", "preparing"],
    ["preparing", "handoff-ready"],
    ["handoff-ready", "confirmed"],
    ["handoff-ready", "effect-unknown"],
    ["handoff-ready", "handoff-expired"],
    ["held", "proposed"],
    ["effect-unknown", "confirmed"],
  ];

  it("allows every legal transition", () => {
    for (const [from, to] of legal) {
      expect(canTransition(from, to)).toBe(true);
      expect(() => assertTransition(from, to)).not.toThrow();
    }
  });

  it("rejects approval-as-sent and other illegal jumps", () => {
    expect(() => assertTransition("proposed", "confirmed")).toThrow(/illegal/);
    expect(() => assertTransition("approved", "confirmed")).toThrow(/illegal/);
    expect(() => assertTransition("preparing", "confirmed")).toThrow(/illegal/);
    expect(() => assertTransition("denied", "approved")).toThrow(/illegal/);
    expect(LEGAL_TRANSITIONS.confirmed).toEqual([]);
  });

  it("maps v1 draft status without claiming a send", () => {
    expect(workStateFromV1Draft("pending")).toBe("proposed");
    expect(workStateFromV1Draft("allowed")).toBe("approved");
    expect(workStateFromV1Draft("denied")).toBe("denied");
  });

  it("keeps occurrence identity stable for a property, kind, and period", () => {
    expect(occurrenceKey("prop-oak", "courtesy-rent", 1)).toBe("prop-oak:courtesy-rent:1");
    expect(proposalHash({ propertyId: "a", kind: "courtesy-rent", periodDueAt: 1, body: "x", to: "y", channel: "sms" })).toMatch(/^ph-/);
  });
});
