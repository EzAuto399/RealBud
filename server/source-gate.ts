// Identity, provenance, and freshness. Stale or unknown facts never become
// an actionable proposal.

export const CSV_FRESH_MS = 12 * 60 * 60_000;
export const PORTAL_FRESH_MS = 30 * 60_000;
/** REI Cloud is read into Desk once a morning, so a part read completely stays fresh for a day. */
export const REI_FRESH_MS = 24 * 60 * 60_000;

export function isFresh(observedAt: number, staleAfterMs: number, now: number): boolean {
  return now - observedAt <= staleAfterMs;
}

/** Fresh or stale per REI part, from each part's own source stamp. A part never read is stale. */
export function reiPartsFreshness<P extends string>(
  parts: readonly P[],
  sources: ReadonlyArray<{ id: string; lastCheckedAt?: number | null }>,
  now: number,
): Record<P, boolean> {
  const at = (part: P) => sources.find((source) => source.id === `src-rei-${part}`)?.lastCheckedAt;
  return Object.fromEntries(parts.map((part) => {
    const checked = at(part);
    return [part, checked != null && isFresh(checked, REI_FRESH_MS, now)];
  })) as Record<P, boolean>;
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
