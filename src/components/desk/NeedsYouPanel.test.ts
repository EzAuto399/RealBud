import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreOfficeDesk } from "@shared/desk-areas";
import { defaultDeskSections, effectiveDeskAreas } from "@shared/workspace-tabs";
import type { Loop, LoopId, LoopRun } from "@shared/contracts";
import type { NeedsYouItem, NeedsYouSnapshot } from "@shared/needs-you";
import type { NeedsYouState } from "@/lib/needs-you";

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock("@/state/store", () => ({ api: vi.fn(), useStore: () => ({ state: store.state, dispatch: vi.fn() }) }));
import { NeedsYouPanel } from "./NeedsYouPanel";

const at = (hour: number, minute = 0) => new Date(2026, 9, 10, hour, minute).toISOString();
const item = (key: string, fields: Partial<NeedsYouItem> = {}): NeedsYouItem => ({
  key, area: "mail", level: "review", title: `Fictional item ${key}`, reason: "Fictional reason.", next: "Open it in Mail priorities", foundAt: at(8), ...fields,
});
const snapshot = (fields: Partial<NeedsYouSnapshot> = {}): NeedsYouSnapshot => ({ checkedAt: at(9, 14), items: [], counts: {}, unavailable: [], ...fields });
const state = (fields: Partial<NeedsYouState> = {}): NeedsYouState => ({ snapshot: null, error: null, checking: false, ...fields });
const areas = (hidden: string[] = []) => effectiveDeskAreas(defaultDeskSections().map(section => ({ ...section, visible: !hidden.includes(section.id) })), coreOfficeDesk());
const render = (value: NeedsYouState, hidden: string[] = []) =>
  renderToStaticMarkup(createElement(NeedsYouPanel, { state: value, active: true, areas: areas(hidden), onShowArea: vi.fn() }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
// Fictional schedule: the jobs behind Mail priorities and Bills and calendar, with runs relative to now.
const HOUR = 3_600_000;
const loop = (id: LoopId, fields: Partial<Loop> = {}): Loop => ({ id, name: `Fictional ${id}`, description: "", available: true, enabled: true,
  schedule: { type: "daily", time: "08:00", weekdays: [1, 2, 3, 4, 5] }, revision: 1, nextRunAt: null, evaluatorId: id, evaluatorVersion: 1, ...fields });
const run = (loopId: LoopId, fields: Partial<LoopRun> = {}): LoopRun => ({ id: `run:${loopId}`, loopId, loopName: `Fictional ${loopId}`, scheduledFor: Date.now() - 2 * HOUR,
  status: "completed", manual: false, startedAt: Date.now() - 2 * HOUR, finishedAt: Date.now() - HOUR, createdAt: Date.now() - 2 * HOUR, ...fields });
const schedule = (fields: Record<string, unknown> = {}) => { store.state = { loops: [], loopRuns: [], activityLoad: { jobs: "ready", routines: "ready" }, desk: null, ...fields }; };

beforeEach(() => { schedule(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("Needs you on the Tasks tab", () => {
  it("shows a skeleton in the final layout while the first read runs, and never says nothing needs you", () => {
    const html = render(state({ checking: true }));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain(">From your workflows</h2>");
    expect(html.match(/class="needs-you-row"/g)).toHaveLength(2);
    expect(html).toContain("Checking what your workflows found…");
    expect(html).not.toContain("Nothing from your workflows");
  });

  it("lists problems first, names each workflow in text, and gives each row a button named after its next step", () => {
    const html = render(state({ snapshot: snapshot({ items: [
      item("loop:1", { area: "schedule", level: "problem", title: "Morning money check", reason: "A run of this job failed.", next: "Open the run in Schedule" }),
      item("bill:1", { area: "bills", title: "Oak St · Water", next: "Assign or resolve it in Bills and calendar" }),
    ], counts: { schedule: { problem: 1, review: 0 }, bills: { problem: 0, review: 1 } } }) }));
    const plain = text(html);
    expect(plain).toContain("From your workflows 2 items · checked 9:14 am");
    expect(html.indexOf(">Problems</h3>")).toBeLessThan(html.indexOf(">To review</h3>"));
    expect(plain).toMatch(/Problem Scheduled jobs Morning money check A run of this job failed\. Open the run in Schedule/);
    expect(plain).toMatch(/Bills and calendar Oak St · Water Fictional reason\. Assign or resolve it in Bills and calendar/);
    expect(html).toMatch(/<button type="button" class="pm-control needs-you-action" aria-label="Open the run in Schedule: Morning money check">Open the run in Schedule<\/button>/);
    expect(html).toMatch(/<button type="button" class="pm-control needs-you-action" aria-label="Assign or resolve it in Bills and calendar: Oak St · Water">Assign or resolve it in Bills and calendar<\/button>/);
  });

  it("counts what it lists as items, not as Needs you, which is the task queue's own filter", () => {
    expect(text(render(state({ snapshot: snapshot({ items: [item("mail:1")] }) })))).toContain("From your workflows 1 item · checked 9:14 am");
    const three = text(render(state({ snapshot: snapshot({ items: [item("mail:1"), item("mail:2")], unavailable: [{ area: "bills", reason: "Fictional." }] }) })));
    expect(three).toContain("From your workflows 3 items · checked 9:14 am");
    expect(three).not.toMatch(/needs? you/);
  });

  it("names each row's button after its next step, then the item, so repeated short labels stay distinct", () => {
    const html = render(state({ snapshot: snapshot({ items: [item("mail:1", { title: "Leak at 4 Fictional St", next: "Review it" }), item("mail:2", { title: "Keys for 9 Example Rd", next: "Review it" })],
      unavailable: [{ area: "bills", reason: "Fictional." }] }) }));
    expect(html).toContain('aria-label="Review it: Leak at 4 Fictional St">Review it</button>');
    expect(html).toContain('aria-label="Review it: Keys for 9 Example Rd">Review it</button>');
    expect(html).toMatch(/<button type="button" class="pm-control needs-you-action">Try again<\/button>/);
    const hidden = render(state({ snapshot: snapshot({ items: [item("bill:1", { area: "bills", next: "Assign or resolve it" })] }) }), ["bills"]);
    expect(hidden).toMatch(/<button type="button" class="pm-control needs-you-action">Show Bills and calendar on my Desk<\/button>/);
  });

  it("shows five rows, then Show all N", () => {
    const items = Array.from({ length: 7 }, (_, index) => item(`mail:${index}`));
    const html = render(state({ snapshot: snapshot({ items, counts: { mail: { problem: 0, review: 7 } } }) }));
    expect(html.match(/class="needs-you-row"/g)).toHaveLength(5);
    expect(html).toMatch(/<button type="button" class="needs-you-more" aria-expanded="false">Show all 7<\/button>/);
    expect(render(state({ snapshot: snapshot({ items: items.slice(0, 5) }) }))).not.toContain("Show all");
  });

  it("lists a source that couldn't be read as a problem with Try again, never as empty", () => {
    const html = render(state({ snapshot: snapshot({ unavailable: [{ area: "mail", reason: "Mail priorities couldn't be checked." }] }) }));
    const plain = text(html);
    expect(plain).toContain("Problem Mail priorities Couldn't check Mail priorities Anything it found is missing from this list until it can be checked.");
    expect(html).toContain(">Try again</button>");
    expect(plain).not.toContain("Nothing from your workflows");
  });

  it("says nothing to review in one quiet line only when every shown area's job has checked", () => {
    schedule({ loops: [loop("inbound-triage"), loop("weekly-bills")], loopRuns: [run("inbound-triage"), run("weekly-bills", { status: "failed", finishedAt: undefined })] });
    const html = render(state({ snapshot: snapshot() }));
    expect(text(html).trim()).toBe("Nothing from your workflows to review · checked 9:14 am");
    expect(html).toContain('aria-label="From your workflows"');
    expect(html).not.toContain("<h2");
    expect(html).not.toContain("Finish setup");
    // A schedule still being read, or unreadable, is claimed neither way.
    for (const routines of ["loading", "error"]) {
      schedule({ activityLoad: { jobs: "ready", routines } });
      expect(text(render(state({ snapshot: snapshot() }))).trim()).toBe("Nothing from your workflows to review · checked 9:14 am");
    }
  });

  it("names shown areas whose job isn't set up, with Finish setup, instead of saying nothing needs review", () => {
    schedule({ loops: [loop("inbound-triage", { enabled: false }), loop("weekly-bills", { available: false })] });
    const html = render(state({ snapshot: snapshot() }));
    expect(text(html).trim()).toBe("Nothing to review yet · Not checked yet: Mail priorities, Bills and calendar Finish setup");
    expect(html).toContain('<button type="button" class="pm-control needs-you-action mt-2">Finish setup</button>');
    expect(text(render(state({ snapshot: snapshot() }), ["bills"])).trim()).toBe("Nothing to review yet · Not checked yet: Mail priorities Finish setup");
    // A reload keeps the schedule already on screen, so the line doesn't flicker back to "nothing".
    schedule({ loops: [loop("inbound-triage", { enabled: false })], activityLoad: { jobs: "loading", routines: "loading" } });
    expect(text(render(state({ snapshot: snapshot() }), ["bills"])).trim()).toBe("Nothing to review yet · Not checked yet: Mail priorities Finish setup");
  });

  it("names shown areas whose job never ran, without Finish setup when every job is set up", () => {
    schedule({ loops: [loop("inbound-triage"), loop("weekly-bills")], loopRuns: [run("weekly-bills")] });
    const html = render(state({ snapshot: snapshot() }));
    expect(text(html).trim()).toBe("Nothing to review yet · Not checked yet: Mail priorities");
    expect(html).not.toContain("Finish setup");
    schedule({ loops: [loop("inbound-triage")] });
    expect(text(render(state({ snapshot: snapshot() }))).trim()).toBe("Nothing to review yet · Not checked yet: Mail priorities, Bills and calendar Finish setup");
  });

  it("keeps the last snapshot after a failed read, with the error and Try again", () => {
    const html = render(state({ error: "Needs you could not be checked. Refresh to try again.", snapshot: snapshot({ items: [item("mail:1")] }) }));
    expect(html).toMatch(/<div role="alert" class="needs-you-error"><span>Needs you could not be checked\. Refresh to try again\.<\/span><button[^>]*>Try again<\/button>/);
    expect(html).toContain("Fictional item mail:1");
    const first = render(state({ error: "Needs you could not be checked. Refresh to try again." }));
    expect(first).toContain(">Try again</button>");
    expect(first).not.toContain("Nothing from your workflows");
  });

  it("marks items found since this computer last showed the panel as New, and works without storage", () => {
    const items = [item("mail:old", { foundAt: at(7) }), item("mail:new", { foundAt: at(9) }), item("mail:untimed", { foundAt: null })];
    expect(render(state({ snapshot: snapshot({ items }) }))).not.toContain(">New<");
    vi.stubGlobal("window", { localStorage: { getItem: () => String(Date.parse(at(8))), setItem: () => {} } });
    const html = render(state({ snapshot: snapshot({ items }) }));
    expect(html.match(/>New</g)).toHaveLength(1);
    expect(text(html)).toContain("New Mail priorities Fictional item mail:new");
    vi.stubGlobal("window", { get localStorage() { throw new Error("blocked"); } });
    expect(() => render(state({ snapshot: snapshot({ items }) }))).not.toThrow();
  });

  it("offers to show an area this Desk hides instead of a button that would open nothing", () => {
    const html = render(state({ snapshot: snapshot({ items: [item("bill:1", { area: "bills", next: "Assign or resolve it in Bills and calendar" })] }) }), ["bills"]);
    expect(html).toContain(">Show Bills and calendar on my Desk</button>");
    expect(text(html)).toContain("Assign or resolve it in Bills and calendar · Hidden on this Desk.");
  });

  it("has a polite live region for arrivals in every state", () => {
    for (const value of [state(), state({ snapshot: snapshot() }), state({ snapshot: snapshot({ items: [item("mail:1")] }) })]) {
      expect(render(value)).toContain('<p class="sr-only" aria-live="polite">');
    }
  });
});
