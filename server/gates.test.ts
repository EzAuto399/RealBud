// THE GATES CANARY. RealBud's product is its hard gates: draft-only, no
// send, no trust, no notice drafting, no Hermes Desktop/cron, locked
// never-rules, headless worker, no starter bot, no prompt-runner. Each gate
// is asserted somewhere in the suite; this file re-asserts ALL of them in
// one place so a regression in any of them fails here first and loudly.
import { mkdtempSync as makeTemp, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { applyPropertyPack, PACK_DIR } from "./hermes-pack.ts";
import { Desk, NEVER_ACTIONS } from "./desk.ts";
import { LOOP_CATALOG } from "./routines.ts";

import { privateFixtureRoot, WINDOWS_PROFILE_TEST_OPTIONS } from "./testing/private-profile-fixture.ts";

const dirs: string[] = [];
const mkdtempSync = (prefix: string) => realpathSync(makeTemp(prefix));
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDesk() {
  const dir = mkdtempSync(join(tmpdir(), "realbud-gates-"));
  dirs.push(dir);
  return new Desk({ file: join(dir, "desk.json") });
}

describe("hard gates (canary)", () => {
  it("never-actions are statutory-send and trust-pay — nothing else sneaks in", () => {
    expect(NEVER_ACTIONS).toEqual(["statutory-send", "trust-pay"]);
  });

  it("every property, fresh or edited, keeps both never-rules", () => {
    const desk = tempDesk();
    const added = desk.addProperty({
      address: "1 Gate St, Fyshwick ACT",
      tenantName: "Gate Tester",
      tenantPhone: "0400 000 000",
      weeklyRentCents: 50_000,
      options: { never: ["nothing"] as never }, // hostile input is ignored
    });
    const property = added.properties.find((p) => p.address.startsWith("1 Gate"));
    expect(property?.options.never).toEqual(["statutory-send", "trust-pay"]);
    const patched = desk.patchProperty(property!.id, { never: ["trust-pay"] } as never);
    expect(patched.options.never).toEqual(["statutory-send", "trust-pay"]);
  });

  it("the courtesy disclaimer cannot be stripped by an edit", () => {
    const desk = tempDesk();
    const snap = desk.runMorningCheck();
    const draft = snap.drafts.find((d) => d.kind === "courtesy-rent")!;
    const edited = desk.editDraft(draft.id, "Pay up. You have 7 days or we issue a notice.");
    expect(edited.body).toMatch(/not a formal notice/i);
    expect(edited.body).toMatch(/does not start any notice period/i);
  });

  it("approving a draft marks it allowed — it never gains a sentAt or a send path", () => {
    const desk = tempDesk();
    const draft = desk.runMorningCheck().drafts.find((d) => d.kind === "courtesy-rent")!;
    const allowed = desk.allowDraft(draft.id);
    expect(allowed.status).toBe("allowed");
    expect(allowed).not.toHaveProperty("sentAt");
    expect(allowed).not.toHaveProperty("sent");
  });

  it("the product fleet is the pinned Hermes worker only", () => {
    expect(BUILT_IN_DRIVERS.map((d) => d.driverKind)).toEqual(["hermesAgent"]);
  });

  it("the property pack locks approvals to manual and cron to deny — no yolo", WINDOWS_PROFILE_TEST_OPTIONS, () => {
    const home = privateFixtureRoot(join(tmpdir(), "realbud-gates-pack-"));
    dirs.push(home);
    applyPropertyPack(home);
    const config = readFileSync(join(home, "profiles", "property", "config.yaml"), "utf8");
    expect(config).toMatch(/mode:\s*manual/);
    expect(config).toMatch(/cron_mode:\s*deny/);
    expect(config).toMatch(/backend:\s*local/);
    expect(config).toMatch(/home_mode:\s*profile/);
    expect(config).toMatch(/redact_secrets:\s*true/);
    expect(config).not.toMatch(/mode:\s*(off|smart|yolo)/);
    expect(config).not.toMatch(/cron_mode:\s*(on|allow)/);
    expect(config).not.toMatch(/backend:\s*none/);
  });

  it("the pack soul refuses send, pay, and notices in its own words", () => {
    const soul = readFileSync(join(PACK_DIR, "SOUL.md"), "utf8");
    expect(soul).toMatch(/Draft only/);
    expect(soul).toMatch(/No notices\. No trust/);
    expect(soul).toMatch(/never send/i);
  });

  it("loops are named product loops — no prompts, no bots, no Hermes cron", () => {
    expect(LOOP_CATALOG.map((loop) => loop.id)).toEqual(["morning-arrears", "owner-letter", "inbound-triage"]);
    for (const loop of LOOP_CATALOG) {
      expect(loop).not.toHaveProperty("prompt");
      expect(loop).not.toHaveProperty("botId");
      expect(loop).not.toHaveProperty("runOn");
    }
  });

  it("the escalation copy states the shop rule and refuses to draft a notice", () => {
    const desk = tempDesk();
    const escalation = desk.runMorningCheck().escalations[0];
    expect(escalation.reason).toBe("statutory-clock");
    expect(escalation.detail).toMatch(/shop reminder rule, not a legal clock/i);
    expect(escalation.detail).toMatch(/RealBud will not draft or send one/i);
  });
});
