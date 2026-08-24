import { describe, expect, it } from "vitest";

import { emptyV3 } from "../shared/desk-v3.ts";
import { lockedNever } from "../shared/desk-v3.ts";
import { ensureDemoBreadth } from "./desk-v3-demo-breadth.ts";

describe("ensureDemoBreadth", () => {
  it("adds historic tenancy, owner/tradie and extra case kinds only on the demo book", () => {
    const live = emptyV3({ name: "Shop", timezone: "Australia/Sydney", jurisdictions: ["NSW"] });
    live.mode = "live";
    live.properties.push({
      id: "prop-oak",
      address: "12 Oak St",
      status: "active",
      options: {
        rentSource: "fixture",
        graceDays: 3,
        courtesyUntilDay: 7,
        levyFromRent: null,
        notifyChannel: "sms",
        never: [...lockedNever()],
      },
    });
    expect(ensureDemoBreadth(live, 1).contacts).toEqual([]);

    const demo = emptyV3({ name: "", timezone: "Australia/Sydney", jurisdictions: [] });
    demo.properties.push(live.properties[0]!);
    const next = ensureDemoBreadth(demo, 1_000);
    expect(next.agency.jurisdictions).toEqual(["ACT"]);
    expect(next.tenancies.some((tenancy) => tenancy.id === "ten-historic-prop-oak" && tenancy.status === "closed")).toBe(true);
    expect(next.contacts.map((contact) => contact.role).sort()).toEqual(["owner", "tradie"]);
    expect(next.cases.map((item) => item.kind).sort()).toEqual([
      "inbound-triage",
      "inspection-prep",
      "lease-review",
      "maintenance-intake",
    ]);
    expect(ensureDemoBreadth(next, 2_000).cases).toHaveLength(4);
  });
});
