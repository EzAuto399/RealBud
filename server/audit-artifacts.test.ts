import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { persistArtifact, readArtifact, scanOrphans } from "./audit-artifacts.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("audit artifacts", () => {
  it("encrypts bytes, reads them back, and reports orphans", () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-art-"));
    dirs.push(dir);
    const meta = persistArtifact({
      dir,
      workItemId: "work-1",
      step: "prefill",
      body: Buffer.from("secret-prefill"),
      now: 10,
    });
    const got = readArtifact(meta.id, dir);
    expect(got.body.toString("utf8")).toBe("secret-prefill");
    expect(got.meta.bytes).toBe(14);
    expect(scanOrphans(new Set(), dir)).toEqual([meta.id]);
    expect(scanOrphans(new Set([meta.id]), dir)).toEqual([]);
  });
});
