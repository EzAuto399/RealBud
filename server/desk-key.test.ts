import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadDeskKey } from "./desk-key.ts";

const dirs: string[] = [];
const saved = {
  key: process.env.REALBUD_DESK_KEY,
  prod: process.env.REALBUD_PRODUCTION,
};
beforeEach(() => { delete process.env.REALBUD_DESK_KEY; delete process.env.REALBUD_PRODUCTION; });
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "realbud-key-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (saved.key === undefined) delete process.env.REALBUD_DESK_KEY;
  else process.env.REALBUD_DESK_KEY = saved.key;
  if (saved.prod === undefined) delete process.env.REALBUD_PRODUCTION;
  else process.env.REALBUD_PRODUCTION = saved.prod;
});

describe("loadDeskKey", () => {
  it("uses REALBUD_DESK_KEY and does not write desk.key", () => {
    const dir = fixture();
    process.env.REALBUD_DESK_KEY = "ab".repeat(32);
    process.env.REALBUD_PRODUCTION = "1";
    const loaded = loadDeskKey({ dir });
    expect(loaded.source).toBe("env");
    expect(loaded.production).toBe(true);
    expect(loaded.key.equals(Buffer.from("ab".repeat(32), "hex"))).toBe(true);
    expect(existsSync(join(dir, "desk.key"))).toBe(false);
  });

  it("creates a private development key only for a fresh workspace and reuses it", () => {
    const dir = fixture();
    writeFileSync(join(dir, "settings.json"), "{}");
    const first = loadDeskKey({ dir });
    expect(first.source).toBe("generated");
    expect(first.production).toBe(false);
    expect(first.key).toHaveLength(32);
    expect(readFileSync(join(dir, "desk.key"))).toEqual(first.key);
    expect(loadDeskKey({ dir }).key).toEqual(first.key);
    if (process.platform !== "win32") expect(statSync(join(dir, "desk.key")).mode & 0o777).toBe(0o600);
  });

  it.each([Buffer.alloc(0), Buffer.from("corrupt"), Buffer.alloc(64, 103)])("preserves an invalid existing key and its saved book (%#)", raw => {
    const dir = fixture(), path = join(dir, "desk.key");
    writeFileSync(path, raw, { mode: 0o600 });
    writeFileSync(join(dir, "desk.json"), "saved-encrypted-book");
    expect(() => loadDeskKey({ dir })).toThrow(/needs recovery.*No replacement/);
    expect(readFileSync(path)).toEqual(raw);
    expect(readFileSync(join(dir, "desk.json"), "utf8")).toBe("saved-encrypted-book");
  });

  it.each(["desk.json", "desk.json.quarantine-1", "desk.key.wrap", "workflow-state.sqlite-wal", "private-workspace-restore-1"])("refuses a replacement key when %s survives key loss", name => {
    const dir = fixture();
    writeFileSync(join(dir, name), "saved-state");
    expect(() => loadDeskKey({ dir })).toThrow(/needs recovery/);
    expect(existsSync(join(dir, "desk.key"))).toBe(false);
    expect(readFileSync(join(dir, name), "utf8")).toBe("saved-state");
  });

  it("refuses key creation when private company data survives", () => {
    const dir = fixture(), privateDir = join(dir, "company-installation", "private");
    mkdirSync(privateDir, { recursive: true });
    writeFileSync(join(privateDir, "saved.json"), "saved-private-state");
    expect(() => loadDeskKey({ dir })).toThrow(/needs recovery/);
    expect(existsSync(join(dir, "desk.key"))).toBe(false);
  });

  it.each(["artifacts", "desk-backups"])("preserves nonempty %s after key loss, but permits an empty directory", name => {
    const dir = fixture(), savedDir = join(dir, name);
    mkdirSync(savedDir);
    writeFileSync(join(savedDir, "saved.bin"), "saved-encrypted-state");
    expect(() => loadDeskKey({ dir })).toThrow(/needs recovery/);
    expect(existsSync(join(dir, "desk.key"))).toBe(false);
    expect(readFileSync(join(savedDir, "saved.bin"), "utf8")).toBe("saved-encrypted-state");
    const fresh = fixture(); mkdirSync(join(fresh, name));
    expect(loadDeskKey({ dir: fresh }).source).toBe("generated");
  });

  it("loads a valid legacy hexadecimal key without rewriting it", () => {
    const dir = fixture(), hex = "ac".repeat(32), path = join(dir, "desk.key");
    writeFileSync(path, hex, { mode: 0o600 });
    expect(loadDeskKey({ dir }).key).toEqual(Buffer.from(hex, "hex"));
    expect(readFileSync(path, "utf8")).toBe(hex);
  });

  it("refuses invalid supplied keys without creating a file", () => {
    const dir = fixture();
    expect(() => loadDeskKey({ dir, key: Buffer.alloc(31) })).toThrow(/needs recovery/);
    process.env.REALBUD_DESK_KEY = "invalid";
    expect(() => loadDeskKey({ dir })).toThrow(/needs recovery/);
    expect(existsSync(join(dir, "desk.key"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("refuses a linked or publicly readable key without changing it", () => {
    const dir = fixture(), outside = join(fixture(), "key"), path = join(dir, "desk.key"), raw = Buffer.alloc(32, 7);
    writeFileSync(outside, raw, { mode: 0o600 });
    symlinkSync(outside, path);
    expect(() => loadDeskKey({ dir })).toThrow(/needs recovery/);
    rmSync(path); linkSync(outside, path);
    expect(() => loadDeskKey({ dir })).toThrow(/needs recovery/);
    rmSync(path); writeFileSync(path, raw, { mode: 0o644 });
    expect(() => loadDeskKey({ dir })).toThrow(/needs recovery/);
    expect(readFileSync(outside)).toEqual(raw);
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });
});
