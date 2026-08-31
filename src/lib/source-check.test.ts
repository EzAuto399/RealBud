import { describe, expect, it } from "vitest";

import { sourceCheckCopy, sourceCheckFailed } from "./source-check";

describe("source check copy", () => {
  it("marks a worker source missed after a failed Recheck", () => {
    const source = { kind: "hermes", lastCheckedAt: 1_700_000_000_000 };
    const lastRecheck = { ok: false, kind: "recheck" as const };
    expect(sourceCheckFailed(source, lastRecheck)).toBe(true);
    expect(sourceCheckCopy(source, lastRecheck, () => "Mon 9:00")).toBe("Missed Mon 9:00");
  });

  it("keeps CSV as checked when Recheck missed", () => {
    const source = { kind: "csv", lastCheckedAt: 1_700_000_000_000 };
    expect(sourceCheckFailed(source, { ok: false, kind: "recheck" })).toBe(false);
    expect(sourceCheckCopy(source, { ok: false, kind: "recheck" }, () => "Mon 9:00")).toBe("Checked Mon 9:00");
  });

  it("does not treat a later hands ping as a successful Recheck", () => {
    const source = { kind: "hermes", lastCheckedAt: 1_700_000_000_000 };
    expect(sourceCheckFailed(source, { ok: true, kind: "ping" })).toBe(false);
  });
});
