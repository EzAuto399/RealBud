import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { writeFileAtomic } from "./atomic.ts";
import { UsageLedger } from "./usage-ledger.ts";

const roots: string[] = [];
const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), "realbud-usage-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("UsageLedger", () => {
  it("deduplicates repeated turn events and reports only provider-supplied totals", () => {
    const now = Date.UTC(2026, 7, 27, 8);
    const file = join(scratch(), "usage.json");
    const ledger = new UsageLedger({ file, now: () => now });

    ledger.record({ threadId: "thread-1", turnId: "turn-1", provider: "hermesAgent", model: "model-a", inputTokens: 120, outputTokens: 30 });
    ledger.record({ threadId: "thread-1", turnId: "turn-1", provider: "hermesAgent", model: "model-a", inputTokens: 80, outputTokens: 20 });
    const summary = ledger.record({ threadId: "thread-1", turnId: "turn-1", completed: true, ok: true });

    expect(summary).toMatchObject({
      completedTurns: 1,
      successfulTurns: 1,
      failedTurns: 0,
      tokenReportedTurns: 1,
      inputTokens: 120,
      outputTokens: 30,
      costReportedTurns: 0,
      costUsd: null,
      lastProvider: "hermesAgent",
      lastModel: "model-a",
      metering: "reported",
      storage: "ok",
    });
    expect(JSON.parse(readFileSync(file, "utf8")).records).toHaveLength(1);
    expect(readFileSync(file, "utf8")).not.toContain("thread-1");
    expect(readFileSync(file, "utf8")).not.toContain("turn-1");
  });

  it("keeps the seven-day window, partial metering, failures and real reported cost honest", () => {
    const now = Date.UTC(2026, 7, 27, 8);
    const file = join(scratch(), "usage.json");
    const ledger = new UsageLedger({ file, now: () => now });
    ledger.record({ threadId: "t", turnId: "old", at: now - 8 * 86_400_000, completed: true, ok: true, inputTokens: 999 });
    ledger.record({ threadId: "t", turnId: "reported", at: now - 1_000, completed: true, ok: true, inputTokens: 10, outputTokens: 4, costUsd: 0.0025 });
    const summary = ledger.record({ threadId: "t", turnId: "unmetered", at: now, provider: "hermesAgent", model: "model-b", completed: true, ok: false });

    expect(summary).toMatchObject({
      completedTurns: 2,
      successfulTurns: 1,
      failedTurns: 1,
      tokenReportedTurns: 1,
      inputTokens: 10,
      outputTokens: 4,
      costReportedTurns: 1,
      costUsd: 0.0025,
      metering: "partial",
      lastModel: "model-b",
    });
  });

  it("preserves a corrupt ledger and starts a bounded replacement", () => {
    const now = Date.UTC(2026, 7, 27, 8);
    const root = scratch();
    const file = join(root, "usage.json");
    writeFileSync(file, "not json");
    const ledger = new UsageLedger({ file, now: () => now });

    expect(ledger.summary()).toMatchObject({ completedTurns: 0, storage: "recovered" });
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(root).some((name) => name.startsWith("usage.json.corrupt-"))).toBe(true);

    ledger.record({ threadId: "t", turnId: "fresh", completed: true, ok: true });
    expect(existsSync(file)).toBe(true);
    expect(ledger.summary()).toMatchObject({ completedTurns: 1, storage: "recovered" });
  });

  it("does not block work or claim unsaved usage after an atomic write failure", () => {
    const now = Date.UTC(2026, 7, 27, 8);
    const file = join(scratch(), "usage.json");
    let fail = true;
    const ledger = new UsageLedger({
      file,
      now: () => now,
      writer: (path, body) => {
        if (fail) throw new Error("disk full");
        writeFileAtomic(path, body);
      },
    });

    expect(() => ledger.record({ threadId: "t", turnId: "first", completed: true, ok: true })).not.toThrow();
    expect(ledger.summary()).toMatchObject({ completedTurns: 0, storage: "attention" });
    fail = false;
    ledger.record({ threadId: "t", turnId: "second", completed: true, ok: true });
    expect(ledger.summary()).toMatchObject({ completedTurns: 1, storage: "ok" });
  });
});
