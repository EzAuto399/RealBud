import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeService, checkConnectionAccess, composioTool, connectionStatus } from "./composio.ts";

const cfg = { composio: { key: "ak_test_private_value", url: "https://broker.example/mcp" } };
const envelope = (result: unknown, id: string | number = 1) => ({ jsonrpc: "2.0", id, result });
const content = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const initialized = () => new Response(JSON.stringify(envelope({
  protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Fixture Connect", version: "1" },
}, "initialize")));
function toolFetch(reply: (message: any, init: RequestInit) => Response | Promise<Response>) {
  return vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url, init: RequestInit) => {
    const message = JSON.parse(String(init.body));
    if (message.method === "initialize") return initialized();
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    return reply(message, init);
  }));
}
function respond(value: unknown, status = 200) {
  if (status !== 200) return vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(value), { status })));
  return toolFetch(() => new Response(JSON.stringify(value), { status }));
}
const call = () => composioTool(cfg, "COMPOSIO_MANAGE_CONNECTIONS", { toolkits: [] });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Composio connection boundary", () => {
  it.each(["INACTIVE", "EXPIRED", "REVOKED", "DISCONNECTED", "PENDING", "not active"])("does not call %s connected", async (status) => {
    respond(envelope(content({ data: { results: { gmail: { accounts: [{ status }] } } } })));
    expect((await connectionStatus(cfg, ["gmail"])).gmail.connected).toBe(false);
  });

  it.each(["ACTIVE", "active"])("recognises exact %s account status", async (status) => {
    respond(envelope(content({ data: { results: { gmail: { accounts: [{ status: "EXPIRED" }, { status }] } } } })));
    expect((await connectionStatus(cfg, ["gmail"])).gmail.connected).toBe(true);
  });

  it("preserves aggregate status support and reports missing services as unknown", async () => {
    respond(envelope(content({ data: { results: { gmail: { status: "ACTIVE" } } } })));
    expect(await connectionStatus(cfg, ["gmail", "outlook"])).toEqual({
      gmail: { connected: true, status: "ACTIVE", accounts: [], accountSelectionRequired: false }, outlook: { connected: false, status: "unknown", accounts: [], accountSelectionRequired: false },
    });
  });

  it("rejects malformed account collections with a safe error", async () => {
    respond(envelope(content({ data: { results: { gmail: { accounts: { secret: cfg.composio.key } } } } })));
    await expect(connectionStatus(cfg, ["gmail"])).rejects.toThrow("invalid connection status");
  });

  it.each([{ accounts: [] }, { accounts: [{ status: "INACTIVE" }] }])("does not let an aggregate ACTIVE override explicit inactive or empty accounts", async ({ accounts }) => {
    respond(envelope(content({ data: { results: { gmail: { status: "ACTIVE", accounts } } } })));
    expect((await connectionStatus(cfg, ["gmail"])).gmail.connected).toBe(false);
  });

  it.each([{}, { successful: false }, { data: { results: [] } }])("does not turn malformed connection results into a fresh sign-in flow", async (value) => {
    respond(envelope(content(value)));
    await expect(connectionStatus(cfg, ["gmail"])).rejects.toThrow(/invalid connection status|tool failed/);
  });

  it("surfaces a body read interrupted after HTTP success without exposing the error", async () => {
    const body = new ReadableStream({ start(controller) { controller.error(new Error(cfg.composio.key)); } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
    await expect(call()).rejects.toThrow("connection interrupted");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("uses the explicit endpoint and credential only in the request header", async () => {
    respond(envelope(content({ ok: true })));
    expect(await call()).toEqual({ ok: true });
    const [url, options] = vi.mocked(fetch).mock.calls[2];
    expect(url).toBe(cfg.composio.url);
    expect(options?.headers).toMatchObject({ "x-api-key": cfg.composio.key });
    expect(JSON.parse(options?.body as string)).toMatchObject({ jsonrpc: "2.0", id: 1, method: "tools/call" });
    expect(options?.body).not.toContain(cfg.composio.key);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not make a request without a key", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(composioTool({}, "tool", {})).rejects.toThrow("Connected apps key");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts leading whitespace JSON and structured results", async () => {
    toolFetch(() => new Response(` \n${JSON.stringify(envelope({ structuredContent: { ready: true }, content: [] }))}`));
    expect(await call()).toEqual({ ready: true });
  });

  it("reads a split SSE response after progress, ignores other IDs, and cancels the open stream", async () => {
    const cancel = vi.fn();
    const wire = ': heartbeat\r\n\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\n' +
      `data: ${JSON.stringify(envelope(content({ wrong: true }), 2))}\r\n\r\n` +
      'event: message\r\ndata:{"jsonrpc":"2.0","id":1,\r\ndata: "result":{"structuredContent":{"label":"café"}}}\r\n\r\n';
    const bytes = new TextEncoder().encode(wire);
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      // Deliberately keep the stream open; the response has already arrived.
    }, cancel });
    toolFetch(() => new Response(body, { headers: { "content-type": "text/event-stream" } }));
    expect(await call()).toEqual({ label: "café" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    { error: { code: -32603, message: cfg.composio.key } },
    { result: { isError: true, content: [{ type: "text", text: cfg.composio.key }] } },
  ])("rejects protocol/tool failures without exposing their payloads", async (failure) => {
    respond({ jsonrpc: "2.0", id: 1, ...failure });
    const error = await call().catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/request failed|tool failed/);
    expect(String(error)).not.toContain(cfg.composio.key);
  });

  it.each([null, {}, envelope(null), envelope(content({}), 99), { jsonrpc: "2.0", id: 1 }, envelope({ content: "bad" })])("rejects incomplete or malformed RPC results: %j", async (value) => {
    respond(value);
    await expect(call()).rejects.toThrow(/invalid|missing matching/);
  });

  it.each(["", "{incomplete", 'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n', 'data: {"jsonrpc":"2.0","id":1'])
  ("rejects a truncated or missing response", async (wire) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wire)));
    await expect(call()).rejects.toThrow(/empty|invalid|truncated|missing matching/i);
  });

  it.each([401, 403, 429, 500, 503])("reports HTTP %s without retrying or echoing the response", async (status) => {
    respond({ secret: cfg.composio.key }, status);
    const error = await call().catch((e: Error) => e);
    expect(String(error)).toContain(`HTTP ${status}`);
    expect(String(error)).not.toContain(cfg.composio.key);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([new DOMException("sensitive payload", "TimeoutError"), new Error(cfg.composio.key)])("sanitizes network failures without retrying", async (failure) => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));
    const error = await call().catch((e: Error) => e);
    expect(String(error)).toMatch(/timed out|network error|request failed|connection interrupted/i);
    expect(String(error)).not.toContain(failure.message);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("bounds the response body and cancels oversized streams", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(2_000_001)); }, cancel });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
    await expect(call()).rejects.toThrow("response too large");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("keeps concurrent response data isolated", async () => {
    toolFetch((message) => {
      const args = message.params.arguments;
      return new Response(JSON.stringify(envelope(content({ data: { results: { [args.toolkits[0].name]: { status: "ACTIVE" } } } }))));
    });
    const results = await Promise.all([connectionStatus(cfg, ["gmail"]), connectionStatus(cfg, ["outlook"])]);
    expect(Object.keys(results[0])).toEqual(["gmail"]);
    expect(Object.keys(results[1])).toEqual(["outlook"]);
  });

  it("cannot turn a tool-error URL into a successful authorization link", async () => {
    respond(envelope({ isError: true, content: [{ type: "text", text: '{"url":"https://auth.example/error"}' }] }));
    await expect(authorizeService(cfg, "gmail")).rejects.toThrow("tool failed");
  });
});

const metaTool = (name: string) => ({ name, description: "Fixture tool", inputSchema: { type: "object", properties: {} } });
const availableTools = ["COMPOSIO_MANAGE_CONNECTIONS", "COMPOSIO_SEARCH_TOOLS", "COMPOSIO_MULTI_EXECUTE_TOOL"].map(metaTool);
const connectionData = (gmail: unknown = { accounts: [] }) => ({ data: { results: { gmail } } });

describe("Composio initialized setup sessions", () => {
  it("performs the complete handshake and carries isolated session and negotiated protocol headers", async () => {
    const requests: Array<{ method: string; key: string; session?: string; protocol?: string }> = [];
    let next = 0;
    const sessions = new Map<string, string>();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      const message = JSON.parse(String(init.body));
      const headers = init.headers as Record<string, string>;
      const key = headers["x-api-key"];
      requests.push({ method: message.method, key, session: headers["mcp-session-id"], protocol: headers["mcp-protocol-version"] });
      expect(init.redirect).toBe("error");
      expect(String(init.body)).not.toContain(key);
      if (message.method === "initialize") {
        expect(message.params).toMatchObject({ protocolVersion: "2025-06-18", capabilities: {} });
        expect(headers["mcp-session-id"]).toBeUndefined();
        const session = `session-${++next}`; sessions.set(session, key);
        return new Response(JSON.stringify(envelope({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "Connect", version: "1" } }, "initialize")), { headers: { "mcp-session-id": session } });
      }
      expect(sessions.get(headers["mcp-session-id"])).toBe(key);
      expect(headers["mcp-protocol-version"]).toBe("2025-03-26");
      if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
      return new Response(JSON.stringify(envelope(content({ data: { results: { gmail: { accounts: [{ id: headers["mcp-session-id"], status: "ACTIVE" }] } } } }), message.id)));
    }));
    const other = { composio: { ...cfg.composio, key: "ak_second_private_value" } };
    const [first, second] = await Promise.all([connectionStatus(cfg, ["gmail"]), connectionStatus(other, ["gmail"])]);
    expect(first.gmail.accounts[0].id).not.toBe(second.gmail.accounts[0].id);
    for (const key of [cfg.composio.key, other.composio.key]) expect(requests.filter((row) => row.key === key).map((row) => row.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
  });

  it.each(["", "ck_consumer_key", "ck_", "ak_", "ak_with spaces", "ak_with\nnewline", "ak_" + "x".repeat(513)])("refuses an invalid Platform project key before sending it: %j", async (key) => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const error = await composioTool({ composio: { key } }, "tool", {}).catch((error) => error);
    expect(error).toBeInstanceOf(Error); expect(fetcher).not.toHaveBeenCalled();
    if (key.length > 5) expect(String(error)).not.toContain(key);
  });

  it("does not treat a catalog-only apiKey as Connected apps access", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(checkConnectionAccess({ composio: { apiKey: "ak_catalog_only" } })).rejects.toThrow(/Connected apps key|Platform project/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["http://remote.example/mcp", "https://user:password@broker.example/mcp", "javascript:alert(1)"])("rejects an insecure endpoint %s", async (url) => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(composioTool({ composio: { ...cfg.composio, url } }, "tool", {})).rejects.toThrow(/endpoint/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { protocolVersion: "2099-01-01", capabilities: { tools: {} }, serverInfo: { name: "x", version: "1" } },
    { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "x", version: "1" } },
    { protocolVersion: "2025-06-18", capabilities: { tools: {} } },
  ])("does not call a tool after an invalid initialize response", async (result) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(envelope(result, "initialize")))));
    await expect(call()).rejects.toThrow(/supported tools handshake/);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("stops when initialized notification is denied and never retries or calls a tool", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(initialized()).mockResolvedValueOnce(new Response(cfg.composio.key, { status: 403 })));
    const error = await call().catch((error) => error);
    expect(String(error)).toContain("HTTP 403"); expect(String(error)).not.toContain(cfg.composio.key);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not follow an HTTP redirect carrying the Platform project key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 307, headers: { location: "https://other.example/mcp" } })));
    await expect(call()).rejects.toThrow(/HTTP 307/);
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.mocked(fetch).mock.calls[0][1]?.redirect).toBe("error");
  });

  it("rejects a replacement session header instead of mixing connection contexts", async () => {
    const initial = new Response(JSON.stringify(envelope({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "x", version: "1" } }, "initialize")), { headers: { "mcp-session-id": "session-a" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(new Response(null, { status: 202 })).mockResolvedValueOnce(new Response(JSON.stringify(envelope(content({ ok: true }))), { headers: { "mcp-session-id": "session-b" } })));
    await expect(call()).rejects.toThrow(/invalid connection session/);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("aborts a stalled response body at the shared operation deadline without a retry", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const cancelled = vi.fn();
    toolFetch(() => new Response(new ReadableStream({ start() {}, cancel: cancelled }), { headers: { "content-type": "text/event-stream" } }));
    const pending = call();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    controller.abort(new DOMException("private timeout reason", "TimeoutError"));
    const error = await pending.catch((error) => error);
    expect(String(error)).toMatch(/request timed out/);
    expect(String(error)).not.toContain("private timeout reason");
    expect(cancelled).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe("connection access and exact account evidence", () => {
  it("discovers useful tools and lists accounts within one initialized setup session", async () => {
    toolFetch((message) => {
      if (message.method === "tools/list") return new Response(JSON.stringify(envelope({ tools: availableTools }, message.id)));
      expect(message.params).toEqual({ name: "COMPOSIO_MANAGE_CONNECTIONS", arguments: { toolkits: [{ name: "gmail", action: "list" }, { name: "outlook", action: "list" }] } });
      return new Response(JSON.stringify(envelope(content(connectionData({ status: "ACTIVE", accounts: [
        { id: "account-work", name: "Work mailbox", status: "ACTIVE" },
        { account_id: "account-personal", label: "Personal mailbox", status: "active" },
        { nanoid: "account-old", email: "former@example.com", status: "EXPIRED" },
      ] })), message.id)));
    });
    const result = await checkConnectionAccess(cfg, ["gmail", "outlook"]);
    expect(result.tools).toEqual({ available: true, names: availableTools.map((tool) => tool.name) });
    expect(Number.isFinite(Date.parse(result.checkedAt))).toBe(true);
    expect(result.services.gmail).toEqual({ connected: true, status: "ACTIVE", accountSelectionRequired: true, accounts: [
      { id: "account-work", label: "Work mailbox", status: "ACTIVE" },
      { id: "account-personal", label: "Personal mailbox", status: "active" },
      { id: "account-old", label: "former@example.com", status: "EXPIRED" },
    ] });
    expect(result.services.outlook).toEqual({ connected: false, status: "unknown", accounts: [], accountSelectionRequired: false });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(result)).not.toContain(cfg.composio.key);
    expect(JSON.stringify(vi.mocked(fetch).mock.calls)).not.toContain("GMAIL_FETCH");
  });

  it("keeps missing account IDs unknown and only flags selection when multiple active accounts were actually reported", async () => {
    respond(envelope(content(connectionData({ accounts: [{ status: "ACTIVE" }, { id: "old", status: "EXPIRED" }] }))));
    expect((await connectionStatus(cfg, ["gmail"])).gmail).toEqual({ connected: true, status: "unknown", accounts: [{ id: "old", status: "EXPIRED" }], accountSelectionRequired: false });
  });

  it.each([{ accounts: [null] }, { accounts: [{ id: 5, status: "ACTIVE" }] }, { accounts: [{ id: "x", status: {} }] }, { accounts: [{ id: "x", status: "ACTIVE" }, { id: "x", status: "ACTIVE" }] }, { status: { token: cfg.composio.key } }])("rejects malformed account identity or status without exposing it", async (row) => {
    respond(envelope(content(connectionData(row))));
    const error = await connectionStatus(cfg, ["gmail"]).catch((error) => error);
    expect(String(error)).toMatch(/invalid connection status/); expect(String(error)).not.toContain(cfg.composio.key);
  });

  it.each([[], ["GMAIL"], ["gmail;send"], Array(31).fill("gmail")].map((slugs) => ({ slugs })))("bounds toolkit status requests before connecting: $slugs", async ({ slugs }) => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(connectionStatus(cfg, slugs)).rejects.toThrow(/valid app names/); expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not claim Bud tools are available from connection management alone", async () => {
    toolFetch((message) => new Response(JSON.stringify(envelope(message.method === "tools/list" ? { tools: [availableTools[0]] } : content(connectionData()), message.id))));
    expect((await checkConnectionAccess(cfg)).tools.available).toBe(false);
  });

  it.each([[{ name: "COMPOSIO_SEARCH_TOOLS" }], [{ ...metaTool("x"), inputSchema: [] }], [metaTool("x"), metaTool("x")], [{ ...metaTool("x"), inputSchema: { type: "object", required: "unsafe" } }]].map((tools) => ({ tools })))("rejects malformed tool metadata $tools", async ({ tools }) => {
    toolFetch((message) => new Response(JSON.stringify(envelope({ tools }, message.id))));
    await expect(checkConnectionAccess(cfg)).rejects.toThrow(/invalid tools metadata/);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not turn a status check into the auth-starting string-array Tool Router call", async () => {
    toolFetch((message) => new Response(JSON.stringify(envelope({ tools: [{ ...availableTools[0], inputSchema: { type: "object", properties: { toolkits: { type: "array", items: { type: "string" } } } } }] }, message.id))));
    await expect(checkConnectionAccess(cfg)).rejects.toThrow(/supported read-only connection list/);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe("structured authorization links", () => {
  it.each(["redirect_url", "authorization_url", "auth_url"])("accepts a secure link from the explicit %s field", async (field) => {
    respond(envelope(content(connectionData({ [field]: "https://connect.composio.dev/link/fixture" }))));
    expect(await authorizeService(cfg, "gmail")).toEqual({ url: "https://connect.composio.dev/link/fixture" });
  });

  it.each([
    { text: "Open https://attacker.example/auth" },
    { url: "https://attacker.example/auth" },
    { data: { results: { gmail: { message: "Authentication: https://attacker.example/auth", homepage: "https://attacker.example" } } } },
  ])("never extracts arbitrary embedded URLs", async (value) => {
    respond(envelope(content(value)));
    await expect(authorizeService(cfg, "gmail")).rejects.toThrow(/No authorization link/);
  });

  it.each(["http://auth.example/link", "https://user:password@auth.example/link", "javascript:alert(1)", "https://127.0.0.1/auth", "https://localhost./auth", "https://service.localhost/auth", " https://auth.example/link"])("rejects unsafe authorization URL %s", async (redirect_url) => {
    respond(envelope(content(connectionData({ redirect_url }))));
    await expect(authorizeService(cfg, "gmail")).rejects.toThrow(/not a secure URL/);
  });
});
