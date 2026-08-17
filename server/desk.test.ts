import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  Desk,
  evaluateProperty,
  fixtureBook,
  type LedgerFacts,
  type Property,
} from "./desk.ts";

const dirs: string[] = [];

function tempDesk() {
  const dir = mkdtempSync(join(tmpdir(), "realbud-desk-"));
  dirs.push(dir);
  let now = new Date(2026, 7, 17, 8, 0, 0).getTime();
  const desk = new Desk({ file: join(dir, "desk.json"), now: () => now });
  return {
    desk,
    now: () => now,
    setNow: (value: number) => {
      now = value;
    },
  };
}

function property(id: string): Property {
  return fixtureBook().properties.find((p) => p.id === id)!;
}

function facts(id: string, patch: Partial<LedgerFacts> = {}): LedgerFacts {
  return { ...fixtureBook().ledger.find((row) => row.propertyId === id)!, ...patch };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("evaluateProperty", () => {
  it("drafts a courtesy when rent is unpaid past grace", () => {
    const result = evaluateProperty(property("prop-oak"), facts("prop-oak"));
    expect(result).toMatchObject({
      outcome: "draft",
      reason: "rent-unpaid-courtesy",
      daysLate: 3,
    });
  });

  it("flags levy-from-rent when rent landed and the levy has not gone out", () => {
    const result = evaluateProperty(property("prop-harbour"), facts("prop-harbour"));
    expect(result).toMatchObject({
      outcome: "draft",
      reason: "rent-landed-levy-unpaid",
    });
  });

  it("does not draft again when a courtesy already went this period", () => {
    const result = evaluateProperty(property("prop-pine"), facts("prop-pine"));
    expect(result).toMatchObject({
      outcome: "skip",
      reason: "already-reminded",
    });
  });

  it("escalates with no draft once the statutory clock starts", () => {
    const result = evaluateProperty(property("prop-king"), facts("prop-king"));
    expect(result).toMatchObject({
      outcome: "escalate",
      reason: "statutory-clock",
      daysLate: 10,
    });
  });

  it("skips rent still inside grace", () => {
    expect(evaluateProperty(property("prop-flora"), facts("prop-flora"))).toMatchObject({
      outcome: "skip",
      reason: "inside-grace",
    });
  });

  it("clears a paid tenancy with no levy", () => {
    expect(evaluateProperty(property("prop-birch"), facts("prop-birch"))).toMatchObject({
      outcome: "clear",
      reason: "rent-landed",
    });
  });
});

describe("Desk morning check", () => {
  it("opens courtesy and levy drafts, escalates statutory, and never sends", () => {
    const { desk } = tempDesk();
    const snap = desk.runMorningCheck();
    const pending = snap.drafts.filter((d) => d.status === "pending");
    expect(pending.map((d) => d.kind).sort()).toEqual(["courtesy-rent", "levy-from-rent"]);
    expect(pending.find((d) => d.kind === "levy-from-rent")?.body).toMatch(/will not move trust/i);
    expect(pending.find((d) => d.kind === "levy-from-rent")?.body).not.toMatch(/from the receipt/i);
    expect(pending.find((d) => d.kind === "courtesy-rent")?.body).toMatch(/does not start any notice period/i);
    expect(snap.escalations).toHaveLength(1);
    expect(snap.escalations[0]?.detail).toMatch(/not a legal clock/i);
    expect(snap.drafts.every((d) => !("sentAt" in d) && d.status === "pending")).toBe(true);
    expect((desk as unknown as { sendDraft?: unknown }).sendDraft).toBeUndefined();
  });

  it("does not open a second draft on re-run, after allow, or the next day", () => {
    const { desk, now, setNow } = tempDesk();
    desk.runMorningCheck();
    const first = desk.snapshot().drafts.map((d) => d.id).sort();
    desk.runMorningCheck();
    expect(desk.snapshot().drafts.map((d) => d.id).sort()).toEqual(first);

    const courtesy = desk.snapshot().drafts.find((d) => d.kind === "courtesy-rent")!;
    desk.allowDraft(courtesy.id);
    expect(desk.snapshot().drafts.find((d) => d.id === courtesy.id)?.status).toBe("allowed");
    desk.runMorningCheck();
    const courtesyDrafts = desk.snapshot().drafts.filter((d) => d.kind === "courtesy-rent");
    expect(courtesyDrafts).toHaveLength(1);
    expect(courtesyDrafts[0]?.status).toBe("allowed");

    setNow(now() + 86_400_000);
    desk.runMorningCheck();
    expect(desk.snapshot().drafts.filter((d) => d.kind === "courtesy-rent")).toHaveLength(1);
  });

  it("allow / deny / edit only touch pending drafts and never mark them sent", () => {
    const { desk } = tempDesk();
    desk.runMorningCheck();
    const courtesy = desk.snapshot().drafts.find((d) => d.kind === "courtesy-rent")!;
    const levy = desk.snapshot().drafts.find((d) => d.kind === "levy-from-rent")!;

    const edited = desk.editDraft(courtesy.id, "Hi Sam — still waiting on rent. You have 7 days or we issue a notice.");
    expect(edited.status).toBe("pending");
    expect(edited.body).toMatch(/still waiting/);
    expect(edited.body).toMatch(/does not start any notice period/i);

    desk.denyDraft(levy.id);
    expect(desk.snapshot().drafts.find((d) => d.id === levy.id)?.status).toBe("denied");

    desk.allowDraft(courtesy.id);
    const allowed = desk.snapshot().drafts.find((d) => d.id === courtesy.id)!;
    expect(allowed.status).toBe("allowed");
    expect(allowed).not.toHaveProperty("sentAt");
    expect(() => desk.allowDraft(courtesy.id)).toThrow(/already decided/);
  });

  it("never strips the hard never-rules off a property", () => {
    const { desk } = tempDesk();
    const patched = desk.patchProperty("prop-oak", { graceDays: 2 });
    expect(patched.options.never).toEqual(["statutory-send", "trust-pay"]);
    expect(() => desk.patchProperty("prop-oak", { courtesyUntilDay: 2 })).toThrow(/after grace/);
  });
});
