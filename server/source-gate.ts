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

type ReiSources = ReadonlyArray<{ id: string; lastCheckedAt?: number | null }>;
/** Why facts read from these REI parts can't back a proposal now, or null when every part is fresh. */
function reiStaleReason(parts: readonly string[], sources: ReiSources, now: number): string | null {
  const fresh = reiPartsFreshness(parts, sources, now);
  const stale = parts.filter((part) => !fresh[part]);
  if (!stale.length) return null;
  const named = stale.length === 1 ? stale[0] : `${stale.slice(0, -1).join(", ")} and ${stale[stale.length - 1]}`;
  return `REI ${named} not fresh: run the REI morning refresh or sign in to REI.`;
}
/** The REI parts the morning money check's REI facts come from (tenant, rent, amount owing, paid to). */
const REI_MONEY_PARTS = ["tenants", "arrears"] as const;
/** Why REI-sourced money facts can't back a proposal now, or null when both parts are fresh. */
export function reiMoneyStaleReason(sources: ReiSources, now: number): string | null {
  return reiStaleReason(REI_MONEY_PARTS, sources, now);
}
/** An owner letter's owner and arrears facts: the tenants list and arrears carry the owner name,
 * amount owing and paid-to date; the owners list carries the owner's contact. */
const REI_OWNER_LETTER_PARTS = ["tenants", "arrears", "owners"] as const;
/** Why REI-sourced owner or arrears facts can't back an owner letter now, or null when every part is fresh. */
export function reiOwnerLetterStaleReason(sources: ReiSources, now: number): string | null {
  return reiStaleReason(REI_OWNER_LETTER_PARTS, sources, now);
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
