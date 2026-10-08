import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/state/store", () => ({ api: vi.fn(), useStore: () => ({ state: {}, dispatch: vi.fn() }) }));
import { NEVER_ACTIONS, type DeskSnapshot, type Draft } from "../../../shared/contracts";
import type { Reminder } from "@shared/reminders";
import type { DeskOtherWork } from "@/lib/desk-view-state";
import { buildDeskQueue } from "@/lib/desk-queue";
import { DeskRecoveryNotice, DeskRemindersDisclosure, DeskWorkArea } from "./DeskSections";
import { RemindersView } from "./RemindersPanel";
import { DeskCase } from "./DeskCase";

const noop = () => {};

describe("Other work", () => {
  const area = (active: DeskOtherWork | null, opened: DeskOtherWork[]) =>
    renderToStaticMarkup(createElement(DeskWorkArea, {
      active,
      opened: new Set(opened),
      tasks: createElement("textarea", { "aria-label": "Draft wording", defaultValue: "Unsaved edit" }),
      panels: {
        mail: createElement("form", { "aria-label": "Review saved mail item" }, "mail draft"),
        bills: createElement("div", null, "bills"),
        "shared-work": createElement("div", null, "shared"),
      },
    }));

  it("replaces the task area while open, keeping the tasks and their draft mounted", () => {
    const html = area("mail", ["mail"]);
    expect(html).toMatch(/<div class="desk-work-tasks" hidden="">.*Unsaved edit/);
    // Desk's Tasks tab is the one way back; the surface adds no second one.
    expect(html).toMatch(/<section class="desk-other-work-surface" data-other-work="mail" aria-label="Mail priorities"><form/);
    expect(html).not.toContain("Back to tasks");
    expect(html).not.toContain("bills");
  });

  it("returns to tasks with an opened surface still mounted but hidden", () => {
    const html = area(null, ["mail", "bills"]);
    expect(html).toMatch(/<div class="desk-work-tasks">.*Unsaved edit/);
    expect(html).toMatch(/data-other-work="mail" hidden="" aria-label="Mail priorities">.*mail draft/);
    expect(html).toMatch(/data-other-work="bills" hidden=""/);
    // Stable order keeps each surface at the same tree position, so React keeps its state.
    expect(html.indexOf("desk-work-tasks")).toBeLessThan(html.indexOf('data-other-work="mail"'));
    expect(html.indexOf('data-other-work="mail"')).toBeLessThan(html.indexOf('data-other-work="bills"'));
  });
});

describe("Reminders disclosure", () => {
  const NOW = Date.UTC(2026, 9, 2, 1, 0);
  const due: Reminder = { id: "00000000-0000-4000-8000-000000000002", title: "Call the owner back", note: "", dueAt: NOW - 60_000, createdBy: "person", state: "due", createdAt: NOW, updatedAt: NOW, revision: 1 };
  const html = renderToStaticMarkup(createElement(DeskRemindersDisclosure, { children: toggle => createElement(RemindersView, {
    headerAction: toggle,
    view: { data: { version: 1, reminders: [due], timeZone: "Australia/Brisbane" }, loading: false, readError: "Reminders couldn't be refreshed.", busyId: null, notice: null, conflict: false },
    draft: { title: "Half typed", when: "" }, now: NOW,
    onDraftChange: noop, onAdd: noop, onDone: noop, onDismiss: noop, onSnooze: noop, onAskBud: noop, onReopen: noop, onRetry: noop,
  }) }));

  it("starts collapsed with the due count and the error in the always-visible parts", () => {
    expect(html).toMatch(/class="desk-reminders-disclosure" data-open="false"/);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Show reminders");
    // The heading row is the panel's first child and carries the due count.
    expect(html).toMatch(/<section[^>]*class="desk-reminders[^"]*"[^>]*><div[^>]*><h2[^>]*>.*Reminders<span[^>]*>1 due<\/span><\/h2>/);
    expect(html).toMatch(/<div role="alert"[^>]*><span[^>]*>Reminders couldn&#x27;t be refreshed.<\/span>/);
    // The unsaved reminder stays in the mounted (hidden) form.
    expect(html).toContain('value="Half typed"');
  });

  it("hides only the list, form and notes while collapsed, never alerts", () => {
    const css = readFileSync(new URL("../../desk.css", import.meta.url), "utf8");
    expect(css).toContain('.desk-reminders-disclosure[data-open="false"] .desk-reminders > :not(:first-child):not([role="alert"]) { display: none; }');
    expect(css).toContain('.desk-reminders-disclosure[data-open="false"] .desk-reminders > :first-child > p { display: none; }');
  });
});

describe("Recovery notice", () => {
  it("keeps Open Workspace and the recovery link", () => {
    const html = renderToStaticMarkup(createElement(DeskRecoveryNotice, { onOpenWorkspace: noop }));
    expect(html.replace(/<[^>]+>/g, "")).toBe("Desk needs recovery. Changes, scheduled jobs and browser work are paused. Your saved book has been kept. Open Workspace and use your recovery key.");
    expect(html).toContain('<a href="#you-recovery"');
    expect(html).toContain('role="status"');
  });
});

describe("Case approval copy", () => {
  const draft = (status: Draft["status"]): Draft => ({ id: "draft-1", propertyId: "prop-oak", kind: "courtesy-rent", status, channel: "sms", to: "Sam", body: "Hi Sam", periodDueAt: 1, createdAt: 2 } as Draft);
  const snap = (status: Draft["status"]): DeskSnapshot => ({
    version: 2, revision: 1, mode: "demo", recovery: { active: false, reason: null, quarantined: [] }, timezone: "Australia/Sydney", retentionDays: 90,
    properties: [{ id: "prop-oak", address: "12 Oak St, Dickson ACT", tenantName: "Sam", tenantPhone: "0400", weeklyRentCents: 62_000, options: { rentSource: "fixture", graceDays: 3, courtesyUntilDay: 7, levyFromRent: null, notifyChannel: "sms", never: [...NEVER_ACTIONS] } }],
    ledger: [], drafts: [draft(status)], escalations: [], workItems: [], lastRunAt: 1, results: [], hands: "demo", handsDetail: null, sources: [], demo: true,
  } as DeskSnapshot);
  const render = (status: Draft["status"]) => {
    const desk = snap(status);
    const item = buildDeskQueue(desk).find(row => row.draftId === "draft-1");
    return renderToStaticMarkup(createElement(DeskCase, {
      snap: desk, item, busy: null, empty: null, edits: new Map(), evidenceOpen: true, evidence: createElement("p", null, "Evidence body"),
      onAllow: noop, onDeny: noop, onEdit: async () => true, onCopy: noop, onPrepare: noop, onRecover: noop, onAsk: noop, onEvidence: noop,
    }));
  };

  it("names the decisions and says approving does not send", () => {
    const html = render("pending");
    expect(html).toContain(">Approve wording<");
    expect(html).toContain(">Edit wording<");
    expect(html).toContain(">Decline wording<");
    expect(html).toContain("Approving saves your decision. It does not send the message.");
    expect(html).not.toContain("Allow wording");
  });

  it("expands evidence inside the case, one action away", () => {
    const html = render("pending");
    expect(html).toContain('aria-expanded="true" aria-controls="desk-case-evidence"');
    expect(html.indexOf("Evidence body")).toBeLessThan(html.indexOf("Approve wording"));
  });

  it("after approval, says the person sends it from their system", () => {
    const html = render("allowed");
    expect(html).toContain("Wording approved. Copy it, then send it from your property management system.");
    expect(html).not.toMatch(/\bPMS\b/);
  });
});
