import { describe, expect, it } from "vitest";
import { compileLearnedSteps } from "./learn-compile.ts";
import { parsePortalRecipePack } from "./portal-recipe.ts";
import { fictionalReiPack, FICTIONAL_REI_ORIGIN, FICTIONAL_REI_SIGNIN } from "./testing/fictional-rei-portal.ts";
import { LEARN_INPUT, LEARN_ROW_VALUE, learnBlockers, type LearnEvent } from "../shared/learned-recipes.ts";

const pack = fictionalReiPack();
const page = (path: string, table = false): LearnEvent => ({ kind: "page", url: `${FICTIONAL_REI_ORIGIN}${path}`, table });
const menu = (name: string): LearnEvent => ({ kind: "click", role: "link", name, landmark: "navigation" });
const button = (name: string, landmark: "main" | "dialog" | "other" = "main"): LearnEvent => ({ kind: "click", role: "button", name, landmark });
const typed = (field: string, landmark: "main" | "dialog" = "main"): LearnEvent => ({ kind: "type", field, landmark });

describe("compileLearnedSteps", () => {
  it("compiles a REI-shaped bulk receipting walk-through and stops before the consequential button", () => {
    const events: LearnEvent[] = [
      page("/dashboard"),
      menu("Receipts"), menu("Bulk receipting"),
      page("/receipts/bulk", true),
      typed("Search"), typed("Search"),
      { kind: "select", field: "Status", landmark: "main" },
      button("View"),
      button("Open details", "dialog"),
      { kind: "radio", name: "This month", landmark: "dialog" },
      button("Process Receipts"),
      button("View"), typed("Ignored after stop"),
    ];
    const out = compileLearnedSteps(events, pack);
    expect(out.steps).toEqual([
      { nav: ["Receipts", "Bulk receipting"] },
      { wait: "table" },
      { type: { field: "Search", value: "{search}" } },
      { select: { field: "Status", option: "{status}" } },
      { click: "View" },
      { wait: "modal" },
      { click: "Open details" },
      { radio: "This month" },
      { wait: "table" },
      { read: "table" },
    ]);
    expect(out.inputs).toEqual(["search", "status"]);
    expect(out.stopBefore).toEqual(["Process Receipts"]);
    expect(out.flags).toEqual([{ code: "needs-confirm", label: "Open details" }]);
    // Merged as a read recipe, the shipped pack still validates.
    const merged = parsePortalRecipePack({ ...pack, recipes: { ...pack.recipes, "learned-bulk-pending": { kind: "read", tier: [], inputs: out.inputs, grantNeeds: [], steps: out.steps, stopBefore: out.stopBefore } } });
    expect(merged.recipes["learned-bulk-pending"].steps).toHaveLength(10);
    expect(learnBlockers({ ...out, confirmedLabels: [] }, pack.labels)).toContain("needs-confirm: Open details");
  });

  it("is deterministic and never mutates its input", () => {
    const events: LearnEvent[] = [page("/a", true), button("View"), typed("Date from")];
    const copy = structuredClone(events);
    expect(compileLearnedSteps(events, pack)).toEqual(compileLearnedSteps(events, pack));
    expect(events).toEqual(copy);
  });

  it("drops a menu path into a forbidden area at its first forbidden prefix", () => {
    const out = compileLearnedSteps([menu("Process"), menu("Disbursement"), menu("Run"), page("/process/disburse"), menu("Settings"), button("View")], pack);
    expect(out.flags).toEqual([{ code: "forbidden-area", label: "Process › Disbursement" }, { code: "forbidden-area", label: "Settings" }]);
    expect(out.steps).toEqual([{ click: "View" }, { read: "controls" }]);
  });

  it("allows a consequential word as a menu name (only main and dialog clicks stop)", () => {
    const out = compileLearnedSteps([menu("Process"), menu("Bank reconciliation"), page("/process/bank")], pack);
    expect(out.steps).toEqual([{ nav: ["Process", "Bank reconciliation"] }, { read: "controls" }]);
    expect(out.stopBefore).toEqual([]);
  });

  it("flushes a menu path on a non-navigation event without a page change (single-page portals)", () => {
    const out = compileLearnedSteps([page("/home", true), menu("Tenants"), menu("Arrears"), button("View")], pack);
    // The home page's table is neither waited for before a menu path to another screen nor read after it.
    expect(out.steps).toEqual([{ nav: ["Tenants", "Arrears"] }, { click: "View" }, { read: "controls" }]);
  });

  it("flags clicks and fields outside main or a dialog, unsupported controls and roles, and never adds a step for them", () => {
    const out = compileLearnedSteps([
      button("Help", "other"),
      { kind: "click", role: "button", name: "Collapse", landmark: "navigation" },
      { kind: "type", field: "Global search", landmark: "other" },
      { kind: "unsupported", control: "checkbox", name: "Include vacated", landmark: "main" },
      { kind: "unsupported", control: "unlabelled-field", name: "", landmark: "main" },
      { kind: "click", role: "option", name: "Pending", landmark: "main" },
      button("Help", "other"),
    ], pack);
    expect(out.steps).toEqual([{ read: "controls" }]);
    expect(out.flags).toEqual([
      { code: "outside-main", label: "Help" }, { code: "outside-main", label: "Collapse" }, { code: "outside-main", label: "Global search" },
      { code: "unsupported", label: "Include vacated" }, { code: "unsupported", label: "unlabelled-field" }, { code: "unsupported", label: "Pending" },
    ]);
  });

  it("records no step for a sign-in and flags only a page off the portal and its sign-in hosts", () => {
    const out = compileLearnedSteps([
      { kind: "page", url: `${FICTIONAL_REI_SIGNIN}/login`, table: false }, { kind: "secret", landmark: "main" },
      page("/dashboard"), { kind: "page", url: "https://elsewhere.fictional.test/", table: false },
    ], pack);
    expect(out.steps).toEqual([{ read: "controls" }]);
    expect(out.flags).toEqual([{ code: "off-portal", label: "https://elsewhere.fictional.test" }]);
  });

  it("gives each field its own input key and reuses it when the same field is typed again later", () => {
    const long = "A very long field label that keeps going past thirty two";
    const out = compileLearnedSteps([typed("Date from"), typed("Date-from"), button("View"), typed("Date from"), typed(long), typed(`${long}!`), typed("2024")], pack);
    expect(out.inputs).toEqual(["date_from", "date_from_2", "a_very_long_field_label_that_kee", "a_very_long_field_label_that_k_2", "value"]);
    expect(out.inputs.every(key => LEARN_INPUT.test(key))).toBe(true);
    expect(out.steps.filter(step => "type" in step)).toHaveLength(6);
  });

  it("inserts one modal wait per run of dialog steps and one table wait per page", () => {
    const out = compileLearnedSteps([
      page("/list", true), button("View", "dialog"), typed("Search", "dialog"), button("Status"), button("View", "dialog"),
      page("/other", true), page("/third", true),
    ], pack);
    expect(out.steps).toEqual([
      { wait: "table" }, { wait: "modal" }, { click: "View" }, { type: { field: "Search", value: "{search}" } }, { click: "Status" },
      { wait: "modal" }, { click: "View" }, { wait: "table" }, { read: "table" },
    ]);
  });

  it("flags a label with braces, which the runner would read as a placeholder", () => {
    const out = compileLearnedSteps([page("/dashboard"), button("Show {all}"), typed("Ref {id}")], pack);
    expect(out.steps.some(step => "click" in step || "type" in step)).toBe(false);
    expect(out.flags).toEqual([{ code: "unsupported", label: "Show {all}" }, { code: "unsupported", label: "Ref {id}" }]);
  });

  it("stops before a risky label the pack doesn't list and flags it, never a step or a stop label", () => {
    for (const label of ["Save changes", "SAVE", "Finalise month", "OK", "Continue", "Sign in", "Confirm", "Yes, proceed"]) {
      const out = compileLearnedSteps([page("/tenants", true), button("View"), button(label, "dialog"), button("View")], pack);
      expect(out.steps, label).toEqual([{ wait: "table" }, { click: "View" }, { wait: "table" }, { read: "table" }]);
      expect(out.flags, label).toEqual([{ code: "unsupported", label }]);
      expect(out.stopBefore, label).toEqual([]);
      // Still a valid pack recipe: stopBefore stays within the pack's consequential list.
      expect(() => parsePortalRecipePack({ ...pack, recipes: { ...pack.recipes, "learned-x": { kind: "read", tier: [], inputs: [], grantNeeds: [], steps: out.steps, stopBefore: out.stopBefore } } })).not.toThrow();
    }
    // An exact shipped consequential label still goes to stopBefore; shipped read-safe labels are not risky.
    expect(compileLearnedSteps([button("Save")], pack).stopBefore).toEqual(["Save"]);
    expect(compileLearnedSteps([button("Search"), button("Open details")], pack).steps).toEqual([{ click: "Search" }, { click: "Open details" }, { read: "controls" }]);
  });

  it("turns pager clicks into a paged table read, never a nav or click step", () => {
    const out = compileLearnedSteps([page("/customers/arrears/", true), { kind: "click", role: "link", name: "2", landmark: "navigation" }, button("Notice")], pack);
    expect(out.steps).toEqual([{ wait: "table" }, { read: "table" }, { paginate: true }]);
    expect(out.stopBefore).toEqual(["Notice"]);
    expect(out.flags).toEqual([]);
    // Next/Previous in a pager landmark are not flagged outside-main; a pager reload of the same listing stays on it.
    const paged = compileLearnedSteps([
      page("/customers/arrears/", true), typed("From day"), { kind: "click", role: "link", name: "Next", landmark: "other" }, page("/customers/arrears/", true),
      { kind: "click", role: "button", name: "Previous", landmark: "navigation" },
      menu("Tenants"), menu("List"), page("/customers/tenant", false),
    ], pack);
    expect(paged.flags).toEqual([]);
    expect(paged.steps).toEqual([
      { wait: "table" }, { type: { field: "From day", value: "{from_day}" } }, { wait: "table" }, { read: "table" }, { paginate: true },
      { nav: ["Tenants", "List"] }, { read: "controls" },
    ]);
  });

  it("turns a chosen option into an input: the option is never part of the recording or the recipe", () => {
    const out = compileLearnedSteps([page("/tenants", true), { kind: "select", field: "Status", landmark: "main" }, { kind: "select", field: "Status", landmark: "main" }, typed("Status")], pack);
    expect(out.steps).toEqual([{ wait: "table" }, { select: { field: "Status", option: "{status}" } }, { type: { field: "Status", value: "{status}" } }, { wait: "table" }, { read: "table" }]);
    expect(out.inputs).toEqual(["status"]);
  });

  it("adds no step for a click on a row's data and never keeps its text, while pack and risky labels keep their handling", () => {
    const rows = ["A6103 MCKI", "$1,050.00", "1,050.00 AUD", "Fictional Tenant Bravo, 2 Fictional Street, Fictional Town, a cell longer than sixty"];
    const out = compileLearnedSteps([page("/customers/tenant", true), ...rows.map(name => ({ kind: "click", role: "link", name, landmark: "main" }) as LearnEvent), button("View")], pack);
    expect(out.steps).toEqual([{ wait: "table" }, { click: "View" }, { wait: "table" }, { read: "table" }]);
    expect(out.flags).toEqual([{ code: "unsupported", label: LEARN_ROW_VALUE }]);
    expect(JSON.stringify(out)).not.toMatch(/A6103|1,050|Bravo/);
    // A consequential label with a digit still stops the recipe; a risky one still ends it.
    expect(compileLearnedSteps([button("Form 9")], pack).stopBefore).toEqual(["Form 9"]);
    expect(compileLearnedSteps([button("Pay $10"), button("View")], pack)).toMatchObject({ steps: [{ read: "controls" }], flags: [{ code: "unsupported", label: "Pay $10" }] });
  });

  it("ends with a controls read when the last page showed no table", () => {
    expect(compileLearnedSteps([page("/a", true), page("/b", false)], pack).steps).toEqual([{ read: "controls" }]);
    expect(compileLearnedSteps([], pack).steps).toEqual([{ read: "controls" }]);
  });
});
