// Evaluators consume Property + current Tenancy + policy + one MoneyPosition.
// They never receive Notes or scan evidence history.
import type { CheckResult, LedgerFacts, PropertyOptions } from "../shared/contracts.ts";
import { lockedNever, type MoneyPosition } from "../shared/desk-v3.ts";
import { evaluateProperty } from "./desk-evaluate.ts";

export interface EvaluateDto {
  propertyId: string;
  address: string;
  weeklyRentCents: number;
  options: PropertyOptions;
  tenancyId: string;
  money: MoneyPosition;
}

export function evaluateFromProjection(input: EvaluateDto): CheckResult {
  if ("notes" in input || "vault" in input) {
    throw new Error("evaluate must not receive Notes or vault paths");
  }
  if (input.money.status !== "current") {
    const coverage = input.money.facts.coverage;
    return {
      propertyId: input.propertyId,
      outcome: "hold",
      reason:
        input.money.status === "stale"
          ? "stale-source"
          : input.money.status === "conflicted" || coverage === "conflicted"
            ? "conflicted-source"
            : coverage === "missing"
              ? "uncovered-source"
              : input.money.facts.reversed
                ? "reversed"
                : "unknown-facts",
      daysLate: input.money.facts.daysSinceDue ?? 0,
    };
  }
  const facts: LedgerFacts = {
    propertyId: input.propertyId,
    daysSinceDue: input.money.facts.daysSinceDue ?? 0,
    rentLanded: input.money.facts.rentLanded ?? false,
    levyPaid: input.money.facts.levyPaid ?? false,
    daysSinceCourtesy: input.money.facts.daysSinceCourtesy ?? null,
    amountPaidCents: input.money.facts.amountPaidCents,
    reversed: input.money.facts.reversed,
  };
  return evaluateProperty(
    {
      id: input.propertyId,
      address: input.address,
      tenantName: "",
      tenantPhone: "",
      weeklyRentCents: input.weeklyRentCents,
      options: { ...input.options, never: [...lockedNever()] },
    },
    facts,
  );
}

export function evaluateCurrentPositions(
  inputs: EvaluateDto[],
): { results: CheckResult[]; visited: number } {
  return { results: inputs.map(evaluateFromProjection), visited: inputs.length };
}
