import { describe, expect, it } from "vitest";

import type { Property } from "./desk";
import { filterProperties } from "./property-search";

const property = (id: string, address: string, tenantName: string): Property => ({
  id,
  address,
  tenantName,
  tenantPhone: "",
  weeklyRentCents: 0,
  options: {
    rentSource: "pms-export",
    graceDays: 0,
    courtesyUntilDay: 0,
    levyFromRent: null,
    notifyChannel: "sms",
    never: [],
  },
});

const book = [
  property("prop-king", "91 King St, Narrabundah ACT", "Riley Chen"),
  property("prop-oak", "12 Oak St, Dickson ACT", "Jordan Blake"),
  property("prop-pine", "8 Pine Ave, Braddon ACT", "Ari Nguyen"),
  property("opaque-27-identifier", "18 Portfolio Way, Testville ACT", "Test Tenant 18"),
];

describe("filterProperties", () => {
  it("finds address tokens regardless of punctuation or order in the original book", () => {
    expect(filterProperties(book, "dickson 12").map((item) => item.id)).toEqual(["prop-oak"]);
    expect(filterProperties(book, "King, St").map((item) => item.id)).toEqual(["prop-king"]);
  });

  it("finds tenant names and property ids", () => {
    expect(filterProperties(book, "nguyen").map((item) => item.id)).toEqual(["prop-pine"]);
    expect(filterProperties(book, "prop oak").map((item) => item.id)).toEqual(["prop-oak"]);
    expect(filterProperties(book, "tenant 27")).toEqual([]);
  });

  it("returns an address-sorted copy and handles no matches without mutating the book", () => {
    const original = book.map((item) => item.id);
    expect(filterProperties(book, "").map((item) => item.id)).toEqual(["prop-pine", "prop-oak", "opaque-27-identifier", "prop-king"]);
    expect(filterProperties(book, "not in this book")).toEqual([]);
    expect(book.map((item) => item.id)).toEqual(original);
  });
});
