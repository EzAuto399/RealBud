// THE GATES CANARY. RealBud's product is its hard gates: draft-only, no
// send, no trust, no notice drafting, no Hermes Desktop/cron, locked
// never-rules, headless worker, no starter bot, no prompt-runner. Each gate
// is asserted somewhere in the suite; this file re-asserts ALL of them in
// one place so a regression in any of them fails here first and loudly.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { applyPropertyPack, PACK_DIR } from "./hermes-pack.ts";
import { Desk, NEVER_ACTIONS } from "./desk.ts";
import { LOOP_CATALOG } from "./routines.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDesk() {
  const dir = mkdtempSync(join(tmpdir(), "realbud-gates-"));
  dirs.push(dir);
  return new Desk({ file: join(dir, "desk.json") });
}

function replaceDraftBodyForRecoveryTest(desk: Desk, draftId: string, body: string): void {
  const internal = desk as unknown as { store: { data: { drafts: Array<{ id: string; body: string }> } } };
  const draft = internal.store.data.drafts.find((candidate) => candidate.id === draftId);
  if (!draft) throw new Error("test draft missing");
  draft.body = body;
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

  it("a courtesy edit cannot introduce notice or legal-clock wording", () => {
    const desk = tempDesk();
    const snap = desk.runMorningCheck();
    const draft = snap.drafts.find((d) => d.kind === "courtesy-rent")!;
    expect(() => desk.editDraft(draft.id, "FORMAL NOTICE: Pay within 7 days or the tenancy will be terminated.")).toThrow(/licensed human/i);
    expect(desk.snapshot().drafts.find((item) => item.id === draft.id)?.body).toBe(draft.body);
  });

  it("rechecks legacy or corrupted wording at Allow, not only in the editor", () => {
    const desk = tempDesk();
    const draft = desk.runMorningCheck().drafts.find((item) => item.kind === "courtesy-rent")!;
    replaceDraftBodyForRecoveryTest(desk, draft.id, "You must pay within seven days under section 55(2).");
    expect(() => desk.allowDraft(draft.id)).toThrow(/licensed human/i);
    expect(desk.snapshot().drafts.find((item) => item.id === draft.id)?.status).toBe("pending");
  });

  it("rechecks already-allowed wording before any portal preparation", () => {
    const desk = tempDesk();
    desk.patchProperty("prop-oak", { notifyChannel: "portal" });
    const draft = desk.runMorningCheck().drafts.find((item) => item.kind === "courtesy-rent")!;
    desk.allowDraft(draft.id);
    replaceDraftBodyForRecoveryTest(desk, draft.id, "A Form 11 Notice to Remedy Breach will be issued.");
    expect(() => desk.command({ type: "prepare-portal", draftId: draft.id, expectedRevision: desk.revision })).toThrow(/licensed human/i);
    expect(desk.snapshot().workItems.find((item) => item.draftId === draft.id)?.state).toBe("approved");
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

  it("the property pack locks approvals to manual and cron to deny — no yolo", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-gates-pack-"));
    dirs.push(home);
    applyPropertyPack(home);
    const config = readFileSync(join(home, "profiles", "property", "config.yaml"), "utf8");
    expect(config).toMatch(/mode:\s*manual/);
    expect(config).toMatch(/cron_mode:\s*deny/);
    expect(config).not.toMatch(/mode:\s*(off|smart|yolo)/);
    expect(config).not.toMatch(/cron_mode:\s*(on|allow)/);
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
