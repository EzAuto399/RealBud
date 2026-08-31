export const LOCAL_SERVICE_UNAVAILABLE =
  "RealBud's local service is not responding yet. New checks and saves are paused; your existing book stays on this Mac.";
export const SERVICE_UNAVAILABLE_EVENT = "realbud:service-unavailable";

export function localServiceError(cause?: unknown): Error {
  const error = new Error(LOCAL_SERVICE_UNAVAILABLE);
  if (cause !== undefined) error.cause = cause;
  return error;
}

export function isRecoveryWriteError(cause: unknown): boolean {
  return cause instanceof Error && /read-only in recovery mode/i.test(cause.message);
}

export function isLocalServiceProxyFailure(status: number, serverError: unknown): boolean {
  return status >= 500 && status <= 504 && (typeof serverError !== "string" || !serverError.trim());
}
