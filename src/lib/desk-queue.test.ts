import { describe, expect, it } from "vitest";

import { NEVER_ACTIONS, type DeskSnapshot } from "../../shared/contracts";
import { buildDeskQueue, filterDeskQueue, queueCounts } from "./desk-queue";

function snap(partial: Partial<DeskSnapshot>): DeskSnapshot {
  return {
    version: 2,
    revision: 1,
    mode: "demo",
    recovery: { active: false, reason: null, quarantined: [] },
    timezone: "Australia/Sydney",
    retentionDays: 90,
    properties: [
      {
        id: "prop-oak",
        address: "12 Oak St, Dickson ACT",
        tenantName: "Sam",
        tenantPhone: "0400",
        weeklyRentCents: 62_000,
        options: {
          rentSource: "fixture",
          graceDays: 3,
          courtesyUntilDay: 7,
          levyFromRent: null,
          notifyChannel: "sms",
          never: [...NEVER_ACTIONS],
        },
      },
    ],
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

describe("desk queue model", () => {
  it("counts cases, not properties, and keeps import holds out of the case wording list", () => {
    const rows = buildDeskQueue(
      snap({
        drafts: [
          {
            id: "draft-1",
            propertyId: "prop-oak",
            kind: "courtesy-rent",
            status: "pending",
            channel: "sms",
            to: "Sam",
            body: "hi",
            periodDueAt: 1,
            createdAt: 2,
            workItemId: "work-1",
          },
        ],
        workItems: [
          {
            id: "work-1",
            kind: "money-arrears",
            state: "proposed",
            propertyId: "prop-oak",
            occurrenceKey: "oak",
            periodDueAt: 1,
            draftId: "draft-1",
            recipient: { name: "Sam", phone: "0400" },
            sourceIds: ["src-demo"],
            observedAt: 2,
            proposalHash: "h",
            createdAt: 2,
            updatedAt: 2,
          },
          {
            id: "work-unmatched",
            kind: "money-arrears",
            state: "held",
            propertyId: "",
            occurrenceKey: "unmatched",
            periodDueAt: 1,
            recipient: { name: "", phone: "" },
            sourceIds: ["src-csv"],
            observedAt: 2,
            proposalHash: "none",
            createdAt: 2,
            updatedAt: 2,
            holdReason: "unmatched",
          },
        ],
        escalations: [
          {
            id: "esc-1",
            propertyId: "prop-oak",
            reason: "statutory-clock",
            detail: "Past courtesy",
            periodDueAt: 1,
            createdAt: 3,
          },
        ],
      }),
    );
    expect(queueCounts(rows)).toEqual({ "needs-you": 1, held: 1, licensee: 1 });
    expect(rows.find((row) => row.kind === "import-issue")?.bucket).toBe("held");
    expect(filterDeskQueue(rows, "needs-you")).toHaveLength(1);
    expect(filterDeskQueue(rows, "needs-you", "unmatched")).toHaveLength(1);
    expect(filterDeskQueue(rows, "needs-you", "unmatched")[0]?.kind).toBe("import-issue");
    expect(rows.some((row) => row.kind === "import-issue" && row.bucket === "needs-you")).toBe(false);
    expect(JSON.stringify(rows)).not.toMatch(/vault|Form 11/i);
  });

  it("renders every case kind from the V3 book, including historic-only records", () => {
    const rows = buildDeskQueue(
      snap({
        book: {
          agency: { name: "Demo agency", timezone: "Australia/Sydney", jurisdictions: ["ACT"] },
          tenancies: [],
          contacts: [],
          archivedProperties: [],
          importIssues: [],
    bookProposals: [],
          decisions: [],
          cases: [
            { id: "case-maint", kind: "maintenance-intake", state: "held", propertyId: "prop-oak" },
            { id: "case-lease", kind: "lease-review", state: "held", propertyId: "prop-oak" },
            { id: "case-insp", kind: "inspection-prep", state: "held", propertyId: "prop-oak" },
            { id: "case-inb", kind: "inbound-triage", state: "held", propertyId: "prop-oak" },
          ],
        },
      }),
    );
    expect(rows.map((row) => row.kind).sort()).toEqual([
      "inbound-triage",
      "inspection-prep",
      "lease-review",
      "maintenance-intake",
    ]);
  });
});
