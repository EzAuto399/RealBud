/** Known managed-service error codes take precedence over generic HTTP/retry
 * errors. Return only product copy; never echo credentials or provider output. */
export function modelServiceFailure(message: string): string | null {
  // Access is managed by RealBud: the office has no key to reconnect, so the
  // copy names who acts rather than an in-app step that does not exist.
  if (/\bkey_expired\b/i.test(message)) {
    return "this computer's AI access has expired; RealBud support needs to renew it before Bud can answer";
  }
  if (/\bkey_revoked\b/i.test(message)) {
    return "this computer's AI access was withdrawn; RealBud support needs to renew it before Bud can answer";
  }
  if (/\b(?:(?:client|customer|project)_)?concurrency_limit\b/i.test(message)) {
    return "another model request is still running; wait for it to finish or stop it before trying again";
  }
  if (/\b(?:(?:client|customer|project)_)?monthly_cap_exceeded\b/i.test(message)) {
    return "this office's monthly AI limit is reached, including reserved work; review AI usage and limits on your linked website, or ask RealBud support to raise it";
  }
  if (/\b(?:project_)?request_cap_exceeded\b|\battempt_cap_exceeded\b/i.test(message)) {
    return "this request needs more reserved capacity than its spending limit allows; review AI usage and limits on your linked website before trying again";
  }
  // Setup the office cannot do itself: Modelvia refuses a client-paid customer
  // with no commercial policy in force, and a billing account with no accepted rates.
  if (/\bcustomer_terms_required\b/i.test(message)) {
    return "your office's AI pricing terms are not set up at the model service yet; RealBud support finishes this, then try again";
  }
  if (/\brates_not_accepted\b|\brate_card_not_effective\b/i.test(message)) {
    return "the model service has no accepted AI rates for your office yet; RealBud support finishes this, then try again";
  }
  // A resend of a request Modelvia already finished (same Idempotency-Key, or an
  // identical body moments after delivery). It is never charged twice, and its
  // reply cannot be replayed, so only a new request can answer.
  if (/\brequest_already_processed\b/i.test(message)) {
    return "the model service already handled this exact request but its reply did not arrive; start the task again to send it as a new request";
  }
  if (/\bidempotency_conflict\b/i.test(message)) {
    return "the model service refused a retry that did not match the original request; start the task again";
  }
  // The model or its reasoning setting is not one this office's plan allows.
  // Only the three RealBud choices are ever sent, so this is a service-side
  // plan change, not something the office can fix by typing a model name.
  if (/\bmode_not_allowed\b/i.test(message)) {
    return "the chosen model is not included in this office's AI plan; choose DeepSeek V4.1 Flash · High in Bud setup, or ask RealBud support to check the plan";
  }
  if (/\bunsupported_parameter(?::[a-z_]+)?\b|\bunsupported_tool_choice\b/i.test(message)) {
    return "the AI service refused a setting Bud sent for this model; choose another model in Bud setup, or ask RealBud support to check this computer's AI setup";
  }
  // 422: the provider no longer holds the reasoning state this conversation
  // continued from. A fresh conversation carries none.
  if (/\breasoning_context_expired\b/i.test(message)) {
    return "the AI service no longer holds this conversation's earlier reasoning; start a new conversation to continue";
  }
  if (/\bprovider_request_failed\b/i.test(message)) {
    return "the AI provider behind RealBud's service did not complete this request; try again shortly";
  }
  // No route the office may use can take the request: an old model id (only
  // since the 29 Sep 2026 r4 menu, `auto`, `deepseek-v4.1-flash` and
  // `claude-sonnet-5.5` are served; `kimi-k3` is retired) or an allowlist change.
  if (/\bmodel_route_unavailable\b|\bmodel_scope_denied\b/i.test(message)) {
    return "no model your office may use can take this request right now; try again shortly, or ask RealBud support to check the office's AI models";
  }
  return null;
}
