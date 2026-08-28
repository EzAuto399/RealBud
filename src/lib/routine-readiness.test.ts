import { describe, expect, it } from "vitest";

import type { DeskSnapshot, Loop } from "@shared/contracts";
import { liveRoutineOutcome, resolveRoutineDependencies, routineMutationsLocked, routineNeedsAttention } from "./routine-readiness";

const morning: Loop = {
  id: "morning-arrears",
  name: "Morning money check",
  description: "",
  available: true,
  enabled: true,
  schedule: { type: "daily", time: "07:30", weekdays: [1, 2, 3, 4, 5] },
  revision: 1,
  nextRunAt: 1,
  evaluatorId: "morning-money",
  evaluatorVersion: 1,
  requirements: [
    { id: "desk-book", label: "Desk book", purpose: "", setupTarget: "desk" },
    { id: "current-money-source", label: "Current money source", purpose: "", setupTarget: "desk" },
  ],
};

function desk(overrides: Partial<Pick<DeskSnapshot, "mode" | "hands" | "handsDetail">> = {}) {
  return {
    mode: "demo" as const,
    recovery: { active: false, reason: null, quarantined: [] },
    hands: "demo" as const,
    handsDetail: null,
    properties: [{ id: "p1" }] as DeskSnapshot["properties"],
    results: [],
    ...overrides,
  };
}

describe("resolveRoutineDependencies", () => {
  it("labels Demo as practice and does not demand a worker for a practice run", () => {
    const dependencies = resolveRoutineDependencies(morning, { desk: desk() });
    expect(dependencies.map((dependency) => [dependency.id, dependency.state])).toEqual([
      ["desk-book", "ready"],
      ["current-money-source", "practice"],
    ]);
    expect(routineNeedsAttention(dependencies)).toBeNull();
  });

  it("shows the current export as ready for a live scheduled collection", () => {
    const dependencies = resolveRoutineDependencies(morning, {
      desk: desk({ mode: "live", hands: "csv", handsDetail: "PMS export covered 1 of 1 properties." }),
    });
    expect(dependencies.every((dependency) => dependency.state === "ready")).toBe(true);
  });

  it("routes source holds to Desk", () => {
    const held = resolveRoutineDependencies(morning, {
      desk: {
        ...desk({ mode: "live", hands: "csv", handsDetail: "Source is stale" }),
        results: [{ propertyId: "p1", outcome: "hold", reason: "stale-source", daysLate: 0 }],
      },
    });
    expect(routineNeedsAttention(held)).toMatchObject({ id: "current-money-source", status: "Held source work", setupTarget: "desk" });
  });

  it("blocks every Desk-backed routine during recovery", () => {
    const dependencies = resolveRoutineDependencies(morning, {
      desk: { ...desk({ mode: "live", hands: "csv" }), recovery: { active: true, reason: "protected", quarantined: [] } },
    });
    expect(dependencies.find((dependency) => dependency.id === "desk-book")?.state).toBe("blocked");
    expect(dependencies.find((dependency) => dependency.id === "current-money-source")?.state).toBe("blocked");
  });

  it("locks routine mutations only for Desk or active routine-state recovery", () => {
    expect(routineMutationsLocked({ deskRecovery: true })).toBe(true);
    expect(routineMutationsLocked({
      deskRecovery: false,
      localIssues: [{ area: "routine clock", action: "attention" }],
    })).toBe(true);
    expect(routineMutationsLocked({
      deskRecovery: false,
      localIssues: [{ area: "configuration", action: "attention" }],
    })).toBe(false);
    expect(routineMutationsLocked({
      deskRecovery: false,
      localIssues: [{ area: "routine clock", action: "restored-previous" }],
    })).toBe(false);
  });
});

describe("liveRoutineOutcome", () => {
  it("quotes remaining Desk cards instead of a stale run snapshot", () => {
    expect(liveRoutineOutcome(4)).toBe("4 still on Desk for Allow.");
    expect(liveRoutineOutcome(0)).toBe("Nothing from that run is still waiting on Desk.");
  });
});
