import { describe, expect, it } from "vitest";
import { parseIntakeText } from "./intake.ts";

describe("parseIntakeText", () => {
  it("reads comma, pipe, and tab lines with the AU state fold", () => {
    const r = parseIntakeText(`12 Oak St, Dickson ACT, Jordan Blake, 0400 555 666, 580
4/22 Harbour Rd, Kingston ACT | Priya Shah | 0400 333 444 | 750
8 Pine Ave	Braddon ACT	Jordan Blake	0400 555 666	580`);
    expect(r.items).toHaveLength(3);
    expect(r.items[0]).toEqual({
      address: "12 Oak St, Dickson ACT",
      tenantName: "Jordan Blake",
      tenantPhone: "0400 555 666",
      weeklyRentCents: 58_000,
    });
    expect(r.unparsed).toEqual([]);
  });

  it("handles decimal rent, bullets, and blank lines", () => {
    const r = parseIntakeText("- 91 King St, Narrabundah ACT, Alex Romero, 0400 777 888, 540.50\n\n");
    expect(r.items[0]?.weeklyRentCents).toBe(54_050);
    expect(r.unparsed).toEqual([]);
  });

  it("reports garbage lines without dropping good neighbours", () => {
    const r = parseIntakeText("12 Oak St, Dickson ACT, Jordan Blake, 0400 555 666, 580\nnot a property\n");
    expect(r.items).toHaveLength(1);
    expect(r.unparsed).toEqual(["not a property"]);
  });

  it("rejects lines missing any required field", () => {
    expect(parseIntakeText("12 Oak St, Dickson ACT, 580").items).toHaveLength(0);
    expect(parseIntakeText("12 Oak St, Dickson ACT, Jordan Blake, 580").items).toHaveLength(0);
    expect(parseIntakeText("12 Oak St, Dickson ACT, Jordan Blake, 0400 555 666, abc").items).toHaveLength(0);
  });
});
