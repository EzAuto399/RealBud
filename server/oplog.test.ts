import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { askTurnOutcome, oplog, opLogPath, oplogAskTurn, setOpLogPath } from "./oplog.ts";
import type { RunTiming } from "../shared/contracts.ts";

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

describe("Ask turn timing line", () => {
  const timing: RunTiming = { modelCalls: 3, modelMs: 9120, modelMaxMs: 4100, headersMaxMs: 1300, upstreamErrors: 1,
    warm: false, readyMs: 2810, firstTextMs: 5230, toolCalls: 4, tools: ["terminal", "mcp__realbud-workroom__read_file"] };

  it("writes one line of named numbers, booleans and tool names only", () => {
    const path = tempLog();
    // Whatever else rides on the caller's object never reaches the line.
    const carrying = { ...timing, threadId: "fictional-thread", text: "Fictional tenant owes $1,234",
      tools: [...timing.tools!, "terminal: cat /synthetic/ledger.csv", "web search", "x".repeat(65), 7] } as unknown as RunTiming;
    oplogAskTurn({ outcome: "completed", preludeMs: 412, totalMs: 15_890, timing: carrying });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const { at, ...row } = JSON.parse(lines[0]!);
    expect(Date.parse(at)).not.toBeNaN();
    expect(row).toEqual({ event: "turn", detail: "Ask turn finished.", outcome: "completed", warm: false, preludeMs: 412, readyMs: 2810,
      firstTextMs: 5230, toolCalls: 4, tools: ["terminal", "mcp__realbud-workroom__read_file"], modelCalls: 3, modelMs: 9120,
      modelMaxMs: 4100, headersMaxMs: 1300, upstreamErrors: 1, totalMs: 15_890 });
    for (const text of ["fictional-thread", "Fictional tenant", "/synthetic", "web search"]) expect(lines[0]).not.toContain(text);
  });

  it("keeps at most 20 tool names and reads missing or unusable numbers as zero", () => {
    const path = tempLog();
    const tools = Array.from({ length: 25 }, (_, index) => `tool_${index}`);
    oplogAskTurn({ outcome: "failed", preludeMs: Number.NaN, totalMs: -5, timing: { ...timing, readyMs: -1, firstTextMs: null, tools } });
    oplogAskTurn({ outcome: "stopped", preludeMs: 30, totalMs: 30 });
    const [first, second] = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(first).toMatchObject({ outcome: "failed", preludeMs: 0, totalMs: 0, readyMs: 0, firstTextMs: null, tools: tools.slice(0, 20) });
    // A turn that never reached the driver: no worker, model or tool time.
    expect(second).toMatchObject({ outcome: "stopped", warm: false, preludeMs: 30, readyMs: 0, firstTextMs: null, toolCalls: 0, tools: [],
      modelCalls: 0, modelMs: 0, modelMaxMs: 0, headersMaxMs: 0, upstreamErrors: 0, totalMs: 30 });
  });

  it("names how the turn ended", () => {
    expect(askTurnOutcome({ ok: true, stopReason: null })).toBe("completed");
    expect(askTurnOutcome({ ok: false, stopReason: "rpc_error" })).toBe("failed");
    expect(askTurnOutcome({ ok: true, stopReason: "cancelled" })).toBe("stopped");
    expect(askTurnOutcome({ ok: false, stopReason: "interrupted" })).toBe("stopped");
    expect(askTurnOutcome({ ok: true, stopReason: null, stopped: true })).toBe("stopped");
    expect(askTurnOutcome({ ok: true, stopReason: "cancelled", stopped: true, timedOut: true })).toBe("timeout");
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
