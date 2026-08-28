import { describe, expect, it } from "vitest";

import { currentBankSourceHealth, currentPmsSourceHealth } from "./source-capability.ts";

describe("source capability health", () => {
  const now = 10_000;

  it("requires fresh complete PMS coverage", () => {
    expect(currentPmsSourceHealth({ sources: [] }, now).health).toBe("missing");
    expect(currentPmsSourceHealth({ sources: [{
      id: "pms",
      kind: "csv",
      label: "PMS",
      stableKey: "pms:one",
      observedAt: 9_000,
      staleAt: 20_000,
      coverage: "incomplete",
    }] }, now).health).toBe("incomplete");
    expect(currentPmsSourceHealth({ sources: [{
      id: "pms",
      kind: "csv",
      label: "PMS",
      stableKey: "pms:one",
      observedAt: 9_000,
      staleAt: 20_000,
      coverage: "complete",
    }] }, now).health).toBe("current");
  });

  it("treats historical and future bank observations as stale", () => {
    expect(currentBankSourceHealth({ sources: [{
      id: "bank",
      kind: "portal",
      label: "Bank",
      stableKey: `bank:${"a".repeat(64)}`,
      observedAt: 1_000,
      staleAt: 9_000,
      coverage: "unknown",
    }] }, now).health).toBe("stale");
    expect(currentBankSourceHealth({ sources: [{
      id: "bank",
      kind: "portal",
      label: "Bank",
      stableKey: `bank:${"a".repeat(64)}`,
      observedAt: 11_000,
      staleAt: 20_000,
      coverage: "unknown",
    }] }, now).health).toBe("stale");
  });
});
