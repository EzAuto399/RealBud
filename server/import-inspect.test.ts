import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { inspectLedgerColumns } from "./import-inspect.ts";
import { fakeHermes } from "./testing/fake-hermes.ts";

const CSV = `Property,Days in arrears,Rent received,Levies
12 Oak St,5,false,false
`;

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("inspectLedgerColumns", () => {
  it("returns a mapping when the worker names real headers", async () => {
    const { dir, script } = fakeHermes(
      `{"mapping":{"identity":"Property","daysSinceDue":"Days in arrears","rentLanded":"Rent received","levyPaid":"Levies"},"confidence":"high"}`,
    );
    dirs.push(dir);
    const result = await inspectLedgerColumns(CSV, { cli: script, root: dir });
    expect(result.mapping).toEqual({
      identity: "Property",
      daysSinceDue: "Days in arrears",
      rentLanded: "Rent received",
      levyPaid: "Levies",
    });
    expect(result.detail).toMatch(/read the columns/);
  });

  it("drops a header the worker invented", async () => {
    const { dir, script } = fakeHermes(
      `{"mapping":{"identity":"Property","daysSinceDue":"Not A Column","rentLanded":"Rent received","levyPaid":"Levies"},"confidence":"high"}`,
    );
    dirs.push(dir);
    const result = await inspectLedgerColumns(CSV, { cli: script, root: dir });
    expect(result.mapping).toEqual({
      identity: "Property",
      rentLanded: "Rent received",
      levyPaid: "Levies",
    });
    expect(result.mapping?.daysSinceDue).toBeUndefined();
  });

  it("returns null with an honest detail when the worker answers junk", async () => {
    const { dir, script } = fakeHermes("Sure, looks like address and days to me.");
    dirs.push(dir);
    const result = await inspectLedgerColumns(CSV, { cli: script, root: dir });
    expect(result.mapping).toBeNull();
    expect(result.detail).toMatch(/without column JSON/);
  });

  it("does not spawn the live worker under VITEST without a cli stub", async () => {
    const result = await inspectLedgerColumns(CSV);
    expect(result.mapping).toBeNull();
    expect(result.detail).toMatch(/tests/);
  });
});
