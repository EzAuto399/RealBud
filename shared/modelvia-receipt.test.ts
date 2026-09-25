import { describe, expect, it } from "vitest";
import { modelviaRefusal, parseModelviaReceipt } from "./modelvia-receipt.ts";

/** Shapes from Modelvia `main` 49327ba: key-gateway.ts Receipt projected by
 * charge-presentation.ts (billing-attribution.test.ts, pricing-audience.test.ts). */
const base = {
  requestId: "req_0123456789abcdef", state: "settled", clientId: "realbud", customerId: "realbud-fictional", projectId: "rb-install-one",
  environment: "production", model: "deepseek-v4.1-flash", requestedModel: "auto", rateVersion: "openrouter-2026-09-r2",
  units: { input_tokens: 812, cache_read_tokens: 0, output_tokens: 64 }, pricingContract: 2, priceAudience: "resale_customer",
  currency: "AUD", replayAvailable: false, idempotencySource: "supplied",
};
const clientInternal = { kind: "client_internal", clientId: "realbud", displayName: "RealBud (internal use)" };

describe("Modelvia receipts", () => {
  it("reads a client-funded all-in receipt as withheld: no price, never zero", () => {
    const receipt = parseModelviaReceipt({ ...base, priceBasis: "withheld", chargeDetail: "all_in", description: "AI usage", usedBy: clientInternal });
    expect(receipt).toEqual({ requestId: base.requestId, state: "settled", model: "deepseek-v4.1-flash", priceBasis: "withheld", chargedNanoAud: null, reservedNanoAud: null,
      chargeDetail: "all_in", description: "AI usage", usedBy: { kind: "client_internal", displayName: "RealBud (internal use)" }, idempotencySource: "supplied" });
    // Seen live for client-funded usage: a "0" beside withheld is the internal allocation, not a price.
    expect(parseModelviaReceipt({ ...base, priceBasis: "withheld", chargedNanoAud: "0", usedBy: clientInternal }).chargedNanoAud).toBeNull();
  });

  it("reads resale all-in and itemized receipts and a direct one, ignoring fields it does not know", () => {
    const retail = parseModelviaReceipt({ ...base, priceBasis: "retail", reservedNanoAud: "3270000000", chargedNanoAud: "1843000", chargeDetail: "all_in", description: "AI usage",
      usedBy: { kind: "customer", customerId: "realbud-fictional", displayName: "Fictional Office", projectId: "rb-install-one" }, somethingNew: { nested: true } });
    expect(retail).toMatchObject({ priceBasis: "retail", chargedNanoAud: "1843000", reservedNanoAud: "3270000000", chargeDetail: "all_in", usedBy: { kind: "customer", displayName: "Fictional Office" } });
    const itemized = parseModelviaReceipt({ ...base, priceBasis: "retail", chargedNanoAud: "1843000", chargeDetail: "itemized", usedBy: clientInternal,
      lines: [{ kind: "model_usage", description: "Model usage", amountNanoAud: "1700000" }], routingSource: "jev-typesafe", configuration: "flash-high" });
    expect(itemized).toMatchObject({ chargeDetail: "itemized", description: null });
    // Retail is "0" until settled; a direct reader's receipt has no chargeDetail.
    expect(parseModelviaReceipt({ ...base, state: "pending", priceBasis: "retail", chargedNanoAud: "0" }).chargedNanoAud).toBe("0");
    expect(parseModelviaReceipt({ ...base, priceAudience: "direct_customer", priceBasis: "direct", chargedNanoAud: "12" })).toMatchObject({ chargeDetail: null, usedBy: null });
  });

  it("refuses what is not a receipt rather than guessing an amount", () => {
    for (const bad of [null, [], {}, { ...base, priceBasis: "free" }, { ...base, requestId: "../x" }, { ...base, priceBasis: "retail", chargedNanoAud: "1.5" },
      { ...base, priceBasis: "retail", chargedNanoAud: -1 }, { ...base, priceBasis: "withheld", chargeDetail: "summary" }, { ...base, priceBasis: "withheld", usedBy: { kind: "robot", displayName: "x" } }]) {
      expect(() => parseModelviaReceipt(bad), JSON.stringify(bad)).toThrow(/could not be read/);
    }
  });

  it("names the refusal code in either error shape and carries a replay's original receipt", () => {
    const replay = { error: { message: "request_already_processed", type: "invalid_request_error", code: "request_already_processed", param: null },
      receipt: { ...base, priceBasis: "withheld", chargeDetail: "all_in", description: "AI usage", usedBy: clientInternal } };
    expect(modelviaRefusal(replay)).toMatchObject({ code: "request_already_processed", receipt: { requestId: base.requestId, priceBasis: "withheld" } });
    expect(modelviaRefusal({ error: { message: "customer_terms_required", type: "invalid_request_error", code: "customer_terms_required", param: null } }))
      .toEqual({ code: "customer_terms_required", receipt: null });
    expect(modelviaRefusal({ error: "account_version_conflict" })).toEqual({ code: "account_version_conflict", receipt: null });
    // An unreadable receipt drops the receipt, not the code.
    expect(modelviaRefusal({ error: { code: "request_already_processed" }, receipt: { nope: true } })).toEqual({ code: "request_already_processed", receipt: null });
    for (const bad of [null, "error", { error: 5 }, { error: { code: "Bad Code" } }, { message: "x" }]) expect(modelviaRefusal(bad)).toBeNull();
  });
});
