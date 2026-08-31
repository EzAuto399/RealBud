import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { oplog, opLogPath, setOpLogPath } from "./oplog.ts";

const dirs: string[] = [];
function tempLog(): string {
  const dir = mkdtempSync(join(tmpdir(), "realbud-oplog-"));
  dirs.push(dir);
  const path = join(dir, "realbud.log");
  setOpLogPath(path);
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("operational log", () => {
  it("writes one JSON line per event with the detail and extras", () => {
    const path = tempLog();
    expect(opLogPath()).toBe(path);
    oplog("routine", "Desk check completed.", { loopId: "morning-arrears", status: "completed" });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]!);
    expect(row).toMatchObject({ event: "routine", detail: "Desk check completed.", loopId: "morning-arrears" });
    expect(Date.parse(row.at)).not.toBeNaN();
  });

  it("masks a credential that reaches the log", () => {
    const path = tempLog();
    oplog("crash", "worker failed with XAI_API_KEY=sk-live-abcdef1234567890 in env");
    const body = readFileSync(path, "utf8");
    expect(body).not.toContain("sk-live-abcdef1234567890");
    expect(body).toContain("XAI_API_KEY");
  });

  it("rotates at the size ceiling instead of growing without bound", () => {
    const path = tempLog();
    writeFileSync(path, "x".repeat(1_000_001));
    oplog("boot", "after rotate");
    expect(statSync(`${path}.1`).size).toBe(1_000_001);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("never throws when the log cannot be written", () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-oplog-ro-"));
    dirs.push(dir);
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x");
    // Parent is a file, not a directory — append must fail fast on every OS.
    // (/proc/... paths hang on Linux when mkdirSync walks procfs.)
    setOpLogPath(join(blocker, "realbud.log"));
    expect(() => oplog("boot", "still fine")).not.toThrow();
  });
});

describe("test isolation", () => {
  it("writes nowhere under vitest until a test chooses a path", () => {
    // Otherwise every suite run appends to the developer's own book directory.
    setOpLogPath("");
    expect(process.env.VITEST).toBeTruthy();
    expect(opLogPath()).toBeNull();
    expect(() => oplog("routine", "should not land on disk")).not.toThrow();
  });
});
