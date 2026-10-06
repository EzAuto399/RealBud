import { describe, expect, it } from "vitest";

import { deskHandsStatus, handsChip, handsFactSource, missAction, sourceKindLabel } from "./hands-label";

describe("hands labels", () => {
  it("keeps Hermes out of user chrome", () => {
    expect(handsChip("hermes")).toBe("Bud live");
    expect(handsChip("csv")).toBe("CSV live");
    expect(handsChip("held")).toBe("Not checked yet");
    expect(handsChip("held", null)).toBe("Not checked yet");
    expect(handsChip("held", "CSV batch is stale")).toBe("On hold");
    expect(handsChip("demo")).toBe("Demo");
    expect(handsFactSource("hermes")).toBe("from Bud");
    expect(sourceKindLabel("hermes")).toBe("Bud");
    expect(`${handsChip("hermes")} ${handsFactSource("hermes")} ${sourceKindLabel("hermes")}`).not.toMatch(/Hermes/i);
  });
});

describe("deskHandsStatus", () => {
  it("reads an empty office book as waiting, whatever an earlier check left", () => {
    expect(deskHandsStatus("held", null, true)).toEqual({ label: "Waiting for properties", tone: "muted" });
    expect(deskHandsStatus("held", "Bud found no ledger facts — facts stay held.", true)).toEqual({ label: "Waiting for properties", tone: "muted" });
  });

  it("keeps On hold for real holds on a book with properties or in recovery", () => {
    expect(deskHandsStatus("held", "Bud found no ledger facts — facts stay held.", false)).toEqual({ label: "On hold", tone: "hold" });
    expect(deskHandsStatus("held", "CSV batch is stale", false)).toEqual({ label: "On hold", tone: "hold" });
    // A recovery book is empty but isEmptyOfficeBook is false for it.
    expect(deskHandsStatus("held", "Desk is in recovery — the book was not replaced with Demo data.", false)).toEqual({ label: "On hold", tone: "hold" });
    expect(deskHandsStatus("held", null, false)).toEqual({ label: "Not checked yet", tone: "muted" });
    expect(deskHandsStatus("hermes", "ok", false)).toEqual({ label: "Bud live", tone: "agency" });
  });
});

describe("missAction", () => {
  it("opens the model connection for key, billing, credits, or no model", () => {
    expect(missAction("the model provider refused Bud's key")).toEqual({
      label: "Open model connection",
      hash: "attach-model",
    });
    expect(missAction("Check the model connection on You")).toEqual({
      label: "Open model connection",
      hash: "attach-model",
    });
    expect(missAction("Billing or credits exhausted at the provider")).toEqual({
      label: "Open model connection",
      hash: "attach-model",
    });
    expect(missAction("no model is attached")).toEqual({
      label: "Open model connection",
      hash: "attach-model",
    });
  });

  it("opens Bud install when the CLI is missing or the build is unsupported", () => {
    expect(missAction("Bud is not installed on this Mac")).toEqual({
      label: "Install Bud",
      hash: "you-worker",
    });
    expect(missAction("CLI not found on PATH")).toEqual({
      label: "Install Bud",
      hash: "you-worker",
    });
    expect(missAction("Run install from You")).toEqual({
      label: "Install Bud",
      hash: "you-worker",
    });
    expect(missAction("installed 0.19, supported build is 0.20.3")).toEqual({
      label: "Install Bud",
      hash: "you-worker",
    });
  });

  it("opens Bud setup for pack, safeguards, approvals, or workroom", () => {
    expect(missAction("property pack is not applied")).toEqual({
      label: "Open Bud setup",
      hash: "you-worker",
    });
    expect(missAction("safeguards need manual approvals")).toEqual({
      label: "Open Bud setup",
      hash: "you-worker",
    });
    expect(missAction("workroom policy is missing")).toEqual({
      label: "Open Bud setup",
      hash: "you-worker",
    });
  });

  it("returns null when the detail has no implied next step", () => {
    expect(missAction("Bud answered without ledger facts — facts stay held.")).toBeNull();
    expect(missAction("")).toBeNull();
  });
});
