import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { NEVER_ACTIONS, type DeskSnapshot } from "../shared/contracts.ts";
import { DESK_CONTEXT_FILE, DESK_CONTEXT_MAX_CHARS, deskContextMarkdown, writeDeskContext } from "./desk-context.ts";

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
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it("includes modern maintenance cases and legacy work once without exposing unrelated property or contact data", () => {
    const snap = snapshot();
    snap.drafts = [];
    snap.book = {
      agency: { name: "Fictional office", timezone: "Australia/Brisbane", jurisdictions: ["ACT"] },
      office: { pmUser: "", pmsBrand: "", namedExporter: "", exportCadence: "", exportIdentity: "", officeOs: "", vendorTestAccount: "" },
      bookProposals: [], tenancies: [], contacts: [], archivedProperties: [], importIssues: [], decisions: [],
      cases: [
        { id: "modern-maintenance", kind: "maintenance", state: "held", propertyId: "prop-oak" },
        { id: "already-finished", kind: "owner-update", state: "confirmed", propertyId: "prop-oak" },
        { id: "other-property-private", kind: "maintenance", state: "held", propertyId: "prop-other" },
      ],
    };
    const work = {
      id: "legacy-follow-up", kind: "owner-letter" as const, state: "held" as const, propertyId: "prop-oak",
      occurrenceKey: "occurrence", periodDueAt: 1, recipient: { name: "PRIVATE recipient", phone: "PRIVATE phone" },
      sourceIds: [], observedAt: 1, proposalHash: "PRIVATE hash", createdAt: 1, updatedAt: 1,
    };
    snap.workItems = [work, { ...work, id: "modern-maintenance" }, { ...work, id: "already-finished" }, { ...work, id: "other-legacy-private", propertyId: "prop-other" }];
    const markdown = deskContextMarkdown(snap);
    expect(markdown).toContain("Case modern-maintenance: maintenance for prop-oak; state held");
    expect(markdown).toContain("Work legacy-follow-up: owner-letter for prop-oak; state held");
    expect(markdown.match(/modern-maintenance/g)).toHaveLength(1);
    expect(markdown).not.toContain("already-finished");
    expect(markdown).not.toContain("other-property-private");
    expect(markdown).not.toContain("other-legacy-private");
    expect(markdown).not.toContain("PRIVATE");
    expect(markdown).not.toContain("Nothing is waiting");
    expect(markdown).toContain("Generation time does not mean the source was refreshed");
  });

  it("bounds larger books while preserving source boundaries and explicitly marking omitted records", () => {
    const snap = snapshot();
    const base = snap.properties[0];
    snap.properties = Array.from({ length: 800 }, (_, index) => ({ ...base, id: `prop-${index}`, address: `${index} ${"Very long street name ".repeat(20)}` }));
    snap.drafts = Array.from({ length: 800 }, (_, index) => ({ ...snap.drafts[0], id: `draft-${index}`, propertyId: `prop-${index}` }));
    const markdown = deskContextMarkdown(snap);
    expect(markdown.length).toBeLessThanOrEqual(DESK_CONTEXT_MAX_CHARS);
    expect(markdown).toContain("Projection incomplete");
    expect(markdown).toContain("records are not included");
    expect(markdown).toContain("## Source boundary");
    expect(markdown).toContain("never authorizes sending");
    expect(markdown).not.toContain("PRIVATE");
  });
});
