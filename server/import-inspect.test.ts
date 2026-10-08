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
import type { JevAnswer, JevRequest, JevResult } from "./jev-client.ts";
import { listHistory } from "./computer-history.ts";

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

  it("reads the whole mapping when trailing prose has its own braces", async () => {
    const { dir, script } = fakeHermes(
      `{"mapping":{"identity":"Property","levyPaid":"Levies"},"confidence":"high"}\nMatched {2} headers.`,
    );
    dirs.push(dir);
    const result = await inspectLedgerColumns(CSV, { cli: script, root: dir });
    expect(result.mapping).toEqual({ identity: "Property", levyPaid: "Levies" });
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

  describe("Jev first", () => {
    const sure = (choice: string): JevAnswer => ({ type: "choice", choice, confidence: 0.95, probabilities: { [choice]: 0.95, none: 0.05 } });
    const all = { identity: sure("h0"), daysSinceDue: sure("h1"), rentLanded: sure("h2"), levyPaid: sure("h3") };
    const jev = (answers: Record<string, JevAnswer> | (() => Promise<JevResult>), ready = true) => {
      const asked: JevRequest[] = [];
      const decide = async (request: JevRequest): Promise<JevResult> => {
        asked.push(request);
        return typeof answers === "function" ? answers() : { ok: true, id: "dec-fictional", model: "fictional-decider", ms: 1, answers };
      };
      return { asked, jev: { decide, ready: () => ready } };
    };
    const BUD = `{"mapping":{"identity":"Property","daysSinceDue":"Days in arrears"},"confidence":"high"}`;

    it("names every role from the header names alone, without running Bud", async () => {
      const { asked, jev: injected } = jev(all);
      const result = await inspectLedgerColumns(CSV, { jev: injected });
      expect(result).toEqual({ mapping: { identity: "Property", daysSinceDue: "Days in arrears", rentLanded: "Rent received", levyPaid: "Levies" }, detail: "Bud read the columns." });
      expect(asked).toHaveLength(1);
      expect(asked[0].state).toEqual({ headers: ["Property", "Days in arrears", "Rent received", "Levies"] });
      expect(Object.keys(asked[0].questions)).toEqual(["identity", "daysSinceDue", "rentLanded", "levyPaid"]);
      expect(asked[0].questions.identity).toMatchObject({ type: "choice", criteria: { h0: "Property", h3: "Levies", none: expect.any(String) } });
      expect(JSON.stringify(asked[0])).not.toContain("12 Oak St");
    });

    it("keeps the Jev call's cost as a history row, since the inspection saves nothing else", async () => {
      const { jev: injected } = jev(all);
      await inspectLedgerColumns(CSV, { jev: injected });
      expect(listHistory(1)[0]).toMatchObject({ name: "ledger columns", ok: true,
        usage: { requestIds: ["dec-fictional"], calls: 1, decisions: [{ id: "dec-fictional", model: "fictional-decider", ms: 1 }] } });
      // A refused call made no request: no row.
      const before = listHistory(50).length;
      await inspectLedgerColumns(CSV, { jev: jev(async () => ({ ok: false, reason: "refused" }) as JevResult).jev });
      expect(listHistory(50)).toHaveLength(before);
    });

    it.each([
      ["a low-confidence role", { ...all, levyPaid: { ...sure("h3"), confidence: 0.8 } }],
      ["a narrow lead", { ...all, levyPaid: { type: "choice", choice: "h3", confidence: 0.9, probabilities: { h3: 0.6, h2: 0.4 } } }],
      ["missing probabilities", { ...all, levyPaid: { type: "choice", choice: "h3", confidence: 0.99 } }],
      ["none for a role", { ...all, levyPaid: sure("none") }],
      ["two roles on one header", { ...all, levyPaid: sure("h2") }],
      ["an option that is not a header", { ...all, levyPaid: sure("h9") }],
    ] as [string, Record<string, JevAnswer>][])("falls back to Bud unchanged on %s", async (_label, answers) => {
      const { dir, script } = fakeHermes(BUD);
      dirs.push(dir);
      const { asked, jev: injected } = jev(answers);
      const result = await inspectLedgerColumns(CSV, { cli: script, root: dir, jev: injected });
      expect(asked).toHaveLength(1);
      expect(result).toEqual({ mapping: { identity: "Property", daysSinceDue: "Days in arrears" }, detail: "Bud read the columns." });
    });

    it("falls back to Bud when Jev fails, throws or is not ready", async () => {
      const { dir, script } = fakeHermes(BUD);
      dirs.push(dir);
      for (const answers of [async (): Promise<JevResult> => ({ ok: false, reason: "unavailable" }), async (): Promise<JevResult> => { throw new Error("fictional Jev failure"); }]) {
        const { asked, jev: injected } = jev(answers);
        expect((await inspectLedgerColumns(CSV, { cli: script, root: dir, jev: injected })).mapping).toEqual({ identity: "Property", daysSinceDue: "Days in arrears" });
        expect(asked).toHaveLength(1);
      }
      const { asked, jev: off } = jev(all, false);
      expect((await inspectLedgerColumns(CSV, { cli: script, root: dir, jev: off })).mapping).toEqual({ identity: "Property", daysSinceDue: "Days in arrears" });
      expect(asked).toHaveLength(0);
    });

    it("sends unsafe header names only as option text under safe keys, and maps back to the real headers", async () => {
      const csv = `__proto__,Days (in arrears)!,constructor,Levy paid? y/n\n12 Oak St,5,false,false\n`;
      const { asked, jev: injected } = jev(all);
      const result = await inspectLedgerColumns(csv, { jev: injected });
      expect(result.mapping).toEqual({ identity: "__proto__", daysSinceDue: "Days (in arrears)!", rentLanded: "constructor", levyPaid: "Levy paid? y/n" });
      for (const question of Object.values(asked[0].questions)) {
        if (question.type !== "choice") throw new Error("expected choice");
        expect(Object.keys(question.criteria)).toEqual(["h0", "h1", "h2", "h3", "none"]);
      }
    });

    it("redacts credential-shaped header names before Jev sees them, and maps back to the real header", async () => {
      const secret = "Bearer fictionalbearer0123456789";
      const csv = `Property,Days in arrears,Rent received,${secret}\n12 Oak St,5,false,false\n`;
      const { asked, jev: injected } = jev(all);
      const result = await inspectLedgerColumns(csv, { jev: injected });
      expect(result.mapping).toMatchObject({ levyPaid: secret });
      expect(JSON.stringify(asked[0])).not.toContain("fictionalbearer0123456789");
      expect((asked[0].state as { headers: string[] }).headers[3]).toMatch(/redacted/);
    });

    it.each([
      ["mostly digits", "12 Oak St,5,4021,false"],
      ["an email address", "12 Oak St,tenant@example.test,Rent,Levy"],
      ["a currency amount", "12 Oak St,Days,$1200,Levy"],
      ["a numeric date", "12 Oak St,Days,2026-10-08,Levy"],
      ["a written date", "12 Oak St,Days,8 Oct 2026,Levy"],
    ])("never sends a row 0 that reads like data (%s), and lets Bud read it", async (_label, row) => {
      const { dir, script } = fakeHermes(BUD);
      dirs.push(dir);
      const { asked, jev: injected } = jev(all);
      await inspectLedgerColumns(`${row}\n13 Elm St,2,true,true\n`, { cli: script, root: dir, jev: injected });
      expect(asked).toHaveLength(0);
    });

    it("asks nothing when the file has more headers than Jev options, and lets Bud read it", async () => {
      const { dir, script } = fakeHermes(BUD);
      dirs.push(dir);
      const wide = `${["Property", "Days in arrears", ...Array.from({ length: 62 }, (_, n) => `Fictional ${n}`)].join(",")}\n`;
      const { asked, jev: injected } = jev(all);
      expect((await inspectLedgerColumns(wide, { cli: script, root: dir, jev: injected })).mapping).toEqual({ identity: "Property", daysSinceDue: "Days in arrears" });
      expect(asked).toHaveLength(0);
    });
  });
});
