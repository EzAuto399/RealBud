import { lockedNever } from "../shared/desk-v3.js";
import { evaluateProperty } from "./desk-evaluate.js";
export function evaluateFromProjection(input) {
    if ("notes" in input || "vault" in input) {
        throw new Error("evaluate must not receive Notes or vault paths");
    }
    if (input.money.status !== "current") {
        return {
            propertyId: input.propertyId,
            outcome: "hold",
            reason: input.money.status === "stale" ? "stale-source" : input.money.facts.reversed ? "reversed" : "unknown-facts",
            daysLate: input.money.facts.daysSinceDue ?? 0,
        };
    }
    const facts = {
        propertyId: input.propertyId,
        daysSinceDue: input.money.facts.daysSinceDue ?? 0,
        rentLanded: input.money.facts.rentLanded ?? false,
        levyPaid: input.money.facts.levyPaid ?? false,
        daysSinceCourtesy: input.money.facts.daysSinceCourtesy ?? null,
        amountPaidCents: input.money.facts.amountPaidCents,
        reversed: input.money.facts.reversed,
    };
    return evaluateProperty({
        id: input.propertyId,
        address: input.address,
        tenantName: "",
        tenantPhone: "",
        weeklyRentCents: input.weeklyRentCents,
        options: { ...input.options, never: [...lockedNever()] },
    }, facts);
}
export function evaluateCurrentPositions(inputs) {
    return { results: inputs.map(evaluateFromProjection), visited: inputs.length };
}
