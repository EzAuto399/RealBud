import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeskSnapshot } from "../shared/contracts.ts";
import { bindRemoteDecisions, decideRemotely, decideRemoteText, resetRemoteDecisions, type DecisionButtons, type RemoteChannelAdapter } from "./remote-decisions.ts";
import { answerToolCardTap, bindRemoteToolCards, remoteToolCardOpened, remoteToolCardResolved, resetRemoteToolCards, type RemoteToolCardsBind } from "./remote-tool-cards.ts";
import type { OptionCardData } from "./store.ts";

const NOW = Date.UTC(2026, 9, 8, 1, 0); // 12:00 pm in Sydney
const STALE = "This card is no longer current. Nothing was changed.";
type Sent = { kind: "decision" | "notice"; text: string; id?: string; buttons?: DecisionButtons };

let dir: string, file: string, now: number, quiet: boolean;
let cards: Map<string, OptionCardData>;
let notes: Array<{ requestId: string; held: string | undefined }>;
let sent: Sent[];
let answer: ReturnType<typeof vi.fn<RemoteToolCardsBind["answer"]>>;

function channel(pairedSender: string | null = "user-1"): RemoteChannelAdapter {
  return {
    id: "telegram", label: "Telegram",
    pairedKey: () => "chat-1",
    pairedSender: () => pairedSender,
    async sendDecision(text, id, buttons) { sent.push({ kind: "decision", text, id, ...(buttons ? { buttons } : {}) }); },
    async sendDigest(text) { sent.push({ kind: "notice", text }); },
  };
}

function bind(channels = [channel()]) {
  // The Desk side has no cards, so every id routes to the live action cards.
  const snapshot = { revision: 1, mode: "demo", timezone: "Australia/Sydney", recovery: { active: false }, drafts: [], escalations: [], properties: [] } as unknown as DeskSnapshot;
  bindRemoteDecisions({ desk: { snapshot: () => snapshot, allowDraft: () => { throw new Error("no desk"); }, denyDraft: () => { throw new Error("no desk"); } }, commit: () => {}, channels });
  return bindRemoteToolCards({
    channels, file, quiet: () => quiet, timeZone: () => "Australia/Sydney", now: () => now,
    liveCard: (_threadId, requestId) => cards.get(requestId) ?? null,
    noteCard: (_threadId, requestId, held) => { notes.push({ requestId, held }); },
    answer,
  });
}

function appCard(requestId: string, patch: Partial<OptionCardData> = {}): OptionCardData {
  const card: OptionCardData = {
    title: "Approval needed",
    subtitle: [
      "Bud wants to use Gmail.",
      "Account: the account connected in Connected apps",
      "Action: Fetch emails (GMAIL_FETCH_EMAILS)",
      "  Query: from:fictional-owner@example.test",
      "This approval applies once to this request only. The exact request is under Exact request.",
    ].join("\n"),
    options: ["Allow", "Deny"],
    requestId,
    tool: "bud_connected_app_action",
    remote: "read",
    deadline: new Date(NOW + 285_000).toISOString(),
    detail: `{"name":"GMAIL_FETCH_EMAILS","request":"${requestId}"}`,
    readOffer: { appLabel: "Gmail", always: false, group: "app:gmail" },
    ...patch,
  };
  cards.set(requestId, card);
  return card;
}

const lastId = () => sent.filter(row => row.kind === "decision").at(-1)!.id!;
const tap = (id: string, decision: "allow" | "deny" | "task" = "allow", chat = "chat-1", sender = "user-1") =>
  decideRemotely("telegram", chat, id, decision, undefined, "Fictional Sam", sender);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "realbud-tool-cards-"));
  file = join(dir, "remote-tool-decisions.json");
  now = NOW; quiet = false; cards = new Map(); notes = []; sent = [];
  answer = vi.fn<RemoteToolCardsBind["answer"]>(async () => ({ status: 200 }));
});
afterEach(() => { resetRemoteToolCards(); resetRemoteDecisions(); rmSync(dir, { recursive: true, force: true }); });

describe("live action cards on a paired phone", () => {
  it("pushes a read card with three buttons and answers a tap through the desktop's answer path", async () => {
    await bind();
    appCard("req-1");
    await remoteToolCardOpened("thread-1", "req-1");
    expect(sent).toHaveLength(1);
    const push = sent[0]!;
    expect(push.buttons).toEqual({ allow: "Allow once", task: "Allow for this task", deny: "Deny" });
    expect(push.id).toMatch(/^[a-f0-9]{12}$/);
    expect(push.text).toMatch(/^Bud wants to read — Gmail\.\n/);
    expect(push.text).toContain("Account: the account connected in Connected apps");
    expect(push.text).toContain("Query: from:fictional-owner@example.test");
    expect(push.text).toContain("Waiting until 12:04 pm.");
    expect(push.text).toContain(`task ${push.id}`);
    expect(notes).toEqual([{ requestId: "req-1", held: "Also on Telegram" }]);

    const result = await tap(push.id!, "task");
    expect(result).toEqual({ ok: true, stamp: "Allowed for this task by Fictional Sam via Telegram · 12:00 pm" });
    expect(answer).toHaveBeenCalledExactlyOnceWith("thread-1", "req-1", "task", { name: "Fictional Sam", via: "telegram" }, "Allowed for this task by Fictional Sam via Telegram · 12:00 pm");
    // The resolve hook hands back the card's own text, without the phone note.
    expect(remoteToolCardResolved("thread-1", "req-1", { behavior: "allow", resolution: "user" })).toEqual({ held: undefined });
  });

  it("accepts the text grammar for channels without buttons", async () => {
    await bind();
    appCard("req-1", { remote: "write", readOffer: undefined, subtitle: "Bud wants to use Google Calendar.\nAccount: the account connected in Connected apps\nAction: Create event (GOOGLECALENDAR_CREATE_EVENT)\n  Summary: Fictional inspection" });
    await remoteToolCardOpened("thread-1", "req-1");
    expect(sent[0]!.buttons).toEqual({ allow: "Allow once", deny: "Deny" });
    expect(sent[0]!.text).toMatch(/^Bud wants to change something — Google Calendar\.\n/);
    const id = lastId();
    expect(await decideRemoteText("telegram", "chat-1", `task ${id}`, "Fictional Sam", "user-1")).toEqual({ ok: false, message: "Allow for this task is only for reads. Nothing was changed." });
    expect(await decideRemoteText("telegram", "chat-1", `deny ${id}`, "Fictional Sam", "user-1")).toMatchObject({ ok: true, stamp: expect.stringMatching(/^Denied by Fictional Sam via Telegram · /) });
    expect(answer).toHaveBeenCalledExactlyOnceWith("thread-1", "req-1", "deny", { name: "Fictional Sam", via: "telegram" }, expect.any(String));
  });

  it("does nothing for a double, stale, expired, wrong-chat or wrong-sender tap", async () => {
    await bind();
    for (const id of ["double", "stale", "expired", "chat", "sender"]) { appCard(id); await remoteToolCardOpened("thread-1", id); }
    const ids = Object.fromEntries(sent.map((row, index) => [["double", "stale", "expired", "chat", "sender"][index], row.id!]));

    expect((await tap(ids.double!)).ok).toBe(true);
    expect(await tap(ids.double!)).toEqual({ ok: false, message: STALE });

    cards.get("stale")!.subtitle += "\n  Changed: after the push";
    expect(await tap(ids.stale!)).toEqual({ ok: false, message: STALE });

    expect(await tap(ids.chat!, "allow", "chat-2")).toEqual({ ok: false, message: "This Bud is paired elsewhere." });
    expect((await tap(ids.sender!, "allow", "chat-1", "user-2")).ok).toBe(false);
    // The module's own check: the push went to chat-1#user-1, not to anyone else in that chat.
    expect(await answerToolCardTap("telegram", "chat-1", "user-2", "Other", ids.sender!, "allow")).toEqual({ ok: false, message: STALE });

    now = NOW + 285_000;
    expect(await tap(ids.expired!)).toEqual({ ok: false, message: "Timed out at 12:04 pm. Bud did not do it." });
    expect(answer).toHaveBeenCalledOnce();
  });

  it("sends a desktop-only card as a notice with no buttons, amounts or recipients", async () => {
    await bind();
    appCard("pay", {
      tool: "browser_click", remote: "desktop-only", readOffer: undefined,
      subtitle: "Pay $1,234.56 to Fictional Plumbing Pty Ltd (BSB fictional-062-000)",
      fence: { surface: "portal-submit", origin: "portal.example.test", ruleOffer: null },
      browserApproval: { kind: "pay", site: "portal.example.test" } as unknown as OptionCardData["browserApproval"],
    });
    appCard("direct", { remote: "desktop-only", readOffer: undefined, subtitle: "Bud wants to use Gmail.\nAccount: the account connected in Connected apps\nAction: Send email (GMAIL_SEND_EMAIL)\n  Recipient email: fictional-tenant@example.test\n  Body: Rent of $580 is due" });
    await remoteToolCardOpened("thread-1", "pay");
    await remoteToolCardOpened("thread-1", "direct");
    expect(sent).toEqual([
      { kind: "notice", text: "Bud is waiting in RealBud: portal.example.test · a payment. Open RealBud to decide." },
      { kind: "notice", text: "Bud is waiting in RealBud: Gmail · Send email. Open RealBud to decide." },
    ]);
    expect(JSON.stringify(sent)).not.toMatch(/1,234|580|Plumbing|fictional-tenant/);
    expect(notes).toEqual([]);
  });

  it("puts the whole message on a send card, and no buttons on one that is too long", async () => {
    await bind();
    const mail = (body: string) => [
      "Bud wants to send an email from the connected mailbox. Check every recipient, the subject, the message and the attachments. This approval sends this one message once.",
      "", "Action: Send a new email (GMAIL_SEND_EMAIL)", 'From: "fictional-office@example.test"',
      'To: "fictional-tenant@example.test"', 'Cc: "fictional-owner@example.test"', "Bcc: none", 'Subject: "Rent reminder"',
      'Attachments: "statement.pdf" (application/pdf, 2048 bytes)', `Message (plain text), ${body.length} characters, every line shown:`, `| ${body}`,
    ].join("\n");
    appCard("send", { remote: "send", readOffer: undefined, subtitle: mail("Hi, a fictional reminder that rent is due Friday.") });
    appCard("long", { remote: "send", readOffer: undefined, subtitle: mail("x".repeat(1900)) });
    await remoteToolCardOpened("thread-1", "send");
    await remoteToolCardOpened("thread-1", "long");
    expect(sent[0]!.buttons).toEqual({ allow: "Send it", deny: "Don't send" });
    expect(sent[0]!.text.startsWith(cards.get("send")!.subtitle)).toBe(true);
    for (const part of ['To: "fictional-tenant@example.test"', 'Cc: "fictional-owner@example.test"', 'Subject: "Rent reminder"', '"statement.pdf"', "rent is due Friday"]) expect(sent[0]!.text).toContain(part);
    expect(sent[1]).toEqual({ kind: "notice", text: "Bud is waiting in RealBud: Gmail · Send email. Open RealBud to decide." });
  });

  it("pushes nothing during quiet hours and says so on the desktop card", async () => {
    quiet = true;
    await bind();
    appCard("req-1", { held: "This request needs your approval once. Saved rules do not apply." });
    await remoteToolCardOpened("thread-1", "req-1");
    expect(sent).toEqual([]);
    expect(notes).toEqual([{ requestId: "req-1", held: "This request needs your approval once. Saved rules do not apply. · Not sent to your phone: quiet hours" }]);
    expect(remoteToolCardResolved("thread-1", "req-1", { behavior: "deny", resolution: "timeout" })).toEqual({ held: "This request needs your approval once. Saved rules do not apply." });
  });

  it("pushes nothing to a pairing that is not a private chat with a recorded sender", async () => {
    await bind([channel(null)]);
    appCard("req-1");
    await remoteToolCardOpened("thread-1", "req-1");
    expect(sent).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("keeps push and decision receipts across a restart", async () => {
    await bind();
    for (const id of ["desk", "timeout", "open"]) { appCard(id); await remoteToolCardOpened("thread-1", id); }
    const [desk, timeout, open] = sent.map(row => row.id!);
    remoteToolCardResolved("thread-1", "desk", { behavior: "allow", resolution: "user" });
    remoteToolCardResolved("thread-1", "timeout", { behavior: "deny", resolution: "timeout" });
    await vi.waitFor(() => expect((JSON.parse(readFileSync(file, "utf8")) as { pushes: Array<{ outcome?: unknown }> }).pushes.filter(row => row.outcome)).toHaveLength(2));

    resetRemoteToolCards(); resetRemoteDecisions();
    await bind();
    expect(await tap(desk!)).toEqual({ ok: false, message: "Already decided on the computer (Allowed)." });
    expect(await tap(timeout!)).toEqual({ ok: false, message: "Timed out at 12:04 pm. Bud did not do it." });
    expect(await tap(open!)).toEqual({ ok: false, message: "RealBud restarted, so this request ended. Nothing was changed." });
    expect(answer).not.toHaveBeenCalled();
    expect(readFileSync(file, "utf8")).not.toContain("fictional-owner@example.test");
  });

  it("holds phone cards when the receipts file is damaged, and keeps the file", async () => {
    writeFileSync(file, "{not json", { mode: 0o600 });
    await bind();
    appCard("req-1");
    await remoteToolCardOpened("thread-1", "req-1");
    expect(sent).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("{not json");
  });
});
