import { describe, expect, it } from "vitest";
import type { HermesStatus } from "@/state/store";
import { budAvailability, parseBudStatus } from "./bud-setup";
import { canUseTaskStarter } from "./pm-task-starters";
import { toolLabel } from "./tool-label";

const ready: HermesStatus = {
  pin: { product: "0.20.3", tag: "v2026.8.16.2", commit: "test", profile: "property" },
  cli: { installed: true, versionText: "0.21.0", matchesPin: false, compatible: true, probeState: "ok" },
  pack: { installed: true, approvalsManual: true, workroomReady: true },
  homeDir: "/test", profileDir: "/test/property", installCommand: null, signInCommand: "", detail: "",
  model: { attached: true, provider: "test", model: "test-model" },
  ready: true,
};

describe("Bud availability across Ask and Schedule", () => {
  it("does not confuse a configured workroom with an installed worker", () => {
    const state = budAvailability({ ...ready, cli: { ...ready.cli, installed: false, probeState: "missing" }, ready: false, model: { ...ready.model!, attached: false } }, true);
    expect(state.ready).toBe(false);
    expect(state.action).toBe("Set up Bud");
    expect(state.target).toBe("you-worker");
    expect(state.label).not.toContain("ready");
  });

  it("holds a partially installed worker even with a previous readiness result", () => {
    expect(budAvailability({ ...ready, bootstrapPending: true }, true).ready).toBe(false);
    expect(budAvailability({ ...ready, bootstrapPending: true }, true).label).toBe("Setup needed");
  });

  it("names a blocked worker update when the installed build is unsupported", () => {
    const state = budAvailability({ ...ready, cli: { ...ready.cli, compatible: false }, ready: false, detail: "This worker release has not been checked with RealBud." }, true);
    expect(state).toMatchObject({ ready: false, label: "Bud update blocked", action: "Restore Bud" });
    expect(state.detail).toMatch(/supported build|not been checked/i);
  });

  it("retains the supported 0.21 path even when it differs from the rollback pin", () => {
    expect(budAvailability(ready, true).ready).toBe(true);
  });

  it("blocks a stale ready result when safeguards are missing or approvals changed", () => {
    for (const pack of [{ ...ready.pack, installed: false }, { ...ready.pack, approvalsManual: false }, { ...ready.pack, workroomReady: false }]) {
      expect(budAvailability({ ...ready, pack }, true).action).toBe("Finish Bud setup");
    }
  });

  it("offers model setup only after the worker and safeguards are ready", () => {
    const state = budAvailability({ ...ready, ready: false, model: { ...ready.model!, attached: false } }, true);
    expect(state.action).toBe("Connect a model");
    expect(state.target).toBe("attach-model");
  });

  it("requires a readiness receipt after attaching a model", () => {
    expect(budAvailability({ ...ready, ready: false }, true).action).toBe("Run readiness check");
    expect(budAvailability({ ...ready, ready: false }, true).canVerify).toBe(true);
  });

  it("offers an inline check only when its prerequisites are current", () => {
    expect(budAvailability(ready, true).canVerify).toBe(false);
    expect(budAvailability({ ...ready, ready: false }, false).canVerify).toBe(false);
    expect(budAvailability({ ...ready, ready: false }, true, true).canVerify).toBe(false);
    expect(budAvailability({ ...ready, ready: false, model: undefined }, true).canVerify).toBe(false);
    expect(budAvailability({ ...ready, ready: false, pack: { ...ready.pack, approvalsManual: false } }, true).canVerify).toBe(false);
  });

  it("does not invent a model failure while its metadata is unknown", () => {
    expect(budAvailability({ ...ready, model: undefined, ready: false }, true).label).toBe("Checking Bud");
    expect(budAvailability(null, true).action).toBeNull();
  });

  it("offers a recheck instead of reinstallation after a failed probe", () => {
    for (const probeState of ["timeout", "error"] as const) {
      const state = budAvailability({ ...ready, cli: { ...ready.cli, probeState, installed: false } }, true);
      expect(state.ready).toBe(false);
      expect(state.action).toBe("Check Bud");
    }
  });

  it("suspends new work while offline or recovering even with a prior ready receipt", () => {
    expect(budAvailability(ready, false)).toMatchObject({ ready: false, label: "Reconnecting", action: null });
    expect(budAvailability(ready, true, true)).toMatchObject({ ready: false, action: "Unlock book", target: "you-recovery" });
  });
});

describe("editable task examples", () => {
  it("preserves unsent text and attachments", () => {
    expect(canUseTaskStarter("Call owner tomorrow")).toBe(false);
    expect(canUseTaskStarter("", 1)).toBe(false);
    expect(canUseTaskStarter(" \n ", 0)).toBe(true);
  });
});

describe("Hermes work explained to the PM", () => {
  it("distinguishes remembering work, parallel checking and planning from generic tool names", () => {
    expect(toolLabel("session_search")).toBe("finding previous work");
    expect(toolLabel("delegate_task")).toBe("checking part of the work in parallel");
    expect(toolLabel("todo_write")).toBe("updating the work plan");
  });
});

describe("permission-aware setup presentation", () => {
  it("offers staff a status view without promising administrator setup", () => {
    const status = { ...ready, pack: { ...ready.pack, workroomReady: false }, ready: false };
    const staff = budAvailability(status, true, false, { canAdminister: false });
    expect(staff).toMatchObject({ label: "Service setup needed", action: "View Bud status", ready: false });
    expect(staff.detail).toContain("private workroom is not ready");
    expect(budAvailability(status, true, false, { canAdminister: true }).action).toBe("Finish Bud setup");
  });
  it("preserves factual verification prerequisites without granting a staff action", () => {
    expect(budAvailability({ ...ready, ready: false }, true, false, { canAdminister: false }))
      .toMatchObject({ canVerify: true, action: "View Bud status" });
  });
  it("names each missing safeguard without claiming later steps prove it", () => {
    for (const [field, detail] of [["installed", "not installed"], ["approvalsManual", "not active"], ["workroomReady", "not ready"]] as const) {
      expect(budAvailability({ ...ready, pack: { ...ready.pack, [field]: false } }, true, false, { canAdminister: false }).detail).toContain(detail);
    }
  });
  it("does not replace recovery or offline actions with service setup", () => {
    expect(budAvailability(ready, true, true, { canAdminister: false }).target).toBe("you-recovery");
    expect(budAvailability(ready, false, false, { canAdminister: false }).action).toBeNull();
  });
  it("holds a previously ready worker when status cannot be refreshed", () => {
    expect(budAvailability(ready, true, false, { canAdminister: true, statusError: true }))
      .toMatchObject({ ready: false, label: "Status unavailable", canVerify: false });
  });
});


describe("automatic Bud status validation", () => {
  it("accepts current server facts without upgrading readiness", () => {
    expect(parseBudStatus(ready)).toBe(ready);
    expect(parseBudStatus({ ...ready, ready: false }).ready).toBe(false);
  });
  it("rejects malformed and partial responses", () => {
    for (const input of [null, {}, [], { ...ready, pin: undefined }, { ...ready, cli: { ...ready.cli, versionText: undefined } }, { ...ready, homeDir: undefined }, { ...ready, ready: "true" }, { ...ready, cli: null },
      { ...ready, pack: { ...ready.pack, approvalsManual: undefined } },
      { ...ready, model: { attached: true } }, { ...ready, modelAccess: { withdrawn: true } },
      { ...ready, lastPing: { ok: "true" } }]) {
      expect(() => parseBudStatus(input)).toThrow("status could not be confirmed");
    }
  });
});
