import { evaluateProperty } from "./desk-evaluate.js";
export function classifyMoneyRow(property, facts, observedAt, sourceId) {
    if (facts.reversed) {
        return { propertyId: property.id, outcome: "hold", reason: "reversed", daysLate: facts.daysSinceDue, observedAt, sourceId };
    }
    if (facts.amountPaidCents != null && property.weeklyRentCents > 0 && facts.rentLanded && facts.amountPaidCents < property.weeklyRentCents) {
        return { propertyId: property.id, outcome: "hold", reason: "partial", daysLate: facts.daysSinceDue, observedAt, sourceId };
    }
    const base = evaluateProperty(property, facts);
    return { ...base, observedAt, sourceId };
}
export function unmatchedException(propertyId, observedAt, sourceId) {
    return { propertyId, outcome: "hold", reason: "unmatched", daysLate: 0, observedAt, sourceId };
}
export function ambiguousMatchException(propertyId, ids, observedAt, sourceId) {
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
