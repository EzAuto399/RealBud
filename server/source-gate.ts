// Identity, provenance, and freshness. Stale or unknown facts never become
// an actionable proposal.

export const CSV_FRESH_MS = 12 * 60 * 60_000;
export const PORTAL_FRESH_MS = 30 * 60_000;

export function isFresh(observedAt: number, staleAfterMs: number, now: number): boolean {
  return now - observedAt <= staleAfterMs;
}

export function sourceReady(input: {
  sourceId: string;
  stableKey: string;
  observedAt: number | null;
  staleAfterMs: number;
  now: number;
}): { ok: boolean; reason: string } {
  if (!input.sourceId.trim() || !input.stableKey.trim()) {
    return { ok: false, reason: "source identity is missing" };
  }
  if (input.observedAt == null) return { ok: false, reason: "no observation yet" };
  if (!isFresh(input.observedAt, input.staleAfterMs, input.now)) {
    return { ok: false, reason: "source is stale" };
  }
  return { ok: true, reason: "fresh" };
}
