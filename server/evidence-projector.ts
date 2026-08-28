// Immutable evidence ingestion and current money projections.
// Evaluation stays O(current tenancies). History and Notes never enter here.
import type { DeskFileV3, Evidence, EvidencePayload, MoneyPosition, MoneyPositionStatus } from "../shared/desk-v3.ts";
import { DeskDecodeError } from "./desk-v3-decode.ts";

function factsKey(payload: EvidencePayload): string {
  return JSON.stringify({
    coverage: payload.coverage ?? "observed",
    daysSinceDue: payload.daysSinceDue ?? null,
    rentLanded: payload.rentLanded ?? null,
    levyPaid: payload.levyPaid ?? null,
    daysSinceCourtesy: payload.daysSinceCourtesy ?? null,
    amountPaidCents: payload.amountPaidCents ?? null,
    reversed: Boolean(payload.reversed),
  });
}

function completeMoneyPayload(payload: EvidencePayload): boolean {
  return (
    typeof payload.daysSinceDue === "number" &&
    typeof payload.rentLanded === "boolean" &&
    typeof payload.levyPaid === "boolean"
  );
}

function latest(rows: readonly Evidence[]): Evidence {
  return rows.reduce((best, row) => {
    const bestObserved = best.observedAt ?? -1;
    const rowObserved = row.observedAt ?? -1;
    if (rowObserved !== bestObserved) return rowObserved > bestObserved ? row : best;
    return row.ingestedAt >= best.ingestedAt ? row : best;
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

  // A newer complete export supersedes older rows from the same or another
  // PMS source. Only rows at the newest observed instant may conflict with
  // each other; an older still-fresh snapshot must not poison the new one.
  const pms = matched.filter(
    (item) => item.authority === "pms" && item.observedAt != null && item.observedAt <= now,
  );
  if (pms.length) {
    const newestObservedAt = Math.max(...pms.map((item) => item.observedAt!));
    const newest = pms.filter((item) => item.observedAt === newestObservedAt);
    const representative = latest(newest);
    if (newest.every((item) => item.staleAt <= now)) {
      return asPosition(tenancyId, representative, "stale");
    }
    if (newest.some((item) => item.staleAt <= now)) {
      return asPosition(tenancyId, representative, "conflicted");
    }
    if (newest.some((item) => item.payload.coverage === "conflicted")) {
      return asPosition(tenancyId, representative, "conflicted");
    }
    if (newest.some((item) => item.payload.coverage === "missing")) {
      return asPosition(tenancyId, representative, "requires-recheck");
    }
    if (newest.some((item) => item.payload.reversed)) {
      return asPosition(tenancyId, representative, "requires-recheck");
    }
    if (new Set(newest.map((item) => factsKey(item.payload))).size > 1) {
      return asPosition(tenancyId, representative, "conflicted");
    }
    if (!newest.every((item) => completeMoneyPayload(item.payload))) {
      return asPosition(tenancyId, representative, "requires-recheck");
    }
    // Read-only browser/worker evidence can never promote a money position to
    // current. It may only fail closed: if a later corroborating observation
    // says a credit landed while the PMS still says unpaid, suppress warning
    // wording until the PM resolves the mismatch in the PMS.
    const laterCorroboration = matched.filter((item) =>
      item.authority === "legacy-unverified"
      && item.observedAt != null
      && item.observedAt >= newestObservedAt
      && item.staleAt > now
      && item.payload.coverage !== "missing"
    );
    if (representative.payload.rentLanded === false
      && laterCorroboration.some((item) => item.payload.rentLanded === true)) {
      return asPosition(tenancyId, representative, "conflicted");
    }
    return asPosition(tenancyId, representative, "current");
  }

  return asPosition(tenancyId, latest(matched), "requires-recheck");
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
