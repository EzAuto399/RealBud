import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: store.state, dispatch: vi.fn() }), api: vi.fn() }));

import { WorkdayPulse } from "../WorkdayPulse";
import { WorkspaceNextStep } from "./WorkspaceNextStep";

function desk(patch: Record<string, unknown> = {}) {
  return {
    version: 2, revision: 1, mode: "demo", timezone: "Australia/Brisbane", retentionDays: 90,
    recovery: { active: false, reason: null, quarantined: [] },
    properties: [{ id: "p1", address: "12 Example St", notes: "" }],
    ledger: [], drafts: [], escalations: [], workItems: [], results: [], sources: [],
    lastRunAt: null, hands: "demo", handsDetail: "", demo: true,
    ...patch,
  };
}

beforeEach(() => {
  store.state = { connected: true, desk: desk(), hermes: { ready: false }, workerIssues: [], bots: [], loops: [], activeView: "desk" };
});

describe("Workspace overview", () => {
  it("shows where the day stands with one labelled next step", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceNextStep));
    expect(html).toContain('aria-label="Workspace overview"');
    expect(html).toContain("Run the sample morning");
    expect(html).toContain(">Run sample morning<");
    expect(html).toContain("Sample book");
    expect(html).toContain("Bud setup open");
    expect(html).not.toContain('role="alert"');
  });

  it("sends a protected book to recovery and pauses the step while reconnecting", () => {
    store.state.desk = desk({ recovery: { active: true, reason: "key missing", quarantined: [] } });
    const recovery = renderToStaticMarkup(createElement(WorkspaceNextStep));
    expect(recovery).toContain("Unlock this book");
    expect(recovery).toContain(">Open recovery<");

    store.state.connected = false;
    const offline = renderToStaticMarkup(createElement(WorkspaceNextStep));
    expect(offline).toContain("Reconnecting");
    expect(offline).not.toContain("<button");
  });

  it("names the latest worker problem in plain words", () => {
    store.state.workerIssues = [{ id: "w1", at: Date.now(), summary: "Bud stopped answering", detail: "Try again in a minute." }];
    const html = renderToStaticMarkup(createElement(WorkspaceNextStep));
    expect(html).toContain('role="status"');
    expect(html).toContain("Bud stopped answering");
  });
});

describe("sidebar Workspace row", () => {
  it("is one button named Workspace with the day's summary and shortcut", () => {
    const html = renderToStaticMarkup(createElement(WorkdayPulse, { shortcut: "⌘4" }));
    expect(html).toContain('aria-label="Workspace"');
    expect(html).toContain('title="Workspace (⌘4)"');
    expect(html).toContain("Run the sample morning");
    expect(html).not.toContain("aria-current");
    expect(html).not.toContain("popover");
  });

  it("marks itself current on the Workspace screen", () => {
    store.state.activeView = "you";
    expect(renderToStaticMarkup(createElement(WorkdayPulse))).toContain('aria-current="page"');
  });
});
