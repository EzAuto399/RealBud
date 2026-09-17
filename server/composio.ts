// Composio Platform — Connected apps use a project API key (ak_…) plus a
// tool-router session MCP. For You / Connect consumer keys (ck_…) are not used.
// Catalog logos still come from backend.composio.dev when the project key works.
import { createHash } from "node:crypto";
import type { AppConfig } from "./config.ts";

const PLATFORM_API = "https://backend.composio.dev/api/v3.1";
const BACKEND_URL = "https://backend.composio.dev/api/v3";
const PROJECT_KEY = /^ak_[a-zA-Z0-9_-]{6,512}$/;

class ComposioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComposioError";
  }
}

function parseJson(text: string): any {
  try { return JSON.parse(text); }
  catch { throw new ComposioError("invalid response"); }
}

function rpcResult(msg: any, id: string | number): any {
  if (msg?.jsonrpc !== "2.0" || msg.id !== id) throw new ComposioError("missing matching response");
  // Provider errors may include credentials or private tool inputs. Never echo them.
  if (msg.error) throw new ComposioError("request failed; check the connected app and try again");
  if (!msg.result || typeof msg.result !== "object" || Array.isArray(msg.result)) throw new ComposioError("invalid tool result");
  return msg.result;
}

function toolResult(result: any): any {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new ComposioError("invalid tool result");
  if (result.isError === true) throw new ComposioError("tool failed; check the connected app and try again");
  if (result.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)) {
    return checkedToolPayload(result.structuredContent);
  }
  if (!Array.isArray(result.content)) throw new ComposioError("invalid tool result");
  const content = result.content.filter((c: any) => c?.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text).join("\n");
  if (!content) return result;
  try { return checkedToolPayload(JSON.parse(content)); }
  catch (error) { if (error instanceof ComposioError) throw error; return { text: content }; }
}

function checkedToolPayload(value: any): any {
  if (value?.successful === false || value?.success === false || (value?.error != null && value.error !== "" && value.error !== false)) {
    throw new ComposioError("tool failed; check the connected app and try again");
  }
  return value;
}

export async function readMcpRpcResponse(res: Response, id: string | number = 1, signal?: AbortSignal): Promise<any> {
  if (!res.body) throw new ComposioError("empty response");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  let sse = res.headers.get("content-type")?.includes("text/event-stream") ?? false;
  let aborted: (() => void) | undefined;
  const abort = signal ? new Promise<never>((_resolve, reject) => {
    aborted = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
  }) : null;
  try {
    while (true) {
      const { value, done } = await (abort ? Promise.race([reader.read(), abort]) : reader.read());
      bytes += value?.byteLength ?? 0;
      if (bytes > 2_000_000) throw new ComposioError("response too large");
      buffer += decoder.decode(value, { stream: !done });
      // Some Connect deployments omit the content type. Recognise SSE fields,
      // not arbitrary text; JSON is decoded once its HTTP body is complete.
      if (!sse && /^\s*(?:data:|event:|id:|retry:|:)/.test(buffer)) sse = true;
      if (sse) {
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
          if (!data) continue;
          const msg = parseJson(data);
          if (msg?.id === id) return rpcResult(msg, id);
          // Progress notifications and other responses cannot settle this call.
        }
      }
      if (done) {
        if (sse) throw new ComposioError("missing matching response");
        return rpcResult(parseJson(buffer), id);
      }
    }
  } finally {
    if (aborted) signal?.removeEventListener("abort", aborted);
    // A matching SSE reply can arrive before the server closes its stream.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

const PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOLS = new Set([PROTOCOL_VERSION, "2025-03-26", "2024-11-05"]);
const MAX_SLUGS = 30;
const MAX_ACCOUNTS = 100;
const MAX_TOOLS = 500;
const record = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === "object" && !Array.isArray(value));

export function platformProjectKey(cfg: AppConfig): string {
  const key = cfg.composio?.key;
  if (!key) throw new ComposioError("No Connected apps key — save the Platform project API key (ak_…) in You.");
  if (typeof key !== "string") throw new ComposioError("Use the Platform project API key from Composio (ak_…).");
  if (key.startsWith("ck_")) {
    // Composio keeps developer and consumer as separate project surfaces with
    // separate connected accounts: an account connected in For You / Connect is not
    // visible to a Platform project, and vice versa. So a ck_ key is not merely the
    // wrong prefix here — pointing RealBud at the consumer surface would silently
    // show none of the office's connections. Say the practical consequence, because
    // the fix is a different action than re-pasting the same key.
    throw new ComposioError(
      "That is a consumer (ck_…) key for For You / Connect. RealBud needs the Platform project API key (ak_…) from the developer dashboard, and accounts must be connected there — a connection made in For You / Connect will not appear in a project.",
    );
  }
  if (!PROJECT_KEY.test(key)) throw new ComposioError("Use the Platform project API key from Composio (ak_…).");
  return key;
}

export function platformUserId(cfg: AppConfig): string {
  const saved = cfg.composio?.userId;
  if (typeof saved === "string" && /^[A-Za-z0-9._@:+-]{1,128}$/.test(saved)) return saved;
  const email = cfg.profile?.email?.trim();
  if (email && email.length <= 128 && /^[A-Za-z0-9._@:+-]+$/.test(email)) return email;
  // Compatibility only for an already configured legacy profile. First setup
  // persists an independent identity in connectedAppConfigPatch; company work
  // must supply its authenticated member binding instead of this fallback.
  return `realbud-${createHash("sha256").update(platformProjectKey(cfg)).digest("hex").slice(0, 16)}`;
}

function checkedEndpoint(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new ComposioError("invalid connected-app endpoint"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (raw.length > 2048 || url.username || url.password || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new ComposioError("Use an HTTPS connected-app endpoint without embedded credentials.");
  }
  return raw;
}

function sanitizeMcpHeaders(value: unknown, fallbackKey: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (record(value)) {
    for (const [name, header] of Object.entries(value)) {
      if (typeof name !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(name) || typeof header !== "string" ||
        !header || header.length > 4096 || /[\r\n\u0000]/.test(header)) {
        throw new ComposioError("invalid session credentials");
      }
      headers[name.toLowerCase()] = header;
    }
  }
  if (!headers["x-api-key"] && !headers["authorization"]) headers["x-api-key"] = fallbackKey;
  return headers;
}

/** Resolve the Platform session MCP endpoint (or an explicit test/stub URL). */
export async function resolveConnectedAppsMcp(cfg: AppConfig): Promise<{ key: string; url: string; headers: Record<string, string> }> {
  const key = platformProjectKey(cfg);
  if (cfg.composio?.url) {
    return { key, url: checkedEndpoint(cfg.composio.url), headers: { "x-api-key": key } };
  }
  const signal = AbortSignal.timeout(30_000);
  let response: Response;
  try {
    response = await fetch(`${PLATFORM_API}/tool_router/session`, {
      method: "POST", redirect: "error", signal,
      headers: { "x-api-key": key, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        user_id: platformUserId(cfg),
        manage_connections: { enable: true, enable_wait_for_connections: true, enable_connection_removal: true },
        mcp: true,
      }),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new ComposioError("request timed out; check connection status before retrying");
    }
    throw new ComposioError("connection interrupted; check connection status before retrying");
  }
  if (!response.ok || response.redirected) {
    await response.body?.cancel().catch(() => {});
    const hint = response.status === 401 || response.status === 403 ? "; check the Connected apps key and access" :
      response.status === 429 ? "; rate limited, try again later" : "";
    throw new ComposioError(response.redirected ? "redirects are not allowed; check the connected-app endpoint" : `HTTP ${response.status}${hint}`);
  }
  let body: any;
  try { body = await response.json(); } catch { throw new ComposioError("invalid session response"); }
  if (!record(body?.mcp) || typeof body.mcp.url !== "string") throw new ComposioError("the Platform session did not return an MCP endpoint");
  return { key, url: checkedEndpoint(body.mcp.url), headers: sanitizeMcpHeaders(body.mcp.headers, key) };
}

/** One initialized transport belongs to one setup operation and credential.
 * Calls within that operation reuse the session; concurrent accounts never do. */
class ConnectSession {
  private session: string | null = null;
  private protocol = PROTOCOL_VERSION;
  private nextId = 1;
  private readonly settings: { url: string; key: string; headers: Record<string, string> };
  private readonly signal = AbortSignal.timeout(30_000);

  constructor(settings: { url: string; key: string; headers: Record<string, string> }) { this.settings = settings; }

  private async post(message: Record<string, unknown>): Promise<Response> {
    this.signal.throwIfAborted();
    const response = await fetch(this.settings.url, {
      method: "POST", redirect: "error", signal: this.signal,
      headers: {
        "content-type": "application/json", accept: "application/json, text/event-stream",
        ...this.settings.headers,
        ...(message.method !== "initialize" ? { "mcp-protocol-version": this.protocol } : {}),
        ...(this.session ? { "mcp-session-id": this.session } : {}),
      },
      body: JSON.stringify(message),
    });
    if (!response.ok || response.redirected) {
      await response.body?.cancel().catch(() => {});
      const hint = response.status === 401 || response.status === 403 ? "; check the Connected apps key and access" :
        response.status === 429 ? "; rate limited, try again later" : "";
      throw new ComposioError(response.redirected ? "redirects are not allowed; check the connected-app endpoint" : `HTTP ${response.status}${hint}`);
    }
    const session = response.headers.get("mcp-session-id");
    if (session && (!/^[\x21-\x7e]{1,512}$/.test(session) || (message.method !== "initialize" && session !== this.session))) {
      await response.body?.cancel().catch(() => {});
      throw new ComposioError("invalid connection session");
    }
    if (message.method === "initialize") this.session = session;
    return response;
  }

  async initialize(): Promise<void> {
    const response = await this.post({ jsonrpc: "2.0", id: "initialize", method: "initialize", params: {
      protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "RealBud connection settings", version: "1.0.0" },
    } });
    const result = await readMcpRpcResponse(response, "initialize", this.signal);
    if (!SUPPORTED_PROTOCOLS.has(result.protocolVersion) || !record(result.capabilities) || !record(result.capabilities.tools) ||
      !record(result.serverInfo) || typeof result.serverInfo.name !== "string" || typeof result.serverInfo.version !== "string") {
      throw new ComposioError("the endpoint did not complete a supported tools handshake");
    }
    this.protocol = result.protocolVersion;
    const initialized = await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    await initialized.body?.cancel().catch(() => {});
  }

  private async rpc(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    return readMcpRpcResponse(response, id, this.signal);
  }

  async call(name: string, args: unknown): Promise<any> {
    if (typeof name !== "string" || !/^[a-zA-Z0-9_.-]{1,150}$/.test(name) || !record(args)) throw new ComposioError("invalid tool request");
    return toolResult(await this.rpc("tools/call", { name, arguments: args }));
  }

  async listTools(): Promise<Array<{ name: string; inputSchema: Record<string, any> }>> {
    const tools: Array<{ name: string; inputSchema: Record<string, any> }> = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await this.rpc("tools/list", cursor ? { cursor } : undefined);
      if (!Array.isArray(result.tools) || result.tools.length + tools.length > MAX_TOOLS) throw new ComposioError("invalid tools metadata");
      for (const tool of result.tools) {
        if (!record(tool) || typeof tool.name !== "string" || !/^[a-zA-Z0-9_.-]{1,150}$/.test(tool.name) || names.has(tool.name) ||
          !record(tool.inputSchema) || tool.inputSchema.type !== "object" ||
          (tool.description !== undefined && typeof tool.description !== "string") ||
          (tool.inputSchema.properties !== undefined && !record(tool.inputSchema.properties)) ||
          (tool.inputSchema.required !== undefined && (!Array.isArray(tool.inputSchema.required) || !tool.inputSchema.required.every((name: unknown) => typeof name === "string")))) {
          throw new ComposioError("invalid tools metadata");
        }
        names.add(tool.name);
        tools.push({ name: tool.name, inputSchema: tool.inputSchema });
      }
      if (result.nextCursor != null && (typeof result.nextCursor !== "string" || !result.nextCursor || result.nextCursor.length > 1000 || cursors.has(result.nextCursor) || cursors.size >= 9)) {
        throw new ComposioError("invalid tools pagination");
      }
      cursor = result.nextCursor ?? undefined;
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return tools;
  }
}

async function withConnect<T>(cfg: AppConfig, work: (session: ConnectSession) => Promise<T>): Promise<T> {
  try {
    const mcp = await resolveConnectedAppsMcp(cfg);
    const session = new ConnectSession(mcp);
    await session.initialize();
    return await work(session);
  } catch (error) {
    if (error instanceof ComposioError) throw error;
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new ComposioError("request timed out; check connection status before retrying");
    }
    throw new ComposioError("connection interrupted; check connection status before retrying");
  }
}

export async function composioTool(cfg: AppConfig, name: string, args: unknown) {
  return withConnect(cfg, (session) => session.call(name, args));
}

function checkedSlugs(slugs: string[]): string[] {
  if (!Array.isArray(slugs) || !slugs.length || slugs.length > MAX_SLUGS || slugs.some((slug) => typeof slug !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(slug))) {
    throw new ComposioError("Choose between 1 and 30 valid app names.");
  }
  return [...new Set(slugs)];
}

export interface ConnectionServiceStatus {
  connected: boolean;
  status: string;
  accounts: Array<{ id: string; label?: string; status: string }>;
  accountSelectionRequired: boolean;
}

function accountText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}

function parseConnectionStatus(out: any, slugs: string[]): Record<string, ConnectionServiceStatus> {
  const results = out?.data?.results;
  if (!record(results)) throw new ComposioError("invalid connection status");
  const services: Record<string, ConnectionServiceStatus> = {};
  for (const slug of slugs) {
    const row = results[slug];
    if (row != null && !record(row)) throw new ComposioError("invalid connection status");
    if (row?.status != null && !accountText(row.status, 100)) throw new ComposioError("invalid connection status");
    if (row?.accounts != null && (!Array.isArray(row.accounts) || row.accounts.length > MAX_ACCOUNTS)) throw new ComposioError("invalid connection status");
    const accounts: ConnectionServiceStatus["accounts"] = [];
    const ids = new Set<string>();
    let activeCount = 0;
    for (const account of row?.accounts ?? []) {
      if (!record(account) || (account.status != null && !accountText(account.status, 100))) throw new ComposioError("invalid connection status");
      const status = account.status ?? "unknown";
      if (/^active$/i.test(status)) activeCount += 1;
      const id = account.id ?? account.account_id ?? account.nanoid;
      // An aggregate ACTIVE flag without identity is useful status evidence,
      // but must never fabricate an account that a PM could select.
      if (id == null) continue;
      if (!accountText(id, 200) || ids.has(id)) throw new ComposioError("invalid connection status");
      const label = account.label ?? account.name ?? account.account_name ?? account.email;
      if (label != null && !accountText(label, 200)) throw new ComposioError("invalid connection status");
      ids.add(id);
      accounts.push({ id, ...(label == null ? {} : { label }), status });
    }
    services[slug] = {
      connected: Array.isArray(row?.accounts) ? activeCount > 0 : /^active$/i.test(row?.status ?? ""),
      status: row?.status ?? "unknown", accounts, accountSelectionRequired: activeCount > 1,
    };
  }
  return services;
}

const listConnections = (session: ConnectSession, slugs: string[]) => session.call("COMPOSIO_MANAGE_CONNECTIONS", {
  toolkits: slugs.map((name) => ({ name, action: "list" })),
});

async function listAccountsByToolkit(cfg: AppConfig, slugs: string[]): Promise<Record<string, ConnectionServiceStatus>> {
  const key = platformProjectKey(cfg);
  const userId = platformUserId(cfg);
  const signal = AbortSignal.timeout(30_000);
  const params = new URLSearchParams();
  params.set("limit", "100");
  for (const slug of slugs) params.append("toolkit_slugs", slug);
  params.append("user_ids", userId);
  params.set("account_type", "PRIVATE");
  let response: Response;
  try {
    response = await fetch(`${PLATFORM_API}/connected_accounts?${params}`, {
      method: "GET", redirect: "error", signal,
      headers: { "x-api-key": key, accept: "application/json" },
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new ComposioError("request timed out; check connection status before retrying");
    }
    throw new ComposioError("connection interrupted; check connection status before retrying");
  }
  if (!response.ok || response.redirected) {
    await response.body?.cancel().catch(() => {});
    const hint = response.status === 401 || response.status === 403 ? "; check the Connected apps key and access" :
      response.status === 429 ? "; rate limited, try again later" : "";
    throw new ComposioError(response.redirected ? "redirects are not allowed; check the connected-app endpoint" : `HTTP ${response.status}${hint}`);
  }
  let body: any;
  try { body = await response.json(); } catch { throw new ComposioError("invalid connection status"); }
  if (!Array.isArray(body?.items) || body.items.length > MAX_ACCOUNTS) throw new ComposioError("invalid connection status");
  if (body.next_cursor) throw new ComposioError("Connection listing is incomplete. Narrow the app selection and check access again.");
  const services: Record<string, ConnectionServiceStatus> = {};
  const seen = new Set<string>();
  for (const slug of slugs) services[slug] = { connected: false, status: "unknown", accounts: [], accountSelectionRequired: false };
  for (const item of body.items) {
    if (!record(item) || !record(item.toolkit) || typeof item.toolkit.slug !== "string") throw new ComposioError("invalid connection status");
    // The project key can see many users. Verify the returned owner as well as
    // sending the filter; never expose a foreign or unbound account to staff.
    if (item.user_id !== userId || item.experimental?.account_type !== "PRIVATE") throw new ComposioError("Connected account ownership could not be verified. Check the account binding.");
    const slug = item.toolkit.slug.toLowerCase();
    if (!services[slug]) continue;
    if (!accountText(item.id, 200) || (item.status != null && !accountText(item.status, 100))) throw new ComposioError("invalid connection status");
    if (seen.has(item.id)) throw new ComposioError("invalid connection status");
    seen.add(item.id);
    const status = item.is_disabled === true ? "DISABLED" : item.status ?? "unknown";
    const label = item.alias ?? item.word_id;
    if (label != null && !accountText(label, 200)) throw new ComposioError("invalid connection status");
    services[slug].accounts.push({ id: item.id, ...(label == null ? {} : { label }), status });
  }
  for (const service of Object.values(services)) {
    const active = service.accounts.filter((account) => /^active$/i.test(account.status));
    service.connected = active.length > 0;
    service.status = active[0]?.status ?? service.accounts[0]?.status ?? "unknown";
    service.accountSelectionRequired = active.length > 1;
  }
  return services;
}

/** Read only: never substitute the newer string-array form which may initiate
 * authorization for a missing connection. Platform uses REST account listing. */
export async function connectionStatus(cfg: AppConfig, slugs: string[]) {
  const names = checkedSlugs(slugs);
  if (!cfg.composio?.url) return listAccountsByToolkit(cfg, names);
  return withConnect(cfg, async (session) => parseConnectionStatus(await listConnections(session, names), names));
}

export async function checkConnectionAccess(cfg: AppConfig, slugs = [...new Set([...CURATED_SLUGS, ...(cfg.composio?.officeApps ?? [])])]) {
  if (!Array.isArray(slugs) || !slugs.length || slugs.length > 100) throw new ComposioError("Choose between 1 and 100 office apps to check.");
  const names = slugs;
  for (let offset = 0; offset < names.length; offset += MAX_SLUGS) checkedSlugs(names.slice(offset, offset + MAX_SLUGS));
  return withConnect(cfg, async (session) => {
    const tools = await session.listTools();
    const manage = tools.find((tool) => tool.name === "COMPOSIO_MANAGE_CONNECTIONS");
    const itemType = manage?.inputSchema.properties?.toolkits?.items?.type;
    // Platform Tool Router exposes string[] toolkits that may start OAuth.
    // Prefer REST account listing there; keep the object list form for stubs.
    let services: Record<string, ConnectionServiceStatus> = {};
    if (manage && itemType !== "string") {
      for (let offset = 0; offset < names.length; offset += MAX_SLUGS) {
        const batch = names.slice(offset, offset + MAX_SLUGS);
        Object.assign(services, parseConnectionStatus(await listConnections(session, batch), batch));
      }
    } else if (!cfg.composio?.url) {
      for (let offset = 0; offset < names.length; offset += MAX_SLUGS) {
        Object.assign(services, await listAccountsByToolkit(cfg, names.slice(offset, offset + MAX_SLUGS)));
      }
    } else {
      throw new ComposioError("This endpoint does not expose the supported read-only connection list. Use Composio Platform settings to check its accounts.");
    }
    const toolNames = tools.map((tool) => tool.name);
    return {
      checkedAt: new Date().toISOString(), services,
      tools: { available: toolNames.includes("COMPOSIO_SEARCH_TOOLS") && toolNames.includes("COMPOSIO_MULTI_EXECUTE_TOOL"), names: toolNames },
    };
  });
}

/** Disconnect a service: remove only exact provider-supplied account IDs. */
export async function removeService(cfg: AppConfig, slug: string) {
  const names = checkedSlugs([slug]);
  return withConnect(cfg, async (session) => {
    const status = parseConnectionStatus(await listConnections(session, names), names)[slug];
    for (const account of status.accounts) await session.call("COMPOSIO_MANAGE_CONNECTIONS", {
      toolkits: [{ name: slug, action: "remove", account_id: account.id }],
    });
    return { removed: status.accounts.length };
  });
}

function authorizationUrl(value: unknown): string | null {
  if (!accountText(value, 4096) || value.trim() !== value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/\.$/, "").toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || host === "localhost" || host.endsWith(".localhost") ||
      host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".") ||
      /^(?:\d+\.){3}\d+$/.test(host) || host.startsWith("[")) return null;
    return url.href;
  } catch { return null; }
}

/** Only structured authorization fields can open a sign-in flow; prose,
 * arbitrary result URLs and links hidden in error text are never candidates. */
export async function authorizeService(cfg: AppConfig, slug: string) {
  checkedSlugs([slug]);
  const out = await composioTool(cfg, "COMPOSIO_MANAGE_CONNECTIONS", { toolkits: [{ name: slug, action: "add" }] });
  const candidates = [out?.data?.results?.[slug], out?.data, out];
  for (const row of candidates) {
    if (!record(row)) continue;
    for (const field of ["redirect_url", "redirectUrl", "authorization_url", "authorizationUrl", "auth_url", "authUrl"]) {
      if (row[field] === undefined) continue;
      const url = authorizationUrl(row[field]);
      if (!url) throw new ComposioError("the authorization link was not a secure URL");
      return { url };
    }
  }
  throw new ComposioError(`No authorization link was returned for ${slug}. Check the app connection before starting a new sign-in.`);
}

// ── marketplace catalog ────────────────────────────────────────────────
export interface ToolkitCard {
  slug: string;
  label: string;
  blurb: string;
  logo: string | null;
  /** used for the client-side favicon fallback when logo is null/broken */
  domain: string | null;
}

// Curated fallback — the services agentcal's connectors page ships plus the
// long marketplace tail. Logos resolve client-side:
// logo → favicon(domain) → monogram.
const CURATED: ToolkitCard[] = [
  { slug: "outlook", label: "Outlook", blurb: "Office email", domain: "outlook.com", logo: null },
  { slug: "instagram", label: "Instagram", blurb: "Your Instagram account", domain: "instagram.com", logo: null },
  { slug: "slack", label: "Slack", blurb: "Post updates and read channels", domain: "slack.com", logo: null },
  { slug: "github", label: "GitHub", blurb: "Issues, pull requests, and code", domain: "github.com", logo: null },
  { slug: "gmail", label: "Gmail", blurb: "Read and send email", domain: "gmail.com", logo: null },
  { slug: "googlecalendar", label: "Google Calendar", blurb: "Read and create events", domain: "calendar.google.com", logo: null },
  { slug: "googlesheets", label: "Google Sheets", blurb: "Read and update spreadsheets", domain: "sheets.google.com", logo: null },
  { slug: "googledocs", label: "Google Docs", blurb: "Read and write documents", domain: "docs.google.com", logo: null },
  { slug: "googledrive", label: "Google Drive", blurb: "Browse and manage files", domain: "drive.google.com", logo: null },
  { slug: "notion", label: "Notion", blurb: "Pages and databases", domain: "notion.so", logo: null },
  { slug: "linear", label: "Linear", blurb: "Issues and project tracking", domain: "linear.app", logo: null },
  { slug: "sentry", label: "Sentry", blurb: "Errors and alerts", domain: "sentry.io", logo: null },
  { slug: "posthog", label: "PostHog", blurb: "Analytics, feature flags, experiments", domain: "posthog.com", logo: null },
  { slug: "discord", label: "Discord", blurb: "Messages and channels", domain: "discord.com", logo: null },
  { slug: "x", label: "X (Twitter)", blurb: "Post and read on X", domain: "x.com", logo: null },
  { slug: "reddit", label: "Reddit", blurb: "Browse and post", domain: "reddit.com", logo: null },
  { slug: "zapier", label: "Zapier", blurb: "Connect 9,000+ apps", domain: "zapier.com", logo: null },
  { slug: "hubspot", label: "HubSpot", blurb: "CRM search & updates", domain: "hubspot.com", logo: null },
  { slug: "salesforce", label: "Salesforce", blurb: "CRM records and reports", domain: "salesforce.com", logo: null },
  { slug: "jira", label: "Jira", blurb: "Issues and sprints", domain: "atlassian.com", logo: null },
  { slug: "asana", label: "Asana", blurb: "Tasks and projects", domain: "asana.com", logo: null },
  { slug: "trello", label: "Trello", blurb: "Boards and cards", domain: "trello.com", logo: null },
  { slug: "dropbox", label: "Dropbox", blurb: "Files and folders", domain: "dropbox.com", logo: null },
  { slug: "airtable", label: "Airtable", blurb: "Bases and records", domain: "airtable.com", logo: null },
  { slug: "figma", label: "Figma", blurb: "Files and comments", domain: "figma.com", logo: null },
  { slug: "stripe", label: "Stripe", blurb: "Payments and customers", domain: "stripe.com", logo: null },
];

let toolkitCache: { at: number; cards: ToolkitCard[] } | null = null;

/**
 * Marketplace catalog. Tries the v3 toolkits API (official names,
 * descriptions, logos — cached 10 min); falls back to the curated list.
 */
export async function listToolkits(cfg: AppConfig): Promise<{ cards: ToolkitCard[]; source: "api" | "curated" }> {
  if (toolkitCache && Date.now() - toolkitCache.at < 10 * 60_000) {
    return { cards: toolkitCache.cards, source: "api" };
  }
  const backendKey = cfg.composio?.apiKey ?? cfg.composio?.key;
  if (backendKey) {
    try {
      const res = await fetch(`${BACKEND_URL}/toolkits?limit=500&sort_by=usage`, {
        headers: { "x-api-key": backendKey },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const json: any = await res.json();
        const items = json.items ?? json.data ?? [];
        if (Array.isArray(items) && items.length) {
          const cards: ToolkitCard[] = items.map((t: any) => ({
            slug: (t.slug ?? t.key ?? t.name ?? "").toLowerCase(),
            label: t.name ?? t.slug ?? "",
            blurb: (t.meta?.description ?? t.description ?? "").slice(0, 90),
            logo: t.meta?.logo ?? t.logo ?? null,
            domain: null,
          }));
          toolkitCache = { at: Date.now(), cards };
          return { cards, source: "api" };
        }
      }
    } catch {
      /* fall through to curated */
    }
  }
  return { cards: CURATED, source: "curated" };
}

export const CURATED_SLUGS = CURATED.map((c) => c.slug);
