const OBSERVED_STALE_MS = 12 * 60 * 60 * 1000;

/** Facts older than 12 hours read as stale on the case header and evidence rail. */
export function isObservedStale(observedAt: number | null | undefined, now = Date.now()): boolean {
  return observedAt != null && now - observedAt > OBSERVED_STALE_MS;
}
