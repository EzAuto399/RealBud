import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { emptyV2 } from "./desk-store.ts";
import { fixtureBook } from "./desk-evaluate.ts";
import { migrateV2ToV3 } from "./desk-v3-migrate.ts";
import { applyRetentionPolicy, pruneDeskBackups } from "./desk-retention.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;

describe("Desk retention", () => {
  it("purges old unreferenced evidence and its stale projection", () => {
    const now = 200 * DAY;
    const book = migrateV2ToV3(emptyV2(fixtureBook()), 1);
    book.retentionDays = 30;
    book.mode = "live";
    book.cases = [];
    book.evidence = [
      {
        id: "old",
        authority: "pms",
        collector: "csv",
        sourceId: book.sources[0]!.id,
        sourceRecordKey: "old",
        observedAt: now - 60 * DAY,
        ingestedAt: now - 60 * DAY,
        staleAt: now - 59 * DAY,
        propertyId: book.properties[0]!.id,
        tenancyId: book.tenancies[0]!.id,
        payload: { rentLanded: false },
      },
    ];
    book.moneyPositions = [
      {
        tenancyId: book.tenancies[0]!.id,
        evidenceId: "old",
        sourceId: book.sources[0]!.id,
        observedAt: now - 60 * DAY,
        staleAt: now - 59 * DAY,
        facts: { rentLanded: false },
        status: "stale",
      },
    ];
    const result = applyRetentionPolicy(book, now);
    expect(result.evidencePurged).toBe(1);
    expect(result.positionsPurged).toBe(1);
  });

  it("retains evidence referenced by a case and every current projection", () => {
    const now = 200 * DAY;
    const book = migrateV2ToV3(emptyV2(fixtureBook()), 1);
    book.retentionDays = 1;
    const old = book.evidence[0]!;
    old.ingestedAt = 1;
    old.observedAt = 1;
    book.cases.push({
      id: "case-retain",
      kind: "money-arrears",
      state: "confirmed",
      propertyId: old.propertyId,
      evidenceIds: [old.id],
      createdAt: 1,
      updatedAt: 1,
    });
    const result = applyRetentionPolicy(book, now);
    expect(result.book.evidence.some((item) => item.id === old.id)).toBe(true);
    for (const position of result.book.moneyPositions.filter((item) => item.status === "current")) {
      expect(result.book.evidence.some((item) => item.id === position.evidenceId)).toBe(true);
    }
  });

  it("removes expired and over-limit encrypted backups", () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-retention-"));
    dirs.push(dir);
    const now = Date.now();
    for (let i = 0; i < 7; i += 1) {
      const file = join(dir, `desk-${i}.json`);
      writeFileSync(file, "encrypted");
      utimesSync(file, new Date(now - i * 1_000), new Date(now - i * 1_000));
    }
    const ancient = join(dir, "pre-v3-ancient.json");
    writeFileSync(ancient, "encrypted");
    utimesSync(ancient, new Date(now - 40 * DAY), new Date(now - 40 * DAY));
    const result = pruneDeskBackups(dir, 30, now, 5);
    expect(result.removed).toHaveLength(3);
    expect(result.removed).toContain(ancient);
  });

  it("rejects a retention value that would erase data immediately", () => {
    const book = migrateV2ToV3(emptyV2(fixtureBook()), 1);
    book.retentionDays = 0;
    expect(() => applyRetentionPolicy(book, Date.now())).toThrow(/retentionDays/);
  });
});
