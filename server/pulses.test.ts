import { afterEach, describe, expect, it } from "vitest";

import type { DeskSnapshot, Draft, Escalation, Property } from "../shared/contracts.ts";
import {
  bindRemoteDecisions,
  flushDeferredDecisions,
  isQuietHours,
  resetRemoteDecisions,
  type RemoteChannelAdapter,
  type RemoteDesk,
} from "./remote-decisions.ts";
import { pulseLoopSettled } from "./pulses.ts";

afterEach(() => {
  resetRemoteDecisions();
});

const OPTIONS: Property["options"] = {
  rentSource: "fixture",
  graceDays: 3,
  courtesyUntilDay: 7,
  levyFromRent: null,
  notifyChannel: "sms",
  never: ["statutory-send", "trust-pay"],
};

function property(id: string, address: string): Property {
  return {
    id,
    address,
    tenantName: "Jordan",
    tenantPhone: "0400555666",
    weeklyRentCents: 58_000,
    options: OPTIONS,
  };
}

function draft(id: string, propertyId: string): Draft {
  return {
    id,
    propertyId,
    kind: "courtesy-rent",
    status: "pending",
    channel: "sms",
    to: "0400555666",
    body: "Hi",
    periodDueAt: 1,
    createdAt: 1,
  };
}

function snapshot(patch?: Partial<DeskSnapshot>): DeskSnapshot {
  return {
    version: 2,
    revision: 1,
    mode: "demo",
    recovery: { active: false, reason: null, quarantined: [] },
    timezone: "Australia/Sydney",
    retentionDays: null,
    properties: [
      property("prop-oak", "12 Oak St, Dickson ACT"),
      property("prop-harbour", "4/22 Harbour Rd, Kingston ACT"),
      property("prop-king", "91 King St, Narrabundah ACT"),
    ],
    ledger: [],
    drafts: [],
    escalations: [],
    workItems: [],
    lastRunAt: 1_700_000_000_000,
    results: [
      { propertyId: "prop-oak", outcome: "draft", reason: "rent-unpaid-courtesy", daysLate: 3 },
      { propertyId: "prop-harbour", outcome: "draft", reason: "rent-unpaid-courtesy", daysLate: 2 },
      { propertyId: "prop-king", outcome: "escalate", reason: "statutory-clock", daysLate: 10 },
    ],
    hands: "demo",
    handsDetail: "Demo book — Recheck asks Bud or a CSV for live facts.",
    sources: [],
    demo: true,
    ...patch,
  };
}

function needsYouSnap(): DeskSnapshot {
  const escalation: Escalation = {
    id: "esc-king",
    propertyId: "prop-king",
    reason: "statutory-clock",
    detail: "needs the licensee",
    periodDueAt: 1,
    createdAt: 1,
  };
  return snapshot({
    drafts: [draft("d-oak", "prop-oak"), draft("d-harbour", "prop-harbour")],
    escalations: [escalation],
  });
}

function stubChannel(id: "telegram" | "discord", sent: string[], paired = true): RemoteChannelAdapter {
  return {
    id,
    label: id === "telegram" ? "Telegram" : "Discord",
    pairedKey: () => (paired ? "chat-1" : null),
    async sendDecision() {},
    async sendDigest(text) {
      sent.push(text);
    },
  };
}

function bind(sent: string[], now: () => number): void {
  const desk: RemoteDesk = {
    snapshot: () => needsYouSnap(),
    allowDraft: () => {
      throw new Error("unused");
    },
    denyDraft: () => {
      throw new Error("unused");
    },
  };
  bindRemoteDecisions({
    desk,
    commit: () => {},
    channels: [stubChannel("telegram", sent), stubChannel("discord", sent)],
    now,
  });
}

describe("pulseLoopSettled", () => {
  it("sends one digest per paired channel when settle has needs-you", async () => {
    const sent: string[] = [];
    bind(sent, () => Date.UTC(2026, 7, 31, 0, 0, 0));
    await pulseLoopSettled("morning-arrears", needsYouSnap());
    expect(sent).toEqual([
      "Morning Recheck: 3 checked · 2 need you · 1 for the licensee. Review on Desk, or decide here as cards arrive.",
      "Morning Recheck: 3 checked · 2 need you · 1 for the licensee. Review on Desk, or decide here as cards arrive.",
    ]);
  });

  it("sends nothing when zero needs-you and zero licensee", async () => {
    const sent: string[] = [];
    bind(sent, () => Date.UTC(2026, 7, 31, 0, 0, 0));
    await pulseLoopSettled(
      "morning-arrears",
      snapshot({
        drafts: [],
        escalations: [],
        results: [
          { propertyId: "prop-oak", outcome: "clear", reason: "rent-landed", daysLate: 0 },
          { propertyId: "prop-harbour", outcome: "clear", reason: "rent-landed", daysLate: 0 },
          { propertyId: "prop-king", outcome: "clear", reason: "rent-landed", daysLate: 0 },
        ],
      }),
    );
    expect(sent).toEqual([]);
  });

  it("defers a digest in quiet hours and flushes after 7:01", async () => {
    const sent: string[] = [];
    let now = Date.UTC(2026, 7, 31, 8, 0, 0);
    bind(sent, () => now);
    expect(isQuietHours(now, "Australia/Sydney")).toBe(true);
    await pulseLoopSettled("morning-arrears", needsYouSnap());
    expect(sent).toEqual([]);

    now = Date.UTC(2026, 7, 31, 21, 1, 0);
    expect(isQuietHours(now, "Australia/Sydney")).toBe(false);
    await flushDeferredDecisions();
    expect(sent).toEqual([
      "Morning Recheck: 3 checked · 2 need you · 1 for the licensee. Review on Desk, or decide here as cards arrive.",
      "Morning Recheck: 3 checked · 2 need you · 1 for the licensee. Review on Desk, or decide here as cards arrive.",
    ]);
  });

  it("pushes an honest miss digest when Recheck returns no live facts", async () => {
    const sent: string[] = [];
    bind(sent, () => Date.UTC(2026, 7, 31, 0, 0, 0));
    await pulseLoopSettled(
      "morning-arrears",
      snapshot({
        drafts: [],
        escalations: [],
        results: [],
        hands: "demo",
        handsDetail: "Recheck missed. Bud did not return live facts.",
      }),
    );
    expect(sent).toEqual([
      "Morning Recheck: Recheck missed — facts held. Open Desk.",
      "Morning Recheck: Recheck missed — facts held. Open Desk.",
    ]);
  });
});
