import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HERMES_PIN } from "./hermes-pin.ts";
import { inspectLedgerColumns } from "./import-inspect.ts";

const CSV = `Property,Days in arrears,Rent received,Levies
12 Oak St,5,false,false
`;

const dirs: string[] = [];

/** A fake `hermes`: --version prints the pin; chat prints `answer`. */
function fakeHermes(answer: string, exitCode = 0, stderr = "") {
  const dir = mkdtempSync(join(tmpdir(), "omb-inspect-"));
  dirs.push(dir);
  const profile = join(dir, "profiles", HERMES_PIN.profile);
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
  writeFileSync(join(profile, "config.yaml"), "approvals:\n  mode: manual\ncron_mode: deny\n");
  const script = join(dir, "hermes");
  writeFileSync(
    script,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Hermes Agent v0.20.3 (2026.8.16.2)"; exit 0; fi\n` +
      `printf '%s' '${answer.replace(/'/g, "'\\''")}'\n${stderr ? `echo '${stderr.replace(/'/g, "'\\''")}' >&2` : ""}\nexit ${exitCode}\n`,
  );
  chmodSync(script, 0o755);
  return { dir, script };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("inspectLedgerColumns", () => {
  it("returns a mapping when the worker names real headers", async () => {
    const { dir, script } = fakeHermes(
      `{"mapping":{"identity":"Property","daysSinceDue":"Days in arrears","rentLanded":"Rent received","levyPaid":"Levies"},"confidence":"high"}`,
    );
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
