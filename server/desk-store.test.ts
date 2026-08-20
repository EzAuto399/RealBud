import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { isEncryptedEnvelope } from "./desk-crypto.ts";
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
    expect(isEncryptedEnvelope(JSON.parse(readFileSync(file, "utf8")))).toBe(true);
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
});
