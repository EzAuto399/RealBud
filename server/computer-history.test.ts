// Capped computer history: append, cap, redact, skip junk on disk.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const dataDir = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || process.cwd();
  const dir = `${base}/realbud-history-${process.pid}-${Date.now().toString(36)}`;
  process.env.REALBUD_DATA_DIR = dir;
  return dir;
});

const { appendHistory, listHistory, loadHistory } = await import("./computer-history.ts");
const { join } = await import("node:path");

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  mkdirSync(dataDir, { recursive: true });
  rmSync(join(dataDir, "computer-history.json"), { force: true });
});

describe("computer history", () => {
  it("appends a tool entry and lists latest first", () => {
    appendHistory({ kind: "tool", name: "Read", ok: true, detail: "opened the book", at: 10 });
    appendHistory({ kind: "turn", name: "ask turn", ok: true, detail: "", at: 20, durationMs: 40 });
    const listed = listHistory(50);
    expect(listed).toHaveLength(2);
    expect(listed[0]).toMatchObject({ kind: "turn", name: "ask turn", ok: true, durationMs: 40 });
    expect(listed[1]).toMatchObject({ kind: "tool", name: "Read", ok: true, detail: "opened the book" });
    expect(typeof listed[0]?.id).toBe("string");
  });

  it("caps at 200 and drops the oldest", () => {
    const seeded = Array.from({ length: 199 }, (_, i) => ({
      id: `e${i}`,
      at: i,
      kind: "tool" as const,
      name: "Read",
      ok: true,
      detail: "",
    }));
    writeFileSync(join(dataDir, "computer-history.json"), JSON.stringify({ entries: seeded }));
    appendHistory({ kind: "tool", name: "Read", ok: true, detail: "", at: 199 });
    appendHistory({ kind: "tool", name: "Read", ok: true, detail: "", at: 200 });
    const all = loadHistory();
    expect(all).toHaveLength(200);
    expect(all[0]?.at).toBe(1);
    expect(all[199]?.at).toBe(200);
    expect(listHistory(50)).toHaveLength(50);
    expect(listHistory(50)[0]?.at).toBe(200);
  });

  it("redacts secrets in detail and clips to 160", () => {
    const next = appendHistory({
      kind: "tool",
      name: "Read",
      ok: false,
      detail: `token=sk-ant-${"a".repeat(24)} and then ${"x".repeat(200)}`,
    });
    const detail = next[0]?.detail ?? "";
    expect(detail).not.toMatch(/sk-ant-/);
    expect(detail.length).toBeLessThanOrEqual(160);
    expect(detail).toMatch(/redacted/i);
  });

  it("skips junk on disk and never throws", () => {
    writeFileSync(join(dataDir, "computer-history.json"), "{not json");
    expect(loadHistory()).toEqual([]);

    writeFileSync(
      join(dataDir, "computer-history.json"),
      JSON.stringify([
        { id: 1, kind: "tool" },
        null,
        {
          id: "ok",
          at: 12,
          kind: "tool",
          name: "Read",
          ok: true,
          detail: "opened arrears",
          threadId: "t1",
        },
        { id: "", kind: "turn", name: "ask turn", ok: true, detail: "", at: 1 },
      ]),
    );
    expect(loadHistory()).toEqual([
      { id: "ok", at: 12, kind: "tool", name: "Read", ok: true, detail: "opened arrears", threadId: "t1" },
    ]);
  });
});
