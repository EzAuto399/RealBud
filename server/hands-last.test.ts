import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readHandsLast, writeHandsLast } from "./hands-last.ts";

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
});
