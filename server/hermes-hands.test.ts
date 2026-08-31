import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HERMES_PIN } from "./hermes-pin.ts";
import type { LedgerFacts } from "./desk.ts";
import { parseLedgerFacts, tryHermesLedger, tryHermesPing, uncoveredPropertyIds } from "./hermes-hands.ts";
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
  // pack marker so tryHermesLedger passes its first gate
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

describe("uncoveredPropertyIds", () => {
  it("returns requested ids the worker omitted", () => {
    expect(uncoveredPropertyIds(["prop-oak", "prop-harbour"], fixture)).toEqual(["prop-harbour"]);
    expect(uncoveredPropertyIds(["prop-oak"], fixture)).toEqual([]);
  });
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

  it("distinguishes a valid empty observation from malformed output", () => {
    expect(parseLedgerFacts("[]")).toEqual([]);
  });

  it("strips ANSI color codes before finding the JSON array", () => {
    const rows = parseLedgerFacts(
      "\x1b[33mwarning: loading skill\x1b[0m\n" +
        `[{"propertyId":"prop-oak","daysSinceDue":3,"rentLanded":false,"levyPaid":false,"daysSinceCourtesy":null}]`,
    );
    expect(rows).toEqual([
      { propertyId: "prop-oak", daysSinceDue: 3, rentLanded: false, levyPaid: false, daysSinceCourtesy: null },
    ]);
  });

  it("finds the answer after reasoning that quotes the instructions", () => {
    // Live: the worker reasons "the prompt says return [] exactly…" before
    // answering — the first bracket is prose, the answer is the last block.
    expect(
      parseLedgerFacts('The prompt says "return [] exactly" when nothing is observable.\nNone of the notes carry ledger facts.\n[]'),
    ).toEqual([]);
  });

  it("reads JSON followed by trailing prose", () => {
    const rows = parseLedgerFacts(
      `[{"propertyId":"prop-oak","daysSinceDue":3,"rentLanded":false,"levyPaid":false,"daysSinceCourtesy":null}]\n\nHope that helps.`,
    );
    expect(rows).toEqual([
      { propertyId: "prop-oak", daysSinceDue: 3, rentLanded: false, levyPaid: false, daysSinceCourtesy: null },
    ]);
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
    expect(attempt.detail).toMatch(/without ledger JSON/);
  });

  it("explains when the worker correctly observed no ledger facts", async () => {
    const { dir, script } = fakeHermes("[]");
    const attempt = await tryHermesLedger(["prop-oak"], { cli: script, root: dir });
    expect(attempt.rows).toBeNull();
    expect(attempt.detail).toMatch(/no observed ledger facts/);
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

  it("fails cleanly when the pack is missing", async () => {
    const ping = await tryHermesPing({ cli: "/bin/false", root: "/tmp/realbud-no-such-home" });
    expect(ping.ok).toBe(false);
    expect(ping.detail).toMatch(/pack is missing/);
  });

  it("refuses to spawn when the pack's approvals are not manual", async () => {
    const { dir, script } = fakeHermes("OK");
    const profile = join(dir, "profiles", HERMES_PIN.profile);
    writeFileSync(join(profile, "config.yaml"), "approvals:\n  mode: yolo\n");
    const attempt = await tryHermesLedger(["prop-oak"], { cli: script, root: dir });
    expect(attempt.rows).toBeNull();
    expect(attempt.detail).toMatch(/manual approvals/);

    const ping = await tryHermesPing({ cli: script, root: dir });
    expect(ping.ok).toBe(false);
    expect(ping.detail).toMatch(/manual approvals/);
  });
});

describe("hermes CLI argv contract", () => {
  it("invokes the worker with the exact pinned profile and headless flags", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-argv-"));
    dirs.push(dir);
    const profile = join(dir, "profiles", HERMES_PIN.profile);
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
    writeFileSync(join(profile, "config.yaml"), "approvals:\n  mode: manual\ncron_mode: deny\n");
    const script = join(dir, "hermes");
    const head = join(dir, "argv-head.txt");
    const promptFile = join(dir, "argv-prompt.txt");
    const tail = join(dir, "argv-tail.txt");
    writeFileSync(
      script,
      // record argv without word-splitting (absolute paths: the child's cwd
      // is the caller's, not this directory)
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Hermes Agent v0.20.3 (2026.8.16.2)"; exit 0; fi\n` +
        `printf "%s\\n" "$1|$2|$3|$4|$5" > "${head}"\n` +
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
    expect(readFileSync(tail, "utf8").trim()).toBe("--max-turns|6");
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toContain("Morning arrears check. Use skill morning-arrears.");
    expect(prompt).toContain("Do not send, pay, or draft a statutory notice.");
    expect(prompt).toContain("prop-oak");
    expect(prompt).toContain("Do not copy sample values");
    expect(prompt).toContain("return [] exactly");
    expect(prompt).not.toContain("training book");
    expect(prompt).not.toContain("copy fixture");
  });

  it("runs the ledger spawn with cwd equal to the book", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-cwd-"));
    dirs.push(dir);
    const profile = join(dir, "profiles", HERMES_PIN.profile);
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
    writeFileSync(join(profile, "config.yaml"), "approvals:\n  mode: manual\ncron_mode: deny\n");
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
