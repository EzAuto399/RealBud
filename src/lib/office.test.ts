import { describe, expect, it } from "vitest";

import {
  agencyIsNamed,
  coerceOffice,
  emptyOffice,
  officeContractComplete,
  officeFilledCount,
  parseOfficePatch,
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

  it("coerces a loose snapshot office back onto closed unions", () => {
    expect(coerceOffice({ pmsBrand: "nope", pmUser: "Alex" })).toMatchObject({
      pmUser: "Alex",
      pmsBrand: "",
    });
  });
});
