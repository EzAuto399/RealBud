import { afterEach, describe, expect, it } from "vitest";

import type { DeskSnapshot, Draft, Escalation, Property } from "../shared/contracts.ts";
import {
  bindRemoteDecisions,
  decideRemotely,
  decisionPushText,
  flushDeferredDecisions,
  isQuietHours,
  notifyDeskSnapshot,
  parseRemoteDecisionText,
  pendingDraftId,
  resetRemoteDecisions,
  startRemoteDecisionFlush,
  type RemoteChannelAdapter,
  type RemoteDesk,
} from "./remote-decisions.ts";

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

function draft(id: string, createdAt: number, patch?: Partial<Draft>): Draft {
  return {
    id,
    propertyId: "prop-oak",
    kind: "courtesy-rent",
    status: "pending",
    channel: "sms",
    to: "0400555666",
    body: "Hi",
    periodDueAt: 1,
    createdAt,
    ...patch,
  };
}

function snapshot(drafts: Draft[], patch?: Partial<DeskSnapshot>): DeskSnapshot {
  return {
    version: 2,
    revision: 1,
    mode: "demo",
    recovery: { active: false, reason: null, quarantined: [] },
    timezone: "Australia/Sydney",
    retentionDays: null,
    properties: [
      {
        id: "prop-oak",
        address: "12 Oak St, Dickson ACT",
        tenantName: "Jordan",
        tenantPhone: "0400555666",
        weeklyRentCents: 58_000,
        options: OPTIONS,
      },
    ],
    ledger: [],
    drafts,
    escalations: [],
    workItems: [],
    lastRunAt: null,
    results: [],
    hands: "demo",
    handsDetail: null,
    sources: [],
    demo: true,
    ...patch,
  };
}

function stubChannel(id: "telegram" | "discord", sent: Array<{ id: string; text: string; draftId: string }>): RemoteChannelAdapter {
  return {
    id,
    label: id === "telegram" ? "Telegram" : "Discord",
    pairedKey: () => "chat-1",
    async sendDecision(text, draftId) {
      sent.push({ id, text, draftId });
    },
  };
}

function fakeDesk(initial: DeskSnapshot): RemoteDesk & { notes: string } {
  let snap = initial;
  const notes = { body: "" };
  return {
    get notes() {
      return notes.body;
    },
    snapshot: () => snap,
    allowDraft(id, expected, via) {
      if (expected != null && expected !== snap.revision) {
        throw Object.assign(new Error("stale desk revision"), { status: 409 });
      }
      const row = snap.drafts.find((item) => item.id === id);
      if (!row || row.status !== "pending") throw Object.assign(new Error("stale"), { status: 409 });
      row.status = "allowed";
      row.decidedAt = 1_725_000_000_000;
      if (via) row.via = via;
      snap = { ...snap, revision: snap.revision + 1, drafts: snap.drafts.map((item) => (item.id === id ? { ...row } : item)) };
      return row;
    },
    denyDraft(id, expected, via, reason) {
      if (expected != null && expected !== snap.revision) {
        throw Object.assign(new Error("stale desk revision"), { status: 409 });
      }
      const row = snap.drafts.find((item) => item.id === id);
      if (!row || row.status !== "pending") throw Object.assign(new Error("stale"), { status: 409 });
      row.status = "denied";
      row.decidedAt = 1_725_000_000_000;
      if (via) row.via = via;
      if (reason) {
        const trimmed = reason.trim();
        if (trimmed) notes.body = notes.body.trim() ? `${notes.body.trim()}\n${trimmed}` : trimmed;
      }
      snap = { ...snap, revision: snap.revision + 1, drafts: snap.drafts.map((item) => (item.id === id ? { ...row } : item)) };
      return row;
    },
    notesFor() {
      return { id: "prop-oak", body: notes.body };
    },
    writeNotes(_id, body) {
      notes.body = body;
      return { id: "prop-oak", body };
    },
  };
}

describe("decisionPushText", () => {
  it("names the address, the kind, and what Allow means", () => {
    const text = decisionPushText("12 Oak St, Dickson ACT", "courtesy-rent");
    expect(text).toBe(
      "12 Oak St, Dickson ACT — Courtesy SMS wording is ready. Allow sends nothing; it approves the wording for you to copy.",
    );
    expect(text.length).toBeLessThanOrEqual(500);
  });
});

describe("notifyDeskSnapshot", () => {
  it("pushes the oldest pending decidable draft and holds one per channel", async () => {
    const sent: Array<{ id: string; text: string; draftId: string }> = [];
    const drafts = [draft("d-newer", 20), draft("d-older", 10), draft("d-mid", 15)];
    const desk = fakeDesk(snapshot(drafts));
    bindRemoteDecisions({
      desk,
      commit: () => {},
      channels: [stubChannel("telegram", sent), stubChannel("discord", sent)],
      now: () => Date.UTC(2026, 7, 31, 0, 0, 0),
    });
    await notifyDeskSnapshot(desk.snapshot());
    expect(sent.map((row) => row.draftId)).toEqual(["d-older", "d-older"]);
    expect(pendingDraftId("telegram")).toBe("d-older");
    expect(pendingDraftId("discord")).toBe("d-older");

    await notifyDeskSnapshot(desk.snapshot());
    expect(sent).toHaveLength(2);
  });

  it("never pushes a licensee escalation", async () => {
    const sent: Array<{ id: string; text: string; draftId: string }> = [];
    const escalation: Escalation = {
      id: "esc-1",
      propertyId: "prop-oak",
      reason: "statutory-clock",
      detail: "needs the licensee",
      periodDueAt: 1,
      createdAt: 1,
    };
    const desk = fakeDesk(snapshot([], { escalations: [escalation] }));
    bindRemoteDecisions({
      desk,
      commit: () => {},
      channels: [stubChannel("telegram", sent)],
      now: () => Date.UTC(2026, 7, 31, 0, 0, 0),
    });
    await notifyDeskSnapshot(desk.snapshot());
    expect(sent).toEqual([]);
    expect(pendingDraftId("telegram")).toBeNull();
  });
});

describe("decideRemotely", () => {
  it("allows with the current revision and stamps via on the draft", async () => {
    const sent: Array<{ id: string; text: string; draftId: string }> = [];
    const desk = fakeDesk(snapshot([draft("d-1", 10), draft("d-2", 20)]));
    const commits: number[] = [];
    bindRemoteDecisions({
      desk,
      commit: (snap) => {
        commits.push(snap.revision);
        return notifyDeskSnapshot(snap);
      },
      channels: [stubChannel("telegram", sent)],
      now: () => Date.UTC(2026, 7, 31, 0, 0, 0),
    });
    await notifyDeskSnapshot(desk.snapshot());
    const result = await decideRemotely("telegram", "chat-1", "d-1", "allow", undefined, "Yoda");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.status).toBe("allowed");
    expect(result.draft.via).toBe("via Telegram · Yoda");
    expect(result.stamp).toMatch(/^Allowed via Telegram · Yoda · /);
    expect(sent.map((row) => row.draftId)).toEqual(["d-1", "d-2"]);
    expect(commits.length).toBeGreaterThan(0);
  });

  it("denies and puts the reason on the card notes", async () => {
    const desk = fakeDesk(snapshot([draft("d-1", 10)]));
    bindRemoteDecisions({
      desk,
      commit: () => {},
      channels: [stubChannel("telegram", [])],
      now: () => Date.UTC(2026, 7, 31, 0, 0, 0),
    });
    const result = await decideRemotely("telegram", "chat-1", "d-1", "deny", "too soon", "Sam");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.status).toBe("denied");
    expect(result.draft.via).toBe("via Telegram · Sam");
    expect(desk.notes).toBe("too soon");
  });

  it("answers the book-moved line on a stale 409", async () => {
    const desk = fakeDesk(snapshot([draft("d-1", 10)]));
    const original = desk.allowDraft;
    desk.allowDraft = () => {
      throw Object.assign(new Error("stale desk revision"), { status: 409 });
    };
    bindRemoteDecisions({
      desk,
      commit: () => {},
      channels: [stubChannel("telegram", [])],
    });
    const result = await decideRemotely("telegram", "chat-1", "d-1", "allow", undefined, "Yoda");
    expect(result).toEqual({ ok: false, message: "the book moved — open Desk to review" });
    desk.allowDraft = original;
    expect(desk.snapshot().drafts[0]?.status).toBe("pending");
  });

  it("never decides a licensee escalation", async () => {
    const escalation: Escalation = {
      id: "esc-1",
      propertyId: "prop-oak",
      reason: "statutory-clock",
      detail: "needs the licensee",
      periodDueAt: 1,
      createdAt: 1,
    };
    const desk = fakeDesk(snapshot([], { escalations: [escalation] }));
    bindRemoteDecisions({
      desk,
      commit: () => {},
      channels: [stubChannel("telegram", [])],
    });
    await expect(decideRemotely("telegram", "chat-1", "esc-1", "allow", undefined, "Yoda")).resolves.toEqual({
      ok: false,
      message: "that card needs the licensee — open Desk when you're at a screen",
    });
  });
});

describe("quiet hours", () => {
  it("defers a push in quiet hours and flushes after 7:01", async () => {
    const sent: Array<{ id: string; text: string; draftId: string }> = [];
    let now = Date.UTC(2026, 7, 31, 8, 0, 0);
    const desk = fakeDesk(snapshot([draft("d-1", 10)]));
    bindRemoteDecisions({
      desk,
      commit: () => {},
      channels: [stubChannel("telegram", sent)],
      now: () => now,
    });
    expect(isQuietHours(now, "Australia/Sydney")).toBe(true);
    await notifyDeskSnapshot(desk.snapshot());
    expect(sent).toEqual([]);
    expect(pendingDraftId("telegram")).toBeNull();

    now = Date.UTC(2026, 7, 31, 21, 1, 0);
    expect(isQuietHours(now, "Australia/Sydney")).toBe(false);
    await flushDeferredDecisions();
    expect(sent.map((row) => row.draftId)).toEqual(["d-1"]);
    expect(pendingDraftId("telegram")).toBe("d-1");
  });

  it("does not start the flush interval under VITEST", async () => {
    expect(process.env.VITEST).toBeTruthy();
    startRemoteDecisionFlush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pendingDraftId("telegram")).toBeNull();
  });
});

describe("parseRemoteDecisionText", () => {
  it("reads yes/allow and no with a reason", () => {
    expect(parseRemoteDecisionText("yes")).toEqual({ decision: "allow" });
    expect(parseRemoteDecisionText("Y")).toEqual({ decision: "allow" });
    expect(parseRemoteDecisionText("allow")).toEqual({ decision: "allow" });
    expect(parseRemoteDecisionText("no")).toEqual({ decision: "deny" });
    expect(parseRemoteDecisionText("no - too soon")).toEqual({ decision: "deny", reason: "too soon" });
    expect(parseRemoteDecisionText("what's late?")).toBeNull();
  });
});
