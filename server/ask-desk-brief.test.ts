import { describe, expect, it } from "vitest";

import { askDeskVoice, currentAskDeskBrief } from "./ask-desk-brief.ts";
import type { DeskSnapshot } from "../shared/contracts.ts";

function snapshot(partial: Partial<DeskSnapshot>): DeskSnapshot {
  return {
    version: 2,
    revision: 1,
    mode: "demo",
    recovery: { active: false, reason: null, quarantined: [] },
    timezone: "Australia/Sydney",
    retentionDays: null,
    properties: [{
      id: "prop-harbour",
      address: "4/22 Harbour Rd, Kingston ACT",
      tenantName: "Alex",
      tenantPhone: "0400000000",
      weeklyRentCents: 62000,
      options: {
        rentSource: "fixture",
        graceDays: 3,
        courtesyUntilDay: 7,
        levyFromRent: null,
        notifyChannel: "sms",
        never: [],
      },
    }],
    ledger: [],
    drafts: [],
    escalations: [],
    workItems: [],
    lastRunAt: null,
    results: [],
    hands: "demo",
    handsDetail: null,
    sources: [],
    demo: true,
    ...partial,
  };
}

describe("currentAskDeskBrief", () => {
  it("names licensee holds and pending Allow without tenant phones or wording", () => {
    const brief = currentAskDeskBrief(snapshot({
      escalations: [{
        id: "esc-1",
        propertyId: "prop-harbour",
        reason: "statutory-clock",
        detail: "Past the shop courtesy window. A licensed person decides.",
        periodDueAt: 1,
        createdAt: 1,
      }],
      drafts: [{
        id: "draft-1",
        propertyId: "prop-harbour",
        kind: "courtesy-rent",
        status: "pending",
        channel: "sms",
        to: "0400000000",
        body: "Hi Alex, this is not a notice.",
        periodDueAt: 1,
        createdAt: 1,
      }],
    }));
    expect(brief.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "licensee-hold",
        address: "4/22 Harbour Rd, Kingston ACT",
      }),
      expect.objectContaining({
        kind: "pending-allow",
        address: "4/22 Harbour Rd, Kingston ACT",
      }),
    ]));
    expect(JSON.stringify(brief)).not.toMatch(/0400000000|Hi Alex/);
    expect(askDeskVoice(brief)).toMatch(/4\/22 Harbour Rd/);
    expect(askDeskVoice(brief)).toMatch(/Open Desk to Allow/);
    expect(askDeskVoice(brief)).not.toMatch(/0400000000|Hi Alex|were not shared/i);
  });
});
