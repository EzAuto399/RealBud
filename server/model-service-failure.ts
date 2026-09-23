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
  return null;
}
