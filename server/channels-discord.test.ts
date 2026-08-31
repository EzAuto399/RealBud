// Discord channel: pairing, Ask relay, Gateway frames, and a token that never leaks.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DiscordDeps, DiscordFetch, DiscordRecord, DiscordSocketLike, StartTurnFn } from "./channels/discord.ts";

const dataDir = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || process.cwd();
  const dir = `${base}/realbud-discord-${process.pid}-${Date.now().toString(36)}`;
  process.env.REALBUD_DATA_DIR = dir;
  return dir;
});

const { join } = await import("node:path");
const { Store } = await import("./store.ts");
const discord = await import("./channels/discord.ts");
const remote = await import("./remote-decisions.ts");
import type { Draft } from "../shared/contracts.ts";

const TOKEN = "SuperSecretDiscordBotTokenXYZ";

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubFetch(opts?: {
  me?: { username: string } | "fail";
  gateway?: string;
  onSend?: (channelId: string, text: string, body?: Record<string, unknown>) => void;
  onCallback?: (url: string, body: unknown) => void;
  onPatch?: (url: string, body: unknown) => void;
  onGateway?: () => void;
  sendError?: Error;
}): DiscordFetch {
  return async (input, init) => {
    const url = String(input);
    if (url.includes("/users/@me")) {
      if (opts?.me === "fail") return jsonRes({ message: "401: Unauthorized", code: 0 }, 401);
      return jsonRes({ id: "1", username: opts?.me?.username ?? "realbud", bot: true });
    }
    if (url.includes("/gateway") && !url.includes("/gateway/bot")) {
      opts?.onGateway?.();
      return jsonRes({ url: opts?.gateway ?? "wss://gateway.test" });
    }
    if (url.includes("/interactions/") && url.includes("/callback")) {
      opts?.onCallback?.(url, JSON.parse(String(init?.body ?? "{}")));
      return jsonRes({ type: 6 });
    }
    if (url.includes("/channels/") && url.includes("/messages") && init?.method === "PATCH") {
      opts?.onPatch?.(url, JSON.parse(String(init.body ?? "{}")));
      return jsonRes({ id: "1" });
    }
    if (url.includes("/channels/") && url.includes("/messages")) {
      if (opts?.sendError) throw opts.sendError;
      const body = JSON.parse(String(init?.body ?? "{}")) as { content?: string };
      const channelId = url.match(/\/channels\/([^/]+)\/messages/)?.[1] ?? "";
      opts?.onSend?.(channelId, String(body.content ?? ""), body);
      return jsonRes({ id: "1" });
    }
    return jsonRes({ message: "404" }, 404);
  };
}

class FakeSocket implements DiscordSocketLike {
  url: string;
  sent: unknown[] = [];
  closed = false;
  private listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", {});
  }

  emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  hello(interval = 45_000): void {
    this.emit("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: interval } }) });
  }

  dispatch(t: string, d: unknown, s = 1): void {
    this.emit("message", { data: JSON.stringify({ op: 0, t, s, d }) });
  }
}

function dm(channelId: string, content: string, username = "Sam", extra?: Record<string, unknown>) {
  return { channel_id: channelId, author: { id: "user-1", username, bot: false }, content, ...extra };
}

function deps(store: InstanceType<typeof Store>, startTurn: StartTurnFn, fetchFn: DiscordFetch): DiscordDeps {
  return {
    store,
    startTurn,
    subscribe: () => () => {},
    fetch: fetchFn,
  };
}

function saveConnected(extra?: Partial<DiscordRecord>): void {
  discord.saveChannel({
    botToken: TOKEN,
    botUsername: "realbud",
    pairedChannelId: null,
    pairedName: null,
    connectedAt: 1,
    lastMessageAt: null,
    ...extra,
  });
}

async function startGateway(store: InstanceType<typeof Store>, startTurn: StartTurnFn, fetchFn: DiscordFetch): Promise<FakeSocket> {
  const sockets: FakeSocket[] = [];
  discord.setDiscordWebSocket((url) => {
    const socket = new FakeSocket(url);
    sockets.push(socket);
    return socket;
  });
  discord.startDiscordBridge({
    store,
    startTurn,
    subscribe: (listener) => {
      storeSubscribe = listener;
      return () => {
        storeSubscribe = null;
      };
    },
    fetch: fetchFn,
  });
  await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
  return sockets[0]!;
}

let storeSubscribe: ((event: import("./contracts.ts").RuntimeEvent) => void) | null = null;

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  mkdirSync(dataDir, { recursive: true });
  rmSync(discord.channelPath(), { force: true });
  rmSync(join(dataDir, "bots.json"), { force: true });
  storeSubscribe = null;
  discord.setDiscordWebSocket(null);
  discord.stopDiscordBridge();
});

afterEach(() => {
  discord.stopDiscordBridge();
  discord.setDiscordWebSocket(null);
  remote.resetRemoteDecisions();
  vi.restoreAllMocks();
});

describe("verifyToken", () => {
  it("returns username for a live bot", async () => {
    await expect(discord.verifyToken(stubFetch({ me: { username: "realbud" } }), TOKEN)).resolves.toEqual({
      username: "realbud",
    });
  });

  it("throws plain language when the developer portal would reject the token", async () => {
    await expect(discord.verifyToken(stubFetch({ me: "fail" }), TOKEN)).rejects.toThrow(/developer portal/);
  });
});

describe("gateway pairing and relay", () => {
  it("pairs on first DM, refuses another user once, and prefixes the Bud turn", async () => {
    const store = new Store(() => ({ instanceId: "", model: "" }));
    store.seedIfEmpty();
    saveConnected();
    const sent: Array<{ channelId: string; text: string }> = [];
    const startTurn = vi.fn(async () => {});
    const socket = await startGateway(store, startTurn, stubFetch({ onSend: (channelId, text) => sent.push({ channelId, text }) }));
    expect(socket.url).toContain("v=10");
    expect(socket.url).toContain("encoding=json");

    socket.hello();
    await vi.waitFor(() => expect(socket.sent.some((frame) => (frame as { op?: number }).op === 2)).toBe(true));
    const identify = socket.sent.find((frame) => (frame as { op?: number }).op === 2) as {
      d: { intents: number; token: string; properties: { browser: string } };
    };
    expect(identify.d.intents).toBe((1 << 12) | (1 << 15));
    expect(identify.d.properties.browser).toBe("RealBud");
    expect(identify.d.token).toBe(TOKEN);

    socket.dispatch("MESSAGE_CREATE", dm("99", "hi", "Sam"));
    await vi.waitFor(() => {
      expect(sent).toEqual([{ channelId: "99", text: "Paired with RealBud on this Mac. Ask Bud anything." }]);
    });
    expect(discord.loadChannel()).toMatchObject({ pairedChannelId: "99", pairedName: "Sam" });
    expect(startTurn).not.toHaveBeenCalled();

    socket.dispatch("MESSAGE_CREATE", dm("88", "hello", "Other"));
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toEqual({ channelId: "88", text: "This Bud is paired elsewhere." });
    socket.dispatch("MESSAGE_CREATE", dm("88", "again", "Other"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toHaveLength(2);
    expect(startTurn).not.toHaveBeenCalled();

    socket.dispatch("MESSAGE_CREATE", dm("99", "what's late?", "Sam"));
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalled());
    const last = store.messagesFor(store.bot("bud")!.threadId).at(-1);
    expect(last).toMatchObject({ role: "user", kind: "text", text: "[Discord · Sam] what's late?" });
    expect(startTurn).toHaveBeenCalledWith(
      "bud",
      "[Discord · Sam] what's late?",
      expect.objectContaining({ userMessage: last }),
    );
  });

  it("ignores bots and guild messages", async () => {
    const store = new Store(() => ({ instanceId: "", model: "" }));
    store.seedIfEmpty();
    saveConnected();
    const sent: string[] = [];
    const startTurn = vi.fn(async () => {});
    const socket = await startGateway(store, startTurn, stubFetch({ onSend: (_id, text) => sent.push(text) }));
    socket.hello();
    await vi.waitFor(() => expect(socket.sent.some((frame) => (frame as { op?: number }).op === 2)).toBe(true));
    socket.dispatch("MESSAGE_CREATE", { channel_id: "1", author: { username: "otherbot", bot: true }, content: "hi" });
    socket.dispatch("MESSAGE_CREATE", { channel_id: "2", guild_id: "g", author: { username: "Sam", bot: false }, content: "hi" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toEqual([]);
    expect(discord.loadChannel()?.pairedChannelId).toBeNull();
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("relays joined assistant text on turn.completed", async () => {
    const store = new Store(() => ({ instanceId: "", model: "" }));
    store.seedIfEmpty();
    const bot = store.bot("bud")!;
    saveConnected({ pairedChannelId: "99", pairedName: "Sam" });
    const sent: string[] = [];
    const startTurn = vi.fn(async () => {
      store.patchBot("bud", { busy: true });
    });
    const socket = await startGateway(store, startTurn, stubFetch({ onSend: (_id, text) => sent.push(text) }));
    socket.hello();
    await vi.waitFor(() => expect(socket.sent.some((frame) => (frame as { op?: number }).op === 2)).toBe(true));
    socket.dispatch("MESSAGE_CREATE", dm("99", "who is late?", "Sam"));
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalled());
    expect(sent).toEqual([]);
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "Oak Street is 14 days late." });
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "I can draft the owner note." });
    store.patchBot("bud", { busy: false });
    storeSubscribe?.({
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

  it("never leaks the token into logs or public status", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "));
    });
    saveConnected({ pairedChannelId: "99", pairedName: "Sam" });
    const store = new Store(() => ({ instanceId: "", model: "" }));
    store.seedIfEmpty();
    await discord.handleInbound(
      dm("99", "ping", "Sam"),
      deps(
        store,
        async () => {},
        stubFetch({
          sendError: new Error(`fetch failed: ${discord.discordApiBase()}/api/v10/channels/99/messages bot ${TOKEN}`),
        }),
      ),
    );
    const publicBody = discord.discordStatus();
    expect(publicBody.discord).toMatchObject({ connected: true, botUsername: "realbud", paired: true });
    expect(JSON.stringify(publicBody)).not.toContain(TOKEN);
    expect(logs.join("\n")).not.toContain(TOKEN);
    expect(readFileSync(discord.channelPath(), "utf8")).toContain(TOKEN);
    const mode = statSync(discord.channelPath()).mode & 0o777;
    expect(mode).toBe(0o600);
    for (const message of store.messagesFor(store.bot("bud")!.threadId)) {
      expect(JSON.stringify(message)).not.toContain(TOKEN);
    }
  });

  it("does not open the Gateway under VITEST without a socket factory", async () => {
    expect(process.env.VITEST).toBeTruthy();
    let fetched = 0;
    const store = new Store(() => ({ instanceId: "", model: "" }));
    store.seedIfEmpty();
    saveConnected();
    discord.startDiscordBridge({
      store,
      startTurn: async () => {},
      subscribe: () => () => {},
      fetch: stubFetch({ onGateway: () => fetched++ }),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetched).toBe(0);
  });

  it("skips a junk channel file", () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(discord.channelPath(), "{not json");
    expect(discord.loadChannel()).toBeNull();
    expect(discord.discordStatus()).toEqual({ discord: { connected: false } });
  });

  it("closes the socket on stop", async () => {
    const store = new Store(() => ({ instanceId: "", model: "" }));
    store.seedIfEmpty();
    saveConnected();
    const socket = await startGateway(store, async () => {}, stubFetch());
    discord.stopDiscordBridge();
    expect(socket.closed).toBe(true);
  });
});

async function bindPairedDesk(
  decided: Array<{ id: string; via?: string; status: string; reason?: string }>,
  fetchFn: DiscordFetch,
) {
  saveConnected({ pairedChannelId: "99", pairedName: "Sam" });
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
  discord.bindDiscordBridge(deps(store, async () => {}, fetchFn));
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
      denyDraft(id, _expected, via) {
        drafts[0]!.status = "denied";
        drafts[0]!.via = via;
        decided.push({ id, via, status: "denied" });
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
    channels: [discord.discordDecisionAdapter()],
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

function interaction(customId: string, channelId = "99", username = "Yoda") {
  return {
    id: "int-1",
    token: "int-token",
    type: 3,
    channel_id: channelId,
    data: { custom_id: customId, component_type: 2 },
    user: { username },
    message: { id: "msg-9" },
  };
}

describe("remote decisions", () => {
  it("acks INTERACTION_CREATE and patches the original message", async () => {
    const decided: Array<{ id: string; via?: string; status: string }> = [];
    const callbacks: unknown[] = [];
    const patches: Array<{ url: string; body: { content?: string; components?: unknown[] } }> = [];
    const fetchFn = stubFetch({
      onCallback: (_url, body) => callbacks.push(body),
      onPatch: (url, body) => patches.push({ url, body: body as { content?: string; components?: unknown[] } }),
    });
    const store = await bindPairedDesk(decided, fetchFn);
    const startTurn = vi.fn(async () => {});
    await discord.handleInteraction(interaction("d:d-oak:allow"), deps(store, startTurn, fetchFn));
    expect(callbacks).toEqual([{ type: 6 }]);
    expect(decided).toEqual([{ id: "d-oak", via: "via Discord · Yoda", status: "allowed" }]);
    expect(patches[0]?.url).toContain("/channels/99/messages/msg-9");
    expect(patches[0]?.body.components).toEqual([]);
    expect(patches[0]?.body.content).toMatch(/^Allowed via Discord · Yoda · /);
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("ignores an interaction from an unpaired channel", async () => {
    const decided: Array<{ id: string; via?: string; status: string }> = [];
    const callbacks: unknown[] = [];
    const fetchFn = stubFetch({ onCallback: (_url, body) => callbacks.push(body) });
    const store = await bindPairedDesk(decided, fetchFn);
    await discord.handleInteraction(interaction("d:d-oak:deny", "88", "Other"), deps(store, async () => {}, fetchFn));
    expect(callbacks).toEqual([]);
    expect(decided).toEqual([]);
  });

  it("treats yes/no in the paired DM as the pending decision", async () => {
    const decided: Array<{ id: string; via?: string; status: string; reason?: string }> = [];
    const sent: string[] = [];
    const fetchFn = stubFetch({ onSend: (_id, text) => sent.push(text) });
    const store = await bindPairedDesk(decided, fetchFn);
    expect(remote.pendingDraftId("discord")).toBe("d-oak");
    const startTurn = vi.fn(async () => {});
    const wired = deps(store, startTurn, fetchFn);
    await discord.handleInbound(dm("99", "deny", "Sam"), wired);
    expect(decided[0]).toMatchObject({ id: "d-oak", status: "denied", via: "via Discord · Sam" });
    expect(sent.some((text) => /^Denied via Discord · Sam · /.test(text))).toBe(true);
    expect(startTurn).not.toHaveBeenCalled();

    await discord.handleInbound(dm("99", "what's late?", "Sam"), wired);
    expect(startTurn).toHaveBeenCalled();
    const last = store.messagesFor(store.bot("bud")!.threadId).at(-1);
    expect(last).toMatchObject({ text: "[Discord · Sam] what's late?" });
  });
});

