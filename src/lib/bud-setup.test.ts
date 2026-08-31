import { describe, expect, it } from "vitest";

import { budFacingCopy, budSetupJourney, type BudSetupInput } from "./bud-setup";

const readyBase: BudSetupInput = {
  statusLoaded: true,
  workerInstalled: true,
  workerPinned: true,
  safeguardsInstalled: true,
  approvalsManual: true,
  workroomReady: true,
  modelChecked: true,
  modelAttached: true,
  verified: false,
};

describe("budSetupJourney", () => {
  it("waits for the authoritative status before offering an action", () => {
    const journey = budSetupJourney({ ...readyBase, statusLoaded: false });
    expect(journey.stage).toBe("checking");
    expect(journey.stepState.install).toBe("upcoming");
  });

  it("keeps setup in dependency order", () => {
    expect(
      budSetupJourney({
        ...readyBase,
        workerInstalled: false,
        workerPinned: false,
        safeguardsInstalled: false,
        approvalsManual: false,
        workroomReady: false,
        modelChecked: false,
        modelAttached: false,
      }).stage,
    ).toBe("install");

    expect(
      budSetupJourney({ ...readyBase, safeguardsInstalled: false, approvalsManual: false, workroomReady: false, modelChecked: false, modelAttached: false }).stage,
    ).toBe("safeguards");

    expect(budSetupJourney({ ...readyBase, modelAttached: false }).stage).toBe("model");
    expect(budSetupJourney(readyBase).stage).toBe("verify");
  });

  it("treats a pin mismatch and unsafe approvals as repair states", () => {
    expect(budSetupJourney({ ...readyBase, workerPinned: false }).stage).toBe("install");
    expect(budSetupJourney({ ...readyBase, approvalsManual: false }).stage).toBe("safeguards");
    expect(budSetupJourney({ ...readyBase, workroomReady: false }).stage).toBe("safeguards");
  });

  it("uses a successful hands check as the ready authority", () => {
    const journey = budSetupJourney({ ...readyBase, modelChecked: false, modelAttached: false, verified: true });
    expect(journey.stage).toBe("ready");
    expect(journey.completed).toBe(4);
    expect(Object.values(journey.stepState)).toEqual(["complete", "complete", "complete", "complete"]);
  });
});

describe("budFacingCopy", () => {
  it("keeps upstream engine terms out of office-facing failures", () => {
    const copy = budFacingCopy(
      new Error('Hermes CLI says the "property" pack profile does not match the pin in ~/.hermes.'),
      "Bud could not finish the check.",
    );
    expect(copy).toContain("Bud");
    expect(copy).toContain("safeguards");
    expect(copy).toContain("private setup");
    expect(copy).toContain("supported build");
    expect(copy).not.toMatch(/Hermes|CLI|\bpack\b|\bprofile\b|\bpin\b|\.hermes/i);
  });

  it("uses a safe fallback for missing detail", () => {
    expect(budFacingCopy(null, "Check Bud again.")).toBe("Check Bud again.");
  });
});
