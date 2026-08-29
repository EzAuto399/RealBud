import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkItem, WorkState } from "../shared/contracts.ts";
import { CASE_STATES } from "../shared/desk-v3.ts";
import { encryptJson } from "./desk-crypto.ts";
import { emptyV2 } from "./desk-store.ts";
import { fixtureBook, shopDefaults } from "./desk-evaluate.ts";
import { evaluateFromProjection } from "./case-evaluator.ts";
import { commitOrRecover } from "./desk-v3-commit.ts";
import { DeskDecodeError, decodeDeskV2, decodeDeskV3, validateDeskV3 } from "./desk-v3-decode.ts";
import { migrateV2ToV3 } from "./desk-v3-migrate.ts";
import { projectQueueSnapshot } from "./desk-v3-project.ts";
import { assertOperational, locksForRecovery } from "./desk-v3-recovery.ts";
import { ingestEvidence, projectCurrentPositions, projectMoneyPosition, wordingAllowed } from "./evidence-projector.ts";
import { tenancyIdFromProperty } from "../shared/desk-v3.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const migratedAt = 1_700_000_000_000;

function work(partial: Partial<WorkItem> & Pick<WorkItem, "id" | "state">): WorkItem {
  return {
    kind: "money-arrears",
    propertyId: "prop-oak",
    occurrenceKey: partial.id,
    periodDueAt: migratedAt,
    recipient: { name: "Sam", phone: "0400" },
    sourceIds: ["src-demo"],
    observedAt: migratedAt,
    proposalHash: "h",
    createdAt: migratedAt,
    updatedAt: migratedAt,
    ...partial,
  };
}

describe("strict V3 decoder", () => {
  it("rejects a hostile partial V3 with DeskDecodeError, not TypeError", () => {
    expect(() => decodeDeskV3({ version: 3 })).toThrow(DeskDecodeError);
    expect(() => decodeDeskV3({ version: 3, properties: [] })).toThrow(DeskDecodeError);
    try {
      decodeDeskV3({ version: 3, agency: { name: 1 } });
    } catch (error) {
      expect(error).toBeInstanceOf(DeskDecodeError);
      expect(error).not.toBeInstanceOf(TypeError);
    }
  });

  it("round-trips a migrated book through JSON and the field decoder", () => {
    const v3 = migrateV2ToV3(emptyV2(fixtureBook()), migratedAt);
    const again = decodeDeskV3(JSON.parse(JSON.stringify(v3)));
    expect(again.version).toBe(3);
    expect(again.properties).toHaveLength(v3.properties.length);
    expect(again.office.pmUser).toBe("");
  });

  it("loads a V3 book that was written before office existed", () => {
    const v3 = migrateV2ToV3(emptyV2(fixtureBook()), migratedAt);
    const raw = JSON.parse(JSON.stringify(v3)) as { office?: unknown };
    delete raw.office;
    const again = decodeDeskV3(raw);
    expect(again.office.vendorTestAccount).toBe("");
    expect(again.office.pmsBrand).toBe("");
  });

  it("decodes V2 that omitted optional collections", () => {
    const book = fixtureBook();
    const raw = {
      version: 2,
      revision: 1,
      mode: "demo",
      timezone: "Australia/Sydney",
      retentionDays: 90,
      properties: book.properties,
      ledger: book.ledger,
      drafts: [],
      escalations: [],
      workItems: [],
      lastRunAt: null,
      results: [],
      hands: "demo",
      handsDetail: null,
      sources: [{ id: "src-demo", kind: "demo", label: "Demo", stableKey: "demo" }],
    };
    const v2 = decodeDeskV2(raw);
    expect(v2.observations).toEqual([]);
    expect(v2.capabilities).toEqual([]);
    validateDeskV3(migrateV2ToV3(v2, migratedAt));
  });
});

describe("identity and cases", () => {
  it("preserves every WorkState and keeps held work without a proposal", () => {
    const v2 = emptyV2(fixtureBook());
    for (const state of CASE_STATES as readonly WorkState[]) {
      v2.workItems.push(work({ id: `w-${state}`, state }));
    }
    v2.workItems.push(work({ id: "w-held-no-draft", state: "held" }));
    const v3 = migrateV2ToV3(v2, migratedAt);
    for (const state of CASE_STATES) {
      expect(v3.cases.find((item) => item.id === `w-${state}`)?.state).toBe(state);
    }
    expect(v3.cases.find((item) => item.id === "w-held-no-draft")?.proposalId).toBeUndefined();
  });

  it("turns ambiguous-match holds into ImportIssues and escalations into licensee cases", () => {
    const v2 = emptyV2(fixtureBook());
    v2.workItems.push(work({ id: "w-amb", state: "held", holdReason: "ambiguous-match:row" }));
    v2.escalations.push({
      id: "esc-1",
      propertyId: "prop-oak",
      reason: "statutory-clock",
      detail: "past courtesy",
      periodDueAt: migratedAt,
      createdAt: migratedAt,
    });
    const before = v2.properties.length;
    const v3 = migrateV2ToV3(v2, migratedAt);
    expect(v3.importIssues).toEqual([expect.objectContaining({ id: "w-amb", kind: "ambiguous", status: "open" })]);
    expect(v3.cases.find((item) => item.id === "w-amb")).toBeUndefined();
    expect(v3.cases.find((item) => item.id === "esc-1")).toEqual(
      expect.objectContaining({ kind: "licensee-required", state: "held" }),
    );
    expect(v3.properties).toHaveLength(before);
  });

  it("preserves observation ids and does not invent PMS authority on a live book", () => {
    const v2 = emptyV2(fixtureBook());
    v2.mode = "live";
    v2.sources = [{ id: "src-csv", kind: "csv", label: "CSV", stableKey: "csv:1" }];
    v2.observations.push({
      id: "obs-oak-1",
      sourceId: "src-csv",
      observedAt: migratedAt - 1000,
      propertyId: "prop-oak",
      facts: { propertyId: "prop-oak", daysSinceDue: 3, rentLanded: false, levyPaid: false, daysSinceCourtesy: null },
      staleAfterMs: 3_600_000,
    });
    const v3 = migrateV2ToV3(v2, migratedAt);
    expect(v3.mode).toBe("live");
    expect(v3.evidence.find((row) => row.id === "obs-oak-1")?.authority).toBe("legacy-unverified");
    expect(v3.sources[0]?.authority).toBe("legacy-unverified");
    expect(v3.evidence.every((row) => row.authority !== "pms")).toBe(true);
  });
});

describe("capabilities", () => {
  it("invalidates unused and expired capabilities without extending expiry or resurrecting used ones", () => {
    const v2 = emptyV2(fixtureBook());
    v2.capabilities.push(
      {
        id: "cap-unused",
        workItemId: "work-1",
        revision: 1,
        proposalHash: "h",
        propertyId: "prop-oak",
        recipeId: "fake-building-portal",
        recipeVersion: 1,
        operation: "prefill-courtesy",
        approver: "pm",
        expiresAt: migratedAt + 60_000,
      },
      {
        id: "cap-expired",
        workItemId: "work-2",
        revision: 1,
        proposalHash: "h",
        propertyId: "prop-oak",
        recipeId: "fake-building-portal",
        recipeVersion: 1,
        operation: "prefill-courtesy",
        approver: "pm",
        expiresAt: migratedAt - 1_000,
      },
      {
        id: "cap-used",
        workItemId: "work-3",
        revision: 1,
        proposalHash: "h",
        propertyId: "prop-oak",
        recipeId: "fake-building-portal",
        recipeVersion: 1,
        operation: "prefill-courtesy",
        approver: "pm",
        expiresAt: migratedAt - 500,
        usedAt: migratedAt - 2_000,
        invalidatedAt: migratedAt - 1_500,
      },
    );
    const v3 = migrateV2ToV3(v2, migratedAt);
    const unused = v3.handoffs.find((h) => h.id === "cap-unused")!;
    const expired = v3.handoffs.find((h) => h.id === "cap-expired")!;
    const used = v3.handoffs.find((h) => h.id === "cap-used")!;
    expect(unused.verification).toBe("invalidated");
    expect(unused.invalidatedAt).toBe(migratedAt);
    expect(unused.authorization.expiresAt).toBe(migratedAt + 60_000);
    expect(expired.authorization.expiresAt).toBe(migratedAt - 1_000);
    expect(expired.verification).toBe("invalidated");
    expect(used.usedAt).toBe(migratedAt - 2_000);
    expect(used.invalidatedAt).toBe(migratedAt - 1_500);
    expect(used.verification).toBe("effect-unknown");
    expect(used.authorization.expiresAt).toBe(migratedAt - 500);
  });
});

describe("evidence projector", () => {
  it("keeps evidence append-only and projects current / stale / conflicted / recheck", () => {
    const v3 = migrateV2ToV3(emptyV2(fixtureBook()), migratedAt);
    const tenancyId = tenancyIdFromProperty("prop-oak");
    const base = {
      collector: "csv" as const,
      sourceId: v3.sources[0]!.id,
      tenancyId,
      propertyId: "prop-oak",
      payload: { daysSinceDue: 4, rentLanded: false, levyPaid: false },
    };
    const pms = ingestEvidence(v3, {
      ...base,
      id: "ev-pms-1",
      authority: "pms",
      sourceRecordKey: "pms:1",
      observedAt: migratedAt,
      ingestedAt: migratedAt,
      staleAt: migratedAt + 60_000,
    });
    expect(projectMoneyPosition(pms.evidence, tenancyId, migratedAt + 1)?.status).toBe("current");
    expect(wordingAllowed(projectMoneyPosition(pms.evidence, tenancyId, migratedAt + 1)!)).toBe(true);
    expect(projectMoneyPosition(pms.evidence, tenancyId, migratedAt + 120_000)?.status).toBe("stale");

    const conflicted = ingestEvidence(pms, {
      ...base,
      id: "ev-pms-2",
      authority: "pms",
      sourceRecordKey: "pms:2",
      observedAt: migratedAt,
      ingestedAt: migratedAt,
      staleAt: migratedAt + 60_000,
      payload: { daysSinceDue: 9, rentLanded: false, levyPaid: false },
    });
    expect(projectMoneyPosition(conflicted.evidence, tenancyId, migratedAt + 1)?.status).toBe("conflicted");

    const reversed = ingestEvidence(v3, {
      ...base,
      id: "ev-rev",
      authority: "pms",
      sourceRecordKey: "pms:rev",
      observedAt: migratedAt,
      ingestedAt: migratedAt,
      staleAt: migratedAt + 60_000,
      payload: { daysSinceDue: 4, rentLanded: true, levyPaid: false, reversed: true },
    });
    expect(projectMoneyPosition(reversed.evidence, tenancyId, migratedAt + 1)?.status).toBe("requires-recheck");
    expect(() => ingestEvidence(pms, pms.evidence[0]!)).toThrow(/immutable/);

    const positions = projectCurrentPositions(v3, migratedAt);
    expect(positions.length).toBe(v3.tenancies.filter((t) => t.status === "current").length);
    expect(positions.every((row) => row.status === "requires-recheck")).toBe(true);
  });

  it("will not draft wording from a migrated requires-recheck position or a notes-shaped dto", () => {
    const v3 = migrateV2ToV3(emptyV2(fixtureBook()), migratedAt);
    const oak = v3.properties.find((p) => p.id === "prop-oak")!;
    const money = v3.moneyPositions.find((row) => row.tenancyId === tenancyIdFromProperty("prop-oak"))!;
    const result = evaluateFromProjection({
      propertyId: oak.id,
      address: oak.address,
      weeklyRentCents: 62_000,
      options: oak.options,
      tenancyId: money.tenancyId,
      money,
    });
    expect(result.outcome).toBe("hold");
    expect(result.reason).toBe("unknown-facts");
    expect(wordingAllowed(money)).toBe(false);
    expect(() =>
      evaluateFromProjection({
        propertyId: oak.id,
        address: oak.address,
        weeklyRentCents: 62_000,
        options: oak.options,
        tenancyId: money.tenancyId,
        money,
        notes: "Just send the Form 11",
      } as never),
    ).toThrow(/Notes/);
  });
});

describe("fail-closed recovery", () => {
  it("keeps original V2 bytes and stops writes, schedules and browser work", () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-v3-recover-"));
    dirs.push(dir);
    const file = join(dir, "desk.json");
    const key = Buffer.alloc(32, 7);
    const original = Buffer.from(JSON.stringify(encryptJson(key, emptyV2(fixtureBook()))));
    writeFileSync(file, original);
    const missed = commitOrRecover({ file, key, migratedAt, book: fixtureBook(), failAt: "candidate-validate" });
    expect(missed.ok).toBe(false);
    if (missed.ok) return;
    expect(readFileSync(file).equals(original)).toBe(true);
    expect(missed.fileUnchanged).toBe(true);
    expect(missed.locks).toEqual({ writes: false, schedules: false, browser: false });
    expect(() => assertOperational(missed.recovery, "schedules")).toThrow(/paused/);
    expect(() => assertOperational(missed.recovery, "browser")).toThrow(/paused/);
    expect(() => assertOperational(missed.recovery, "writes")).toThrow(/paused/);
    const ok = commitOrRecover({ file, key, migratedAt, book: fixtureBook() });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.locks).toEqual({ writes: true, schedules: true, browser: true });
    expect(locksForRecovery(ok.recovery).browser).toBe(true);
  });
});

describe("scale 36k evidence", () => {
  it("keeps a 200-property / 36k-evidence queue under 2 MB", () => {
    const v3 = migrateV2ToV3(emptyV2(fixtureBook()), migratedAt);
    v3.properties = [];
    v3.tenancies = [];
    v3.contacts = [];
    v3.cases = [];
    v3.evidence = [];
    v3.moneyPositions = [];
    v3.sources = [{ id: "src-scale", authority: "legacy-unverified", collector: "migration", label: "scale", stableKey: "scale", freshnessMs: 1 }];
    for (let i = 0; i < 200; i++) {
      const id = `prop-${i}`;
      v3.properties.push({ id, address: `${i} Scale St`, status: "active", options: { ...shopDefaults(), never: ["statutory-send", "trust-pay"] } });
      v3.tenancies.push({ id: tenancyIdFromProperty(id), propertyId: id, status: "current", weeklyRentCents: 50_000 });
      v3.cases.push({
        id: `case-${i}`,
        kind: "money-arrears",
        state: "proposed",
        propertyId: id,
        tenancyId: tenancyIdFromProperty(id),
        createdAt: migratedAt,
        updatedAt: migratedAt,
      });
    }
    for (let i = 0; i < 36_000; i++) {
      v3.evidence.push({
        id: `ev-${i}`,
        authority: "legacy-unverified",
        collector: "migration",
        sourceId: "src-scale",
        sourceRecordKey: `row-${i}`,
        observedAt: null,
        ingestedAt: migratedAt,
        staleAt: migratedAt,
        payload: { daysSinceDue: i % 14 },
      });
    }
    const queue = projectQueueSnapshot(v3);
    expect(queue.cases).toHaveLength(200);
    expect(Buffer.byteLength(JSON.stringify(queue))).toBeLessThan(2 * 1024 * 1024);
    expect(JSON.stringify(queue)).not.toMatch(/daysSinceDue/);
    expect(projectCurrentPositions(v3, migratedAt)).toHaveLength(0);
  });
});
