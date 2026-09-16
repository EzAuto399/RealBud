import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { formatUsd, usdToMicro } from "../shared/billing-money.ts";
import {
  applyMarkup,
  billedHermesAttachInput,
  billingSettings,
  creditBalance,
  defaultBilledModel,
  estimateUpstreamMicroUsd,
  hashOfficeKey,
  hermesConnectSteps,
  issueOfficeKey,
  loadBilling,
  lookupOfficeKey,
  publicBillingView,
  recordLlmUsage,
  revokeOfficeKey,
  verifyStripeSignature,
} from "./llm-billing.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.REALBUD_BILLING_MARKUP;
  delete process.env.REALBUD_BILLING_MOCK;
  delete process.env.REALBUD_OPENROUTER_API_KEY;
  delete process.env.STRIPE_SECRET_KEY;
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "realbud-billing-"));
  dirs.push(dir);
  return dir;
}

describe("office model-spend book", () => {
  it("issues a hashed key and never reloads the secret", () => {
    const dir = tmp();
    const issued = issueOfficeKey("Hermes", dir);
    expect(issued.key.startsWith("rbk_live_")).toBe(true);
    expect(issued.hint).not.toContain(issued.key);
    expect(lookupOfficeKey(issued.key, dir)?.id).toBe(issued.id);
    expect(lookupOfficeKey("rbk_live_not-a-real-key-value-xxxxxx", dir)).toBeNull();
    const disk = loadBilling(dir);
    expect(disk.keys[0]?.hash).toBe(hashOfficeKey(issued.key));
    expect(JSON.stringify(disk)).not.toContain(issued.key);
    expect(publicBillingView(dir).keys[0]).toMatchObject({ id: issued.id, label: "Hermes", active: true });
    expect(JSON.stringify(publicBillingView(dir))).not.toContain(issued.key);
  });

  it("revokes a key so the secret stops matching", () => {
    const dir = tmp();
    const issued = issueOfficeKey("Office key", dir);
    expect(revokeOfficeKey(issued.id, dir)).toBe(true);
    expect(lookupOfficeKey(issued.key, dir)).toBeNull();
    expect(publicBillingView(dir).keys[0]?.active).toBe(false);
  });

  it("marks up reported upstream cost and deducts the office balance", () => {
    const dir = tmp();
    process.env.REALBUD_BILLING_MARKUP = "2";
    const issued = issueOfficeKey("Hermes", dir);
    creditBalance({ usd: 10 }, dir);
    const row = recordLlmUsage({
      keyId: issued.id,
      model: "anthropic/claude-sonnet-5",
      promptTokens: 100,
      completionTokens: 20,
      upstreamCostUsd: 0.4,
      usageAvailable: true,
    }, dir);
    expect(row.upstreamMicroUsd).toBe(usdToMicro(0.4));
    expect(row.billedMicroUsd).toBe(usdToMicro(0.8));
    expect(loadBilling(dir).balanceMicroUsd).toBe(usdToMicro(9.2));
    const view = publicBillingView(dir);
    expect(view.usage.calls).toBe(1);
    expect(view.usage.promptTokens).toBe(100);
    expect(view.remainingLabel).toBe(formatUsd(usdToMicro(9.2)));
    expect(view.recent[0]?.kind).toBe("llm");
  });

  it("estimates from tokens when the provider omits cost", () => {
    process.env.REALBUD_BILLING_MARKUP = "1";
    const est = estimateUpstreamMicroUsd({ promptTokens: 1_000_000, completionTokens: 0 });
    expect(est.usageAvailable).toBe(true);
    expect(est.micro).toBe(usdToMicro(3));
    expect(applyMarkup(1_000_000, 1.25)).toBe(1_250_000);
    const missing = estimateUpstreamMicroUsd({ promptTokens: 0, completionTokens: 0 });
    expect(missing.usageAvailable).toBe(false);
    expect(missing.micro).toBe(0);
  });

  it("rejects out-of-range top-ups and builds the Hermes attach recipe", () => {
    const dir = tmp();
    expect(() => creditBalance({ usd: 0.5 }, dir)).toThrow(/US\$1/);
    expect(() => creditBalance({ usd: 900 }, dir)).toThrow(/US\$500/);
    expect(billedHermesAttachInput({ apiKey: "rbk_live_abc", baseUrl: "http://127.0.0.1:8799/v1" })).toEqual({
      providerId: "openrouter",
      apiKey: "rbk_live_abc",
      model: defaultBilledModel(),
      baseUrl: "http://127.0.0.1:8799/v1",
    });
    expect(hermesConnectSteps("http://127.0.0.1:8799/v1")[2]).toContain("http://127.0.0.1:8799/v1");
  });

  it("treats Stripe Checkout as unconfigured without a live secret", () => {
    expect(billingSettings().stripeConfigured).toBe(false);
    expect(billingSettings().mockTopup).toBe(false);
    process.env.REALBUD_BILLING_MOCK = "1";
    process.env.REALBUD_OPENROUTER_API_KEY = "or-test-placeholder-not-a-real-secret";
    expect(billingSettings().mockTopup).toBe(true);
    expect(billingSettings().upstreamConfigured).toBe(true);
    expect(publicBillingView(tmp()).payments.todo).toBeNull();
  });

  it("verifies a Stripe-shaped webhook signature and rejects a stale one", () => {
    const secret = "whsec_testsecret";
    const raw = "{\"id\":\"evt_1\"}";
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
    expect(verifyStripeSignature(raw, `t=${t},v1=${v1}`, secret)).toBe(true);
    expect(verifyStripeSignature(raw, `t=${t},v1=${"ab".repeat(32)}`, secret)).toBe(false);
    expect(verifyStripeSignature(raw, `t=${t - 400},v1=${v1}`, secret)).toBe(false);
  });
});
