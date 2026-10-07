// Pack recipe documents: the row-filter declaration and the pure filter RealBud applies after a read.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { filterPortalRows, filterPortalRunRows, parsePortalRecipePack, type PortalRowFilter } from "./portal-recipe.ts";
import type { PortalRecipeResult, PortalRunRequest } from "./portal-recipe-runner.ts";

const raw = JSON.parse(readFileSync(new URL("../pack/workflows/austin-accounts/support/rei-cloud-navigation/recipes.json", import.meta.url), "utf8"));
const pack = parsePortalRecipePack(raw);
const withFilter = (rowFilter: unknown, inputs = ["min_days"]) => ({ ...raw, recipes: { ...raw.recipes, x: { kind: "read", tier: [], inputs, grantNeeds: [], steps: [], stopBefore: [], rowFilter } } });
const result = (recipe: string, rows: Array<Record<string, string>>, extra: Partial<PortalRecipeResult> = {}): PortalRecipeResult =>
  ({ recipe, outcome: "completed", rows, filters: {}, table: rows.length ? "rows" : "empty", pages: 1, stopBefore: [], ...extra });

describe("REI read recipes use named controls only", () => {
  it("types and selects only the live portal's named fields, and keeps the morning refresh's recipes and inputs", () => {
    const named = new Set(["Search", "Search:", "Show entries"]);
    for (const name of ["open-session", "find-record", "arrears-review", "tasks-due", "compliance-expiry", "bank-reconciliation-read", "tenant-list"]) {
      const recipe = pack.recipes[name];
      expect(recipe.kind, name).toBe("read");
      for (const step of recipe.steps) {
        const field = (step.type ?? step.select) as { field?: string } | undefined;
        if (field) expect(named.has(String(field.field)), `${name} ${field.field}`).toBe(true);
      }
    }
    expect(pack.recipes["arrears-review"].inputs).toEqual(["min_days"]);
    expect(pack.recipes["tasks-due"].inputs).toEqual(["date_from", "date_to"]);
    expect(pack.recipes["find-record"].inputs).toEqual(["list", "query"]);
    expect(pack.recipes["compliance-expiry"].inputs).toEqual([]);
    expect(pack.labels.readSafe).toEqual(expect.arrayContaining(["Search", "Search:", "Show entries"]));
  });

  it("rejects a row filter that is malformed or names an input the recipe does not take", () => {
    const good: PortalRowFilter = { column: "Days Arrears", op: ">=", input: "min_days", as: "number" };
    expect(parsePortalRecipePack(withFilter([good])).recipes.x.rowFilter).toEqual([good]);
    for (const bad of [{}, [{ ...good, op: "==" }], [{ ...good, as: "text" }], [{ ...good, column: " " }], [{ ...good, input: "days" }], [{ ...good, extra: 1 }], ["x"]]) {
      expect(() => parsePortalRecipePack(withFilter(bad)), JSON.stringify(bad)).toThrow(/damaged/);
    }
  });
});

describe("filterPortalRows", () => {
  const arrears = pack.recipes["arrears-review"], tasks = pack.recipes["tasks-due"];
  it("keeps rows at or above min_days, reading REI's figures and a DataTables sort header", () => {
    const rows = [{ "Days Arrears: activate to sort column ascending": "12" }, { "Days Arrears: activate to sort column ascending": "3" }, { "Days Arrears: activate to sort column ascending": "" }];
    expect(filterPortalRows(arrears, { min_days: "7" }, rows)).toEqual({ rows: [rows[0]], unapplied: [] });
    expect(filterPortalRows(arrears, { min_days: "1" }, [{ "days arrears": "1" }, { "Days Arrears": "0" }]).rows).toEqual([{ "days arrears": "1" }]);
  });
  it("keeps tasks due in the range, from ISO or DD/MM/YYYY dates", () => {
    const rows = [{ "Date Due": "25/09/2026 9:00 AM" }, { "Date Due": "2026-09-26" }, { "Date Due": "1/10/2026" }, { "Date Due": "soon" }];
    expect(filterPortalRows(tasks, { date_from: "2026-09-25", date_to: "2026-09-30" }, rows).rows).toEqual(rows.slice(0, 2));
  });
  it("applies nothing it cannot read: a missing column or input keeps every row and says which", () => {
    const rows = [{ Name: "A" }, { Name: "B" }];
    expect(filterPortalRows(arrears, { min_days: "1" }, rows)).toEqual({ rows, unapplied: ["Days Arrears"] });
    expect(filterPortalRows(arrears, {}, [{ "Days Arrears": "4" }])).toEqual({ rows: [{ "Days Arrears": "4" }], unapplied: ["Days Arrears"] });
    expect(filterPortalRows(arrears, { min_days: "1" }, [])).toEqual({ rows: [], unapplied: [] });
  });
  it("filters each run by its own inputs, keeps the count the portal showed, and leaves unfiltered recipes alone", () => {
    const runs: PortalRunRequest[] = [{ recipe: "arrears-review", inputs: { min_days: "5" } }, { recipe: "find-record", inputs: { list: "Tenants", query: "" } }];
    const read = [result("arrears-review", [{ "Days Arrears": "9" }, { "Days Arrears": "2" }], { footer: 2 }), result("find-record", [{ Surname: "A" }])];
    const [filtered, plain] = filterPortalRunRows(pack, runs, read);
    expect(filtered).toMatchObject({ rows: [{ "Days Arrears": "9" }], footer: 2, filtered: { read: 2, unapplied: [] } });
    expect(plain).toEqual(read[1]);
    expect(read[0].rows).toHaveLength(2); // the runner's result is not changed
  });
});
