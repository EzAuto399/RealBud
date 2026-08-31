import { describe, expect, it } from "vitest";

import type { DeskSnapshot } from "../../shared/contracts.ts";
import { workdayGuide } from "./workday";

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
    handsDetail: "Demo book — Recheck asks the worker or a CSV for live facts.",
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
    expect(guide).toMatchObject({ phase: "unchecked", action: "practice", actionLabel: "Run sample check" });
    expect(guide.detail).toContain("training facts");
  });

  it("does not present a worker miss as a completed morning", () => {
    const guide = workdayGuide({
      connected: true,
      desk: snapshot({ lastRunAt: 1, handsDetail: "Worker timed out" }),
      workerReady: true,
    });
    expect(guide).toMatchObject({ phase: "worker-miss", action: "practice", actionLabel: "Run sample check" });
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
