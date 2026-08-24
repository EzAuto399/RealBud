// Immutable evidence ingestion and current money projections.
// Evaluation stays O(current tenancies). History and Notes never enter here.
import type { DeskFileV3, Evidence, EvidencePayload, MoneyPosition, MoneyPositionStatus } from "../shared/desk-v3.ts";
import { DeskDecodeError } from "./desk-v3-decode.ts";

function factsKey(payload: EvidencePayload): string {
  return JSON.stringify({
    daysSinceDue: payload.daysSinceDue ?? null,
    rentLanded: payload.rentLanded ?? null,
    levyPaid: payload.levyPaid ?? null,
    amountPaidCents: payload.amountPaidCents ?? null,
    reversed: Boolean(payload.reversed),
  });
}

function asPosition(tenancyId: string, evidence: Evidence, status: MoneyPositionStatus): MoneyPosition {
  return {
    tenancyId,
    evidenceId: evidence.id,
    sourceId: evidence.sourceId,
    observedAt: evidence.observedAt,
    staleAt: evidence.staleAt,
    facts: evidence.payload,
    status,
  };
}

export function ingestEvidence(book: DeskFileV3, row: Evidence): DeskFileV3 {
  if (book.evidence.some((item) => item.id === row.id)) {
    throw new DeskDecodeError([`evidence ${row.id} is immutable and cannot be overwritten`]);
  }
  return { ...book, evidence: [...book.evidence, row] };
}

export function projectMoneyPosition(rows: readonly Evidence[], tenancyId: string, now: number): MoneyPosition | null {
  const matched = rows.filter((item) => item.tenancyId === tenancyId);
  if (!matched.length) return null;

  const reversed = matched.filter((item) => item.payload.reversed);
  if (reversed.length) {
    return asPosition(tenancyId, reversed[reversed.length - 1]!, "requires-recheck");
  }

  const pmsFresh = matched.filter(
    (item) => item.authority === "pms" && item.observedAt != null && item.observedAt <= now && item.staleAt > now,
  );
  if (pmsFresh.length) {
    const keys = new Set(pmsFresh.map((item) => factsKey(item.payload)));
    if (keys.size > 1) return asPosition(tenancyId, pmsFresh[pmsFresh.length - 1]!, "conflicted");
    return asPosition(tenancyId, pmsFresh[pmsFresh.length - 1]!, "current");
  }

  const pmsStale = matched.filter((item) => item.authority === "pms" && item.observedAt != null && item.staleAt <= now);
  if (pmsStale.length) return asPosition(tenancyId, pmsStale[pmsStale.length - 1]!, "stale");

  return asPosition(tenancyId, matched[matched.length - 1]!, "requires-recheck");
}

export function projectCurrentPositions(book: DeskFileV3, now: number): MoneyPosition[] {
  return book.tenancies
    .filter((tenancy) => tenancy.status === "current")
    .map((tenancy) => projectMoneyPosition(book.evidence, tenancy.id, now))
    .filter((position): position is MoneyPosition => position != null);
}

export function wordingAllowed(position: MoneyPosition): boolean {
  return position.status === "current";
}
