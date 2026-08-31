import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { NEVER_ACTIONS, type DeskSnapshot } from "../shared/contracts.ts";
import { DESK_CONTEXT_FILE, deskContextMarkdown, writeDeskContext } from "./desk-context.ts";

function snapshot(): DeskSnapshot {
  return {
    version: 2,
    revision: 7,
    mode: "demo",
    recovery: { active: false, reason: null, quarantined: [] },
    timezone: "Australia/Brisbane",
    retentionDays: 90,
    properties: [{
      id: "prop-oak",
      address: "12 Oak St, Dickson ACT",
      tenantName: "Private Tenant",
      tenantPhone: "0400 123 456",
      weeklyRentCents: 58_000,
      options: {
        rentSource: "fixture",
        graceDays: 3,
        courtesyUntilDay: 7,
        levyFromRent: null,
        notifyChannel: "sms",
        never: [...NEVER_ACTIONS],
      },
    }],
    ledger: [{ propertyId: "prop-oak", daysSinceDue: 3, rentLanded: false, levyPaid: false, daysSinceCourtesy: null }],
    drafts: [{
      id: "draft-1",
      propertyId: "prop-oak",
      kind: "courtesy-rent",
      status: "pending",
      channel: "sms",
      to: "0400 123 456",
      body: "Private draft body",
      periodDueAt: 1,
      createdAt: 2,
    }],
    escalations: [],
    workItems: [],
    lastRunAt: 1_700_000_000_000,
    results: [{ propertyId: "prop-oak", outcome: "draft", reason: "rent-unpaid-courtesy", daysLate: 3 }],
    hands: "demo",
    handsDetail: "Demo book",
    sources: [],
    demo: true,
  };
}

describe("Desk workroom context", () => {
  it("projects current operational facts without contact or recovery material", () => {
    const markdown = deskContextMarkdown(snapshot(), 1_700_000_000_000);
    expect(markdown).toContain("TRAINING SAMPLE");
    expect(markdown).toContain("12 Oak St, Dickson ACT");
    expect(markdown).toContain("| 3 | no | no | none | 580.00 |");
    expect(markdown).toContain("waiting for a person");
    expect(markdown).not.toContain("Private Tenant");
    expect(markdown).not.toContain("0400 123 456");
    expect(markdown).not.toContain("Private draft body");
  });

  it("writes the projection atomically as a private workroom file", () => {
    const book = mkdtempSync(join(tmpdir(), "realbud-desk-context-"));
    const path = writeDeskContext(snapshot(), book);
    expect(path).toBe(join(book, DESK_CONTEXT_FILE));
    expect(readFileSync(path, "utf8")).toContain("Current Desk context");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
