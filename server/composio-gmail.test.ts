import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeGmailReadOnly, createGmailReadOnlyTransport, getGmailReadOnlyAccess, isGmailReadOnlyAuthorizationUrl, listGmailReadOnlyAccounts, verifyGmailReadOnlyConfig, type GmailReadOnlyBinding } from "./composio-gmail.ts";

const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const binding: GmailReadOnlyBinding = { apiKey: "ak_fixture_project_key", authConfigId: "ac_readonly", userId: "review-user", accountId: "ca_work" };
const slugs = ["GMAIL_GET_PROFILE", "GMAIL_LIST_THREADS", "GMAIL_FETCH_MESSAGE_BY_THREAD_ID"];
const config = () => ({ id: binding.authConfigId, toolkit: { slug: "gmail" }, auth_scheme: "OAUTH2", status: "ENABLED", credentials: { scopes: [READONLY, "openid", "email", "profile"], client_secret: "hidden-fixture-secret" } });
const account = () => ({ id: binding.accountId, toolkit: { slug: "gmail" }, auth_config: { id: binding.authConfigId, auth_scheme: "OAUTH2", is_disabled: false }, user_id: binding.userId, authScheme: "OAUTH2", is_disabled: false, status: "ACTIVE", alias: "Work Gmail", requested_scopes: [READONLY], state: { access_token: "hidden-fixture-token" }, data: { private: true } });
function tool(slug: string) {
  const properties: Record<string, unknown> = { user_id: { type: "string" } };
  if (slug === slugs[1]) Object.assign(properties, { query: { type: "string" }, max_results: { type: "integer" }, page_token: { type: "string" }, include_spam_trash: { type: "boolean" } });
  if (slug === slugs[2]) properties.thread_id = { type: "string" };
  return { slug, toolkit: { slug: "gmail" }, version: "20260828_00", no_auth: false, is_deprecated: false, scopes: [READONLY], input_parameters: { type: "object", properties, required: slug === slugs[2] ? ["thread_id"] : [] }, output_parameters: { type: "object" } };
}
const message = (id = "aa", at = Date.now() - 60_000) => ({ id, threadId: "abc", internalDate: String(at), payload: { mimeType: "text/plain", headers: [{ name: "Subject", value: "Fictional repair update" }, { name: "From", value: "tenant@example.test" }, { name: "X-Private", value: "not projected" }], body: { data: Buffer.from("Please review the fictional tap repair.").toString("base64url") } }, token: "not projected" });
const success = (data: unknown) => ({ successful: true, error: null, data });
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
type Call = { url: URL; options: RequestInit; body: any };
type Fixture = {
  auth?: any; accounts?: any; detail?: any; metadata?: (slug: string) => any;
  execute?: (slug: string, call: Call) => any | Promise<any>;
  override?: (call: Call) => Response | Promise<Response> | undefined;
};
function fixture(options: Fixture = {}) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
    const call = { url: new URL(input), options: init, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    expect(call.url.origin).toBe("https://backend.composio.dev");
    expect(call.options.redirect).toBe("error");
    expect(call.options.headers).toMatchObject({ "x-api-key": binding.apiKey });
    const override = options.override?.(call);
    if (override) return override;
    const path = call.url.pathname;
    if (path.includes("/auth_configs/")) return response(options.auth ?? config());
    if (path === "/api/v3.1/connected_accounts/link") return response({ redirect_url: "https://connect.composio.dev/link/fixture", connected_account_id: "ca_new", expires_at: new Date(Date.now() + 600_000).toISOString(), link_token: "not projected" });
    if (path === "/api/v3.1/connected_accounts") return response(options.accounts ?? { items: [account()], next_cursor: null });
    if (path.includes("/connected_accounts/")) return response(options.detail ?? account());
    if (path.includes("/tools/execute/")) {
      const slug = path.split("/").at(-1)!;
      if (options.execute) return response(await options.execute(slug, call));
      if (slug === slugs[0]) return response(success({ emailAddress: "work@example.test", messagesTotal: 15, threadsTotal: 10, access_token: "not projected" }));
      if (slug === slugs[1]) return response(success({ threads: [{ id: "abc", snippet: "not projected" }], nextPageToken: "private-page-token", resultSizeEstimate: 30 }));
      if (slug === slugs[2]) return response(success({ id: "abc", messages: [message()] }));
    }
    if (path.includes("/tools/")) { const slug = path.split("/").at(-1)!; return response(options.metadata?.(slug) ?? tool(slug)); }
    throw new Error("Unexpected fixture request");
  }));
  return calls;
}
function client(value = binding) {
  const transport = createGmailReadOnlyTransport(value), signal = new AbortController().signal;
  return { request: (method: string, params?: unknown) => transport.request(method, params, signal), call: (name: string, args: unknown = {}) => transport.request("tools/call", { name, arguments: args }, signal), transport };
}
const data = (result: any) => JSON.parse(result.content[0].text);
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Gmail read-only configuration and connection identity", () => {
  it("projects only the verified enabled Gmail OAuth2 configuration", async () => {
    fixture();
    const result = await verifyGmailReadOnlyConfig(binding);
    expect(result).toEqual({ id: "ac_readonly", toolkit: "gmail", authScheme: "OAUTH2", status: "ENABLED", scopes: [READONLY, "openid", "email", "profile"] });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it.each([undefined, [], "********", [READONLY, "https://mail.google.com/"], ["https://www.googleapis.com/auth/gmail.modify"], [READONLY, "https://www.googleapis.com/auth/gmail.send"]])("rejects hidden or broader scopes: %j", async scopes => {
    fixture({ auth: { ...config(), credentials: { scopes } } });
    await expect(verifyGmailReadOnlyConfig(binding)).rejects.toThrow(/scopes/);
  });
  it.each([
    { toolkit: { slug: "outlook" } }, { id: "ac_other" }, { auth_scheme: "API_KEY" }, { status: "DISABLED" }, { proxy_config: { proxy_url: "https://elsewhere.example" } },
  ])("rejects a changed auth configuration %j", async patch => {
    fixture({ auth: { ...config(), ...patch } });
    await expect(verifyGmailReadOnlyConfig(binding)).rejects.toThrow(/Gmail read-only/);
  });
  it.each([{ apiKey: "ck_consumer_key" }, { apiKey: "bad key\n" }, { authConfigId: "../other" }, { userId: "user&other=user" }, { accountId: "ca/other" }])("rejects an invalid binding before any request %j", patch => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect(() => createGmailReadOnlyTransport({ ...binding, ...patch })).toThrow(/Gmail read-only/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("filters account discovery by server-owned user and auth config and excludes state and tokens", async () => {
    const calls = fixture();
    expect(await listGmailReadOnlyAccounts(binding)).toEqual([{ id: "ca_work", label: "Work Gmail", status: "ACTIVE" }]);
    const list = calls.find(call => call.url.pathname.endsWith("/connected_accounts"))!;
    expect(Object.fromEntries(list.url.searchParams)).toEqual({ user_ids: "review-user", auth_config_ids: "ac_readonly", toolkit_slugs: "gmail", account_type: "PRIVATE", limit: "50" });
  });
  it("accepts omitted deprecated user_id only inside the fixed user-filtered query", async () => {
    const row: any = account(); delete row.user_id;
    fixture({ accounts: { items: [row] }, detail: row });
    expect((await getGmailReadOnlyAccess(binding)).services.gmail.connected).toBe(true);
  });
  it.each([{ user_id: "other-user" }, { auth_config: { id: "ac_other", is_disabled: false } }, { toolkit: { slug: "outlook" } }, { experimental: { account_type: "SHARED" } }, { is_disabled: undefined }])("rejects mismatched or unclear account ownership %j", async patch => {
    fixture({ accounts: { items: [{ ...account(), ...patch }] } });
    await expect(listGmailReadOnlyAccounts(binding)).rejects.toThrow(/account/);
  });
  it("marks disabled accounts unusable and does not select them", async () => {
    fixture({ accounts: { items: [{ ...account(), is_disabled: true }] } });
    expect(await listGmailReadOnlyAccounts(binding)).toEqual([{ id: "ca_work", label: "Work Gmail", status: "DISABLED" }]);
    expect((await getGmailReadOnlyAccess(binding)).services.gmail).toMatchObject({ connected: false, status: "DISABLED" });
  });
  it.each([undefined, [READONLY, "https://www.googleapis.com/auth/gmail.modify"]])("rejects an old or hidden connection scope snapshot %j", async requested_scopes => {
    fixture({ detail: { ...account(), requested_scopes } });
    await expect(getGmailReadOnlyAccess(binding)).rejects.toThrow(/scopes/);
  });
  it("requires a persisted binding even when the user has active accounts", async () => {
    fixture({ accounts: { items: [account(), { ...account(), id: "ca_second" }] } });
    const value = { ...binding, accountId: undefined };
    expect((await getGmailReadOnlyAccess(value)).services.gmail).toEqual({ connected: false, status: "NOT_CONNECTED", accounts: [], accountSelectionRequired: false });
    expect(await client(value).call(slugs[0])).toMatchObject({ isError: true });
  });
  it.each(["INITIATED", "INITIALIZING", "EXPIRED", "FAILED"])("keeps pending/inactive %s account visible without advertising reads", async status => {
    const calls = fixture({ accounts: { items: [{ ...account(), status }, { ...account(), id: "ca_older_active" }] } });
    const result = await getGmailReadOnlyAccess(binding);
    expect(result.services.gmail).toEqual({ connected: false, status, accounts: [{ id: "ca_work", label: "Work Gmail", status }], accountSelectionRequired: false });
    expect(result.tools).toEqual({ available: false, names: [] });
    expect(calls.some(call => call.url.pathname.includes("/tools/") || call.url.pathname.endsWith("/ca_work"))).toBe(false);
  });
  it("projects only the exact persisted account even when other accounts are active", async () => {
    fixture({ accounts: { items: [account(), { ...account(), id: "ca_other" }] } });
    const result = await getGmailReadOnlyAccess(binding);
    expect(result.services.gmail.accounts.map(row => row.id)).toEqual(["ca_work"]);
    expect(result.services.gmail.accountSelectionRequired).toBe(false);
  });
  it("never substitutes another active account for a missing saved binding", async () => {
    fixture({ accounts: { items: [{ ...account(), id: "ca_other" }] } });
    await expect(getGmailReadOnlyAccess(binding)).rejects.toThrow(/no longer belongs/);
  });
  it("caps pagination and rejects repeated cursors", async () => {
    let page = 0;
    fixture({ override: call => call.url.pathname.endsWith("/connected_accounts") ? response({ items: [{ ...account(), id: `ca_${++page}` }], next_cursor: "repeat" }) : undefined });
    await expect(listGmailReadOnlyAccounts(binding)).rejects.toThrow(/pagination/);
    expect(page).toBe(2);
  });
  it("creates only a link for the verified config and user, without returning its link token", async () => {
    const calls = fixture();
    const result = await authorizeGmailReadOnly(binding);
    expect(result).toMatchObject({ url: "https://connect.composio.dev/link/fixture", accountId: "ca_new" });
    expect(Object.keys(result)).toEqual(["url", "accountId", "expiresAt"]);
    expect(calls.find(call => call.options.method === "POST")!.body).toEqual({ auth_config_id: "ac_readonly", user_id: "review-user" });
  });
  it.each(["http://connect.composio.dev/link", "https://evil.example/link", "https://connect.composio.dev.evil.example/link", "https://name:password@connect.composio.dev/link", "https://connect.composio.dev:444/link"])('rejects unsafe authorization link %s', async redirect_url => {
    fixture({ override: call => call.url.pathname.endsWith("/link") ? response({ redirect_url, connected_account_id: "ca_new", expires_at: new Date(Date.now() + 60_000).toISOString() }) : undefined });
    await expect(authorizeGmailReadOnly(binding)).rejects.toThrow(/sign-in link/);
  });
  it("validates persisted consent URLs using the provider link allowlist", () => {
    expect(isGmailReadOnlyAuthorizationUrl("https://connect.composio.dev/link/fixture", binding.apiKey)).toBe(true);
    for (const value of [undefined, null, {}, "not a URL", "http://connect.composio.dev/link", "https://evil.example/link",
      "https://connect.composio.dev.evil.example/link", "https://name:password@connect.composio.dev/link", "https://connect.composio.dev:444/link",
      " https://connect.composio.dev/link", `https://connect.composio.dev/link/${binding.apiKey}`, `https://connect.composio.dev/${"x".repeat(4096)}`]) {
      expect(isGmailReadOnlyAuthorizationUrl(value, binding.apiKey)).toBe(false);
    }
  });
});

describe("bounded Gmail MCP transport", () => {
  it("offers a virtual handshake and exactly the three fixed read tools", async () => {
    fixture(); const c = client();
    expect(await c.request("initialize", {})).toMatchObject({ capabilities: { tools: {} }, protocolVersion: "2025-06-18" });
    expect(await c.request("ping")).toEqual({});
    const result = await c.request("tools/list");
    expect(result.tools.map((tool: any) => tool.name)).toEqual(slugs);
    expect(result.tools.every((tool: any) => tool.inputSchema.additionalProperties === false)).toBe(true);
  });
  it("pins the verified metadata version and fills the selected account and user server-side", async () => {
    const calls = fixture(); const c = client();
    expect(data(await c.call(slugs[0]))).toEqual({ accountId: "ca_work", emailAddress: "work@example.test", messagesTotal: 15, threadsTotal: 10 });
    const execution = calls.find(call => call.options.method === "POST")!;
    expect(execution.body).toEqual({ connected_account_id: "ca_work", user_id: "review-user", version: "20260828_00", arguments: { user_id: "me" } });
    expect(calls.filter(call => call.url.pathname.includes("/tools/") && call.options.method === "GET").slice(1).every(call => call.url.searchParams.get("version") === "20260828_00")).toBe(true);
  });
  it("rejects inconsistent versions across the three tools", async () => {
    const calls = fixture({ metadata: slug => ({ ...tool(slug), version: slug === slugs[0] ? "20260828_00" : "20260901_00" }) });
    expect(await client().request("tools/list")).toMatchObject({ isError: true });
    expect(calls.some(call => call.options.method === "POST")).toBe(false);
  });
  it.each(["COMPOSIO_MULTI_EXECUTE_TOOL", "GMAIL_SEND_EMAIL", "GMAIL_GET_ATTACHMENT", "GMAIL_CREATE_EMAIL_DRAFT", "GMAIL_ADD_LABEL_TO_EMAIL"])("rejects %s without a provider call", async slug => {
    const calls = fixture(); expect(await client().call(slug)).toMatchObject({ isError: true }); expect(calls).toHaveLength(0);
  });
  it.each([{ user_id: "other" }, { query: "all mail" }, { page_token: "next" }, { max_results: 100 }, { connected_account_id: "other" }, { version: "latest" }])("rejects untrusted account or scope overrides %j", async args => {
    const calls = fixture(); expect(await client().call(slugs[1], args)).toMatchObject({ isError: true }); expect(calls).toHaveLength(0);
  });
  it("requires an explicit listing before fetching any thread", async () => {
    const calls = fixture(); expect(await client().call(slugs[2], { thread_id: "abc" })).toMatchObject({ isError: true }); expect(calls).toHaveLength(0);
  });
  it("caches concurrent listings, enforces ten results and seven days, and exposes no page token", async () => {
    const calls = fixture(); const c = client();
    const [one, two] = await Promise.all([c.call(slugs[1]), c.call(slugs[1])]);
    expect(one).toEqual(two); expect(data(one)).toMatchObject({ threads: [{ id: "abc" }], hasMore: true });
    expect(JSON.stringify(one)).not.toContain("private-page-token");
    const executions = calls.filter(call => call.url.pathname.includes("/execute/"));
    expect(executions).toHaveLength(1);
    const args = executions[0].body.arguments;
    expect(args).toMatchObject({ user_id: "me", max_results: 10, include_spam_trash: false });
    const match = /^after:(\d+) before:(\d+)$/.exec(args.query)!;
    expect(Number(match[2]) - Number(match[1])).toBe(7 * 86_400);
    expect(args).not.toHaveProperty("page_token");
  });
  it.each([{ threads: [] }, { resultSizeEstimate: 0 }])("handles an empty Gmail listing %j", async value => {
    fixture({ execute: () => success(value) });
    expect(data(await client().call(slugs[1]))).toMatchObject({ threads: [], hasMore: false });
  });
  it.each([{ threads: [{ id: "abc" }, { id: "abc" }] }, { threads: [{ id: "../other" }] }, { threads: [], nextPageToken: {} }, { threads: [], resultSizeEstimate: -1 }])("rejects malformed listing identities or pagination %j", async value => {
    fixture({ execute: () => success(value) });
    expect(await client().call(slugs[1])).toMatchObject({ isError: true });
  });
  it("reads only a listed thread once and omits old messages, attachment bodies, and secret fields", async () => {
    const current = message(), old = message("bb", Date.now() - 8 * 86_400_000);
    const multipart: any = current.payload;
    multipart.parts = [{ mimeType: "text/plain", filename: "private.txt", body: { attachmentId: "attachment-id", data: Buffer.from("attachment content").toString("base64url") } }];
    const calls = fixture({ execute: slug => slug === slugs[1] ? success({ threads: [{ id: "abc" }] }) : success({ id: "abc", messages: [current, old] }) });
    const c = client(); await c.call(slugs[1]);
    const [one, two] = await Promise.all([c.call(slugs[2], { thread_id: "abc" }), c.call(slugs[2], { thread_id: "abc" })]);
    expect(one).toEqual(two);
    expect(data(one)).toMatchObject({ threadId: "abc", messages: [{ id: "aa", headers: { subject: "Fictional repair update" }, attachmentsOmitted: true }], omittedOutsideWindow: 1 });
    expect(data(one).messages).toHaveLength(1);
    for (const forbidden of ["attachment content", "attachment-id", "not projected"]) expect(JSON.stringify(one)).not.toContain(forbidden);
    expect(calls.filter(call => call.url.pathname.endsWith(`/execute/${slugs[2]}`))).toHaveLength(1);
    expect(await c.call(slugs[2], { thread_id: "def" })).toMatchObject({ isError: true });
  });
  it("does not allow an eleventh unique thread even if the provider ignores the limit", async () => {
    fixture({ execute: () => success({ threads: Array.from({ length: 11 }, (_, i) => ({ id: (i + 1).toString(16) })) }) });
    const c = client(); expect(await c.call(slugs[1])).toMatchObject({ isError: true });
    expect(await c.call(slugs[2], { thread_id: "b" })).toMatchObject({ isError: true });
  });
  it("labels body truncation so a partial message cannot look like a complete read", async () => {
    const row = message(); row.payload.body.data = Buffer.from("x".repeat(10_000)).toString("base64url");
    fixture({ execute: slug => slug === slugs[1] ? success({ threads: [{ id: "abc" }] }) : success({ id: "abc", messages: [row] }) });
    const c = client(); await c.call(slugs[1]);
    const result = data(await c.call(slugs[2], { thread_id: "abc" }));
    expect(result.messages[0].bodyTruncated).toBe(true);
    expect(result.messages[0].body.length).toBe(8_000);
  });
  it("rechecks configuration/account state before each new read", async () => {
    const options: Fixture = {}; const calls = fixture(options); const c = client(); await c.call(slugs[1]);
    options.detail = { ...account(), is_disabled: true };
    expect(await c.call(slugs[2], { thread_id: "abc" })).toMatchObject({ isError: true });
    expect(calls.filter(call => call.url.pathname.includes("/execute/"))).toHaveLength(1);
  });
  it("isolates turn listings and fails unknown thread IDs in a fresh transport", async () => {
    fixture(); await client().call(slugs[1]);
    expect(await client().call(slugs[2], { thread_id: "abc" })).toMatchObject({ isError: true });
  });
  it.each([{ version: "latest" }, { toolkit: { slug: "outlook" } }, { no_auth: true }, { is_deprecated: true }, { scopes: ["https://www.googleapis.com/auth/gmail.modify"] }, { input_parameters: { type: "object", properties: { account: { type: "string" } }, required: ["account"] } }])("does not advertise unverifiable tool metadata %j", async patch => {
    fixture({ metadata: slug => ({ ...tool(slug), ...patch }) });
    expect(await client().request("tools/list")).toMatchObject({ isError: true });
  });
  it("honors scope alternatives without treating the flattened union as required", async () => {
    fixture({ metadata: slug => ({ ...tool(slug), scopes: [READONLY, "https://www.googleapis.com/auth/gmail.modify"], scope_requirements: { all_of: [{ any_of: [READONLY, "https://www.googleapis.com/auth/gmail.modify"] }] } }) });
    expect((await client().request("tools/list")).tools).toHaveLength(3);
  });
  it.each([success({ messages: [] }), success({ id: "other", messages: [] }), success({ id: "abc", messages: [{ ...message(), threadId: "def" }] }), success({ id: "abc", messages: [{ ...message(), internalDate: "unknown" }] })])("rejects incomplete message identity or dates %j", async result => {
    // A thread lacking its own id is accepted only when every message binds
    // to the requested thread; an empty identity-less result is rejected.
    fixture({ execute: slug => slug === slugs[1] ? success({ threads: [{ id: "abc" }] }) : result });
    const c = client(); await c.call(slugs[1]); expect(await c.call(slugs[2], { thread_id: "abc" })).toMatchObject({ isError: true });
  });
});

describe("Gmail transport failure and privacy boundaries", () => {
  it("returns a known provider failure as MCP isError without exposing error payloads or retrying", async () => {
    const calls = fixture({ execute: () => ({ successful: false, error: binding.apiKey, data: { access_token: "fixture-token" } }) });
    const c = client(); const result = await c.call(slugs[0]); expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(binding.apiKey);
    await c.call(slugs[0]);
    expect(calls.filter(call => call.url.pathname.includes("/execute/"))).toHaveLength(1);
  });
  it("does not accept contradictory successful:true plus error", async () => {
    fixture({ execute: () => ({ successful: true, error: "denied", data: {} }) });
    expect(await client().call(slugs[0])).toMatchObject({ isError: true });
  });
  it("throws a sanitized uncertain result for interrupted HTTP and does not retry auth links", async () => {
    const calls = fixture({ override: call => call.url.pathname.endsWith("/link") ? response({ error: binding.apiKey }, 500) : undefined });
    await expect(authorizeGmailReadOnly(binding)).rejects.toThrow(/could not be confirmed/);
    expect(calls.filter(call => call.url.pathname.endsWith("/link"))).toHaveLength(1);
  });
  it("never follows a redirect or leaks the project credential into an error", async () => {
    fixture({ override: () => { const result = response({ private: binding.apiKey }); Object.defineProperty(result, "redirected", { value: true }); return result; } });
    await expect(verifyGmailReadOnlyConfig(binding)).rejects.toThrow(/could not be confirmed/);
  });
  it("does not return an authorization URL carrying the project credential", async () => {
    fixture({ override: call => call.url.pathname.endsWith("/link") ? response({ redirect_url: `https://connect.composio.dev/link?private=${binding.apiKey}`, connected_account_id: "ca_new", expires_at: new Date(Date.now() + 60_000).toISOString() }) : undefined });
    await expect(authorizeGmailReadOnly(binding)).rejects.toThrow(/sign-in link/);
  });
  it("rejects oversized responses before parsing provider content", async () => {
    fixture({ override: () => new Response('"' + "x".repeat(2_000_001) + '"') });
    await expect(verifyGmailReadOnlyConfig(binding)).rejects.toThrow(/size/);
  });
  it("scrubs the project key even when the provider echoes it inside allowed message text", async () => {
    const row = message(); row.payload.body.data = Buffer.from(binding.apiKey).toString("base64url");
    fixture({ execute: slug => slug === slugs[1] ? success({ threads: [{ id: "abc" }] }) : success({ id: "abc", messages: [row] }) });
    const c = client(); await c.call(slugs[1]);
    const result = await c.call(slugs[2], { thread_id: "abc" });
    expect(JSON.stringify(result)).not.toContain(binding.apiKey);
    expect(data(result).messages[0].body).toContain("[private app key]");
  });
  it("aborts a stalled response body without waiting for its stream to finish", async () => {
    let opened!: () => void; const gate = new Promise<void>(resolve => { opened = resolve; });
    fixture({ override: () => { opened(); return new Response(new ReadableStream({ start() {} })); } });
    const controller = new AbortController();
    const pending = createGmailReadOnlyTransport(binding).request("tools/list", {}, controller.signal);
    await gate; controller.abort(new Error(binding.apiKey));
    await expect(pending).rejects.toThrow(/interrupted/);
  });
  it("does not start provider requests for a cancelled turn", async () => {
    const calls = fixture(), controller = new AbortController(); controller.abort();
    await expect(createGmailReadOnlyTransport(binding).request("tools/list", {}, controller.signal)).rejects.toThrow(/interrupted/);
    expect(calls).toHaveLength(0);
  });
  it("applies a 30-second deadline to setup and cancels its pending response", async () => {
    let opened!: () => void; const gate = new Promise<void>(resolve => { opened = resolve; });
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    fixture({ override: () => { opened(); return new Response(new ReadableStream({ start() {} })); } });
    const pending = verifyGmailReadOnlyConfig(binding); await gate;
    expect(timeout).toHaveBeenCalledWith(30_000); controller.abort();
    await expect(pending).rejects.toThrow(/interrupted/);
  });
});
