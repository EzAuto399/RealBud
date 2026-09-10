// Real HTTP setup tests. Only the test child redirects Composio's fixed REST
// origin; production has no endpoint override, and these fixtures cannot read mail.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_KEY = "project_fixture_private_key_one";
const NEXT_PROJECT_KEY = "project_fixture_private_key_two";
const BAD_PROJECT_KEY = "project_fixture_rejected_private_key";
const CONSUMER_KEY = "ck_fixture_consumer_preserved";
const AUTH_CONFIG = "ac_fixture_readonly";
const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_TOOLS = ["GMAIL_GET_PROFILE", "GMAIL_LIST_THREADS", "GMAIL_FETCH_MESSAGE_BY_THREAD_ID"];
const CONSUMER_TOOLS = ["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS", "COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_MANAGE_CONNECTIONS"];
const SETUP = "/api/connected-apps/gmail-readonly/setup";
const MODE = "/api/connected-apps/mode";

interface ProviderCall { path: string; method: string; project: boolean; body?: Record<string, any> }
let scratch: string, dataDir: string, preload: string, cli: string;
let stub: Server, stubUrl: string, base: string, session: string;
let child: ChildProcess | undefined, stderr = "";
let calls: ProviderCall[] = [], violations: string[] = [];
let holdAuth = false, breakAuth = false, rejectConsumer = false, activeAccount = false, linkedAccount = false;
let accountStatus: string | undefined, missingAccount = false;
let loseLinkResponse = false, ambiguousAccounts = false, linkMarkerBeforeDispatch = false;
let heldAuth: Array<() => void> = [];
let selectedUser = "", selectedAuth = AUTH_CONFIG;

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}
function authConfig(id: string) {
  return { id, toolkit: { slug: "gmail" }, auth_scheme: "OAUTH2", status: "ENABLED", is_disabled: false,
    credentials: { scopes: id.endsWith("_broad") ? "https://mail.google.com/" : READONLY } };
}
function account() {
  return { id: "ca_fixture_gmail", alias: "Fixture Gmail", user_id: selectedUser, status: accountStatus ?? (activeAccount ? "ACTIVE" : "INITIATED"), is_disabled: false,
    toolkit: { slug: "gmail" }, auth_config: { id: selectedAuth, is_disabled: false, auth_scheme: "OAUTH2" },
    experimental: { account_type: "PRIVATE" }, requested_scopes: [READONLY] };
}
function toolMetadata(slug: string) {
  const properties: Record<string, unknown> = slug === "GMAIL_LIST_THREADS"
    ? { query: { type: "string" }, max_results: { type: "integer" } }
    : slug === "GMAIL_FETCH_MESSAGE_BY_THREAD_ID" ? { thread_id: { type: "string" } } : {};
  return { slug, toolkit: { slug: "gmail" }, no_auth: false, is_deprecated: false, version: "20260908_01", scopes: [READONLY],
    input_parameters: { type: "object", properties, required: Object.keys(properties) } };
}
function diskConfig(): any { return JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")); }
function expectPublic(value: unknown) {
  const text = JSON.stringify(value);
  for (const secret of [PROJECT_KEY, NEXT_PROJECT_KEY, BAD_PROJECT_KEY, CONSUMER_KEY, diskConfig().composio?.gmailReadOnly?.userId].filter(Boolean)) {
    expect(text).not.toContain(secret);
  }
  expect(text).not.toMatch(/"(?:apiKey|userId|pendingLink)"\s*:/);
}
async function api(method: string, path: string, body?: unknown, authenticated = true) {
  const response = await fetch(`${base}${path}`, { method,
    headers: { ...(authenticated ? { "x-realbud-session": session } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: await response.json() as any };
}
async function setup(apiKey = PROJECT_KEY, authConfigId = AUTH_CONFIG) {
  const result = await api("POST", SETUP, { apiKey, authConfigId });
  expect(result.status).toBe(200);
  return result;
}
async function readonlyMode() {
  await setup();
  expect((await api("POST", MODE, { mode: "gmail-readonly" })).status).toBe(200);
}
async function settledBud() {
  let bot: any;
  await vi.waitFor(async () => {
    bot = (await api("GET", "/api/bots")).body.bots.find((row: any) => row.id === "bud");
    expect(bot?.busy).toBe(false);
  }, { timeout: 5_000, interval: 25 });
  return bot;
}
async function authorizeGmail() {
  expect((await api("POST", "/api/bots/bud/messages", { text: "Connect Gmail" })).status).toBe(202);
  const bot = await settledBud();
  expect(bot.messages.at(-1).text).toContain("https://connect.composio.dev/fixture-consent");
  return bot.messages.at(-1).text as string;
}
async function loseConsentResponse() {
  await readonlyMode();
  loseLinkResponse = true;
  expect((await api("POST", "/api/bots/bud/messages", { text: "Connect Gmail" })).status).toBe(202);
  const reply = (await settledBud()).messages.at(-1).text as string;
  expect(reply).toMatch(/couldn't confirm|could not be confirmed/i);
  expect(linkMarkerBeforeDispatch).toBe(true);
  expect(diskConfig().composio.gmailReadOnly).toMatchObject({ linkUnknown: { startedAt: expect.any(String) } });
  expect(diskConfig().composio.gmailReadOnly.pendingLink).toBeUndefined();
  expect(calls.filter(call => call.path.endsWith("/link"))).toHaveLength(1);
  loseLinkResponse = false;
  return reply;
}
async function stoppedFixture() {
  const running = child; child = undefined;
  if (running && running.exitCode === null) await new Promise<void>(resolve => {
    const timer = setTimeout(() => { running.kill("SIGKILL"); resolve(); }, 5_000); timer.unref();
    running.once("close", () => { clearTimeout(timer); resolve(); });
    running.kill("SIGTERM");
  });
}
async function startFixture() {
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", preload, join(SERVER_DIR, "index.ts")], { cwd: join(SERVER_DIR, ".."),
    env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      VITEST: "true", REALBUD_DATA_DIR: dataDir, REALBUD_HERMES_CLI: cli, OMB_PORT: String(port), TZ: "UTC" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr!.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-12_000); });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`Fixture server exited ${child.exitCode}: ${stderr}`);
    try { if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).ok) break; } catch { /* starting */ }
    if (Date.now() >= deadline) throw new Error(`Fixture server did not start: ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  session = String((await (await fetch(`${base}/api/session`)).json() as any).token);
  expect(session).toBeTruthy();
}
async function expectHeldConsent() {
  const before = readFileSync(join(dataDir, "config.json"), "utf8");
  const links = calls.filter(call => call.path.endsWith("/link")).length;
  expect((await api("POST", "/api/bots/bud/messages", { text: "Connect Gmail" })).status).toBe(202);
  const reply = (await settledBud()).messages.at(-1).text;
  expect(reply).not.toContain("https://connect.composio.dev/fixture-consent");
  expect(reply).toMatch(/couldn't|already connected|saved Gmail|previous Gmail|existing Gmail|pending|resolve|check connection/i);
  expect(calls.filter(call => call.path.endsWith("/link"))).toHaveLength(links);
  expect(readFileSync(join(dataDir, "config.json"), "utf8")).toBe(before);
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "realbud-gmail-api-"));
  cli = join(scratch, "hermes.mjs");
  writeFileSync(cli, `#!${process.execPath}\nconsole.log("Hermes Agent v0.21.0 (2026.8.31)");\n`);
  chmodSync(cli, 0o755);
  stub = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://fixture.test");
      let text = ""; for await (const chunk of req) text += chunk;
      const body = text ? JSON.parse(text) : undefined;
      const project = url.pathname.startsWith("/api/v3.1/");
      calls.push({ path: url.pathname, method: req.method ?? "GET", project, ...(body ? { body } : {}) });
      if (project) {
        if (req.headers["x-consumer-api-key"] || ![PROJECT_KEY, NEXT_PROJECT_KEY, BAD_PROJECT_KEY].includes(String(req.headers["x-api-key"]))) {
          violations.push("project request credentials crossed the transport boundary"); return json(res, 401, {});
        }
        if (req.headers["x-api-key"] === BAD_PROJECT_KEY) return json(res, 401, { error: BAD_PROJECT_KEY });
        if (url.pathname.startsWith("/api/v3.1/auth_configs/")) {
          if (breakAuth) { res.destroy(); return; }
          const answer = () => json(res, 200, authConfig(url.pathname.split("/").at(-1)!));
          if (holdAuth) { heldAuth.push(answer); return; }
          return answer();
        }
        if (url.pathname === "/api/v3.1/connected_accounts" && req.method === "GET") {
          selectedUser = url.searchParams.get("user_ids") ?? "";
          selectedAuth = url.searchParams.get("auth_config_ids") ?? "";
          if (!selectedUser.startsWith("realbud_") || url.searchParams.get("toolkit_slugs") !== "gmail" || url.searchParams.get("account_type") !== "PRIVATE") violations.push("unbound account discovery");
          const items = !missingAccount && (activeAccount || linkedAccount) ? [account()] : [];
          if (ambiguousAccounts && items.length) items.push({ ...account(), id: "ca_fixture_second" });
          return json(res, 200, { items, next_cursor: null });
        }
        if (url.pathname === "/api/v3.1/connected_accounts/link" && req.method === "POST") {
          if (!body?.user_id?.startsWith("realbud_") || !body.auth_config_id || Object.keys(body).some(key => !["auth_config_id", "user_id"].includes(key))) violations.push("unbound sign-in request");
          linkedAccount = true; selectedUser = body.user_id; selectedAuth = body.auth_config_id;
          linkMarkerBeforeDispatch = Boolean(diskConfig().composio?.gmailReadOnly?.linkUnknown);
          if (loseLinkResponse) { res.destroy(); return; }
          return json(res, 200, { redirect_url: "https://connect.composio.dev/fixture-consent", connected_account_id: "ca_fixture_gmail", expires_at: new Date(Date.now() + 600_000).toISOString() });
        }
        if (url.pathname === "/api/v3.1/connected_accounts/ca_fixture_gmail") return json(res, 200, account());
        const slug = url.pathname.replace("/api/v3.1/tools/", "");
        if (GMAIL_TOOLS.includes(slug) && req.method === "GET") return json(res, 200, toolMetadata(slug));
        violations.push("unexpected project operation");
        return json(res, 400, { error: "Fixture has no mailbox execution endpoint" });
      }
      if (url.pathname !== "/consumer-mcp" || req.headers["x-api-key"] || req.headers["x-consumer-api-key"] !== CONSUMER_KEY) {
        violations.push("consumer request credentials crossed the transport boundary"); return json(res, 401, {});
      }
      if (rejectConsumer) return json(res, 401, {});
      if (body?.id === undefined) { res.writeHead(202).end(); return; }
      let result: unknown;
      if (body.method === "initialize") result = { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "Fixture consumer", version: "1" } };
      else if (body.method === "tools/list") result = { tools: CONSUMER_TOOLS.map(name => ({ name, inputSchema: { type: "object", properties: name === "COMPOSIO_MANAGE_CONNECTIONS"
        ? { toolkits: { type: "array", items: { type: "object" } } } : {} } })) };
      else if (body.method === "tools/call" && body.params?.name === "COMPOSIO_MANAGE_CONNECTIONS") {
        const rows = body.params.arguments.toolkits;
        if (!Array.isArray(rows) || rows.some(row => row.action !== "list")) {
          violations.push("unexpected consumer sign-in or mutation"); return json(res, 400, {});
        }
        result = { content: [{ type: "text", text: JSON.stringify({ data: { results: Object.fromEntries(rows.map(row => [row.name, { status: "ACTIVE", accounts: [{ id: "consumer_fixture_account", status: "ACTIVE" }] }])) } }) }] };
      } else { violations.push("unexpected consumer operation"); return json(res, 400, {}); }
      return json(res, 200, { jsonrpc: "2.0", id: body.id, result });
    })().catch(() => { if (!res.headersSent) json(res, 500, { error: "Invalid fixture request" }); });
  });
  await new Promise<void>(resolve => stub.listen(0, "127.0.0.1", resolve));
  stubUrl = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
  preload = join(scratch, "provider-fixture.mjs");
  writeFileSync(preload, `const original = globalThis.fetch;\nconst fixture = ${JSON.stringify(stubUrl)};\nglobalThis.fetch = (input, init) => {\n  const url = new URL(input instanceof Request ? input.url : String(input));\n  if (url.origin === "https://backend.composio.dev") {\n    const mapped = fixture + url.pathname + url.search;\n    return original(input instanceof Request ? new Request(mapped, input) : mapped, init);\n  }\n  if (url.origin === fixture) return original(input, init);\n  throw new Error("Unexpected network request blocked by Gmail API test fixture");\n};\n`);
});

beforeEach(async () => {
  calls = []; violations = []; heldAuth = []; holdAuth = false; breakAuth = false; rejectConsumer = false; activeAccount = false; linkedAccount = false;
  accountStatus = undefined; missingAccount = false;
  loseLinkResponse = false; ambiguousAccounts = false; linkMarkerBeforeDispatch = false;
  selectedUser = ""; selectedAuth = AUTH_CONFIG; session = ""; stderr = "";
  // Precreated DATA_DIR prevents legacy migration; HOME and user profiles stay untouched.
  dataDir = mkdtempSync(join(scratch, "case-"));
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver", displayName: "Fixture" } },
    composio: { key: CONSUMER_KEY, url: `${stubUrl}/consumer-mcp` } }));
  writeFileSync(join(dataDir, "loops.json"), JSON.stringify({ version: 3, timezone: "UTC", runs: [], state: Object.fromEntries(
    ["morning-arrears", "owner-letter", "inbound-triage"].map(id => [id, { enabled: false, handledThrough: Date.now(), revision: 1 }]),
  ) }));
  await startFixture();
}, 25_000);

afterEach(async () => {
  holdAuth = false; for (const answer of heldAuth.splice(0)) answer();
  await stoppedFixture();
  expect(violations).toEqual([]);
  rmSync(dataDir, { recursive: true, force: true });
}, 7_000);
afterAll(async () => {
  stub?.closeAllConnections();
  if (stub) await new Promise<void>(resolve => stub.close(() => resolve()));
  rmSync(scratch, { recursive: true, force: true });
});

describe("Gmail read-only setup HTTP boundary", () => {
  it("requires a session for setup, mode, public config, status, and connection actions", async () => {
    for (const [method, path, body] of [["POST", SETUP, { apiKey: PROJECT_KEY, authConfigId: AUTH_CONFIG }], ["POST", MODE, { mode: "gmail-readonly" }],
      ["GET", "/api/config"], ["GET", "/api/connected-apps/status"], ["POST", "/api/connected-apps/check", {}],
      ["POST", "/api/bots/bud/messages", { text: "Connect Gmail" }]] as const) {
      expect((await api(method, path, body, false)).status).toBe(401);
    }
    expect(calls).toEqual([]);
    expect(diskConfig().composio).not.toHaveProperty("gmailReadOnly");
  });

  it("rejects incomplete, malformed, and injected setup bodies before provider access", async () => {
    const before = readFileSync(join(dataDir, "config.json"), "utf8");
    for (const body of [null, [], "gmail", {}, { apiKey: PROJECT_KEY }, { authConfigId: AUTH_CONFIG },
      { apiKey: CONSUMER_KEY, authConfigId: AUTH_CONFIG }, { apiKey: 123, authConfigId: AUTH_CONFIG }, { apiKey: PROJECT_KEY, authConfigId: "bad" },
      { apiKey: PROJECT_KEY, authConfigId: AUTH_CONFIG, userId: "attacker" }, { apiKey: PROJECT_KEY, authConfigId: AUTH_CONFIG, accountId: "ca_attacker" }]) {
      const result = await api("POST", SETUP, body);
      expect(result.status).toBe(400); expectPublic(result.body);
    }
    const malformed = await fetch(`${base}${SETUP}`, { method: "POST", headers: { "x-realbud-session": session, "content-type": "application/json" }, body: "{" });
    expect(malformed.status).toBe(400);
    expect(calls).toEqual([]);
    expect(readFileSync(join(dataDir, "config.json"), "utf8")).toBe(before);
  });

  it("verifies before saving, preserves consumer access, and generates a private stable binding without switching mode", async () => {
    const result = await setup();
    expect(result.body.composio).toEqual({ configured: true, apiKeyConfigured: true, mode: "consumer", readOnlyConfigured: true, readOnlyAuthConfigId: AUTH_CONFIG });
    expectPublic(result.body);
    const saved = diskConfig().composio;
    expect(saved.key).toBe(CONSUMER_KEY);
    expect(saved.gmailReadOnly).toEqual({ authConfigId: AUTH_CONFIG, userId: expect.stringMatching(/^realbud_[\w-]+$/) });
    expect(calls.filter(call => call.project).map(call => call.path)).toEqual([`/api/v3.1/auth_configs/${AUTH_CONFIG}`]);
    expect(calls.filter(call => !call.project && call.body?.method === "tools/call").every(call =>
      call.body?.params?.name === "COMPOSIO_MANAGE_CONNECTIONS" && call.body.params.arguments.toolkits.every((row: any) => row.action === "list"))).toBe(true);
    const repeated = await api("POST", SETUP, { authConfigId: AUTH_CONFIG });
    expect(repeated.status).toBe(200);
    expect(diskConfig().composio.gmailReadOnly).toEqual(saved.gmailReadOnly);
    expectPublic((await api("GET", "/api/config")).body);
    await setup(PROJECT_KEY, "ac_fixture_second");
    const next = diskConfig().composio.gmailReadOnly;
    expect(next.userId).not.toBe(saved.gmailReadOnly.userId);
    await setup(NEXT_PROJECT_KEY, "ac_fixture_second");
    expect(diskConfig().composio.gmailReadOnly.userId).not.toBe(next.userId);
    expect(diskConfig().composio.key).toBe(CONSUMER_KEY);
  });

  it("keeps the previous configuration after broad scopes, rejected keys, and interrupted verification", async () => {
    await setup();
    const before = readFileSync(join(dataDir, "config.json"), "utf8");
    for (const body of [{ apiKey: PROJECT_KEY, authConfigId: "ac_fixture_broad" }, { apiKey: BAD_PROJECT_KEY, authConfigId: AUTH_CONFIG }]) {
      const result = await api("POST", SETUP, body);
      expect(result.status).toBe(403); expectPublic(result.body);
      expect(readFileSync(join(dataDir, "config.json"), "utf8")).toBe(before);
    }
    breakAuth = true;
    const interrupted = await api("POST", SETUP, { apiKey: NEXT_PROJECT_KEY, authConfigId: AUTH_CONFIG });
    expect(interrupted.status).toBeGreaterThanOrEqual(400); expectPublic(interrupted.body);
    expect(readFileSync(join(dataDir, "config.json"), "utf8")).toBe(before);
    breakAuth = false;
    expect((await api("POST", SETUP, { apiKey: PROJECT_KEY, authConfigId: AUTH_CONFIG })).status).toBe(200);
  });

  it("serializes setup against competing setup, mode changes, and generic credential saves", async () => {
    holdAuth = true;
    const pending = api("POST", SETUP, { apiKey: PROJECT_KEY, authConfigId: AUTH_CONFIG });
    await vi.waitFor(() => expect(heldAuth).toHaveLength(1));
    expect(diskConfig().composio).not.toHaveProperty("gmailReadOnly");
    expect((await api("POST", SETUP, { apiKey: NEXT_PROJECT_KEY, authConfigId: AUTH_CONFIG })).status).toBe(409);
    expect((await api("POST", MODE, { mode: "consumer" })).status).toBe(409);
    expect((await api("PUT", "/api/config", { composio: { apiKey: NEXT_PROJECT_KEY } })).status).toBe(409);
    holdAuth = false; heldAuth.splice(0).forEach(answer => answer());
    expect((await pending).status).toBe(200);
    expect(diskConfig().composio.apiKey).toBe(PROJECT_KEY);
  });

  it("recovers a lost setup response through public status and an idempotent same-binding retry", async () => {
    holdAuth = true;
    const controller = new AbortController();
    const pending = fetch(`${base}${SETUP}`, { method: "POST", headers: { "x-realbud-session": session, "content-type": "application/json" },
      body: JSON.stringify({ apiKey: PROJECT_KEY, authConfigId: AUTH_CONFIG }), signal: controller.signal }).catch(() => null);
    await vi.waitFor(() => expect(heldAuth).toHaveLength(1));
    controller.abort(); await pending;
    holdAuth = false; heldAuth.splice(0).forEach(answer => answer());
    await vi.waitFor(() => expect(diskConfig().composio.gmailReadOnly?.userId).toMatch(/^realbud_/));
    const saved = diskConfig().composio.gmailReadOnly;
    expect((await api("GET", "/api/config")).body.composio.readOnlyConfigured).toBe(true);
    await setup();
    expect(diskConfig().composio.gmailReadOnly).toEqual(saved);
  });

  it("validates mode changes, checks the selected access path, and preserves mode on failure", async () => {
    expect((await api("POST", MODE, { mode: "gmail-readonly" })).status).toBe(409);
    for (const body of [null, [], {}, { mode: "other" }, { mode: "consumer", userId: "injected" }]) expect((await api("POST", MODE, body)).status).toBe(400);
    await readonlyMode();
    calls = [];
    const readonly = await api("POST", "/api/connected-apps/check", {});
    expect(readonly.body).toMatchObject({ configured: true, services: { gmail: { connected: false } }, tools: { available: false, names: [] } });
    expect(calls.every(call => call.project)).toBe(true); expectPublic(readonly.body);
    await authorizeGmail();
    activeAccount = true;
    const connected = await api("POST", "/api/connected-apps/check", {});
    expect(connected.body).toMatchObject({ services: { gmail: { connected: true } }, tools: { available: true, names: GMAIL_TOOLS } });
    expectPublic(connected.body);
    rejectConsumer = true;
    expect((await api("POST", MODE, { mode: "consumer" })).status).toBeGreaterThanOrEqual(400);
    expect((await api("GET", "/api/config")).body.composio.mode).toBe("gmail-readonly");
    rejectConsumer = false;
    expect((await api("POST", MODE, { mode: "consumer" })).status).toBe(200);
    calls = [];
    const consumer = await api("POST", "/api/connected-apps/check", {});
    expect(consumer.body.tools.names).toEqual(CONSUMER_TOOLS);
    expect(calls.every(call => !call.project)).toBe(true); expectPublic(consumer.body);
  });

  it("routes Ask connection checks through the selected mode and rejects other apps without OAuth", async () => {
    await readonlyMode();
    await authorizeGmail();
    activeAccount = true; calls = [];
    expect((await api("POST", "/api/bots/bud/messages", { text: "check Gmail connection" })).status).toBe(202);
    expect((await settledBud()).messages.at(-1).text).toMatch(/already connected/i);
    expect(calls.length).toBeGreaterThan(0); expect(calls.every(call => call.project && call.method === "GET")).toBe(true);
    calls = [];
    expect((await api("POST", "/api/bots/bud/messages", { text: "connect Outlook" })).status).toBe(202);
    expect((await settledBud()).messages.at(-1).text).toMatch(/No new sign-in was started/);
    expect((await api("POST", "/api/connectors/outlook/authorize", {})).status).toBe(403);
    expect(calls).toEqual([]);
    expect((await api("POST", MODE, { mode: "consumer" })).status).toBe(200);
    calls = [];
    expect((await api("POST", "/api/bots/bud/messages", { text: "check Gmail connection" })).status).toBe(202);
    expect((await settledBud()).messages.at(-1).text).toMatch(/already connected/i);
    expect(calls.length).toBeGreaterThan(0); expect(calls.every(call => !call.project)).toBe(true);
  });

  it.each(["check Gmail connection", "what are we connected to?"])("holds a queued follow-up across setting changes and restart while running %s", async request => {
    await readonlyMode();
    holdAuth = true;
    expect((await api("POST", "/api/bots/bud/messages", { text: request })).status).toBe(202);
    await vi.waitFor(() => expect(heldAuth.length).toBeGreaterThan(0));
    const followup = "Review the recent mailbox messages and prepare unsent replies";
    const queued = await api("PUT", "/api/bots/bud/queued-message", { text: followup });
    expect(queued.status).toBe(200);
    expect((await api("POST", MODE, { mode: "consumer" })).status).toBe(200);
    const held = (await settledBud()).queuedMessage;
    expect(held).toMatchObject({ id: queued.body.queued.id, text: followup, heldReason: "connected-app-settings-changed" });
    const providerCallCount = calls.length;
    holdAuth = false; heldAuth.splice(0).forEach(answer => answer());
    await new Promise(resolve => setTimeout(resolve, 100));
    let bot = await settledBud();
    expect(bot.queuedMessage).toEqual(held);
    expect(bot.messages.some((message: any) => message.role === "user" && message.text === followup)).toBe(false);
    // The already-dispatched metadata check may finish its scoped account GET;
    // it must not replay the follow-up, start sign-in, or execute app tools.
    expect(calls.slice(providerCallCount).every(call => call.method === "GET" && call.path === "/api/v3.1/connected_accounts")).toBe(true);
    const settledCallCount = calls.length;
    await stoppedFixture(); await startFixture();
    bot = await settledBud();
    expect(bot.queuedMessage).toEqual(held);
    expect((await api("DELETE", "/api/bots/bud/queued-message", { id: "stale-id" })).status).toBe(409);
    expect((await api("DELETE", "/api/bots/bud/queued-message", { id: held.id })).status).toBe(200);
    expect((await settledBud()).queuedMessage).toBeUndefined();
    expect(calls).toHaveLength(settledCallCount);
  });

  it("reuses a pending consent link and preserves it through same-binding setup retries", async () => {
    await readonlyMode(); calls = [];
    const first = await authorizeGmail();
    const binding = diskConfig().composio.gmailReadOnly;
    expect(binding.accountId).toBe("ca_fixture_gmail");
    const second = await authorizeGmail();
    expect(second).toEqual(first);
    expect(calls.filter(call => call.path.endsWith("/link"))).toHaveLength(1);
    await setup();
    expect(diskConfig().composio.gmailReadOnly).toEqual(binding);
    expectPublic((await api("GET", "/api/config")).body);
    expect((await api("DELETE", "/api/connectors/gmail")).status).toBe(403);
    expect(calls.some(call => call.method === "DELETE")).toBe(false);
  });

  it.each(["INITIATED", "INITIALIZING"])("reuses verified %s consent after server restart without creating another link", async status => {
    await readonlyMode();
    const first = await authorizeGmail();
    accountStatus = status;
    await stoppedFixture(); await startFixture();
    expect(await authorizeGmail()).toBe(first);
    expect(calls.filter(call => call.path.endsWith("/link"))).toHaveLength(1);
  });

  it.each(["FAILED", "EXPIRED", "INACTIVE", "REVOKED"])("permits a new explicit Connect after confirmed %s consent", async status => {
    await readonlyMode(); await authorizeGmail();
    accountStatus = status;
    calls = [];
    await authorizeGmail();
    expect(calls.filter(call => call.path.endsWith("/link"))).toHaveLength(1);
    const linkIndex = calls.findIndex(call => call.path.endsWith("/link"));
    expect(calls.slice(0, linkIndex).some(call => call.path === "/api/v3.1/connected_accounts")).toBe(true);
    expect(diskConfig().composio.gmailReadOnly.accountId).toBe("ca_fixture_gmail");
  });

  it("holds unknown, disabled, missing, and unverifiable bound accounts without replacing their receipt", async () => {
    await readonlyMode(); await authorizeGmail();
    for (const status of ["FUTURE_STATUS", "DISABLED", "ACTIVE"]) {
      accountStatus = status; await expectHeldConsent();
    }
    accountStatus = "INITIATED";
    missingAccount = true; await expectHeldConsent(); missingAccount = false;
    breakAuth = true; await expectHeldConsent(); breakAuth = false;
    expect(calls.filter(call => call.path.endsWith("/link"))).toHaveLength(1);
  });

  it.each(["unsafe-url", "expired", "too-long-lived", "missing-account"])("refuses persisted %s pending consent without starting another sign-in", async scenario => {
    await readonlyMode(); await authorizeGmail();
    await stoppedFixture();
    const config = diskConfig();
    const saved = config.composio.gmailReadOnly;
    if (scenario === "unsafe-url") saved.pendingLink.url = "https://example.invalid/not-provider-consent";
    if (scenario === "expired") saved.pendingLink.expiresAt = new Date(Date.now() - 1_000).toISOString();
    if (scenario === "too-long-lived") saved.pendingLink.expiresAt = new Date(Date.now() + 172_800_000).toISOString();
    if (scenario === "missing-account") delete saved.accountId;
    writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
    await startFixture();
    await expectHeldConsent();
  });

  it.each(["INITIATED", "INITIALIZING", "ACTIVE"])("reconciles a lost consent response to one %s account after restart without another provider POST", async status => {
    const initialReply = await loseConsentResponse();
    accountStatus = status;
    await stoppedFixture(); await startFixture();
    expect((await api("POST", "/api/bots/bud/messages", { text: "Connect Gmail" })).status).toBe(202);
    const reply = (await settledBud()).messages.at(-1).text;
    expect(reply).not.toContain("https://connect.composio.dev/fixture-consent");
    const binding = diskConfig().composio.gmailReadOnly;
    expect(binding.accountId).toBe("ca_fixture_gmail");
    expect(binding.linkUnknown).toBeUndefined(); expect(binding.pendingLink).toBeUndefined();
    expect(calls.filter(call => call.path.endsWith("/link"))).toHaveLength(1);
    await expectHeldConsent();
    expectPublic((await api("GET", "/api/config")).body);
    expect(reply).toMatch(/recovered/i);
    expect(initialReply).toMatch(/could not be confirmed|outcome is unknown/i);
    expect(initialReply).not.toContain("Nothing was sent or changed");
  });

  it("retains uncertain consent when no account, multiple accounts, an unsupported status, or failed verification prevents reconciliation", async () => {
    const initialReply = await loseConsentResponse();
    missingAccount = true; await expectHeldConsent(); missingAccount = false;
    ambiguousAccounts = true; await expectHeldConsent(); ambiguousAccounts = false;
    for (const status of ["DISABLED", "UNKNOWN", "FAILED"]) {
      accountStatus = status; await expectHeldConsent();
    }
    accountStatus = "INITIATED";
    breakAuth = true; await expectHeldConsent(); breakAuth = false;
    expect(diskConfig().composio.gmailReadOnly.linkUnknown.startedAt).toEqual(expect.any(String));
    expect(calls.filter(call => call.path.endsWith("/link"))).toHaveLength(1);
    expect(initialReply).not.toContain("Nothing was sent or changed");
  });

  it("checks the active readonly binding before generic project-key changes and rejects binding injection", async () => {
    await readonlyMode();
    await authorizeGmail();
    activeAccount = true;
    const before = readFileSync(join(dataDir, "config.json"), "utf8");
    expect((await api("PUT", "/api/config", { composio: { apiKey: BAD_PROJECT_KEY } })).status).toBe(403);
    expect(readFileSync(join(dataDir, "config.json"), "utf8")).toBe(before);
    for (const patch of [{ mode: "consumer" }, { gmailReadOnly: { authConfigId: AUTH_CONFIG, userId: "injected" } }]) {
      expect((await api("PUT", "/api/config", { composio: patch })).status).toBe(400);
    }
    calls = [];
    const updated = await api("PUT", "/api/config", { composio: { apiKey: NEXT_PROJECT_KEY } });
    expect(updated.status).toBe(200); expectPublic(updated.body);
    expect(calls.some(call => call.path === `/api/v3.1/auth_configs/${AUTH_CONFIG}`)).toBe(true);
    expect(diskConfig().composio.key).toBe(CONSUMER_KEY);
    expect(diskConfig().composio.gmailReadOnly).toEqual(JSON.parse(before).composio.gmailReadOnly);
    expect((await api("GET", "/api/connected-apps/status")).body.tools.available).toBe(true);
    expect((await api("POST", "/api/connected-apps/check", {})).body.tools.available).toBe(true);
    expect(calls.some(call => call.path === "/api/v3.1/connected_accounts")).toBe(true);
  });
});
