import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectedAppPolicy, connectedAppResultStatus, revokeConnectedAppsBrokers, startConnectedAppsBroker, type ConnectedAppsBroker, type ConnectedAppsLocalTransport } from "./connected-apps-broker.ts";
import { ConnectedAppOperationStore } from "./connected-app-operations.ts";
import * as atomic from "./atomic.ts";

describe("connected app policy", () => {
  it("allows discovery and explicit connection reads only", () => {
    expect(connectedAppPolicy({ name: "COMPOSIO_SEARCH_TOOLS" })).toBe("read");
    expect(connectedAppPolicy({ name: "COMPOSIO_GET_TOOL_SCHEMAS" })).toBe("read");
    expect(connectedAppPolicy({ name: "COMPOSIO_MANAGE_CONNECTIONS", arguments: { toolkits: [{ name: "gmail", action: "list" }] } })).toBe("read");
    expect(connectedAppPolicy({ name: "READ_EMAILS" })).toBe("review");
  });
  it.each(["add", "remove", "rename", "LIST", ""])("blocks connection mutation or ambiguous action %s", action => {
    expect(connectedAppPolicy({ name: "COMPOSIO_MANAGE_CONNECTIONS", arguments: { toolkits: [{ name: "gmail", action }] } })).toBe("blocked");
  });
  it.each(["COMPOSIO_REMOTE_WORKBENCH", "COMPOSIO_REMOTE_BASH_TOOL"])("blocks indirect remote execution via %s", name => {
    expect(connectedAppPolicy({ name })).toBe("blocked");
  });
  it("holds a mixed batch for exact review, including any nested write", () => {
    expect(connectedAppPolicy({ name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [
      { tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} }, { tool_slug: "GMAIL_SEND_EMAIL", arguments: { recipient: "fictional@example.test" } },
    ] } })).toBe("review");
  });
  it.each([[], Array.from({ length: 51 }, () => ({ tool_slug: "READ", arguments: {} })), [{ tool_slug: "COMPOSIO_REMOTE_BASH_TOOL", arguments: {} }], [{ tool_slug: "READ" }]].map(tools => ({ tools })))("blocks malformed, oversized or nested meta-tool batches", ({ tools }) => {
    expect(connectedAppPolicy({ name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools } })).toBe("blocked");
  });
  it("permits review of the supported 50-operation boundary", () => {
    expect(connectedAppPolicy({ name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: Array.from({ length: 50 }, () => ({ tool_slug: "READ", arguments: {} })) } })).toBe("review");
  });
  it.each([null, [], "send email"])("blocks malformed discovery arguments %j", args => {
    expect(connectedAppPolicy({ name: "COMPOSIO_SEARCH_TOOLS", arguments: args as any })).toBe("blocked");
  });
});

describe("connected app result classification", () => {
  it.each([
    [{ content: [{ type: "text", text: "Returned 2 records" }] }, "succeeded", false],
    [{ isError: true, content: [{ type: "text", text: "private failure" }] }, "failed", false],
    [{ content: [{ type: "text", text: JSON.stringify({ successful: false, error: "private" }) }] }, "failed", false],
    [{ structuredContent: { data: { successful: false } } }, "failed", false],
    [{ structuredContent: { successful: true, data: { results: [{ tool_slug: "READ", response: { successful: true } }, { tool_slug: "WRITE", response: { successful: false } }] } } }, "failed", true],
    [{ structuredContent: { data: { results: { first: { success: false } } } } }, "failed", false],
    [{ structuredContent: { successful: true, data: { results: [{ response: { successful: false } }, { response: { successful: false } }] } } }, "failed", false],
    [{ content: [{ type: "text", text: '{"successful":' }, { type: "text", text: "false}" }] }, "failed", false],
    [{ content: [] }, "unknown", false],
    [{ structuredContent: {} }, "unknown", false],
  ])("classifies provider envelopes without treating nested failures as success", (result, status, partial) => {
    expect(connectedAppResultStatus(result)).toEqual({ status, partial });
  });
});

describe("connected app authoritative broker", () => {
  let upstream: Server, broker: ConnectedAppsBroker;
  let active: boolean;
  let approve = vi.fn<(summary: string, signal: AbortSignal) => Promise<boolean>>();
  let received: any[];
  let url: string;
  let requestId: number;
  let upstreamStatus: number;
  let echoKey: boolean;
  let resultOverride: unknown;
  let holdResponse: boolean;
  let holdBody: boolean;
  let operations: ConnectedAppOperationStore;
  let scratch: string;
  let dispatchStatuses: string[];
  const key = "ck_fixture_upstream_only";
  const invoke = async (method: string, params: unknown = {}, id = ++requestId, overrideHeaders?: Record<string, string>) => {
    const headers = Object.fromEntries(broker.descriptor.headers.map(({ name, value }) => [name, value]));
    const response = await fetch(broker.descriptor.url, { method: "POST", headers: { ...headers, "content-type": "application/json", ...overrideHeaders }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  };
  beforeEach(async () => {
    received = []; active = true; requestId = 0; upstreamStatus = 200; echoKey = false; resultOverride = undefined; holdResponse = false; holdBody = false; dispatchStatuses = []; approve = vi.fn().mockResolvedValue(false);
    scratch = mkdtempSync(join(tmpdir(), "realbud-app-broker-"));
    operations = new ConnectedAppOperationStore({ file: join(scratch, "operations.json") });
    upstream = createServer(async (req, res) => {
      if (req.headers["x-consumer-api-key"] !== key) { res.writeHead(401).end(); return; }
      let body = ""; for await (const chunk of req) body += chunk;
      const msg = JSON.parse(body); received.push(msg);
      if (msg.method === "tools/call") dispatchStatuses.push(operations.list()[0].status);
      if (holdResponse) return;
      if (holdBody) { res.writeHead(200, { "content-type": "application/json" }); res.write('{"jsonrpc":"2.0",'); return; }
      if (upstreamStatus !== 200) { res.writeHead(upstreamStatus).end(key); return; }
      if (msg.id === undefined) { res.writeHead(202).end(); return; }
      const result = msg.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "Upstream", version: "1" } } :
        msg.method === "tools/list" ? { tools: [{ name: "send_email", annotations: { readOnlyHint: true } }] } :
          resultOverride ?? { content: [{ type: "text", text: echoKey ? `Upstream echoed ${key}` : "fixture result" }] };
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "fixture-session" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address(); if (!address || typeof address === "string") throw Error("fixture unavailable");
    url = `http://127.0.0.1:${address.port}/mcp`;
    broker = await startConnectedAppsBroker({ threadId: "fixture-thread", key, url, operations, isActive: () => active, approve: (summary, signal) => approve(summary, signal) });
  });
  afterEach(async () => { broker?.close(); upstream?.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); vi.restoreAllMocks(); rmSync(scratch, { recursive: true, force: true }); });

  it("exposes only the private broker token, never the upstream credential", async () => {
    expect(JSON.stringify(broker.descriptor)).not.toContain(key);
    const result = await invoke("initialize", { protocolVersion: "2025-11-25" });
    expect(result.body.result.serverInfo.name).toBe("Bud connected apps");
    expect(result.body.result.capabilities).toEqual({ tools: {} });
    expect(received.map(row => row.method)).toEqual(["initialize", "notifications/initialized"]);
    expect(approve).not.toHaveBeenCalled();
  });
  it("rejects browser origins and incorrect tokens before forwarding", async () => {
    expect((await invoke("tools/list", {}, 1, { origin: "https://untrusted.example" })).status).toBe(403);
    expect((await invoke("tools/list", {}, 2, { authorization: "Bearer wrong" })).status).toBe(403);
    expect(received).toHaveLength(0);
  });
  it("does not trust a readOnlyHint to permit a write", async () => {
    await invoke("tools/list");
    const result = await invoke("tools/call", { name: "send_email", arguments: { to: "fictional@example.test", text: "Draft" } });
    expect(result.body.result.isError).toBe(true);
    expect(approve).toHaveBeenCalledOnce();
    expect(received.every(row => row.method !== "tools/call")).toBe(true);
  });
  it("allows exactly the reviewed payload and reuses a duplicate request without repeating it", async () => {
    approve.mockResolvedValue(true);
    const params = { name: "send_email", arguments: { to: "fictional@example.test", text: "café draft" } };
    const results = await Promise.all([invoke("tools/call", params, 7), invoke("tools/call", params, 7)]);
    expect(results[0].body).toEqual(results[1].body);
    expect(received).toHaveLength(1);
    expect(received[0].params).toEqual(params);
    expect(dispatchStatuses).toEqual(["started"]);
    expect(operations.list()).toEqual([expect.objectContaining({ threadId: "fixture-thread", toolName: "send_email", status: "succeeded" })]);
    expect(approve).toHaveBeenCalledOnce();
    expect(approve.mock.calls[0][0]).toContain("café draft");
    const changed = await invoke("tools/call", { ...params, arguments: { to: "changed@example.test" } }, 7);
    expect(changed.body.result.isError).toBe(true);
    expect(received).toHaveLength(1);
  });
  it("reuses a denial on duplicate delivery", async () => {
    await invoke("tools/call", { name: "write" }, 5);
    await invoke("tools/call", { name: "write" }, 5);
    expect(approve).toHaveBeenCalledOnce(); expect(received).toHaveLength(0);
    expect(operations.list()).toEqual([expect.objectContaining({ status: "denied" })]);
  });
  it("keeps provider failures secret-safe and does not retry an uncertain operation", async () => {
    approve.mockResolvedValue(true); upstreamStatus = 503;
    const first = await invoke("tools/call", { name: "write" }, 15);
    expect(first.body.result.isError).toBe(true);
    expect(JSON.stringify(first.body)).not.toContain(key);
    const again = await invoke("tools/call", { name: "write" }, 15);
    expect(again.body).toEqual(first.body);
    expect(received).toHaveLength(1); expect(approve).toHaveBeenCalledOnce();
    expect(operations.list()[0].status).toBe("unknown");
  });
  it("redacts an upstream credential even if a tool echoes it as ordinary text", async () => {
    approve.mockResolvedValue(true); echoKey = true;
    const result = await invoke("tools/call", { name: "read" });
    expect(JSON.stringify(result.body)).not.toContain(key);
    expect(JSON.stringify(result.body)).toContain("private app key");
  });
  it("rejects oversized requests before asking or forwarding", async () => {
    expect((await invoke("tools/call", { name: "write", arguments: { text: "x".repeat(32_001) } })).status).toBe(413);
    expect(received).toHaveLength(0); expect(approve).not.toHaveBeenCalled();
  });
  it("rechecks a stopped turn after approval", async () => {
    approve.mockImplementation(async () => { active = false; return true; });
    expect((await invoke("tools/call", { name: "write" })).body.result.isError).toBe(true);
    expect(received).toHaveLength(0);
  });
  it("cancels pending approval before any transport work", async () => {
    approve.mockImplementation((_summary, signal: AbortSignal) => new Promise(resolve => signal.addEventListener("abort", () => resolve(false), { once: true })));
    const result = invoke("tools/call", { name: "write" });
    await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce());
    broker.cancelPending();
    expect((await result).body.result.isError).toBe(true); expect(received).toHaveLength(0);
  });
  it("prevents tools from an idle session and unsupported methods", async () => {
    expect((await invoke("resources/read", { uri: "file:///private" })).body.result.isError).toBe(true);
    active = false;
    expect((await invoke("tools/call", { name: "COMPOSIO_SEARCH_TOOLS" })).body.result.isError).toBe(true);
    expect(received).toHaveLength(0);
  });
  it("holds an entire mixed batch on Deny without partially running its read", async () => {
    const result = await invoke("tools/call", { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [
      { tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} }, { tool_slug: "GMAIL_SEND_EMAIL", arguments: { to: "fictional@example.test" } },
    ] } });
    expect(result.body.result.isError).toBe(true);
    expect(received).toHaveLength(0);
    expect(approve.mock.calls[0][0]).toContain("GMAIL_SEND_EMAIL");
  });
  it("records partial nested results as failed and preserves only safe tool identifiers", async () => {
    approve.mockResolvedValue(true);
    resultOverride = { structuredContent: { successful: true, data: { results: [
      { tool_slug: "READ", response: { successful: true, data: { email: "private@example.test" } } },
      { tool_slug: "WRITE", response: { successful: false, error: "ck_private" } },
    ] } } };
    const result = await invoke("tools/call", { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [
      { tool_slug: "READ", arguments: {} }, { tool_slug: "WRITE", arguments: {} },
    ] } });
    expect(result.body.result.isError).toBe(true);
    expect(operations.list()[0]).toMatchObject({ status: "failed", toolSlugs: ["READ", "WRITE"], detail: expect.stringContaining("Some app operations failed") });
    expect(JSON.stringify(operations.list())).not.toMatch(/private@example|ck_private/);
  });
  it("does not dispatch if the initial receipt cannot be saved", async () => {
    approve.mockResolvedValue(true);
    vi.spyOn(atomic, "writeFileAtomic").mockImplementation(() => { throw new Error("disk failed"); });
    const result = await invoke("tools/call", { name: "write" }, 32);
    expect(result.body.result.isError).toBe(true);
    expect(result.body.result.content[0].text).toContain("It was not sent");
    expect(received).toHaveLength(0);
    expect((await invoke("tools/call", { name: "write" }, 32)).body).toEqual(result.body);
  });
  it("does not replay after an outcome-save failure", async () => {
    approve.mockResolvedValue(true);
    const original = atomic.writeFileAtomic; let writes = 0;
    vi.spyOn(atomic, "writeFileAtomic").mockImplementation((...args) => { if (++writes > 1) throw new Error("disk failed"); return original(...args); });
    const result = await invoke("tools/call", { name: "write" }, 34);
    expect(result.body.result.content[0].text).toContain("operation may have happened");
    expect((await invoke("tools/call", { name: "write" }, 34)).body).toEqual(result.body);
    expect(received).toHaveLength(1);
    expect(() => operations.list()).toThrow(/history needs recovery/);
  });
  it.each([false, true])("marks an already-dispatched operation unknown on cancellation (headers received: %s)", async afterHeaders => {
    approve.mockResolvedValue(true); holdResponse = !afterHeaders; holdBody = afterHeaders;
    const result = invoke("tools/call", { name: "write" });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    broker.cancelPending();
    expect((await result).body.result.isError).toBe(true);
    expect(operations.list()[0].status).toBe("unknown");
  });
  it("revokes live brokers and aborts pending approval without an upstream operation", async () => {
    approve.mockImplementation((_summary, signal) => new Promise(resolve => signal.addEventListener("abort", () => resolve(false), { once: true })));
    const result = invoke("tools/call", { name: "write" }).catch(() => null);
    await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce());
    revokeConnectedAppsBrokers();
    await result;
    expect(received).toHaveLength(0);
    await vi.waitFor(() => expect(operations.list()[0].status).toBe("denied"));
  });
  it("does not publish a broker that was revoked while its listener was starting", async () => {
    const pending = startConnectedAppsBroker({ threadId: "fixture-starting", key, url, operations, isActive: () => active, approve: async () => true });
    revokeConnectedAppsBrokers();
    await expect(pending).rejects.toThrow(/revoked during setup/);
    expect(received).toHaveLength(0);
  });
  it("rejects credentials embedded in the upstream URL before starting a broker", async () => {
    await expect(startConnectedAppsBroker({ threadId: "fixture-starting", key, url: "https://private:secret@example.test/mcp", operations,
      isActive: () => active, approve: async () => true })).rejects.toThrow("without embedded credentials");
    expect(received).toHaveLength(0);
  });

  describe("project Gmail read-only transport", () => {
    const projectKey = "project_fixture_server_only";
    let request: ReturnType<typeof vi.fn<ConnectedAppsLocalTransport["request"]>>;
    beforeEach(async () => {
      broker.close();
      request = vi.fn(async (method, _params, signal) => {
        signal.throwIfAborted();
        if (method === "initialize") return { protocolVersion: "2025-11-25", capabilities: { resources: {}, tools: {} } };
        if (method === "tools/list") return { tools: ["GMAIL_GET_PROFILE", "GMAIL_LIST_THREADS", "GMAIL_FETCH_MESSAGE_BY_THREAD_ID"].map(name => ({ name, inputSchema: { type: "object" } })) };
        if (method === "ping") return {};
        dispatchStatuses.push(operations.list()[0].status);
        return { content: [{ type: "text", text: "Fixture Gmail read result" }] };
      });
      broker = await startConnectedAppsBroker({ threadId: "fixture-gmail", key: projectKey, url, operations, localTransport: { request }, readOnlyAccountId: "ca_fixture_gmail",
        isActive: () => active, approve: (summary, signal) => approve(summary, signal) });
    });
    it("serves MCP metadata locally without forwarding a project key to a consumer endpoint", async () => {
      const fetches = vi.spyOn(globalThis, "fetch");
      expect((await invoke("initialize")).body.result.capabilities).toEqual({ tools: {} });
      expect((await invoke("tools/list")).body.result.tools.map((row: any) => row.name)).toEqual(["GMAIL_GET_PROFILE", "GMAIL_LIST_THREADS", "GMAIL_FETCH_MESSAGE_BY_THREAD_ID"]);
      expect((await invoke("ping")).body.result).toEqual({});
      expect(request.mock.calls.map(([method]) => method)).toEqual(["initialize", "tools/list", "ping"]);
      expect(fetches.mock.calls.every(([target]) => target === broker.descriptor.url)).toBe(true);
      expect(received).toHaveLength(0);
      expect(approve).not.toHaveBeenCalled();
      expect(operations.list()).toEqual([]);
      expect(JSON.stringify(broker.descriptor)).not.toContain(projectKey);
    });
    it.each(["GMAIL_GET_PROFILE", "GMAIL_LIST_THREADS", "GMAIL_FETCH_MESSAGE_BY_THREAD_ID"])("requires exact approval and a durable receipt for %s", async name => {
      let allow!: (decision: boolean) => void;
      approve.mockImplementation(() => new Promise(resolve => { allow = resolve; }));
      const params = { name, arguments: name === "GMAIL_FETCH_MESSAGE_BY_THREAD_ID" ? { thread_id: "fixture-thread" } : {} };
      const response = invoke("tools/call", params, 71);
      await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce());
      expect(request).not.toHaveBeenCalled();
      expect(approve.mock.calls[0][0]).toContain(name);
      expect(approve.mock.calls[0][0]).toContain("Account: ca_fixture_gmail");
      expect(approve.mock.calls[0][0]).toContain("10 threads from the last 7 days");
      expect(approve.mock.calls[0][0]).not.toContain(projectKey);
      allow(true);
      const result = await response;
      expect(result.body.result.isError).not.toBe(true);
      expect(request).toHaveBeenCalledWith("tools/call", params, expect.any(AbortSignal));
      expect(dispatchStatuses).toEqual(["started"]);
      expect(operations.list()).toEqual([expect.objectContaining({ toolName: name, threadId: "fixture-gmail", status: "succeeded" })]);
      expect((await invoke("tools/call", params, 71)).body).toEqual(result.body);
      expect(request).toHaveBeenCalledOnce();
      expect(received).toHaveLength(0);
    });
    it.each(["GMAIL_SEND_EMAIL", "GMAIL_CREATE_EMAIL_DRAFT", "COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_SEARCH_TOOLS", "COMPOSIO_MANAGE_CONNECTIONS", "GMAIL_LIST_MESSAGES", "UNKNOWN_READ"])("blocks %s before approval or dispatch", async name => {
      approve.mockResolvedValue(true);
      expect((await invoke("tools/call", { name, arguments: {} })).body.result.isError).toBe(true);
      expect(approve).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(operations.list()).toEqual([]);
      expect(received).toHaveLength(0);
    });
    it("does not dispatch a Gmail read after Deny", async () => {
      expect((await invoke("tools/call", { name: "GMAIL_GET_PROFILE" })).body.result.isError).toBe(true);
      expect(operations.list()[0].status).toBe("denied");
      expect(request).not.toHaveBeenCalled();
    });
    it("accepts Hermes MCP protocol metadata without changing the reviewed tool arguments", async () => {
      approve.mockResolvedValue(true);
      const args = { thread_id: "abcdef" };
      const result = await invoke("tools/call", { name: "GMAIL_FETCH_MESSAGE_BY_THREAD_ID", arguments: args, _meta: {} });
      expect(result.body.result.isError).not.toBe(true);
      expect(request).toHaveBeenCalledWith("tools/call", { name: "GMAIL_FETCH_MESSAGE_BY_THREAD_ID", arguments: args }, expect.any(AbortSignal));
      expect(approve.mock.calls[0][0]).toContain("abcdef");
      expect(operations.list()[0].status).toBe("succeeded");
    });
    it.each([{ accountId: "injected" }, { _meta: null }, { _meta: [] }, { _meta: "invalid" }])("rejects unexpected local action envelope %j before approval", async extra => {
      expect((await invoke("tools/call", { name: "GMAIL_GET_PROFILE", arguments: {}, ...extra })).body.result.isError).toBe(true);
      expect(approve).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    });
    it("rejects a late approval after cancellation", async () => {
      let allow!: (decision: boolean) => void;
      approve.mockImplementation(() => new Promise(resolve => { allow = resolve; }));
      const response = invoke("tools/call", { name: "GMAIL_LIST_THREADS" });
      await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce());
      broker.cancelPending();
      allow(true);
      expect((await response).body.result.isError).toBe(true);
      expect(request).not.toHaveBeenCalled();
      expect(operations.list()[0].status).toBe("denied");
    });
    it("propagates cancellation to a dispatched read and retains an unknown receipt without retry", async () => {
      approve.mockResolvedValue(true);
      request.mockImplementation((_method, _params, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })));
      const response = invoke("tools/call", { name: "GMAIL_LIST_THREADS" }, 79);
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      broker.cancelPending();
      const result = await response;
      expect(result.body.result.isError).toBe(true);
      expect(operations.list()[0].status).toBe("unknown");
      expect((await invoke("tools/call", { name: "GMAIL_LIST_THREADS" }, 79)).body).toEqual(result.body);
      expect(request).toHaveBeenCalledOnce();
    });
    it("holds Gmail reads before dispatch when the receipt cannot be saved", async () => {
      approve.mockResolvedValue(true);
      vi.spyOn(atomic, "writeFileAtomic").mockImplementation(() => { throw new Error("disk failed"); });
      expect((await invoke("tools/call", { name: "GMAIL_GET_PROFILE" })).body.result.isError).toBe(true);
      expect(request).not.toHaveBeenCalled();
    });
    it("retains provider failure status and redacts echoed project credentials", async () => {
      approve.mockResolvedValue(true);
      request.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify({ successful: false, error: projectKey }) }] });
      const result = await invoke("tools/call", { name: "GMAIL_GET_PROFILE" });
      expect(result.body.result.isError).toBe(true);
      expect(JSON.stringify(result.body)).not.toContain(projectKey);
      expect(operations.list()[0].status).toBe("failed");
    });
  });
});
