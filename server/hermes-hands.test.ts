import { mkdtempSync, readFileSync, realpathSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HERMES_PIN } from "./hermes-pin.ts";
import { applyPropertyPack, withYamlBlock } from "./hermes-pack.ts";
import type { LedgerFacts } from "./desk.ts";
import { parseLedgerFacts, tryHermesLedger, tryHermesPing } from "./hermes-hands.ts";
import { seedVault } from "./vault.ts";
import { HermesAgentDriver } from "./drivers/acp/hermes.ts";

const fixture: LedgerFacts[] = [
  { propertyId: "prop-oak", daysSinceDue: 3, rentLanded: false, levyPaid: false, daysSinceCourtesy: null },
];

const dirs: string[] = [];

/** A fake `hermes`: --version prints the pin; chat prints `answer`. */
function fakeHermes(answer: string, exitCode = 0, stderr = "") {
  const dir = mkdtempSync(join(tmpdir(), "omb-hands-"));
  dirs.push(dir);
  // Exact pack attestation is part of the spawn gate. Tests install the real
  // checked-in pack, then add only the dynamic model block it permits.
  const profile = applyPropertyPack(dir).dir;
  const config = join(profile, "config.yaml");
  writeFileSync(
    config,
    withYamlBlock(readFileSync(config, "utf8"), "model", "model:\n  default: grok-4\n  provider: xai\n  base_url: ''\n"),
  );
  writeFileSync(join(profile, ".env"), "XAI_API_KEY=fixture-key\n");
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

describe("parseLedgerFacts", () => {
  it("reads a bare JSON array", () => {
    const rows = parseLedgerFacts(
      `[{"propertyId":"prop-oak","daysSinceDue":3,"rentLanded":false,"levyPaid":false,"daysSinceCourtesy":null}]`,
    );
    expect(rows).toEqual([
      { propertyId: "prop-oak", daysSinceDue: 3, rentLanded: false, levyPaid: false, daysSinceCourtesy: null },
    ]);
  });

  it("rejects chatter without valid facts", () => {
    expect(parseLedgerFacts("I will send the notice now")).toBeNull();
    expect(parseLedgerFacts("not json")).toBeNull();
  });

  it("rejects the string \"false\" instead of coercing it truthy", () => {
    expect(
      parseLedgerFacts(
        `[{"propertyId":"prop-oak","daysSinceDue":3,"rentLanded":"false","levyPaid":false,"daysSinceCourtesy":null}]`,
      ),
    ).toBeNull();
  });
});

describe("tryHermesLedger (fake pinned CLI)", () => {
  it("returns rows and a success detail when the worker answers JSON", async () => {
    const { dir, script } = fakeHermes(
      `[{"propertyId":"prop-oak","daysSinceDue":3,"rentLanded":false,"levyPaid":false,"daysSinceCourtesy":null}]`,
    );
    const attempt = await tryHermesLedger(["prop-oak"], { cli: script, root: dir });
    expect(attempt.rows).toEqual(fixture);
    expect(attempt.detail).toMatch(/answered with 1 ledger rows/);
  });

  it("misses cleanly when the worker answers chatter", async () => {
    const { dir, script } = fakeHermes("Sure, here are the rows I would check!");
    const attempt = await tryHermesLedger(["prop-oak"], { cli: script, root: dir });
    expect(attempt.rows).toBeNull();
    expect(attempt.detail).toMatch(/without ledger facts/);
  });

  it("surfaces the provider's own error words (billing, auth) in the detail", async () => {
    const { dir, script } = fakeHermes("", 1, "Billing or credits exhausted: HTTP 402");
    const attempt = await tryHermesLedger(["prop-oak"], { cli: script, root: dir });
    expect(attempt.rows).toBeNull();
    expect(attempt.detail).toContain("Billing or credits exhausted");
    expect(attempt.detail).toMatch(/held/);
  });

  it("finds the real error on stdout even when stderr is only warnings", async () => {
    const { dir, script } = fakeHermes("Billing or credits exhausted: HTTP 402", 1, "session_id: 123");
    const attempt = await tryHermesLedger(["prop-oak"], { cli: script, root: dir });
    expect(attempt.rows).toBeNull();
    expect(attempt.detail).toContain("Billing or credits exhausted");
    expect(attempt.detail).not.toContain("session_id");
  });
});

describe("tryHermesPing (fake pinned CLI)", () => {
  it("is ok when the worker answers OK", async () => {
    const { dir, script } = fakeHermes("OK");
    const ping = await tryHermesPing({ cli: script, root: dir });
    expect(ping.ok).toBe(true);
    expect(ping.detail).toMatch(/answered OK/);
    expect(ping.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("fails with the provider's words when the model cannot answer", async () => {
    const { dir, script } = fakeHermes("Billing or credits exhausted: HTTP 402", 1);
    const ping = await tryHermesPing({ cli: script, root: dir });
    expect(ping.ok).toBe(false);
    expect(ping.detail).toContain("Billing or credits exhausted");
  });

  it("stops before spawning when no model is attached", async () => {
    const { dir, script } = fakeHermes("OK");
    const profile = join(dir, "profiles", HERMES_PIN.profile);
    const config = join(profile, "config.yaml");
    writeFileSync(config, withYamlBlock(readFileSync(config, "utf8"), "model", null));
    rmSync(join(profile, ".env"));

    const ping = await tryHermesPing({ cli: script, root: dir });
    expect(ping.ok).toBe(false);
    expect(ping.detail).toMatch(/Choose a provider, model and key in You/);
    expect(ping.detail).not.toMatch(/Hermes|terminal/i);
  });

  it("keeps engine setup and credentials out of provider failures", async () => {
    const { dir, script } = fakeHermes(
      "",
      1,
      "Or set OPENAI_API_KEY in your environment.\nRun 'worker setup' in an interactive terminal.",
    );
    const ping = await tryHermesPing({ cli: script, root: dir });
    expect(ping.ok).toBe(false);
    expect(ping.detail).toBe("The model could not authenticate. Reconnect it in You.");
    expect(ping.detail).not.toMatch(/Hermes|terminal|API_KEY/i);
  });

  it("redacts a credential echoed by a provider error", async () => {
    const fakeSecret = "sk-test-abcdefghijklmnopqrstuvwxyz012345";
    const { dir, script } = fakeHermes("", 1, `Authentication failed: api_key=${fakeSecret}`);
    const ping = await tryHermesPing({ cli: script, root: dir });
    expect(ping.ok).toBe(false);
    expect(ping.detail).toContain("Authentication failed");
    expect(ping.detail).toContain("redacted");
    expect(ping.detail).not.toContain(fakeSecret);
  });

  it("fails cleanly when the pack is missing", async () => {
    const ping = await tryHermesPing({ cli: "/bin/false", root: "/tmp/realbud-no-such-home" });
    expect(ping.ok).toBe(false);
    expect(ping.detail).toMatch(/pack is missing/);
  });

  it("refuses to spawn when the pack's approval safety config is altered", async () => {
    const { dir, script } = fakeHermes("OK");
    const profile = join(dir, "profiles", HERMES_PIN.profile);
    const config = join(profile, "config.yaml");
    writeFileSync(config, readFileSync(config, "utf8").replace("mode: manual", "mode: yolo"));
    const attempt = await tryHermesLedger(["prop-oak"], { cli: script, root: dir });
    expect(attempt.rows).toBeNull();
    expect(attempt.detail).toMatch(/pack is missing|re-apply/i);

    const ping = await tryHermesPing({ cli: script, root: dir });
    expect(ping.ok).toBe(false);
    expect(ping.detail).toMatch(/pack is missing|apply it again/i);
  });
});

describe("hermes CLI argv contract", () => {
  it("invokes the worker with the exact pinned profile and headless flags", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-argv-"));
    dirs.push(dir);
    applyPropertyPack(dir);
    const script = join(dir, "hermes");
    const head = join(dir, "argv-head.txt");
    const promptFile = join(dir, "argv-prompt.txt");
    const tail = join(dir, "argv-tail.txt");
    const workerHome = join(dir, "worker-home.txt");
    writeFileSync(
      script,
      // record argv without word-splitting (absolute paths: the child's cwd
      // is the caller's, not this directory)
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Hermes Agent v0.20.3 (2026.8.16.2)"; exit 0; fi\n` +
        `printf "%s\\n" "$1|$2|$3|$4|$5" > "${head}"\n` +
        `printf "%s" "$HERMES_HOME" > "${workerHome}"\n` +
        `printf "%s" "$6" > "${promptFile}"\n` +
        `printf "%s|%s\\n" "$7" "$8" > "${tail}"\n` +
        `printf '%s' '[{"propertyId":"prop-oak","daysSinceDue":3,"rentLanded":false,"levyPaid":false,"daysSinceCourtesy":null}]'\n`,
    );
    chmodSync(script, 0o755);

    const attempt = await tryHermesLedger(["prop-oak"], { cli: script, root: dir });
    expect(attempt.rows).toEqual(fixture);

    // the contract: any change to these flags breaks the worker seam and
    // must be deliberate (pin bump), never accidental
    expect(readFileSync(head, "utf8").trim()).toBe(`--profile|${HERMES_PIN.profile}|chat|-Q|-q`);
    expect(readFileSync(workerHome, "utf8")).toBe(dir);
    expect(readFileSync(tail, "utf8").trim()).toBe("--max-turns|2");
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toContain("Morning arrears check. Use skill morning-arrears.");
    expect(prompt).toContain("Do not send, pay, or draft a statutory notice.");
    expect(prompt).toContain("prop-oak");
    expect(prompt).toContain("Do not copy sample values");
    expect(prompt).not.toContain("training book");
    expect(prompt).not.toContain("copy fixture");
  });

  it("runs the ledger spawn with cwd equal to the book", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-cwd-"));
    dirs.push(dir);
    applyPropertyPack(dir);
    const book = seedVault();
    const cwdFile = join(dir, "cwd.txt");
    const script = join(dir, "hermes");
    writeFileSync(
      script,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Hermes Agent v0.20.3 (2026.8.16.2)"; exit 0; fi\n` +
        `pwd > "${cwdFile}"\n` +
        `printf '%s' '[{"propertyId":"prop-oak","daysSinceDue":3,"rentLanded":false,"levyPaid":false,"daysSinceCourtesy":null}]'\n`,
    );
    chmodSync(script, 0o755);
    const attempt = await tryHermesLedger(["prop-oak"], { cli: script, root: dir });
    expect(attempt.rows?.[0]?.propertyId).toBe("prop-oak");
    expect(realpathSync(readFileSync(cwdFile, "utf8").trim())).toBe(realpathSync(book));
    expect(HermesAgentDriver.defaultConfig().workspace).toBe(book);
    expect(HermesAgentDriver.decodeConfig({}).workspace).toBe(book);
  });
});
