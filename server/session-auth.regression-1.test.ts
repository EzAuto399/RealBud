import { describe, expect, it } from "vitest";

import { originAllowed } from "./session-auth.ts";

// Regression: ISSUE-001 — a configured Vite UI port was rejected by the API origin gate
// Found by /qa on 2026-08-26
// Report: .gstack/qa-reports/qa-report-realbud-local-2026-08-26.md
describe("configured development UI origin", () => {
  it("accepts only the exact configured loopback port", () => {
    expect(originAllowed("http://127.0.0.1:5181", 8901, 5181)).toBe(true);
    expect(originAllowed("http://localhost:5181", 8901, 5181)).toBe(true);
    expect(originAllowed("http://127.0.0.1:5182", 8901, 5181)).toBe(false);
    expect(originAllowed("https://evil.example:5181", 8901, 5181)).toBe(false);
  });

  it("ignores an absent configured UI port", () => {
    expect(originAllowed("http://127.0.0.1:5181", 8901, null)).toBe(false);
  });
});
