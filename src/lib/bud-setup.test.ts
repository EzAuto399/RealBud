import { describe, expect, it } from "vitest";

import { budAutoSetupView, budAvailability, budFacingCopy, budSetupJourney, parseBudStatus, type BudSetupInput } from "./bud-setup";
import type { HermesStatus } from "@/state/store";

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

  it("hides private engine paths while keeping the failure reason", () => {
    for (const path of [
      "/Users/Office Manager/.hermes/profiles/property/config.yaml",
      "C:\\Users\\Office Manager\\.hermes\\profiles\\property\\config.yaml",
      "~/.hermes/profiles/property/config.yaml",
    ]) {
      const copy = budFacingCopy(`Could not read ${path}; check permissions.`, "Bud setup failed.");
      expect(copy).toBe("Could not read Bud's private setup; check permissions.");
      expect(copy).not.toMatch(/Hermes|\.hermes|Office Manager|config\.yaml/i);
    }
  });
});

describe("automatic Bud setup status", () => {
  const status = {
    pin: { product: "fixture", tag: "fixture", commit: "fixture", profile: "property" },
    cli: { installed: false, versionText: null, matchesPin: false, probeState: "missing" },
    pack: { installed: false, approvalsManual: false, workroomReady: false },
    ready: false, detail: "", homeDir: "/synthetic", profileDir: "/synthetic", installCommand: null, signInCommand: "",
    autoSetup: { state: "verifying", step: 3, total: 4, detail: "Connecting Bud’s model" },
  } as HermesStatus;

  it("validates the automatic setup field and rejects a malformed one", () => {
    expect(parseBudStatus(status).autoSetup?.state).toBe("verifying");
    expect(() => parseBudStatus({ ...status, autoSetup: { state: "done", step: 1, total: 4, detail: "" } })).toThrow();
    expect(() => parseBudStatus({ ...status, autoSetup: { state: "installing", step: "1", total: 4, detail: "" } })).toThrow();
  });

  it("gives a non-administrator progress with nothing to press, and ready at the end", () => {
    const availability = budAvailability(status, true, false, { canAdminister: false });
    expect(availability.label).toBe("Connecting Bud’s model");
    expect(availability.detail).toBe("Step 3 of 4. Keep RealBud open. You can draft a request or prepare plans while setup continues. Work starts only when you choose.");
    expect(availability.action).toBeNull();
    expect(budAutoSetupView({ ...status, ready: true, autoSetup: { state: "ready", step: 4, total: 4, detail: "Bud is ready." } })).toBeNull();
  });

  it("surfaces a hold with its product copy and a way to Bud's status", () => {
    const held = { ...status, autoSetup: { state: "held", step: 1, total: 4, detail: "Hermes setup record could not be read." } } as HermesStatus;
    const availability = budAvailability(held, true, false, { canAdminister: false });
    expect(availability.label).toBe("Bud setup stopped");
    expect(availability.detail).toBe("Bud’s setup could not finish. Contact RealBud support.");
    expect(availability.action).toBe("View Bud status");
  });

  it("shows actual fixed installer phases without guessing a percentage or finish time", () => {
    for (const phase of ["Downloading verified setup", "Preparing this computer", "Downloading Bud", "Installing Bud’s components", "Finishing setup", "Checking already downloaded Bud"]) {
      const view = budAutoSetupView({ ...status, autoSetup: { state: "installing", code: "installing", step: 1, total: 4, detail: phase } });
      expect(view?.label).toBe(phase);
      expect(view?.detail).toContain("Step 1 of 4");
      expect(view?.detail).toContain("You can draft a request");
      expect(view?.detail).not.toMatch(/%|minute|second|almost done/i);
    }
  });

  it("uses codes for safety/model/readiness phases and ignores arbitrary upstream detail", () => {
    const phases = { checking: "Checking Bud on this computer", safeguards: "Applying Bud’s safeguards", model: "Connecting Bud’s model", readiness: "Running the private readiness check" } as const;
    for (const [code, label] of Object.entries(phases)) {
      const view = budAutoSetupView({ ...status, autoSetup: { state: "verifying", code: code as keyof typeof phases, step: code === "checking" ? 0 : 2, total: 4, detail: "/private/path?api_key=fictional-secret" } });
      expect(view?.label).toBe(label);
      expect(view?.detail).not.toMatch(/private\/path|fictional-secret/);
      if (code === "checking") expect(view?.detail).not.toContain("Step 1");
    }
    expect(budAutoSetupView({ ...status, autoSetup: { state: "installing", code: "installing", step: 1, total: 4, detail: "Downloading Bud from /private/secret" } })?.label).toBe("Installing Bud");
  });

  it("uses fixed hold copy even if the status carries an unsafe error", () => {
    const view = budAutoSetupView({ ...status, autoSetup: { state: "held", code: "held_failed", step: 1, total: 4, detail: "fatal: secret-token from /private/path" } });
    expect(view?.detail).toBe("Bud’s setup stopped before it finished. Your files are kept. Try again, or contact RealBud support.");
    expect(view?.detail).not.toMatch(/secret-token|private\/path/);
  });
});
