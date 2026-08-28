import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PocketGateway, type PocketHandlers } from "./pocket-gateway.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempState(): string {
  const dir = mkdtempSync(join(tmpdir(), "realbud-pocket-"));
  dirs.push(dir);
  return join(dir, "pocket-state.json");
}

function telegramFetch(batches: unknown[][], options?: { failSend?: boolean }) {
  const sent: Array<Record<string, unknown>> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split("/").at(-1);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (method === "getMe") return new Response(JSON.stringify({ ok: true, result: { id: 7, username: "realbud_test_bot" } }), { status: 200 });
    if (method === "deleteWebhook") return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    if (method === "getUpdates") return new Response(JSON.stringify({ ok: true, result: batches.shift() ?? [] }), { status: 200 });
    if (method === "sendMessage") {
      sent.push(body);
      if (options?.failSend) throw new Error("fixture network failure");
      return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length, chat: { id: 12345, type: "private" } } }), { status: 200 });
    }
    if (method === "answerCallbackQuery" || method === "editMessageReplyMarkup") {
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

function handlers(overrides?: Partial<PocketHandlers>): PocketHandlers {
  return {
    onText: vi.fn(async () => ({ text: "I prepared the safe change." })),
    onDecision: vi.fn(async (_messageId, decision) => decision === "allow" ? "Allowed on RealBud." : "Not allowed on RealBud."),
    onStatus: vi.fn(async () => "RealBud is open and Bud is ready."),
    ...overrides,
  };
}

const TOKEN = "123456:abcdefghijklmnopqrstuvwxyz_ABCDEFG";

describe("PocketGateway", () => {
  it("stays network-silent until a named PM pilot is ready", async () => {
    const transport = telegramFetch([]);
    const gateway = new PocketGateway({
      handlers: handlers(),
      stateFile: tempState(),
      fetchImpl: transport.fetchImpl,
      autoPoll: false,
    });
    const status = await gateway.configure({ enabled: true, pilotReady: false, token: TOKEN, allowedUserId: "12345" });
    expect(status.state).toBe("pilot-gated");
    const startupStatus = await gateway.configure({ enabled: false, pilotReady: false });
    expect(startupStatus.state).toBe("pilot-gated");
    expect(transport.fetchImpl).not.toHaveBeenCalled();
  });

  it("routes one allowlisted private message into Ask and never replays its update", async () => {
    const stateFile = tempState();
    const update = {
      update_id: 41,
      message: { message_id: 3, from: { id: 12345 }, chat: { id: 12345, type: "private" }, text: "Run the morning check" },
    };
    const transport = telegramFetch([[update], [update]]);
    const onText = vi.fn(async () => ({
      text: "I prepared the safe change.",
      action: { messageId: "123e4567-e89b-12d3-a456-426614174000", title: "Run morning money check", detail: "Run once now; nothing sends." },
    }));
    const gateway = new PocketGateway({
      handlers: handlers({ onText }),
      stateFile,
      fetchImpl: transport.fetchImpl,
      autoPoll: false,
      now: () => 1_000,
    });
    expect((await gateway.configure({ enabled: true, pilotReady: true, token: TOKEN, allowedUserId: "12345" })).state).toBe("ready");
    await gateway.pollOnce();
    await gateway.pollOnce();

    expect(onText).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledWith("Run the morning check");
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.text).toContain("Why\nRun once now; nothing sends.");
    expect(transport.sent[0]?.text).toContain("Permission\nRun this exact RealBud action one time.");
    expect(transport.sent[0]?.text).toContain("Stops at\nBud may complete only this request. Nothing else changes.");
    expect(transport.sent[0]?.text).toContain("Future work still needs another Allow.");
    expect(transport.sent[0]?.text).not.toMatch(/always approve|allow automatically/i);
    expect(transport.sent[0]?.reply_markup).toEqual({
      inline_keyboard: [[
        { text: "Allow once", callback_data: "rb:allow:123e4567-e89b-12d3-a456-426614174000" },
        { text: "Not now", callback_data: "rb:deny:123e4567-e89b-12d3-a456-426614174000" },
      ]],
    });
    const disk = readFileSync(stateFile, "utf8");
    expect(disk).not.toContain(TOKEN);
    expect(disk).not.toContain("Run the morning check");
    expect(JSON.parse(disk).nextUpdateId).toBe(42);
  });

  it("ignores every user and group except the exact private PM identity", async () => {
    const batches = [[
      { update_id: 1, message: { message_id: 1, from: { id: 99999 }, chat: { id: 99999, type: "private" }, text: "hello" } },
      { update_id: 2, message: { message_id: 2, from: { id: 12345 }, chat: { id: -10, type: "group" }, text: "hello" } },
    ]];
    const transport = telegramFetch(batches);
    const onText = vi.fn(async () => ({ text: "no" }));
    const gateway = new PocketGateway({ handlers: handlers({ onText }), stateFile: tempState(), fetchImpl: transport.fetchImpl, autoPoll: false });
    await gateway.configure({ enabled: true, pilotReady: true, token: TOKEN, allowedUserId: "12345" });
    await gateway.pollOnce();
    expect(onText).not.toHaveBeenCalled();
    expect(transport.sent).toHaveLength(0);
  });

  it("turns the PM's inline choice into the same manual decision and removes both buttons", async () => {
    const callback = {
      update_id: 9,
      callback_query: {
        id: "callback-1",
        from: { id: 12345 },
        data: "rb:allow:123e4567-e89b-12d3-a456-426614174000",
        message: { message_id: 8, chat: { id: 12345, type: "private" } },
      },
    };
    const transport = telegramFetch([[callback]]);
    const onDecision = vi.fn(async () => "Allowed on RealBud.");
    const gateway = new PocketGateway({ handlers: handlers({ onDecision }), stateFile: tempState(), fetchImpl: transport.fetchImpl, autoPoll: false });
    await gateway.configure({ enabled: true, pilotReady: true, token: TOKEN, allowedUserId: "12345" });
    await gateway.pollOnce();
    expect(onDecision).toHaveBeenCalledWith("123e4567-e89b-12d3-a456-426614174000", "allow");
    expect(transport.fetchImpl).toHaveBeenCalledWith(
      expect.stringMatching(/editMessageReplyMarkup$/),
      expect.objectContaining({ body: expect.stringContaining('"inline_keyboard":[]') }),
    );
    expect(transport.sent.at(-1)?.text).toBe("Allowed on RealBud.");
  });

  it("blocks credentials before they enter Ask", async () => {
    const transport = telegramFetch([[
      { update_id: 3, message: { message_id: 1, from: { id: 12345 }, chat: { id: 12345, type: "private" }, text: "use sk-abcdefghijklmnopqrstuvwxyz1234567890" } },
    ]]);
    const onText = vi.fn(async () => ({ text: "no" }));
    const gateway = new PocketGateway({ handlers: handlers({ onText }), stateFile: tempState(), fetchImpl: transport.fetchImpl, autoPoll: false });
    await gateway.configure({ enabled: true, pilotReady: true, token: TOKEN, allowedUserId: "12345" });
    await gateway.pollOnce();
    expect(onText).not.toHaveBeenCalled();
    expect(String(transport.sent[0]?.text)).toMatch(/credential/i);
  });

  it("rejects an invalid server action id before recording a possible network effect", async () => {
    const stateFile = tempState();
    const transport = telegramFetch([[
      { update_id: 4, message: { message_id: 1, from: { id: 12345 }, chat: { id: 12345, type: "private" }, text: "change something" } },
    ]]);
    const gateway = new PocketGateway({
      handlers: handlers({
        onText: vi.fn(async () => ({
          text: "Prepared.",
          action: { messageId: "a".repeat(49), title: "Invalid fixture", detail: "Must not be sent." },
        })),
      }),
      stateFile,
      fetchImpl: transport.fetchImpl,
      autoPoll: false,
    });
    await gateway.configure({ enabled: true, pilotReady: true, token: TOKEN, allowedUserId: "12345" });
    await gateway.pollOnce();

    expect(transport.sent).toHaveLength(1);
    expect(String(transport.sent[0]?.text)).toMatch(/could not complete/i);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).outbound.every((item: { state: string }) => item.state === "delivered")).toBe(true);
    expect(gateway.status().deliveryUncertain).toBe(false);
  });

  it("recovers claimed work as interrupted and never silently replays it", async () => {
    const stateFile = tempState();
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      nextUpdateId: 8,
      inbound: [{ updateId: 7, kind: "message", state: "claimed", at: 10 }],
      outbound: [],
    }));
    const transport = telegramFetch([]);
    const onText = vi.fn(async () => ({ text: "no" }));
    const gateway = new PocketGateway({ handlers: handlers({ onText }), stateFile, fetchImpl: transport.fetchImpl, autoPoll: false });
    await gateway.configure({ enabled: true, pilotReady: true, token: TOKEN, allowedUserId: "12345" });
    expect(onText).not.toHaveBeenCalled();
    expect(String(transport.sent[0]?.text)).toMatch(/not replayed/i);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).inbound[0].state).toBe("interrupted");
  });

  it("fails closed without touching Telegram when its delivery ledger is corrupt", async () => {
    const stateFile = tempState();
    writeFileSync(stateFile, "{not-json");
    const transport = telegramFetch([]);
    const gateway = new PocketGateway({ handlers: handlers(), stateFile, fetchImpl: transport.fetchImpl, autoPoll: false });

    const status = await gateway.configure({ enabled: true, pilotReady: true, token: TOKEN, allowedUserId: "12345" });

    expect(status).toMatchObject({ state: "attention", enabled: true, configured: true });
    expect(status.detail).toMatch(/refused to poll/i);
    expect(transport.fetchImpl).not.toHaveBeenCalled();
  });

  it("marks an unacknowledged outbound send effect-unknown without retaining its text", async () => {
    const stateFile = tempState();
    const transport = telegramFetch([[
      { update_id: 5, message: { message_id: 1, from: { id: 12345 }, chat: { id: 12345, type: "private" }, text: "/status" } },
    ]], { failSend: true });
    const gateway = new PocketGateway({ handlers: handlers(), stateFile, fetchImpl: transport.fetchImpl, autoPoll: false });
    await gateway.configure({ enabled: true, pilotReady: true, token: TOKEN, allowedUserId: "12345" });
    await gateway.pollOnce();
    expect(gateway.status()).toMatchObject({ state: "attention", deliveryUncertain: true });
    const disk = readFileSync(stateFile, "utf8");
    expect(disk).not.toContain("RealBud is open");
    expect(JSON.parse(disk).outbound.at(-1).state).toBe("effect-unknown");
  });
});
