import { withWorkerProfile } from "./hermes-profile.ts";
import { applyPropertyPack } from "./hermes-pack.ts";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HERMES_PIN } from "./hermes-pin.ts";
import type { LedgerFacts } from "./desk.ts";
import { parseLedgerFacts, tryHermesLedger, tryHermesPing, uncoveredPropertyIds, workerMissReason } from "./hermes-hands.ts";
import { seedVault } from "./vault.ts";
import { HermesAgentDriver } from "./drivers/acp/hermes.ts";
import { fakeHermes } from "./testing/fake-hermes.ts";
import { WINDOWS_PROFILE_TEST_OPTIONS } from "./testing/private-profile-fixture.ts";

const fixture: LedgerFacts[] = [
  { propertyId: "prop-oak", daysSinceDue: 3, rentLanded: false, levyPaid: false, daysSinceCourtesy: null },
];

const dirs: string[] = [];

function stubHermes(...args: Parameters<typeof fakeHermes>) {
  const fake = fakeHermes(...args);
  fake.root = realpathSync(fake.root);
  fake.dir = realpathSync(fake.dir);
  dirs.push(fake.dir);
  return fake;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("workerMissReason", () => {
  it("turns a refused provider key into one plain line without the scanner noise", () => {
    const stderr =
      "⚠ tirith security scanner enabled but not available — command scanning will use pattern matching only\n" +
      "API call failed after 3 retries: An error occurred (UnrecognizedClientException) when calling the Converse operation\n";
    const reason = workerMissReason("session_id: abc\n", stderr);
    expect(reason).toBe("the model provider refused Bud's key; check the model connection on You");
    expect(reason).not.toMatch(/tirith|UnrecognizedClient/);
  });

  it("names billing, rate limits, and a missing model", () => {
    expect(workerMissReason("", "Error: insufficient_quota (402)")).toMatch(/Billing or credits exhausted/);
    expect(workerMissReason("", "429 Too Many Requests")).toMatch(/rate-limiting/);
    expect(workerMissReason("", "No model configured for profile property")).toMatch(/no model is connected/);
  });

  it("keeps an unknown failure honest but bounded to one line", () => {
    const long = "x".repeat(300);
    const reason = workerMissReason(`first line\n${long}`, "");
    expect(reason.length).toBeLessThanOrEqual(120);
    expect(reason.endsWith("…")).toBe(true);
    expect(workerMissReason("", "")).toBe("");
  });
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
    const { dir, script } = stubHermes(
      `[{"propertyId":"prop-oak","daysSinceDue":3,"rentLanded":false,"levyPaid":false,"daysSinceCourtesy":null}]`,
    );
    const attempt = await tryHermesLedger(["prop-oak"], { cli: script, root: dir });
    expect(attempt.rows).toEqual(fixture);
    expect(attempt.detail).toMatch(/answered with 1 ledger rows/);
  });

  it("misses cleanly when the worker answers chatter", async () => {
    const { dir, script } = stubHermes("Sure, here are the rows I would check!");
    const attempt = await tryHermesLedger(["prop-oak"], { cli: script, root: dir });
    expect(attempt.rows).toBeNull();
    expect(attempt.detail).toMatch(/without ledger facts/);
  });

  it("explains when the worker correctly observed no ledger facts", async () => {
    const { dir, script } = stubHermes("[]");
    const attempt = await tryHermesLedger(["prop-oak"], { cli: script, root: dir });
    expect(attempt.rows).toBeNull();
    expect(attempt.detail).toMatch(/no ledger facts/);
  });

  it("surfaces the provider's own error words (billing, auth) in the detail", async () => {
    const { dir, script } = stubHermes("", 1, "Billing or credits exhausted: HTTP 402");
    const attempt = await tryHermesLedger(["prop-oak"], { cli: script, root: dir });
    expect(attempt.rows).toBeNull();
    expect(attempt.detail).toContain("Billing or credits exhausted");
    expect(attempt.detail).toMatch(/held/);
  });

  it("finds the real error on stdout even when stderr is only warnings", async () => {
    const { dir, script } = stubHermes("Billing or credits exhausted: HTTP 402", 1, "session_id: 123");
    const attempt = await tryHermesLedger(["prop-oak"], { cli: script, root: dir });
    expect(attempt.rows).toBeNull();
    expect(attempt.detail).toContain("Billing or credits exhausted");
    expect(attempt.detail).not.toContain("session_id");
  });
});

describe("tryHermesPing (fake pinned CLI)", () => {
  it("is ok when the worker answers OK", async () => {
    const { dir, script } = stubHermes("OK");
    const ping = await tryHermesPing({ cli: script, root: dir });
    expect(ping.ok).toBe(true);
    expect(ping.detail).toMatch(/answered OK/);
    expect(ping.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  // Per-seat isolation: the whole point of the office host is that two seats never
  // share one Hermes profile, because a profile carries one memory, skills store
  // and session database. These pin that execution resolves the profile it was
  // given rather than always the shared base — the regression would be silent,
  // since every seat would keep working while quietly sharing each other's state.
  describe("per-seat worker profiles", WINDOWS_PROFILE_TEST_OPTIONS, () => {
    const profileArg = (argsFile: string): string => {
      const args = readFileSync(argsFile, "utf8").split("\n");
      const at = args.indexOf("--profile");
      expect(at, `no --profile in: ${args.join(" ")}`).toBeGreaterThanOrEqual(0);
      return args[at + 1] ?? "";
    };

    it("runs the base profile when no seat is given, so single-seat installs are unchanged", async () => {
      const { dir, script, argsFile } = stubHermes("OK");
      await tryHermesPing({ cli: script, root: dir });
      expect(profileArg(argsFile)).toBe(HERMES_PIN.profile);
    });

    it("runs the seat's own profile once a seat is given", async () => {
      const { dir, script, argsFile } = stubHermes("OK");
      withWorkerProfile("dana", () => applyPropertyPack(dir));
      await tryHermesPing({ cli: script, root: dir, memberKey: "dana" });
      expect(profileArg(argsFile)).toBe(`${HERMES_PIN.profile}-dana`);
    });

    it("never resolves two seats to one profile", async () => {
      const seen: string[] = [];
      for (const seat of ["dana", "sam"]) {
        const { dir, script, argsFile } = stubHermes("OK");
        withWorkerProfile(seat, () => applyPropertyPack(dir));
        await tryHermesPing({ cli: script, root: dir, memberKey: seat });
        seen.push(profileArg(argsFile));
      }
      expect(new Set(seen).size).toBe(2);
      expect(seen).not.toContain(HERMES_PIN.profile);
    });

    it("resolves the same seat to the same profile every time", async () => {
      const first = stubHermes("OK");
      withWorkerProfile("dana", () => applyPropertyPack(first.dir));
      await tryHermesPing({ cli: first.script, root: first.dir, memberKey: "dana" });
      const second = stubHermes("OK");
      withWorkerProfile("dana", () => applyPropertyPack(second.dir));
      await tryHermesPing({ cli: second.script, root: second.dir, memberKey: "dana" });
      expect(profileArg(first.argsFile)).toBe(profileArg(second.argsFile));
    });

    it("carries the seat through the ledger read too, not just the ping", async () => {
      const { dir, script, argsFile } = stubHermes(JSON.stringify(fixture));
      withWorkerProfile("sam", () => applyPropertyPack(dir));
      await tryHermesLedger(["prop-oak"], { cli: script, root: dir, memberKey: "sam" });
      expect(profileArg(argsFile)).toBe(`${HERMES_PIN.profile}-sam`);
    });

    it("normalises a hostile seat string instead of letting it name a profile", async () => {
      // A seat key reaches the profile name, which is a directory name. It must be
      // sanitised, so a caller cannot climb out of the profiles directory.
      const { dir, script, argsFile } = stubHermes("OK");
      withWorkerProfile("../../etc/passwd", () => applyPropertyPack(dir));
      await tryHermesPing({ cli: script, root: dir, memberKey: "../../etc/passwd" });
      const profile = profileArg(argsFile);
      expect(profile).not.toContain("/");
      expect(profile).not.toContain("..");
      expect(profile.startsWith(`${HERMES_PIN.profile}-`)).toBe(true);
    });

    it("carries an office-host member uuid through to the spawned profile", async () => {      // The seat identity from realbud_company.members.id is a uuid. This is the
      // shape the office host will pass, so pin it end to end rather than only
      // through the resolver's own unit test.
      const memberId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
      const { dir, script, argsFile } = stubHermes("OK");
      withWorkerProfile(memberId, () => applyPropertyPack(dir));
      await tryHermesPing({ cli: script, root: dir, memberKey: memberId });
      expect(profileArg(argsFile)).toBe(`${HERMES_PIN.profile}-${memberId}`);
    });

    it("a blank seat is no seat, so a desk that never resolved one keeps the base", async () => {
      const { dir, script, argsFile } = stubHermes("OK");
      withWorkerProfile("", () => applyPropertyPack(dir));
      await tryHermesPing({ cli: script, root: dir, memberKey: "" });
      expect(profileArg(argsFile)).toBe(HERMES_PIN.profile);
    });
  });

  it("fails with the provider's words when the model cannot answer", async () => {
    const { dir, script } = stubHermes("Billing or credits exhausted: HTTP 402", 1);
    const ping = await tryHermesPing({ cli: script, root: dir });
    expect(ping.ok).toBe(false);
    expect(ping.detail).toContain("Billing or credits exhausted");
  });

  it("fails cleanly when the pack is missing", async () => {
    const ping = await tryHermesPing({ cli: "/bin/false", root: "/tmp/realbud-no-such-home" });
    expect(ping.ok).toBe(false);
    expect(ping.detail).toMatch(/Bud is not set up/);
  });

  it("refuses to spawn when the pack's approvals are not manual", async () => {
    const { dir, script } = stubHermes("OK");
    const profile = join(dir, "profiles", HERMES_PIN.profile);
    writeFileSync(join(profile, "config.yaml"), "approvals:\n  mode: yolo\n");
    const attempt = await tryHermesLedger(["prop-oak"], { cli: script, root: dir });
    expect(attempt.rows).toBeNull();
    expect(attempt.detail).toMatch(/safeguards need attention/);

    const ping = await tryHermesPing({ cli: script, root: dir });
    expect(ping.ok).toBe(false);
    expect(ping.detail).toMatch(/safeguards need attention/);
  });
});

describe.skipIf(process.platform === "win32")("hermes CLI argv contract", () => {
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
    // The worker is told to report only facts it observed, so the prompt must say
    // what to observe. Ask has always pointed at DESK-CONTEXT.md (ask-book.ts:101);
    // this path did not, so the morning check asked for book facts while naming no
    // book — every run returned a one-of-six answer with the rest held, and nothing
    // in the suite noticed.
    expect(prompt).toContain("DESK-CONTEXT.md");
    expect(prompt).toContain("properties/");
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


it("holds an interrupted installation before pinging or reading property facts", async () => {
  const root = mkdtempSync(join(tmpdir(), "bud-interrupted-hands-")); dirs.push(root);
  writeFileSync(join(root, ".realbud-bootstrap.json"), JSON.stringify({ version: 1, pending: true, childPid: null }));
  expect(await tryHermesPing({ root, cli: "must-not-be-spawned" })).toMatchObject({ ok: false, detail: expect.stringContaining("setup did not finish") });
  expect(await tryHermesLedger(["fictional-property"], { root, cli: "must-not-be-spawned" })).toMatchObject({ rows: null, detail: expect.stringContaining("setup did not finish") });
});

it("does not borrow a configured base pack for an unconfigured member", async () => {
  const { dir, script, argsFile } = stubHermes("OK");
  const result = await tryHermesPing({ cli: script, root: dir, memberKey: "new-member" });
  expect(result).toMatchObject({ ok: false, detail: expect.stringContaining("not set up") });
  expect(() => readFileSync(argsFile, "utf8")).toThrow();
});
