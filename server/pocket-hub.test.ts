import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PocketHub } from "./pocket-hub.ts";

const dirs: string[] = [];
const hubs: PocketHub[] = [];

afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.stop()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "realbud-pocket-hub-"));
  dirs.push(dir);
  return dir;
}

function handlers() {
  return {
    onText: vi.fn(async () => ({ text: "Done." })),
    onDecision: vi.fn(async () => "Allowed."),
    onStatus: vi.fn(async () => "Ready."),
  };
}

const telegramFetchMock = vi.fn(async (url: string | URL | Request) => {
  const method = String(url).split("/").at(-1);
  if (method === "getMe") return new Response(JSON.stringify({ ok: true, result: { id: 1, username: "realbud_bot" } }));
  if (method === "deleteWebhook") return new Response(JSON.stringify({ ok: true, result: true }));
  return new Response(JSON.stringify({ ok: true, result: [] }));
});
const telegramFetch = telegramFetchMock as unknown as typeof fetch;

const graphFetchMock = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify({
  display_phone_number: "+61 400 000 000",
  verified_name: "Pilot",
})));
const graphFetch = graphFetchMock as unknown as typeof fetch;

function fullConfig(pilotReady: boolean) {
  return {
    pilotReady,
    telegram: {
      enabled: true,
      token: "123456:abcdefghijklmnopqrstuvwxyz_ABCDEFG",
      allowedUserId: "12345",
    },
    whatsappCloud: {
      enabled: true,
      accessToken: `EAA${"x".repeat(80)}`,
      appSecret: "a".repeat(32),
      verifyToken: "realbud_verify_token_123456",
      phoneNumberId: "123456789012345",
      allowedUserId: "61412345678",
    },
  };
}

describe("PocketHub", () => {
  it("keeps every adapter network-silent behind the shared named-PM gate", async () => {
    telegramFetchMock.mockClear();
    graphFetchMock.mockClear();
    const hub = new PocketHub({
      handlers: handlers(),
      stateDir: stateDir(),
      telegram: { fetchImpl: telegramFetch, autoPoll: false },
      whatsappCloud: { fetchImpl: graphFetch, listenPort: 0 },
    });
    hubs.push(hub);
    const status = await hub.configure(fullConfig(false));
    expect(status).toMatchObject({ provider: "multi-channel", state: "pilot-gated", connectedCount: 0 });
    expect(telegramFetch).not.toHaveBeenCalled();
    expect(graphFetch).not.toHaveBeenCalled();
  });

  it("runs independent adapters while projecting one aggregate connection truth", async () => {
    const hub = new PocketHub({
      handlers: handlers(),
      stateDir: stateDir(),
      telegram: { fetchImpl: telegramFetch, autoPoll: false },
      whatsappCloud: { fetchImpl: graphFetch, listenPort: 0 },
    });
    hubs.push(hub);
    const status = await hub.configure(fullConfig(true));
    expect(status.channels.telegram.state).toBe("ready");
    expect(status.channels.whatsappCloud.state).toBe("setup-required");
    expect(status).toMatchObject({ state: "attention", connectedCount: 1 });

    const wa = status.channels.whatsappCloud;
    const response = await fetch(
      `http://127.0.0.1:${wa.webhookPort}${wa.webhookPath}?hub.mode=subscribe&hub.verify_token=realbud_verify_token_123456&hub.challenge=ok`,
    );
    expect(response.status).toBe(200);
    expect(hub.status()).toMatchObject({ state: "ready", connectedCount: 2 });
  });

  it("accepts a named PM request that arrives on Telegram's first poll", async () => {
    const pocketHandlers = handlers();
    let pollCount = 0;
    const sent: string[] = [];
    const immediateFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split("/").at(-1);
      if (method === "getMe") return new Response(JSON.stringify({ ok: true, result: { id: 1, username: "realbud_bot" } }));
      if (method === "deleteWebhook") return new Response(JSON.stringify({ ok: true, result: true }));
      if (method === "sendMessage") {
        const body = JSON.parse(String(init?.body)) as { text?: string };
        sent.push(body.text ?? "");
        return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length, chat: { id: 12345, type: "private" } } }));
      }
      if (method === "getUpdates" && pollCount++ === 0) {
        return new Response(JSON.stringify({
          ok: true,
          result: [{
            update_id: 1,
            message: {
              message_id: 1,
              from: { id: 12345 },
              chat: { id: 12345, type: "private" },
              text: "What needs attention?",
            },
          }],
        }));
      }
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    }) as unknown as typeof fetch;
    const hub = new PocketHub({
      handlers: pocketHandlers,
      stateDir: stateDir(),
      telegram: { fetchImpl: immediateFetch, autoPoll: true },
      whatsappCloud: { fetchImpl: graphFetch, listenPort: 0 },
    });
    hubs.push(hub);

    await hub.configure({
      pilotReady: true,
      telegram: {
        enabled: true,
        token: "123456:abcdefghijklmnopqrstuvwxyz_ABCDEFG",
        allowedUserId: "12345",
      },
      whatsappCloud: {
        enabled: false,
        accessToken: "",
        appSecret: "",
        verifyToken: "",
        phoneNumberId: "",
        allowedUserId: "",
      },
    });

    await vi.waitFor(() => expect(pocketHandlers.onText).toHaveBeenCalledWith("What needs attention?"));
    await vi.waitFor(() => expect(sent).toContain("Done."));
    expect(sent).not.toContain(expect.stringContaining("reconnecting"));
  });

  it("serializes a WhatsApp decision behind an active Telegram Ask turn", async () => {
    let releaseTurn!: (value: { text: string }) => void;
    const pendingTurn = new Promise<{ text: string }>((resolve) => { releaseTurn = resolve; });
    const onText = vi.fn(() => pendingTurn);
    const onDecision = vi.fn(async () => "Allowed.");
    const pocketHandlers = { ...handlers(), onText, onDecision };
    let pollCount = 0;
    const telegramFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split("/").at(-1);
      if (method === "getMe") return new Response(JSON.stringify({ ok: true, result: { id: 1, username: "realbud_bot" } }));
      if (method === "deleteWebhook") return new Response(JSON.stringify({ ok: true, result: true }));
      if (method === "sendMessage") {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 12345, type: "private" } } }));
      }
      if (method === "getUpdates" && pollCount++ === 0) {
        return new Response(JSON.stringify({
          ok: true,
          result: [{
            update_id: 1,
            message: {
              message_id: 1,
              from: { id: 12345 },
              chat: { id: 12345, type: "private" },
              text: "Prepare the current work",
            },
          }],
        }));
      }
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    }) as unknown as typeof fetch;
    const hub = new PocketHub({
      handlers: pocketHandlers,
      stateDir: stateDir(),
      telegram: { fetchImpl: telegramFetch, autoPoll: true },
      whatsappCloud: { fetchImpl: graphFetch, listenPort: 0 },
    });
    hubs.push(hub);
    const status = await hub.configure(fullConfig(true));
    await vi.waitFor(() => expect(onText).toHaveBeenCalledWith("Prepare the current work"));

    const whatsapp = status.channels.whatsappCloud;
    const base = `http://127.0.0.1:${whatsapp.webhookPort}${whatsapp.webhookPath}`;
    const verification = await fetch(`${base}?hub.mode=subscribe&hub.verify_token=realbud_verify_token_123456&hub.challenge=ok`);
    expect(verification.status).toBe(200);
    const actionId = "123e4567-e89b-12d3-a456-426614174000";
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages", value: {
        metadata: { phone_number_id: "123456789012345" },
        messages: [{
          id: "cross-channel-decision",
          from: "61412345678",
          type: "interactive",
          interactive: { type: "button_reply", button_reply: { id: `rb:allow:${actionId}` } },
        }],
      } }] }],
    });
    const decision = await fetch(base, {
      method: "POST",
      headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", "a".repeat(32)).update(body).digest("hex")}` },
      body,
    });
    expect(decision.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onDecision).not.toHaveBeenCalled();

    releaseTurn({ text: "Prepared." });
    await vi.waitFor(() => expect(onDecision).toHaveBeenCalledWith(actionId, "allow"));
  });
});
