import { describe, expect, it } from "vitest";

import { formatUsd, readBillingView } from "./billing";

describe("readBillingView", () => {
  it("accepts a complete office spend payload and rejects a hollow one", () => {
    expect(readBillingView({})).toBeNull();
    const view = readBillingView({
      keys: [{ id: "key_1", label: "Hermes", hint: "rbk_live_ab12…9f3c", createdAt: 1, revokedAt: null, lastUsedAt: null, active: true }],
      usage: { calls: 2, promptTokens: 10, completionTokens: 4, billedUsd: 0.8, billedLabel: "US$0.80", usageMissingCalls: 0 },
      balanceLabel: "US$9.20",
      remainingLabel: "US$9.20",
      markup: 2,
      upstreamConfigured: true,
      payments: { stripeConfigured: false, mockEnabled: true, currency: "USD", todo: null },
      gateway: { baseUrl: "http://127.0.0.1:8799/v1", provider: "openrouter", envVar: "OPENROUTER_API_KEY", defaultModel: "anthropic/claude-sonnet-5" },
      hermes: { steps: ["Create an office key."] },
      recent: [{ id: "use_1", at: 2, kind: "llm", model: "anthropic/claude-sonnet-5", promptTokens: 10, completionTokens: 4, billedUsd: 0.8, billedLabel: "US$0.80", usageAvailable: true }],
    });
    expect(view?.keys[0]?.hint).toBe("rbk_live_ab12…9f3c");
    expect(view?.payments.mockEnabled).toBe(true);
    expect(view?.recent[0]?.kind).toBe("llm");
    expect(formatUsd(800_000)).toBe("US$0.80");
  });
});
