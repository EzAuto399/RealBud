import { describe, expect, it } from "vitest";

import { NEVER_ACTIONS, type DeskSnapshot } from "../../shared/contracts";
import { buildDeskQueue, filterDeskQueue, groupDeskQueue, queueCounts } from "./desk-queue";

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
    expect(queueCounts(rows)).toEqual({ "needs-you": 3, waiting: 0, handling: 0 });
    expect(rows.find((row) => row.kind === "import-issue")?.bucket).toBe("held");
    expect(filterDeskQueue(rows, "needs-you")).toHaveLength(3);
    expect(filterDeskQueue(rows, "needs-you", "unmatched")).toHaveLength(1);
    expect(filterDeskQueue(rows, "needs-you", "unmatched")[0]?.kind).toBe("import-issue");
    expect(rows.find((row) => row.kind === "import-issue")?.pmState).toBe("needs-you");
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

  it("keeps source incidents singular and orders Waiting work by its next check", () => {
    const baseWork = {
      kind: "inbound-triage" as const,
      propertyId: "prop-oak",
      occurrenceKey: "wait",
      periodDueAt: 1,
      recipient: { name: "Sam", phone: "0400" },
      sourceIds: ["src-mail"],
      observedAt: 2,
      proposalHash: "h",
      createdAt: 2,
      updatedAt: 2,
    };
    const rows = buildDeskQueue(snap({
      workItems: [
        { ...baseWork, id: "wait-later", state: "waiting", lifecycle: { waitingParty: "tradie", nextCheckAt: 300 } },
        { ...baseWork, id: "wait-sooner", state: "waiting", lifecycle: { waitingParty: "sender", nextCheckAt: 200 } },
        {
          ...baseWork,
          id: "source-incident",
          kind: "source-incident",
          state: "held",
          propertyId: "",
          holdReason: "PMS source unavailable",
          sourceIncident: { sourceId: "src-pms", code: "unavailable", affectedPropertyCount: 100, firstSeenAt: 1, lastSeenAt: 2 },
        },
      ],
    }));

    expect(rows.filter((row) => row.kind === "source-incident")).toHaveLength(1);
    expect(filterDeskQueue(rows, "waiting").map((row) => row.workItemId)).toEqual(["wait-sooner", "wait-later"]);
    expect(filterDeskQueue(rows, "needs-you", "wait")).toEqual([]);
  });

  it("drops allowed wording from Needs you and groups remaining jobs by property", () => {
    const rows = buildDeskQueue(
      snap({
        drafts: [
          {
            id: "draft-allowed",
            propertyId: "prop-oak",
            kind: "courtesy-rent",
            status: "allowed",
            channel: "sms",
            to: "Sam",
            body: "hi",
            periodDueAt: 1,
            createdAt: 2,
            decidedAt: 3,
            workItemId: "work-allowed",
          },
        ],
        workItems: [
          {
            id: "work-allowed",
            kind: "money-arrears",
            state: "approved",
            propertyId: "prop-oak",
            occurrenceKey: "oak-allowed",
            periodDueAt: 1,
            draftId: "draft-allowed",
            recipient: { name: "Sam", phone: "0400" },
            sourceIds: ["src-demo"],
            observedAt: 2,
            proposalHash: "h",
            createdAt: 2,
            updatedAt: 3,
          },
        ],
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
          ],
        },
      }),
    );

    expect(rows.find((row) => row.draftId === "draft-allowed")?.bucket).toBe("decided");
    expect(filterDeskQueue(rows, "needs-you").map((row) => row.kind).sort()).toEqual([
      "lease-review",
      "maintenance-intake",
    ]);
    expect(queueCounts(rows)["needs-you"]).toBe(2);

    const groups = groupDeskQueue(filterDeskQueue(rows, "needs-you"));
    expect(groups).toHaveLength(1);
    expect(groups[0]?.address).toBe("12 Oak St, Dickson ACT");
    expect(groups[0]?.items).toHaveLength(2);
  });
});
