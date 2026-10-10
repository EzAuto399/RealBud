import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/state/store", () => ({ api: vi.fn(), useStore: () => ({ state: {}, dispatch: vi.fn() }) }));
// A static render can't type. While `typing.on`, state keeps its value across renders in call
// order, so a test can change a field as its onChange would, render again and read the guard.
const typing = vi.hoisted(() => ({ on: false, at: 0, values: [] as unknown[], guards: [] as boolean[] }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => {
    if (!typing.on) return react.useState(initial);
    const at = typing.at++;
    if (!(at in typing.values)) typing.values[at] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [typing.values[at], (next: unknown) => { typing.values[at] = typeof next === "function" ? (next as (old: unknown) => unknown)(typing.values[at]) : next; }];
  } };
});
vi.mock("@/lib/unsaved-work", async original => ({ ...await original<object>(), useUnsavedGuard: (dirty: boolean) => { typing.guards.push(dirty); } }));
afterEach(() => { typing.on = false; typing.values.length = 0; });
import type { Reminder } from "@shared/reminders";
import type { RemindersViewState } from "@/lib/reminders-api";
import { RemindersPanel, RemindersView, type RemindersViewProps } from "./RemindersPanel";

const NOW = Date.UTC(2026, 9, 2, 1, 0);
const scheduled: Reminder = { id: "00000000-0000-4000-8000-000000000001", title: "Inspect 12 Example St", note: "", dueAt: NOW + 3_600_000, createdBy: "person", state: "scheduled", createdAt: NOW, updatedAt: NOW, revision: 1 };
const due: Reminder = { ...scheduled, id: "00000000-0000-4000-8000-000000000002", title: "Call the owner back", note: "About the lease renewal", dueAt: NOW - 60_000, state: "due", createdBy: "bud", source: { threadId: "thread-1" } };
const noop = () => {};
const view = (fields: Partial<RemindersViewState> = {}): RemindersViewState => ({ data: { version: 1, reminders: [], timeZone: "Australia/Brisbane" }, loading: false, readError: null, busyId: null, notice: null, conflict: false, ...fields });
const html = (fields: Partial<RemindersViewProps> = {}) => renderToStaticMarkup(createElement(RemindersView, {
  view: view(), draft: { title: "", when: "" }, now: NOW,
  onDraftChange: noop, onAdd: noop, onDone: noop, onDismiss: noop, onSnooze: noop, onAskBud: noop, onReopen: noop, onRetry: noop, ...fields,
}));

describe("Reminders panel", () => {
  it("shows the empty state, the office time zone and an accessible add form", () => {
    const markup = html();
    expect(markup).toContain("Reminders");
    expect(markup).toContain("No reminders.");
    expect(markup).toContain("Times in Australia/Brisbane");
    expect(markup).toContain('aria-label="Reminder title"');
    expect(markup).toContain('aria-label="Remind me at"');
    expect(markup).toContain('type="datetime-local"');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Add reminder/);
    expect(markup).not.toMatch(/Hermes|MCP|broker|RealBud clock/);
  });

  it("never presents a guessed zone as the office's", () => {
    expect(html({ view: view({ data: { version: 1, reminders: [], timeZone: null } }) })).toContain("this computer&#x27;s time zone. Set the office time zone in Agency setup.");
  });

  it("enables Add once a title and time are entered", () => {
    expect(html({ draft: { title: "Chase invoice", when: "2026-10-05T09:00" } })).not.toMatch(/<button[^>]*disabled=""[^>]*>Add reminder/);
    expect(html({ draft: { title: "Chase invoice", when: "" } })).toMatch(/<button[^>]*disabled=""[^>]*>Add reminder/);
  });

  it("lists a scheduled reminder with Dismiss only", () => {
    const markup = html({ view: view({ data: { version: 1, reminders: [scheduled], timeZone: "Australia/Brisbane" } }) });
    expect(markup).toContain("Inspect 12 Example St");
    expect(markup).toContain("Scheduled ·");
    expect(markup).toContain('aria-label="Dismiss: Inspect 12 Example St"');
    expect(markup).not.toContain("Ask Bud to prepare");
    expect(markup).not.toContain(" due</span>");
  });

  it("highlights a due reminder with Done, Snooze and Ask Bud to prepare", () => {
    const markup = html({ view: view({ data: { version: 1, reminders: [due, scheduled], timeZone: "Australia/Brisbane" } }) });
    expect(markup).toContain("1 due");
    expect(markup).toContain("border-hold bg-hold/10");
    expect(markup).toContain('aria-label="Done: Call the owner back"');
    expect(markup).toContain('aria-label="Ask Bud to prepare: Call the owner back"');
    expect(markup).toContain('aria-label="Snooze Call the owner back until later today"');
    expect(markup).toContain('aria-label="Snooze Call the owner back until tomorrow 9am"');
    expect(markup).toContain('aria-label="Snooze Call the owner back until next week"');
    expect(markup).toContain("Set by Bud from a conversation");
    expect(markup.indexOf("Call the owner back")).toBeLessThan(markup.indexOf("Inspect 12 Example St"));
    expect(markup).toContain("pm-control");
  });

  it("treats a scheduled reminder whose time has passed as due before the next refresh", () => {
    expect(html({ now: scheduled.dueAt + 1, view: view({ data: { version: 1, reminders: [scheduled], timeZone: null } }) })).toContain('aria-label="Done: Inspect 12 Example St"');
  });

  it("keeps every snooze option inside a closed native disclosure", () => {
    const markup = html({ view: view({ data: { version: 1, reminders: [due], timeZone: "Australia/Brisbane" } }) });
    const disclosure = markup.match(/<details[^>]*>.*?<\/details>/)?.[0] ?? "";
    expect(disclosure).toContain("Remind me later");
    expect(disclosure).not.toMatch(/<details[^>]*\sopen(?:\s|=|>)/);
    expect(disclosure).toContain('aria-label="Snooze Call the owner back until later today"');
    expect(disclosure).toContain('aria-label="Snooze Call the owner back until tomorrow 9am"');
    expect(disclosure).toContain('aria-label="Snooze Call the owner back until next week"');
    expect(disclosure).not.toContain("Dismiss:");
    expect(disclosure).not.toContain("Done:");
  });

  it("on a conflict keeps the typed draft and offers Open again", () => {
    const markup = html({ draft: { title: "My unsaved reminder", when: "2026-10-05T09:00" }, view: view({ conflict: true, data: { version: 1, reminders: [due], timeZone: null } }) });
    expect(markup).toContain("This reminder changed — open it again");
    expect(markup).toContain("Open again");
    expect(markup).toContain('value="My unsaved reminder"');
    expect(markup).toContain('role="alert"');
  });

  it("shows a load failure with a retry, and disables actions while saving", () => {
    expect(html({ view: view({ data: null, readError: "Reminders couldn't be loaded. Try again." }) })).toContain("Try again");
    expect(html({ view: view({ data: null, loading: true }) })).toContain("Loading reminders");
    expect(html({ view: view({ busyId: due.id, data: { version: 1, reminders: [due], timeZone: null } }) })).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Done: Call the owner back"/);
  });
});

describe("unsaved reminder", () => {
  it("holds beforeunload and the update restart only while a reminder title is typed", () => {
    const answer = () => { typing.at = 0; typing.guards.length = 0; renderToStaticMarkup(createElement(RemindersPanel)); return [...typing.guards]; };
    typing.on = true;
    expect(answer()).toEqual([false]);
    const draft = typing.values.findIndex(value => JSON.stringify(value) === JSON.stringify({ title: "", when: "" }));
    expect(draft).toBeGreaterThanOrEqual(0);
    typing.values[draft] = { title: "  ", when: "2026-10-12T09:00" };
    expect(answer()).toEqual([false]);
    typing.values[draft] = { title: "Call the fictional owner", when: "" };
    expect(answer()).toEqual([true]);
  });
});
