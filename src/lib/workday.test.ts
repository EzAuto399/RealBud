import { describe, expect, it } from "vitest";

import type { DeskSnapshot } from "../../shared/contracts.ts";
import { deskCheckAction, workdayGuide } from "./workday";

function snapshot(patch: Partial<DeskSnapshot> = {}): DeskSnapshot {
  return {
    version: 2,
    revision: 1,
    mode: "demo",
    recovery: { active: false, reason: null, quarantined: [] },
    timezone: "Australia/Brisbane",
    retentionDays: 90,
    properties: [{ id: "p1", address: "12 Oak St", notes: "" }],
    ledger: [],
    drafts: [],
    escalations: [],
    workItems: [],
    lastRunAt: null,
    results: [],
    hands: "demo",
    handsDetail: "Demo book — Recheck asks Bud or a CSV for live facts.",
    sources: [],
    demo: true,
    ...patch,
  } as DeskSnapshot;
}

describe("workdayGuide", () => {
  it("keeps the book visible but pauses actions while the local service reconnects", () => {
    const guide = workdayGuide({ connected: false, desk: snapshot(), workerReady: true });
    expect(guide).toMatchObject({ phase: "offline", action: null, title: "Reconnecting" });
    expect(guide.detail).toContain("book stays on this Mac");
  });

  it("routes recovery to the dedicated recovery surface", () => {
    const guide = workdayGuide({
      connected: true,
      desk: snapshot({ recovery: { active: true, reason: "key missing", quarantined: ["desk.locked"] } }),
      workerReady: true,
    });
    expect(guide).toMatchObject({ phase: "recovery", action: "you", actionLabel: "Open recovery" });
  });

  it("offers a labelled practice check on the sample book", () => {
    const guide = workdayGuide({ connected: true, desk: snapshot(), workerReady: false });
    expect(guide).toMatchObject({ phase: "unchecked", action: "practice", actionLabel: "Run sample morning" });
    expect(guide.detail).toContain("training facts");
  });

  it("does not present a worker miss as a completed morning", () => {
    const guide = workdayGuide({
      connected: true,
      desk: snapshot({ lastRunAt: 1, handsDetail: "Worker timed out" }),
      workerReady: true,
    });
    expect(guide).toMatchObject({
      phase: "worker-miss",
      eyebrow: "Live check missed",
      title: "Facts stay held",
      action: "practice",
      actionLabel: "Run the sample morning",
    });
    expect(guide.detail).toBe(
      "The last check did not return live facts. Bud is connected now; you can recheck from Desk or practise with the sample.",
    );
  });

  it("routes a worker miss on a live book to Bud setup", () => {
    const guide = workdayGuide({
      connected: true,
      desk: snapshot({ mode: "live", demo: false, lastRunAt: 1, handsDetail: "Worker timed out" }),
      workerReady: true,
    });
    expect(guide).toMatchObject({ phase: "worker-miss", action: "you", actionLabel: "Check Bud" });
  });

  it("prioritises a licensee item over ordinary prepared wording", () => {
    const guide = workdayGuide({
      connected: true,
      workerReady: true,
      desk: snapshot({
        lastRunAt: 1,
        hands: "hermes",
        handsDetail: "Worker answered",
        results: [{ propertyId: "p1", outcome: "escalate", reason: "statutory-clock", daysLate: 3 }],
        drafts: [{
          id: "d1",
          propertyId: "p1",
          workItemId: "w1",
          kind: "owner-letter",
          status: "pending",
          channel: "email",
          to: "owner@example.com",
          body: "Draft",
          periodDueAt: 1,
          createdAt: 1,
        }],
        escalations: [{ id: "e1", propertyId: "p1", reason: "statutory-clock", detail: "Licensee review", periodDueAt: 1, createdAt: 1 }],
      }),
    });
    expect(guide).toMatchObject({ phase: "licensee", title: "1 item needs the licensee" });
  });

  it("shows an all-clear state only after a successful check", () => {
    const guide = workdayGuide({
      connected: true,
      workerReady: true,
      desk: snapshot({
        lastRunAt: 1,
        hands: "hermes",
        handsDetail: "Worker answered",
        results: [{ propertyId: "p1", outcome: "clear", reason: "rent-landed", daysLate: 0 }],
      }),
    });
    expect(guide).toMatchObject({ phase: "clear", title: "You are clear for now" });
  });
});

describe("Desk first action", () => {
  it("offers explicitly labelled practice only for an unchecked sample book", () => {
    expect(deskCheckAction(snapshot())).toEqual({ path: "/api/desk/practice", label: "Run sample morning" });
  });
  it.each([null, 0, 1])("keeps a live book on the live check endpoint (last run %s)", (lastRunAt) => {
    expect(deskCheckAction(snapshot({ mode: "live", demo: false, lastRunAt }))).toEqual({ path: "/api/desk/check", label: "Recheck" });
  });
  it.each([0, 1])("does not silently replay samples after a prior check (%s)", (lastRunAt) => {
    expect(deskCheckAction(snapshot({ lastRunAt, handsDetail: "Worker timed out" })).path).toBe("/api/desk/check");
  });
});
