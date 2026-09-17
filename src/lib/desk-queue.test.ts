import { describe, expect, it } from "vitest";

import { NEVER_ACTIONS, type DeskSnapshot, type WorkState } from "../../shared/contracts";
import { bucketForWork, buildDeskQueue, filterDeskQueue, queueCounts, recoveryPlanFor, type QueueBucket } from "./desk-queue";

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
    // courtesy draft, licensee escalation and the unmatched row all need a
    // person this sitting, so all three land in Now.
    expect(queueCounts(rows, 0)).toEqual({ now: 3, next: 0, waiting: 0, done: 0, licensee: 1 });
    expect(rows.find((row) => row.kind === "import-issue")?.bucket).toBe("now");
    expect(filterDeskQueue(rows, "now")).toHaveLength(3);
    expect(filterDeskQueue(rows, "now", "unmatched")).toHaveLength(1);
    expect(filterDeskQueue(rows, "now", "unmatched")[0]?.kind).toBe("import-issue");
    // an unmatched row is still its own kind, not a wording case
    expect(rows.find((row) => row.kind === "import-issue")?.action).toBe("Match this source row");
    // the licensee sorts to the top of Now
    expect(rows[0]?.kind).toBe("licensee-required");
    expect(rows[0]?.action).toBe("For the licensee — RealBud will not draft");
    expect(JSON.stringify(rows)).not.toMatch(/vault|Form 11/i);
  });

  it("names the Waiting repair in one line", () => {
    const rows = buildDeskQueue(
      snap({
        workItems: [
          {
            id: "w-miss",
            propertyId: "prop-oak",
            kind: "money-arrears",
            state: "held",
            holdReason: "uncovered-by-worker",
            occurrenceKey: "miss",
            periodDueAt: 1,
            recipient: { name: "Sam", phone: "0400", hardship: false, dispute: false, paymentArrangement: false, doNotContact: false },
            sourceIds: ["src"],
            observedAt: 1,
            proposalHash: "h",
            updatedAt: 2,
            createdAt: 1,
          },
        ],
      }),
    );
    const waiting = rows.find((row) => row.bucket === "waiting");
    expect(waiting?.action).toBe("Waiting — Bud miss");
    expect(waiting?.meta).toBe("Bud miss");
    expect(waiting && recoveryPlanFor(waiting)).toMatchObject({
      headline: "Bud could not verify the current facts",
      action: "ask",
      actionLabel: "Ask Bud to investigate",
    });
    expect(waiting && recoveryPlanFor(waiting).prompt).toMatch(/12 Oak St.*only/i);
    expect(waiting && recoveryPlanFor(waiting).prompt).toContain("source is restored. State");
    expect(waiting && recoveryPlanFor(waiting).prompt).not.toMatch(/retry this property/i);
  });

  it("routes recoveries to the authoritative place without granting consequences", () => {
    const base = {
      id: "row",
      bucket: "waiting" as const,
      state: "held",
      address: "12 Oak St, Dickson ACT",
      action: "Waiting",
      meta: "Held",
      updatedAt: 1,
    };
    expect(recoveryPlanFor({ ...base, kind: "import-issue", holdReason: "ambiguous-match" })).toMatchObject({
      action: "book",
      source: "The CSV export and the Properties book",
    });
    expect(recoveryPlanFor({ ...base, kind: "inbound-triage" })).toMatchObject({
      action: "you",
      actionLabel: "Connect an inbox",
    });
    expect(recoveryPlanFor({ ...base, kind: "licensee-required", holdReason: "dispute" })).toMatchObject({
      action: "none",
    });
    expect(recoveryPlanFor({ ...base, kind: "maintenance-intake" }).prompt).toMatch(/do not dispatch/i);
  });

  it.each(["maintenance-intake", "lease-review", "inspection-prep"] as const)("preserves the selected %s case when the property also has money work", (kind) => {
    const plan = recoveryPlanFor({ id: "case-oak", workItemId: "work-17", propertyId: "prop-oak", kind, bucket: "next", state: "held", address: "12 Oak St, Dickson ACT", action: "Prepare", meta: "On the book", updatedAt: 1 });
    expect(plan.prompt).toContain(`"kind":"${kind}"`);
    expect(plan.prompt).toContain('"caseId":"work-17"');
    expect(plan.prompt).toContain('"state":"held"');
    expect(plan.prompt).toContain(plan.missing);
    expect(plan.prompt).toContain("Check availability before claiming access");
    expect(plan.prompt).toContain("Missing case details mean an incomplete intake, not a different task");
  });

  it("renders every case kind from the V3 book, including historic-only records", () => {
    const rows = buildDeskQueue(
      snap({
        book: {
          agency: { name: "Demo agency", timezone: "Australia/Sydney", jurisdictions: ["ACT"] },
          office: {
            pmUser: "",
            pmsBrand: "",
            namedExporter: "",
            exportCadence: "",
            exportIdentity: "",
            officeOs: "",
            vendorTestAccount: "",
          },
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
    // seeded book kinds are not this morning's work and are not blocked — Next
    expect(rows.every((row) => row.bucket === "next")).toBe(true);
    expect(queueCounts(rows, 0)).toEqual({ now: 0, next: 4, waiting: 0, done: 0, licensee: 0 });
    expect(filterDeskQueue(rows, "waiting")).toHaveLength(0);
    expect(filterDeskQueue(rows, "next")).toHaveLength(4);
    expect(filterDeskQueue(rows, "all")).toHaveLength(4);
  });

  it("places every work state in exactly one part of the day", () => {
    const expected: Record<WorkState, QueueBucket> = {
      proposed: "now",
      "handoff-ready": "now",
      preparing: "next",
      held: "waiting",
      stale: "waiting",
      failed: "waiting",
      "effect-unknown": "waiting",
      "handoff-expired": "waiting",
      approved: "done",
      denied: "done",
      confirmed: "done",
      superseded: "done",
      cancelled: "done",
    };
    // the Record above cannot compile until a new WorkState is placed, and
    // bucketForWork cannot compile until its switch handles it
    for (const [state, bucket] of Object.entries(expected) as Array<[WorkState, QueueBucket]>) {
      expect(bucketForWork(state)).toBe(bucket);
    }
    expect(Object.keys(expected)).toHaveLength(13);
  });

  it("a failed or unverifiable handoff waits for a person; it is not done", () => {
    const base = {
      kind: "money-arrears" as const,
      propertyId: "prop-oak",
      occurrenceKey: "oak",
      periodDueAt: 1,
      recipient: { name: "Sam", phone: "0400" },
      sourceIds: ["src-demo"],
      observedAt: 2,
      proposalHash: "h",
      createdAt: 2,
      updatedAt: 2,
    };
    const rows = buildDeskQueue(
      snap({
        workItems: [
          { ...base, id: "w-failed", state: "failed" },
          { ...base, id: "w-unknown", state: "effect-unknown" },
          { ...base, id: "w-expired", state: "handoff-expired" },
          { ...base, id: "w-confirmed", state: "confirmed" },
        ],
      }),
    );
    const bucketOf = (id: string) => rows.find((row) => row.workItemId === id)?.bucket;
    expect(bucketOf("w-failed")).toBe("waiting");
    expect(bucketOf("w-unknown")).toBe("waiting");
    expect(bucketOf("w-expired")).toBe("waiting");
    expect(bucketOf("w-confirmed")).toBe("done");
  });

  it("counts Done for today only, but keeps the older decisions in the list", () => {
    const today = Date.UTC(2026, 7, 30, 6, 0);
    const draft = {
      propertyId: "prop-oak",
      kind: "courtesy-rent" as const,
      status: "allowed" as const,
      channel: "sms" as const,
      to: "Sam",
      body: "hi",
      periodDueAt: 1,
      createdAt: 1,
    };
    const rows = buildDeskQueue(
      snap({
        drafts: [
          { ...draft, id: "d-today", decidedAt: today },
          { ...draft, id: "d-last-week", decidedAt: today - 7 * 86_400_000 },
        ],
      }),
    );
    expect(rows.filter((row) => row.bucket === "done")).toHaveLength(2);
    expect(queueCounts(rows, today).done).toBe(1);
    expect(filterDeskQueue(rows, "done")).toHaveLength(2);
  });
});
