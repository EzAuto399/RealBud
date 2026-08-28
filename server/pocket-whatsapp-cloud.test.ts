import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PocketHandlers } from "./pocket-shared.ts";
import { WhatsAppCloudGateway } from "./pocket-whatsapp-cloud.ts";

const dirs: string[] = [];
const gateways: WhatsAppCloudGateway[] = [];

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.stop()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempState(): string {
  const dir = mkdtempSync(join(tmpdir(), "realbud-whatsapp-pocket-"));
  dirs.push(dir);
  return join(dir, "state.json");
}

function handlers(overrides?: Partial<PocketHandlers>): PocketHandlers {
  return {
    onText: vi.fn(async () => ({ text: "I prepared the safe change." })),
    onDecision: vi.fn(async (_messageId, decision) => decision === "allow" ? "Allowed on RealBud." : "Not allowed on RealBud."),
    onStatus: vi.fn(async () => "RealBud is open and Bud is ready."),
    ...overrides,
  };
}

function graphTransport(options?: { failSend?: boolean }) {
  const sent: Array<Record<string, unknown>> = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({ display_phone_number: "+61 400 000 000", verified_name: "RealBud Pilot" }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    sent.push(body);
    if (options?.failSend) throw new Error("fixture acknowledgement loss");
    return new Response(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: `out-${sent.length}` }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

const ACCESS_TOKEN = `EAA${"x".repeat(80)}`;
const APP_SECRET = "a".repeat(32);
const VERIFY_TOKEN = "realbud_verify_token_123456";
const PHONE_NUMBER_ID = "123456789012345";
const PM_NUMBER = "61412345678";

function config(enabled = true) {
  return {
    enabled,
    pilotReady: true,
    accessToken: ACCESS_TOKEN,
    appSecret: APP_SECRET,
    verifyToken: VERIFY_TOKEN,
    phoneNumberId: PHONE_NUMBER_ID,
    allowedUserId: PM_NUMBER,
  };
}

function inboundBody(options?: { id?: string; from?: string; phoneNumberId?: string; text?: string; buttonId?: string }) {
  const message = options?.buttonId
    ? {
        id: options.id ?? "wamid-1",
        from: options.from ?? PM_NUMBER,
        type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: options.buttonId, title: "Allow" } },
      }
    : {
        id: options?.id ?? "wamid-1",
        from: options?.from ?? PM_NUMBER,
        type: "text",
        text: { body: options?.text ?? "Run the morning check" },
      };
  return {
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: {
      metadata: { phone_number_id: options?.phoneNumberId ?? PHONE_NUMBER_ID },
      messages: [message],
    } }] }],
  };
}

function signedInit(body: unknown, secret = APP_SECRET): RequestInit {
  const raw = JSON.stringify(body);
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
    },
    body: raw,
  };
}

async function configuredGateway(input?: { handlers?: PocketHandlers; stateFile?: string; failSend?: boolean }) {
  const transport = graphTransport({ failSend: input?.failSend });
  const gateway = new WhatsAppCloudGateway({
    handlers: input?.handlers ?? handlers(),
    stateFile: input?.stateFile ?? tempState(),
    fetchImpl: transport.fetchImpl,
    graphBase: "https://graph.test",
    listenPort: 0,
  });
  gateways.push(gateway);
  const status = await gateway.configure(config());
  return { gateway, transport, status, base: `http://127.0.0.1:${status.webhookPort}` };
}

describe("WhatsAppCloudGateway", () => {
  it("stays network- and listener-silent before the named PM pilot gate", async () => {
    const transport = graphTransport();
    const gateway = new WhatsAppCloudGateway({
      handlers: handlers(),
      stateFile: tempState(),
      fetchImpl: transport.fetchImpl,
      listenPort: 0,
    });
    gateways.push(gateway);
    const status = await gateway.configure({ ...config(), pilotReady: false });
    expect(status.state).toBe("pilot-gated");
    expect(transport.fetchImpl).not.toHaveBeenCalled();
  });

  it("does not claim connected until Meta completes the Verify Token handshake", async () => {
    const { gateway, status, base } = await configuredGateway();
    expect(status).toMatchObject({ state: "setup-required", verifiedName: "RealBud Pilot" });
    const denied = await fetch(`${base}/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=hello`);
    expect(denied.status).toBe(403);
    const verified = await fetch(`${base}/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=hello`);
    expect(verified.status).toBe(200);
    expect(await verified.text()).toBe("hello");
    expect(gateway.status()).toMatchObject({ state: "ready" });
    expect(gateway.status().webhookVerifiedAt).toEqual(expect.any(Number));
  });

  it("invalidates an old webhook handshake when its signed binding changes", async () => {
    const { gateway, base } = await configuredGateway();
    const verified = await fetch(`${base}/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=hello`);
    expect(verified.status).toBe(200);
    expect(gateway.status().state).toBe("ready");

    const nextVerifyToken = "realbud_verify_token_654321";
    const next = await gateway.configure({ ...config(), verifyToken: nextVerifyToken });
    expect(next.state).toBe("setup-required");
    expect(next.webhookVerifiedAt).toBeNull();
    const nextBase = `http://127.0.0.1:${next.webhookPort}/whatsapp/webhook`;
    const oldToken = await fetch(`${nextBase}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=old`);
    expect(oldToken.status).toBe(403);
    const newToken = await fetch(`${nextBase}?hub.mode=subscribe&hub.verify_token=${nextVerifyToken}&hub.challenge=new`);
    expect(newToken.status).toBe(200);
    expect(gateway.status().state).toBe("ready");
  });

  it("rejects unsigned payloads before parsing or invoking Ask", async () => {
    const onText = vi.fn(async () => ({ text: "no" }));
    const { base, transport } = await configuredGateway({ handlers: handlers({ onText }) });
    const response = await fetch(`${base}/whatsapp/webhook`, signedInit(inboundBody(), "b".repeat(32)));
    expect(response.status).toBe(401);
    expect(onText).not.toHaveBeenCalled();
    expect(transport.sent).toHaveLength(0);
  });

  it("bounds the raw webhook body before signature verification or JSON parsing", async () => {
    const onText = vi.fn(async () => ({ text: "no" }));
    const { base, transport } = await configuredGateway({ handlers: handlers({ onText }) });
    const raw = "x".repeat(1_000_001);
    const response = await fetch(`${base}/whatsapp/webhook`, {
      method: "POST",
      headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}` },
      body: raw,
    });
    expect(response.status).toBe(413);
    expect(onText).not.toHaveBeenCalled();
    expect(transport.sent).toHaveLength(0);
  });

  it("claims before acknowledgement, routes one exact PM message, and deduplicates provider retries", async () => {
    let release!: (value: { text: string }) => void;
    const pending = new Promise<{ text: string }>((resolve) => { release = resolve; });
    const onText = vi.fn(() => pending);
    const stateFile = tempState();
    const { base, transport } = await configuredGateway({ handlers: handlers({ onText }), stateFile });
    const body = inboundBody();
    const first = await fetch(`${base}/whatsapp/webhook`, signedInit(body));
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("EVENT_RECEIVED");
    expect(onText).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).inbound[0].state).toBe("claimed");

    const duplicate = await fetch(`${base}/whatsapp/webhook`, signedInit(body));
    expect(duplicate.status).toBe(200);
    expect(onText).toHaveBeenCalledTimes(1);
    release({ text: "Done safely." });
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
    expect(transport.sent[0]).toMatchObject({ to: PM_NUMBER, type: "text" });
    const disk = readFileSync(stateFile, "utf8");
    expect(disk).not.toContain("Run the morning check");
    expect(disk).not.toContain(ACCESS_TOKEN);
    expect(JSON.parse(disk).inbound[0].state).toBe("completed");
  });

  it("does not deliver a completed old-channel turn through a reconfigured channel", async () => {
    let release!: (value: { text: string }) => void;
    const pending = new Promise<{ text: string }>((resolve) => { release = resolve; });
    const onText = vi.fn(() => pending);
    const stateFile = tempState();
    const { gateway, base, transport } = await configuredGateway({ handlers: handlers({ onText }), stateFile });
    const response = await fetch(`${base}/whatsapp/webhook`, signedInit(inboundBody({ id: "during-reconfigure" })));
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(onText).toHaveBeenCalledTimes(1));

    const off = await gateway.configure(config(false));
    expect(off.state).toBe("off");
    release({ text: "This old reply must not leave." });
    await vi.waitFor(() => {
      const disk = JSON.parse(readFileSync(stateFile, "utf8")) as { inbound: Array<{ state: string }> };
      expect(disk.inbound[0]?.state).toBe("interrupted");
    });
    expect(transport.sent).toHaveLength(0);
  });

  it("ignores another sender and a payload addressed to another business number", async () => {
    const onText = vi.fn(async () => ({ text: "no" }));
    const { base, transport } = await configuredGateway({ handlers: handlers({ onText }) });
    await fetch(`${base}/whatsapp/webhook`, signedInit(inboundBody({ id: "other-user", from: "61499999999" })));
    await fetch(`${base}/whatsapp/webhook`, signedInit(inboundBody({ id: "other-number", phoneNumberId: "999999999999999" })));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onText).not.toHaveBeenCalled();
    expect(transport.sent).toHaveLength(0);
  });

  it("routes native Allow through the shared decision owner and emits native buttons for a proposal", async () => {
    const actionId = "123e4567-e89b-12d3-a456-426614174000";
    const onText = vi.fn(async () => ({
      text: "Prepared.",
      action: { messageId: actionId, title: "Run morning money", detail: "One run; nothing sends." },
    }));
    const onDecision = vi.fn(async () => "Allowed on RealBud.");
    const { base, transport } = await configuredGateway({ handlers: handlers({ onText, onDecision }) });
    await fetch(`${base}/whatsapp/webhook`, signedInit(inboundBody({ id: "proposal" })));
    await vi.waitFor(() => expect(transport.sent).toHaveLength(2));
    expect(transport.sent[1]).toMatchObject({
      type: "interactive",
      interactive: { body: { text: expect.stringContaining("Why\nOne run; nothing sends.") }, action: { buttons: [
        { reply: { id: `rb:allow:${actionId}`, title: "Allow once" } },
        { reply: { id: `rb:deny:${actionId}` } },
      ] } },
    });
    const approvalBody = JSON.stringify(transport.sent[1]);
    expect(approvalBody).toContain("Permission\\nRun this exact RealBud action one time.");
    expect(approvalBody).toContain("Stops at\\nBud may complete only this request. Nothing else changes.");
    expect(approvalBody).toContain("Future work still needs another Allow.");
    expect(approvalBody).not.toMatch(/always approve|allow automatically/i);

    await fetch(`${base}/whatsapp/webhook`, signedInit(inboundBody({ id: "decision", buttonId: `rb:allow:${actionId}` })));
    await vi.waitFor(() => expect(onDecision).toHaveBeenCalledWith(actionId, "allow"));
    expect(transport.sent.at(-1)).toMatchObject({ type: "text" });
  });

  it("clips a long mobile reason without losing the permission or stopping boundary", async () => {
    const onText = vi.fn(async () => ({
      text: "Prepared.",
      action: {
        messageId: "123e4567-e89b-12d3-a456-426614174001",
        title: "Review a bounded portal case",
        detail: "Observed evidence needs review. ".repeat(200),
        permission: "Prepare this exact case once.",
        boundary: "Prefill only. The PM performs Submit.",
      },
    }));
    const { base, transport } = await configuredGateway({ handlers: handlers({ onText }) });
    await fetch(`${base}/whatsapp/webhook`, signedInit(inboundBody({ id: "long-proposal" })));
    await vi.waitFor(() => expect(transport.sent).toHaveLength(2));
    const interactive = transport.sent[1]?.interactive as { body?: { text?: string } } | undefined;
    const body = interactive?.body?.text ?? "";
    expect(body.length).toBeLessThanOrEqual(1_024);
    expect(body).toContain("Permission\nPrepare this exact case once.");
    expect(body).toContain("Stops at\nPrefill only. The PM performs Submit.");
    expect(body).toContain("Future work still needs another Allow.");
  });

  it("rejects a malformed server action id before any proposal text or button can leave", async () => {
    const onText = vi.fn(async () => ({
      text: "This must not leave.",
      action: { messageId: "a".repeat(49), title: "Invalid fixture", detail: "No effect." },
    }));
    const { base, transport } = await configuredGateway({ handlers: handlers({ onText }) });
    await fetch(`${base}/whatsapp/webhook`, signedInit(inboundBody({ id: "invalid-action" })));
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
    expect(JSON.stringify(transport.sent[0])).toMatch(/could not complete/i);
    expect(JSON.stringify(transport.sent)).not.toContain("This must not leave");
  });

  it("marks a lost outbound acknowledgement effect-unknown without retaining reply text", async () => {
    const stateFile = tempState();
    const { base, gateway } = await configuredGateway({ stateFile, failSend: true });
    await fetch(`${base}/whatsapp/webhook`, signedInit(inboundBody({ id: "uncertain", text: "status" })));
    await vi.waitFor(() => expect(gateway.status().deliveryUncertain).toBe(true));
    const disk = readFileSync(stateFile, "utf8");
    expect(disk).not.toContain("RealBud is open");
    expect(JSON.parse(disk).outbound.at(-1).state).toBe("effect-unknown");
  });

  it("fails closed before contacting Meta when its delivery ledger is corrupt", async () => {
    const stateFile = tempState();
    writeFileSync(stateFile, "{not-json");
    const transport = graphTransport();
    const gateway = new WhatsAppCloudGateway({
      handlers: handlers(),
      stateFile,
      fetchImpl: transport.fetchImpl,
      listenPort: 0,
    });
    gateways.push(gateway);
    const status = await gateway.configure(config());
    expect(status).toMatchObject({ state: "attention", configured: true });
    expect(status.detail).toMatch(/refused the webhook/i);
    expect(transport.fetchImpl).not.toHaveBeenCalled();
  });
});
