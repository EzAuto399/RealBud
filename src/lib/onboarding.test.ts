import { describe, expect, it } from "vitest";

import {
  goLiveReadiness,
  markOnboardingComplete,
  nextWorkerSetupOperation,
  onboardingComplete,
  recordRecoveryKeySaved,
  recordWorkerVerification,
  recoveryKeySaved,
  setSetupJourneyPending,
  setupGuideItems,
  setupJourneyPending,
  workerSetupStep,
  workerVerified,
  type StorageLike,
  type WorkerSetupStatus,
} from "./onboarding";

class MemoryStorage implements StorageLike {
  private values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

const readyWorker = (model = "model-a"): WorkerSetupStatus => ({
  ready: true,
  pin: { product: "0.20.3", tag: "v0.20.3" },
  model: { provider: "provider-a", model, keyPresent: true },
});

const desktopCapabilities = (
  overrides: Partial<DesktopCapabilities["localComputer"]> = {},
): DesktopCapabilities => ({
  host: { platform: "darwin", label: "macOS", session: "unknown", packaged: true },
  windowChrome: "mac-inset",
  screenPreview: { available: true, interaction: "direct" },
  dictation: { available: true, engine: "apple-speech", onDevice: true },
  localComputer: {
    available: false,
    support: "limited",
    runtime: "bundled",
    reasonCode: "cua-not-enabled",
    ...overrides,
  },
});

describe("onboarding preferences", () => {
  it("starts incomplete and records completion without storing profile data", () => {
    const storage = new MemoryStorage();
    expect(onboardingComplete(storage)).toBe(false);
    markOnboardingComplete(storage);
    expect(onboardingComplete(storage)).toBe(true);
  });

  it("persists only whether the focused setup guide should resume", () => {
    const storage = new MemoryStorage();
    expect(setupJourneyPending(storage)).toBe(false);

    setSetupJourneyPending(true, storage);
    expect(setupJourneyPending(storage)).toBe(true);
    expect(storage.getItem("realbud.setup-journey.pending.v1")).toBe("1");

    setSetupJourneyPending(false, storage);
    expect(setupJourneyPending(storage)).toBe(false);
  });

  it("binds a successful hands test to the exact worker pin and model", () => {
    const storage = new MemoryStorage();
    const worker = readyWorker();
    expect(workerVerified(worker, storage)).toBe(false);

    recordWorkerVerification(worker, true, storage);
    expect(workerVerified(worker, storage)).toBe(true);
    expect(workerVerified(readyWorker("model-b"), storage)).toBe(false);

    recordWorkerVerification(worker, false, storage);
    expect(workerVerified(worker, storage)).toBe(false);
  });

  it("invalidates an old hands test after the private worker is reinstalled", () => {
    const storage = new MemoryStorage();
    const first = { ...readyWorker(), cli: { installId: "runtime-a" } };
    const reinstalled = { ...readyWorker(), cli: { installId: "runtime-b" } };
    recordWorkerVerification(first, true, storage);
    expect(workerVerified(first, storage)).toBe(true);
    expect(workerVerified(reinstalled, storage)).toBe(false);
  });

  it("stores only the PM's recovery acknowledgement and can clear it", () => {
    const storage = new MemoryStorage();
    expect(recoveryKeySaved(storage)).toBe(false);
    recordRecoveryKeySaved(true, storage);
    expect(recoveryKeySaved(storage)).toBe(true);
    expect(storage.getItem("realbud.recovery-key-saved")).toBe("1");
    recordRecoveryKeySaved(false, storage);
    expect(recoveryKeySaved(storage)).toBe(false);
  });
});

describe("Ask worker setup state", () => {
  it("distinguishes checking, install, model, test and ready states", () => {
    expect(workerSetupStep({ worker: null, workerIsVerified: false }).state).toBe("checking");
    expect(workerSetupStep({
      worker: { ready: false, pin: { product: "0.20.3", tag: "v0.20.3" }, model: null },
      workerIsVerified: false,
    }).title).toBe("Prepare Bud");
    expect(workerSetupStep({
      worker: { ready: true, pin: { product: "0.20.3", tag: "v0.20.3" }, model: null },
      workerIsVerified: false,
    }).title).toBe("Connect Bud's model");
    expect(workerSetupStep({ worker: readyWorker(), workerIsVerified: false }).title).toBe("Check Bud can answer");
    expect(workerSetupStep({ worker: readyWorker(), workerIsVerified: true }).state).toBe("done");
  });

  it("returns one resumable setup operation in the non-technical journey order", () => {
    expect(nextWorkerSetupOperation({ worker: null, workerIsVerified: false })).toBe("checking");
    expect(nextWorkerSetupOperation({
      worker: {
        ready: false,
        pin: { product: "0.20.3", tag: "v0.20.3" },
        cli: { installed: false, matchesPin: false },
        pack: { installed: false, approvalsManual: false },
      },
      workerIsVerified: false,
    })).toBe("install");
    expect(nextWorkerSetupOperation({
      worker: {
        ready: false,
        pin: { product: "0.20.3", tag: "v0.20.3" },
        cli: { installed: true, matchesPin: true },
        pack: { installed: false, approvalsManual: false },
      },
      workerIsVerified: false,
    })).toBe("pack");
    expect(nextWorkerSetupOperation({ worker: { ...readyWorker(), model: null }, workerIsVerified: false })).toBe("model");
    expect(nextWorkerSetupOperation({ worker: readyWorker(), workerIsVerified: false })).toBe("test");
    expect(nextWorkerSetupOperation({ worker: readyWorker(), workerIsVerified: true })).toBe("done");
  });

  it("routes uncertain runtime and model recovery back to their exact owner", () => {
    expect(nextWorkerSetupOperation({
      worker: { ...readyWorker(), runtimeRecovery: { action: "attention" } },
      workerIsVerified: true,
    })).toBe("install");
    expect(nextWorkerSetupOperation({
      worker: { ...readyWorker(), modelRecovery: { action: "attention" } },
      workerIsVerified: true,
    })).toBe("model");
  });
});

describe("go-live readiness", () => {
  it("keeps demo, worker setup and optional agency naming distinct", () => {
    const readiness = goLiveReadiness({
      mode: "demo",
      recoveryActive: false,
      worker: null,
      workerIsVerified: false,
      agencyName: "Demo agency",
    });
    expect(readiness.complete).toBe(false);
    expect(readiness.requiredDone).toBe(0);
    expect(readiness.steps.map((step) => step.state)).toEqual(["checking", "action", "optional"]);
    expect(readiness.steps[1].title).toBe("Verify the live book");
    expect(readiness.steps[1].detail).toMatch(/practice book/i);
    expect(readiness.steps[1].detail).toMatch(/current PMS export/i);
    expect(readiness.steps[1].detail).not.toMatch(/CSV/i);
  });

  it("does not call an installed worker ready until a model and matching hands test exist", () => {
    const noModel = goLiveReadiness({
      mode: "live",
      recoveryActive: false,
      worker: { ready: true, pin: { product: "0.20.3", tag: "v0.20.3" }, model: null },
      workerIsVerified: true,
    });
    expect(noModel.complete).toBe(false);
    expect(noModel.steps[0]).toMatchObject({ state: "action", title: "Connect Bud's model" });

    const untested = goLiveReadiness({
      mode: "live",
      recoveryActive: false,
      worker: readyWorker(),
      workerIsVerified: false,
    });
    expect(untested.complete).toBe(false);
    expect(untested.steps[0]).toMatchObject({ state: "action", title: "Check Bud can answer" });
  });

  it("finishes after a live source and verified worker; agency naming stays optional", () => {
    const readiness = goLiveReadiness({
      mode: "live",
      recoveryActive: false,
      worker: readyWorker(),
      workerIsVerified: true,
      agencyName: "",
    });
    expect(readiness.complete).toBe(true);
    expect(readiness.requiredDone).toBe(2);
    expect(readiness.steps[2].state).toBe("optional");
  });

  it("never reports complete while Desk is in recovery", () => {
    const readiness = goLiveReadiness({
      mode: "live",
      recoveryActive: true,
      worker: readyWorker(),
      workerIsVerified: true,
      agencyName: "Example Agency",
    });
    expect(readiness.complete).toBe(false);
    expect(readiness.steps[1].state).toBe("held");
  });
});

describe("first Desk setup guide", () => {
  it("shows every follow-on area without turning optional setup into a gate", () => {
    const items = setupGuideItems({
      agencyName: "RealBud Demo Book",
      recoveryActive: false,
      recoverySaved: false,
      desktopReady: true,
      desktop: desktopCapabilities(),
      remindersAvailable: true,
      remindersOn: false,
      pocket: { pilotReady: false, connectedCount: 0, state: "pilot-gated" },
    });

    expect(items.map((item) => item.id)).toEqual([
      "agency",
      "computer-use",
      "recovery",
      "reminders",
      "connections",
    ]);
    expect(items.map((item) => item.status)).toEqual([
      "Optional",
      "Included",
      "Save a copy",
      "Optional",
      "Pilot-gated",
    ]);
    expect(items.every((item) => item.state === "optional")).toBe(true);
    expect(items.find((item) => item.id === "computer-use")?.detail).toMatch(/until you choose Set up/i);
  });

  it("distinguishes missing permissions, a missing private runtime and a ready runtime", () => {
    const base = {
      agencyName: "Example Agency",
      recoveryActive: false,
      recoverySaved: true,
      desktopReady: true,
      remindersAvailable: true,
      remindersOn: true,
      pocket: { pilotReady: true, connectedCount: 0, state: "setup-required" as const },
    };
    const permissions = setupGuideItems({
      ...base,
      desktop: desktopCapabilities({ reasonCode: "cua-accessibility-and-screen-required" }),
    }).find((item) => item.id === "computer-use");
    expect(permissions).toMatchObject({ state: "action", status: "Permissions needed" });

    const missing = setupGuideItems({
      ...base,
      desktop: desktopCapabilities({ runtime: "none", reasonCode: "cua-bundle-missing" }),
    }).find((item) => item.id === "computer-use");
    expect(missing).toMatchObject({ state: "held", status: "Repair needed" });

    const ready = setupGuideItems({
      ...base,
      desktop: desktopCapabilities({ available: true, support: "supported", reasonCode: undefined }),
    }).find((item) => item.id === "computer-use");
    expect(ready).toMatchObject({ state: "done", status: "Ready" });
  });

  it("reports only verified PM-channel readiness and keeps mail/calendar separate", () => {
    const connections = setupGuideItems({
      agencyName: "Example Agency",
      recoveryActive: false,
      recoverySaved: true,
      desktopReady: true,
      desktop: desktopCapabilities(),
      remindersAvailable: true,
      remindersOn: true,
      pocket: { pilotReady: true, connectedCount: 2, state: "ready" },
    }).find((item) => item.id === "connections");

    expect(connections).toMatchObject({ state: "done", status: "2 mobile ready" });
    expect(connections?.detail).toMatch(/Mail and calendar remain separately pilot-gated/i);
  });
});
