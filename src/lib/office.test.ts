import { describe, expect, it } from "vitest";

import {
  agencyIsNamed,
  coerceOffice,
  emptyOffice,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  officeContractComplete,
  officeFilledCount,
  parseOfficePatch,
  parseRetentionDays,
} from "../../shared/office";

const named = {
  agencyName: "Harbour PM",
  jurisdictions: ["ACT"],
  office: {
    ...emptyOffice(),
    pmUser: "Alex",
    pmsBrand: "other" as const,
    namedExporter: "Principal",
    exportCadence: "daily" as const,
    exportIdentity: "address" as const,
    officeOs: "linux" as const,
    vendorTestAccount: "fake-building-portal",
  },
};

describe("office visit fields", () => {
  it("does not count the training agency as named", () => {
    expect(agencyIsNamed("Demo agency")).toBe(false);
    expect(agencyIsNamed("RealBud Demo Book")).toBe(false);
    expect(agencyIsNamed("Harbour PM")).toBe(true);
  });

  it("keeps the demo book incomplete even when ACT is already on the book", () => {
    expect(
      officeFilledCount({
        agencyName: "Demo agency",
        jurisdictions: ["ACT"],
        office: emptyOffice(),
      }),
    ).toBe(1);
    expect(
      officeContractComplete({
        agencyName: "Demo agency",
        jurisdictions: ["ACT"],
        office: emptyOffice(),
      }),
    ).toBe(false);
  });

  it("is complete only when all eight fields are real", () => {
    expect(officeContractComplete(named)).toBe(true);
    expect(officeFilledCount(named)).toBe(8);
    expect(officeContractComplete({ ...named, office: { ...named.office, vendorTestAccount: "" } })).toBe(false);
  });

  it("rejects an unknown PMS and a long name", () => {
    expect(parseOfficePatch({ pmsBrand: "aime" }).ok).toBe(false);
    expect(parseOfficePatch({ pmUser: "x".repeat(81) }).ok).toBe(false);
    expect(parseOfficePatch({ pmUser: "Alex", pmsBrand: "other" })).toEqual({
      ok: true,
      value: { pmUser: "Alex", pmsBrand: "other" },
    });
  });

  it("keeps retention a whole number of days, or nothing", () => {
    expect(parseRetentionDays(90)).toEqual({ ok: true, value: 90 });
    expect(parseRetentionDays(null)).toEqual({ ok: true, value: null });
    expect(parseRetentionDays(MIN_RETENTION_DAYS).ok).toBe(true);
    expect(parseRetentionDays(MAX_RETENTION_DAYS).ok).toBe(true);
  });

  it("refuses a retention window that would destroy the book immediately", () => {
    // 0 days would mean "destroy now", so this floor is a safety property.
    expect(parseRetentionDays(0).ok).toBe(false);
    expect(parseRetentionDays(1).ok).toBe(false);
    expect(parseRetentionDays(-5).ok).toBe(false);
  });

  it("refuses a retention window beyond the ceiling", () => {
    expect(parseRetentionDays(MAX_RETENTION_DAYS + 1).ok).toBe(false);
    expect(parseRetentionDays(Number.MAX_SAFE_INTEGER).ok).toBe(false);
  });

  it("refuses a retention window that is not a whole number", () => {
    expect(parseRetentionDays(90.5).ok).toBe(false);
    expect(parseRetentionDays("90").ok).toBe(false);
    expect(parseRetentionDays(Number.NaN).ok).toBe(false);
    expect(parseRetentionDays(undefined).ok).toBe(false);
  });

  it("names the safe alternative when retention is rejected", () => {
    const low = parseRetentionDays(0);
    expect(low.ok).toBe(false);
    if (!low.ok) expect(low.error).toMatch(new RegExp(String(MIN_RETENTION_DAYS)));
    const high = parseRetentionDays(MAX_RETENTION_DAYS + 1);
    expect(high.ok).toBe(false);
    if (!high.ok) expect(high.error).toMatch(/until you decide/i);
  });

  it("coerces a loose snapshot office back onto closed unions", () => {
    expect(coerceOffice({ pmsBrand: "nope", pmUser: "Alex" })).toMatchObject({
      pmUser: "Alex",
      pmsBrand: "",
    });
  });
});
