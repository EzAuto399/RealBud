import { describe, expect, it } from "vitest";

import type { DeskSnapshot } from "./desk";
import type { Loop, LoopRun } from "./routines";
import { deriveAskSuggestions, deriveRoutineReminders, isAskSuggestionSpent, presentAskActivity } from "./ask-presentation";

function desk(overrides: Partial<DeskSnapshot> = {}): DeskSnapshot {
  return {
    version: 2,
    revision: 1,
    mode: "live",
    recovery: { active: false, reason: null, quarantined: [] },
    timezone: "Australia/Brisbane",
    retentionDays: 30,
    properties: [],
    ledger: [],
    drafts: [],
    escalations: [],
    workItems: [],
    lastRunAt: Date.now(),
    results: [],
    hands: "csv",
    handsDetail: null,
    sources: [],
    demo: false,
    ...overrides,
  };
}

const loop: Loop = {
  id: "morning-arrears",
  name: "Morning money check",
  description: "Checks the book",
  available: true,
  enabled: true,
  schedule: { type: "daily", time: "07:30", weekdays: [1, 2, 3, 4, 5] },
  revision: 1,
  nextRunAt: Date.now() + 60_000,
  evaluatorId: "morning-money",
  evaluatorVersion: 1,
};

function run(overrides: Partial<LoopRun> = {}): LoopRun {
  return {
    id: "run-1",
    loopId: "morning-arrears",
    loopName: "Morning money check",
    scheduledFor: 100,
    status: "completed",
    manual: false,
    createdAt: 90,
    ...overrides,
  };
}

describe("Ask activity presentation", () => {
  it("turns provider skill syntax into PM language", () => {
    const activity = presentAskActivity("skill view (intake-properties)", true);
    expect(activity).toMatchObject({ kind: "intake", status: "done", title: "Property intake rules checked" });
    expect(JSON.stringify(activity)).not.toMatch(/skill view|intake-properties/);
  });

  it("does not label a morning-arrears skill view as property intake", () => {
    const activity = presentAskActivity("skill view (morning-arrears)", true);
    expect(activity).toMatchObject({ kind: "general", status: "done", title: "Morning money rules checked" });
    expect(activity.title).not.toMatch(/intake/i);
    expect(JSON.stringify(activity)).not.toMatch(/skill view|morning-arrears/);
  });

  it("keeps failed host probes out of the Ask thread", () => {
    expect(presentAskActivity("python: import os", false)).toMatchObject({ kind: "suppressed", status: "failed" });
  });

  it("never promotes a model tool title into a connected claim", () => {
    const activity = presentAskActivity("mcp__composio__gmail_search", true);
    expect(activity.title).toBe("Source connection check completed");
    expect(activity.detail).toMatch(/verifies connection state separately/i);
  });

  it("degrades unknown and control-filled tool names to a closed generic label", () => {
    expect(presentAskActivity("deploy_everything\nsecret", undefined)).toMatchObject({
      kind: "general",
      status: "working",
      title: "Bud is checking the request",
    });
  });
});

describe("Ask next-step suggestions", () => {
  it("prioritises recovery, failed routines and held work without executing anything", () => {
    const suggestions = deriveAskSuggestions(
      desk({
        recovery: { active: true, reason: "locked", quarantined: [] },
        workItems: [{
          id: "work-1",
          kind: "money-arrears",
          state: "held",
          propertyId: "property-1",
          occurrenceKey: "period-1",
          periodDueAt: 1,
          recipient: { name: "Tenant", phone: "" },
          sourceIds: [],
          observedAt: 1,
          proposalHash: "hash",
          createdAt: 1,
          updatedAt: 1,
        }],
      }),
      [loop],
      [run({ status: "failed" })],
    );

    expect(suggestions.map((item) => item.id)).toEqual(["recovery", "routine-attention"]);
    expect(suggestions.every((item) => item.action.kind === "ask")).toBe(true);
    expect(suggestions.every((item) => item.action.kind === "ask" && item.action.prompt.length > 20)).toBe(true);
    expect(JSON.stringify(suggestions)).not.toMatch(/"kind":"desk"|"kind":"you"/);
  });

  it("names the live hold count and property in the Ask prompt", () => {
    const suggestions = deriveAskSuggestions(
      desk({
        lastRunAt: 0,
        properties: [{
          id: "property-1",
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
            never: [],
          },
        }],
        workItems: [{
          id: "work-1",
          kind: "money-arrears",
          state: "held",
          propertyId: "property-1",
          occurrenceKey: "period-1",
          periodDueAt: 1,
          recipient: { name: "Tenant", phone: "" },
          sourceIds: [],
          observedAt: 1,
          proposalHash: "hash",
          createdAt: 1,
          updatedAt: 1,
        }],
      }),
      [],
      [],
    );

    expect(suggestions[0]).toMatchObject({
      id: "held-work",
      label: "Resolve 1 hold at 12 Oak St",
    });
    expect(suggestions[0].action.kind === "ask" && suggestions[0].action.prompt).toMatch(/12 Oak St/);
    expect(suggestions[0].action.kind === "ask" && suggestions[0].action.prompt).toMatch(/Do not send/);
  });

  it("reviews live pending drafts as an Ask turn, not a Desk jump", () => {
    const suggestions = deriveAskSuggestions(
      desk({
        lastRunAt: 0,
        properties: [{
          id: "property-1",
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
            never: [],
          },
        }],
        drafts: [{
          id: "draft-1",
          propertyId: "property-1",
          kind: "courtesy",
          status: "pending",
          channel: "sms",
          to: "0400",
          body: "Hi Sam",
          periodDueAt: 1,
          createdAt: 1,
        }],
      }),
      [],
      [],
    );

    expect(suggestions[0]).toMatchObject({
      id: "pending-decisions",
      label: "Review 1 draft at 12 Oak St",
    });
    expect(suggestions[0].action.kind).toBe("ask");
    expect(suggestions[0].action.kind === "ask" && suggestions[0].action.prompt).toMatch(/Allow would approve/);
  });

  it("asks Bud to review this morning's exceptions once the clock has already run", () => {
    const suggestions = deriveAskSuggestions(desk(), [loop], []);
    expect(suggestions[0]).toMatchObject({
      id: "review-morning-landed",
      label: "Review this morning's exceptions",
      action: {
        kind: "ask",
        prompt: expect.stringMatching(/Review this morning's exceptions/),
      },
    });
    expect(suggestions[0].action.kind === "ask" && suggestions[0].action.prompt).toMatch(/Do not send or pay/);
    expect(suggestions.some((item) => item.id === "run-morning-money")).toBe(false);
  });

  it("offers a run of an enabled owner letter on that loop's live clock, not a vendor", () => {
    const friday: Loop = {
      ...loop,
      id: "owner-letter",
      name: "Friday owner letter",
      schedule: { type: "daily", time: "16:00", weekdays: [5] },
    };
    const suggestions = deriveAskSuggestions(
      desk({ lastRunAt: Date.now(), mode: "live", demo: false, hands: "csv" }),
      [loop, friday],
      [],
      { composioConfigured: false },
    );
    expect(suggestions.map((item) => item.id)).toEqual(["review-morning-landed"]);
    expect(JSON.stringify(suggestions)).not.toMatch(/composio/i);

    const fridayOnly = deriveAskSuggestions(
      desk({ lastRunAt: Date.now() - 86_400_000, mode: "live", demo: false, hands: "csv" }),
      [friday],
      [],
    );
    expect(fridayOnly[0]).toMatchObject({
      id: "run-owner-letter",
      label: "Run Friday owner letter",
      detail: expect.stringMatching(/Fri at 4:00 pm/i),
      action: { kind: "ask", prompt: "Run the Friday owner letter now." },
    });
    expect(fridayOnly[0].action.kind === "ask" && fridayOnly[0].action.prompt).not.toMatch(/send/i);
  });

  it("offers to turn on a paused named routine at its current clock", () => {
    const paused: Loop = { ...loop, enabled: false };
    const suggestions = deriveAskSuggestions(
      desk({ lastRunAt: Date.now() - 86_400_000, mode: "live", demo: false }),
      [paused],
      [],
    );
    expect(suggestions[0]).toMatchObject({
      id: "enable-morning-money",
      label: "Turn on Morning money check",
    });
    expect(suggestions[0].detail).toMatch(/Weekdays at 7:30 am/);
    expect(suggestions[0].action).toMatchObject({
      kind: "ask",
      prompt: expect.stringMatching(/Turn on Morning money check/),
    });
    expect(suggestions.some((item) => item.id === "run-morning-money")).toBe(false);
  });

  it("offers a same-turn morning money run after setup when the clock has not run today", () => {
    const suggestions = deriveAskSuggestions(
      desk({ lastRunAt: Date.now() - 86_400_000, mode: "live", demo: false }),
      [loop],
      [],
    );
    expect(suggestions[0]).toMatchObject({
      id: "run-morning-money",
      label: "Run Morning money check",
      action: { kind: "ask", prompt: "Run the Morning money check now." },
    });
    expect(suggestions[0].detail).toMatch(/Weekdays at 7:30 am/);
  });

  it("keeps Suggested next on the current book decision, not a setup strip", () => {
    const suggestions = deriveAskSuggestions(
      desk({ lastRunAt: Date.now(), mode: "demo", demo: true }),
      [loop],
      [],
    );
    expect(suggestions.map((item) => item.id)).toEqual(["review-morning-landed"]);
    expect(JSON.stringify(suggestions)).not.toMatch(/composio|propertyme|Set up connections/i);
  });

  it("drops a card this office already asked, then shows the next live book item", () => {
    const asked = "Review this morning's exceptions. The clock already ran Recheck. Summarise what still needs Allow and the next safe step for each. Do not send or pay.";
    expect(isAskSuggestionSpent({
      id: "review-morning-landed",
      label: "Review this morning's exceptions",
      detail: "The clock already pressed Recheck.",
      action: { kind: "ask", prompt: asked },
    }, [asked])).toBe(true);

    const suggestions = deriveAskSuggestions(
      desk({ lastRunAt: Date.now(), mode: "demo", demo: true }),
      [loop],
      [],
      { userTexts: [asked] },
    );
    expect(suggestions).toEqual([]);
    expect(suggestions.some((item) => item.id === "review-morning-landed")).toBe(false);
  });

  it("does not spend a card on a short overlapping word", () => {
    expect(isAskSuggestionSpent({
      id: "held-work",
      label: "Ask about 1 licensee hold",
      detail: "Held work.",
      action: { kind: "ask", prompt: "Ask about the licensee hold on Oak Street. Do not send or pay." },
    }, ["hold", "review", "exceptions"])).toBe(false);
  });

  it("does not pad Suggested next with connect or verify after the office already spoke", () => {
    const suggestions = deriveAskSuggestions(
      desk({ lastRunAt: Date.now(), mode: "demo", demo: true }),
      [loop],
      [],
      { userTexts: ["connect me to instagram"] },
    );
    expect(suggestions.map((item) => item.id)).toEqual(["review-morning-landed"]);
    expect(JSON.stringify(suggestions)).not.toMatch(/Set up connections|Verify the live book/);
  });

  it("offers verify-book only on an empty demo thread with no live decision", () => {
    const suggestions = deriveAskSuggestions(
      desk({ lastRunAt: 0, mode: "demo", demo: true }),
      [],
      [],
    );
    expect(suggestions.map((item) => item.id)).toEqual(["verify-book"]);
  });
});

describe("routine reminder projection", () => {
  it("emits only unseen, unnotified failures and completed runs with linked held work", () => {
    const failed = run({ id: "run-failed", status: "failed", scheduledFor: 300 });
    const held = run({ id: "run-held", status: "completed", scheduledFor: 200 });
    const alreadyNotified = run({ id: "run-old", status: "missed", scheduledFor: 100, notifiedAt: 500 });
    const snapshot = desk({
      workItems: [{
        id: "work-held",
        kind: "money-arrears",
        state: "held",
        propertyId: "property-1",
        occurrenceKey: "period-held",
        periodDueAt: 1,
        recipient: { name: "Tenant", phone: "" },
        sourceIds: [],
        observedAt: 1,
        proposalHash: "hash",
        createdAt: 1,
        updatedAt: 1,
        origin: { kind: "routine", runId: "run-held", loopId: "morning-arrears" },
      }],
    });

    expect(deriveRoutineReminders([alreadyNotified, held, failed], snapshot)).toEqual([
      { runId: "run-failed", kind: "failed" },
      { runId: "run-held", kind: "held" },
    ]);
  });

  it("does not notify for queued/running/successful no-hold runs", () => {
    expect(deriveRoutineReminders([
      run({ id: "queued", status: "queued" }),
      run({ id: "running", status: "running" }),
      run({ id: "done", status: "completed" }),
    ], desk())).toEqual([]);
  });
});
