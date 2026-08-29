import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadDeskKey } from "./desk-key.ts";

const dirs: string[] = [];
const saved = {
  key: process.env.REALBUD_DESK_KEY,
  prod: process.env.REALBUD_PRODUCTION,
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (saved.key === undefined) delete process.env.REALBUD_DESK_KEY;
  else process.env.REALBUD_DESK_KEY = saved.key;
  if (saved.prod === undefined) delete process.env.REALBUD_PRODUCTION;
  else process.env.REALBUD_PRODUCTION = saved.prod;
});

describe("loadDeskKey", () => {
  it("uses REALBUD_DESK_KEY and does not write desk.key", () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-key-"));
    dirs.push(dir);
    process.env.REALBUD_DESK_KEY = "ab".repeat(32);
    process.env.REALBUD_PRODUCTION = "1";
    const loaded = loadDeskKey({ dir });
    expect(loaded.source).toBe("env");
    expect(loaded.production).toBe(true);
    expect(loaded.key.equals(Buffer.from("ab".repeat(32), "hex"))).toBe(true);
    expect(existsSync(join(dir, "desk.key"))).toBe(false);
  });
});
