import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import {
  CONNECTOR_ID, CONNECTOR_REASONS, connectorCallbackPath, parseConnectorStart, parseConnectorState,
  type ConnectorAccount, type ConnectorAction, type ConnectorStart, type ConnectorState,
} from '../shared/mcp-connector.ts';
import { readMcpRpcResponse } from './composio.ts';
import { pinnedLookup, publicAddress } from './web-research-broker.ts';
import { redactSecrets, redactSecretsInText } from './redact.ts';
import { workLedger, type WorkLedger } from './work-ledger.ts';

/**
 * Generic connector core: one OAuth-connected MCP server per workspace.
 * - MCP auth discovery (401 → protected-resource → authorization-server metadata),
 *   dynamic registration as a public client, PKCE S256, single-use state,
 *   `iss` check, RFC 8707 `resource`, loopback redirect per connector id.
 * - Tokens only in the encrypted private vault, keyed by connector + workspace;
 *   refresh serialized; invalid_grant → needs_reconnect; disconnect deletes
 *   locally first, then revokes best effort.
 * - Egress pinned to the server origin and its authorization-server origin:
 *   every request resolves the name, requires every answer to be public, and
 *   connects to that exact address (TLS still verifies the host name), so a
 *   DNS answer cannot rebind a connection to a private address.
 * - The MCP client calls only allowlisted `read` tools; anything else is
 *   refused before any request. One audit receipt per call, no bodies.
 * Connector-specific mapping (e.g. Redbark bank rows) lives in its preset.
 */

export type ToolClass = 'read' | 'write' | 'consequential';
/** The card the person allowed for one call. */
export type Approval = 'write' | 'consequential';
export type ConnectorCall = (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
/** One tool as the server lists it. Every field is untrusted server text. */
export interface RemoteTool {
  name: string; description: string; inputSchema: Record<string, unknown>; annotations: { readOnlyHint?: unknown; destructiveHint?: unknown } | null;
  /** sha256 of the complete raw listing (name, full description, raw schema, all annotations; canonical JSON),
   * taken before any truncation or redaction; null when the raw listing is over MAX_RAW_TOOL. */
  rawHash: string | null;
}
/** A single tool's raw listing above this is never hashed in part: the connector is quarantined instead. */
export const MAX_RAW_TOOL = 64_000;
/** Canonical JSON: sorted keys at every level. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export type ListTools = () => Promise<RemoteTool[]>;
export const MAX_REMOTE_TOOLS = 300;
export interface McpConnectorConfig {
  id: string;
  label: string;
  serverUrl: string;
  scopes: readonly string[];
  /** Tools Bud may call, by class. A function is read on every call (a registry's reviewed list). */
  allowlist: Readonly<Record<string, ToolClass>> | (() => Readonly<Record<string, ToolClass>>);
  /** 'oauth' (default) or 'header': a bearer token entered once by the office owner. */
  auth?: 'oauth' | 'header';
  /** If set, the protected-resource metadata must name exactly this origin. */
  authorizationServer?: string;
  /** Arguments every call carries (e.g. Redbark's required `context`). */
  defaultArgs?: Record<string, unknown>;
  /** Checked inside every serialized credential commit (registry removal epochs). */
  committable?: () => boolean;
  /** A read that proves the grant works; returns a display label. */
  verify: (call: ConnectorCall, listTools: ListTools) => Promise<string>;
}
export interface ConnectorVault {
  read(name: string): Promise<unknown | undefined>;
  write(name: string, value: unknown): Promise<void>;
  remove(name: string): Promise<void>;
}
export type ConnectorAuthority = 'manage' | 'read';
/** One request's authority, bound to who asked. `stillManages` re-checks that
 * same identity later (OAuth callbacks arrive without a RealBud request). */
export interface ConnectorGrant { authority: ConnectorAuthority; principal: string; stillManages: () => Promise<boolean> }
export type Resolver = (hostname: string) => Promise<Array<{ address: string }>>;
export interface PinnedAddress { address: string; family: 4 | 6 }
export interface TransportInit { method?: string; headers?: Record<string, string>; body?: string; signal: AbortSignal }
/** Sends one request to `address` while keeping the URL's host for SNI, the certificate check and Host. */
export type ConnectorTransport = (url: string, init: TransportInit, address: PinnedAddress) => Promise<Response>;
export interface ConnectorReceipt { connector: string; tool: string; outcome: 'succeeded' | 'failed' | 'refused'; at: number }
export interface McpConnectorOptions {
  vault: ConnectorVault;
  workspaceId: () => string;
  /** The verified RealBud person's office authority for this request. */
  authorize: (request: IncomingMessage) => Promise<ConnectorGrant>;
  /** `http://127.0.0.1:<RealBud port>`; the redirect is re-registered when it changes. */
  redirectBase: () => string;
  transport?: ConnectorTransport;
  resolve?: Resolver;
  now?: () => number;
  random?: (bytes: number) => Buffer;
  audit?: (receipt: ConnectorReceipt) => void;
  /** Defaults to the process-wide ledger an update restart reads. */
  workLedger?: WorkLedger;
}

type ErrorCode = 'unavailable' | 'needs_reconnect' | 'not_connected' | 'stale' | 'forbidden' | 'invalid_request';
export class ConnectorError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  constructor(code: ErrorCode, message: string, status = 409) { super(message); this.name = 'ConnectorError'; this.code = code; this.status = status; }
}
/** Logs an unexpected (non-ConnectorError) failure so the service log shows its
 * cause: name, message and the first stack frames, redacted. Never bodies or tokens. */
export function logUnexpected(where: string, error: unknown): void {
  const text = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`).split('\n').slice(0, 5).join('\n') : typeof error;
  console.error(`[connectors] ${where} failed unexpectedly: ${redactSecretsInText(text)}`);
}
export class McpToolError extends Error {
  readonly code: 'unauthorized' | 'unavailable' | 'invalid' | 'refused';
  constructor(code: 'unauthorized' | 'unavailable' | 'invalid' | 'refused') {
    super(code === 'unauthorized' ? 'The service refused the connection.' : code === 'invalid' ? 'The service returned an unverified reply.'
      : code === 'refused' ? 'RealBud does not use that tool.' : 'The service could not be reached.');
    this.name = 'McpToolError';
    this.code = code;
  }
}

interface Discovery { authorize: string; token: string; register: string; revoke: string | null; issuer: string; resource: string; issParameter: boolean }
interface Tokens { accessToken: string; refreshToken: string | null; expiresAt: number; clientId: string }
interface ConnectorRecord {
  version: 1; connector: string; workspaceId: string; generation: number;
  status: 'not_connected' | 'connected' | 'needs_reconnect';
  reason: string | null; account: ConnectorAccount | null; tokens: Tokens | null;
}
interface ClientRecord { version: 1; issuer: string; redirectUri: string; clientId: string }
interface Pending {
  key: string; workspaceId: string; generation: number; verifier: string; redirectUri: string; clientId: string; expiresAt: number;
  principal: string; stillManages: () => Promise<boolean>;
}
export interface ConnectorCallbackPage { status: number; headers: Record<string, string>; body: string }

const HEADER_CLIENT = 'header-token';
const STATE_LIFETIME = 10 * 60_000, DISCOVERY_LIFETIME = 5 * 60_000, REFRESH_MARGIN = 60_000, TIMEOUT = 20_000;
const REASONS = CONNECTOR_REASONS;
const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOLS = new Set([PROTOCOL_VERSION, '2025-03-26']);

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const opaque = (v: unknown, max = 8192): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && /^[\x21-\x7e]+$/.test(v);

/** https, no credentials, port or fragment. DNS is checked separately. */
function httpsUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash ? url : null;
  } catch { return null; }
}

const defaultResolver: Resolver = hostname => lookup(hostname, { all: true, verbatim: true });

/** Resolves a connector host and returns the address to pin. Loopback,
 * private, link-local, CGNAT and metadata answers are refused: one non-public
 * answer refuses the whole name. Plain http is refused. */
export async function publicServerAddress(value: string, resolve: Resolver = defaultResolver, signal?: AbortSignal): Promise<PinnedAddress> {
  const url = httpsUrl(value);
  if (!url) throw new ConnectorError('unavailable', REASONS.notVerified, 503);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let answers: Array<{ address: string }>;
  if (isIP(host)) answers = [{ address: host }];
  else if (host === 'localhost' || host.endsWith('.localhost')) answers = [];
  else {
    // Resolution shares the request's deadline: a stalled resolver cannot outlive it.
    try {
      if (signal?.aborted) throw signal.reason;
      answers = await (signal ? Promise.race([resolve(host), new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]) : resolve(host));
    } catch { throw new ConnectorError('unavailable', REASONS.unreachable, 503); }
  }
  if (!answers.length || answers.some(answer => !publicAddress(answer.address))) throw new ConnectorError('unavailable', REASONS.notVerified, 503);
  return { address: answers[0]!.address, family: isIP(answers[0]!.address) === 6 ? 6 : 4 };
}

/** Node http(s) connected to the checked address only: no second DNS lookup.
 * Redirects are never followed (a 3xx is returned as-is). */
export const pinnedTransport: ConnectorTransport = (url, init, address) => new Promise((resolve, reject) => {
  const target = new URL(url);
  const client = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const headers = { ...init.headers, ...(init.body !== undefined ? { 'content-length': String(Buffer.byteLength(init.body)) } : {}) };
  const req = client(target, { method: init.method ?? 'GET', headers, signal: init.signal, agent: false, lookup: pinnedLookup(address) }, res => {
    try {
      const status = res.statusCode ?? 0;
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(res.headers)) if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
      const empty = status === 204 || status === 304 || init.method === 'HEAD';
      if (empty) res.resume();
      resolve(new Response(empty ? null : Readable.toWeb(res) as ReadableStream<Uint8Array>, { status, headers: responseHeaders }));
    } catch (error) { res.destroy(); reject(error); }
  });
  req.once('error', reject);
  req.end(init.body);
});

/** Who may connect or disconnect an office connector. Every caller has
 * already passed the per-boot RealBud session gate.
 * - A service admin: manage.
 * - Single seat (this private workspace was never bound to an office
 *   membership, so `seatIdentity()` is null): the local person owns this
 *   RealBud and the office, so manage.
 * - Company mode: only the office owner whose member session matches this
 *   seat manages; members and anything unverifiable read.
 * A damaged seat record throws, and the connector treats that as read.
 * `stillManages` re-runs this with the same request headers (kept in memory
 * only, for the life of one sign-in) and requires the same principal. */
/** One abort controller per stored connection, keyed by connection key. A newer
 * generation aborts and replaces the older controller; an older generation is
 * rejected on its own and never aborts or replaces the current one. */
export function createLiveSignals() {
  const live = new Map<string, { generation: number; controller: AbortController }>();
  return {
    signal(key: string, generation: number): AbortSignal {
      let entry = live.get(key);
      if (entry && generation < entry.generation) return AbortSignal.abort();
      if (!entry || entry.generation !== generation) {
        entry?.controller.abort();
        entry = { generation, controller: new AbortController() };
        live.set(key, entry);
      }
      return entry.controller.signal;
    },
    retire(key: string) { live.get(key)?.controller.abort(); live.delete(key); },
    retireAll() { for (const entry of live.values()) entry.controller.abort(); live.clear(); },
  };
}

export function officeAuthority(deps: {
  serviceAdmin: (request: Pick<IncomingMessage, 'headers'>) => boolean;
  seatIdentity: () => Promise<string | null>;
  companyMe: (request: Pick<IncomingMessage, 'headers'>) => Promise<{ status: number; body: unknown }>;
}): (request: Pick<IncomingMessage, 'headers'>) => Promise<ConnectorGrant> {
  const evaluate = async (request: Pick<IncomingMessage, 'headers'>): Promise<{ authority: ConnectorAuthority; principal: string }> => {
    if (deps.serviceAdmin(request)) return { authority: 'manage', principal: 'service-admin' };
    const seat = await deps.seatIdentity();
    if (seat === null) return { authority: 'manage', principal: 'single-seat' };
    const me = await deps.companyMe(request).catch(() => null);
    const member = me?.status === 200 && object(me.body) && object(me.body.member) ? me.body.member : null;
    const principal = typeof member?.id === 'string' ? `member:${member.id}` : 'unverified';
    return { authority: member?.id === seat && member.role === 'owner' ? 'manage' : 'read', principal };
  };
  return async request => {
    const held = { headers: { ...request.headers } };
    const first = await evaluate(held);
    return { ...first, stillManages: async () => {
      try { const again = await evaluate(held); return again.authority === 'manage' && again.principal === first.principal; }
      catch { return false; }
    } };
  };
}

/** Reads a body up to `max` bytes, cancelling the stream as soon as it is exceeded. */
export async function readCapped(response: Response, max: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) throw new McpToolError('invalid');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

/** Only the opaque `page` token from a list's `next_page_url` is used; the URL
 * itself (which may name a foreign host) is never requested. */
export function nextPageToken(list: Record<string, unknown>, seen: Set<string>): string | null {
  const next = list.next_page_url;
  if (next === null || next === undefined) return null;
  if (typeof next !== 'string' || next.length > 4096) throw new McpToolError('invalid');
  let token: string | null;
  try { token = new URL(next, 'https://page-token.invalid/').searchParams.get('page'); } catch { throw new McpToolError('invalid'); }
  if (!opaque(token, 2048) || seen.has(token)) throw new McpToolError('invalid');
  seen.add(token);
  return token;
}

/** Removes this connection's own credentials and credential-shaped text from
 * anything the service returns (tool metadata, schemas, results), so an echoed
 * bearer never reaches storage or Bud. */
export function scrubCredentials<T>(value: T, secrets: readonly (string | null | undefined)[]): T {
  // Every accepted credential, whatever its length, is replaced exactly in
  // every string and key; generic credential patterns are redacted as well.
  const known = secrets.filter((secret): secret is string => typeof secret === 'string' && secret.length > 0).sort((a, b) => b.length - a.length);
  const clean = (text: string) => known.reduce((current, secret) => current.split(secret).join('[redacted]'), text);
  const walk = (item: unknown, depth: number): unknown => {
    if (typeof item === 'string') return clean(item);
    if (!item || typeof item !== 'object') return item;
    // Fail closed: anything nested deeper than the scrubber walks is refused, never passed through.
    if (depth > 64) throw new McpToolError('invalid');
    if (Array.isArray(item)) return item.map(entry => walk(entry, depth + 1));
    return Object.fromEntries(Object.entries(item).map(([key, entry]) => [clean(key), walk(entry, depth + 1)]));
  };
  return redactSecrets(walk(value, 0)) as T;
}

// ── Callback page: self-contained, no scripts, no external assets ──────────
const PAGE_STYLE = 'body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f7f7f5;color:#1d1d1b}main{max-width:28rem;padding:2rem;text-align:center}@media (prefers-color-scheme:dark){body{background:#1b1b1a;color:#ececea}}';
const PAGE_CSP = `default-src 'none'; style-src 'sha256-${createHash('sha256').update(PAGE_STYLE).digest('base64')}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
const PAGES = {
  connected: 'Connected. You can return to RealBud.',
  expired: 'This sign-in link has expired or was already used. Return to RealBud and choose Connect again.',
  cancelled: 'Sign-in was not completed. Return to RealBud and try again.',
  changed: 'The connection changed while you were signing in. Return to RealBud and connect again.',
  forbidden: 'Only the office owner or an administrator can finish this connection. Nothing was saved.',
  tooBroad: REASONS.tooBroad,
  failed: 'The service could not be connected. Return to RealBud and try again.',
} as const;
function page(kind: keyof typeof PAGES): ConnectorCallbackPage {
  return {
    status: kind === 'connected' ? 200 : 400,
    headers: {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', pragma: 'no-cache',
      'content-security-policy': PAGE_CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
    },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RealBud · Connection</title><style>${PAGE_STYLE}</style></head><body><main><p>${PAGES[kind]}</p></main></body></html>`,
  };
}

export function createMcpConnector(config: McpConnectorConfig, options: McpConnectorOptions) {
  const server = httpsUrl(config.serverUrl);
  if (!CONNECTOR_ID.test(config.id) || !server || config.scopes.some(scope => !/^[\x21-\x7e]{1,100}$/.test(scope))) {
    throw new Error('Invalid connector configuration.');
  }
  const transport = options.transport ?? pinnedTransport;
  const resolve = options.resolve ?? defaultResolver;
  const now = options.now ?? Date.now;
  const random = options.random ?? randomBytes;
  const scope = config.scopes.join(' ');
  const headerMode = config.auth === 'header';
  const allowlist = () => typeof config.allowlist === 'function' ? config.allowlist() : config.allowlist;
  const callbackPath = connectorCallbackPath(config.id);
  const clientEntry = `connector-client-${config.id}`;
  const closing = new AbortController();
  const pending = new Map<string, Pending>();
  // A sign-in the person has open in their browser lives only in this process: a restart turns its callback into
  // "expired", so it waits on the person until it completes or its link lapses. Counted, never shown.
  const releaseWork = (options.workLedger ?? workLedger).probe('connector-sign-in', () => {
    let waiting = 0;
    for (const entry of pending.values()) if (entry.expiresAt > now()) waiting++;
    return { waiting };
  });
  const transient = new Map<string, { generation: number; reason: string }>();
  const chains = new Map<string, Promise<unknown>>();
  const refreshing = new Map<string, Promise<Tokens>>();
  const receipts: ConnectorReceipt[] = [];
  /** One AbortController per stored generation: retiring a generation aborts its in-flight reads. */
  const liveSignals = createLiveSignals();
  const liveSignal = liveSignals.signal;
  const retire = liveSignals.retire;
  /** Set once on removal: this instance never commits credentials again. */
  let removed = false;
  const refuseIfRemoved = () => { if (removed || closing.signal.aborted || (config.committable && !config.committable())) throw new ConnectorError('stale', 'This connector was removed.', 409); };
  const dropPending = (key: string) => { for (const [state, entry] of pending) if (entry.key === key) pending.delete(state); };
  /** Egress allowlist: the server origin, plus the issuer once discovered. */
  const origins = new Set([server.origin]);
  let discovery: { value: Discovery; until: number } | null = null;
  let discovering: Promise<Discovery> | null = null;
  let registering: Promise<string> | null = null;

  const unavailable = (reason: string = REASONS.unreachable) => new ConnectorError('unavailable', reason, 503);
  const reconnect = (reason: string = REASONS.signInAgain) => new ConnectorError('needs_reconnect', reason, 409);
  const stale = () => new ConnectorError('stale', 'This connection changed. Use the current connection.', 409);
  const notConnected = () => new ConnectorError('not_connected', `Connect ${config.label} first.`, 409);
  const forbidden = () => new ConnectorError('forbidden', 'Only the office owner or an administrator can change this connection.', 403);

  function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const run = (chains.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    const tail = run.catch(() => {});
    chains.set(key, tail);
    void tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
    return run;
  }

  const signal = () => AbortSignal.any([closing.signal, AbortSignal.timeout(TIMEOUT)]);
  /** Every outbound request: allowed origins only, resolved and pinned to a
   * public address per request, no redirects followed. */
  async function egress(url: string, init: Omit<TransportInit, 'signal'> & { signal?: AbortSignal }): Promise<Response> {
    let target: URL;
    try { target = new URL(url); } catch { throw unavailable(REASONS.notVerified); }
    if (!origins.has(target.origin)) throw unavailable(REASONS.notVerified);
    const deadline = init.signal ?? signal();
    const address = await publicServerAddress(target.toString(), resolve, deadline);
    return transport(target.toString(), { ...init, signal: deadline }, address);
  }
  async function request(url: string, init: Omit<TransportInit, 'signal'>): Promise<{ status: number; body: unknown; headers: Headers }> {
    let response: Response;
    try { response = await egress(url, init); }
    catch (error) { if (error instanceof ConnectorError) throw error; throw unavailable(); }
    let text = '';
    try { text = await readCapped(response, 256_000); } catch { throw unavailable(); }
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: response.status, body, headers: response.headers };
  }

  // ── Discovery and registration ──────────────────────────────────────────
  async function discover(): Promise<Discovery> {
    if (discovery && discovery.until > now()) return discovery.value;
    discovering ??= (async () => {
      const probe = await request(server!.toString(), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'discover', method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'RealBud', version: '1.0.0' } } }) });
      if (probe.status !== 401) throw unavailable(REASONS.notVerified);
      const advertised = /resource_metadata="([^"]+)"/.exec(probe.headers.get('www-authenticate') ?? '')?.[1];
      const metadataUrl = httpsUrl(advertised ?? `${server!.origin}/.well-known/oauth-protected-resource`);
      if (!metadataUrl || metadataUrl.origin !== server!.origin) throw unavailable(REASONS.notVerified);
      const resourceReply = await request(metadataUrl.toString(), { headers: { accept: 'application/json' } });
      const prm = object(resourceReply.body) ? resourceReply.body : {};
      const resource = httpsUrl(prm.resource);
      const issuerUrl = Array.isArray(prm.authorization_servers) && prm.authorization_servers.length === 1 ? httpsUrl(prm.authorization_servers[0]) : null;
      const offered = Array.isArray(prm.scopes_supported) ? prm.scopes_supported : null;
      if (resourceReply.status !== 200 || !resource || resource.origin !== server!.origin || !issuerUrl || issuerUrl.pathname !== '/' || issuerUrl.search ||
          (config.authorizationServer !== undefined && issuerUrl.origin !== config.authorizationServer) ||
          (offered && !config.scopes.every(item => offered.includes(item)))) throw unavailable(REASONS.notVerified);
      const issuer = issuerUrl.origin;
      origins.add(issuer);
      const { status, body } = await request(`${issuer}/.well-known/oauth-authorization-server`, { headers: { accept: 'application/json' } });
      const m = object(body) ? body : {};
      const list = (v: unknown, item: string) => Array.isArray(v) && v.includes(item);
      const onIssuer = (v: unknown) => { const url = httpsUrl(v); return url && url.origin === issuer ? url : null; };
      const authorize = onIssuer(m.authorization_endpoint), token = onIssuer(m.token_endpoint), register = onIssuer(m.registration_endpoint);
      const revoke = m.revocation_endpoint === undefined ? null : onIssuer(m.revocation_endpoint);
      if (status !== 200 || m.issuer !== issuer || !authorize || !token || !register || (revoke === null && m.revocation_endpoint !== undefined) ||
          !list(m.code_challenge_methods_supported, 'S256') || !list(m.response_types_supported, 'code') ||
          !list(m.grant_types_supported, 'authorization_code') || !list(m.grant_types_supported, 'refresh_token') ||
          (m.token_endpoint_auth_methods_supported !== undefined && !list(m.token_endpoint_auth_methods_supported, 'none'))) {
        throw unavailable(REASONS.notVerified);
      }
      const value: Discovery = { authorize: authorize.toString(), token: token.toString(), register: register.toString(), revoke: revoke?.toString() ?? null,
        issuer, resource: prm.resource as string, issParameter: m.authorization_response_iss_parameter_supported === true };
      discovery = { value, until: now() + DISCOVERY_LIFETIME };
      return value;
    })().finally(() => { discovering = null; });
    return discovering;
  }

  async function clientFor(found: Discovery, redirectUri: string): Promise<string> {
    const saved = await options.vault.read(clientEntry) as ClientRecord | undefined;
    if (saved?.version === 1 && saved.issuer === found.issuer && saved.redirectUri === redirectUri && opaque(saved.clientId, 256)) return saved.clientId;
    registering ??= (async () => {
      const { status, body } = await request(found.register, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ client_name: 'RealBud', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'], token_endpoint_auth_method: 'none', ...(scope ? { scope } : {}) }),
      });
      if (status === 429) throw unavailable(REASONS.registrationLimited);
      const r = object(body) ? body : {};
      if ((status !== 201 && status !== 200) || !opaque(r.client_id, 256) || r.client_secret !== undefined ||
          (r.token_endpoint_auth_method !== undefined && r.token_endpoint_auth_method !== 'none') ||
          (r.redirect_uris !== undefined && !(Array.isArray(r.redirect_uris) && r.redirect_uris.includes(redirectUri)))) {
        throw unavailable(REASONS.notVerified);
      }
      await options.vault.write(clientEntry, { version: 1, issuer: found.issuer, redirectUri, clientId: r.client_id } satisfies ClientRecord);
      return r.client_id as string;
    })().finally(() => { registering = null; });
    return registering;
  }

  function redirect(): string {
    const value = `${options.redirectBase()}${callbackPath}`;
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && url.pathname === callbackPath && !url.search && !url.hash && url.toString() === value) return value;
    } catch { /* fall through */ }
    throw new Error('Invalid connector redirect configuration.');
  }

  // ── Tokens ──────────────────────────────────────────────────────────────
  type TokenResult = { ok: true; tokens: Tokens } | { ok: false; grant: boolean; broad?: boolean };
  async function tokenRequest(found: Discovery, params: Record<string, string>, clientId: string, previousRefresh: string | null): Promise<TokenResult> {
    const { status, body } = await request(found.token, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ ...params, client_id: clientId, resource: found.resource }).toString(),
    });
    const r = object(body) ? body : {};
    if (status === 200) {
      const expires = Number.isSafeInteger(r.expires_in) && r.expires_in > 0 && r.expires_in <= 366 * 86_400 ? r.expires_in as number : 300;
      if (!opaque(r.access_token) || typeof r.token_type !== 'string' || r.token_type.toLowerCase() !== 'bearer' ||
          (r.refresh_token !== undefined && r.refresh_token !== null && !opaque(r.refresh_token))) return { ok: false, grant: false };
      const tokens: Tokens = { accessToken: r.access_token, refreshToken: (r.refresh_token as string | undefined) ?? previousRefresh, expiresAt: now() + expires * 1000, clientId };
      // Anything granted beyond what was requested is refused and retired.
      if (config.scopes.length && typeof r.scope === 'string' && r.scope.split(/\s+/).filter(Boolean).some(item => !config.scopes.includes(item))) {
        void revoke(tokens);
        return { ok: false, grant: true, broad: true };
      }
      return { ok: true, tokens };
    }
    if (status === 429 || status >= 500) throw unavailable();
    return { ok: false, grant: r.error === 'invalid_grant' || r.error === 'invalid_client' || status === 401 };
  }

  async function revoke(tokens: Tokens | null): Promise<void> {
    if (!tokens || tokens.clientId === HEADER_CLIENT) return;
    try {
      const found = await discover();
      if (!found.revoke) return;
      for (const [token, hint] of [[tokens.refreshToken, 'refresh_token'], [tokens.accessToken, 'access_token']] as const) {
        if (!token) continue;
        await request(found.revoke, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: new URLSearchParams({ token, token_type_hint: hint, client_id: tokens.clientId }).toString(),
        });
      }
    } catch { /* best effort: local deletion already happened */ }
  }

  function workspace(): { workspaceId: string; key: string } {
    const workspaceId = options.workspaceId();
    if (typeof workspaceId !== 'string' || !workspaceId.trim() || workspaceId.length > 300) throw new ConnectorError('invalid_request', 'Set up this RealBud office before connecting.', 403);
    // Vault names are at most 80 characters: a long connector id gets a shorter
    // hash (at least 29 hex for a 40-character id); short ids keep their existing key.
    const prefix = `connector-${config.id}-`;
    return { workspaceId, key: `${prefix}${createHash('sha256').update(JSON.stringify(['mcp-connector-v1', config.id, workspaceId])).digest('hex').slice(0, Math.min(48, 80 - prefix.length))}` };
  }
  async function load(key: string, workspaceId: string): Promise<ConnectorRecord | null> {
    const saved = await options.vault.read(key) as ConnectorRecord | undefined;
    if (saved === undefined) return null;
    if (!object(saved) || saved.version !== 1 || saved.connector !== config.id || !Number.isSafeInteger(saved.generation) || saved.generation < 0 || saved.workspaceId !== workspaceId) {
      throw new Error('Connection storage needs recovery.');
    }
    return saved;
  }
  const save = (key: string, value: ConnectorRecord) => options.vault.write(key, value);

  /** Exactly one refresh per connector and workspace in flight; joiners share it. */
  function refreshed(key: string, workspaceId: string, generation: number, used: string): Promise<Tokens> {
    const existing = refreshing.get(key);
    if (existing) return existing;
    const run = serial(key, async () => {
      const current = await load(key, workspaceId);
      if (!current || current.generation !== generation) throw stale();
      if (current.status !== 'connected' || !current.tokens) throw current.status === 'needs_reconnect' ? reconnect(current.reason ?? undefined) : notConnected();
      if (current.tokens.accessToken !== used) return current.tokens;
      const markReconnect = async () => {
        await save(key, { ...current, status: 'needs_reconnect', reason: REASONS.signInAgain, tokens: null });
        retire(key);
        return reconnect();
      };
      if (!current.tokens.refreshToken) throw await markReconnect();
      const result = await tokenRequest(await discover(), { grant_type: 'refresh_token', refresh_token: current.tokens.refreshToken },
        current.tokens.clientId, current.tokens.refreshToken);
      if (!result.ok) {
        if (result.grant) throw await markReconnect();
        throw unavailable();
      }
      await save(key, { ...current, tokens: result.tokens });
      return result.tokens;
    }).finally(() => { if (refreshing.get(key) === run) refreshing.delete(key); });
    refreshing.set(key, run);
    return run;
  }

  async function accessToken(key: string, workspaceId: string, generation: number): Promise<string> {
    const current = await load(key, workspaceId);
    if (!current || current.generation !== generation) throw stale();
    if (current.status === 'needs_reconnect') throw reconnect(current.reason ?? undefined);
    if (current.status !== 'connected' || !current.tokens) throw notConnected();
    let tokens = current.tokens;
    if (tokens.expiresAt - REFRESH_MARGIN <= now()) tokens = await refreshed(key, workspaceId, generation, tokens.accessToken);
    return tokens.accessToken;
  }

  // ── MCP client: allowlisted read tools only ─────────────────────────────
  function receipt(tool: string, outcome: ConnectorReceipt['outcome']) {
    const entry = { connector: config.id, tool: tool.slice(0, 100), outcome, at: now() };
    receipts.push(entry);
    if (receipts.length > 100) receipts.shift();
    try { options.audit?.(entry); } catch { /* the receipt sink never blocks a read */ }
  }

  /** `guard` runs before every dispatch and before a result is returned;
   * `bound` aborts the session when its connection generation is retired. */
  function mcpSession(token: string, scope: { bound?: AbortSignal; guard?: () => Promise<void>; approval?: Approval; secrets?: readonly (string | null)[] } = {}): { call: ConnectorCall; listTools: ListTools } {
    const secrets = [token, ...(scope.secrets ?? [])];
    let session: string | null = null, protocol = PROTOCOL_VERSION, ready: Promise<void> | null = null, id = 0;
    const callSignal = scope.bound ? AbortSignal.any([signal(), scope.bound]) : signal();
    const post = async (message: Record<string, unknown>): Promise<Response> => {
      let response: Response;
      try {
        response = await egress(server!.toString(), {
          method: 'POST', signal: callSignal,
          headers: {
            authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
            ...(message.method !== 'initialize' ? { 'mcp-protocol-version': protocol } : {}),
            ...(session ? { 'mcp-session-id': session } : {}),
          },
          body: JSON.stringify(message),
        });
      } catch { throw new McpToolError('unavailable'); }
      if (response.status === 401) { await response.body?.cancel().catch(() => {}); throw new McpToolError('unauthorized'); }
      if (!response.ok || response.redirected) { await response.body?.cancel().catch(() => {}); throw new McpToolError('unavailable'); }
      const next = response.headers.get('mcp-session-id');
      if (next && (!/^[\x21-\x7e]{1,512}$/.test(next) || (message.method !== 'initialize' && next !== session))) {
        await response.body?.cancel().catch(() => {});
        throw new McpToolError('invalid');
      }
      if (message.method === 'initialize') session = next;
      return response;
    };
    const rpc = async (method: string, params: unknown) => {
      const requestId = `rb-${++id}`;
      const response = await post({ jsonrpc: '2.0', id: requestId, method, params });
      // readMcpRpcResponse caps the body at 2 MB.
      try { return await readMcpRpcResponse(response, requestId, callSignal); }
      catch { throw new McpToolError(callSignal.aborted ? 'unavailable' : 'invalid'); }
    };
    const initialize = async () => {
      const init = await rpc('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'RealBud', version: '1.0.0' } });
      if (!object(init) || !SUPPORTED_PROTOCOLS.has(init.protocolVersion) || !object(init.capabilities) || !object(init.capabilities.tools)) throw new McpToolError('invalid');
      protocol = init.protocolVersion;
      const initialized = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
      await initialized.body?.cancel().catch(() => {});
    };
    const listTools: ListTools = async () => {
      await scope.guard?.();
      ready ??= initialize();
      await ready;
      const tools: RemoteTool[] = [], seen = new Set<string>();
      let cursor: string | undefined;
      for (let pages = 0; pages < 10; pages++) {
        const result = await rpc('tools/list', cursor ? { cursor } : {});
        if (!object(result) || !Array.isArray(result.tools)) throw new McpToolError('invalid');
        for (const item of result.tools) {
          if (!object(item) || typeof item.name !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(item.name) || seen.has(item.name) ||
              secrets.some(secret => secret && item.name.includes(secret)) || scrubCredentials(item.name, []) !== item.name) throw new McpToolError('invalid');
          seen.add(item.name);
          if (tools.length >= MAX_REMOTE_TOOLS) throw new McpToolError('invalid');
          // Hash the complete raw listing first; only then truncate and redact for use.
          const raw = canonicalJson({ name: item.name, description: item.description ?? null, inputSchema: item.inputSchema ?? null, annotations: item.annotations ?? null });
          let rawHash = raw.length <= MAX_RAW_TOOL ? createHash('sha256').update(raw).digest('hex') : null;
          // A schema nested beyond what the scrubber walks is never stored: it
          // counts as over the cap, so the connector stays unreviewable.
          let inputSchema: Record<string, unknown> = {};
          if (object(item.inputSchema)) {
            try { inputSchema = scrubCredentials(item.inputSchema, secrets); }
            catch (error) { if (!(error instanceof McpToolError)) throw error; rawHash = null; }
          }
          tools.push({ name: item.name, description: typeof item.description === 'string' ? scrubCredentials(item.description.slice(0, 2000), secrets) : '',
            inputSchema,
            annotations: object(item.annotations) ? { readOnlyHint: item.annotations.readOnlyHint, destructiveHint: item.annotations.destructiveHint } : null, rawHash });
        }
        if (result.nextCursor === undefined || result.nextCursor === null) { await scope.guard?.(); return tools; }
        if (!opaque(result.nextCursor, 2048)) throw new McpToolError('invalid');
        cursor = result.nextCursor;
      }
      throw new McpToolError('invalid');
    };
    const call: ConnectorCall = async (tool, args) => {
      // Reads run; a write runs only after the person allowed this exact call;
      // consequential tools are never called (no verified fact card exists for them).
      // A read runs; a write or consequential call runs only with the person's
      // approval of its own kind. The policy is read again right before
      // dispatch and before a result is released.
      const permitted = () => {
        const allowed = allowlist(), toolClass = Object.hasOwn(allowed, tool) ? allowed[tool] : undefined;
        return toolClass === 'read' || (toolClass !== undefined && toolClass === scope.approval);
      };
      if (!permitted() || !object(args)) { receipt(tool, 'refused'); throw new McpToolError('refused'); }
      try {
        await scope.guard?.();
        ready ??= initialize();
        await ready;
        await scope.guard?.();
        if (!permitted() || callSignal.aborted) throw new McpToolError('refused');
        const result = await rpc('tools/call', { name: tool, arguments: { ...config.defaultArgs, ...args } });
        if (!object(result) || result.isError === true) throw new McpToolError('invalid');
        let payload: unknown = result.structuredContent;
        if (!object(payload)) {
          const block = Array.isArray(result.content) && result.content.length === 1 ? result.content[0] : null;
          if (!object(block) || block.type !== 'text' || typeof block.text !== 'string') throw new McpToolError('invalid');
          try { payload = JSON.parse(block.text); } catch { throw new McpToolError('invalid'); }
        }
        if (!object(payload)) throw new McpToolError('invalid');
        await scope.guard?.();
        if (!permitted() || callSignal.aborted) throw new McpToolError('refused');
        receipt(tool, 'succeeded');
        return scrubCredentials(payload, secrets);
      } catch (error) { receipt(tool, 'failed'); throw error; }
    };
    return { call, listTools };
  }

  /** Runs read work with a live token; one refresh on 401, then needs_reconnect. */
  type Session = { call: ConnectorCall; listTools: ListTools };
  async function withCall<T>(key: string, workspaceId: string, generation: number, work: (session: Session) => Promise<T>, approval?: Approval, stop?: AbortSignal): Promise<T> {
    const bound = stop ? AbortSignal.any([liveSignal(key, generation), stop]) : liveSignal(key, generation);
    // The stored connection must still be this generation, connected, at every page and before any result leaves.
    const guard = async () => {
      if (bound.aborted) throw notConnected();
      const latest = await load(key, workspaceId);
      if (!latest || latest.generation !== generation || latest.status !== 'connected' || bound.aborted) throw latest?.status === 'needs_reconnect' ? reconnect() : notConnected();
    };
    const attempt = async (token: string) => {
      const refresh = (await load(key, workspaceId))?.tokens?.refreshToken ?? null;
      const value = await work(mcpSession(token, { bound, guard, approval, secrets: [refresh] }));
      await guard();
      return value;
    };
    const token = await accessToken(key, workspaceId, generation);
    try { return await attempt(token); }
    catch (error) {
      if (bound.aborted) throw notConnected();
      if (!(error instanceof McpToolError) || error.code !== 'unauthorized') throw error;
    }
    await refreshed(key, workspaceId, generation, token);
    try { return await attempt(await accessToken(key, workspaceId, generation)); }
    catch (error) {
      if (bound.aborted) throw notConnected();
      if (!(error instanceof McpToolError) || error.code !== 'unauthorized') throw error;
      await serial(key, async () => {
        const latest = await load(key, workspaceId);
        if (latest && latest.generation === generation && latest.status === 'connected') {
          await save(key, { ...latest, status: 'needs_reconnect', reason: REASONS.signInAgain, tokens: null });
          retire(key);
        }
      });
      throw reconnect();
    }
  }

  const accountFrom = (label: string): ConnectorAccount => ({ label: label.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300) || config.label, verifiedAt: now() });

  // ── State and actions ───────────────────────────────────────────────────
  function pendingFor(key: string): Pending | null {
    for (const [state, entry] of pending) {
      if (entry.expiresAt <= now()) pending.delete(state);
      else if (entry.key === key) return entry;
    }
    return null;
  }

  async function state(canManage: boolean): Promise<ConnectorState> {
    const { workspaceId, key } = workspace();
    const current = await load(key, workspaceId);
    const generation = current?.generation ?? 0;
    const view = (status: ConnectorState['status'], account: ConnectorAccount | null, reason: string | null) => {
      const value = parseConnectorState({ version: 1, connector: config.id, status, account: account && { ...account }, generation, reason, canManage });
      if (!value) throw new Error('Connection state needs recovery.');
      return value;
    };
    const waiting = pendingFor(key);
    if (waiting && waiting.generation === generation) return view('connecting', null, null);
    const hold = transient.get(key);
    if (hold && hold.generation === generation && current?.status === 'connected') return view('unavailable', null, hold.reason);
    if (current?.status === 'connected' && current.account) return view('connected', current.account, null);
    if (current?.status === 'needs_reconnect') return view('needs_reconnect', current.account, current.reason ?? REASONS.signInAgain);
    return view('not_connected', null, null);
  }

  async function start(grant: ConnectorGrant): Promise<ConnectorStart> {
    const { workspaceId, key } = workspace();
    const generation = (await load(key, workspaceId))?.generation ?? 0;
    const redirectUri = redirect();
    const found = await discover();
    const clientId = await clientFor(found, redirectUri);
    for (const [state, entry] of pending) if (entry.key === key || entry.expiresAt <= now()) pending.delete(state);
    if (pending.size >= 200) throw unavailable();
    const verifier = random(32).toString('base64url'), state = random(32).toString('base64url');
    const url = new URL(found.authorize);
    for (const [name, value] of Object.entries({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope, state, resource: found.resource,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })) url.searchParams.set(name, value);
    const result = parseConnectorStart({ authorizeUrl: url.toString() }, found.issuer);
    if (!result) throw unavailable(REASONS.notVerified);
    pending.set(state, { key, workspaceId, generation, verifier, redirectUri, clientId, expiresAt: now() + STATE_LIFETIME,
      principal: grant.principal, stillManages: grant.stillManages });
    return result;
  }

  async function callback(query: URLSearchParams): Promise<ConnectorCallbackPage> {
    const stateValue = query.get('state') ?? '';
    const entry = pending.get(stateValue);
    if (!entry || query.getAll('state').length !== 1) return page('expired');
    pending.delete(stateValue); // single use, whatever happens next
    if (entry.expiresAt <= now()) return page('expired');
    if (query.has('error')) return page('cancelled');
    const code = query.get('code');
    if (!opaque(code, 2048) || query.getAll('code').length !== 1) return page('failed');
    const sameWorkspace = () => { try { return workspace().workspaceId === entry.workspaceId; } catch { return false; } };
    if (!sameWorkspace()) return page('changed');
    // The person who started this sign-in must still manage the office connection.
    const stillManages = async () => { try { return await entry.stillManages(); } catch { return false; } };
    if (!await stillManages()) { dropPending(entry.key); return page('forbidden'); }
    try {
      const found = await discover();
      const iss = query.get('iss');
      if ((iss !== null || found.issParameter) && iss !== found.issuer) return page('failed');
      if (((await load(entry.key, entry.workspaceId))?.generation ?? 0) !== entry.generation) return page('changed');
      const result = await tokenRequest(found, { grant_type: 'authorization_code', code, redirect_uri: entry.redirectUri, code_verifier: entry.verifier }, entry.clientId, null);
      if (!result.ok) return page(result.broad ? 'tooBroad' : 'failed');
      if (!await stillManages()) { dropPending(entry.key); void revoke(result.tokens); return page('forbidden'); }
      let account: ConnectorAccount;
      try { const session = mcpSession(result.tokens.accessToken, { secrets: [result.tokens.refreshToken] }); account = accountFrom(await config.verify(session.call, session.listTools)); }
      catch { void revoke(result.tokens); return page('failed'); }
      const outcome = await serial(entry.key, async () => {
        const latest = await load(entry.key, entry.workspaceId);
        // Re-check after every await: a disconnect, another connect, a workspace switch or lost authority wins.
        if ((latest?.generation ?? 0) !== entry.generation || !sameWorkspace()) return { kind: 'changed' as const, replaced: null };
        if (removed || (config.committable && !config.committable()) || !await stillManages() || (config.committable && !config.committable())) return { kind: 'forbidden' as const, replaced: null };
        await save(entry.key, { version: 1, connector: config.id, workspaceId: entry.workspaceId, generation: entry.generation + 1, status: 'connected', reason: null, account, tokens: result.tokens });
        retire(entry.key);
        transient.delete(entry.key);
        return { kind: 'connected' as const, replaced: latest?.tokens ?? null };
      });
      if (outcome.kind === 'forbidden') { dropPending(entry.key); void revoke(result.tokens); return page('forbidden'); }
      if (outcome.kind !== 'connected') { void revoke(result.tokens); return page('changed'); }
      void revoke(outcome.replaced);
      return page('connected');
    } catch { return page('failed'); }
  }

  async function check(canManage: boolean): Promise<ConnectorState> {
    const { workspaceId, key } = workspace();
    const current = await load(key, workspaceId);
    if (!current || current.status !== 'connected') return state(canManage);
    const generation = current.generation;
    try {
      const label = await withCall(key, workspaceId, generation, session => config.verify(session.call, session.listTools));
      await serial(key, async () => {
        const latest = await load(key, workspaceId);
        if (latest && latest.generation === generation && latest.status === 'connected') await save(key, { ...latest, account: accountFrom(label) });
      });
      transient.delete(key);
    } catch (error) {
      // Needs-reconnect is already saved; anything else keeps the tokens and reads as unavailable.
      if (!(error instanceof ConnectorError && error.code === 'needs_reconnect')) transient.set(key, { generation, reason: REASONS.unreachable });
    }
    return state(canManage);
  }

  async function disconnect(canManage: boolean): Promise<ConnectorState> {
    const { workspaceId, key } = workspace();
    dropPending(key);
    retire(key);
    const removed = await serial(key, async () => {
      const current = await load(key, workspaceId);
      await save(key, { version: 1, connector: config.id, workspaceId, generation: (current?.generation ?? 0) + 1, status: 'not_connected', reason: null, account: null, tokens: null });
      retire(key);
      transient.delete(key);
      return current?.tokens ?? null;
    });
    await revoke(removed);
    return state(canManage);
  }

  /** Header-token mode: the owner enters the token once; it is verified, then
   * kept only in the vault. It is never returned, logged or shown again. */
  async function setToken(body: unknown, grant: ConnectorGrant): Promise<ConnectorState> {
    const canManage = grant.authority === 'manage';
    refuseIfRemoved();
    if (!headerMode) throw new ConnectorError('invalid_request', 'This connection signs in through the service instead.', 400);
    const token = object(body) && Object.keys(body).length === 1 ? body.token : undefined;
    if (!opaque(token, 4096)) throw new ConnectorError('invalid_request', 'Paste the access token exactly as the service gave it.', 400);
    const { workspaceId, key } = workspace();
    const generation = (await load(key, workspaceId))?.generation ?? 0;
    const tokens: Tokens = { accessToken: token, refreshToken: null, expiresAt: Number.MAX_SAFE_INTEGER, clientId: HEADER_CLIENT };
    let account: ConnectorAccount;
    try { const session = mcpSession(token); account = accountFrom(await config.verify(session.call, session.listTools)); }
    catch { throw new ConnectorError('unavailable', 'The service did not accept that token. Nothing was saved.', 409); }
    let refused = false;
    await serial(key, async () => {
      // Commit only if this instance is live, the workspace is the same and the person still manages it.
      refuseIfRemoved();
      const latest = await load(key, workspaceId);
      if ((latest?.generation ?? 0) !== generation) throw stale();
      let sameWorkspace = false;
      try { sameWorkspace = workspace().workspaceId === workspaceId; } catch { /* refused below */ }
      if (!sameWorkspace || !(await grant.stillManages().catch(() => false))) { refused = true; return; }
      refuseIfRemoved();
      await save(key, { version: 1, connector: config.id, workspaceId, generation: generation + 1, status: 'connected', reason: null, account, tokens });
      retire(key);
      transient.delete(key);
    });
    if (refused) throw forbidden();
    return state(canManage);
  }

  const emptyBody = (body: unknown) => body === undefined || (object(body) && Object.keys(body).length === 0);

  return {
    id: config.id,
    callback,
    /** Server-internal reads for presets. Throws ConnectorError
     * ('not_connected' | 'needs_reconnect' | 'unavailable' | 'stale') or McpToolError. */
    async read<T>(work: (call: ConnectorCall) => Promise<T>): Promise<T> {
      const { workspaceId, key } = workspace();
      const current = await load(key, workspaceId);
      if (current?.status === 'needs_reconnect') throw reconnect(current.reason ?? undefined);
      if (!current || current.status !== 'connected') throw notConnected();
      return withCall(key, workspaceId, current.generation, session => work(session.call));
    },
    /** One tool call for Ask. `approval` names the card the person allowed for
     * this exact call ('write' or 'consequential'); a read needs none. */
    async invoke(tool: string, args: Record<string, unknown>, approval: Approval | undefined, stop?: AbortSignal): Promise<Record<string, unknown>> {
      if (stop?.aborted) throw new McpToolError('unavailable');
      const { workspaceId, key } = workspace();
      const current = await load(key, workspaceId);
      if (current?.status === 'needs_reconnect') throw reconnect(current.reason ?? undefined);
      if (!current || current.status !== 'connected') throw notConnected();
      return withCall(key, workspaceId, current.generation, session => session.call(tool, args), approval, stop);
    },
    /** Health check without a request: re-verifies (and re-lists tools) when connected. */
    async healthCheck(): Promise<ConnectorState> { return check(false); },
    async state(): Promise<ConnectorState> { return state(false); },
    /** Aborts calls in flight (e.g. on quarantine); later calls re-read the policy. */
    abortInFlight() { try { retire(workspace().key); } catch { /* no workspace, nothing in flight */ } },
    /** Removal retires this instance first: nothing it started may commit afterwards. */
    async purge(): Promise<void> {
      removed = true;
      const { workspaceId, key } = workspace();
      dropPending(key); retire(key);
      // Then forget sign-ins, delete tokens and the client registration, revoking best effort.
      const purged = await serial(key, async () => {
        const current = await load(key, workspaceId).catch(() => null);
        await options.vault.remove(key);
        await options.vault.remove(clientEntry);
        transient.delete(key);
        return current?.tokens ?? null;
      });
      await revoke(purged);
    },
    receipts: () => receipts.map(entry => ({ ...entry })),
    async handle(action: ConnectorAction, method: string, request: IncomingMessage, body?: unknown): Promise<{ status: number; body: unknown }> {
      try {
        if (method !== (action === 'state' ? 'GET' : 'POST')) return { status: 405, body: { error: 'Use the connection controls.' } };
        if (action !== 'state' && action !== 'token' && !emptyBody(body)) return { status: 400, body: { error: 'This action takes no options.' } };
        const grant = await options.authorize(request).catch((): ConnectorGrant => ({ authority: 'read', principal: 'unverified', stillManages: async () => false }));
        const canManage = grant.authority === 'manage';
        // Authority changed: this person's unfinished sign-ins no longer count.
        if (!canManage) for (const [state, entry] of pending) if (entry.principal === grant.principal) pending.delete(state);
        if ((action === 'start' || action === 'disconnect' || action === 'token') && !canManage) throw forbidden();
        if (action === 'start' && headerMode) throw new ConnectorError('invalid_request', 'Enter this service\'s access token instead.', 400);
        const result = action === 'state' ? await state(canManage) : action === 'start' ? await start(grant) : action === 'check' ? await check(canManage)
          : action === 'token' ? await setToken(body, grant) : await disconnect(canManage);
        return { status: 200, body: result };
      } catch (error) {
        if (error instanceof ConnectorError) return { status: error.status, body: { error: error.message, code: error.code } };
        logUnexpected(`${config.id} ${action}`, error);
        return { status: 500, body: { error: 'The connection could not be updated. Try again.' } };
      }
    },
    close() {
      closing.abort();
      liveSignals.retireAll();
      pending.clear();
      releaseWork();
    },
  };
}

export type McpConnector = ReturnType<typeof createMcpConnector>;
