import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { applyPropertyPack } from "./hermes-pack.ts";
import { HERMES_PIN } from "./hermes-pin.ts";
import { withWorkerProfile } from "./hermes-profile.ts";
import { inspectLedgerColumns } from "./import-inspect.ts";
import { fakeHermes } from "./testing/fake-hermes.ts";
import { WINDOWS_PROFILE_TEST_OPTIONS } from "./testing/private-profile-fixture.ts";

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

  describe("per-seat worker profile", WINDOWS_PROFILE_TEST_OPTIONS, () => {
    const seatFake = () => {
      const fake = fakeHermes(`{"mapping":{"identity":"Property"},"confidence":"high"}`);
      fake.dir = realpathSync(fake.dir);
      dirs.push(fake.dir);
      return fake;
    };

    it("reads the upload with the seat's own profile, not the shared base", async () => {
      const { dir, script, argsFile } = seatFake();
      withWorkerProfile("dana", () => applyPropertyPack(dir));
      const result = await withWorkerProfile("dana", () => inspectLedgerColumns(CSV, { cli: script, root: dir }));
      expect(result.mapping).toEqual({ identity: "Property" });
      const args = readFileSync(argsFile, "utf8").split("\n");
      expect(args[args.indexOf("--profile") + 1]).toBe(`${HERMES_PIN.profile}-dana`);
    });

    it("holds instead of borrowing the base profile when the seat has no pack", async () => {
      const { dir, script, argsFile } = seatFake();
      const result = await withWorkerProfile("sam", () => inspectLedgerColumns(CSV, { cli: script, root: dir }));
      expect(result.mapping).toBeNull();
      expect(result.detail).toContain(`"${HERMES_PIN.profile}-sam" pack is missing`);
      expect(existsSync(argsFile)).toBe(false);
    });
  });

  it("does not spawn the live worker under VITEST without a cli stub", async () => {
    const result = await inspectLedgerColumns(CSV);
    expect(result.mapping).toBeNull();
    expect(result.detail).toMatch(/tests/);
  });
});
