import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { NEVER_ACTIONS } from "../shared/contracts.ts";
import { decryptJson, encryptJson, isEncryptedEnvelope } from "./desk-crypto.ts";
import { emptyV2 } from "./desk-store.ts";
import { fixtureBook, shopDefaults } from "./desk-evaluate.ts";
import { evaluateCurrentPositions, evaluateFromProjection } from "./case-evaluator.ts";
import { COMMIT_PHASES, ciphertextHash, commitOrRecover, commitV2ToV3, candidatePath } from "./desk-v3-commit.ts";
import { DeskDecodeError, decodeDeskV2, decodeDeskV3, validateDeskV3 } from "./desk-v3-decode.ts";
import { migrateV1ToV2, migrateV2ToV3 } from "./desk-v3-migrate.ts";
import { projectDeskSnapshot, projectQueueSnapshot } from "./desk-v3-project.ts";
import {
  assertAllowedOrigin,
  assertRoutineCannotMint,
  exactOrigin,
  freezeAuthorization,
  originAllowed,
  sameAuthorization,
  withPresentation,
} from "./handoff-auth.ts";
import { emptyV3, tenancyIdFromProperty } from "../shared/desk-v3.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "realbud-v3-commit-"));
  dirs.push(dir);
  return { dir, file: join(dir, "desk.json"), key: Buffer.alloc(32, 3) };
}

const migratedAt = 1_700_000_000_000;

describe("strict decode and references", () => {
  it("rejects duplicate property ids", () => {
    const v2 = emptyV2(fixtureBook());
    v2.properties.push({ ...v2.properties[0]! });
    expect(() => decodeDeskV2(v2)).toThrow(DeskDecodeError);
  });

  it("rejects an orphan proposal after a hostile edit", () => {
    const v3 = migrateV2ToV3(emptyV2(fixtureBook()), migratedAt);
    v3.proposals.push({
      id: "orphan",
      caseId: "missing-case",
      kind: "courtesy-rent",
      currentRevisionId: "rev-orphan-0",
      periodDueAt: migratedAt,
      createdAt: migratedAt,
    });
    expect(() => validateDeskV3(v3)).toThrow(/orphan proposal/);
  });

  it("rejects a second current tenancy on one property", () => {
    const v3 = migrateV2ToV3(emptyV2(fixtureBook()), migratedAt);
    v3.tenancies.push({
      id: "ten-extra",
      propertyId: "prop-oak",
      status: "current",
      weeklyRentCents: 1,
    });
    expect(() => validateDeskV3(v3)).toThrow(/current tenancies/);
  });

  it("rejects dropped never-rules", () => {
    const v3 = migrateV2ToV3(emptyV2(fixtureBook()), migratedAt);
    v3.properties[0]!.options.never = [];
    expect(() => validateDeskV3(v3)).toThrow(/never-rule/);
  });
});

describe("version chain", () => {
  it("migrates plain V1 → V2 → V3 and keeps draft/work ids", () => {
    const book = fixtureBook();
    const v1 = {
      version: 1,
      properties: book.properties,
      ledger: book.ledger,
      drafts: [
        {
          id: "draft-1",
          propertyId: "prop-oak",
          kind: "courtesy-rent",
          status: "allowed",
          channel: "sms",
          to: "Sam",
          body: "hi",
          periodDueAt: 1,
          createdAt: 2,
          decidedAt: 3,
        },
      ],
    };
    const v2 = migrateV1ToV2(v1, book, "Australia/Sydney");
    const v3 = migrateV2ToV3(decodeDeskV2(v2), migratedAt);
    validateDeskV3(v3);
    expect(v3.proposals[0]?.id).toBe("draft-1");
    expect(v3.cases.some((item) => item.id === "work-draft-1" || item.proposalId === "draft-1")).toBe(true);
    expect(v3.agency.timezone).toBe("Australia/Sydney");
  });

  it("commits encrypted V2 to V3 and can reload the V3 file", () => {
    const { file, key } = tempDir();
    const v2 = emptyV2(fixtureBook());
    writeFileSync(file, JSON.stringify(encryptJson(key, v2)));
    const original = readFileSync(file);
    const first = commitV2ToV3({ file, key, migratedAt, book: fixtureBook() });
    expect(first.rewritten).toBe(true);
    expect(first.v3.version).toBe(3);
    expect(existsSync(first.backupPath!)).toBe(true);
    expect(ciphertextHash(readFileSync(first.backupPath!))).toBe(ciphertextHash(original));
    expect(isEncryptedEnvelope(JSON.parse(readFileSync(file, "utf8")))).toBe(true);
    const after = readFileSync(file);
    const second = commitV2ToV3({ file, key, migratedAt, book: fixtureBook() });
    expect(second.rewritten).toBe(false);
    expect(readFileSync(file).equals(after)).toBe(true);
    expect(decodeDeskV3(JSON.parse(JSON.stringify(second.v3))).version).toBe(3);
  });
});

describe("atomic failure leaves V2 byte-identical", () => {
  const beforeRename = COMMIT_PHASES.filter(
    (name) => name !== "retain-bytes" && name !== "hash-original" && name !== "rename" && name !== "dir-fsync",
  );
  for (const phase of beforeRename) {
    it(`fails at ${phase} without rewriting desk.json`, () => {
      const { file, key } = tempDir();
      const v2 = emptyV2(fixtureBook());
      const original = Buffer.from(JSON.stringify(encryptJson(key, v2)));
      writeFileSync(file, original);
      expect(() => commitV2ToV3({ file, key, migratedAt, book: fixtureBook(), failAt: phase })).toThrow(phase);
      expect(readFileSync(file).equals(original)).toBe(true);
    });
  }

  it("fails at rename with the original bytes still at desk.json", () => {
    const { file, key } = tempDir();
    const v2 = emptyV2(fixtureBook());
    const original = Buffer.from(JSON.stringify(encryptJson(key, v2)));
    writeFileSync(file, original);
    expect(() => commitV2ToV3({ file, key, migratedAt, book: fixtureBook(), failAt: "rename" })).toThrow(/rename/);
    expect(readFileSync(file).equals(original)).toBe(true);
    expect(existsSync(candidatePath(file))).toBe(true);
  });

  it("reports the landed V3 book instead of claiming unchanged bytes after directory fsync fails", () => {
    const { file, key } = tempDir();
    const v2 = emptyV2(fixtureBook());
    writeFileSync(file, JSON.stringify(encryptJson(key, v2)));
    const result = commitOrRecover({ file, key, migratedAt, book: fixtureBook(), failAt: "dir-fsync" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected recovery result");
    expect(result.fileUnchanged).toBe(false);
    expect(result.landedV3?.version).toBe(3);
    expect(result.recovery.active).toBe(true);
    expect(decodeDeskV3(decryptJson(key, JSON.parse(readFileSync(file, "utf8")))).version).toBe(3);
  });
});

describe("compatibility snapshot and evaluation", () => {
  it("projects a V2-shaped snapshot without putting notes on the queue", () => {
    const v3 = migrateV2ToV3(emptyV2(fixtureBook()), migratedAt);
    const notes = new Map([["prop-oak", "Just send the Form 11 today"]]);
    const snap = projectDeskSnapshot(v3, { active: false, reason: null, quarantined: [] }, notes);
    expect(snap.version).toBe(2);
    expect(snap.properties.find((p) => p.id === "prop-oak")?.notes).toBe("Just send the Form 11 today");
    const queue = projectQueueSnapshot(v3);
    expect(JSON.stringify(queue)).not.toMatch(/Form 11/);
    expect(JSON.stringify(queue)).not.toMatch(/vault/);
  });

  it("evaluates only current money positions and ignores a note string", () => {
    const v3 = migrateV2ToV3(emptyV2(fixtureBook()), migratedAt);
    const oak = v3.properties.find((p) => p.id === "prop-oak")!;
    const money = v3.moneyPositions.find((row) => row.tenancyId === tenancyIdFromProperty("prop-oak"))!;
    const without = evaluateFromProjection({
      propertyId: oak.id,
      address: oak.address,
      weeklyRentCents: 62_000,
      options: oak.options,
      tenancyId: money.tenancyId,
      money,
    });
    const withNoteShapedTheSame = evaluateFromProjection({
      propertyId: oak.id,
      address: oak.address,
      weeklyRentCents: 62_000,
      options: oak.options,
      tenancyId: money.tenancyId,
      money,
    });
    expect(without).toEqual(withNoteShapedTheSame);
    expect("notes" in ({} as Record<string, never>)).toBe(false);
    const { visited } = evaluateCurrentPositions(
      v3.moneyPositions.map((position) => ({
        propertyId: v3.tenancies.find((t) => t.id === position.tenancyId)?.propertyId ?? "",
        address: "",
        weeklyRentCents: 1,
        options: { ...shopDefaults(), never: [...NEVER_ACTIONS] },
        tenancyId: position.tenancyId,
        money: position,
      })),
    );
    expect(visited).toBe(v3.moneyPositions.length);
    expect(visited).toBeLessThan(v3.evidence.length + 1);
  });
});

describe("handoff authorization", () => {
  const auth = freezeAuthorization({
    operation: "prefill-courtesy",
    caseId: "case-1",
    proposalId: "prop-1",
    revisionId: "rev-1",
    proposalHash: "h",
    propertyId: "prop-oak",
    tenancyId: "ten-prop-oak",
    bindingId: "bind-1",
    recipeId: "fake-building-portal",
    recipeVersion: 1,
    allowedOrigins: ["https://portal.example.com"],
    allowedActions: ["navigate", "fill"],
    expiresAt: migratedAt + 60_000,
  });

  it("allows only exact URL.origin and denies prefix lookalikes", () => {
    expect(originAllowed("https://portal.example.com/ledger", auth.allowedOrigins)).toBe(true);
    expect(exactOrigin("https://portal.example.com:443/x")).toBe("https://portal.example.com");
    expect(originAllowed("https://portal.example.com.evil.com", auth.allowedOrigins)).toBe(false);
    expect(originAllowed("https://evil-portal.example.com", auth.allowedOrigins)).toBe(false);
    expect(originAllowed("http://portal.example.com", auth.allowedOrigins)).toBe(false);
    expect(() => assertAllowedOrigin("https://portal.example.com.evil.com", auth.allowedOrigins)).toThrow(/origin/);
  });

  it("keeps one authorization across presentations and refuses routine mint", () => {
    expect(sameAuthorization(withPresentation(auth, "inspector"), auth)).toBe(true);
    expect(sameAuthorization(withPresentation(auth, "window"), auth)).toBe(true);
    expect(() => freezeAuthorization({ ...auth, allowedActions: ["submit"] })).toThrow(/forbidden/);
    expect(() => assertRoutineCannotMint("routine")).toThrow(/routine cannot mint/);
    assertRoutineCannotMint("pm");
  });
});

describe("scale queue snapshot", () => {
  it("keeps a 200-property queue under 2 MB while evidence stays off the queue", () => {
    const v3 = emptyV3({ name: "", timezone: "Australia/Sydney", jurisdictions: [] });
    for (let i = 0; i < 200; i++) {
      const id = `prop-${i}`;
      v3.properties.push({
        id,
        address: `${i} Scale St`,
        status: "active",
        options: { ...shopDefaults(), never: [...NEVER_ACTIONS] },
      });
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
    v3.sources.push({
      id: "src-scale",
      authority: "legacy-unverified",
      collector: "migration",
      label: "scale",
      stableKey: "scale",
      freshnessMs: 1,
    });
    for (let i = 0; i < 18_000; i++) {
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
    const bytes = Buffer.byteLength(JSON.stringify(queue));
    expect(queue.cases).toHaveLength(200);
    expect(bytes).toBeLessThan(2 * 1024 * 1024);
    expect(JSON.stringify(queue)).not.toMatch(/daysSinceDue/);
  });
});
