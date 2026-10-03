import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectedAppPolicy, connectedAppResultStatus, revokeConnectedAppsBrokers, startConnectedAppsBroker, type ConnectedAppsBroker, type ConnectedAppsLocalTransport } from "./connected-apps-broker.ts";
import { ConnectedAppOperationStore } from "./connected-app-operations.ts";
import { ServiceEntitlementError } from "./service-entitlement.ts";
import * as atomic from "./atomic.ts";

const { assertCapability, mailboxAccess } = vi.hoisted(() => ({ assertCapability: vi.fn(), mailboxAccess: vi.fn() }));
vi.mock("./managed-service.ts", () => ({ managedService: { assertCapability } }));
// The connector status the desktop last read (shared mailbox, full access or not).
vi.mock("./managed-connectors.ts", () => ({ managedMailboxAccess: mailboxAccess }));

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
  it("behind the managed service classifies any app's tools by name: reads run, writes review, destructive or admin blocked", () => {
    const managed = { managed: true };
    expect(connectedAppPolicy({ name: "XERO_LIST_INVOICES" }, managed)).toBe("read");
    expect(connectedAppPolicy({ name: "SLACK_SEARCH_MESSAGES", arguments: { query: "rent" } }, managed)).toBe("read");
    expect(connectedAppPolicy({ name: "XERO_CREATE_INVOICE" }, managed)).toBe("review");
    expect(connectedAppPolicy({ name: "SLACK_POST_MESSAGE" }, managed)).toBe("review");
    expect(connectedAppPolicy({ name: "XERO_FROBNICATE" }, managed)).toBe("review");
    for (const name of ["XERO_DELETE_INVOICE", "SLACK_ADMIN_USERS_SET_OWNER", "NOTION_BULK_ARCHIVE_PAGES", "GITHUB_REVOKE_TOKEN"]) expect(connectedAppPolicy({ name }, managed)).toBe("blocked");
    // Mailbox tools follow the owner's exact lists: reads, drafts and labels run; sends and Trash
    // are reviewed; permanent delete, filters and settings are blocked; an unknown mail tool is reviewed.
    expect(connectedAppPolicy({ name: "GMAIL_LIST_THREADS", arguments: { query: "from:fictional@example.test" } }, managed)).toBe("read");
    expect(connectedAppPolicy({ name: "GMAIL_CREATE_EMAIL_DRAFT", arguments: { recipient_email: "fictional@example.test" } }, managed)).toBe("read");
    expect(connectedAppPolicy({ name: "GMAIL_ADD_LABEL_TO_EMAIL", arguments: { message_id: "abc", remove_label_ids: ["INBOX"] } }, managed)).toBe("read");
    expect(connectedAppPolicy({ name: "GMAIL_ADD_LABEL_TO_EMAIL", arguments: { message_id: "abc", add_label_ids: ["TRASH"] } }, managed)).toBe("review");
    for (const name of ["GMAIL_SEND_EMAIL", "GMAIL_REPLY_TO_THREAD", "GMAIL_FORWARD_MESSAGE", "GMAIL_SEND_DRAFT", "GMAIL_MOVE_TO_TRASH", "OUTLOOK_SEND_EMAIL", "OUTLOOK_SEND_DRAFT", "GMAIL_FROBNICATE"]) expect(connectedAppPolicy({ name }, managed)).toBe("review");
    for (const name of ["GMAIL_DELETE_MESSAGE", "GMAIL_BATCH_DELETE_MESSAGES", "GMAIL_CREATE_FILTER", "GMAIL_UPDATE_VACATION_SETTINGS", "OUTLOOK_CREATE_EMAIL_RULE", "OUTLOOK_PERMANENT_DELETE_MESSAGE"]) expect(connectedAppPolicy({ name }, managed)).toBe("blocked");
    expect(connectedAppPolicy({ name: "OUTLOOK_MOVE_MESSAGE", arguments: { message_id: "m", destination_id: "archive" } }, managed)).toBe("read");
    expect(connectedAppPolicy({ name: "OUTLOOK_MOVE_MESSAGE", arguments: { message_id: "m", destination_id: "deleteditems" } }, managed)).toBe("review");
    // A message is sent only on its own card, never inside a batch; batch members are classified with their arguments.
    expect(connectedAppPolicy({ name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: "GMAIL_LIST_THREADS", arguments: {} }, { tool_slug: "GMAIL_SEND_EMAIL", arguments: {} }] } }, managed)).toBe("blocked");
    expect(connectedAppPolicy({ name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: "GMAIL_LIST_THREADS", arguments: {} }, { tool_slug: "GMAIL_UPDATE_DRAFT", arguments: { draft_id: "r1" } }] } }, managed)).toBe("read");
    expect(connectedAppPolicy({ name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: "GMAIL_LIST_THREADS", arguments: {} }, { tool_slug: "GMAIL_MODIFY_THREAD_LABELS", arguments: { add_label_ids: ["TRASH"] } }] } }, managed)).toBe("review");
    // A batch is as strict as its strictest member.
    expect(connectedAppPolicy({ name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: "XERO_LIST_INVOICES", arguments: {} }, { tool_slug: "XERO_GET_CONTACT", arguments: {} }] } }, managed)).toBe("read");
    expect(connectedAppPolicy({ name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: "XERO_LIST_INVOICES", arguments: {} }, { tool_slug: "XERO_DELETE_INVOICE", arguments: {} }] } }, managed)).toBe("blocked");
  });
  it("keeps the review-everything default for a direct connection", () => {
    for (const name of ["XERO_LIST_INVOICES", "XERO_CREATE_INVOICE", "XERO_DELETE_INVOICE", "GMAIL_SEND_EMAIL", "send_email"]) expect(connectedAppPolicy({ name })).toBe("review");
    expect(connectedAppPolicy({ name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: "XERO_LIST_INVOICES", arguments: {} }, { tool_slug: "XERO_DELETE_INVOICE", arguments: {} }] } })).toBe("review");
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
  const key = "ak_fixture_upstream_only";
  const invoke = async (method: string, params: unknown = {}, id = ++requestId, overrideHeaders?: Record<string, string>) => {
    const headers = Object.fromEntries(broker.descriptor.headers.map(({ name, value }) => [name, value]));
    const response = await fetch(broker.descriptor.url, { method: "POST", headers: { ...headers, "content-type": "application/json", ...overrideHeaders }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  };
  beforeEach(async () => {
    assertCapability.mockReset(); mailboxAccess.mockReset();
    received = []; active = true; requestId = 0; upstreamStatus = 200; echoKey = false; resultOverride = undefined; holdResponse = false; holdBody = false; dispatchStatuses = []; approve = vi.fn().mockResolvedValue(false);
    scratch = mkdtempSync(join(tmpdir(), "realbud-app-broker-"));
    operations = new ConnectedAppOperationStore({ file: join(scratch, "operations.json") });
    upstream = createServer(async (req, res) => {
      if (req.headers["x-api-key"] !== key) { res.writeHead(401).end(); return; }
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
    expect(JSON.stringify(result.body)).toMatch(/private app key|redacted \d+ chars/);
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
  it("returns an accurate MCP error for an initial entitlement denial without approval or dispatch", async () => {
    assertCapability.mockImplementation(() => { throw new ServiceEntitlementError("The service entitlement has expired.", 402); });
    const result = await invoke("tools/call", { name: "write" }, 47);
    expect(result.status).toBe(200);
    expect(result.body.result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("entitlement has expired") }] });
    expect(JSON.stringify(result.body)).not.toContain("disk access");
    expect(approve).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);
    expect(operations.list()).toHaveLength(0);
    assertCapability.mockReset();
    expect((await invoke("tools/call", { name: "write" }, 47)).body).toEqual(result.body);
    expect(received).toHaveLength(0);
  });
  it("does not dispatch an approved action when its entitlement expired while approval was pending", async () => {
    let now = 10;
    const expiresAt = 20;
    assertCapability.mockImplementation((capability: string) => {
      expect(capability).toBe("connected-tools");
      if (now >= expiresAt) throw new ServiceEntitlementError("The service entitlement has expired.", 402);
    });
    let approvePending!: (accepted: boolean) => void;
    approve.mockImplementation(() => new Promise(resolve => { approvePending = resolve; }));
    const pending = invoke("tools/call", { name: "write" });
    await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce());
    expect(assertCapability).toHaveBeenCalledOnce();
    now = expiresAt;
    approvePending(true);
    const result = await pending;
    expect(assertCapability).toHaveBeenCalledTimes(2);
    expect(result.body.result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("entitlement has expired") }] });
    expect(received).toHaveLength(0);
    expect(operations.list()).toHaveLength(0);
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

  describe("managed gateway session refresh", () => {
    let gateway: Server;
    let live: Set<string>;
    let calls: { method: string; params?: unknown; session?: string; status: number }[];
    let refusals: string[];
    let alwaysExpire: boolean;
    let sessions: number;
    /** Per-tool fixture answers for mailbox reads made while preparing a card. */
    let toolAnswers: Record<string, (args: any) => unknown | Promise<unknown>>;
    const managedBroker = (managed: boolean, extra: { threadId?: string; mailDrainMs?: number } = {}) => {
      const address = gateway.address(); if (!address || typeof address === "string") throw Error("fixture unavailable");
      return startConnectedAppsBroker({ threadId: extra.threadId ?? "fixture-managed", key, url: `http://127.0.0.1:${address.port}/v1/connectors/mcp`, operations, ...(managed ? { managed: true } : {}),
        ...(extra.mailDrainMs !== undefined ? { mailDrainMs: extra.mailDrainMs } : {}), isActive: () => active, approve: (summary, signal) => approve(summary, signal) });
    };
    const startManaged = async (managed: boolean, extra: { mailDrainMs?: number } = {}) => {
      broker.close();
      broker = await managedBroker(managed, extra);
    };
    beforeEach(async () => {
      live = new Set(); calls = []; refusals = []; alwaysExpire = false; sessions = 0; toolAnswers = {};
      // Mirrors managed-gateway/connectors.ts: an unknown or re-fingerprinted
      // session is refused with `{ error }` before anything is dispatched.
      gateway = createServer(async (req, res) => {
        let body = ""; for await (const chunk of req) body += chunk;
        const msg = JSON.parse(body); const session = req.headers["mcp-session-id"] as string | undefined;
        const refuse = (error: string) => { calls.push({ method: msg.method, params: msg.params, session, status: 409 }); res.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ error })); };
        if (msg.method === "initialize") {
          if (session) { res.writeHead(429).end(); return; }
          const fresh = `fixture-session-${++sessions}`; live.add(fresh); calls.push({ method: msg.method, status: 200 });
          res.writeHead(200, { "content-type": "application/json", "mcp-session-id": fresh }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } }));
          return;
        }
        if (msg.method === "notifications/initialized") {
          if (!session || !live.has(session)) { refuse("connector_session_expired"); return; }
          calls.push({ method: msg.method, session, status: 202 }); res.writeHead(202).end(); return;
        }
        if (refusals.length) { refuse(refusals.shift()!); return; }
        if (alwaysExpire || !session || !live.has(session)) { refuse("connector_session_expired"); return; }
        calls.push({ method: msg.method, params: msg.params, session, status: 200 });
        const reviewRead = String(msg.id).startsWith("bud-mail-review-");
        if (msg.method === "tools/call" && !reviewRead) dispatchStatuses.push(operations.list()[0].status);
        // The gateway's adapters read only name/arguments; Hermes' protocol
        // metadata belongs to the desktop broker.
        const invalidEnvelope = msg.method === "tools/call" && Object.keys(msg.params).some(key => !["name", "arguments"].includes(key));
        const answer = msg.method === "tools/call" ? toolAnswers[msg.params.name] : undefined;
        const result = invalidEnvelope ? { isError: true, content: [{ type: "text", text: "The gateway refused an unexpected call envelope." }] } :
          msg.method === "tools/list" ? { tools: [{ name: "GMAIL_GET_PROFILE" }] } : answer ? await answer(msg.params.arguments) : { content: [{ type: "text", text: "Fixture profile" }] };
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": session }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      });
      await new Promise<void>(resolve => gateway.listen(0, "127.0.0.1", resolve));
      await startManaged(true);
      approve.mockResolvedValue(true);
      await invoke("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture-worker", version: "1" } });
      live.clear(); // Gmail reconnected: the gateway's binding fingerprint moved.
      calls = [];
    });
    afterEach(async () => { gateway.closeAllConnections(); await new Promise<void>(resolve => gateway.close(() => resolve())); });
    const toolCalls = () => calls.filter(row => row.method === "tools/call");

    it("re-initializes an expired session and retries the reviewed call once under one receipt", async () => {
      const result = await invoke("tools/call", { name: "GMAIL_GET_PROFILE", arguments: {} });
      expect(result.body.result.isError).not.toBe(true);
      expect(calls.map(row => `${row.method}:${row.status}`)).toEqual(["tools/call:409", "initialize:200", "notifications/initialized:202", "tools/call:200"]);
      expect(toolCalls()[1].session).toBe("fixture-session-2");
      expect(dispatchStatuses).toEqual(["started"]);
      // A mailbox read runs without a card, but still under a durable receipt.
      expect(approve).not.toHaveBeenCalled();
      expect(operations.list()).toEqual([expect.objectContaining({ threadId: "fixture-managed", toolName: "GMAIL_GET_PROFILE", status: "succeeded" })]);
      // The fresh session carries later calls without another handshake.
      expect((await invoke("tools/list")).body.result.tools).toHaveLength(1);
      expect(calls.filter(row => row.method === "initialize")).toHaveLength(1);
    });
    it.each(["GMAIL_GET_PROFILE", "GMAIL_LIST_THREADS", "GMAIL_FETCH_MESSAGE_BY_THREAD_ID"])("forwards the reviewed %s arguments without Hermes metadata, including after session refresh", async name => {
      const args = name === "GMAIL_FETCH_MESSAGE_BY_THREAD_ID" ? { thread_id: "abcdef" } : {};
      const params = { name, arguments: args, _meta: {} };
      const result = await invoke("tools/call", params, 81);
      expect(result.body.result.isError).not.toBe(true);
      expect(toolCalls().map(row => row.params)).toEqual([{ name, arguments: args }, { name, arguments: args }]);
      expect(approve).not.toHaveBeenCalled();
      expect(dispatchStatuses).toEqual(["started"]);
      expect(operations.list()).toEqual([expect.objectContaining({ toolName: name, status: "succeeded" })]);
      expect((await invoke("tools/call", params, 81)).body).toEqual(result.body);
      expect(toolCalls()).toHaveLength(2);
      expect((await invoke("tools/call", { ...params, _meta: { progressToken: "fictional-progress" } }, 81)).body.result.isError).toBe(true);
      expect(toolCalls()).toHaveLength(2);
    });
    it("removes nonempty protocol metadata without treating it as Gmail account or query arguments", async () => {
      const result = await invoke("tools/call", { name: "GMAIL_GET_PROFILE", arguments: {}, _meta: { progressToken: "fictional-progress", accountId: "fictional-other", query: "anywhere" } });
      expect(result.body.result.isError).not.toBe(true);
      expect(toolCalls().map(row => row.params)).toEqual([{ name: "GMAIL_GET_PROFILE", arguments: {} }, { name: "GMAIL_GET_PROFILE", arguments: {} }]);
      expect(operations.list()[0].status).toBe("succeeded");
    });
    it.each([{ accountId: "injected" }, { _meta: null }, { _meta: [] }, { _meta: "invalid" }])("rejects unexpected managed envelope %j before approval or dispatch", async extra => {
      expect((await invoke("tools/call", { name: "GMAIL_GET_PROFILE", arguments: {}, ...extra })).body.result.isError).toBe(true);
      expect(approve).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
      expect(operations.list()).toEqual([]);
    });
    it("reports a plain error without a third attempt when the fresh session is also refused", async () => {
      alwaysExpire = true;
      const result = await invoke("tools/call", { name: "GMAIL_GET_PROFILE", arguments: {} });
      expect(result.body.result.isError).toBe(true);
      const text = result.body.result.content[0].text;
      expect(text).not.toMatch(/409|HTTP|conflict/i);
      expect(text).toContain("won't repeat this operation");
      expect(toolCalls()).toHaveLength(2);
      expect(calls.filter(row => row.method === "initialize")).toHaveLength(1);
      expect(dispatchStatuses).toEqual([]);
      expect(operations.list()).toEqual([expect.objectContaining({ toolName: "GMAIL_GET_PROFILE", status: "unknown" })]);
    });
    it.each(["connector_binding_changed", "connector_busy", "office_mailbox_review_required"])("does not retry a %s refusal", async code => {
      refusals = [code];
      const result = await invoke("tools/call", { name: "GMAIL_GET_PROFILE", arguments: {} });
      expect(result.body.result.isError).toBe(true);
      expect(toolCalls()).toHaveLength(1);
      expect(calls.some(row => row.method === "initialize")).toBe(false);
      expect(operations.list()).toEqual([expect.objectContaining({ status: "unknown" })]);
    });
    describe("mailbox review cards", () => {
      // Dispatches the gateway accepted (a refused stale-session attempt is not one).
      const sends = () => toolCalls().filter(row => row.status === 200 && !String((row.params as any)?.name).match(/_GET_DRAFT$|_GET_MESSAGE$|_LIST_OUTLOOK_ATTACHMENTS$/));
      const gmailDraft = (to: string, body = "See you at 10.") => ({ structuredContent: { id: "r-fixture-1", message: { id: "m1", payload: { mimeType: "multipart/mixed",
        headers: [{ name: "From", value: "office@example.test" }, { name: "To", value: to }, { name: "Cc", value: "cc@example.test" }, { name: "Subject", value: "Inspection" }],
        parts: [{ mimeType: "text/plain", body: { data: Buffer.from(body).toString("base64url") } }, { mimeType: "application/pdf", filename: "report.pdf", partId: "1", body: { attachmentId: `att-${Math.random()}`, size: 3 } }] } } } });
      it("shows every recipient, the subject, every body line and the attachment names, then sends exactly what was shown", async () => {
        const args = { recipient_email: "tenant@example.test", extra_recipients: ["second@example.test"], cc: ["cc@example.test"], bcc: ["hidden@example.test"],
          subject: "Rent\nTo: attacker@example.test", body: "Line one\nTo: forged@example.test\nLine three",
          attachment: { name: "lease.pdf", mimetype: "application/pdf", s3key: "fictional/lease.pdf" } };
        const result = await invoke("tools/call", { name: "GMAIL_SEND_EMAIL", arguments: args, _meta: { progressToken: "fictional-progress" } });
        expect(result.body.result.isError).not.toBe(true);
        const card: string = approve.mock.calls[0][0];
        expect(card).toContain('To: "tenant@example.test", "second@example.test"');
        expect(card).toContain('Cc: "cc@example.test"');
        expect(card).toContain('Bcc: "hidden@example.test"');
        expect(card).toContain('Subject: "Rent\\nTo: attacker@example.test"');
        expect(card).toContain('Attachments: "lease.pdf"');
        expect(card).toContain("| Line one\n| To: forged@example.test\n| Line three");
        // Neither the subject nor the body can draw a second recipient line.
        expect(card.split("\n").filter(line => line.startsWith("To: "))).toEqual(['To: "tenant@example.test", "second@example.test"']);
        expect(sends().map(row => row.params)).toEqual([{ name: "GMAIL_SEND_EMAIL", arguments: args }]);
        expect(operations.list()).toEqual([expect.objectContaining({ toolName: "GMAIL_SEND_EMAIL", status: "succeeded" })]);
      });
      it("sends nothing when the person denies the card", async () => {
        approve.mockResolvedValue(false);
        const result = await invoke("tools/call", { name: "OUTLOOK_SEND_EMAIL", arguments: { to: "a@example.test, b@example.test", subject: "Keys", body: "Ready." } });
        expect(result.body.result.isError).toBe(true);
        expect(approve.mock.calls[0][0]).toContain('To: "a@example.test", "b@example.test"');
        expect(toolCalls()).toEqual([]);
        expect(operations.list()).toEqual([expect.objectContaining({ toolName: "OUTLOOK_SEND_EMAIL", status: "denied" })]);
      });
      it("reads a saved Gmail draft for the card, re-reads it after approval and sends only that unchanged draft", async () => {
        let reads = 0;
        toolAnswers.GMAIL_GET_DRAFT = args => { reads++; expect(args).toEqual({ draft_id: "r-fixture-1", format: "full" }); return gmailDraft("tenant@example.test"); };
        const result = await invoke("tools/call", { name: "GMAIL_SEND_DRAFT", arguments: { draft_id: "r-fixture-1" } });
        expect(result.body.result.isError).not.toBe(true);
        const card: string = approve.mock.calls[0][0];
        for (const line of ['From: "office@example.test"', 'To: "tenant@example.test"', 'Cc: "cc@example.test"', "Bcc: none", 'Subject: "Inspection"', 'Attachments: "report.pdf" (application/pdf, 3 bytes)', "| See you at 10."]) expect(card).toContain(line);
        expect(reads).toBe(2);
        expect(sends().map(row => row.params)).toEqual([{ name: "GMAIL_SEND_DRAFT", arguments: { draft_id: "r-fixture-1" } }]);
        expect(operations.list()).toEqual([expect.objectContaining({ toolName: "GMAIL_SEND_DRAFT", status: "succeeded" })]);
      });
      it("does not send a draft that changed after it was approved", async () => {
        let reads = 0;
        toolAnswers.GMAIL_GET_DRAFT = () => gmailDraft(++reads === 1 ? "tenant@example.test" : "attacker@example.test");
        const result = await invoke("tools/call", { name: "GMAIL_SEND_DRAFT", arguments: { draft_id: "r-fixture-1" } });
        expect(result.body.result.isError).toBe(true);
        expect(result.body.result.content[0].text).toContain("changed");
        expect(sends()).toEqual([]);
        expect(operations.list()).toEqual([expect.objectContaining({ toolName: "GMAIL_SEND_DRAFT", status: "denied" })]);
      });
      it("fails closed without a card when the draft cannot be read in a known shape", async () => {
        toolAnswers.GMAIL_GET_DRAFT = () => ({ content: [{ type: "text", text: "Draft r-fixture-1 to someone" }] });
        const result = await invoke("tools/call", { name: "GMAIL_SEND_DRAFT", arguments: { draft_id: "r-fixture-1" } });
        expect(result.body.result.isError).toBe(true);
        expect(result.body.result.content[0].text).toContain("nothing was sent");
        expect(approve).not.toHaveBeenCalled();
        expect(sends()).toEqual([]);
      });
      it("holds the mailbox between the final draft read and the send, refusing a concurrent draft edit", async () => {
        let reads = 0, release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        toolAnswers.GMAIL_GET_DRAFT = async () => { if (++reads === 2) await held; return gmailDraft("tenant@example.test"); };
        const sending = invoke("tools/call", { name: "GMAIL_SEND_DRAFT", arguments: { draft_id: "r-fixture-1" } }, 501);
        await vi.waitFor(() => expect(reads).toBe(2));
        const edit = await invoke("tools/call", { name: "GMAIL_UPDATE_DRAFT", arguments: { draft_id: "r-fixture-1", recipient_email: "attacker@example.test" } }, 502);
        expect(edit.body.result.isError).toBe(true);
        expect(edit.body.result.content[0].text).toContain("Wait for it to finish");
        release();
        expect((await sending).body.result.isError).not.toBe(true);
        expect(sends().map(row => (row.params as any).name)).toEqual(["GMAIL_SEND_DRAFT"]);
        // Released afterwards: the edit can run again.
        expect((await invoke("tools/call", { name: "GMAIL_UPDATE_DRAFT", arguments: { draft_id: "r-fixture-1", subject: "Later" } }, 503)).body.result.isError).not.toBe(true);
      });
      it("waits for a draft edit already in flight before the final read, and then refuses the changed draft", async () => {
        let reads = 0, edited = false, finishEdit!: () => void;
        const editHeld = new Promise<void>(resolve => { finishEdit = resolve; });
        toolAnswers.GMAIL_UPDATE_DRAFT = async () => { await editHeld; edited = true; return { content: [{ type: "text", text: "{}" }] }; };
        toolAnswers.GMAIL_GET_DRAFT = () => { reads++; return gmailDraft(edited ? "attacker@example.test" : "tenant@example.test"); };
        const edit = invoke("tools/call", { name: "GMAIL_UPDATE_DRAFT", arguments: { draft_id: "r-fixture-1", recipient_email: "attacker@example.test" } }, 601);
        await vi.waitFor(() => expect(toolCalls().some(row => (row.params as any)?.name === "GMAIL_UPDATE_DRAFT" && row.status === 200)).toBe(true));
        const sending = invoke("tools/call", { name: "GMAIL_SEND_DRAFT", arguments: { draft_id: "r-fixture-1" } }, 602);
        await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce());
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(reads).toBe(1); // The final read waits for the edit in flight.
        finishEdit();
        expect((await edit).body.result.isError).not.toBe(true);
        const sent = await sending;
        expect(sent.body.result.content[0].text).toContain("changed");
        expect(reads).toBe(2);
        expect(sends().map(row => (row.params as any).name)).toEqual(["GMAIL_UPDATE_DRAFT"]);
      });
      it("refuses the send when a mail call in flight does not settle within the bound", async () => {
        await startManaged(true, { mailDrainMs: 30 });
        await invoke("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture-worker", version: "1" } });
        let finishEdit!: () => void;
        const editHeld = new Promise<void>(resolve => { finishEdit = resolve; });
        toolAnswers.GMAIL_UPDATE_DRAFT = async () => { await editHeld; return { content: [{ type: "text", text: "{}" }] }; };
        toolAnswers.GMAIL_GET_DRAFT = () => gmailDraft("tenant@example.test");
        const edit = invoke("tools/call", { name: "GMAIL_UPDATE_DRAFT", arguments: { draft_id: "r-fixture-1", subject: "Edit" } }, 611);
        await vi.waitFor(() => expect(toolCalls().some(row => (row.params as any)?.name === "GMAIL_UPDATE_DRAFT")).toBe(true));
        const sent = await invoke("tools/call", { name: "GMAIL_SEND_DRAFT", arguments: { draft_id: "r-fixture-1" } }, 612);
        expect(sent.body.result.content[0].text).toContain("still running");
        finishEdit(); await edit;
        expect(sends().map(row => (row.params as any).name)).toEqual(["GMAIL_UPDATE_DRAFT"]);
      });
      it("holds the mailbox for every Ask thread on the same connection, not only its own", async () => {
        const other = await managedBroker(true, { threadId: "fixture-other-thread" });
        try {
          let reads = 0, release!: () => void;
          const held = new Promise<void>(resolve => { release = resolve; });
          toolAnswers.GMAIL_GET_DRAFT = async () => { if (++reads === 2) await held; return gmailDraft("tenant@example.test"); };
          const sending = invoke("tools/call", { name: "GMAIL_SEND_DRAFT", arguments: { draft_id: "r-fixture-1" } }, 621);
          await vi.waitFor(() => expect(reads).toBe(2));
          const headers = Object.fromEntries(other.descriptor.headers.map(({ name, value }) => [name, value]));
          const response = await fetch(other.descriptor.url, { method: "POST", headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "GMAIL_UPDATE_DRAFT", arguments: { draft_id: "r-fixture-1", subject: "Other" } } }) });
          expect(((await response.json()) as any).result.content[0].text).toContain("Wait for it to finish");
          release();
          expect((await sending).body.result.isError).not.toBe(true);
          expect(sends().map(row => (row.params as any).name)).toEqual(["GMAIL_SEND_DRAFT"]);
        } finally { other.close(); }
      });
      it("shows the HTML a recipient reads, both versions when they differ, and refuses parts it cannot show", async () => {
        const encode = (value: string) => Buffer.from(value).toString("base64url");
        const draftWith = (parts: unknown[]) => ({ structuredContent: { id: "r-fixture-2", message: { id: "m2", payload: { mimeType: "multipart/alternative",
          headers: [{ name: "To", value: "tenant@example.test" }, { name: "Subject", value: "Bond" }], parts } } } });
        toolAnswers.GMAIL_GET_DRAFT = () => draftWith([{ mimeType: "text/plain", body: { data: encode("Your bond is ready.") } },
          { mimeType: "text/html", body: { data: encode('<p>Pay your bond <a href="https://pay.example.test/x">here</a>.</p><div style="display:none">hidden</div>') } }]);
        await invoke("tools/call", { name: "GMAIL_SEND_DRAFT", arguments: { draft_id: "r-fixture-2" } }, 631);
        const card: string = approve.mock.calls[0][0];
        expect(card).toContain("Plain-text version (some mail apps show this one; it differs from the HTML version)");
        expect(card).toContain("| Pay your bond here [https://pay.example.test/x].");
        expect(card).toContain("HTML source");
        expect(card).toContain("| <p>Pay your bond");
        expect(card).toContain("display:none");
        for (const parts of [
          [{ mimeType: "text/plain", body: { data: encode("Hi") } }, { mimeType: "image/png", body: { attachmentId: "img", size: 10 } }],
          [{ mimeType: "text/plain", body: { attachmentId: "big-body", size: 900000 } }],
        ]) {
          approve.mockClear();
          toolAnswers.GMAIL_GET_DRAFT = () => draftWith(parts);
          const refused = await invoke("tools/call", { name: "GMAIL_SEND_DRAFT", arguments: { draft_id: "r-fixture-2" } });
          expect(refused.body.result.content[0].text).toContain("nothing was sent");
          expect(approve).not.toHaveBeenCalled();
        }
        expect(sends().map(row => (row.params as any).name)).toEqual(["GMAIL_SEND_DRAFT"]);
      });
      it("refuses a draft whose attachment changed size after approval", async () => {
        let reads = 0;
        toolAnswers.GMAIL_GET_DRAFT = () => { const draft = gmailDraft("tenant@example.test"); if (++reads > 1) draft.structuredContent.message.payload.parts[1].body.size = 4; return draft; };
        expect((await invoke("tools/call", { name: "GMAIL_SEND_DRAFT", arguments: { draft_id: "r-fixture-1" } })).body.result.content[0].text).toContain("changed");
        expect(sends()).toEqual([]);
      });
      it("spells out direction overrides and line separators in addresses, subject and body", async () => {
        approve.mockResolvedValue(false);
        await invoke("tools/call", { name: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "evil\u202Egpj.test@example.test", subject: "Rent\u2028To: x@example.test", body: "Pay\u2066 now\u0085done" } });
        const card: string = approve.mock.calls[0][0];
        expect(card).toContain('To: "evil<U+202E>gpj.test@example.test"');
        expect(card).toContain('Subject: "Rent<U+2028>To: x@example.test"');
        expect(card).toContain("| Pay<U+2066> now<U+0085>done");
        expect(card).not.toMatch(/[\u202a-\u202e\u2066-\u2069\u2028\u2029\u0085]/);
      });
      it("shows the hidden recipient of an Outlook reply and the attachment names of an Outlook draft", async () => {
        const message = (extra: Record<string, unknown>) => ({ structuredContent: { data: { id: "AAMk-fixture", subject: "Repairs", from: { emailAddress: { address: "sender@example.test", name: "Fictional Sender" } },
          replyTo: [], toRecipients: [{ emailAddress: { address: "office@example.test" } }], ccRecipients: [], bccRecipients: [], body: { contentType: "text", content: "Original" }, hasAttachments: false, ...extra } } });
        toolAnswers.OUTLOOK_GET_MESSAGE = () => message({});
        expect((await invoke("tools/call", { name: "OUTLOOK_REPLY_EMAIL", arguments: { message_id: "AAMk-fixture", comment: "Booked for Tuesday." } })).body.result.isError).not.toBe(true);
        expect(approve.mock.calls[0][0]).toContain('To: "Fictional Sender <sender@example.test>"');
        expect(approve.mock.calls[0][0]).toContain("| Booked for Tuesday.");
        toolAnswers.OUTLOOK_GET_MESSAGE = () => message({ isDraft: true, hasAttachments: true, toRecipients: [{ emailAddress: { address: "owner@example.test" } }], body: { contentType: "html", content: "<p>Photos</p>" } });
        toolAnswers.OUTLOOK_LIST_OUTLOOK_ATTACHMENTS = () => ({ structuredContent: { value: [{ id: "att-1", name: "photo-1.jpg", contentType: "image/jpeg", size: 2048 }, { id: "att-2", name: "quote.pdf", size: 512 }] } });
        expect((await invoke("tools/call", { name: "OUTLOOK_SEND_DRAFT", arguments: { message_id: "AAMk-fixture" } })).body.result.isError).not.toBe(true);
        const card: string = approve.mock.calls[1][0];
        expect(card).toContain('To: "owner@example.test"');
        expect(card).toContain('Attachments: "photo-1.jpg" (image/jpeg, 2048 bytes), "quote.pdf" (512 bytes)');
        expect(card).toContain("HTML version as text (links in brackets), 6 characters, every line shown:\n| Photos");
        expect(sends().map(row => (row.params as any).name)).toEqual(["OUTLOOK_REPLY_EMAIL", "OUTLOOK_SEND_DRAFT"]);
      });
      it.each([
        ["no recipient", { name: "GMAIL_SEND_EMAIL", arguments: { subject: "Hi", body: "Hello" } }, "names no recipient"],
        ["another mailbox", { name: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "a@example.test", body: "Hi", user_id: "other@example.test" } }, "own mailbox"],
        ["a credential in the body", { name: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "a@example.test", body: "password: Fictional-Secret-123" } }, "password"],
        ["an unreadable recipient field", { name: "GMAIL_SEND_EMAIL", arguments: { recipient_email: { address: "a@example.test" }, body: "Hi" } }, "nothing was sent"],
      ])("refuses a send with %s before any card or dispatch", async (_label, params, message) => {
        const result = await invoke("tools/call", params);
        expect(result.body.result.isError).toBe(true);
        expect(result.body.result.content[0].text).toContain(message);
        expect(approve).not.toHaveBeenCalled();
        expect(toolCalls()).toEqual([]);
      });
      it.each(["GMAIL_DELETE_MESSAGE", "GMAIL_BATCH_DELETE_MESSAGES", "GMAIL_CREATE_FILTER", "GMAIL_UPDATE_SEND_AS", "OUTLOOK_CREATE_EMAIL_RULE", "OUTLOOK_PERMANENT_DELETE_MESSAGE"])("blocks %s at the desktop", async name => {
        expect((await invoke("tools/call", { name, arguments: { message_id: "abc" } })).body.result.isError).toBe(true);
        expect(approve).not.toHaveBeenCalled();
        expect(toolCalls()).toEqual([]);
      });
      it("shows no card for a shared mailbox without the owner's full-access grant, and says the owner must turn it on", async () => {
        mailboxAccess.mockImplementation((credential: string) => credential === key ? "read_only" : undefined);
        toolAnswers.GMAIL_GET_DRAFT = () => gmailDraft("tenant@example.test");
        for (const params of [{ name: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "tenant@example.test", body: "Hi" } }, { name: "GMAIL_SEND_DRAFT", arguments: { draft_id: "r-fixture-1" } },
          { name: "GMAIL_CREATE_EMAIL_DRAFT", arguments: { recipient_email: "tenant@example.test" } }, { name: "GMAIL_ADD_LABEL_TO_EMAIL", arguments: { message_id: "abc", remove_label_ids: ["INBOX"] } }]) {
          const result = await invoke("tools/call", params);
          expect(result.body.result.isError).toBe(true);
          expect(result.body.result.content[0].text).toContain("office owner to turn on full access");
        }
        expect(approve).not.toHaveBeenCalled();
        expect(toolCalls()).toEqual([]);
        // The three bounded reads still run; with the grant, the send card returns.
        expect((await invoke("tools/call", { name: "GMAIL_LIST_THREADS", arguments: {} })).body.result.isError).not.toBe(true);
        mailboxAccess.mockReturnValue("full");
        expect((await invoke("tools/call", { name: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "tenant@example.test", body: "Hi" } })).body.result.isError).not.toBe(true);
        expect(approve).toHaveBeenCalledOnce();
      });
      it("runs drafts, labels and archive without a card, and moves to Trash only after one", async () => {
        for (const params of [{ name: "GMAIL_CREATE_EMAIL_DRAFT", arguments: { recipient_email: "a@example.test", body: "Draft" } },
          { name: "GMAIL_ADD_LABEL_TO_EMAIL", arguments: { message_id: "abc", remove_label_ids: ["INBOX", "UNREAD"] } }]) expect((await invoke("tools/call", params)).body.result.isError).not.toBe(true);
        expect(approve).not.toHaveBeenCalled();
        expect((await invoke("tools/call", { name: "GMAIL_MOVE_TO_TRASH", arguments: { message_id: "abc" } })).body.result.isError).not.toBe(true);
        expect(approve).toHaveBeenCalledOnce();
        expect(approve.mock.calls[0][0]).toContain("GMAIL_MOVE_TO_TRASH");
      });
    });
    it("does not retry an expired session on a direct (unmanaged) connection", async () => {
      await startManaged(false); calls = [];
      const result = await invoke("tools/call", { name: "GMAIL_GET_PROFILE", arguments: {} });
      expect(result.body.result.isError).toBe(true);
      expect(calls.map(row => row.method)).toEqual(["tools/call"]);
    });
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
