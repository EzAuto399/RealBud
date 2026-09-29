import { describe, expect, it } from "vitest";
import { modelServiceFailure } from "./model-service-failure.ts";
import { productAskFailure } from "./ask-book.ts";
import { workerMissReason } from "./hermes-hands.ts";

describe("managed model failure messages", () => {
  it.each([
    ["key_expired", /AI access has expired; RealBud support needs to renew it/],
    ["key_revoked", /AI access was withdrawn; RealBud support needs to renew it/],
    ["concurrency_limit", /another model request is still running/i],
    ["client_concurrency_limit", /another model request is still running/i],
    ["customer_concurrency_limit", /another model request is still running/i],
    ["project_concurrency_limit", /another model request is still running/i],
    ["monthly_cap_exceeded", /monthly AI limit is reached/],
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
    [403, "mode_not_allowed", /not included in this office's AI plan/],
    [400, "unsupported_parameter:reasoning_effort", /refused a setting Bud sent/],
    [400, "unsupported_parameter:parallel_tool_calls", /refused a setting Bud sent/],
    [400, "unsupported_tool_choice", /refused a setting Bud sent/],
    [422, "reasoning_context_expired", /start a new conversation/],
    [502, "provider_request_failed", /did not complete this request/],
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

  it("never tells a managed office to reconnect or retype a model it cannot set", () => {
    for (const code of ["key_expired", "key_revoked", "mode_not_allowed", "unsupported_parameter:reasoning_effort", "unsupported_tool_choice",
      "reasoning_context_expired", "provider_request_failed", "customer_terms_required", "project_request_cap_exceeded", "model_route_unavailable", "monthly_cap_exceeded"]) {
      const reason = modelServiceFailure(`Error code: 400 - {'error': {'code': '${code}'}}`)!;
      expect(reason).toBeTruthy();
      expect(reason).not.toMatch(/reconnect|api key|provider key|model id|Hermes|MCP/i);
    }
    expect(productAskFailure("HTTP 401 Unauthorized")).toMatch(/RealBud support needs to check this computer's AI access/);
    expect(productAskFailure("HTTP 429 Too Many Requests")).toMatch(/AI service is busy right now/);
    for (const raw of ["HTTP 401 Unauthorized", "HTTP 429 Too Many Requests"]) expect(productAskFailure(raw)).not.toMatch(/reconnect|change the model/i);
  });

  it("does not invent a known cause for HTTP status alone or partial code names", () => {
    for (const raw of ["HTTP 402", "HTTP 429", "quota", "not_key_expired", "key_expired_extra", "network timeout", "", "HTTP 409", "customer_terms_required_soon", "not_request_already_processed", "not_mode_not_allowed", "reasoning_context_expired_later"]) {
      expect(modelServiceFailure(raw)).toBeNull();
    }
  });
});
