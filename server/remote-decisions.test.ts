import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Desk } from "./desk.ts";

import type { DeskSnapshot, Draft, Escalation, Property } from "../shared/contracts.ts";
import {
  bindRemoteDecisions,
  decideRemotely,
  decideRemoteText,
  pendingDecisionId,
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
    editDraft(id: string, body: string, expected?: number) {
      if (expected != null && expected !== snap.revision) {
        throw Object.assign(new Error("stale desk revision"), { status: 409 });
      }
      const row = snap.drafts.find((item) => item.id === id);
      if (!row || row.status !== "pending") throw Object.assign(new Error("stale"), { status: 404 });
      row.body = body;
      snap = { ...snap, revision: snap.revision + 1, drafts: snap.drafts.map((item) => (item.id === id ? { ...row } : item)) };
      return row;
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
    expect(sent).toHaveLength(2);
    expect(sent[0]!.draftId).toBe(pendingDecisionId("telegram"));
    expect(sent[1]!.draftId).toBe(pendingDecisionId("discord"));
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
  it("does not re-send the same review card after a restart with storeDir", async () => {
    const sent: Array<{ id: string; text: string; draftId: string }> = [];
    const dir = mkdtempSync(join(tmpdir(), "realbud-decision-push-"));
    const drafts = [draft("d-harbour", 10)];
    const desk = fakeDesk(snapshot(drafts));
    bindRemoteDecisions({
      desk,
      commit: () => {},
      channels: [stubChannel("telegram", sent)],
      now: () => Date.UTC(2026, 7, 31, 0, 0, 0),
      storeDir: dir,
    });
    await notifyDeskSnapshot(desk.snapshot());
    expect(sent).toHaveLength(1);
    const firstId = pendingDecisionId("telegram");
    expect(firstId).toBeTruthy();

    // Simulate process restart: new bind, same storeDir + same pending draft.
    bindRemoteDecisions({
      desk,
      commit: () => {},
      channels: [stubChannel("telegram", sent)],
      now: () => Date.UTC(2026, 7, 31, 0, 5, 0),
      storeDir: dir,
    });
    await notifyDeskSnapshot(desk.snapshot());
    expect(sent).toHaveLength(1);
    expect(pendingDecisionId("telegram")).toBe(firstId);
  });
});

describe("decideRemotely", () => {
  it("does not approve wording changed after the phone card was delivered", async () => {
    const desk = fakeDesk(snapshot([draft("d-1", 10)]));
    bindRemoteDecisions({ desk, commit: () => {}, channels: [stubChannel("telegram", [])], now: () => Date.UTC(2026, 7, 31, 0) });
    await notifyDeskSnapshot(desk.snapshot());
    const decisionId = pendingDecisionId("telegram")!;
    desk.snapshot().drafts[0]!.body = "Different wording";
    const result = await decideRemotely("telegram", "chat-1", decisionId, "allow", undefined, "Sam");
    expect(result.ok).toBe(false);
    expect(desk.snapshot().drafts[0]!.status).toBe("pending");
  });
  it("does not approve a card that was never delivered to this channel", async () => {
    const desk = fakeDesk(snapshot([draft("d-1", 10)]));
    bindRemoteDecisions({ desk, commit: () => {}, channels: [stubChannel("telegram", [])] });
    expect((await decideRemotely("telegram", "chat-1", "d-1", "allow", undefined, "Sam")).ok).toBe(false);
    expect(desk.snapshot().drafts[0]!.status).toBe("pending");
  });
  it("coalesces overlapping snapshots while delivery is pending", async () => {
    let finish!: () => void;
    const send = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const desk = fakeDesk(snapshot([draft("d-1", 10)]));
    bindRemoteDecisions({ desk, commit: () => {}, channels: [{ ...stubChannel("telegram", []), sendDecision: send }], now: () => Date.UTC(2026, 7, 31, 0) });
    const first = notifyDeskSnapshot(desk.snapshot()); await Promise.resolve();
    const second = notifyDeskSnapshot(desk.snapshot()); await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    finish(); await Promise.all([first, second]);
  });
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
    const result = await decideRemotely("telegram", "chat-1", pendingDecisionId("telegram")!, "allow", undefined, "Yoda");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.status).toBe("allowed");
    expect(result.draft.via).toBe("via Telegram · Yoda");
    expect(result.stamp).toMatch(/^Allowed via Telegram · Yoda · /);
    expect(sent).toHaveLength(2);
    expect(pendingDraftId("telegram")).toBe("d-2");
    expect(sent[0]!.draftId).not.toBe(sent[1]!.draftId);
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
    await notifyDeskSnapshot(desk.snapshot());
    const result = await decideRemotely("telegram", "chat-1", pendingDecisionId("telegram")!, "deny", "too soon", "Sam");
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
      now: () => Date.UTC(2026, 7, 31, 0),
    });
    await notifyDeskSnapshot(desk.snapshot());
    const result = await decideRemotely("telegram", "chat-1", pendingDecisionId("telegram")!, "allow", undefined, "Yoda");
    expect(result).toEqual({ ok: false, message: "This work changed. Review the current wording on Desk before deciding." });
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
    expect(sent).toHaveLength(1);
    expect(sent[0]!.draftId).toBe(pendingDecisionId("telegram"));
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

describe("review card identity and recovery", () => {
  function setup(patch: Partial<RemoteChannelAdapter> = {}, rows = [draft("d-1", 10), draft("d-2", 20)]) {
    const desk = fakeDesk(snapshot(rows));
    const sent: Array<{ id: string; text: string; draftId: string }> = [];
    const channel = { ...stubChannel("telegram", sent), ...patch };
    const options = { desk, channels: [channel], commit: (snap: DeskSnapshot) => notifyDeskSnapshot(snap), now: () => Date.UTC(2026, 7, 31, 0) };
    bindRemoteDecisions(options);
    return { desk, sent, channel, options };
  }

  it.each([
    { body: "Changed wording" }, { to: "another@example.test" }, { propertyId: "prop-other" },
    { channel: "email" as const }, { kind: "owner-letter" as const }, { periodDueAt: 42 },
  ])("replaces a changed card and refuses the old approval: %j", async patch => {
    const { desk, sent } = setup();
    await notifyDeskSnapshot(desk.snapshot());
    const old = pendingDecisionId("telegram")!;
    Object.assign(desk.snapshot().drafts[0]!, patch);
    await notifyDeskSnapshot(desk.snapshot());
    const current = pendingDecisionId("telegram")!;
    expect(current).not.toBe(old);
    expect(sent).toHaveLength(2);
    expect((await decideRemotely("telegram", "chat-1", old, "allow", undefined, "Sam")).ok).toBe(false);
    expect(desk.snapshot().drafts[0]!.status).toBe("pending");
    expect((await decideRemotely("telegram", "chat-1", current, "allow", undefined, "Sam")).ok).toBe(true);
  });

  it("shows exact recipient and wording, and does not invalidate review for an unrelated revision", async () => {
    const { desk, sent } = setup();
    await notifyDeskSnapshot(desk.snapshot());
    expect(sent[0]!.text).toContain("To: 0400555666 (sms)\n\nHi\n\n");
    expect(sent[0]!.text).toContain("Allow sends nothing");
    const id = pendingDecisionId("telegram")!;
    desk.snapshot().revision++;
    expect((await decideRemotely("telegram", "chat-1", id, "allow", undefined, "Sam")).ok).toBe(true);
  });

  it("does not guess what yes means or apply a repeated coded reply to the next card", async () => {
    const { desk } = setup(); await notifyDeskSnapshot(desk.snapshot());
    const id = pendingDecisionId("telegram")!;
    expect(await decideRemoteText("telegram", "chat-1", "yes", "Sam")).toMatchObject({ ok: false, message: expect.stringContaining(`allow ${id}`) });
    expect(desk.snapshot().drafts[0]!.status).toBe("pending");
    expect((await decideRemoteText("telegram", "chat-1", `allow ${id}`, "Sam"))?.ok).toBe(true);
    expect((await decideRemoteText("telegram", "chat-1", `allow ${id}`, "Sam"))?.ok).toBe(false);
    expect(desk.snapshot().drafts[1]!.status).toBe("pending");
  });

  it("admits only one decision across two paired channels", async () => {
    const { desk, options } = setup();
    bindRemoteDecisions({ ...options, channels: [...options.channels, stubChannel("discord", [])] });
    await notifyDeskSnapshot(desk.snapshot());
    const first = pendingDecisionId("telegram")!, second = pendingDecisionId("discord")!;
    const outcomes = await Promise.all([
      decideRemotely("telegram", "chat-1", first, "allow", undefined, "Sam"),
      decideRemotely("discord", "chat-1", second, "deny", undefined, "Sam"),
    ]);
    expect(outcomes.filter(result => result.ok)).toHaveLength(1);
    expect(desk.snapshot().revision).toBe(2);
  });

  it("keeps a saved decision successful when notification fails", async () => {
    const { desk, options } = setup();
    bindRemoteDecisions({ ...options, commit: () => { throw new Error("notification failed"); } });
    await notifyDeskSnapshot(desk.snapshot());
    expect((await decideRemotely("telegram", "chat-1", pendingDecisionId("telegram")!, "allow", undefined, "Sam")).ok).toBe(true);
    expect(desk.snapshot().drafts[0]!.status).toBe("allowed");
  });

  it("does not approve truncated wording", async () => {
    const sendDecision = vi.fn(), sendDigest = vi.fn();
    const { desk } = setup({ sendDecision, sendDigest }, [draft("long", 1, { body: "x".repeat(1900) })]);
    await notifyDeskSnapshot(desk.snapshot());
    expect(sendDecision).not.toHaveBeenCalled();
    expect(sendDigest).toHaveBeenCalledWith(expect.stringContaining("full wording"));
    expect(pendingDecisionId("telegram")).toBeNull();
    expect((await decideRemotely("telegram", "chat-1", "long", "allow", undefined, "Sam")).ok).toBe(false);
  });

  it("recovers failed delivery using the same card identity", async () => {
    const sendDecision = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const { desk } = setup({ sendDecision });
    await notifyDeskSnapshot(desk.snapshot());
    const id = sendDecision.mock.calls[0]![1];
    expect(pendingDecisionId("telegram")).toBeNull();
    await notifyDeskSnapshot(desk.snapshot());
    expect(sendDecision.mock.calls[1]![1]).toBe(id);
    expect(pendingDecisionId("telegram")).toBe(id);
  });

  it("refreshes an old card after restart and rejects a re-paired account", async () => {
    let paired = "chat-1";
    const { desk, options } = setup({ pairedKey: () => paired });
    await notifyDeskSnapshot(desk.snapshot());
    const old = pendingDecisionId("telegram")!;
    bindRemoteDecisions(options);
    expect((await decideRemotely("telegram", "chat-1", old, "allow", undefined, "Sam")).ok).toBe(false);
    await notifyDeskSnapshot(desk.snapshot());
    expect(pendingDecisionId("telegram")).not.toBe(old);
    const current = pendingDecisionId("telegram")!;
    paired = "chat-2";
    expect((await decideRemotely("telegram", "chat-2", current, "allow", undefined, "Other")).ok).toBe(false);
    expect(desk.snapshot().drafts[0]!.status).toBe("pending");
  });

  it("does not publish late delivery into a replacement binding", async () => {
    let finish!: () => void;
    const { desk } = setup({ sendDecision: () => new Promise<void>(resolve => { finish = resolve; }) });
    const old = notifyDeskSnapshot(desk.snapshot()); await Promise.resolve();
    const replacement = setup({}, [draft("new", 1)]);
    await notifyDeskSnapshot(replacement.desk.snapshot());
    const current = pendingDecisionId("telegram");
    finish(); await old;
    expect(pendingDraftId("telegram")).toBe("new");
    expect(pendingDecisionId("telegram")).toBe(current);
  });

  it("refreshes wording that changed while the old card was being delivered", async () => {
    let finish!: () => void;
    const sendDecision = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
    const { desk } = setup({ sendDecision });
    const sending = notifyDeskSnapshot(desk.snapshot()); await Promise.resolve();
    const old = sendDecision.mock.calls[0]![1];
    desk.snapshot().drafts[0]!.body = "Updated before delivery completed";
    finish(); await sending;
    expect(sendDecision).toHaveBeenCalledTimes(2);
    expect(pendingDecisionId("telegram")).toBe(sendDecision.mock.calls[1]![1]);
    expect(pendingDecisionId("telegram")).not.toBe(old);
    expect((await decideRemotely("telegram", "chat-1", old, "allow", undefined, "Sam")).ok).toBe(false);
  });

  it("holds decisions during book recovery and does not disclose reply codes to another pairing", async () => {
    const { desk } = setup(); await notifyDeskSnapshot(desk.snapshot());
    const id = pendingDecisionId("telegram")!;
    expect(await decideRemoteText("telegram", "other", "yes", "Other")).toEqual({ ok: false, message: "This Bud is paired elsewhere." });
    desk.snapshot().recovery.active = true;
    expect((await decideRemotely("telegram", "chat-1", id, "allow", undefined, "Sam")).ok).toBe(false);
    expect(desk.snapshot().drafts[0]!.status).toBe("pending");
  });

  it("binds review to the actual durable Desk edit and saves only the newly reviewed wording", async () => {
    const desk = fakeDesk(snapshot([draft("d-review", 10, { body: "Original wording for this tenant." })]));
    const sent: Array<{ id: string; text: string; draftId: string }> = [];
    bindRemoteDecisions({
      desk,
      channels: [stubChannel("telegram", sent)],
      commit: notifyDeskSnapshot,
      now: () => Date.UTC(2026, 7, 17, 2),
    });
    await notifyDeskSnapshot(desk.snapshot());
    const draftId = pendingDraftId("telegram");
    expect(draftId).toBe("d-review");
    const old = pendingDecisionId("telegram")!;
    const edited = desk.editDraft(draftId!, "Updated wording for this tenant only.", desk.snapshot().revision);
    expect((await decideRemotely("telegram", "chat-1", old, "allow", undefined, "Sam")).ok).toBe(false);
    await notifyDeskSnapshot(desk.snapshot());
    expect(sent.at(-1)!.text).toContain(edited.body);
    expect((await decideRemotely("telegram", "chat-1", pendingDecisionId("telegram")!, "allow", undefined, "Sam")).ok).toBe(true);
    expect(desk.snapshot().drafts.find((row) => row.id === draftId)).toMatchObject({ status: "allowed", body: edited.body });
  });
});
