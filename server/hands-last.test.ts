import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readHandsLast, readHandsPing, writeHandsLast, writeHandsPing } from "./hands-last.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("hands-last", () => {
  it("round-trips a Recheck clock Desk and You both read", () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-hands-"));
    dirs.push(dir);
    writeHandsLast(dir, { at: 1_777_000_000_000, ok: false, detail: "The worker is not answering.", kind: "recheck" });
    expect(readHandsLast(dir)).toEqual({
      at: 1_777_000_000_000,
      ok: false,
      detail: "The worker is not answering.",
      kind: "recheck",
    });
  });

  it("keeps a successful ping after Recheck overwrites hands-last", () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-hands-"));
    dirs.push(dir);
    writeHandsPing(dir, { at: 1_777_000_000_000, ok: true, detail: "Worker answered OK.", kind: "ping" });
    writeHandsLast(dir, { at: 1_777_000_000_100, ok: false, detail: "answered without ledger JSON", kind: "recheck" });
    expect(readHandsPing(dir)?.ok).toBe(true);
    expect(readHandsLast(dir)?.ok).toBe(false);
  });

  it("keeps the worker fingerprint on a ping receipt", () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-hands-"));
    dirs.push(dir);
    writeHandsPing(dir, {
      at: 1,
      ok: true,
      detail: "ok",
      kind: "ping",
      workerFingerprint: "abc",
    });
    expect(readHandsPing(dir)?.workerFingerprint).toBe("abc");
  });
});
