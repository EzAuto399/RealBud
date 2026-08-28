import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { acquireDataDirLock, DataDirLockedError } from "./data-dir-lock.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "realbud-data-lock-"));
  dirs.push(dir);
  return dir;
}

describe("data-directory ownership", () => {
  it("allows one writer and refuses a second live owner", () => {
    const dir = tempDir();
    const first = acquireDataDirLock(dir, { token: "00000000-0000-4000-8000-000000000001" });
    expect(() => acquireDataDirLock(dir)).toThrow(DataDirLockedError);
    expect(JSON.parse(readFileSync(first.path, "utf8"))).toMatchObject({ pid: process.pid, version: 1 });
    first.release();
    expect(existsSync(first.path)).toBe(false);
  });

  it("recovers a well-formed lock whose process is gone", () => {
    const dir = tempDir();
    const path = join(dir, "realbud.lock");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        token: "00000000-0000-4000-8000-000000000002",
        startedAt: 1,
      }),
    );
    const lock = acquireDataDirLock(dir, { token: "00000000-0000-4000-8000-000000000003" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ pid: process.pid });
    lock.release();
  });

  it("fails closed on malformed ownership rather than guessing", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "realbud.lock"), "not-json");
    expect(() => acquireDataDirLock(dir)).toThrow(DataDirLockedError);
  });

  it("never removes a replacement lock during late release", () => {
    const dir = tempDir();
    const first = acquireDataDirLock(dir, { token: "00000000-0000-4000-8000-000000000004" });
    writeFileSync(
      first.path,
      JSON.stringify({
        version: 1,
        pid: process.pid,
        token: "00000000-0000-4000-8000-000000000005",
        startedAt: Date.now(),
      }),
    );
    first.release();
    expect(existsSync(first.path)).toBe(true);
  });
});
