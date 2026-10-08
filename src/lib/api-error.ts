export const LOCAL_SERVICE_UNAVAILABLE =
  "RealBud's local service is not responding yet. New checks and saves are paused; your existing book stays saved in your private workspace.";
/** The service still answers its health check but says it is busy (Bud setup, a running task). */
export const LOCAL_SERVICE_BUSY =
  "RealBud is busy and answering slowly. Your work is safe; try again in a moment.";
/** A CustomEvent whose `detail.busy` says whether the health check answered as busy. */
export const SERVICE_UNAVAILABLE_EVENT = "realbud:service-unavailable";

export function localServiceError(cause?: unknown, busy = false): Error {
  const error = new Error(busy ? LOCAL_SERVICE_BUSY : LOCAL_SERVICE_UNAVAILABLE);
  if (cause !== undefined) error.cause = cause;
  return error;
}

export function isRecoveryWriteError(cause: unknown): boolean {
  return cause instanceof Error && /read-only in recovery mode/i.test(cause.message);
}

export function isLocalServiceProxyFailure(status: number, serverError: unknown): boolean {
  return status >= 500 && status <= 504 && (typeof serverError !== "string" || !serverError.trim());
}
