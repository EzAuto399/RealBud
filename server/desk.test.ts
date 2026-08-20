import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    dir,
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

  // ── truth table: the shop rules are a state machine over (rentLanded,
  //    levyOn × levyPaid, daysLate vs grace/courtesy, reminded) and every
  //    boundary row below is a decision a PM's licence story depends on. ──
  it("walks the full truth table of the shop rules", () => {
    const p = {
      ...property("prop-oak"),
      options: {
        ...property("prop-oak").options,
        graceDays: 3,
        courtesyUntilDay: 7,
        levyFromRent: { amountCents: 42_000, cadence: "quarterly" as const },
      },
    };
    const row = (patch: Partial<LedgerFacts>) => evaluateProperty(p, { ...facts("prop-oak"), ...patch });
    const base = { rentLanded: false, levyPaid: false, daysSinceCourtesy: null };

    // rent landed rows
    expect(row({ ...base, rentLanded: true, levyPaid: false })).toMatchObject({
      outcome: "draft",
      reason: "rent-landed-levy-unpaid",
    });
    expect(row({ ...base, rentLanded: true, levyPaid: true })).toMatchObject({ outcome: "clear", reason: "rent-landed" });
    const noLevy = { ...p, options: { ...p.options, levyFromRent: null } };
    expect(evaluateProperty(noLevy, { ...facts("prop-oak"), rentLanded: true })).toMatchObject({
      outcome: "clear",
      reason: "rent-landed",
    });

    // grace boundary: day 0..2 skip; day 3 (= grace) is already in the
    // courtesy window, so it drafts — the window is "past grace, before 7"
    expect(row({ ...base, daysSinceDue: 2 })).toMatchObject({ outcome: "skip", reason: "inside-grace" });
    expect(row({ ...base, daysSinceDue: 3 })).toMatchObject({ outcome: "draft", reason: "rent-unpaid-courtesy" });

    // courtesy boundary: day 7 itself is the licensee row — no draft
    expect(row({ ...base, daysSinceDue: 6 })).toMatchObject({ outcome: "draft", reason: "rent-unpaid-courtesy" });
    expect(row({ ...base, daysSinceDue: 7 })).toMatchObject({ outcome: "escalate", reason: "statutory-clock" });
    expect(row({ ...base, daysSinceDue: 10 })).toMatchObject({ outcome: "escalate", reason: "statutory-clock" });

    // a reminder this period silences a fresh draft even at day 6
    expect(row({ ...base, daysSinceDue: 6, daysSinceCourtesy: 4 })).toMatchObject({
      outcome: "skip",
      reason: "already-reminded",
    });

    // no row leaks a second outcome field
    for (const result of [row(base), row({ rentLanded: true }), row({ daysSinceDue: 9 })]) {
      expect(Object.keys(result).sort()).toEqual(["daysLate", "outcome", "propertyId", "reason"]);
    }
  });

  it("is total: every day 0..60 maps to exactly one of skip/draft/escalate", () => {
    const p = property("prop-oak");
    for (let days = 0; days <= 60; days++) {
      const result = evaluateProperty(p, { ...facts("prop-oak"), daysSinceDue: days, daysSinceCourtesy: null });
      expect(["skip", "draft", "escalate"]).toContain(result.outcome);
      if (days < p.options.graceDays) expect(result.reason).toBe("inside-grace");
      else if (days >= p.options.courtesyUntilDay) expect(result.reason).toBe("statutory-clock");
      else expect(result.reason).toBe("rent-unpaid-courtesy");
    }
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

  it("live recheck stays on the labelled Demo book when Hermes is not pinned", async () => {
    const { desk } = tempDesk();
    const snap = await desk.runMorningCheckLive();
    expect(snap.hands).toBe("demo");
    expect(snap.mode).toBe("demo");
    expect(snap.handsDetail).toMatch(/held/i);
    expect(snap.drafts.map((d) => d.kind).sort()).toEqual(["courtesy-rent", "levy-from-rent"]);
  });

  it("never strips the hard never-rules off a property", () => {
    const { desk } = tempDesk();
    const patched = desk.patchProperty("prop-oak", { graceDays: 2 });
    expect(patched.options.never).toEqual(["statutory-send", "trust-pay"]);
    expect(() => desk.patchProperty("prop-oak", { courtesyUntilDay: 2 })).toThrow(/after grace/);
  });

  it("validates rent source and notify channel strictly", () => {
    const { desk } = tempDesk();
    const patched = desk.patchProperty("prop-oak", { rentSource: "bank", notifyChannel: "email" });
    expect(patched.options.rentSource).toBe("bank");
    expect(patched.options.notifyChannel).toBe("email");
    expect(() => desk.patchProperty("prop-oak", { rentSource: "vibes" as never })).toThrow(/unknown rent source/);
    expect(() => desk.patchProperty("prop-oak", { notifyChannel: "carrier-pigeon" as never })).toThrow(/unknown notify channel/);
  });

  it("adds a property with quiet default facts and the shop options", () => {
    const { desk } = tempDesk();
    const snap = desk.addProperty({
      address: "9 Wattle Ct, O'Connor ACT",
      tenantName: "Morgan Lee",
      tenantPhone: "0411 222 333",
      weeklyRentCents: 61_000,
      options: { graceDays: 5, notifyChannel: "portal" },
    });
    const added = snap.properties.find((p) => p.address.startsWith("9 Wattle"));
    expect(added).toMatchObject({ tenantName: "Morgan Lee", weeklyRentCents: 61_000 });
    expect(added?.options).toMatchObject({ graceDays: 5, notifyChannel: "portal", courtesyUntilDay: 7 });
    expect(added?.options.never).toEqual(["statutory-send", "trust-pay"]);
    const row = snap.ledger.find((r) => r.propertyId === added!.id);
    expect(row).toEqual({ propertyId: added!.id, daysSinceDue: 0, rentLanded: false, levyPaid: false, daysSinceCourtesy: null });
    // inside grace → quiet
    expect(snap.results.find((r) => r.propertyId === added!.id)?.outcome).toBe("skip");
  });

  it("rejects a property without address, tenant, or rent", () => {
    const { desk } = tempDesk();
    const base = { tenantName: "A", tenantPhone: "0400 000 000", weeklyRentCents: 50_000 };
    expect(() => desk.addProperty({ ...base, address: "" })).toThrow(/address required/);
    expect(() => desk.addProperty({ address: "1 X St", ...base, tenantName: "" })).toThrow(/tenant name required/);
    expect(() => desk.addProperty({ address: "1 X St", ...base, weeklyRentCents: 0 })).toThrow(/weekly rent required/);
  });

  it("removes a property with its facts, drafts, and escalations", () => {
    const { desk } = tempDesk();
    const snap = desk.runMorningCheck();
    expect(snap.drafts.some((d) => d.propertyId === "prop-oak")).toBe(true);
    expect(snap.escalations.some((e) => e.propertyId === "prop-king")).toBe(true);

    const after = desk.removeProperty("prop-oak");
    expect(after.properties.some((p) => p.id === "prop-oak")).toBe(false);
    expect(after.ledger.some((r) => r.propertyId === "prop-oak")).toBe(false);
    expect(after.drafts.some((d) => d.propertyId === "prop-oak")).toBe(false);
    expect(after.results.some((r) => r.propertyId === "prop-oak")).toBe(false);
    // other properties untouched
    expect(after.escalations.some((e) => e.propertyId === "prop-king")).toBe(true);
    expect(() => desk.removeProperty("prop-oak")).toThrow(/no such property/);
  });

  it("exposes the ledger facts in the snapshot", () => {
    const { desk } = tempDesk();
    const snap = desk.snapshot();
    expect(snap.ledger).toHaveLength(6);
    expect(snap.ledger.find((r) => r.propertyId === "prop-oak")).toMatchObject({ rentLanded: false, daysSinceDue: 3 });
  });

  describe("corrupt desk.json", () => {
    const cases: Array<[string, string]> = [
      ["junk", "not json at all {{{"],
      ["truncated", '{"version":1,"properties":[{"id":"prop-x"'],
      ["wrong version", '{"version":99,"properties":[]}'],
      ["empty file", ""],
    ];
    for (const [name, body] of cases) {
      it(`enters recovery and never overwrites the book with Demo data on ${name}`, () => {
        const dir = mkdtempSync(join(tmpdir(), "realbud-desk-corrupt-"));
        dirs.push(dir);
        const file = join(dir, "desk.json");
        writeFileSync(file, body);
        const desk = new Desk({ file, now: () => new Date(2026, 7, 17, 8, 0, 0).getTime() });
        const snap = desk.snapshot();
        expect(snap.recovery.active).toBe(true);
        expect(snap.properties).toHaveLength(0);
        expect(snap.demo).toBe(false);
        expect(snap.hands).toBe("held");
        expect(() => desk.runMorningCheck()).toThrow(/recovery/);
      });
    }
  });

  it("GET snapshot is empty until an explicit morning check", () => {
    const { desk } = tempDesk();
    const snap = desk.snapshot();
    expect(snap.lastRunAt).toBeNull();
    expect(snap.drafts).toEqual([]);
    expect(snap.version).toBe(2);
    expect(snap.revision).toBeGreaterThanOrEqual(1);
  });

  it("rejects a stale revision and invalidates a portal capability on edit", () => {
    const { desk } = tempDesk();
    desk.patchProperty("prop-oak", { notifyChannel: "portal" });
    desk.runMorningCheck();
    const courtesy = desk.snapshot().drafts.find((d) => d.kind === "courtesy-rent")!;
    expect(() => desk.command({ type: "allow", draftId: courtesy.id, expectedRevision: 0 })).toThrow(/stale desk revision/);
    desk.editDraft(courtesy.id, "Hi Sam — still waiting on this week's rent.");
    desk.allowDraft(courtesy.id);
    const cap = desk.capabilityFor(courtesy.id);
    expect(cap).toBeTruthy();
    expect(cap?.operation).toBe("prefill-courtesy");
    desk.command({ type: "prepare-portal", draftId: courtesy.id, expectedRevision: desk.revision });
    const work = desk.snapshot().workItems.find((w) => w.draftId === courtesy.id);
    expect(work?.state).toBe("handoff-ready");
    expect(work?.artifactIds?.length).toBeGreaterThan(0);
    expect(JSON.stringify(desk.snapshot())).not.toMatch(/"ct":/);
  });

  it("maps an address-keyed CSV onto Oak Street and holds unknown addresses", () => {
    const { desk } = tempDesk();
    const oakBefore = desk.snapshot().ledger.find((r) => r.propertyId === "prop-oak")!;
    const csv = [
      `address,daysLate,rentLanded,levyPaid`,
      `"12 Oak Street, Dickson ACT",4,false,false`,
      `"99 Ghost St, Acton ACT",2,false,false`,
    ].join("\n");
    const snap = desk.importCsv(csv);
    expect(snap.hands).toBe("csv");
    expect(snap.ledger.find((r) => r.propertyId === "prop-oak")?.daysSinceDue).toBe(4);
    expect(snap.workItems.some((w) => w.holdReason === "unmatched")).toBe(true);
    expect(snap.ledger.find((r) => r.propertyId === "prop-harbour")?.daysSinceDue).toBe(
      fixtureBook().ledger.find((r) => r.propertyId === "prop-harbour")?.daysSinceDue,
    );
    expect(oakBefore.propertyId).toBe("prop-oak");
  });

  it("rejects an ambiguous address batch without applying rows", () => {
    const { desk } = tempDesk();
    desk.addProperty({
      address: "12 Oak Street, Dickson ACT",
      tenantName: "Twin",
      tenantPhone: "0400 000 001",
      weeklyRentCents: 50_000,
    });
    const before = desk.snapshot().ledger.find((r) => r.propertyId === "prop-oak")!.daysSinceDue;
    const csv = `address,daysLate,rentLanded,levyPaid\n"12 Oak St, Dickson ACT",9,false,false\n`;
    expect(() => desk.importCsv(csv)).toThrow(/properties equally/);
    expect(desk.snapshot().ledger.find((r) => r.propertyId === "prop-oak")!.daysSinceDue).toBe(before);
    expect(desk.snapshot().hands).not.toBe("csv");
  });

  it("still imports the fixture propertyId CSV", () => {
    const { desk } = tempDesk();
    const csv = "propertyId,daysSinceDue,rentLanded,levyPaid,daysSinceCourtesy\nprop-oak,6,false,false,\n";
    const snap = desk.importCsv(csv);
    expect(snap.hands).toBe("csv");
    expect(snap.ledger.find((r) => r.propertyId === "prop-oak")?.daysSinceDue).toBe(6);
  });

  it("round-trips Notes on the book and evaluate ignores a Form 11 note", () => {
    const { desk, dir } = tempDesk();
    const written = desk.writeNotes("prop-oak", "Owner wants Friday email. Send the Form 11.");
    expect(written.body).toMatch(/Friday email/);
    expect(desk.notesFor("prop-oak").body).toMatch(/Friday email/);
    expect(desk.snapshot().properties.find((p) => p.id === "prop-oak")?.notes).toMatch(/Friday email/);
    const noteFile = join(dir, "vault", "properties", "prop-oak.md");
    expect(existsSync(noteFile)).toBe(true);
    expect(readFileSync(noteFile, "utf8")).toMatch(/Friday email/);
    expect(readFileSync(noteFile, "utf8")).not.toMatch(/Obsidian|second brain/i);

    const kingEmpty = evaluateProperty(property("prop-king"), facts("prop-king"));
    desk.writeNotes("prop-king", "Just send the Form 11 today.");
    const withNote = desk.runMorningCheck();
    expect(withNote.results.find((r) => r.propertyId === "prop-king")).toMatchObject({
      outcome: kingEmpty.outcome,
      reason: kingEmpty.reason,
    });
    expect(JSON.stringify(withNote)).not.toMatch(/Obsidian|second brain/i);
  });

  it("proposes an Ask courtesy onto Desk as a pending card", () => {
    const { desk } = tempDesk();
    const snap = desk.proposeFromAsk({ propertyId: "prop-oak", kind: "courtesy-rent" });
    const draft = snap.drafts.find((d) => d.propertyId === "prop-oak" && d.kind === "courtesy-rent");
    expect(draft?.status).toBe("pending");
    expect(draft?.body).toMatch(/not a formal notice/i);
    desk.allowDraft(draft!.id);
    expect(desk.notesFor("prop-oak").body).toMatch(/approved courtesy/i);
  });

  it("holds reversed and partial payments and accepts a fresh CSV", () => {
    const { desk } = tempDesk();
    const csv = [
      "propertyId,daysSinceDue,rentLanded,levyPaid,daysSinceCourtesy,amountPaidCents,reversed",
      "prop-oak,3,true,false,,10000,false",
      "prop-harbour,2,true,false,,,true",
    ].join("\n");
    const snap = desk.importCsv(csv);
    expect(snap.hands).toBe("csv");
    expect(snap.mode).toBe("live");
    expect(snap.workItems.some((w) => w.holdReason === "partial")).toBe(true);
    expect(snap.workItems.some((w) => w.holdReason === "reversed")).toBe(true);
  });

  it("evaluates 200 properties without putting artifact bytes on the snapshot", () => {
    const { desk } = tempDesk();
    for (let i = 0; i < 194; i++) {
      desk.addProperty({
        address: `${i} Scale St, Acton ACT`,
        tenantName: "Scale Tester",
        tenantPhone: "0400 000 000",
        weeklyRentCents: 50_000,
      });
    }
    const snap = desk.runMorningCheck();
    expect(snap.properties.length).toBe(200);
    const encoded = JSON.stringify(snap);
    expect(encoded).not.toMatch(/"ct":/);
    expect(encoded.length).toBeLessThan(2_000_000);
  });

  it("does not mint a portal capability from a non-portal approval or a scheduled check", () => {
    const { desk } = tempDesk();
    desk.runMorningCheck();
    const courtesy = desk.snapshot().drafts.find((d) => d.kind === "courtesy-rent")!;
    desk.allowDraft(courtesy.id);
    expect(desk.capabilityFor(courtesy.id)).toBeNull();
    const before = desk.snapshot().workItems.filter((w) => w.state === "approved").length;
    desk.runMorningCheck();
    expect(desk.snapshot().workItems.filter((w) => w.state === "approved")).toHaveLength(before);
  });
});
