// Telegram channel: pairing, Ask relay, offset, and a token that never leaks.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StartTurnFn, TelegramDeps, TelegramFetch } from "./channels/telegram.ts";

const dataDir = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || process.cwd();
  const dir = `${base}/realbud-telegram-${process.pid}-${Date.now().toString(36)}`;
  process.env.REALBUD_DATA_DIR = dir;
  return dir;
});

const { join } = await import("node:path");
const { Store } = await import("./store.ts");
const telegram = await import("./channels/telegram.ts");
const remote = await import("./remote-decisions.ts");
const { createPairingCode } = await import("./channel-pairing.ts");
import type { Draft } from "../shared/contracts.ts";

const TOKEN = "999001:SuperSecretTelegramTokenXYZ";

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubFetch(opts?: {
  me?: { id: number; username: string } | "fail";
  onSend?: (chatId: number, text: string, body?: Record<string, unknown>) => void;
  onAnswer?: (callbackId: string, text?: string) => void;
  onEdit?: (chatId: number, messageId: number, text: string) => void;
  onGetUpdates?: () => void;
  sendError?: Error;
}): TelegramFetch {
  return async (input, init) => {
    const url = String(input);
    if (url.includes("/getMe")) {
      if (opts?.me === "fail") return jsonRes({ ok: false, description: "Unauthorized" }, 401);
      const me = opts?.me ?? { id: 1, username: "realbud_bot" };
      return jsonRes({ ok: true, result: { ...me, is_bot: true } });
    }
    if (url.includes("/getUpdates")) {
      opts?.onGetUpdates?.();
      return jsonRes({ ok: true, result: [] });
    }
    if (url.includes("/answerCallbackQuery")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { callback_query_id?: string; text?: string };
      opts?.onAnswer?.(String(body.callback_query_id ?? ""), body.text);
      return jsonRes({ ok: true, result: true });
    }
    if (url.includes("/editMessageText")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { chat_id?: number; message_id?: number; text?: string };
      opts?.onEdit?.(Number(body.chat_id), Number(body.message_id), String(body.text ?? ""));
      return jsonRes({ ok: true, result: { message_id: body.message_id } });
    }
    if (url.includes("/sendMessage")) {
      if (opts?.sendError) throw opts.sendError;
      const body = JSON.parse(String(init?.body ?? "{}")) as { chat_id?: number; text?: string };
      opts?.onSend?.(Number(body.chat_id), String(body.text ?? ""), body);
      return jsonRes({ ok: true, result: { message_id: 1 } });
    }
    return jsonRes({ ok: false }, 404);
  };
}

function update(id: number, chatId: number, text: string, name = "Sam") {
  return { update_id: id, message: { chat: { id: chatId }, from: { first_name: name }, text } };
}

function deps(store: InstanceType<typeof Store>, startTurn: StartTurnFn, fetchFn: TelegramFetch): TelegramDeps {
  return {
    store,
    startTurn,
    subscribe: () => () => {},
    fetch: fetchFn,
  };
}

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  mkdirSync(dataDir, { recursive: true });
  rmSync(join(dataDir, "channel.json"), { force: true });
  rmSync(join(dataDir, "bots.json"), { force: true });
  telegram.stopTelegramBridge();
});

afterEach(() => {
  telegram.stopTelegramBridge();
  remote.resetRemoteDecisions();
  vi.restoreAllMocks();
});

describe("verifyToken", () => {
  it("returns id and username for a live bot", async () => {
    await expect(telegram.verifyToken(stubFetch({ me: { id: 42, username: "realbud_bot" } }), TOKEN)).resolves.toEqual({
      id: 42,
      username: "realbud_bot",
    });
  });

  it("throws plain language when BotFather would reject the token", async () => {
    await expect(telegram.verifyToken(stubFetch({ me: "fail" }), TOKEN)).rejects.toThrow(/BotFather/);
  });
});

describe("pairing and relay", () => {
  it("requires the Mac pairing code and refuses another chat", async () => {
    const store = new Store(() => ({ instanceId: "", model: "" }));
    store.seedIfEmpty();
    telegram.saveChannel({
      botToken: TOKEN,
      botUsername: "realbud_bot",
      pairedChatId: null,
      pairedName: null,
      offset: 0,
      connectedAt: 1,
      lastMessageAt: null,
    });
    const sent: Array<{ chatId: number; text: string }> = [];
    const fetchFn = stubFetch({ onSend: (chatId, text) => sent.push({ chatId, text }) });
    const startTurn = vi.fn(async () => {});
    await telegram.handleTelegramUpdates([update(8, 222, "hi", "Other")], deps(store, startTurn, fetchFn));
    expect(telegram.loadChannel()?.pairedChatId).toBeNull();
    expect(sent).toHaveLength(0);
    await telegram.handleTelegramUpdates([update(10, 111, createPairingCode("telegram").command, "Sam")], deps(store, startTurn, fetchFn));
    expect(sent).toEqual([{ chatId: 111, text: "Paired with RealBud on this Mac. Send a task, /continue for your latest saved reply, or /help. Keep this Mac awake and online." }]);
    expect(telegram.loadChannel()).toMatchObject({ pairedChatId: 111, pairedName: "Sam", offset: 11 });
    expect(startTurn).not.toHaveBeenCalled();

    await telegram.handleTelegramUpdates([update(11, 222, "hello", "Other")], deps(store, startTurn, fetchFn));
    expect(sent[1]).toEqual({ chatId: 222, text: "This Bud is paired elsewhere." });
    expect(startTurn).not.toHaveBeenCalled();
    const userLines = store.messagesFor(store.bot("bud")!.threadId).filter((m) => m.role === "user");
    expect(userLines).toHaveLength(0);
  });

  it("prefixes inbound paired text and starts the Bud turn", async () => {
    const store = new Store(() => ({ instanceId: "", model: "" }));
    store.seedIfEmpty();
    telegram.saveChannel({
      botToken: TOKEN,
      botUsername: "realbud_bot",
      pairedChatId: 111,
      pairedName: "Sam",
      offset: 20,
      connectedAt: 1,
      lastMessageAt: null,
    });
    const startTurn = vi.fn(async () => {});
    await telegram.handleTelegramUpdates(
      [update(21, 111, "what's late?", "Sam")],
      deps(store, startTurn, stubFetch()),
    );
    const bot = store.bot("bud")!;
    const last = store.messagesFor(bot.threadId).at(-1);
    expect(last).toMatchObject({ role: "user", kind: "text", text: "[Telegram · Sam] what's late?" });
    expect(startTurn).toHaveBeenCalledWith("bud", "what's late?", expect.objectContaining({ userMessage: last, channelRelay: true }));
    await telegram.handleTelegramUpdates([update(21, 111, "what's late?", "Sam")], deps(store, startTurn, stubFetch()));
    expect(startTurn).toHaveBeenCalledTimes(1);

  });

  it("starts Ask when Bud still has a legacy upgraded id", async () => {
    const store = new Store(() => ({ instanceId: "", model: "" }));
    store.seedIfEmpty();
    const legacyId = "c634d570-adaa-420d-b3d2-fee96ac63523";
    const bud = store.bot("bud")!;
    bud.id = legacyId;
    telegram.saveChannel({
      botToken: TOKEN,
      botUsername: "realbud_bot",
      pairedChatId: 111,
      pairedName: "Yoda",
      offset: 20,
      connectedAt: 1,
      lastMessageAt: null,
    });
    const startTurn = vi.fn(async () => {});
    await telegram.handleTelegramUpdates(
      [update(21, 111, "hi bud", "Yoda")],
      deps(store, startTurn, stubFetch()),
    );
    expect(store.bot("bud")).toBeNull();
    expect(store.productBud()?.id).toBe(legacyId);
    const last = store.messagesFor(bud.threadId).at(-1);
    expect(last).toMatchObject({ role: "user", kind: "text", text: "[Telegram · Yoda] hi bud" });
    expect(startTurn).toHaveBeenCalledWith(legacyId, "hi bud", expect.objectContaining({ userMessage: last, channelRelay: true }));
  });

  it("relays a sync Ask reply without waiting for turn.completed", async () => {
    const store = new Store(() => ({ instanceId: "", model: "" }));
    store.seedIfEmpty();
    const bot = store.bot("bud")!;
    telegram.saveChannel({
      botToken: TOKEN,
      botUsername: "realbud_bot",
      pairedChatId: 111,
      pairedName: "Sam",
      offset: 0,
      connectedAt: 1,
      lastMessageAt: null,
    });
    const sent: string[] = [];
    const startTurn = vi.fn(async () => {
      store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "I'm Bud. What needs you?" });
    });
    const fetchFn = stubFetch({ onSend: (_chatId, text) => sent.push(text) });
    await telegram.handleTelegramUpdates([update(1, 111, "hi", "Sam")], deps(store, startTurn, fetchFn));
    expect(sent).toEqual(["I'm Bud. What needs you?"]);
  });

  it("relays joined assistant text on turn.completed", async () => {
    const store = new Store(() => ({ instanceId: "", model: "" }));
    store.seedIfEmpty();
    const bot = store.bot("bud")!;
    telegram.saveChannel({
      botToken: TOKEN,
      botUsername: "realbud_bot",
      pairedChatId: 111,
      pairedName: "Sam",
      offset: 0,
      connectedAt: 1,
      lastMessageAt: null,
    });
    const sent: string[] = [];
    const startTurn = vi.fn(async () => {
      store.patchBot("bud", { busy: true });
    });
    const fetchFn = stubFetch({ onSend: (_chatId, text) => sent.push(text) });
    const wired = deps(store, startTurn, fetchFn);
    await telegram.handleTelegramUpdates([update(1, 111, "who is late?", "Sam")], wired);
    expect(sent).toEqual([]);
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "Oak Street is 14 days late." });
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "I can draft the owner note." });
    store.patchBot("bud", { busy: false });
    telegram.onTelegramRuntimeEvent({
      eventId: "e1",
      provider: "hermes",
      threadId: bot.threadId,
      createdAt: new Date().toISOString(),
      type: "turn.completed",
      ok: true,
    });
    await vi.waitFor(() => {
      expect(sent).toEqual(["Oak Street is 14 days late.\n\nI can draft the owner note."]);
    });
  });

  it("advances offset across a handled batch including non-text", async () => {
    const store = new Store(() => ({ instanceId: "", model: "" }));
    store.seedIfEmpty();
    telegram.saveChannel({
      botToken: TOKEN,
      botUsername: "realbud_bot",
      pairedChatId: 111,
      pairedName: "Sam",
      offset: 5,
      connectedAt: 1,
      lastMessageAt: null,
    });
    await telegram.handleTelegramUpdates(
      [
        { update_id: 6, message: { chat: { id: 111 }, sticker: { file_id: "x" } } },
        update(7, 111, "next", "Sam"),
      ],
      deps(store, async () => {}, stubFetch()),
    );
    expect(telegram.loadChannel()?.offset).toBe(8);
  });

  it("never leaks the token into logs or public status", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "));
    });
    telegram.saveChannel({
      botToken: TOKEN,
      botUsername: "realbud_bot",
      pairedChatId: 111,
      pairedName: "Sam",
      offset: 0,
      connectedAt: 1,
      lastMessageAt: null,
    });
    const store = new Store(() => ({ instanceId: "", model: "" }));
    store.seedIfEmpty();
    await telegram.handleTelegramUpdates(
      [update(1, 111, "ping", "Sam")],
      deps(
        store,
        async () => {},
        stubFetch({
          sendError: new Error(`fetch failed: ${telegram.telegramApiBase()}/bot${TOKEN}/sendMessage`),
        }),
      ),
    );
    const publicBody = telegram.telegramStatus();
    expect(publicBody.telegram).toMatchObject({ connected: true, botUsername: "realbud_bot", paired: true });
    expect(JSON.stringify(publicBody)).not.toContain(TOKEN);
    expect(logs.join("\n")).not.toContain(TOKEN);
    expect(readFileSync(join(dataDir, "channel.json"), "utf8")).toContain(TOKEN);
    if (process.platform !== "win32") {
      const mode = statSync(join(dataDir, "channel.json")).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    for (const message of store.messagesFor(store.bot("bud")!.threadId)) {
      expect(JSON.stringify(message)).not.toContain(TOKEN);
    }
  });

  it("does not start the poller under VITEST", async () => {
    expect(process.env.VITEST).toBeTruthy();
    let polled = 0;
    const store = new Store(() => ({ instanceId: "", model: "" }));
    store.seedIfEmpty();
    telegram.saveChannel({
      botToken: TOKEN,
      botUsername: "realbud_bot",
      pairedChatId: null,
      pairedName: null,
      offset: 0,
      connectedAt: 1,
      lastMessageAt: null,
    });
    telegram.startTelegramBridge({
      store,
      startTurn: async () => {},
      subscribe: () => () => {},
      fetch: stubFetch({ onGetUpdates: () => polled++ }),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(polled).toBe(0);
  });

  it("skips a junk channel file", () => {
    writeFileSync(join(dataDir, "channel.json"), "{not json");
    expect(telegram.loadChannel()).toBeNull();
    expect(telegram.telegramStatus()).toEqual({ telegram: { connected: false } });
  });
});

function callbackUpdate(id: number, chatId: number, data: string, name = "Sam") {
  return {
    update_id: id,
    callback_query: {
      id: `cb-${id}`,
      from: { first_name: name },
      message: { message_id: 9, chat: { id: chatId } },
      data,
    },
  };
}

async function bindPairedDesk(
  decided: Array<{ id: string; via?: string; status: string; reason?: string }>,
  fetchFn: TelegramFetch,
) {
  telegram.saveChannel({
    botToken: TOKEN,
    botUsername: "realbud_bot",
    pairedChatId: 111,
    pairedName: "Sam",
    offset: 0,
    connectedAt: 1,
    lastMessageAt: null,
  });
  const drafts: Draft[] = [
    {
      id: "d-oak",
      propertyId: "prop-oak",
      kind: "courtesy-rent",
      status: "pending",
      channel: "sms",
      to: "0400",
      body: "Hi",
      periodDueAt: 1,
      createdAt: 1,
    },
  ];
  const store = new Store(() => ({ instanceId: "", model: "" }));
  store.seedIfEmpty();
  telegram.bindTelegramBridge(deps(store, async () => {}, fetchFn));
  remote.bindRemoteDecisions({
    desk: {
      snapshot: () =>
        ({
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
              tenantPhone: "0400",
              weeklyRentCents: 1,
              options: {
                rentSource: "fixture",
                graceDays: 3,
                courtesyUntilDay: 7,
                levyFromRent: null,
                notifyChannel: "sms",
                never: [],
              },
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
        }) as never,
      allowDraft(id, _expected, via) {
        drafts[0]!.status = "allowed";
        drafts[0]!.via = via;
        decided.push({ id, via, status: "allowed" });
        return drafts[0]!;
      },
      denyDraft(id, _expected, via, reason) {
        drafts[0]!.status = "denied";
        drafts[0]!.via = via;
        decided.push({ id, via, status: "denied" });
        if (reason) decided.push({ id: "note", status: "note", reason });
        return drafts[0]!;
      },
      notesFor() {
        return { id: "prop-oak", body: "" };
      },
      writeNotes(_id, body) {
        decided.push({ id: "note", status: "note", reason: body });
        return { id: "prop-oak", body };
      },
    },
    commit: (snap) => remote.notifyDeskSnapshot(snap),
    channels: [telegram.telegramDecisionAdapter()],
    now: () => Date.UTC(2026, 7, 31, 0, 0, 0),
  });
  await remote.notifyDeskSnapshot({
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
        tenantPhone: "0400",
        weeklyRentCents: 1,
        options: {
          rentSource: "fixture",
          graceDays: 3,
          courtesyUntilDay: 7,
          levyFromRent: null,
          notifyChannel: "sms",
          never: [],
        },
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
  } as never);
  return store;
}

describe("remote decisions", () => {
  it("does not report failed delivery as an actionable card", async () => {
    const store = await bindPairedDesk([], stubFetch({ sendError: new Error("offline") }));
    expect(store.productBud()).toBeDefined();
    expect(remote.pendingDecisionId("telegram")).toBeNull();
  });
  it("rejects a provider-level failure despite HTTP success", async () => {
    await expect(telegram.sendDecisionMessage(async () => jsonRes({ ok: false }), TOKEN, 111, "Fictional review", "abcdef123456")).rejects.toThrow(/did not accept/);
  });
  it("a bare yes asks which card without changing work or starting the model", async () => {
    const decided: Array<{ id: string; status: string }> = [], sent: string[] = [];
    const fetchFn = stubFetch({ onSend: (_chat, text) => sent.push(text) });
    const store = await bindPairedDesk(decided, fetchFn);
    const startTurn = vi.fn(async () => {});
    await telegram.handleTelegramUpdates([update(29, 111, "yes")], deps(store, startTurn, fetchFn));
    expect(decided).toEqual([]);
    expect(startTurn).not.toHaveBeenCalled();
    expect(sent.at(-1)).toContain(`allow ${remote.pendingDecisionId("telegram")}`);
  });
  it("answers a paired callback and edits the card", async () => {
    const decided: Array<{ id: string; via?: string; status: string }> = [];
    const answered: string[] = [];
    const edited: string[] = [];
    const fetchFn = stubFetch({
      onAnswer: (id) => answered.push(id),
      onEdit: (_chat, _msg, text) => edited.push(text),
    });
    const store = await bindPairedDesk(decided, fetchFn);
    const startTurn = vi.fn(async () => {});
    await telegram.handleTelegramUpdates([callbackUpdate(30, 111, `d:${remote.pendingDecisionId("telegram")}:allow`, "Yoda")], deps(store, startTurn, fetchFn));
    expect(answered).toEqual(["cb-30"]);
    expect(decided).toEqual([{ id: "d-oak", via: "via Telegram · Yoda", status: "allowed" }]);
    expect(edited[0]).toMatch(/^Allowed via Telegram · Yoda · /);
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("ignores a callback from an unpaired chat", async () => {
    const decided: Array<{ id: string; via?: string; status: string }> = [];
    const answered: string[] = [];
    const fetchFn = stubFetch({ onAnswer: (id) => answered.push(id) });
    const store = await bindPairedDesk(decided, fetchFn);
    await telegram.handleTelegramUpdates(
      [callbackUpdate(31, 222, `d:${remote.pendingDecisionId("telegram")}:allow`, "Other")],
      deps(store, async () => {}, fetchFn),
    );
    expect(answered).toEqual([]);
    expect(decided).toEqual([]);
  });

  it("uses a card-specific reply for the pending decision and keeps other text on the Bud relay", async () => {
    const decided: Array<{ id: string; via?: string; status: string; reason?: string }> = [];
    const sent: string[] = [];
    const fetchFn = stubFetch({ onSend: (_chat, text) => sent.push(text) });
    const store = await bindPairedDesk(decided, fetchFn);
    expect(remote.pendingDraftId("telegram")).toBe("d-oak");
    const startTurn = vi.fn(async () => {});
    const wired = deps(store, startTurn, fetchFn);
    await telegram.handleTelegramUpdates([update(40, 111, `deny ${remote.pendingDecisionId("telegram")} - too soon`, "Sam")], wired);
    expect(decided).toEqual(
      expect.arrayContaining([
        { id: "d-oak", via: "via Telegram · Sam", status: "denied" },
        { id: "note", status: "note", reason: "too soon" },
      ]),
    );
    expect(sent.some((text) => /^Denied via Telegram · Sam · /.test(text))).toBe(true);
    expect(startTurn).not.toHaveBeenCalled();

    await telegram.handleTelegramUpdates([update(41, 111, "what's late?", "Sam")], wired);
    expect(startTurn).toHaveBeenCalled();
    const last = store.messagesFor(store.bot("bud")!.threadId).at(-1);
    expect(last).toMatchObject({ text: "[Telegram · Sam] what's late?" });
  });
});




describe("phone continuation and busy recovery", () => {
  it("returns saved desktop work and preserves a waiting request in the durable transcript", async () => {
    const store = new Store(() => ({ instanceId: "", model: "" })); store.seedIfEmpty();
    telegram.saveChannel({ botToken: TOKEN, botUsername: "realbud_bot", pairedChatId: 111, pairedName: "Sam", offset: 0, connectedAt: 1, lastMessageAt: null });
    const bot = store.productBud()!;
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "Owner update prepared on desktop. Approval still required." });
    const sent: string[] = []; const startTurn = vi.fn(async () => {});
    const wired = deps(store, startTurn, stubFetch({ onSend: (_id, text) => sent.push(text) }));
    await telegram.handleTelegramUpdates([update(1, 111, "/continue")], wired);
    expect(sent.at(-1)).toContain("Owner update prepared on desktop"); expect(startTurn).not.toHaveBeenCalled();
    store.patchBot(bot.id, { busy: true });
    await telegram.handleTelegramUpdates([update(2, 111, "Include the new access question")], wired);
    expect(sent.at(-1)).toContain("Saved in Ask");
    const reopened = new Store(() => ({ instanceId: "", model: "" }));
    expect(reopened.messagesFor(bot.threadId).some(message => message.text?.includes("Include the new access question"))).toBe(true);
    expect(startTurn).not.toHaveBeenCalled();
    store.patchBot(bot.id, { busy: false });
    telegram.flushTelegramRelayForThread(bot.threadId);
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledTimes(1));
    expect(startTurn).toHaveBeenCalledWith(bot.id, "Include the new access question", expect.anything());

  });
});
