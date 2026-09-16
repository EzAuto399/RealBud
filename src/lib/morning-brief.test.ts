import { describe, expect, it } from "vitest";

import { NEVER_ACTIONS, type DeskSnapshot } from "../../shared/contracts";
import { collapseBriefRows, morningBrief, shortStreet, type MorningAddress } from "./morning-brief";

function property(id: string, address: string): DeskSnapshot["properties"][number] {
  return {
    id,
    address,
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
  };
}

function snap(partial: Partial<DeskSnapshot>): DeskSnapshot {
  return {
    version: 2,
    revision: 1,
    mode: "demo",
    recovery: { active: false, reason: null, quarantined: [] },
    timezone: "Australia/Sydney",
    retentionDays: 90,
    properties: [
      property("prop-oak", "12 Oak St, Dickson ACT"),
      property("prop-harbour", "4/22 Harbour Rd, Kingston ACT"),
      property("prop-pine", "8 Pine Ave, Braddon ACT"),
      property("prop-king", "91 King St, Narrabundah ACT"),
      property("prop-birch", "3 Birch Cl, Watson ACT"),
      property("prop-flora", "2/5 Flora St, Ainslie ACT"),
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

describe("morning brief", () => {
  it("names every address as not checked before Recheck, and never invents an inbox", () => {
    const brief = morningBrief(snap({}));
    expect(brief.addresses).toHaveLength(6);
    expect(brief.addresses.every((row) => row.attention === "unchecked")).toBe(true);
    expect(brief.checkedCount).toBe(0);
    expect(brief.headline).toBe("6 addresses on the book. Recheck has not run.");
    expect(brief.inboxConnected).toBe(false);
    expect(brief.inboxLabel).toBe("Inbox planned");
    expect(brief.inboxDetail).not.toMatch(/Gmail read that actually returns mail/i);
    expect(JSON.stringify(brief)).not.toMatch(/Hermes|100%|Verify the live book/i);
  });

  it("lands the six known addresses as checked after Recheck, with money work split out", () => {
    const brief = morningBrief(
      snap({
        lastRunAt: 1_700_000_000_000,
        results: [
          { propertyId: "prop-oak", outcome: "draft", reason: "rent-unpaid-courtesy", daysLate: 3 },
          { propertyId: "prop-harbour", outcome: "draft", reason: "rent-landed-levy-unpaid", daysLate: 2 },
          { propertyId: "prop-pine", outcome: "skip", reason: "already-reminded", daysLate: 5 },
          { propertyId: "prop-king", outcome: "escalate", reason: "statutory-clock", daysLate: 10 },
          { propertyId: "prop-birch", outcome: "clear", reason: "rent-landed", daysLate: 3 },
          { propertyId: "prop-flora", outcome: "skip", reason: "inside-grace", daysLate: 1 },
        ],
        drafts: [
          {
            id: "d-oak",
            propertyId: "prop-oak",
            kind: "courtesy-rent",
            status: "pending",
            channel: "sms",
            to: "Sam",
            body: "hi",
            periodDueAt: 1,
            createdAt: 2,
          },
          {
            id: "d-harbour",
            propertyId: "prop-harbour",
            kind: "levy-from-rent",
            status: "pending",
            channel: "desk",
            to: "Priya",
            body: "levy",
            periodDueAt: 1,
            createdAt: 2,
          },
        ],
        escalations: [
          {
            id: "esc-king",
            propertyId: "prop-king",
            reason: "statutory-clock",
            detail: "shop rule",
            periodDueAt: 1,
            createdAt: 2,
          },
        ],
      }),
    );
    expect(brief.checkedCount).toBe(6);
    expect(brief.addresses.map((row) => row.attention)).toEqual([
      "needs-you",
      "needs-you",
      "quiet",
      "licensee",
      "quiet",
      "quiet",
    ]);
    expect(brief.addresses.filter((row) => row.label === "Checked")).toHaveLength(3);
    expect(brief.addresses.find((row) => row.attention === "quiet")?.tone).toBe("muted");
    expect(brief.addresses.find((row) => row.attention === "needs-you")?.tone).toBe("agency");
    expect(brief.needsYou).toBe(2);
    expect(brief.licensee).toBe(1);
    expect(brief.headline).toBe("6 addresses checked. 2 need you, 1 for the licensee.");
    expect(brief.inboxConnected).toBe(false);
  });

  it("holds an uncovered address and ignores fixture maintenance as morning money", () => {
    const brief = morningBrief(
      snap({
        lastRunAt: 1,
        hands: "hermes",
        results: [
          { propertyId: "prop-oak", outcome: "hold", reason: "uncovered-by-worker", daysLate: 3 },
          { propertyId: "prop-harbour", outcome: "clear", reason: "rent-landed", daysLate: 0 },
        ],
        workItems: [
          {
            id: "work-oak",
            kind: "money-arrears",
            state: "held",
            propertyId: "prop-oak",
            occurrenceKey: "oak-hold",
            periodDueAt: 0,
            recipient: { name: "Sam", phone: "0400" },
            sourceIds: ["src-held"],
            observedAt: 1,
            proposalHash: "hold",
            createdAt: 1,
            updatedAt: 1,
            holdReason: "uncovered-by-worker",
          },
          {
            id: "work-maint",
            kind: "maintenance-intake",
            state: "held",
            propertyId: "prop-birch",
            occurrenceKey: "birch-maint",
            periodDueAt: 0,
            recipient: { name: "Casey", phone: "0400" },
            sourceIds: ["src-demo"],
            observedAt: 1,
            proposalHash: "maint",
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    );
    expect(brief.addresses.find((row) => row.propertyId === "prop-oak")?.attention).toBe("held");
    expect(brief.addresses.find((row) => row.propertyId === "prop-harbour")?.attention).toBe("quiet");
    expect(brief.addresses.find((row) => row.propertyId === "prop-birch")?.attention).toBe("unchecked");
    expect(brief.inboxConnected).toBe(false);
  });

  it("does not treat a Demo worker miss as addresses checked", () => {
    const brief = morningBrief(
      snap({
        lastRunAt: 1_700_000_000_000,
        hands: "demo",
        handsDetail: "Bud answered without ledger facts — facts stay held.",
        drafts: [
          {
            id: "d-oak",
            propertyId: "prop-oak",
            kind: "courtesy-rent",
            status: "pending",
            channel: "sms",
            to: "Sam",
            body: "hi",
            periodDueAt: 1,
            createdAt: 2,
          },
        ],
      }),
    );
    expect(brief.checkedCount).toBe(0);
    expect(brief.addresses.every((row) => row.attention === "unchecked")).toBe(true);
    expect(brief.headline).toBe("Recheck missed. Bud did not return live facts.");
  });

  it("still lands training Recheck as checked when the detail is the Demo book", () => {
    const brief = morningBrief(
      snap({
        lastRunAt: 1,
        hands: "demo",
        handsDetail: "Demo book — Recheck asks Bud or a CSV for live facts.",
        results: [{ propertyId: "prop-oak", outcome: "clear", reason: "rent-landed", daysLate: 0 }],
      }),
    );
    expect(brief.addresses.find((row) => row.propertyId === "prop-oak")?.attention).toBe("quiet");
    expect(brief.headline).not.toMatch(/missed/i);
  });

  it("shortens a street for the strip without dropping the suburb from the model", () => {
    expect(shortStreet("12 Oak St, Dickson ACT")).toBe("12 Oak St");
    const brief = morningBrief(snap({}));
    expect(brief.addresses[0]?.address).toContain("Dickson");
  });
});

function row(id: string, attention: MorningAddress["attention"]): MorningAddress {
  const label =
    attention === "needs-you" ? "Needs you" : attention === "licensee" ? "Licensee" : attention === "held" ? "Waiting" : attention === "quiet" ? "Checked" : "Not checked";
  const tone =
    attention === "needs-you" ? "agency" : attention === "licensee" ? "danger" : attention === "held" ? "hold" : "muted";
  return { propertyId: id, address: `${id} St`, attention, label, tone };
}

describe("collapseBriefRows", () => {
  it("leaves eight or fewer addresses expanded exactly as given", () => {
    const rows = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => row(id, "quiet"));
    expect(collapseBriefRows(rows)).toEqual({ expanded: rows, collapsedCount: 0, collapsedSummary: null });
    expect(collapseBriefRows(rows.slice(0, 3)).collapsedSummary).toBeNull();
  });

  it("keeps needs-you and licensee rows and folds the rest as checked", () => {
    const rows = [
      row("oak", "needs-you"),
      row("king", "licensee"),
      ...["a", "b", "c", "d", "e", "f", "g"].map((id) => row(id, "quiet")),
    ];
    const collapsed = collapseBriefRows(rows);
    expect(collapsed.expanded.map((item) => item.propertyId)).toEqual(["oak", "king"]);
    expect(collapsed.expanded.map((item) => item.label)).toEqual(["Needs you", "Licensee"]);
    expect(collapsed.collapsedCount).toBe(7);
    expect(collapsed.collapsedSummary).toBe("and 7 more — checked, nothing waiting");
  });

  it("names the honest mix when held addresses are folded", () => {
    const rows = [
      row("oak", "needs-you"),
      ...["a", "b", "c", "d"].map((id) => row(id, "quiet")),
      ...["h1", "h2", "h3", "h4"].map((id) => row(id, "held")),
    ];
    const collapsed = collapseBriefRows(rows);
    expect(collapsed.expanded).toHaveLength(1);
    expect(collapsed.collapsedSummary).toBe("and 8 more: 4 fine · 4 held");
  });
});
