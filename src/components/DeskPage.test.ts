import { readFileSync } from "node:fs";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NEVER_ACTIONS, type DeskSnapshot } from "../../shared/contracts";
import { defaultDeskSections } from "../../shared/workspace-tabs";

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown>, sections: null as unknown }));
vi.mock("@/state/store", () => ({
  api: vi.fn(),
  useStore: () => ({ state: store.state, dispatch: vi.fn(), refreshHermes: vi.fn() }),
}));
vi.mock("@/lib/workspace-tabs", () => ({
  useWorkspaceTabs: () => ({ data: store.sections ? { state: { desk: { sections: store.sections } } } : null, loading: false, saving: false, error: "", save: vi.fn() }),
}));
vi.mock("@/lib/workspace-preferences", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/workspace-preferences")>();
  return { ...actual, useWorkspacePreferences: () => ({ preferences: actual.DEFAULT_WORKSPACE, update: vi.fn(), saved: true }) };
});
// RemindersPanel keeps its own behaviour; the Desk wrapper is what is tested here.
vi.mock("./desk/RemindersPanel", () => ({
  RemindersPanel: ({ headerAction }: { headerAction?: ReactNode }) => createElement("section", { className: "desk-reminders", "data-testid": "reminders" }, createElement("div", null, "Reminders", headerAction)),
}));

import { DeskPage, reviewOrder } from "./DeskPage";
import { openDeskTasks } from "@/lib/desk-view-state";

function snapshot(partial: Partial<DeskSnapshot> = {}): DeskSnapshot {
  return {
    version: 2,
    revision: 1,
    mode: "demo",
    recovery: { active: false, reason: null, quarantined: [] },
    timezone: "Australia/Sydney",
    retentionDays: 90,
    properties: [
      {
        id: "prop-oak",
        address: "12 Oak St, Dickson ACT",
        tenantName: "Sam",
        tenantPhone: "0400",
        weeklyRentCents: 62_000,
        options: { rentSource: "fixture", graceDays: 3, courtesyUntilDay: 7, levyFromRent: null, notifyChannel: "sms", never: [...NEVER_ACTIONS] },
      },
    ],
    ledger: [],
    drafts: [],
    escalations: [{ id: "esc-1", propertyId: "prop-oak", reason: "statutory-clock", detail: "12 Oak St, Dickson ACT is 10 days late on this sample book (courtesy window ends day 7). That is a shop reminder rule, not a legal clock. A licensed person decides whether any state notice is due — in the PMS. RealBud will not draft or send one.", periodDueAt: 1, createdAt: 2 }],
    workItems: [],
    lastRunAt: Date.UTC(2026, 9, 1, 20, 3),
    results: [],
    hands: "demo",
    handsDetail: null,
    sources: [],
    demo: true,
    ...partial,
  } as DeskSnapshot;
}

function render(desk: DeskSnapshot): string {
  store.state = { desk, connected: true, bots: [], deskBookNonce: 0, hermes: null };
  return renderToStaticMarkup(createElement(DeskPage, { caseEdits: new Map() }));
}

beforeEach(() => { openDeskTasks(); store.sections = null; });

describe("Desk layout", () => {
  it("has one scroll owner: the queue, case and toolbar never scroll on their own", () => {
    const html = render(snapshot());
    const owners = html.match(/class="[^"]*overflow-y-auto[^"]*"/g) ?? [];
    expect(owners).toHaveLength(1);
    expect(owners[0]).toContain("desk-content");
    // The queue sits beside the case inside that one region.
    const content = html.slice(html.indexOf("desk-content"));
    expect(content).toContain('aria-label="Case queue"');
    expect(content).toContain('id="desk-case-column"');
    // The toolbar holds the title, Sample book badge, Check, Ask and More.
    const toolbar = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    expect(toolbar).toContain("Sample book");
    expect(toolbar).toContain("Check sample tasks");
    expect(toolbar).toContain("Ask Bud");
    expect(toolbar).toContain(">More<");
    expect(toolbar).not.toContain("Mail priorities summary");
  });

  it("shows the work areas as tabs after Tasks in the saved order, with Arrange Desk one step under More", () => {
    const tabs = (html: string) => [...html.slice(html.indexOf('aria-label="Desk workspace"'), html.indexOf("desk-shell-tabs")).matchAll(/<button type="button" aria-pressed="(true|false)"[^>]*>(?:<img[^>]*>)?([^<]+)/g)].map(match => match[2]);
    const toolbar = (html: string) => html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    const standard = render(snapshot());
    expect(tabs(standard)).toEqual(["Tasks", "Mail priorities", "Bills and calendar", "Shared work", "Hermios"]);
    expect(toolbar(standard)).toContain(">Arrange Desk<");
    for (const removed of ["Other work", "Desk options", "Turn these on in More", "Keep Bud panel open"]) expect(toolbar(standard)).not.toContain(removed);
    // Hidden areas leave the row; the rest follow the saved order. Tasks and Hermios always stay.
    const sections = defaultDeskSections().map(section => ({ ...section, visible: section.id !== "bills" }));
    store.sections = [sections[0], sections[3], sections[1], ...sections.slice(4), sections[2]];
    expect(tabs(render(snapshot()))).toEqual(["Tasks", "Shared work", "Mail priorities", "Hermios"]);
  });

  it("keeps nested scrolling out of the Desk stylesheet and the case", () => {
    const css = readFileSync(new URL("../desk.css", import.meta.url), "utf8");
    expect(css).not.toMatch(/\.pm-desk-header\s*\{[^}]*(overflow|max-height)/);
    expect(css).not.toContain("48%");
    // The only scrolling queue is the narrow drawer, inside its media query.
    const drawer = css.indexOf('[data-queue-open="true"] .desk-queue-column');
    expect(drawer).toBeGreaterThan(css.indexOf("@media (max-width: 959px)"));
    const caseSource = readFileSync(new URL("./desk/DeskCase.tsx", import.meta.url), "utf8");
    const evidenceSource = readFileSync(new URL("./desk/DeskEvidence.tsx", import.meta.url), "utf8");
    expect(caseSource).not.toContain("overflow-y");
    expect(evidenceSource).not.toContain("overflow-y");
    expect(evidenceSource).not.toContain("EvidenceRail");
  });

  it("marks a licensee hold in the queue and on the case", () => {
    const html = render(snapshot());
    // One badge on the row and one on the case; no header duplicate, no second case badge.
    expect(html.match(/>Needs licensee review</g)?.length).toBe(2);
    expect(html).not.toContain("Licensee · held");
    expect(html).not.toContain("A licensed or human decision is required");
    expect(html.match(/>Your licensee must decide what happens next/g)?.length).toBe(1);
    expect(html.match(/>10 days late on this sample book; courtesy window ends day 7\.</g)?.length).toBe(2);
    expect(html).not.toContain("shop reminder rule");
    expect(html).not.toContain("For the licensee — RealBud will not draft");
    expect(html).toContain("Your licensee must decide what happens next. RealBud will not prepare or send a legal notice, or determine its legal deadline.");
    // The case explanation and Desk chrome carry no legal jargon.
    const chrome = html;
    expect(chrome).not.toMatch(/statutory clock|No second property catalogue|\bPMS\b/);
  });

  it("uses one status selector with Type under Filters, and keeps search", () => {
    const html = render(snapshot());
    expect(html).toContain('aria-label="Status"');
    expect(html).toMatch(/<option value="now"[^>]*>Needs you · 1<\/option>/);
    expect(html).not.toContain('aria-label="Queue filters"');
    expect(html).toMatch(/<summary>Filters<\/summary><label class="desk-case-kind">Type/);
    expect(html).toContain("Search address or person");
    expect(html).toContain("Tasks · 1");
  });

  it("shows a compact task-check line and never a clean result after a missed check", () => {
    expect(render(snapshot({ lastRunAt: null }))).toContain("These tasks haven&#x27;t been checked yet.");
    const missed = render(snapshot({ escalations: [], handsDetail: "Bud did not answer." }));
    expect(missed).toContain("The check didn&#x27;t finish. The last saved results are shown.");
    const notInstalled = render(snapshot({ escalations: [], handsDetail: "Bud is not installed — open Workspace → Settings & help. Facts stay held." }));
    expect(notInstalled).toContain("Bud isn&#x27;t set up yet, so this morning&#x27;s check didn&#x27;t run. Saved results are shown.");
    expect(notInstalled).toContain(">Install Bud<");
    expect(notInstalled).not.toContain("Missed — facts held");
    expect(notInstalled).not.toContain("The check didn&#x27;t finish");
    expect(missed).not.toContain("Nothing needs you");
    expect(render(snapshot())).toMatch(/Tasks checked 2 Oct, 6:03\s?am\./);
  });

  it.each([null, Date.UTC(2026, 9, 1, 20, 3)])("puts empty-office setup and expanded reminders inline without unused case controls (last check %s)", lastRunAt => {
    const html = render(snapshot({ mode: "live", demo: false, properties: [], escalations: [], lastRunAt }));
    expect(html).toContain("Start your office book");
    expect(html).toContain('class="desk-empty-workspace"');
    expect(html).toContain('class="desk-empty-reminders"');
    expect(html).toMatch(/class="desk-empty-reminders"><div class="desk-reminders-disclosure" data-open="true"/);
    expect(html).toContain('aria-label="Hide reminders" aria-expanded="true"');
    expect(html.match(/data-testid="reminders"/g)).toHaveLength(1);
    expect(html).not.toContain('aria-label="Status"');
    expect(html).not.toContain("Search address or person");
    expect(html).not.toContain('class="desk-queue-filters');
    expect(html).not.toContain('aria-label="Case queue"');
    expect(html).not.toContain('class="desk-task-split"');
    expect(html).not.toContain("Tasks · 0");
    expect(html).not.toContain('data-drawer-open="true"');
    expect(html.match(/class="[^"]*overflow-y-auto[^"]*"/g)).toHaveLength(1);
    expect(html).not.toContain("Nothing needs you");
    expect(html).not.toContain("Open Waiting");
  });

  it("hides only the never-checked explanation on an empty office and preserves failed-check recovery", () => {
    const emptyBook: Partial<DeskSnapshot> = { mode: "live", demo: false, properties: [], escalations: [] };
    const never = render(snapshot({ ...emptyBook, lastRunAt: null }));
    const failed = render(snapshot({ ...emptyBook, handsDetail: "Bud did not answer." }));
    expect(never).not.toContain("These tasks haven&#x27;t been checked yet.");
    expect(never).not.toContain('aria-label="This morning"');
    expect(failed).toContain("The check didn&#x27;t finish. The last saved results are shown.");
    expect(failed).toContain('role="alert"');
    expect(failed.indexOf("The check didn&#x27;t finish")).toBeLessThan(failed.indexOf('class="desk-empty-workspace"'));
    const notInstalled = render(snapshot({ ...emptyBook, handsDetail: "Bud is not installed — open Workspace → Settings & help. Facts stay held." }));
    expect(notInstalled).toContain("Bud isn&#x27;t set up yet, so this morning&#x27;s check didn&#x27;t run. Saved results are shown.");
    expect(notInstalled).toContain(">Install Bud<");
    for (const html of [never, failed]) {
      expect(html).not.toContain("Nothing needs you");
      expect(html).not.toContain("Open Waiting");
    }
  });

  it("does not use empty-office onboarding for a recovering book or an empty sample", () => {
    const emptyBook = { properties: [], escalations: [], lastRunAt: null };
    const recovery = render(snapshot({ ...emptyBook, mode: "live", demo: false, recovery: { active: true, reason: "key", quarantined: [] } as DeskSnapshot["recovery"] }));
    expect(recovery).toContain("Desk needs recovery");
    expect(recovery).toMatch(/<a href="#you-recovery"[^>]*>Open Workspace<\/a>/);
    expect(recovery.indexOf("Desk needs recovery")).toBeLessThan(recovery.indexOf("</header>"));
    const sample = render(snapshot(emptyBook));
    for (const html of [recovery, sample]) {
      expect(html).not.toContain('class="desk-empty-workspace"');
      expect(html).not.toContain("Start your office book");
      expect(html).toContain('aria-label="Case queue"');
      expect(html).toContain("These tasks haven&#x27;t been checked yet.");
    }
    expect(sample).toContain("Check sample tasks");
  });

  it("keeps unmatched imports available before the first office property is added", () => {
    const html = render(snapshot({ mode: "live", demo: false, properties: [], escalations: [], lastRunAt: null,
      workItems: [{ id: "work-unmatched", kind: "money-arrears", state: "held", propertyId: "", occurrenceKey: "unmatched", periodDueAt: 1,
        recipient: { name: "", phone: "" }, sourceIds: ["src-csv"], observedAt: 2, proposalHash: "none", createdAt: 2, updatedAt: 2, holdReason: "unmatched" }],
    }));
    expect(html).not.toContain('class="desk-empty-workspace"');
    expect(html).toContain('aria-label="Case queue"');
    expect(html).toContain("Tasks · 1");
    expect(html).toContain("Match this source row");
    expect(html).toContain("These tasks haven&#x27;t been checked yet.");
  });

  it("offers Waiting only when there are waiting tasks", () => {
    expect(render(snapshot({ escalations: [] }))).not.toContain("Open Waiting");
    const html = render(snapshot({ escalations: [], workItems: [{
      id: "work-held", kind: "money-arrears", state: "held", propertyId: "prop-oak", occurrenceKey: "oak", periodDueAt: 1,
      recipient: { name: "Sam", phone: "0400" }, sourceIds: [], observedAt: 2, proposalHash: "none", createdAt: 2, updatedAt: 2,
      holdReason: "source-unavailable",
    }] }));
    expect(html).toContain("Open Waiting");
  });

  it("shows the recovery notice outside the sections, with Open Workspace linking to recovery", () => {
    const html = render(snapshot({ recovery: { active: true, reason: "key", quarantined: [] } as DeskSnapshot["recovery"] }));
    const text = html.replace(/<[^>]+>/g, "");
    expect(text).toContain("Desk needs recovery. Changes, scheduled jobs and browser work are paused. Your saved book has been kept. Open Workspace and use your recovery key.");
    expect(html).toMatch(/<a href="#you-recovery"[^>]*>Open Workspace<\/a>/);
    expect(html.indexOf("Desk needs recovery")).toBeLessThan(html.indexOf("</header>"));
  });

  it("wraps reminders in a collapsed disclosure above the queue list", () => {
    const html = render(snapshot());
    const reminders = html.indexOf('data-testid="reminders"');
    expect(reminders).toBeGreaterThan(0);
    expect(reminders).toBeLessThan(html.indexOf('aria-label="Case queue"'));
    expect(html).toMatch(/class="desk-reminders-disclosure" data-open="false"/);
  });
});

describe("Desk queue review order", () => {
  const row = (id: string, kind = "money-arrears") => ({ id, kind, bucket: "now", state: "proposed", address: id, action: "", meta: "", updatedAt: 1 }) as Parameters<typeof reviewOrder>[1][number];

  it("keeps the order under review, drops finished rows and appends a new licensee escalation", () => {
    const live = [row("esc:new", "licensee-required"), row("b"), row("a")];
    const held = reviewOrder(["a", "b", "c"], live);
    expect(held.rows.map((item) => item.id)).toEqual(["a", "b", "esc:new"]);
    expect(held.updates).toBe(true);
    expect(reviewOrder(["a", "b"], [row("a"), row("b")]).updates).toBe(false);
    // No case open (or Update order): the live order applies.
    expect(reviewOrder(null, live)).toEqual({ rows: live, updates: false });
  });

  it("says on each row why it is there and shows no Update order until the order changes", () => {
    const html = render(snapshot());
    expect(html).toMatch(/class="desk-queue-reason[^"]*">Licensee escalation · Changed /);
    expect(html).not.toContain("Update order");
  });
});
