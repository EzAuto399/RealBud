import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LEARN_ROW_VALUE, type LearnedRecipe } from "@shared/learned-recipes";
import { LearnedRecipeItem, LearnedRecipesCard, learnFlagText, learnInputLabel, learnPublishReason, learnStepText, parseLearnList } from "./LearnedRecipesCard";

vi.mock("@/state/store", () => ({ api: vi.fn(), useStore: () => ({ state: { bots: [] }, dispatch: vi.fn() }) }));
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
const answer = (element: ReturnType<typeof createElement>) => { typing.at = 0; typing.guards.length = 0; renderToStaticMarkup(element); return [...typing.guards]; };

const draft: LearnedRecipe = {
  version: 1, purpose: "realbud-learned-recipe", id: "lr_fictional", portal: "fictional-portal", name: "learned-arrears-check", title: "Arrears check",
  state: "draft",
  steps: [{ nav: ["Accounts", "Arrears"] }, { click: "View" }, { click: "Filter" }, { type: { field: "Search", value: "{search}" } }, { read: "table" }],
  inputs: ["search"], stopBefore: ["Save"], confirmedLabels: [],
  flags: [{ code: "needs-confirm", label: "View" }, { code: "unsupported", label: "Include closed" }],
  createdAt: 1, updatedAt: 1, revision: 3,
};
const labels = { readSafe: ["Filter"], consequential: ["Save"] };
const render = (recipe: LearnedRecipe) => renderToStaticMarkup(createElement(LearnedRecipeItem, { recipe, labels, busy: false, onChange: vi.fn(), onRun: vi.fn() }));

describe("learned recipe copy", () => {
  it("reads every step in plain words and never shows a placeholder as a typed value", () => {
    expect(draft.steps.map(learnStepText)).toEqual(["Open Accounts › Arrears", "Press View", "Press Filter", "Type into Search (asked each run)", "Read the table"]);
    expect(learnStepText({ type: { field: "Status", value: "Open" } })).toBe("Type “Open” into Status");
    expect(learnStepText({ wait: "modal" })).toBe("Wait for the window to open");
    expect(learnStepText({ paginate: true })).toBe("Read every page");
    expect(learnInputLabel("date_from")).toBe("Date from");
    expect(learnStepText({ select: { field: "Status", option: "{status}" } })).toBe("Choose an option in Status (asked each run)");
    expect(learnStepText({ select: { field: "Status", option: "All" } })).toBe("Choose “All” in Status");
  });

  it("explains each flag without jargon", () => {
    expect(learnFlagText({ code: "unsupported", label: "Include closed" })).toContain("can't repeat yet");
    expect(learnFlagText({ code: "needs-confirm", label: "View" })).toContain("Only opens or shows something");
    expect(learnFlagText({ code: "unsupported", label: LEARN_ROW_VALUE })).toBe("You clicked a value in a table row. Bud doesn't keep row values, so it can't repeat that click.");
  });
});

describe("parseLearnList", () => {
  it("accepts a valid list and rejects a malformed 200", () => {
    const body = { session: { state: "idle", portal: null, startedAt: null, events: 0 }, recipes: [draft], portals: ["fictional-portal"], labels: { "fictional-portal": labels } };
    expect(parseLearnList(body).recipes).toHaveLength(1);
    expect(() => parseLearnList({ ...body, recipes: [{ ...draft, revision: "3" }] })).toThrow();
    expect(() => parseLearnList({ ...body, session: { state: "paused", events: 0 } })).toThrow();
    expect(() => parseLearnList({ ...body, labels: { "fictional-portal": { readSafe: "View" } } })).toThrow();
  });
});

describe("LearnedRecipeItem", () => {
  it("shows a draft's steps, stop point, warnings and blocks Publish while flags remain", () => {
    const html = render(draft);
    expect(html).toContain("Stops before: Save");
    expect(html.match(/Only opens or shows something/g)).toHaveLength(1); // View only: Filter is read-safe
    expect(html).not.toContain("hasn&#x27;t seen"); // needs-confirm is shown as the tick box, not a warning
    expect(html).toContain(">Use fixed text</button>");
    expect(html).toContain('aria-label="Remove step 2: Press View"');
    expect(html.match(/>OK, skip this</g)).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Publish<\/button>/);
    expect(html).toContain("Sort out the warnings first.");
  });

  it("gives every repeated control a name that says which step, field, flag or recipe it acts on", () => {
    const html = render({ ...draft, steps: [...draft.steps, { paginate: true }] });
    expect(html).toContain('aria-label="View only opens or shows something"');
    expect(html).toContain('aria-label="Use fixed text for Search"');
    expect(html).toContain('aria-label="OK, skip this: Include closed"');
    expect(html).toContain('aria-label="Publish Arrears check"');
    expect(html).toContain('aria-label="Delete Arrears check"');
    expect(html).toContain('aria-label="Remove step 6: Read every page"');
    expect(html).not.toContain("min-h-11"); // compact inline step controls
    const fixed = render({ ...draft, steps: [{ type: { field: "Status", value: "Open" } }] });
    expect(fixed).toContain('aria-label="Ask for Status each run"');
    // A chosen option is asked each run until a reviewer pins one, like a typed value.
    expect(render({ ...draft, steps: [{ select: { field: "Status", option: "{status}" } }] })).toContain('aria-label="Use fixed text for Status"');
    expect(render({ ...draft, steps: [{ select: { field: "Status", option: "All" } }] })).toContain('aria-label="Ask for Status each run"');
    expect(render({ ...draft, state: "published", steps: [{ select: { field: "Status", option: "{status}" } }] })).not.toContain("Use fixed text");
    const published = render({ ...draft, state: "published", flags: [], confirmedLabels: ["View"] });
    expect(published).toContain('aria-label="Run Arrears check"');
    expect(published).toContain('aria-label="Unpublish Arrears check"');
  });

  it("explains what still blocks Publish and allows it once every unknown click is confirmed", () => {
    const clean = { ...draft, flags: [] };
    expect(learnPublishReason(clean, labels)).toBe("Tick or remove: View.");
    expect(learnPublishReason({ ...clean, confirmedLabels: ["View"] }, labels)).toBe("");
    expect(learnPublishReason({ ...clean, confirmedLabels: ["View", "Save"] }, labels)).toContain("never press");
    expect(render({ ...clean, confirmedLabels: ["View"] })).toMatch(/<button[^>]*>Publish<\/button>/);
    expect(render({ ...clean, confirmedLabels: ["View"] })).not.toMatch(/disabled=""[^>]*>Publish/);
  });

  it("offers Run and Unpublish once published, with no step editing", () => {
    const html = render({ ...draft, state: "published", flags: [], confirmedLabels: ["View"] });
    expect(html).toContain(">Run</button>");
    expect(html).toContain(">Unpublish</button>");
    expect(html).not.toContain("Remove step");
    expect(html).not.toContain(">Publish</button>");
  });
});

describe("LearnedRecipesCard", () => {
  it("drops the card frame and title when bare, keeping the subtitle", () => {
    const framed = renderToStaticMarkup(createElement(LearnedRecipesCard, {}));
    const bare = renderToStaticMarkup(createElement(LearnedRecipesCard, { bare: true }));
    expect(framed).toContain(">Show Bud a task</h3>");
    expect(bare).not.toContain("Show Bud a task");
    expect(bare).not.toContain("border-line bg-sheet p-4");
    expect(bare).toContain("It never keeps what you type into fields.");
  });
});

describe("unsaved learned-task text", () => {
  it("holds beforeunload and the update restart while a recording's task name is typed", () => {
    const card = createElement(LearnedRecipesCard, {});
    typing.on = true;
    expect(answer(card)).toEqual([false]);
    typing.values[0] = parseLearnList({ session: { state: "recording", portal: "fictional-portal", startedAt: 1, events: 2 }, recipes: [], portals: ["fictional-portal"], labels: {} });
    expect(answer(card)).toEqual([false]);
    typing.values[typing.values.lastIndexOf("")] = "Fictional arrears check"; // the task name, the card's last text state
    expect(answer(card)).toEqual([true]);
  });

  it("holds them while a draft's fixed text or a published task's run values are typed", () => {
    const item = (recipe: LearnedRecipe) => createElement(LearnedRecipeItem, { recipe, labels, busy: false, onChange: vi.fn(), onRun: vi.fn() });
    typing.on = true;
    expect(answer(item(draft))).toEqual([false]);
    const fixed = typing.values.indexOf(null);
    typing.values[fixed] = { index: 3, text: "Fictional tenant" };
    expect(answer(item(draft))).toEqual([true]);
    typing.values.length = 0;
    const published = item({ ...draft, state: "published", flags: [], confirmedLabels: ["View"] });
    expect(answer(published)).toEqual([false]);
    const [open, marker] = [typing.values.indexOf(false), typing.values.indexOf("")];
    typing.values[marker] = "FICT-01";
    expect(answer(published)).toEqual([false]); // the run form is closed
    typing.values[open] = true;
    expect(answer(published)).toEqual([true]);
  });
});
