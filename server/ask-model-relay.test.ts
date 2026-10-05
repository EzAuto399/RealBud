/** Ask's loopback model relay: the office key stays in RealBud, the office's
 * reasoning effort reaches the wire, and the worker holds only a relay token.
 * Fake upstreams on loopback only; all values fictional. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { existsSync, chmodSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { windowsAdmissionTimeout } from "./testing/private-fixture.ts";

vi.mock("./managed-service.ts", async (original) => ({
  ...await original<typeof import("./managed-service.ts")>(),
  managedService: { assertCapability: vi.fn() },
}));

vi.mock("./office-link.ts", async (original) => ({
  ...await original<typeof import("./office-link.ts")>(),
  noteModelKeyAnswer: vi.fn(),
}));

import { noteModelKeyAnswer } from "./office-link.ts";
import { applyPropertyPack, propertyProfileDir } from "./hermes-pack.ts";
import { MANAGED_ACCESS_MISMATCH, MANAGED_ACCESS_WITHDRAWN, setWorkerModelAccessSnapshot } from "./hermes-runtime-env.ts";
import { setWorkerModelGrant } from "./worker-model-access.ts";
import { productAskFailure } from "./ask-book.ts";
import { ASK_MODEL_RELAY_UNAVAILABLE, applyAskModelRelayEnv, createAskModelRelayLease, startAskModelRelay, withAskModelRelayLease, type AskModelRelay, type AskModelRelayLease } from "./ask-model-relay.ts";
import { HermesAgentDriver } from "./drivers/acp/hermes.ts";
import { recordEvents } from "./testing/events.ts";
import { clearManagedAccess, FICTIONAL_GRANTED_KEY, grantManagedAccess } from "./testing/managed-grant.ts";
import { privateFixtureRoot } from "./testing/private-profile-fixture.ts";
import { MANAGED_MODEL_CHOICES, type ManagedModelChoiceId } from "../shared/managed-model-choices.ts";

type Seen = { method: string; url: string; headers: IncomingHttpHeaders; body: Record<string, unknown>; closed: Promise<boolean> };
type Upstream = { url: string; seen: Seen[]; server: Server };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  clearManagedAccess();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function home(): string {
  const root = privateFixtureRoot(join(tmpdir(), "realbud-ask-relay-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  applyPropertyPack(root);
  return root;
}

/** A fictional gateway on loopback. `reply` answers each request. */
async function upstream(reply: (response: ServerResponse, seen: Seen) => void | Promise<void>): Promise<Upstream> {
  const seen: Seen[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    // True when the relay hung up before this response finished.
    const closed = new Promise<boolean>(done => response.once("close", () => done(!response.writableFinished)));
    const raw = Buffer.concat(chunks).toString("utf8");
    const entry: Seen = { method: request.method ?? "", url: request.url ?? "", headers: request.headers, body: raw ? JSON.parse(raw) : {}, closed };
    seen.push(entry);
    await reply(response, entry);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  cleanups.push(() => { server.closeAllConnections(); return new Promise<void>(done => server.close(() => done())); });
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}/v1`, seen, server };
}

const json = (body: unknown) => (response: ServerResponse) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

/** One execution's launch: a live lease (revoked at cleanup) and the env it applied. */
function leasedLaunch(root: string, lease: AskModelRelayLease = createAskModelRelayLease()): { refusal: string | null; env: NodeJS.ProcessEnv; lease: AskModelRelayLease } {
  cleanups.push(() => lease.revoke());
  const env: NodeJS.ProcessEnv = {};
  const refusal = lease.run(() => applyAskModelRelayEnv(env, root));
  return { refusal, env, lease };
}

async function relayFor(root: string, opts: { maxRequestBytes?: number; timeoutMs?: number; idleTimeoutMs?: number; serviceFailure?: () => string | null } = {}): Promise<{ relay: AskModelRelay; token: string; overlayDir: string; lease: AskModelRelayLease }> {
  const overlayDir = join(root, "relay-overlay");
  const relay = await startAskModelRelay({ root, overlayDir, serviceFailure: opts.serviceFailure ?? (() => null), ...opts });
  cleanups.push(() => relay.close());
  const { refusal, env, lease } = leasedLaunch(root);
  expect(refusal).toBeNull();
  return { relay, token: env.REALBUD_MODEL_API_KEY!, overlayDir, lease };
}

function post(relay: AskModelRelay, body: unknown, token: string | null, extra: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
  return fetch(`${relay.url}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...extra },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal,
  });
}

const messages = [{ role: "user", content: "fictional question" }];
const choiceOf = (id: ManagedModelChoiceId) => MANAGED_MODEL_CHOICES.find(choice => choice.id === id)!;

describe("Ask model relay", () => {
  it.each(MANAGED_MODEL_CHOICES.map(choice => choice.id))("sends the office key and %s's reasoning effort upstream", async (id) => {
    const root = home(), gateway = await upstream(json({ id: "fictional-completion", choices: [] }));
    grantManagedAccess(root, { baseUrl: gateway.url, choice: id });
    const { relay, token } = await relayFor(root);
    const response = await post(relay, { model: choiceOf(id).model, messages }, token);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ id: "fictional-completion", choices: [] });
    expect(gateway.seen).toHaveLength(1);
    const [request] = gateway.seen;
    expect(request!.url).toBe("/v1/chat/completions");
    expect(request!.body).toEqual({ model: choiceOf(id).model, messages, reasoning_effort: choiceOf(id).effort });
    expect(request!.headers.authorization).toBe(`Bearer ${FICTIONAL_GRANTED_KEY}`);
    expect(request!.headers["idempotency-key"]).toMatch(/^realbud-ask-[0-9a-f]{48}$/);
    expect(token).not.toBe(FICTIONAL_GRANTED_KEY);
  });

  it("replaces whatever effort the worker sent with the office's choice", async () => {
    const root = home(), gateway = await upstream(json({}));
    grantManagedAccess(root, { baseUrl: gateway.url, choice: "flash-high" });
    const { relay, token } = await relayFor(root);
    // Flash refuses `xhigh`/`max` upstream; the relay never forwards them.
    for (const effort of ["max", "xhigh", "low", null]) {
      expect((await post(relay, { model: "deepseek-v4.1-flash", messages, reasoning_effort: effort }, token)).status).toBe(200);
    }
    expect(gateway.seen.map(request => request.body.reasoning_effort)).toEqual(["high", "high", "high", "high"]);
  });

  it("requires the relay token and forwards no probe as chat", async () => {
    const root = home(), gateway = await upstream(json({}));
    grantManagedAccess(root, { baseUrl: gateway.url });
    const { relay, token } = await relayFor(root);
    const body = { model: "deepseek-v4.1-flash", messages };
    expect((await post(relay, body, null)).status).toBe(401);
    expect((await post(relay, body, `${token}0`)).status).toBe(401);
    // The office key itself is not a relay credential.
    expect((await post(relay, body, FICTIONAL_GRANTED_KEY)).status).toBe(401);
    expect((await fetch(`${relay.url}/api/tags`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
    expect((await fetch(`${relay.url}/api/show`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" })).status).toBe(404);
    expect(gateway.seen).toHaveLength(0);
  });

  it("refuses a model other than the office's choice, and unreadable or oversized bodies", async () => {
    const root = home(), gateway = await upstream(json({}));
    grantManagedAccess(root, { baseUrl: gateway.url, choice: "flash-high" });
    const { relay, token } = await relayFor(root, { maxRequestBytes: 4_096 });
    const refused = await post(relay, { model: "claude-sonnet-5.5", messages }, token);
    expect(refused.status).toBe(400);
    expect(JSON.stringify(await refused.json())).toContain("model other than the one chosen");
    expect((await post(relay, { messages }, token)).status).toBe(400);
    expect((await post(relay, "[1,2]", token)).status).toBe(400);
    expect((await post(relay, "not json", token)).status).toBe(400);
    expect((await post(relay, { model: "deepseek-v4.1-flash", messages, stream: "yes" }, token)).status).toBe(400);
    expect((await post(relay, { model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "x".repeat(8_192) }] }, token)).status).toBe(413);
    expect(gateway.seen).toHaveLength(0);
  });

  it("relays streamed chunks in order as they arrive", async () => {
    let release!: () => void;
    const released = new Promise<void>(done => { release = done; });
    const events = ["{\"n\":1}", "{\"n\":2}", "{\"n\":3}"].map(data => `data: ${data}\n\n`);
    const gateway = await upstream(async (response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(events[0]);
      // The rest only after the worker has seen the first event: nothing is buffered.
      await released;
      response.write(events[1]); response.write(events[2]); response.end("data: [DONE]\n\n");
    });
    const root = home();
    grantManagedAccess(root, { baseUrl: gateway.url, choice: "sonnet-xhigh" });
    const { relay, token } = await relayFor(root);
    const response = await post(relay, { model: "claude-sonnet-5.5", messages, stream: true }, token, { accept: "text/event-stream" });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader(), decoder = new TextDecoder();
    let text = "";
    while (!text.includes("\n\n")) text += decoder.decode((await reader.read()).value, { stream: true });
    expect(text).toBe(events[0]);
    release();
    for (let part = await reader.read(); !part.done; part = await reader.read()) text += decoder.decode(part.value, { stream: true });
    expect(text).toBe(`${events.join("")}data: [DONE]\n\n`);
    expect(gateway.seen[0]!.body).toMatchObject({ stream: true, reasoning_effort: "xhigh" });
    expect(gateway.seen[0]!.headers.accept).toBe("text/event-stream");
  });

  it("stops the upstream exchange when the worker hangs up", async () => {
    const gateway = await upstream((response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: {\"n\":1}\n\n"); // then hold the stream open
    });
    const root = home();
    grantManagedAccess(root, { baseUrl: gateway.url });
    const { relay, token } = await relayFor(root);
    const worker = new AbortController();
    const response = await post(relay, { model: "deepseek-v4.1-flash", messages, stream: true }, token, {}, worker.signal);
    await response.body!.getReader().read();
    worker.abort();
    await expect(gateway.seen[0]!.closed).resolves.toBe(true);
  });

  it("times out a stalled upstream", async () => {
    const gateway = await upstream(() => { /* never answers */ });
    const root = home();
    grantManagedAccess(root, { baseUrl: gateway.url });
    const { relay, token } = await relayFor(root, { timeoutMs: 200 });
    expect((await post(relay, { model: "deepseek-v4.1-flash", messages }, token)).status).toBe(504);
    await expect(gateway.seen[0]!.closed).resolves.toBe(true);
  });

  // Windows: the private setup alone costs several PowerShell launches.
  it("ends a stream that stops arriving with an error event, and stops the upstream", { timeout: 5_000, ...windowsAdmissionTimeout(30) }, async () => {
    const gateway = await upstream((response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: {\"n\":1}\n\n"); // then nothing, connection held open
    });
    const root = home();
    grantManagedAccess(root, { baseUrl: gateway.url });
    const { relay, token } = await relayFor(root, { idleTimeoutMs: 200 });
    const response = await post(relay, { model: "deepseek-v4.1-flash", messages, stream: true }, token);
    const text = await response.text();
    expect(text.startsWith("data: {\"n\":1}\n\n")).toBe(true);
    expect(text).toContain("The AI service stopped sending its answer.");
    await expect(gateway.seen[0]!.closed).resolves.toBe(true);
  });

  it("keeps one idempotency key across an SDK retry of the same body, and a new one for a new request", async () => {
    const root = home(), gateway = await upstream(json({}));
    grantManagedAccess(root, { baseUrl: gateway.url });
    const { relay, token } = await relayFor(root);
    const body = { model: "deepseek-v4.1-flash", messages };
    await post(relay, body, token, { "x-stainless-retry-count": "0" });
    await post(relay, body, token, { "x-stainless-retry-count": "1" });
    await post(relay, body, token, { "x-stainless-retry-count": "0" });
    const keys = gateway.seen.map(request => request.headers["idempotency-key"]);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("re-checks the grant and entitlement on every request", async () => {
    const root = home(), gateway = await upstream(json({}));
    grantManagedAccess(root, { baseUrl: gateway.url });
    let entitlement: string | null = null;
    const { relay, token } = await relayFor(root, { serviceFailure: () => entitlement });
    const body = { model: "deepseek-v4.1-flash", messages };
    expect((await post(relay, body, token)).status).toBe(200);
    entitlement = "Fictional service hold.";
    expect((await post(relay, body, token)).status).toBe(503);
    entitlement = null;
    setWorkerModelGrant({ state: "withdrawn" });
    const withdrawn = await post(relay, body, token);
    expect(withdrawn.status).toBe(503);
    expect(JSON.stringify(await withdrawn.json())).toContain(MANAGED_ACCESS_WITHDRAWN);
    expect(gateway.seen).toHaveLength(1);
  });

  it("reads an old or redirected profile as needing Repair, at launch and per request", async () => {
    const root = home(), gateway = await upstream(json({}));
    grantManagedAccess(root, { baseUrl: gateway.url });
    const { relay, token } = await relayFor(root);
    const config = join(propertyProfileDir(root), "config.yaml");
    // The pre-29-Sep profile, before the managed provider existed.
    writeFileSync(config, readFileSync(config, "utf8").replace(/^model:\n(?:[ \t].*\n)*/m, "").replace(/^providers:\n(?:[ \t].*\n)*/m, "")
      + `model:\n  default: auto\n  provider: openai-api\n  base_url: "${gateway.url}"\n  api_mode: chat_completions\n`);
    const env: NodeJS.ProcessEnv = {};
    expect(applyAskModelRelayEnv(env, root)).toBe(MANAGED_ACCESS_MISMATCH);
    expect(env).toEqual({});
    const refused = await post(relay, { model: "auto", messages }, token);
    expect(refused.status).toBe(503);
    expect(JSON.stringify(await refused.json())).toContain("Repair Bud");
    expect(gateway.seen).toHaveLength(0);
  });

  it("refuses an Ask launch when this process runs no relay for that Hermes home", async () => {
    const root = home(), other = home();
    grantManagedAccess(root);
    expect(applyAskModelRelayEnv({}, root)).toBe(ASK_MODEL_RELAY_UNAVAILABLE);
    const relay = await startAskModelRelay({ root: other, overlayDir: join(other, "relay-overlay"), serviceFailure: () => null });
    cleanups.push(() => relay.close());
    expect(applyAskModelRelayEnv({}, root)).toBe(ASK_MODEL_RELAY_UNAVAILABLE);
    await relay.close();
    grantManagedAccess(other);
    expect(applyAskModelRelayEnv({}, other)).toBe(ASK_MODEL_RELAY_UNAVAILABLE);
    // Ask shows exactly this sentence, not the generic failure copy.
    expect(productAskFailure(`Error: ${ASK_MODEL_RELAY_UNAVAILABLE}`)).toBe(ASK_MODEL_RELAY_UNAVAILABLE);
  });
});

describe("Ask model relay throttling", () => {
  it("forwards the AI service's 429 wait as bounded whole seconds, and drops a malformed one", async () => {
    const waits = ["7", "3600", new Date(Date.now() + 30_000).toUTCString(), "soon", "-5", "1e3", "99999999999", "Thu, 99 Foo 2026 00:00:00 GMT", null];
    const gateway: Upstream = await upstream((response) => {
      const wait = waits[gateway.seen.length - 1];
      response.writeHead(429, { "content-type": "application/json", ...(wait === null || wait === undefined ? {} : { "retry-after": wait }) });
      response.end(JSON.stringify({ error: { message: "fictional rate limit" } }));
    });
    const root = home();
    grantManagedAccess(root, { baseUrl: gateway.url });
    const { relay, token } = await relayFor(root);
    const seen: Array<string | null> = [];
    for (let i = 0; i < waits.length; i++) {
      const response = await post(relay, { model: "deepseek-v4.1-flash", messages }, token);
      expect(response.status).toBe(429);
      seen.push(response.headers.get("retry-after"));
    }
    expect(seen[0]).toBe("7");
    expect(seen[1]).toBe("60");
    // An HTTP date 30 s ahead; slow runners spend some of it before the relay reads it.
    expect(Number(seen[2])).toBeGreaterThanOrEqual(15);
    expect(Number(seen[2])).toBeLessThanOrEqual(30);
    expect(seen.slice(3)).toEqual([null, null, null, null, null, null]);
  });
});

describe("Ask model relay grant withdrawal", () => {
  const streaming = (hold: Promise<void>) => async (response: ServerResponse) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: {\"n\":1}\n\n");
    await hold;
    response.end("data: [DONE]\n\n");
  };

  it("ends a streaming exchange the moment the grant is withdrawn", async () => {
    const gateway = await upstream(streaming(new Promise(() => {})));
    const root = home();
    grantManagedAccess(root, { baseUrl: gateway.url });
    const { relay, token } = await relayFor(root);
    const response = await post(relay, { model: "deepseek-v4.1-flash", messages, stream: true }, token);
    const reader = response.body!.getReader();
    await reader.read();
    // The composition's withdraw order: the snapshot is emptied first.
    setWorkerModelAccessSnapshot({});
    setWorkerModelGrant({ state: "withdrawn" });
    await expect(gateway.seen[0]!.closed).resolves.toBe(true);
    await expect((async () => { for (;;) if ((await reader.read()).done) return "ended cleanly"; })()).rejects.toThrow();
  });

  it("refuses with the withdrawal sentence when it lands before the AI service answers", async () => {
    const gateway = await upstream(() => { /* holds the headers */ });
    const root = home();
    grantManagedAccess(root, { baseUrl: gateway.url });
    const { relay, token } = await relayFor(root);
    const pending = post(relay, { model: "deepseek-v4.1-flash", messages }, token);
    await vi.waitFor(() => expect(gateway.seen).toHaveLength(1));
    setWorkerModelGrant({ state: "withdrawn" });
    setWorkerModelAccessSnapshot({});
    const refused = await pending;
    expect(refused.status).toBe(503);
    expect(JSON.stringify(await refused.json())).toContain(MANAGED_ACCESS_WITHDRAWN);
    await expect(gateway.seen[0]!.closed).resolves.toBe(true);
  });

  it("ends only exchanges on a replaced key; one on the current key carries on", async () => {
    let release!: () => void;
    const released = new Promise<void>(done => { release = done; });
    const gateway = await upstream(streaming(released));
    const root = home();
    grantManagedAccess(root, { baseUrl: gateway.url });
    const { relay, token } = await relayFor(root);
    const body = { model: "deepseek-v4.1-flash", messages, stream: true };
    const old = await post(relay, body, token);
    await old.body!.getReader().read();
    grantManagedAccess(root, { baseUrl: gateway.url, key: "fictional-granted-key-2" });
    await expect(gateway.seen[0]!.closed).resolves.toBe(true);

    const current = await post(relay, body, token);
    expect(gateway.seen[1]!.headers.authorization).toBe("Bearer fictional-granted-key-2");
    // A refresh that republishes the same key leaves its exchange alone.
    setWorkerModelAccessSnapshot({ REALBUD_MODEL_API_KEY: "fictional-granted-key-2" });
    release();
    expect(await current.text()).toBe("data: {\"n\":1}\n\ndata: [DONE]\n\n");
    await expect(gateway.seen[1]!.closed).resolves.toBe(false);
  });
});

describe("Ask model relay execution leases", () => {
  const body = { model: "deepseek-v4.1-flash", messages };
  const held = (hold: Promise<void>) => async (response: ServerResponse) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: {\"n\":1}\n\n");
    await hold;
    response.end("data: [DONE]\n\n");
  };

  it("refuses a launch outside a live lease, and mints no token for a revoked one", async () => {
    const root = home(), gateway = await upstream(json({}));
    grantManagedAccess(root, { baseUrl: gateway.url });
    await relayFor(root);
    const bare: NodeJS.ProcessEnv = {};
    expect(applyAskModelRelayEnv(bare, root)).toBe(ASK_MODEL_RELAY_UNAVAILABLE);
    expect(bare).toEqual({});
    const lease = createAskModelRelayLease();
    lease.revoke();
    expect(leasedLaunch(root, lease).refusal).toBe(ASK_MODEL_RELAY_UNAVAILABLE);
  });

  it("stops accepting a token once its execution completes", async () => {
    const root = home(), gateway = await upstream(json({}));
    grantManagedAccess(root, { baseUrl: gateway.url });
    const { relay } = await relayFor(root);
    let token = "";
    await withAskModelRelayLease(async () => {
      const env: NodeJS.ProcessEnv = {};
      expect(applyAskModelRelayEnv(env, root)).toBeNull();
      token = env.REALBUD_MODEL_API_KEY!;
      expect((await post(relay, body, token)).status).toBe(200);
    });
    expect((await post(relay, body, token)).status).toBe(401);
    expect((await fetch(`${relay.url}/models`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    expect(gateway.seen).toHaveLength(1);
  });

  it("stops accepting a token after its execution errors", async () => {
    const root = home(), gateway = await upstream(json({}));
    grantManagedAccess(root, { baseUrl: gateway.url });
    const { relay } = await relayFor(root);
    let token = "";
    await expect(withAskModelRelayLease(async () => {
      const env: NodeJS.ProcessEnv = {};
      applyAskModelRelayEnv(env, root);
      token = env.REALBUD_MODEL_API_KEY!;
      throw new Error("fictional worker failure");
    })).rejects.toThrow("fictional worker failure");
    expect((await post(relay, body, token)).status).toBe(401);
    expect(gateway.seen).toHaveLength(0);
  });

  it("on Stop, refuses the token and aborts its exchange in flight", async () => {
    const gateway = await upstream(held(new Promise(() => {})));
    const root = home();
    grantManagedAccess(root, { baseUrl: gateway.url });
    const { relay } = await relayFor(root);
    const stop = new AbortController();
    const { env } = leasedLaunch(root, createAskModelRelayLease({ signal: stop.signal }));
    const token = env.REALBUD_MODEL_API_KEY!;
    const response = await post(relay, { ...body, stream: true }, token);
    await response.body!.getReader().read();
    stop.abort();
    await expect(gateway.seen[0]!.closed).resolves.toBe(true);
    expect((await post(relay, body, token)).status).toBe(401);
  });

  it("gives each execution its own token; a released one cannot serve another, and a live one carries on", async () => {
    let release!: () => void;
    const released = new Promise<void>(done => { release = done; });
    const gateway = await upstream((response, seen) => seen.body.stream ? held(released)(response) : json({})(response));
    const root = home();
    grantManagedAccess(root, { baseUrl: gateway.url });
    const { relay } = await relayFor(root);
    const first = leasedLaunch(root), second = leasedLaunch(root);
    const firstToken = first.env.REALBUD_MODEL_API_KEY!, secondToken = second.env.REALBUD_MODEL_API_KEY!;
    expect(firstToken).not.toBe(secondToken);
    // A second launch inside the same execution reuses its token.
    expect(leasedLaunch(root, first.lease).env.REALBUD_MODEL_API_KEY).toBe(firstToken);

    const live = await post(relay, { ...body, stream: true }, secondToken);
    first.lease.revoke();
    expect((await post(relay, body, firstToken)).status).toBe(401);
    expect(leasedLaunch(root, first.lease).refusal).toBe(ASK_MODEL_RELAY_UNAVAILABLE);
    expect((await post(relay, body, secondToken)).status).toBe(200);
    release();
    expect(await live.text()).toBe("data: {\"n\":1}\n\ndata: [DONE]\n\n");
    await expect(gateway.seen[0]!.closed).resolves.toBe(false);
  });
});

describe("Ask model relay request shape", () => {
  it("drops second reasoning channels, sends one completion, and clamps output to the model's ceiling", async () => {
    const root = home(), gateway = await upstream((response, seen) => seen.method === "GET" ? modelvia(response, seen) : json({})(response));
    grantManagedAccess(root, { baseUrl: gateway.url, choice: "flash-high" });
    const { relay, token } = await relayFor(root);
    const send = (extra: Record<string, unknown>) => post(relay, { model: "deepseek-v4.1-flash", messages, ...extra }, token);
    expect((await send({ reasoning: { effort: "max" }, extra_body: { reasoning_effort: "max" }, n: 3, max_tokens: 999_999, max_completion_tokens: 50_000 })).status).toBe(200);
    // Before the gateway's listing has been read: the smallest published ceiling.
    expect(gateway.seen[0]!.body).toEqual({ model: "deepseek-v4.1-flash", messages, reasoning_effort: "high", n: 1, max_tokens: 32_000, max_completion_tokens: 32_000 });
    expect((await fetch(`${relay.url}/models`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await send({ max_tokens: 100_000 })).status).toBe(200);
    expect((await send({ max_tokens: 500_000.7 })).status).toBe(200);
    expect(gateway.seen.filter(request => request.method === "POST").slice(1).map(request => request.body.max_tokens)).toEqual([100_000, 131_072]);
    for (const bad of [{ n: "2" }, { n: 0 }, { max_tokens: 0 }, { max_tokens: "100" }, { max_completion_tokens: -1 }]) {
      expect((await send(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(gateway.seen).toHaveLength(4);
  });
});

describe("Ask model relay under Hermes 0.21.5", () => {
  // 0.21.5 ACP sends the profile's effort itself, and its custom provider sends
  // `medium` when none is set (plugins/model-providers/custom default_reasoning_config).
  it("keeps exactly one effort field, the office's, whatever the worker sent", async () => {
    const root = home(), gateway = await upstream(json({}));
    grantManagedAccess(root, { baseUrl: gateway.url, choice: "sonnet-xhigh" });
    const { relay, token } = await relayFor(root);
    for (const extra of [{ reasoning_effort: "medium" }, { reasoning_effort: "xhigh" }, { reasoning_effort: "none" }, {}]) {
      expect((await post(relay, { model: "claude-sonnet-5.5", messages, ...extra, reasoning: { effort: "medium" } }, token)).status).toBe(200);
    }
    for (const request of gateway.seen) {
      expect(Object.keys(request.body).filter(key => /reason|extra_body/.test(key))).toEqual(["reasoning_effort"]);
      expect(request.body.reasoning_effort).toBe("xhigh");
    }
  });

  // Chat-completions sanitization in 0.21.5 strips `reasoning_details` before
  // the request leaves Hermes (agent/transports/chat_completions.py). Whatever
  // replay fields do arrive, the relay must pass the loop through untouched.
  // Whether Modelvia still accepts the replay is a separate live test.
  it("passes a multi-turn tool loop through intact apart from the effort", async () => {
    const root = home(), gateway = await upstream(json({}));
    grantManagedAccess(root, { baseUrl: gateway.url, choice: "sonnet-high" });
    const { relay, token } = await relayFor(root);
    const loop = {
      model: "claude-sonnet-5.5",
      stream: true,
      stream_options: { include_usage: true },
      tools: [{ type: "function", function: { name: "read_file", description: "Read a fictional file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }],
      messages: [
        { role: "system", content: "Fictional office instructions." },
        { role: "user", content: "Summarize /synthetic/ledger.csv" },
        { role: "assistant", content: null, reasoning_content: "Need the file first.",
          reasoning_details: [{ type: "reasoning.text", text: "Need the file first.", signature: "fictional-signature" }],
          tool_calls: [{ id: "call_fictional_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"/synthetic/ledger.csv\"}" } }] },
        { role: "tool", tool_call_id: "call_fictional_1", content: "date,amount\n2026-09-01,100" },
        { role: "assistant", content: "One row of 100.", reasoning_content: "Done." },
        { role: "user", content: [{ type: "text", text: "And the total?" }] },
      ],
      reasoning_effort: "medium",
    };
    expect((await post(relay, loop, token, { accept: "text/event-stream" })).status).toBe(200);
    expect(gateway.seen).toHaveLength(1);
    expect(gateway.seen[0]!.body).toEqual({ ...loop, reasoning_effort: "high" });
  });
});

describe.skipIf(process.platform === "win32")("Ask model relay overlay integrity", () => {
  const tampering: Array<[string, (dir: string) => void]> = [
    ["policy written into the overlay", dir => {
      chmodSync(dir, 0o700); chmodSync(join(dir, "config.yaml"), 0o600);
      writeFileSync(join(dir, "config.yaml"), "approvals:\n  mode: \"off\"\n");
      chmodSync(join(dir, "config.yaml"), 0o400); chmodSync(dir, 0o500);
    }],
    ["a managed .env added beside it", dir => { chmodSync(dir, 0o700); writeFileSync(join(dir, ".env"), "FICTIONAL_FLAG=1\n"); chmodSync(dir, 0o500); }],
    ["the overlay made writable", dir => chmodSync(join(dir, "config.yaml"), 0o600)],
    ["the folder made writable", dir => chmodSync(dir, 0o700)],
  ];

  it("writes the overlay read-only, holding only config.yaml", async () => {
    const root = home(), gateway = await upstream(json({}));
    grantManagedAccess(root, { baseUrl: gateway.url });
    const { overlayDir } = await relayFor(root);
    expect(readdirSync(overlayDir)).toEqual(["config.yaml"]);
    expect(statSync(overlayDir).mode & 0o777).toBe(0o500);
    expect(statSync(join(overlayDir, "config.yaml")).mode & 0o777).toBe(0o400);
  });

  it.each(tampering)("refuses every request until restart and retires the workers after %s", async (_name, tamper) => {
    const root = home(), gateway = await upstream((response, seen) => seen.method === "GET" ? modelvia(response, seen) : json({})(response));
    grantManagedAccess(root, { baseUrl: gateway.url });
    const onTamper = vi.fn();
    const overlayDir = join(root, "relay-overlay");
    const relay = await startAskModelRelay({ root, overlayDir, serviceFailure: () => null, onTamper });
    cleanups.push(() => relay.close());
    const { refusal, env } = leasedLaunch(root);
    expect(refusal).toBeNull();
    const token = env.REALBUD_MODEL_API_KEY!;
    const body = { model: "deepseek-v4.1-flash", messages };
    expect((await post(relay, body, token)).status).toBe(200);

    tamper(overlayDir);
    const refused = await post(relay, body, token);
    expect(refused.status).toBe(503);
    expect(JSON.stringify(await refused.json())).toContain(ASK_MODEL_RELAY_UNAVAILABLE);
    expect(onTamper).toHaveBeenCalledTimes(1);
    expect((await fetch(`${relay.url}/models`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(503);
    // Putting things back does not reopen it, and no new worker is launched.
    removeAndRewrite(overlayDir, relay.url);
    expect((await post(relay, body, token)).status).toBe(503);
    expect(leasedLaunch(root).refusal).toBe(ASK_MODEL_RELAY_UNAVAILABLE);
    expect(onTamper).toHaveBeenCalledTimes(1);
    expect(gateway.seen).toHaveLength(1);
  });

  it("refuses the launch itself when the overlay changed before any request", async () => {
    const root = home(), gateway = await upstream(json({}));
    grantManagedAccess(root, { baseUrl: gateway.url });
    const onTamper = vi.fn();
    const overlayDir = join(root, "relay-overlay");
    const relay = await startAskModelRelay({ root, overlayDir, serviceFailure: () => null, onTamper });
    cleanups.push(() => relay.close());
    tampering[1]![1](overlayDir);
    const { refusal, env } = leasedLaunch(root);
    expect(refusal).toBe(ASK_MODEL_RELAY_UNAVAILABLE);
    expect(env).toEqual({});
    expect(onTamper).toHaveBeenCalledTimes(1);
  });

  it("starts from a fresh folder, dropping anything an earlier process or worker left", async () => {
    const root = home(), gateway = await upstream(json({}));
    grantManagedAccess(root, { baseUrl: gateway.url });
    const overlayDir = join(root, "relay-overlay");
    const first = await startAskModelRelay({ root, overlayDir, serviceFailure: () => null });
    tampering[1]![1](overlayDir);
    // An unclean exit leaves the folder; the next start replaces it.
    const second = await startAskModelRelay({ root, overlayDir, serviceFailure: () => null });
    cleanups.push(() => second.close(), () => first.close());
    expect(readdirSync(overlayDir)).toEqual(["config.yaml"]);
    expect(leasedLaunch(root).refusal).toBeNull();
  });
});

/** Restore the exact overlay bytes and modes, as a worker covering its tracks would. */
function removeAndRewrite(dir: string, relayUrl: string): void {
  chmodSync(dir, 0o700);
  rmSync(join(dir, ".env"), { force: true });
  chmodSync(join(dir, "config.yaml"), 0o600);
  writeFileSync(join(dir, "config.yaml"), JSON.stringify({ providers: { realbud: { api: relayUrl, url: relayUrl, base_url: relayUrl } } }));
  chmodSync(join(dir, "config.yaml"), 0o400); chmodSync(dir, 0o500);
}

/** The listing shape a Modelvia project key returns at GET /v1/models, as the
 * repo's Modelvia stand-in publishes it (managed-gateway/modelvia-live-contract.test.ts):
 * modes first, then `default`, then the route ids, with `context_length` and
 * `max_output_tokens` per entry. Not a live readback. */
const MODELVIA_LISTING = {
  object: "list", pricing_contract: 2, price_audience: "resale_customer", price_basis: "withheld",
  data: [
    { id: "auto", object: "model", created: 0, owned_by: "managed-ai-platform", context_length: 1_000_000, max_output_tokens: 32_000, capabilities: ["text", "tools"], mode: "auto", default: true },
    { id: "flash", object: "model", created: 0, owned_by: "managed-ai-platform", context_length: 1_048_576, max_output_tokens: 131_072, capabilities: ["text", "tools"], mode: "flash" },
    { id: "max", object: "model", created: 0, owned_by: "managed-ai-platform", context_length: 1_000_000, max_output_tokens: 32_000, capabilities: ["text", "tools"], mode: "max" },
    { id: "default", object: "model", created: 0, owned_by: "managed-ai-platform", context_length: 1_000_000, max_output_tokens: 32_000, capabilities: ["text", "tools"], mode: "auto", resolves_to: "auto" },
    { id: "deepseek-v4.1-flash", object: "model", created: 0, owned_by: "managed-ai-platform", context_length: 1_048_576, max_output_tokens: 131_072, capabilities: ["text", "tools"] },
    { id: "claude-sonnet-5.5", object: "model", created: 0, owned_by: "managed-ai-platform", context_length: 1_000_000, max_output_tokens: 32_000, capabilities: ["text", "tools"] },
  ],
};
const modelvia = (response: ServerResponse, seen: Seen) => {
  if (seen.method === "GET" && seen.url === "/v1/models") return json(MODELVIA_LISTING)(response);
  response.writeHead(404); response.end();
};

describe("Ask model relay model listing", () => {
  it.each(MANAGED_MODEL_CHOICES.map(choice => choice.id))("lists only %s's model from the gateway, read-only with the office key", async (id) => {
    const root = home(), gateway = await upstream(modelvia);
    grantManagedAccess(root, { baseUrl: gateway.url, choice: id });
    const { relay, token } = await relayFor(root);
    const response = await fetch(`${relay.url}/models`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ object: "list", data: MODELVIA_LISTING.data.filter(entry => entry.id === choiceOf(id).model) });
    expect(gateway.seen).toHaveLength(1);
    expect(gateway.seen[0]).toMatchObject({ method: "GET", url: "/v1/models" });
    expect(gateway.seen[0]!.headers.authorization).toBe(`Bearer ${FICTIONAL_GRANTED_KEY}`);
  });

  it("requires the token, forwards no other read, and never passes a refusal body through", async () => {
    let status = 200;
    const gateway = await upstream((response, seen) => {
      if (status !== 200) { response.writeHead(status, { "content-type": "application/json" }); response.end("{\"error\":\"fictional-upstream-detail\"}"); return; }
      modelvia(response, seen);
    });
    const root = home();
    grantManagedAccess(root, { baseUrl: gateway.url });
    const { relay, token } = await relayFor(root);
    const auth = { authorization: `Bearer ${token}` };
    expect((await fetch(`${relay.url}/models`)).status).toBe(401);
    for (const path of ["/models/claude-sonnet-5.5", "/v1/models", "/api/tags", "/props", "/version", "/api/v1/models"]) {
      expect((await fetch(`${relay.url}${path}`, { headers: auth })).status, path).toBe(404);
    }
    expect(gateway.seen).toHaveLength(0);
    status = 401;
    const refused = await fetch(`${relay.url}/models`, { headers: auth });
    expect(refused.status).toBe(401);
    expect(await refused.text()).not.toContain("fictional-upstream-detail");
    setWorkerModelGrant({ state: "withdrawn" });
    expect((await fetch(`${relay.url}/models`, { headers: auth })).status).toBe(503);
    expect(gateway.seen).toHaveLength(1);
  });

  it("records the AI service rejecting the office key for check-in, and clears it on success", async () => {
    let status = 401;
    const gateway = await upstream(response => { response.writeHead(status, { "content-type": "application/json" }); response.end("{}"); });
    const root = home();
    grantManagedAccess(root, { baseUrl: gateway.url });
    const { relay, token } = await relayFor(root);
    const answer = vi.mocked(noteModelKeyAnswer); answer.mockClear();
    expect((await post(relay, { model: "deepseek-v4.1-flash", messages }, token)).status).toBe(401);
    expect(answer).toHaveBeenLastCalledWith("fictional-key-id", false);
    status = 403;
    expect((await fetch(`${relay.url}/models`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
    expect(answer).toHaveBeenLastCalledWith("fictional-key-id", false);
    status = 429; answer.mockClear();
    expect((await post(relay, { model: "deepseek-v4.1-flash", messages }, token)).status).toBe(429);
    expect(answer).not.toHaveBeenCalled();
    status = 200;
    expect((await post(relay, { model: "deepseek-v4.1-flash", messages }, token)).status).toBe(200);
    expect(answer).toHaveBeenLastCalledWith("fictional-key-id", true);
  });

  it("refuses an oversized listing", async () => {
    const gateway = await upstream(json({ data: [{ id: "deepseek-v4.1-flash", padding: "x".repeat(2 * 1024 * 1024) }] }));
    const root = home();
    grantManagedAccess(root, { baseUrl: gateway.url });
    const { relay, token } = await relayFor(root);
    expect((await fetch(`${relay.url}/models`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(502);
  });
});

/**
 * Gated: the context window Hermes itself resolves, through the relay and
 * directly against the same fake gateway, using the pinned runtime's own
 * agent/model_metadata.py `_resolve_custom_endpoint_context_length` in an
 * isolated Python process (temporary HERMES_HOME, loopback only). No agent,
 * ACP session or Hermes.app is started. Set REALBUD_TEST_HERMES_CLI to the
 * admitted runtime's `hermes-agent/venv/bin/hermes`.
 */
const nativeCli = process.env.REALBUD_TEST_HERMES_CLI;
describe.runIf(Boolean(nativeCli) && process.platform !== "win32")("context window Hermes resolves through the relay", () => {
  const python = nativeCli ? join(dirname(nativeCli), "python") : "";
  const agentDir = nativeCli ? dirname(dirname(dirname(nativeCli))) : "";
  const script = [
    "import json, sys",
    "sys.path.insert(0, sys.argv[1])",
    "from agent import model_metadata as m",
    "model, relay, token, direct, key = sys.argv[2:7]",
    "hit = m._longest_key_match(m.DEFAULT_CONTEXT_LENGTHS, model.lower())",
    "print(json.dumps({'relay': m._resolve_custom_endpoint_context_length(model, relay, token, 'custom'),",
    "  'direct': m._resolve_custom_endpoint_context_length(model, direct, key, 'custom'),",
    "  'catalog': hit[1] if hit else None, 'fallback': m.DEFAULT_FALLBACK_CONTEXT}))",
  ].join("\n");
  const resolve = (args: string[], hermesHome: string) => new Promise<Record<string, number | null>>((done, fail) => {
    execFile(python, ["-I", "-B", "-c", script, agentDir, ...args], { cwd: agentDir, env: { PATH: process.env.PATH, HERMES_HOME: hermesHome, NO_PROXY: "*", HOME: hermesHome }, timeout: 60_000 },
      (error, stdout) => error ? fail(error) : done(JSON.parse(stdout.trim().split("\n").at(-1)!)));
  });

  it.each(MANAGED_MODEL_CHOICES.map(choice => choice.id))("resolves the gateway's window for %s, the same as the direct path", async (id) => {
    expect(existsSync(python)).toBe(true);
    const root = home(), gateway = await upstream(modelvia);
    grantManagedAccess(root, { baseUrl: gateway.url, choice: id });
    const { relay, token } = await relayFor(root);
    const model = choiceOf(id).model;
    const resolved = await resolve([model, relay.url, token, gateway.url, FICTIONAL_GRANTED_KEY], join(root, "native-hermes-home"));
    const expected = MODELVIA_LISTING.data.find(entry => entry.id === model)!.context_length;
    expect(resolved.relay).toBe(expected);
    expect(resolved.direct).toBe(expected);
    // Evidence for the report: what the catalog fallback alone would have chosen.
    console.info(`[context] ${id}: relay=${resolved.relay} direct=${resolved.direct} catalog=${resolved.catalog} fallback=${resolved.fallback}`);
  }, 90_000);
});

describe("Ask worker key custody", () => {
  const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-acp-cli.ts");

  it("launches Ask with the relay token and overlay, never the office key, and never writes the key to the profile", async () => {
    const root = home(), gateway = await upstream(json({}));
    grantManagedAccess(root, { baseUrl: gateway.url, choice: "sonnet-high" });
    const { relay, token, overlayDir } = await relayFor(root);
    const overlay = JSON.parse(readFileSync(join(overlayDir, "config.yaml"), "utf8"));
    expect(overlay).toEqual({ providers: { realbud: { api: relay.url, url: relay.url, base_url: relay.url } } });
    if (process.platform !== "win32") expect(statSync(join(overlayDir, "config.yaml")).mode & 0o077).toBe(0);

    chmodSync(FAKE_CLI, 0o755);
    const dump = join(root, "fake-acp-dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    cleanups.push(() => { delete process.env.FAKE_ACP_DUMP; });
    const instance = await HermesAgentDriver.create({
      instanceId: "fictional-ask", displayName: "Bud", enabled: true,
      // An ambient grant name or overlay must not reach the worker either.
      environment: { REALBUD_HERMES_HOME: root, OPENAI_API_KEY: "fictional-ambient", HERMES_MANAGED_DIR: "/synthetic/ambient-overlay" },
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const recorder = recordEvents(instance.adapter);
    cleanups.push(async () => { recorder.stop(); await instance.dispose(); });
    const turn = await instance.adapter.sendTurn({ threadId: "custody", text: "hi" });
    await recorder.until(event => (event.type === "turn.completed" && event.turnId === turn.turnId) || event.type === "runtime.error");
    const seen = JSON.parse(readFileSync(dump, "utf8")) as { env: Record<string, string> };
    // The worker ran under its own execution token, live while its process is
    // and refused once that process is stopped.
    const turnToken = seen.env.REALBUD_MODEL_API_KEY!;
    expect(turnToken).toMatch(/^[0-9a-f]{64}$/);
    expect(turnToken).not.toBe(token);
    const chat = { model: "claude-sonnet-5.5", messages };
    expect((await post(relay, chat, turnToken)).status).toBe(200);
    await instance.dispose();
    expect((await post(relay, chat, turnToken)).status).toBe(401);
    expect(seen.env.HERMES_MANAGED_DIR).toBe(overlayDir);
    expect(seen.env.OPENAI_API_KEY).toBeUndefined();
    expect(JSON.stringify(seen.env)).not.toContain(FICTIONAL_GRANTED_KEY);

    // Neither the profile (config, .env, anything else) nor the overlay holds the key or the token.
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
      .flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : entry.isFile() ? [join(dir, entry.name)] : []);
    for (const file of [...files(propertyProfileDir(root)), ...files(overlayDir)]) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toContain(FICTIONAL_GRANTED_KEY);
      expect(text, file).not.toContain(token);
      expect(text, file).not.toContain(turnToken);
    }
    // The profile still names the granted endpoint, so every other managed check holds.
    expect(readFileSync(join(propertyProfileDir(root), "config.yaml"), "utf8")).toContain(gateway.url);
  }, 30_000);
});
