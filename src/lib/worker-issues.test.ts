import { describe, expect, it } from "vitest";

import { latestWorkerIssue, readWorkerIssues, workerIssueLine } from "./worker-issues";

describe("worker issues", () => {
  it("reads issues from the API payload", () => {
    expect(
      readWorkerIssues({
        issues: [
          {
            id: "a",
            at: 100,
            source: "ask",
            summary: "Bud could not answer",
            detail: "Model busy.",
          },
        ],
      }),
    ).toHaveLength(1);
  });

  it("returns the latest issue only while it is still fresh", () => {
    const now = 1_000_000;
    const issues = readWorkerIssues({
      issues: [{ id: "a", at: now - 60_000, source: "channel", summary: "Telegram reply missed", detail: "Fetch failed." }],
    });
    expect(latestWorkerIssue(issues, 6 * 60 * 60_000, now)?.summary).toBe("Telegram reply missed");
    expect(latestWorkerIssue(issues, 30_000, now)).toBeNull();
  });

  it("formats a readable line", () => {
    expect(
      workerIssueLine(
        { id: "a", at: 1_700_000_000_000, source: "runtime", summary: "Worker error", detail: "Capacity." },
        1_700_000_120_000,
      ),
    ).toMatch(/Worker · .* — Capacity\./);
  });
});
