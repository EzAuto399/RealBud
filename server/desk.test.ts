import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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

function portfolioCsv(
  patch: Partial<Record<string, Partial<LedgerFacts>>> = {},
): string {
  const rows = fixtureBook().properties.map((property) => {
    const row = {
      propertyId: property.id,
      daysSinceDue: 0,
      rentLanded: true,
      levyPaid: true,
      daysSinceCourtesy: null as number | null,
      ...patch[property.id],
    };
    return [
      row.propertyId,
      row.daysSinceDue,
      row.rentLanded,
      row.levyPaid,
      row.daysSinceCourtesy ?? "",
    ].join(",");
  });
  return ["propertyId,daysSinceDue,rentLanded,levyPaid,daysSinceCourtesy", ...rows].join("\n");
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

  it("reopens the complete licensed-person escalation explanation", () => {
    const { desk, dir, now } = tempDesk();
    desk.runMorningCheck();

    const escalation = new Desk({ file: join(dir, "desk.json"), now }).snapshot().escalations[0];
    expect(escalation?.reason).toBe("statutory-clock");
    expect(escalation?.detail).toMatch(/shop reminder rule, not a legal clock/i);
    expect(escalation?.detail).toMatch(/will not draft or send one/i);
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

    expect(() => desk.editDraft(courtesy.id, "Hi Sam — still waiting on rent. You have 7 days or we issue a breach notice.")).toThrow(/licensed human/i);
    const edited = desk.editDraft(courtesy.id, "Hi Sam — still waiting on rent. Please contact the office if you have already paid.");
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

  it("keeps an archived property out of the compatibility book after restart", () => {
    const { desk, dir, now } = tempDesk();
    desk.runMorningCheck();
    desk.removeProperty("prop-oak");

    const snap = new Desk({ file: join(dir, "desk.json"), now }).snapshot();
    expect(snap.properties.some((p) => p.id === "prop-oak")).toBe(false);
    expect(snap.ledger.some((r) => r.propertyId === "prop-oak")).toBe(false);
    expect(snap.drafts.some((d) => d.propertyId === "prop-oak")).toBe(false);
    expect(snap.escalations.some((e) => e.propertyId === "prop-oak")).toBe(false);
    expect(snap.workItems.some((w) => w.propertyId === "prop-oak")).toBe(false);
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
    expect(snap.results.find((row) => row.propertyId === "prop-harbour")).toMatchObject({
      outcome: "hold",
      reason: "uncovered-source",
    });
  });

  it("persists an import identity link, supports idempotent retry and applies it on the next batch", () => {
    const { desk, dir } = tempDesk();
    const csv = [
      "address,daysLate,rentLanded,levyPaid",
      `"99 Ghost St, Acton ACT",6,false,false`,
    ].join("\n");
    const first = desk.importCsv(csv, undefined, desk.revision);
    const issue = first.book?.importIssues.find((item) => item.status === "open")!;
    expect(issue).toMatchObject({ rawIdentity: "99 Ghost St, Acton ACT", identityKind: "address" });

    const requestId = "import-link-test-0001";
    const linked = desk.resolveImportIssue({
      issueId: issue.id,
      action: "linked",
      propertyId: "prop-harbour",
      expectedRevision: desk.revision,
      requestId,
    });
    expect(linked.book?.importIssues.find((item) => item.id === issue.id)).toMatchObject({
      status: "linked",
      linkedPropertyId: "prop-harbour",
      resolutionCount: 1,
    });
    expect(linked.workItems.some((item) => item.id === issue.id)).toBe(false);

    const replay = desk.resolveImportIssue({
      issueId: issue.id,
      action: "linked",
      propertyId: "prop-harbour",
      expectedRevision: first.revision,
      requestId,
    });
    expect(replay.revision).toBe(linked.revision);
    expect(() => desk.resolveImportIssue({
      issueId: issue.id,
      action: "rejected",
      expectedRevision: desk.revision,
      requestId,
    })).toThrow(/requestId was already used/i);

    const reopened = new Desk({ file: join(dir, "desk.json") });
    const applied = reopened.importCsv(csv, undefined, reopened.revision);
    expect(applied.ledger.find((row) => row.propertyId === "prop-harbour")?.daysSinceDue).toBe(6);
    expect(applied.book?.importIssues.find((item) => item.id === issue.id)).toMatchObject({ status: "linked", resolutionCount: 1 });
  });

  it("lets the clock re-evaluate admitted PMS evidence without a model call and holds it after expiry", () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-desk-scheduled-source-"));
    dirs.push(dir);
    let now = new Date(2026, 7, 17, 8, 0, 0).getTime();
    const hermes = vi.fn(async () => ({ rows: null, detail: "must not run" }));
    const desk = new Desk({ file: join(dir, "desk.json"), now: () => now, hermes });
    desk.importCsv(portfolioCsv({
      "prop-oak": { daysSinceDue: 3, rentLanded: false, levyPaid: false, daysSinceCourtesy: null },
    }));

    const current = desk.runMorningCheckFromCurrentSource();
    expect(hermes).not.toHaveBeenCalled();
    expect(current.hands).toBe("csv");
    expect(current.handsDetail).toMatch(/latest structured PMS export/i);
    expect(current.results.find((row) => row.propertyId === "prop-oak")?.outcome).toBe("draft");

    now += 13 * 60 * 60_000;
    const stale = desk.runMorningCheckFromCurrentSource();
    expect(hermes).not.toHaveBeenCalled();
    expect(stale.results.every((row) => row.outcome === "hold")).toBe(true);
    expect(stale.results.some((row) => row.reason === "stale-source")).toBe(true);
    expect(stale.workItems.filter((item) => item.kind === "source-incident" && item.state === "held")).toHaveLength(1);
    expect(stale.workItems.filter((item) => item.state === "held" && item.holdReason === "unknown-facts")).toHaveLength(0);
  });

  it("supersedes pending wording when a newer complete PMS snapshot changes the facts", () => {
    const { desk, now, setNow } = tempDesk();
    const first = desk.importCsv(portfolioCsv({
      "prop-oak": { daysSinceDue: 3, rentLanded: false, levyPaid: false, daysSinceCourtesy: null },
    }));
    const draft = first.drafts.find((item) => item.propertyId === "prop-oak" && item.status === "pending")!;
    const work = first.workItems.find((item) => item.id === draft.workItemId)!;
    expect(work).toMatchObject({ state: "proposed", evidenceStatus: "current" });
    expect(work.evidenceId).toMatch(/^obs-/);

    setNow(now() + 1_000);
    const paid = desk.importCsv(portfolioCsv());
    expect(paid.drafts.find((item) => item.id === draft.id)?.status).toBe("stale");
    expect(paid.workItems.find((item) => item.id === work.id)?.state).toBe("stale");
    expect(paid.drafts.some((item) => item.propertyId === "prop-oak" && item.status === "pending")).toBe(false);
    expect(() => desk.allowDraft(draft.id)).toThrow(/superseded/i);
  });

  it("revalidates exact evidence at Allow and refuses a source that expired after drafting", () => {
    const { desk, now, setNow } = tempDesk();
    const first = desk.importCsv(portfolioCsv({
      "prop-oak": { daysSinceDue: 3, rentLanded: false, levyPaid: false, daysSinceCourtesy: null },
    }));
    const draft = first.drafts.find((item) => item.propertyId === "prop-oak" && item.status === "pending")!;
    setNow(now() + 13 * 60 * 60_000);
    expect(() => desk.allowDraft(draft.id)).toThrow(/no longer supported by the current PMS evidence/i);
    expect(desk.snapshot().drafts.find((item) => item.id === draft.id)?.status).toBe("pending");
  });

  it("holds duplicate property rows as a conflict and never uses last-row-wins", () => {
    const { desk } = tempDesk();
    const before = desk.snapshot().ledger.find((row) => row.propertyId === "prop-oak")!;
    const csv = [
      "propertyId,daysSinceDue,rentLanded,levyPaid,daysSinceCourtesy",
      "prop-oak,3,false,false,",
      "prop-oak,4,false,false,",
      "prop-pine,0,true,true,",
    ].join("\n");
    const snap = desk.importCsv(csv);
    expect(snap.ledger.find((row) => row.propertyId === "prop-oak")).toEqual(before);
    expect(snap.results.find((row) => row.propertyId === "prop-oak")).toMatchObject({
      outcome: "hold",
      reason: "conflicted-source",
    });
    expect(snap.drafts.some((item) => item.propertyId === "prop-oak" && item.status === "pending")).toBe(false);
  });

  it("never treats worker-produced money rows as PMS authority", async () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-worker-evidence-"));
    dirs.push(dir);
    const workerRows = fixtureBook().ledger.map((row) => ({ ...row }));
    const desk = new Desk({
      file: join(dir, "desk.json"),
      hermes: async () => ({ rows: workerRows, detail: "Worker returned structured rows." }),
    });
    const before = desk.snapshot().ledger;
    const snap = await desk.runMorningCheckLive();
    expect(snap.mode).toBe("demo");
    expect(snap.hands).toBe("held");
    expect(snap.handsDetail).toMatch(/unverified/i);
    expect(snap.drafts).toEqual([]);
    expect(snap.ledger).toEqual(before);
  });

  it("rejects a stale CSV import before changing facts or live state", () => {
    const { desk } = tempDesk();
    const before = desk.snapshot();
    const csv = `address,daysLate,rentLanded,levyPaid\n"12 Oak Street, Dickson ACT",4,false,false\n`;
    expect(() => desk.importCsv(csv, undefined, before.revision - 1)).toThrow(/stale desk revision/);
    expect(desk.snapshot()).toMatchObject({ revision: before.revision, mode: before.mode, hands: before.hands });
    expect(desk.snapshot().ledger).toEqual(before.ledger);
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

  it("reopens the full ambiguous-match explanation", () => {
    const { desk, dir, now } = tempDesk();
    desk.addProperty({
      address: "12 Oak Street, Dickson ACT",
      tenantName: "Twin",
      tenantPhone: "0400 000 001",
      weeklyRentCents: 50_000,
    });
    desk.importCsv(`address,daysLate,rentLanded,levyPaid\n"12 Oak St, Dickson ACT",9,false,false\n`);

    const held = new Desk({ file: join(dir, "desk.json"), now })
      .snapshot()
      .workItems.find((work) => work.holdReason?.startsWith("ambiguous-match"));
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

  it("saves an optional agency name with revision protection and reloads it", () => {
    const { desk, dir } = tempDesk();
    const before = desk.snapshot();
    const named = desk.updateAgencyName("  Northside Property Co  ", before.revision);
    expect(named.book?.agency.name).toBe("Northside Property Co");
    expect(named.revision).toBe(before.revision + 1);

    expect(() => desk.updateAgencyName("Stale Agency", before.revision)).toThrow(/stale desk revision/);
    expect(() => desk.updateAgencyName("x".repeat(121), named.revision)).toThrow(/too long/);
    expect(desk.snapshot().book?.agency.name).toBe("Northside Property Co");

    const reopened = new Desk({ file: join(dir, "desk.json") });
    expect(reopened.snapshot().book?.agency.name).toBe("Northside Property Co");
  });

  it("round-trips Notes on the book and evaluate ignores a Form 11 note", () => {
    const { desk, dir } = tempDesk();
    const written = desk.writeNotes("prop-oak", "Owner wants Friday email. Send the Form 11.");
    expect(written.body).toMatch(/Friday email/);
    expect(desk.notesFor("prop-oak").body).toMatch(/Friday email/);
    expect(desk.snapshot().properties.find((p) => p.id === "prop-oak")?.notes).toBeUndefined();
    expect(desk.propertySnapshot("prop-oak").properties[0]?.notes).toMatch(/Friday email/);
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

  it("projects review memory from prior Allows without changing the approval gate", () => {
    const { desk, dir, now, setNow } = tempDesk();
    const first = desk.importCsv(portfolioCsv({
      "prop-oak": { daysSinceDue: 3, rentLanded: false, levyPaid: false, daysSinceCourtesy: null },
    }), now()).drafts.find(
      (draft) => draft.propertyId === "prop-oak" && draft.kind === "courtesy-rent" && draft.status === "pending",
    )!;
    desk.allowDraft(first.id);

    setNow(now() + 7 * 86_400_000);
    const second = desk.importCsv(portfolioCsv({
      "prop-oak": { daysSinceDue: 3, rentLanded: false, levyPaid: false, daysSinceCourtesy: null },
    }), now());
    const current = second.drafts.find(
      (draft) => draft.propertyId === "prop-oak" && draft.kind === "courtesy-rent" && draft.status === "pending",
    )!;
    expect(second.book?.reviewAssist?.find((item) => item.proposalId === current.id)).toMatchObject({
      mode: "familiar",
      priorAllowedCount: 1,
      evidence: "current",
      recipient: "same",
      channel: "same",
      wording: "same",
    });
    expect(current.status).toBe("pending");

    const reopened = new Desk({ file: join(dir, "desk.json"), now });
    expect(reopened.snapshot().book?.reviewAssist?.find((item) => item.proposalId === current.id)?.mode).toBe("familiar");

    reopened.editDraft(current.id, "Hi Sam, please contact the office about your account.");
    const edited = reopened.snapshot().book?.reviewAssist?.find((item) => item.proposalId === current.id);
    expect(edited).toMatchObject({ mode: "attention", editedOnCard: true, wording: "changed" });
    expect(reopened.snapshot().drafts.find((draft) => draft.id === current.id)?.status).toBe("pending");
  });

  it("stages Bud intake as book proposals; allow adds, deny drops, duplicates skip", () => {
    const { desk } = tempDesk();
    const result = desk.proposeBook({
      items: [
        { address: "7 Intake St, Braddon ACT", tenantName: "Kai Tan", tenantPhone: "0400 555 999", weeklyRentCents: 60_000 },
        { address: "7 Intake St, Braddon ACT", tenantName: "Kai Tan", tenantPhone: "0400 555 999", weeklyRentCents: 60_000 },
        { address: "12 Oak St, Dickson ACT", tenantName: "Someone", tenantPhone: "0400 000 111", weeklyRentCents: 50_000 },
        { address: "!!!", tenantName: "Not an address", tenantPhone: "0400 000 222", weeklyRentCents: 50_000 },
      ],
    }, "ask");
    expect(result.created).toBe(1); // duplicate, existing address, and malformed address are all skipped
    expect(result.skipped).toBe(3);

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

  it("allows the visible intake set with one revision bump and one encrypted commit", () => {
    const { desk, dir, now } = tempDesk();
    const beforeCount = desk.snapshot().properties.length;
    const staged = desk.proposeBook({
      items: Array.from({ length: 12 }, (_, index) => ({
        address: `${index + 1} Batch Street, Braddon ACT`,
        tenantName: `Batch Tenant ${index + 1}`,
        tenantPhone: `0400 100 ${String(index).padStart(3, "0")}`,
        weeklyRentCents: 50_000 + index,
      })),
    });
    expect(staged).toMatchObject({ created: 12, skipped: 0 });
    const before = desk.snapshot();
    const ids = before.book!.bookProposals.map((proposal) => proposal.id);

    const allowed = desk.allowBookProposals(ids, before.revision);
    expect(allowed.revision).toBe(before.revision + 1);
    expect(allowed.properties).toHaveLength(beforeCount + 12);
    expect(allowed.book!.bookProposals).toHaveLength(0);
    expect(readdirSync(join(dir, "desk-backups")).filter((name) => /^desk-\d+\.json$/.test(name))).toHaveLength(1);
    expect(desk.notesFor(allowed.properties.find((property) => property.address.startsWith("1 Batch Street"))!.id).body).toMatch(
      /added from Bud intake/,
    );
    const decisionDay = new Date(now()).toISOString().slice(0, 10);
    const decisionLog = readFileSync(join(dir, "vault", "decisions", `${decisionDay}.md`), "utf8");
    expect(decisionLog.match(/added from Bud intake/g)).toHaveLength(12);

    const reopened = new Desk({ file: join(dir, "desk.json"), now });
    expect(reopened.snapshot().properties).toHaveLength(beforeCount + 12);
    expect(reopened.snapshot().book!.bookProposals).toHaveLength(0);
  });

  it("rejects an invalid, duplicate, missing, or stale batch without a partial add", () => {
    const { desk } = tempDesk();
    const baseline = desk.snapshot();
    const valid = {
      address: "88 Atomic Street, Braddon ACT",
      tenantName: "Atomic One",
      tenantPhone: "0400 888 001",
      weeklyRentCents: 58_000,
    };

    expect(() => desk.addProperties([valid, { ...valid, address: "", tenantName: "Broken" }])).toThrow(/address required/);
    expect(desk.snapshot().properties).toHaveLength(baseline.properties.length);
    expect(desk.revision).toBe(baseline.revision);

    expect(() =>
      desk.addProperties([
        valid,
        { ...valid, address: "88 Atomic St, Braddon ACT", tenantName: "Atomic Two" },
      ]),
    ).toThrow(/already exists/);
    expect(desk.snapshot().properties).toHaveLength(baseline.properties.length);

    desk.proposeBook({ items: [valid, { ...valid, address: "89 Atomic St, Braddon ACT", tenantName: "Atomic Two" }] });
    const proposed = desk.snapshot();
    const ids = proposed.book!.bookProposals.map((proposal) => proposal.id);
    expect(() => desk.allowBookProposals([ids[0]!, ids[0]!], proposed.revision)).toThrow(/unique/);
    expect(() => desk.allowBookProposals([ids[0]!, "book-missing"], proposed.revision)).toThrow(/no such book proposal/);
    expect(desk.snapshot().properties).toHaveLength(baseline.properties.length);
    expect(desk.snapshot().book!.bookProposals).toHaveLength(2);

    desk.runMorningCheck();
    expect(() => desk.allowBookProposals(ids, proposed.revision)).toThrow(/stale desk revision/);
    expect(desk.snapshot().properties).toHaveLength(baseline.properties.length);
    expect(desk.snapshot().book!.bookProposals).toHaveLength(2);
  });

  it("restores proposals, book state, and new note files when the batch commit fails", () => {
    const { desk, dir } = tempDesk();
    desk.proposeBook({
      items: [
        { address: "91 Rollback St, Braddon ACT", tenantName: "Rollback One", tenantPhone: "0400 910 001", weeklyRentCents: 59_000 },
        { address: "92 Rollback St, Braddon ACT", tenantName: "Rollback Two", tenantPhone: "0400 920 002", weeklyRentCents: 60_000 },
      ],
    });
    const before = desk.snapshot();
    const ids = before.book!.bookProposals.map((proposal) => proposal.id);
    const noteDir = join(dir, "vault", "properties");
    const decisionDir = join(dir, "vault", "decisions");
    const notesBefore = readdirSync(noteDir).sort();
    const decisionsBefore = readdirSync(decisionDir).sort();
    const store = (desk as unknown as { store: { persist(): void } }).store;
    const persist = vi.spyOn(store, "persist").mockImplementationOnce(() => {
      throw new Error("simulated encrypted commit failure");
    });

    expect(() => desk.allowBookProposals(ids, before.revision)).toThrow(/simulated encrypted commit failure/);
    persist.mockRestore();
    const after = desk.snapshot();
    expect(after.revision).toBe(before.revision);
    expect(after.properties).toHaveLength(before.properties.length);
    expect(after.book!.bookProposals.map((proposal) => proposal.id)).toEqual(ids);
    expect(readdirSync(noteDir).sort()).toEqual(notesBefore);
    expect(readdirSync(decisionDir).sort()).toEqual(decisionsBefore);
  });

  it("keeps a fully replaced batch when only final durability confirmation fails", () => {
    const { desk, dir, now } = tempDesk();
    desk.proposeBook({
      items: [
        { address: "93 Durable St, Braddon ACT", tenantName: "Durable One", tenantPhone: "0400 930 001", weeklyRentCents: 61_000 },
        { address: "94 Durable St, Braddon ACT", tenantName: "Durable Two", tenantPhone: "0400 940 002", weeklyRentCents: 62_000 },
      ],
    });
    const before = desk.snapshot();
    const ids = before.book!.bookProposals.map((proposal) => proposal.id);
    const store = (desk as unknown as { store: { persist(): void } }).store;
    const originalPersist = store.persist.bind(store);
    const persist = vi.spyOn(store, "persist").mockImplementationOnce(() => {
      originalPersist();
      throw new Error("simulated directory fsync failure after replace");
    });

    expect(() => desk.allowBookProposals(ids, before.revision)).toThrow(/saved the full batch/);
    persist.mockRestore();
    const after = desk.snapshot();
    expect(after.revision).toBe(before.revision + 1);
    expect(after.properties).toHaveLength(before.properties.length + 2);
    expect(after.book!.bookProposals).toHaveLength(0);
    expect(after.recovery.active).toBe(true);
    expect(after.properties.filter((property) => property.address.includes("Durable St")).every((property) =>
      desk.propertySnapshot(property.id).properties[0]?.notes?.includes("added from Bud intake"),
    )).toBe(true);
    expect(() =>
      desk.addProperty({ address: "95 Blocked St", tenantName: "Wait", tenantPhone: "0400 950 003", weeklyRentCents: 63_000 }),
    ).toThrow(/read-only in recovery/);

    const reopened = new Desk({ file: join(dir, "desk.json"), now });
    expect(reopened.snapshot().properties).toHaveLength(before.properties.length + 2);
    expect(reopened.snapshot().book!.bookProposals).toHaveLength(0);
    expect(reopened.recovery.active).toBe(false);
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

  it("allows 194 staged properties in one commit and keeps the 200-property snapshot bounded", () => {
    const { desk } = tempDesk();
    const items = Array.from({ length: 194 }, (_, i) => ({
      address: `${i} Scale St, Acton ACT`,
      tenantName: "Scale Tester",
      tenantPhone: "0400 000 000",
      weeklyRentCents: 50_000,
    }));
    expect(desk.proposeBook({ items })).toMatchObject({ created: 194, skipped: 0 });
    const beforeRevision = desk.revision;
    const ids = desk.snapshot().book!.bookProposals.map((proposal) => proposal.id);
    const added = desk.allowBookProposals(ids, beforeRevision);
    expect(added.revision).toBe(beforeRevision + 1);
    expect(added.properties).toHaveLength(200);
    expect(() =>
      desk.addProperties([
        { address: "201 Scale St, Acton ACT", tenantName: "Over Capacity", tenantPhone: "0400 000 001", weeklyRentCents: 50_000 },
      ]),
    ).toThrow(/book is full/);
    expect(desk.snapshot().properties).toHaveLength(200);
    const snap = desk.runMorningCheck();
    expect(snap.properties.length).toBe(200);
    const queue = desk.queueSnapshot();
    expect(queue.properties).toHaveLength(200);
    expect(queue.book?.contacts).toEqual([]);
    expect(queue.book?.tenancies).toEqual([]);
    expect(queue.properties.every((property) => property.notes === undefined)).toBe(true);
    const encoded = JSON.stringify(queue);
    expect(encoded).not.toMatch(/"ct":/);
    expect(encoded.length).toBeLessThan(750_000);
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
});
