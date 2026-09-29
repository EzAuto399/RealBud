/** Known managed-service error codes take precedence over generic HTTP/retry
 * errors. Return only product copy; never echo credentials or provider output. */
export function modelServiceFailure(message: string): string | null {
  if (/\bkey_expired\b/i.test(message)) {
    return "Bud's model access has expired; open You and reconnect the model service";
  }
  if (/\bkey_revoked\b/i.test(message)) {
    return "Bud's model access was withdrawn; open You and reconnect the model service";
  }
  if (/\b(?:(?:client|customer|project)_)?concurrency_limit\b/i.test(message)) {
    return "another model request is still running; wait for it to finish or stop it before trying again";
  }
  if (/\b(?:(?:client|customer|project)_)?monthly_cap_exceeded\b/i.test(message)) {
    return "the AI spending limit has no room for this request, including reserved work; review AI usage and limits on your linked website before trying again";
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
  // No route the office may use can take the request: an old model id (only
  // `auto`, `deepseek-v4.1-flash` and `kimi-k3` are served) or an allowlist change.
  if (/\bmodel_route_unavailable\b|\bmodel_scope_denied\b/i.test(message)) {
    return "no model your office may use can take this request right now; try again shortly, or ask RealBud support to check the office's AI models";
  }
  return null;
}
