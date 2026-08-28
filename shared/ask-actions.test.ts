import { describe, expect, it } from "vitest";

import {
  askConnectReceiptCopy,
  askSetupUserTurnCopy,
  honoredSetupNavigation,
  honoredSetupRequest,
  isSpentConnectReceipt,
  isUnsupportedOfficeConnect,
  type AskActionProposal,
} from "./ask-actions.ts";

const setup = (overrides: Partial<AskActionProposal> = {}): AskActionProposal => ({
  schemaVersion: 1,
  id: "action-1",
  status: "allowed",
  title: "Open Connections",
  detail: "Navigation only.",
  createdAt: 1_000,
  decidedAt: 1_100,
  kind: "open-setup",
  target: "connections",
  ...overrides,
});

describe("honored setup navigation", () => {
  it("opens a fresh setup the PM already asked for", () => {
    expect(honoredSetupNavigation(setup(), 1_100)).toBe("connections");
    expect(honoredSetupNavigation(setup({ target: "worker" }), 1_100)).toBe("worker");
    expect(honoredSetupRequest(setup({ service: "Gmail" }), 1_100)).toEqual({
      target: "connections",
      service: "Gmail",
    });
  });

  it("does not yank the page for old receipts or consequential work", () => {
    expect(honoredSetupNavigation(setup(), 1_100 + 13_000)).toBeNull();
    expect(honoredSetupNavigation(setup({ status: "pending" }), 1_100)).toBeNull();
    expect(honoredSetupNavigation({
      schemaVersion: 1,
      id: "run-1",
      status: "allowed",
      title: "Run Morning money check",
      detail: "Once.",
      createdAt: 1_000,
      decidedAt: 1_100,
      kind: "run-routine",
      loopId: "morning-arrears",
      loopName: "Morning money check",
      expectedLoopRevision: 1,
    }, 1_100)).toBeNull();
  });
});

describe("spent connect receipts", () => {
  it("treats settled setup cards as spent and leaves pending or Desk work full", () => {
    expect(isSpentConnectReceipt(setup())).toBe(true);
    expect(isSpentConnectReceipt(setup({ status: "denied" }))).toBe(true);
    expect(isSpentConnectReceipt(setup({ status: "pending" }))).toBe(false);
    expect(isSpentConnectReceipt({
      schemaVersion: 1,
      id: "run-1",
      status: "allowed",
      title: "Run Morning money check",
      detail: "Once.",
      createdAt: 1_000,
      kind: "run-routine",
      loopId: "morning-arrears",
      loopName: "Morning money check",
      expectedLoopRevision: 1,
    })).toBe(false);
  });

  it("does not treat a refused social name as a completed connection", () => {
    const instagram = setup({
      title: "Instagram isn't a named office source",
      service: "Instagram",
    });
    expect(isUnsupportedOfficeConnect(instagram)).toBe(true);
    expect(isUnsupportedOfficeConnect(setup({ service: "Gmail" }))).toBe(false);
    expect(askConnectReceiptCopy(instagram)).toEqual({ status: "Not a source", open: "Pick a source" });
    expect(askConnectReceiptCopy(setup({ service: "Gmail" }))).toEqual({ status: "Card ready", open: "Open card" });
    expect(askSetupUserTurnCopy(instagram)).toEqual({
      label: "Not a source",
      detail: "Instagram isn't a named office source. Nothing connected.",
    });
    expect(askSetupUserTurnCopy(setup({ service: "Gmail" })).label).toBe("Card opened");
  });
});
