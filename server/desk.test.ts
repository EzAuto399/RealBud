import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  Desk,
  MAX_BOOK_PROPERTIES,
  evaluateProperty,
  fixtureBook,
  type LedgerFacts,
  type Property,
} from "./desk.ts";
import { readHandsLast } from "./hands-last.ts";
import type { HermesLedgerAttempt } from "./hermes-hands.ts";
import { removeFixture, windowsAdmissionTimeout } from "./testing/private-fixture.ts";

const dirs: string[] = [];

function tempDesk(opts?: { hermes?: (ids: string[]) => Promise<HermesLedgerAttempt> }) {
  const dir = mkdtempSync(join(tmpdir(), "realbud-desk-"));
  dirs.push(dir);
  let now = new Date(2026, 7, 17, 8, 0, 0).getTime();
  const desk = new Desk({ file: join(dir, "desk.json"), now: () => now, hermes: opts?.hermes });
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

afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeFixture(dir);
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

  it("preserves every morning outcome across a restart", () => {
    const { desk, dir, now } = tempDesk();
    const checked = desk.runMorningCheck();
    expect(checked.results).toHaveLength(checked.properties.length);
    expect(checked.results.some((result) => result.outcome === "clear")).toBe(true);
    expect(checked.results.some((result) => result.outcome === "skip")).toBe(true);

    const reopened = new Desk({ file: join(dir, "desk.json"), now });
    const restored = reopened.snapshot();

    expect(restored.lastRunAt).toBe(checked.lastRunAt);
    expect(restored.results).toEqual(checked.results);
    expect(restored.results).toHaveLength(restored.properties.length);
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
    expect(desk.notesFor(levy.propertyId).body).toMatch(/denied levy flag/);
    expect(desk.notesFor(levy.propertyId).body).not.toMatch(/too soon/);

    desk.allowDraft(courtesy.id);
    const allowed = desk.snapshot().drafts.find((d) => d.id === courtesy.id)!;
    expect(allowed.status).toBe("allowed");
    expect(allowed).not.toHaveProperty("sentAt");
    expect(() => desk.allowDraft(courtesy.id)).toThrow(/already decided/);
  });

  it("records an optional deny reason on the property notes", () => {
    const { desk } = tempDesk();
    desk.runMorningCheck();
    const courtesy = desk.snapshot().drafts.find((d) => d.kind === "courtesy-rent")!;
    const levy = desk.snapshot().drafts.find((d) => d.kind === "levy-from-rent")!;
    const notesBeforeStale = desk.notesFor(courtesy.propertyId).body;
    expect(() => desk.denyDraft(courtesy.id, 0, undefined, "stale reason")).toThrow(
      expect.objectContaining({ status: 409, message: expect.stringMatching(/stale desk revision/) }),
    );
    expect(desk.notesFor(courtesy.propertyId).body).toBe(notesBeforeStale);
    expect(desk.snapshot().drafts.find((d) => d.id === courtesy.id)?.status).toBe("pending");

    desk.denyDraft(courtesy.id, desk.revision, undefined, "  too soon  ");
    const after = desk.notesFor(courtesy.propertyId).body;
    expect(desk.snapshot().drafts.find((d) => d.id === courtesy.id)?.status).toBe("denied");
    expect(after).toMatch(/too soon/);
    expect(after).not.toMatch(/too soon  /);

    desk.denyDraft(levy.id, desk.revision, undefined, "x".repeat(400));
    const levyNotes = desk.notesFor(levy.propertyId).body;
    expect(levyNotes).toContain("x".repeat(280));
    expect(levyNotes).not.toContain("x".repeat(281));
  });

  it("live recheck stays on the labelled Demo book when Hermes is not pinned", async () => {
    const { desk, dir } = tempDesk();
    const snap = await desk.runMorningCheckLive();
    expect(snap.hands).toBe("demo");
    expect(snap.mode).toBe("demo");
    expect(snap.handsDetail).toMatch(/held/i);
    expect(snap.drafts).toEqual([]);
    expect(snap.results).toEqual([]);
    expect(readHandsLast(dir)?.kind).toBe("recheck");
    expect(readHandsLast(dir)?.ok).toBe(false);
    expect(snap.sources.some((s) => s.kind === "hermes" && typeof s.lastCheckedAt === "number")).toBe(true);
  });

  it("holds properties the worker omitted and keeps the chip held", async () => {
    const { desk, dir } = tempDesk({
      hermes: async () => ({
        rows: [
          { propertyId: "prop-oak", daysSinceDue: 0, rentLanded: true, levyPaid: true, daysSinceCourtesy: null },
        ],
        detail: "Worker answered with 1 ledger rows.",
      }),
    });
    const snap = await desk.runMorningCheckLive();
    expect(snap.hands).toBe("held");
    expect(snap.handsDetail).toMatch(/Uncovered stay held/);
    const uncovered = snap.results.filter((row) => row.reason === "uncovered-by-worker");
    expect(uncovered).toHaveLength(snap.properties.length - 1);
    expect(uncovered.every((row) => row.propertyId !== "prop-oak")).toBe(true);
    expect(snap.drafts.some((d) => uncovered.some((row) => row.propertyId === d.propertyId))).toBe(false);
    expect(readHandsLast(dir)?.ok).toBe(false);
    expect(readHandsLast(dir)?.kind).toBe("recheck");
  });

  it("never lets a late worker response overwrite newer Desk work", async () => {
    let finish!: (attempt: HermesLedgerAttempt) => void;
    const provider = new Promise<HermesLedgerAttempt>((resolve) => {
      finish = resolve;
    });
    const { desk } = tempDesk({ hermes: async () => provider });

    const pending = desk.runMorningCheckLive();
    await Promise.resolve();
    const practice = desk.runMorningCheck();
    expect(practice.results).toHaveLength(practice.properties.length);

    finish({ rows: [], detail: "Worker returned no observable rows." });
    await expect(pending).rejects.toMatchObject({ status: 409 });
    expect(desk.snapshot().revision).toBe(practice.revision);
    expect(desk.snapshot().results).toEqual(practice.results);
    expect(desk.snapshot().handsDetail).toBe(practice.handsDetail);
  });

  it("never strips the hard never-rules off a property", () => {
    const { desk } = tempDesk();
    const patched = desk.patchProperty("prop-oak", { graceDays: 2 });
    expect(patched.options.never).toEqual(["statutory-send", "trust-pay"]);
    expect(() => desk.patchProperty("prop-oak", { courtesyUntilDay: 2 })).toThrow(/after grace/);
  });

  it("recomputes cards when a rule moves, without claiming a fresh check", () => {
    const { desk } = tempDesk();
    const checked = desk.command({ type: "check-demo" });
    const ranAt = checked.lastRunAt;
    expect(ranAt).not.toBeNull();
    const before = checked.results.find((r) => r.propertyId === "prop-oak");

    // widen the courtesy window past the late count: the case stops escalating
    desk.patchProperty("prop-oak", { courtesyUntilDay: 60 });
    const after = desk.snapshot();
    expect(after.results.find((r) => r.propertyId === "prop-oak")?.outcome).not.toBe("escalate");
    expect(after.lastRunAt).toBe(ranAt);
    expect(before).toBeDefined();
  });

  it("does not evaluate an unchecked book when a rule moves", () => {
    const { desk } = tempDesk();
    expect(desk.snapshot().lastRunAt).toBeNull();
    desk.patchProperty("prop-oak", { graceDays: 1 });
    const snap = desk.snapshot();
    expect(snap.lastRunAt).toBeNull();
    expect(snap.results).toEqual([]);
    expect(snap.drafts).toEqual([]);
  });

  it("validates rent source and notify channel strictly", () => {
    const { desk } = tempDesk();
    const patched = desk.patchProperty("prop-oak", { rentSource: "bank", notifyChannel: "email" });
    expect(patched.options.rentSource).toBe("bank");
    expect(patched.options.notifyChannel).toBe("email");
    expect(() => desk.patchProperty("prop-oak", { rentSource: "vibes" as never })).toThrow(/unknown rent source/);
    expect(() => desk.patchProperty("prop-oak", { notifyChannel: "carrier-pigeon" as never })).toThrow(/unknown notify channel/);
  });

  it("does not partially change options when a later option is invalid", () => {
    const { desk } = tempDesk();
    const before = structuredClone(desk.snapshot());
    expect(() => desk.patchProperty("prop-oak", { graceDays: 4, courtesyUntilDay: 2 })).toThrow(/after grace/);
    expect(desk.snapshot().properties.find(p => p.id === "prop-oak")?.options).toEqual(before.properties.find(p => p.id === "prop-oak")?.options);
    expect(desk.snapshot().revision).toBe(before.revision);
    expect(() => desk.patchProperty("prop-oak", { graceDays: 2, notifyChannel: "invalid" as never })).toThrow(/unknown notify/);
    expect(desk.snapshot().properties.find(p => p.id === "prop-oak")?.options.graceDays).toBe(3);
  });

  it("adds a property with quiet default facts and the shop options", () => {
    const { desk } = tempDesk();
    const checked = desk.command({ type: "check-demo" });
    const ranAt = checked.lastRunAt;
    expect(ranAt).not.toBeNull();
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
    // adding a row recomputes cards but is not a fresh Recheck
    expect(snap.lastRunAt).toBe(ranAt);
  });

  it("does not invent a check when adding to an unchecked book", () => {
    const { desk } = tempDesk();
    expect(desk.snapshot().lastRunAt).toBeNull();
    const snap = desk.addProperty({
      address: "9 Wattle Ct, O'Connor ACT",
      tenantName: "Morgan Lee",
      tenantPhone: "0411 222 333",
      weeklyRentCents: 61_000,
    });
    expect(snap.lastRunAt).toBeNull();
    expect(snap.results).toEqual([]);
    expect(snap.properties.some((p) => p.address.startsWith("9 Wattle"))).toBe(true);
  });

  it("rejects a property without address, tenant, or rent", () => {
    const { desk } = tempDesk();
    const base = { tenantName: "A", tenantPhone: "0400 000 000", weeklyRentCents: 50_000 };
    expect(() => desk.addProperty({ ...base, address: "" })).toThrow(/address required/);
    expect(() => desk.addProperty({ address: "1 X St", ...base, tenantName: "" })).toThrow(/tenant name required/);
    expect(() => desk.addProperty({ address: "1 X St", ...base, weeklyRentCents: 0 })).toThrow(/weekly rent required/);
  });

  it("rejects a duplicate address or property code, and keeps the code on the book", () => {
    const { desk } = tempDesk();
    const base = { tenantName: "A", tenantPhone: "0400 000 000", weeklyRentCents: 50_000 };
    expect(() => desk.addProperty({ ...base, address: "12 Oak St, Dickson ACT" })).toThrow(/address is already on the book/);
    const snap = desk.addProperty({ ...base, address: "7 Banksia Pl, Bruce ACT", propertyCode: "A-1042" });
    expect(snap.properties.find((p) => p.propertyCode === "A-1042")?.address).toBe("7 Banksia Pl, Bruce ACT");
    expect(() => desk.addProperty({ ...base, address: "8 Banksia Pl, Bruce ACT", propertyCode: "a-1042" })).toThrow(
      /property code is already on the book/,
    );
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

  it("holds an ambiguous address row without applying it or flipping to live", () => {
    const { desk } = tempDesk();
    desk.addProperty({
      address: "12 Oak Street, Dickson ACT",
      tenantName: "Twin",
      tenantPhone: "0400 000 001",
      weeklyRentCents: 50_000,
    });
    const before = desk.snapshot().ledger.find((r) => r.propertyId === "prop-oak")!.daysSinceDue;
    const csv = `address,daysLate,rentLanded,levyPaid\n"12 Oak St, Dickson ACT",9,false,false\n`;
    const snap = desk.importCsv(csv);
    expect(desk.snapshot().ledger.find((r) => r.propertyId === "prop-oak")!.daysSinceDue).toBe(before);
    expect(snap.hands).not.toBe("csv");
    const held = snap.workItems.find((w) => w.holdReason?.startsWith("ambiguous-match"));
    expect(held?.state).toBe("held");
    expect(held?.propertyId).toBe("12 Oak St, Dickson ACT");
    expect(held?.holdReason).toMatch(/2 properties equally \(prop-oak, prop-/);
  });

  it("imports clean rows past an ambiguous one and stays honest about holds", () => {
    const { desk } = tempDesk();
    desk.addProperty({
      address: "12 Oak Street, Dickson ACT",
      tenantName: "Twin",
      tenantPhone: "0400 000 001",
      weeklyRentCents: 50_000,
    });
    const csv = [
      `address,daysLate,rentLanded,levyPaid`,
      `"4/22 Harbour Road, Kingston ACT",5,false,false`,
      `"8 Pine Ave, Braddon ACT",1,true,true`,
      `"12 Oak St, Dickson ACT",9,false,false`,
    ].join("\n");
    const snap = desk.importCsv(csv);
    expect(snap.hands).toBe("csv");
    expect(snap.mode).toBe("live");
    expect(snap.ledger.find((r) => r.propertyId === "prop-harbour")?.daysSinceDue).toBe(5);
    expect(snap.ledger.find((r) => r.propertyId === "prop-pine")?.rentLanded).toBe(true);
    expect(snap.ledger.every((r) => r.propertyId !== "12 Oak St, Dickson ACT")).toBe(true);
    expect(snap.workItems.some((w) => w.holdReason?.startsWith("ambiguous-match"))).toBe(true);
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

  it("stages Bud intake as book proposals; allow adds, deny drops, duplicates skip", () => {
    const { desk } = tempDesk();
    const result = desk.proposeBook({
      items: [
        { address: "7 Intake St, Braddon ACT", tenantName: "Kai Tan", tenantPhone: "0400 555 999", weeklyRentCents: 60_000 },
        { address: "7 Intake St, Braddon ACT", tenantName: "Kai Tan", tenantPhone: "0400 555 999", weeklyRentCents: 60_000 },
        { address: "12 Oak St, Dickson ACT", tenantName: "Someone", tenantPhone: "0400 000 111", weeklyRentCents: 50_000 },
      ],
    }, "ask");
    expect(result.created).toBe(1); // second is a duplicate, third matches an existing property
    expect(result.skipped).toBe(2);

    const before = desk.snapshot().properties.length;
    const proposal = desk.snapshot().book!.bookProposals[0]!;
    const snap = desk.allowBookProposal(proposal.id);
    expect(snap.properties.length).toBe(before + 1);
    expect(snap.properties.some((p) => p.address === "7 Intake St, Braddon ACT")).toBe(true);
    expect(snap.book!.bookProposals).toHaveLength(0);
    expect(desk.notesFor(snap.properties.find((p) => p.address === "7 Intake St, Braddon ACT")!.id).body).toMatch(/added from Bud intake/);

    desk.proposeBook({ items: [{ address: "9 Drop St, Braddon ACT", tenantName: "Skip Me", tenantPhone: "0400 222 333", weeklyRentCents: 55_000 }] });
    const drop = desk.snapshot().book!.bookProposals[0]!;
    const afterDeny = desk.denyBookProposal(drop.id);
    expect(afterDeny.properties.some((p) => p.address === "9 Drop St")).toBe(false);
  });

  it("allows every staged book proposal in one revision bump", () => {
    const { desk } = tempDesk();
    desk.proposeBook({
      items: [
        { address: "1 Batch St, Braddon ACT", tenantName: "Ada Cole", tenantPhone: "0400 111 000", weeklyRentCents: 51_000 },
        { address: "2 Batch St, Braddon ACT", tenantName: "Ben Cole", tenantPhone: "0400 111 001", weeklyRentCents: 52_000 },
      ],
    }, "ask");
    const before = desk.revision;
    const snap = desk.allowAllBookProposals();
    expect(desk.revision).toBe(before + 1);
    expect(snap.book!.bookProposals).toHaveLength(0);
    expect(snap.properties.some((p) => p.address === "1 Batch St, Braddon ACT")).toBe(true);
    expect(snap.properties.some((p) => p.address === "2 Batch St, Braddon ACT")).toBe(true);
  });

  it("parses pasted intake text into staged proposals and reports garbage", () => {
    const { desk } = tempDesk();
    const result = desk.proposeBook({
      text: "12 Oak St, Dickson ACT, Jordan Blake, 0400 555 666, 580\nnot a property",
    });
    expect(result.created).toBe(0); // Oak already exists in the fixture book -> skipped
    expect(result.skipped).toBe(1);
    expect(result.unparsed).toEqual(["not a property"]);
  });

  it("drafts one Copy-only owner letter per property per week from facts and notes", () => {
    const { desk } = tempDesk();
    desk.writeNotes("prop-oak", "Owner prefers short updates. Gutter repair booked for Tuesday.");
    const first = desk.draftOwnerLetters();
    const letters = first.drafts.filter((d) => d.kind === "owner-letter");
    expect(letters.length).toBe(first.properties.length);
    const oak = letters.find((d) => d.propertyId === "prop-oak")!;
    expect(oak).toMatchObject({ status: "pending", channel: "desk" });
    expect(oak.body).toMatch(/Weekly update for 12 Oak St/);
    expect(oak.body).toMatch(/Gutter repair booked for Tuesday/); // Notes colour the draft
    expect(oak.body).toMatch(/Prepared from the RealBud Desk book/);

    // running it again the same week never duplicates
    const again = desk.draftOwnerLetters();
    expect(again.drafts.filter((d) => d.kind === "owner-letter")).toHaveLength(letters.length);

    // allow still works like every other card, and nothing was sent
    desk.allowDraft(oak.id);
    const decided = desk.snapshot().drafts.find((d) => d.id === oak.id)!;
    expect(decided.status).toBe("allowed");
    expect(JSON.stringify(desk.snapshot())).not.toMatch(/"sentAt"/);
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

  // 604 measured Windows admissions (a private intake note per added property); elsewhere the 30 s budget stands.
  it("accepts and evaluates a 600-property office in one intake commit", { timeout: 30_000, ...windowsAdmissionTimeout(700) }, () => {
    const { desk } = tempDesk();
    const items = Array.from({ length: 594 }, (_, i) => ({
      address: `${i + 1} Scale St, Acton ACT`,
      tenantName: `Scale Tester ${i + 1}`,
      tenantPhone: "0400 000 000",
      weeklyRentCents: 50_000,
    }));
    expect(desk.proposeBook({ items }).created).toBe(594);
    const before = desk.revision;
    const allowed = desk.allowAllBookProposals();
    expect(desk.revision).toBe(before + 1);
    expect(allowed.properties).toHaveLength(600);
    expect(allowed.book?.bookProposals).toHaveLength(0);
    const snap = desk.runMorningCheck();
    expect(snap.properties.length).toBe(600);
    const encoded = JSON.stringify(snap);
    expect(encoded).not.toMatch(/"ct":/);
    expect(encoded.length).toBeLessThan(8_000_000);
  });

  it("preflights capacity and leaves every proposal staged on overflow", { timeout: 30_000 }, () => {
    const { desk } = tempDesk();
    const items = Array.from({ length: MAX_BOOK_PROPERTIES - 5 }, (_, i) => ({
      address: `${i + 1} Overflow Rd, Acton ACT`,
      tenantName: `Overflow Tester ${i + 1}`,
      tenantPhone: "0400 000 000",
      weeklyRentCents: 50_000,
    }));
    expect(desk.proposeBook({ items }).created).toBe(MAX_BOOK_PROPERTIES - 5);
    const before = desk.snapshot();
    expect(() => desk.allowAllBookProposals()).toThrow(/No proposals were added/i);
    const after = desk.snapshot();
    expect(after.properties).toHaveLength(before.properties.length);
    expect(after.book?.bookProposals).toHaveLength(MAX_BOOK_PROPERTIES - 5);
    expect(after.revision).toBe(before.revision);
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

  it("surfaces demo book breadth and stamps routine origin without widening handoff", async () => {
    const { desk } = tempDesk();
    const snap = desk.snapshot();
    expect(snap.book?.agency.jurisdictions).toContain("ACT");
    expect(snap.book?.tenancies.some((tenancy) => tenancy.status === "closed")).toBe(true);
    expect(snap.book?.contacts.some((contact) => contact.role === "owner")).toBe(true);
    expect(snap.book?.contacts.some((contact) => contact.role === "tradie")).toBe(true);
    expect(snap.book?.cases.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["maintenance-intake", "lease-review", "inspection-prep", "inbound-triage"]),
    );
    await desk.withRoutineOrigin({ kind: "routine", runId: "run-1", loopId: "morning-arrears" }, () => desk.runMorningCheck());
    expect(desk.snapshot().workItems.some((item) => item.origin?.runId === "run-1")).toBe(true);
    const presented = desk.setPresentation("inspector");
    expect(presented.book?.handoff?.presentation ?? "inspector").toBe("inspector");
    expect(presented.book?.handoff?.allowedActions ?? []).not.toContain("submit");
  });

  it("keeps the whole office unchanged when any field in a patch is invalid", () => {
    const { desk } = tempDesk();
    const before = desk.snapshot();
    expect(() => desk.patchAgency({ name: "Changed agency", jurisdictions: ["QLD"], office: { pmsBrand: "unsupported" } })).toThrow(/pmsBrand/);
    expect(desk.snapshot().book?.agency).toEqual(before.book?.agency);
    expect(desk.snapshot().book?.office).toEqual(before.book?.office);
    expect(desk.snapshot().revision).toBe(before.revision);
  });

  it("saves basics without optional setup metadata and preserves hidden fields on later edits", () => {
    const { desk } = tempDesk();
    desk.patchAgency({ name: "Harbour PM", jurisdictions: ["QLD"] });
    expect(desk.snapshot().book?.office.pmsBrand).toBe("");
    desk.patchAgency({ office: { pmsBrand: "propertyme", namedExporter: "Existing contact" } });
    desk.patchAgency({ name: "Harbour Agency" });
    expect(desk.snapshot().book?.office).toMatchObject({ pmsBrand: "propertyme", namedExporter: "Existing contact" });
    desk.patchAgency({ office: { pmsBrand: "" } });
    expect(desk.snapshot().book?.office).toMatchObject({ pmsBrand: "", namedExporter: "Existing contact" });
  });

  it("persists office visit fields without inventing an agency", () => {
    const { desk } = tempDesk();
    const start = desk.snapshot();
    expect(start.book?.agency.name).toMatch(/demo/i);
    expect(start.book?.office.pmUser).toBe("");
    const named = desk.patchAgency({
      name: "Harbour PM",
      jurisdictions: ["ACT", "nsw", "ZZ"],
      office: {
        pmUser: "Alex",
        pmsBrand: "other",
        namedExporter: "Principal",
        exportCadence: "daily",
        exportIdentity: "address",
        officeOs: "linux",
        vendorTestAccount: "fake-building-portal",
      },
    });
    expect(named.book?.agency.name).toBe("Harbour PM");
    expect(named.book?.agency.jurisdictions).toEqual(["ACT", "NSW"]);
    expect(named.book?.office.pmUser).toBe("Alex");
    expect(named.book?.office.pmsBrand).toBe("other");
    expect(() => desk.patchAgency({ office: { pmsBrand: "aime" } })).toThrow(/pmsBrand/);
    const onlyOffice = desk.patchAgency({ office: { pmUser: "Sam" } });
    expect(onlyOffice.book?.agency.name).toBe("Harbour PM");
    expect(onlyOffice.book?.office.pmUser).toBe("Sam");
  });
});

describe("sample replay", () => {
  it("replaces prior demo cases once, keeps office setup and survives reopening", () => {
    const { desk, dir, now, setNow } = tempDesk();
    desk.patchAgency({ name: "Example office", office: { pmUser: "Example PM" } });
    const first = desk.resetFixtures();
    for (let i = 0; i < 3; i++) {
      setNow(now() + 60_000);
      const replay = desk.resetFixtures();
      expect(replay.book!.cases).toHaveLength(first.book!.cases.length);
      expect(replay.drafts).toHaveLength(first.drafts.length);
      expect(replay.book!.agency.name).toBe("Example office");
      expect(replay.book!.office.pmUser).toBe("Example PM");
      expect(replay.revision).toBe(first.revision + i + 1);
    }
    const reopened = new Desk({ file: join(dir, "desk.json"), now });
    expect(reopened.snapshot().book!.cases).toHaveLength(first.book!.cases.length);
    expect(reopened.snapshot().drafts).toHaveLength(first.drafts.length);
  });
  it("refuses to replace a live book", () => {
    const { desk, dir } = tempDesk();
    desk.importCsv("propertyId,daysSinceDue,rentLanded,levyPaid\nprop-oak,4,false,false");
    const before = readFileSync(join(dir, "desk.json"), "utf8");
    expect(desk.snapshot().mode).toBe("live");
    expect(() => desk.resetFixtures()).toThrow(/office book has been kept/);
    expect(readFileSync(join(dir, "desk.json"), "utf8")).toBe(before);
  });
});
