import { describe, expect, it } from "vitest";
import { modelServiceFailure } from "./model-service-failure.ts";
import { productAskFailure } from "./ask-book.ts";
import { workerMissReason } from "./hermes-hands.ts";

describe("managed model failure messages", () => {
  it.each([
    ["key_expired", /access has expired/],
    ["key_revoked", /access was withdrawn/],
    ["concurrency_limit", /another model request is still running/i],
    ["client_concurrency_limit", /another model request is still running/i],
    ["customer_concurrency_limit", /another model request is still running/i],
    ["project_concurrency_limit", /another model request is still running/i],
    ["monthly_cap_exceeded", /including reserved work/],
    ["client_monthly_cap_exceeded", /including reserved work/],
    ["customer_monthly_cap_exceeded", /including reserved work/],
    ["project_monthly_cap_exceeded", /including reserved work/],
    ["request_cap_exceeded", /more reserved capacity/],
    ["project_request_cap_exceeded", /more reserved capacity/],
    ["attempt_cap_exceeded", /more reserved capacity/],
  ])("preserves %s through Ask and readiness retry wrappers", (code, expected) => {
    const status = code.startsWith("key_") ? 401 : code.includes("concurrency") ? 429 : 402;
    const raw = `API call failed after 3 retries: max_retries HTTP ${status} {"error":{"code":"${code}"}} token=fictional-secret`;
    const reason = modelServiceFailure(raw);
    expect(reason).toMatch(expected);
    expect(workerMissReason("", raw)).toBe(reason);
    const ask = productAskFailure(raw);
    expect(ask).toMatch(expected);
    expect(ask).toMatch(/review this task's activity/i);
    expect(ask).not.toMatch(/fictional-secret|max_retries|HTTP|nothing was sent or changed/i);
  });

  it.each([
    [409, "customer_terms_required", /pricing terms are not set up/i],
    [409, "rates_not_accepted", /no accepted AI rates/],
    [409, "request_already_processed", /already handled this exact request/],
    [409, "idempotency_conflict", /did not match the original request/],
    [503, "model_route_unavailable", /no model your office may use/i],
    [403, "model_scope_denied", /no model your office may use/i],
  ])("names Modelvia's live %s %s refusal through Ask and readiness wrappers", (status, code, expected) => {
    // Modelvia's OpenAI-shaped error body (http.ts), as the worker's SDK reports it.
    const raw = `Error code: ${status} - {'error': {'message': '${code}', 'type': 'invalid_request_error', 'code': '${code}', 'param': None}} token=fictional-secret`;
    const reason = modelServiceFailure(raw);
    expect(reason).toMatch(expected);
    expect(workerMissReason("", raw)).toBe(reason);
    const ask = productAskFailure(raw);
    expect(ask).toMatch(expected);
    expect(ask).not.toMatch(/fictional-secret|Error code|invalid_request_error/i);
  });

  it("does not invent a known cause for HTTP status alone or partial code names", () => {
    for (const raw of ["HTTP 402", "HTTP 429", "quota", "not_key_expired", "key_expired_extra", "network timeout", "", "HTTP 409", "customer_terms_required_soon", "not_request_already_processed"]) {
      expect(modelServiceFailure(raw)).toBeNull();
    }
  });
});
