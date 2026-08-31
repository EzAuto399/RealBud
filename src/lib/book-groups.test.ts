import { describe, expect, it } from "vitest";

import type { Property } from "./desk";
import { buildingKey, groupBySuburb, sortBook, suburbOf } from "./book-groups";

function prop(id: string, address: string, weeklyRentCents = 50_000): Property {
  return {
    id,
    address,
    tenantName: "A Tenant",
    tenantPhone: "0400 000 000",
    weeklyRentCents,
    options: { rentSource: "fixture", graceDays: 3, courtesyUntilDay: 7, levyFromRent: null, notifyChannel: "sms", never: [] },
  };
}

describe("buildingKey", () => {
  it("strips unit designators so units share a building", () => {
    expect(buildingKey("4/22 Harbour Rd, Kingston ACT")).toBe(buildingKey("7/22 Harbour Rd, Kingston ACT"));
    expect(buildingKey("Unit 3, 12 Oak St, Dickson ACT")).toBe(buildingKey("12 Oak St, Dickson ACT"));
    expect(buildingKey("Shop 2, 5 Flora St, Ainslie ACT")).toBe(buildingKey("2/5 Flora St, Ainslie ACT"));
  });

  it("keeps different buildings distinct", () => {
    expect(buildingKey("22 Harbour Rd, Kingston ACT")).not.toBe(buildingKey("24 Harbour Rd, Kingston ACT"));
    expect(buildingKey("12 Oak St, Dickson ACT")).not.toBe(buildingKey("12 Oak St, Kingston ACT"));
  });
});

describe("suburbOf", () => {
  it("reads everything after the first comma", () => {
    expect(suburbOf("4/22 Harbour Rd, Kingston ACT")).toBe("Kingston ACT");
    expect(suburbOf("12 Oak St")).toBe("No suburb");
  });
});

describe("groupBySuburb", () => {
  it("groups A-Z with rent subtotals and buildings clustered inside", () => {
    const groups = groupBySuburb([
      prop("b", "7/22 Harbour Rd, Kingston ACT", 52_000),
      prop("a", "12 Oak St, Dickson ACT", 58_000),
      prop("c", "4/22 Harbour Rd, Kingston ACT", 54_000),
      prop("d", "9 Elm Ave, Kingston ACT", 49_000),
    ]);
    expect(groups.map((g) => g.suburb)).toEqual(["Dickson ACT", "Kingston ACT"]);
    const kingston = groups[1]!;
    expect(kingston.weeklyRentCents).toBe(155_000);
    // the two Harbour Rd units sit together, before the Elm Ave house
    expect(kingston.properties.map((p) => p.id)).toEqual(["c", "b", "d"]);
  });
});

describe("sortBook", () => {
  const book = [prop("a", "3 Birch Cl, Watson ACT", 61_000), prop("b", "12 Oak St, Dickson ACT", 52_000)];

  it("orders by address with numeric awareness", () => {
    // 3 Birch Cl sorts before 12 Oak St: leading street numbers compare as numbers
    expect(sortBook(book, [], "address").map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("orders by rent high to low", () => {
    expect(sortBook(book, [], "rent").map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("orders by days late with unknown facts last, never as zero", () => {
    const ledger = [{ propertyId: "b", daysSinceDue: 9, rentLanded: false, levyPaid: false, daysSinceCourtesy: null }];
    expect(sortBook(book, ledger, "late").map((p) => p.id)).toEqual(["b", "a"]);
  });
});
