import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AtomicWriteError } from "./atomic.ts";
import { WorkOutputStore } from "./work-output-store.ts";
import { workDigest } from "./work-broker.ts";

describe("encrypted work output store", () => {
  let dir: string;
  const receipt = { id: "receipt-selected-file-1", requestDigest: workDigest("request-one") };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "realbud-work-output-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const store = (overrides: ConstructorParameters<typeof WorkOutputStore>[0] = {}) => new WorkOutputStore({
    dir,
    key: randomBytes(32),
    now: () => 1_800_000_000_000,
    ...overrides,
  });

  it("round-trips authenticated output without plaintext content or authority in its filename", () => {
    const outputs = store();
    const payload = { summary: "Tenant Sam at 12 Oak Street", amount: 62_000 };
    const saved = outputs.persist({ receipt, fencingToken: 1, payload });
    expect(saved.duplicate).toBe(false);
    expect(outputs.read(receipt)?.payload).toEqual(payload);

    const files = readdirSync(outputs.directory);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain(receipt.id);
    const raw = readFileSync(join(outputs.directory, files[0]!), "utf8");
    expect(raw).not.toContain("Tenant Sam");
    expect(raw).not.toContain("12 Oak Street");
    expect(raw).not.toContain(receipt.requestDigest);
    if (process.platform !== "win32") {
      expect(statSync(join(outputs.directory, files[0]!)).mode & 0o777).toBe(0o600);
    }
  });

  it("deduplicates one fence, rejects conflicts and permits a newer fence", () => {
    const outputs = store();
    const first = outputs.persist({ receipt, fencingToken: 3, payload: { value: "first" } });
    expect(outputs.persist({ receipt, fencingToken: 3, payload: { value: "first" } }).duplicate).toBe(true);
    expect(() => outputs.persist({ receipt, fencingToken: 3, payload: { value: "different" } })).toThrow(/different content/i);
    expect(() => outputs.persist({ receipt, fencingToken: 2, payload: { value: "old" } })).toThrow(/stale/i);

    const newer = outputs.persist({ receipt, fencingToken: 4, payload: { value: "new" } });
    expect(newer.duplicate).toBe(false);
    expect(newer.output.outputDigest).not.toBe(first.output.outputDigest);
    expect(outputs.read(receipt)).toMatchObject({ fencingToken: 4, payload: { value: "new" } });
  });

  it("binds an artifact to the exact receipt request and fails closed on tampering", () => {
    const key = randomBytes(32);
    const outputs = store({ key });
    outputs.persist({ receipt, fencingToken: 1, payload: { value: "verified" } });
    expect(() => outputs.read({ ...receipt, requestDigest: workDigest("different") })).toThrow(/different work/i);

    const path = join(outputs.directory, readdirSync(outputs.directory)[0]!);
    const envelope = JSON.parse(readFileSync(path, "utf8")) as { ct: string };
    envelope.ct = `${envelope.ct[0] === "A" ? "B" : "A"}${envelope.ct.slice(1)}`;
    writeFileSync(path, JSON.stringify(envelope));
    expect(() => outputs.read(receipt)).toThrow(/authenticated/i);

    // A permissive filesystem mode cannot turn ciphertext into authority.
    chmodSync(path, 0o666);
    expect(() => outputs.read(receipt)).toThrow(/authenticated/i);
  });

  it("distinguishes a proven failed write from uncertain durability and blocks further writes", () => {
    const notLanded = store({
      writer: () => { throw new AtomicWriteError("not-landed"); },
    });
    expect(() => notLanded.persist({ receipt, fencingToken: 1, payload: { value: "x" } })).toThrow(/not written/i);
    expect(notLanded.storageStatus()).toBe("ok");

    const uncertain = store({
      writer: () => { throw new AtomicWriteError("landed-uncertain"); },
    });
    expect(() => uncertain.persist({ receipt, fencingToken: 1, payload: { value: "x" } })).toThrow(/uncertain/i);
    expect(uncertain.storageStatus()).toBe("uncertain");
    expect(() => uncertain.persist({ receipt, fencingToken: 2, payload: { value: "y" } })).toThrow(/restart/i);
  });

  it("deletes only the named encrypted output", () => {
    const outputs = store();
    outputs.persist({ receipt, fencingToken: 1, payload: { value: "done" } });
    expect(outputs.delete(receipt.id)).toBe(true);
    expect(outputs.delete(receipt.id)).toBe(false);
    expect(outputs.read(receipt)).toBeNull();
  });
});
