import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { decryptJson, isEncryptedEnvelope } from "./desk-crypto.ts";
import { AtomicWriteError, writeFileAtomic } from "./atomic.ts";
import { DeskStore } from "./desk-store.ts";
import { fixtureBook } from "./desk-evaluate.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), "realbud-desk-store-"));
  dirs.push(dir);
  return { dir, file: join(dir, "desk.json"), key: Buffer.alloc(32, 7) };
}

describe("DeskStore", () => {
  it("migrates a v1 book without claiming old approvals were sent", () => {
    const { file, key } = tempFile();
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        properties: fixtureBook().properties,
        ledger: fixtureBook().ledger.map((row) => ({ ...row, daysSinceCourtesy: 0 })),
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
        escalations: [],
        lastRunAt: 4,
        results: [],
        hands: "fixture",
        handsDetail: "old",
      }),
    );
    const store = new DeskStore({ file, book: fixtureBook(), key });
    expect(store.recovery.active).toBe(false);
    expect(store.data.version).toBe(2);
    expect(store.data.workItems[0]?.state).toBe("approved");
    expect(store.data.ledger.every((row) => row.daysSinceCourtesy === null)).toBe(true);
    store.persist();
    const envelope = JSON.parse(readFileSync(file, "utf8"));
    expect(isEncryptedEnvelope(envelope)).toBe(true);
    expect((decryptJson(key, envelope) as { version: number }).version).toBe(3);
    const again = new DeskStore({ file, book: fixtureBook(), key });
    expect(again.data.workItems[0]?.state).toBe("approved");
    expect(again.v3.version).toBe(3);
  });

  it("quarantines a corrupt ledger and stays read-only", () => {
    const { file, key } = tempFile();
    writeFileSync(file, "not json {{{");
    const store = new DeskStore({ file, book: fixtureBook(), key });
    expect(store.recovery.active).toBe(true);
    expect(store.data.properties).toEqual([]);
    expect(() => store.persist()).toThrow(/recovery/);
  });

  it("enters recovery when the key cannot open the envelope", () => {
    const { file, key } = tempFile();
    const first = new DeskStore({ file, book: fixtureBook(), key });
    first.persist();
    const other = Buffer.alloc(32, 9);
    const lost = new DeskStore({ file, book: fixtureBook(), key: other });
    expect(lost.recovery.active).toBe(true);
    expect(lost.data.properties).toEqual([]);
  });

  it("restores the committed V3 projection when an ordinary write is proven not to have landed", () => {
    const { file, key } = tempFile();
    let fail = false;
    const store = new DeskStore({
      file,
      book: fixtureBook(),
      key,
      authorityWriter(path, data) {
        if (fail) throw new AtomicWriteError("not-landed", new Error("fixture write failure"));
        writeFileAtomic(path, data);
      },
    });
    const before = structuredClone(store.data);
    store.data.handsDetail = "must roll back";
    fail = true;
    try {
      store.persist();
      throw new Error("expected persistence to fail");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("commit-not-landed");
    }
    expect(store.recovery.active).toBe(false);
    expect(store.data).toEqual(before);
    const reopened = new DeskStore({ file, book: fixtureBook(), key });
    expect(reopened.data).toEqual(before);
  });

  it("keeps the exact candidate visible read-only when replacement landed but confirmation failed", () => {
    const { file, key } = tempFile();
    let failAfterWrite = false;
    const store = new DeskStore({
      file,
      book: fixtureBook(),
      key,
      authorityWriter(path, data) {
        writeFileAtomic(path, data);
        if (failAfterWrite) throw new Error("fixture confirmation failure");
      },
    });
    const beforeRevision = store.data.revision;
    store.data.handsDetail = "landed candidate";
    failAfterWrite = true;
    try {
      store.persist();
      throw new Error("expected persistence to fail closed");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("commit-outcome-unknown");
    }
    expect(store.recovery.active).toBe(true);
    expect(store.data.revision).toBe(beforeRevision + 1);
    expect(store.data.handsDetail).toBe("landed candidate");
    expect(() => store.persist()).toThrow(/read-only/);

    const reopened = new DeskStore({ file, book: fixtureBook(), key });
    expect(reopened.recovery.active).toBe(false);
    expect(reopened.data.revision).toBe(beforeRevision + 1);
    expect(reopened.data.handsDetail).toBe("landed candidate");
  });

  it("rolls back an invalid compatibility mutation before any disk write", () => {
    const { file, key } = tempFile();
    const store = new DeskStore({ file, book: fixtureBook(), key });
    const before = structuredClone(store.data);
    store.data.retentionDays = 0;
    expect(() => store.persist()).toThrow(/retentionDays/);
    expect(store.data).toEqual(before);
    expect(store.recovery.active).toBe(false);
  });
});
