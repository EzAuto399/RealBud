import { describe, expect, it } from "vitest";

import { asBoolean, asFiniteInteger, asFiniteNumber, asNonEmptyString, asNullableNumber } from "./decode.ts";

describe("strict decoders", () => {
  it("rejects the string false instead of coercing it truthy", () => {
    expect(() => asBoolean("false", "rentLanded")).toThrow(/boolean/);
    expect(() => asBoolean("true", "rentLanded")).toThrow(/boolean/);
    expect(() => asBoolean(1, "rentLanded")).toThrow(/boolean/);
    expect(asBoolean(false, "rentLanded")).toBe(false);
    expect(asBoolean(true, "rentLanded")).toBe(true);
  });

  it("rejects missing ids and non-integers", () => {
    expect(() => asNonEmptyString("", "propertyId")).toThrow(/non-empty/);
    expect(() => asNonEmptyString("  ", "propertyId")).toThrow(/non-empty/);
    expect(() => asFiniteInteger(3.5, "daysSinceDue")).toThrow(/integer/);
    expect(() => asFiniteInteger(Number("x"), "daysSinceDue")).toThrow(/integer/);
    expect(asFiniteInteger(3, "daysSinceDue")).toBe(3);
    expect(asFiniteNumber(3.25, "daysSinceDue")).toBe(3.25);
    expect(asNullableNumber(null, "daysSinceCourtesy")).toBeNull();
  });
});
