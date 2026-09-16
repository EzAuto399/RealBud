import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dataDir = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || process.cwd();
  const dir = `${base}/realbud-worker-issues-${process.pid}-${Date.now().toString(36)}`;
  process.env.REALBUD_DATA_DIR = dir;
  return dir;
});

const { listWorkerIssues, noteWorkerIssue, setWorkerIssueListener } = await import("./worker-issues.ts");

beforeEach(() => {
  mkdirSync(dataDir, { recursive: true });
  setWorkerIssueListener(null);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  setWorkerIssueListener(null);
});

describe("worker issues", () => {
  it("records and lists issues newest first", () => {
    noteWorkerIssue({ source: "ask", summary: "Bud could not answer", detail: "Model busy.", at: 1 });
    noteWorkerIssue({ source: "channel", summary: "Telegram reply missed", detail: "Fetch failed.", at: 2 });
    expect(listWorkerIssues()).toEqual([
      {
        id: expect.any(String),
        at: 2,
        source: "channel",
        summary: "Telegram reply missed",
        detail: "Fetch failed.",
      },
      {
        id: expect.any(String),
        at: 1,
        source: "ask",
        summary: "Bud could not answer",
        detail: "Model busy.",
      },
    ]);
  });

  it("dedupes identical issues inside two minutes", () => {
    const heard: string[] = [];
    setWorkerIssueListener((issue) => heard.push(issue.id));
    expect(noteWorkerIssue({ source: "ask", summary: "Miss", detail: "Capacity.", at: 100 })).not.toBeNull();
    expect(noteWorkerIssue({ source: "ask", summary: "Miss", detail: "Capacity.", at: 100 + 60_000 })).toBeNull();
    expect(listWorkerIssues()).toHaveLength(1);
    expect(heard).toHaveLength(1);
  });

  it("redacts secrets from detail", () => {
    noteWorkerIssue({
      source: "runtime",
      summary: "Worker error",
      detail: "token sk-live-abcdefghijklmnopqrstuvwxyz1234567890 failed",
    });
    expect(listWorkerIssues()[0]?.detail).not.toMatch(/sk-live/);
  });
});
