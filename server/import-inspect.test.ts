import { chmodSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyPropertyPack } from "./hermes-pack.ts";
import { HERMES_PIN } from "./hermes-pin.ts";
import { withWorkerProfile } from "./hermes-profile.ts";
import { inspectLedgerColumns } from "./import-inspect.ts";
import { fakeHermes } from "./testing/fake-hermes.ts";
import { WINDOWS_PROFILE_TEST_OPTIONS } from "./testing/private-profile-fixture.ts";
import { clearManagedAccess, FICTIONAL_GRANTED_KEY, grantManagedAccess } from "./testing/managed-grant.ts";
import { startAskModelRelay } from "./ask-model-relay.ts";
import { propertyProfileDir } from "./hermes-pack.ts";

const CSV = `Property,Days in arrears,Rent received,Levies
12 Oak St,5,false,false
`;

const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  clearManagedAccess();
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

  it("gives the worker only the Ask relay's token and overlay, never the office key, and nothing to a tampered endpoint", async () => {
    const { dir } = fakeHermes("unused");
    dirs.push(dir);
    const captured = join(dir, "worker-key.json");
    const script = join(dir, "key-check.mjs");
    const answer = `{"mapping":{"identity":"Property"},"confidence":"high"}`;
    writeFileSync(script, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nif (process.argv.includes('--version')) { console.log('Hermes Agent v0.20.3 (2026.8.16.2)'); process.exit(0); }\nwriteFileSync(${JSON.stringify(captured)}, JSON.stringify({ grant: process.env.REALBUD_MODEL_API_KEY ?? null, openai: process.env.OPENAI_API_KEY ?? null, managedDir: process.env.HERMES_MANAGED_DIR ?? null }));\nconsole.log(${JSON.stringify(answer)});\n`);
    chmodSync(script, 0o755);
    vi.stubEnv("OPENAI_API_KEY", "fictional-ambient-openai");
    vi.stubEnv("REALBUD_MODEL_API_KEY", "fictional-ambient-grant");
    grantManagedAccess(dir);
    const relay = await startAskModelRelay({ root: dir, overlayDir: join(dir, "relay-overlay") });
    try {
      const result = await inspectLedgerColumns(CSV, { cli: script, root: dir });
      expect(result.mapping).toMatchObject({ identity: "Property" });
      const child = JSON.parse(readFileSync(captured, "utf8"));
      expect(child).toMatchObject({ openai: null, managedDir: relay.overlayDir });
      expect(child.grant).toEqual(expect.any(String));
      expect(child.grant).not.toBe(FICTIONAL_GRANTED_KEY);
      // A tampered profile endpoint gets neither the relay nor a key.
      const config = join(propertyProfileDir(dir), "config.yaml");
      writeFileSync(config, readFileSync(config, "utf8").replace("https://gateway.fictional.test/v1", "https://attacker.invalid/v1"));
      await inspectLedgerColumns(CSV, { cli: script, root: dir });
      expect(JSON.parse(readFileSync(captured, "utf8"))).toEqual({ grant: null, openai: null, managedDir: null });
    } finally { await relay.close(); }
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
