import { chmodSync, statSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { decryptJson, isEncryptedEnvelope } from "./desk-crypto.ts";
import { DeskStore, STORAGE_FULL_MESSAGE } from "./desk-store.ts";
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
  it.skipIf(process.platform === 'win32')('creates private ciphertext and tightens an older owned file without changing its bytes', () => {
    const { file, key } = tempFile(); new DeskStore({ file, key, book: fixtureBook() });
    expect(statSync(file).mode & 0o077).toBe(0); const original = readFileSync(file); chmodSync(file, 0o644);
    new DeskStore({ file, key, book: fixtureBook() }); expect(statSync(file).mode & 0o077).toBe(0); expect(readFileSync(file)).toEqual(original);
  });

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

  it("stamps the host timezone on a migrated v1 book instead of a fixed Australian zone", () => {
    const { file, key } = tempFile();
    writeFileSync(file, JSON.stringify({
      version: 1,
      properties: fixtureBook().properties,
      ledger: fixtureBook().ledger.map((row) => ({ ...row, daysSinceCourtesy: 0 })),
      drafts: [],
      escalations: [],
      lastRunAt: null,
      results: [],
      hands: "fixture",
      handsDetail: null,
    }));
    const previousTz = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("America/New_York");
      const store = new DeskStore({ file, book: fixtureBook(), key });
      expect(store.recovery.active).toBe(false);
      expect(store.data.timezone).toBe("America/New_York");
      expect(store.v3.agency.timezone).toBe("America/New_York");
      expect(store.data.timezone).not.toBe("Australia/Sydney");
    } finally {
      if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz;
    }
  });

  it("keeps a licensee escalation's explanation across a restart", () => {
    const { file, key } = tempFile();
    const sentence = "91 King St is 10 days late on this sample book. A licensed person decides whether any state notice is due.";
    const store = new DeskStore({ file, book: fixtureBook(), key });
    store.data.escalations.push({
      id: "esc-king",
      propertyId: "prop-king",
      reason: "statutory-clock",
      detail: sentence,
      periodDueAt: 1,
      createdAt: 2,
    });
    store.persist();
    const again = new DeskStore({ file, book: fixtureBook(), key });
    const reloaded = again.data.escalations.find((row) => row.id === "esc-king");
    expect(reloaded?.detail).toBe(sentence);
    expect(reloaded?.detail).not.toBe("statutory-clock");
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

  it("treats a full disk as a recoverable write failure and never quarantines", () => {
    const { dir, file, key } = tempFile();
    const store = new DeskStore({ file, book: fixtureBook(), key });
    const beforeRevision = store.data.revision;
    const beforeBytes = readFileSync(file);
    const previous = DeskStore.atomicWrite;
    DeskStore.atomicWrite = () => {
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    };
    try {
      expect(() => store.persist()).toThrow(expect.objectContaining({
        status: 507,
        code: "storage-full",
        message: STORAGE_FULL_MESSAGE,
      }));
      expect(store.data.revision).toBe(beforeRevision);
      expect(readFileSync(file)).toEqual(beforeBytes);
      expect(readdirSync(dir).filter((name) => name.includes("quarantine"))).toEqual([]);
      expect(decryptJson(key, JSON.parse(beforeBytes.toString("utf8")))).toMatchObject({ version: 3 });
    } finally {
      DeskStore.atomicWrite = previous;
    }

    store.persist();
    expect(store.data.revision).toBe(beforeRevision + 1);
    expect(readdirSync(dir).filter((name) => name.includes("quarantine"))).toEqual([]);
    const again = new DeskStore({ file, book: fixtureBook(), key });
    expect(again.data.revision).toBe(beforeRevision + 1);
    expect(again.recovery.active).toBe(false);
  });
});


describe("atomic sample replay", () => {
  it("keeps both projections and disk bytes if preparation or final persistence fails", () => {
    const { file, key } = tempFile();
    const store = new DeskStore({ file, book: fixtureBook(), key });
    const beforeData = structuredClone(store.data), beforeV3 = structuredClone(store.v3);
    const beforeBytes = readFileSync(file, "utf8");
    expect(() => store.replaySample(fixtureBook(), 1, () => { store.data.results = []; store.persist(); throw new Error("interrupted preparation"); })).toThrow("interrupted preparation");
    expect(store.data).toEqual(beforeData); expect(store.v3).toEqual(beforeV3);
    expect(readFileSync(file, "utf8")).toBe(beforeBytes);
    const write = DeskStore.atomicWrite;
    DeskStore.atomicWrite = () => { throw Object.assign(new Error("full"), { code: "ENOSPC" }); };
    try {
      expect(() => store.replaySample(fixtureBook(), 2, () => store.persist())).toThrow(STORAGE_FULL_MESSAGE);
      expect(store.data).toEqual(beforeData); expect(store.v3).toEqual(beforeV3);
      expect(readFileSync(file, "utf8")).toBe(beforeBytes);
    } finally { DeskStore.atomicWrite = write; }
    store.replaySample(fixtureBook(), 3, () => store.persist());
    expect(store.data.revision).toBe(beforeData.revision + 1);
  });
});
