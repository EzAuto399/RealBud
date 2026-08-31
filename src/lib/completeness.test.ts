import { describe, expect, it } from "vitest";

import type { Property } from "./desk";
import { completenessLine, propertyCompleteness } from "./completeness";

function prop(overrides: Partial<Property> = {}): Property {
  return {
    id: "prop-x",
    address: "12 Oak St, Dickson ACT",
    tenantName: "Sam Nguyen",
    tenantPhone: "0400 111 222",
    weeklyRentCents: 58_000,
    options: { rentSource: "fixture", graceDays: 3, courtesyUntilDay: 7, levyFromRent: null, notifyChannel: "sms", never: [] },
    ...overrides,
  };
}

function bookWith(flags?: { owner?: boolean; current?: boolean }) {
  return flags
    ? {
        tenancies: flags.current ? [{ propertyId: "prop-x", status: "current" }] : [],
        contacts: flags.owner ? [{ propertyId: "prop-x", role: "owner", name: "Pat Chen" }] : [],
      }
    : null;
}

describe("propertyCompleteness", () => {
  it("counts the four core fields plus the four book details", () => {
    const bare = propertyCompleteness(prop(), bookWith());
    expect(bare).toEqual({ have: 4, total: 8, missing: ["owner contact", "current tenancy", "property code", "notes"] });
  });

  it("is complete with owner, current tenancy, code, and notes", () => {
    const full = propertyCompleteness(
      prop({ propertyCode: "A-1042", notes: "Hardship-aware." }),
      bookWith({ owner: true, current: true }),
    );
    expect(full.missing).toEqual([]);
    expect(completenessLine(full)).toBeNull();
  });

  it("names the missing piece in PM language", () => {
    const c = propertyCompleteness(prop({ tenantPhone: "" }), bookWith({ owner: true, current: true }));
    expect(completenessLine(c)).toBe("5 of 8 details — missing: tenant phone, property code, notes");
  });
});
