// Morning Money Check — one exception queue from CSV/demo + optional portal facts.
import type { CheckResult, LedgerFacts, Property } from "../shared/contracts.ts";
import { evaluateProperty } from "./desk-evaluate.ts";

export interface MoneyException {
  propertyId: string;
  outcome: CheckResult["outcome"];
  reason: CheckResult["reason"];
  daysLate: number;
  observedAt: number;
  sourceId: string;
}

export function classifyMoneyRow(property: Property, facts: LedgerFacts, observedAt: number, sourceId: string): MoneyException {
  if (facts.reversed) {
    return { propertyId: property.id, outcome: "hold", reason: "reversed", daysLate: facts.daysSinceDue, observedAt, sourceId };
  }
  if (facts.amountPaidCents != null && property.weeklyRentCents > 0 && facts.rentLanded && facts.amountPaidCents < property.weeklyRentCents) {
    return { propertyId: property.id, outcome: "hold", reason: "partial", daysLate: facts.daysSinceDue, observedAt, sourceId };
  }
  const base = evaluateProperty(property, facts);
  return { ...base, observedAt, sourceId };
}

export function unmatchedException(propertyId: string, observedAt: number, sourceId: string): MoneyException {
  return { propertyId, outcome: "hold", reason: "unmatched", daysLate: 0, observedAt, sourceId };
}

export function ambiguousMatchException(
  propertyId: string,
  ids: string[],
  observedAt: number,
  sourceId: string,
): MoneyException & { detail: string } {
  return {
    propertyId,
    outcome: "hold",
    reason: "ambiguous-match",
    daysLate: 0,
    observedAt,
    sourceId,
    detail: `csv row matches ${ids.length} properties equally (${ids.join(", ")})`,
  };
}
