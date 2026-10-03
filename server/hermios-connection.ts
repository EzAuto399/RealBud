import { createHash, randomBytes } from 'node:crypto';
import {
  HERMIOS_CONNECTION_API, HERMIOS_CONNECTION_CHECK_API, HERMIOS_CONNECTION_DISCONNECT_API, HERMIOS_CONNECTION_REASONS,
  HERMIOS_CONNECTION_START_API, HERMIOS_OAUTH_CALLBACK_PATH, parseHermiosConnectionStart, parseHermiosConnectionState,
  type HermiosConnectedAccount, type HermiosConnectionStart, type HermiosConnectionState,
} from '../shared/hermios-connection.ts';
import type { HermiosProfile } from '../shared/hermios-modules.ts';
import { HermiosMcpError, readHermiosProfile } from './hermios-connection-mcp.ts';

/**
 * A RealBud member's own Bud ↔ Hermios OAuth connection (public client, PKCE,
 * loopback redirect). Tokens live only in the encrypted private vault and leave
 * this module only through `accessTokenFor`, which is server-internal and pinned
 * to a connection generation. Every route answers for the calling member only.
 * Identity is the opaque `get_hermios_profile` id; labels are display-only.
 */

export interface HermiosConnectionContext { companyId: string; memberId: string }
export interface HermiosConnectionVault {
  read(name: string): Promise<unknown | undefined>;
  write(name: string, value: unknown): Promise<void>;
  remove(name: string): Promise<void>;
}
export interface HermiosConnectionOptions {
  vault: HermiosConnectionVault;
  /** The verified RealBud company and member making this request. */
  context: () => HermiosConnectionContext;
  /** `http://127.0.0.1:<RealBud port>${HERMIOS_OAUTH_CALLBACK_PATH}`; re-registered when it changes. */
  redirectUri: () => string;
  fetch?: typeof fetch;
  now?: () => number;
  random?: (bytes: number) => Buffer;
  issuer?: string;
  mcpUrl?: string;
}

type ErrorCode = 'unavailable' | 'needs_reconnect' | 'not_connected' | 'stale' | 'invalid_request';
export class HermiosConnectionError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  constructor(code: ErrorCode, message: string, status = 409) {
    super(message);
    this.name = 'HermiosConnectionError';
    this.code = code;
    this.status = status;
  }
}

interface Discovery { authorize: string; token: string; register: string; revoke: string | null; issParameter: boolean }
interface Tokens { accessToken: string; refreshToken: string | null; expiresAt: number; clientId: string }
interface MemberRecord {
  version: 1; companyId: string; memberId: string; generation: number;
  status: 'not_connected' | 'connected' | 'needs_reconnect';
  reason: string | null; account: HermiosConnectedAccount | null; tokens: Tokens | null;
}
interface ClientRecord { version: 1; issuer: string; redirectUri: string; clientId: string }
interface Pending {
  key: string; context: HermiosConnectionContext; generation: number; verifier: string;
  redirectUri: string; clientId: string; expiresAt: number;
}
export interface HermiosCallbackPage { status: number; headers: Record<string, string>; body: string }

const DEFAULT_ISSUER = 'https://api.hermios.app';
const DEFAULT_MCP = 'https://api.hermios.app/mcp';
const SCOPE = 'api profile';
const STATE_LIFETIME = 10 * 60_000, DISCOVERY_LIFETIME = 5 * 60_000, REFRESH_MARGIN = 60_000, TIMEOUT = 15_000;
const CLIENT_ENTRY = 'hermios-oauth-client';
const REASONS = HERMIOS_CONNECTION_REASONS;

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const opaque = (v: unknown, max = 8192): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && /^[\x21-\x7e]+$/.test(v);
const label = (v: string | undefined, fallback: string) => (v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) || fallback;

function hermiosUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash &&
      (url.hostname === 'hermios.app' || url.hostname.endsWith('.hermios.app')) ? url : null;
  } catch { return null; }
}

function checkedContext(value: HermiosConnectionContext): HermiosConnectionContext {
  if (!object(value) || typeof value.companyId !== 'string' || !value.companyId.trim() || typeof value.memberId !== 'string' ||
      value.companyId.length > 300 || value.memberId.length > 300) {
    throw new HermiosConnectionError('invalid_request', 'Sign in to RealBud before connecting Hermios.', 403);
  }
  return { companyId: value.companyId, memberId: value.memberId };
}
const memberEntry = (c: HermiosConnectionContext) =>
  `hermios-member-${createHash('sha256').update(JSON.stringify(['hermios-connection-v1', c.companyId, c.memberId])).digest('hex').slice(0, 48)}`;
const sameContext = (a: HermiosConnectionContext, b: HermiosConnectionContext) => a.companyId === b.companyId && a.memberId === b.memberId;

const unavailable = (reason: string = REASONS.unreachable) => new HermiosConnectionError('unavailable', reason, 503);
const reconnect = (reason: string = REASONS.signInAgain) => new HermiosConnectionError('needs_reconnect', reason, 409);
const stale = () => new HermiosConnectionError('stale', 'This Hermios connection changed. Use the current connection.', 409);
const notConnected = () => new HermiosConnectionError('not_connected', 'Connect your Hermios account first.', 409);

// ── Callback page: self-contained, no scripts, no external assets ──────────
const PAGE_STYLE = 'body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f7f7f5;color:#1d1d1b}main{max-width:28rem;padding:2rem;text-align:center}@media (prefers-color-scheme:dark){body{background:#1b1b1a;color:#ececea}}';
const PAGE_CSP = `default-src 'none'; style-src 'sha256-${createHash('sha256').update(PAGE_STYLE).digest('base64')}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
const PAGES = {
  connected: 'Hermios is connected. You can return to RealBud.',
  expired: 'This Hermios sign-in link has expired or was already used. Return to RealBud and choose Connect again.',
  cancelled: 'Hermios sign-in was not completed. Return to RealBud and try again.',
  changed: 'RealBud changed member or connection while you were signing in. Return to RealBud and connect again.',
  failed: 'Hermios could not be connected. Return to RealBud and try again.',
} as const;
function page(kind: keyof typeof PAGES): HermiosCallbackPage {
  return {
    status: kind === 'connected' ? 200 : 400,
    headers: {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', pragma: 'no-cache',
      'content-security-policy': PAGE_CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
    },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RealBud · Hermios</title><style>${PAGE_STYLE}</style></head><body><main><p>${PAGES[kind]}</p></main></body></html>`,
  };
}

export function createHermiosConnectionService(options: HermiosConnectionOptions) {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const random = options.random ?? randomBytes;
  const issuer = options.issuer ?? DEFAULT_ISSUER;
  const mcpUrl = options.mcpUrl ?? DEFAULT_MCP;
  if (!hermiosUrl(issuer) || new URL(issuer).pathname !== '/' || issuer.endsWith('/') || !hermiosUrl(mcpUrl)) throw new Error('Invalid Hermios endpoint configuration.');
  const closing = new AbortController();
  const pending = new Map<string, Pending>();
  const transient = new Map<string, { generation: number; reason: string }>();
  const chains = new Map<string, Promise<unknown>>();
  const refreshing = new Map<string, Promise<Tokens>>();
  let discovery: { value: Discovery; until: number } | null = null;
  let discovering: Promise<Discovery> | null = null;
  let registering: Promise<string> | null = null;

  /** One operation per member at a time: refresh, callback, check update, disconnect. */
  function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const run = (chains.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    const tail = run.catch(() => {});
    chains.set(key, tail);
    void tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
    return run;
  }

  const signal = () => AbortSignal.any([closing.signal, AbortSignal.timeout(TIMEOUT)]);
  async function request(url: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try { response = await doFetch(url, { ...init, redirect: 'error', signal: signal() }); }
    catch { throw unavailable(); }
    let text = '';
    try { text = await response.text(); } catch { throw unavailable(); }
    if (text.length > 256_000) throw unavailable();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: response.status, body };
  }

  // ── Discovery and client registration ───────────────────────────────────
  async function discover(): Promise<Discovery> {
    if (discovery && discovery.until > now()) return discovery.value;
    discovering ??= (async () => {
      const { status, body } = await request(`${issuer}/.well-known/oauth-authorization-server`, { headers: { accept: 'application/json' } });
      if (status !== 200) throw unavailable();
      const m = object(body) ? body : {};
      const list = (v: unknown, item: string) => Array.isArray(v) && v.includes(item);
      const authorize = hermiosUrl(m.authorization_endpoint), token = hermiosUrl(m.token_endpoint), register = hermiosUrl(m.registration_endpoint);
      const revoke = m.revocation_endpoint === undefined ? null : hermiosUrl(m.revocation_endpoint);
      if (m.issuer !== issuer || !authorize || !token || !register || revoke === null && m.revocation_endpoint !== undefined ||
          !list(m.code_challenge_methods_supported, 'S256') || !list(m.response_types_supported, 'code') ||
          !list(m.grant_types_supported, 'authorization_code') || !list(m.grant_types_supported, 'refresh_token') ||
          (m.token_endpoint_auth_methods_supported !== undefined && !list(m.token_endpoint_auth_methods_supported, 'none'))) {
        throw unavailable(REASONS.notVerified);
      }
      const value: Discovery = { authorize: authorize.toString(), token: token.toString(), register: register.toString(),
        revoke: revoke?.toString() ?? null, issParameter: m.authorization_response_iss_parameter_supported === true };
      discovery = { value, until: now() + DISCOVERY_LIFETIME };
      return value;
    })().finally(() => { discovering = null; });
    return discovering;
  }

  async function clientFor(found: Discovery, redirectUri: string): Promise<string> {
    const saved = await options.vault.read(CLIENT_ENTRY) as ClientRecord | undefined;
    if (saved?.version === 1 && saved.issuer === issuer && saved.redirectUri === redirectUri && opaque(saved.clientId, 256)) return saved.clientId;
    registering ??= (async () => {
      const { status, body } = await request(found.register, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ client_name: 'RealBud', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'], token_endpoint_auth_method: 'none', scope: SCOPE }),
      });
      if (status === 429) throw unavailable(REASONS.registrationLimited);
      const r = object(body) ? body : {};
      // A public client only: a returned secret means this is not the client we asked for.
      if ((status !== 201 && status !== 200) || !opaque(r.client_id, 256) || r.client_secret !== undefined ||
          (r.token_endpoint_auth_method !== undefined && r.token_endpoint_auth_method !== 'none') ||
          (r.redirect_uris !== undefined && !(Array.isArray(r.redirect_uris) && r.redirect_uris.includes(redirectUri)))) {
        throw unavailable(REASONS.notVerified);
      }
      await options.vault.write(CLIENT_ENTRY, { version: 1, issuer, redirectUri, clientId: r.client_id } satisfies ClientRecord);
      return r.client_id as string;
    })().finally(() => { registering = null; });
    return registering;
  }

  function redirect(): string {
    const value = options.redirectUri();
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && url.pathname === HERMIOS_OAUTH_CALLBACK_PATH && !url.search && !url.hash && url.toString() === value) return value;
    } catch { /* fall through */ }
    throw new Error('Invalid Hermios redirect configuration.');
  }

  // ── Tokens ──────────────────────────────────────────────────────────────
  type TokenResult = { ok: true; tokens: Tokens } | { ok: false; grant: boolean };
  async function tokenRequest(found: Discovery, params: Record<string, string>, clientId: string, previousRefresh: string | null): Promise<TokenResult> {
    const { status, body } = await request(found.token, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ ...params, client_id: clientId }).toString(),
    });
    const r = object(body) ? body : {};
    if (status === 200) {
      const expires = Number.isSafeInteger(r.expires_in) && r.expires_in > 0 && r.expires_in <= 366 * 86_400 ? r.expires_in as number : 300;
      if (!opaque(r.access_token) || typeof r.token_type !== 'string' || r.token_type.toLowerCase() !== 'bearer' ||
          (r.refresh_token !== undefined && !opaque(r.refresh_token))) return { ok: false, grant: false };
      return { ok: true, tokens: { accessToken: r.access_token, refreshToken: (r.refresh_token as string | undefined) ?? previousRefresh, expiresAt: now() + expires * 1000, clientId } };
    }
    if (status === 429 || status >= 500) throw unavailable();
    // invalid_grant: the grant is gone. invalid_client: our registration is gone.
    return { ok: false, grant: r.error === 'invalid_grant' || r.error === 'invalid_client' || status === 401 };
  }

  async function revoke(tokens: Tokens | null): Promise<void> {
    if (!tokens) return;
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

  async function load(key: string, context: HermiosConnectionContext): Promise<MemberRecord | null> {
    const saved = await options.vault.read(key) as MemberRecord | undefined;
    if (saved === undefined) return null;
    if (!object(saved) || saved.version !== 1 || !Number.isSafeInteger(saved.generation) || saved.generation < 0 ||
        saved.companyId !== context.companyId || saved.memberId !== context.memberId) {
      throw new Error('Hermios connection storage needs recovery.');
    }
    return saved;
  }
  const save = (key: string, value: MemberRecord) => options.vault.write(key, value);

  /** Exactly one refresh per member in flight; joiners share its result. */
  function refreshed(key: string, context: HermiosConnectionContext, generation: number, used: string): Promise<Tokens> {
    const existing = refreshing.get(key);
    if (existing) return existing;
    const run = serial(key, async () => {
      const current = await load(key, context);
      if (!current || current.generation !== generation) throw stale();
      if (current.status !== 'connected' || !current.tokens) throw current.status === 'needs_reconnect' ? reconnect(current.reason ?? undefined) : notConnected();
      // Someone already replaced the token this caller used.
      if (current.tokens.accessToken !== used) return current.tokens;
      const markReconnect = async () => {
        await save(key, { ...current, status: 'needs_reconnect', reason: REASONS.signInAgain, tokens: null });
        return reconnect();
      };
      if (!current.tokens.refreshToken) throw await markReconnect();
      const result = await tokenRequest(await discover(), { grant_type: 'refresh_token', refresh_token: current.tokens.refreshToken },
        current.tokens.clientId, current.tokens.refreshToken);
      if (!result.ok) {
        if (result.grant) throw await markReconnect();
        throw unavailable();
      }
      // Atomic replace: the rotated refresh token and new access token land together.
      await save(key, { ...current, tokens: result.tokens });
      return result.tokens;
    }).finally(() => { if (refreshing.get(key) === run) refreshing.delete(key); });
    refreshing.set(key, run);
    return run;
  }

  async function accessTokenFor(contextValue: HermiosConnectionContext, generation: number): Promise<string> {
    const context = checkedContext(contextValue), key = memberEntry(context);
    const current = await load(key, context);
    if (!current || current.generation !== generation) throw stale();
    if (current.status === 'needs_reconnect') throw reconnect(current.reason ?? undefined);
    if (current.status !== 'connected' || !current.tokens) throw notConnected();
    let tokens = current.tokens;
    if (tokens.expiresAt - REFRESH_MARGIN <= now()) tokens = await refreshed(key, context, generation, tokens.accessToken);
    const after = await load(key, context);
    if (!after || after.generation !== generation || after.status !== 'connected' || after.tokens?.accessToken !== tokens.accessToken) throw stale();
    return tokens.accessToken;
  }

  async function profileWith(accessToken: string): Promise<HermiosProfile> {
    return readHermiosProfile({ fetch: doFetch, url: mcpUrl, accessToken, signal: signal() });
  }

  function accountFrom(profile: HermiosProfile): HermiosConnectedAccount {
    if (!/^[\x21-\x7e]{1,180}$/.test(profile.id)) throw new HermiosMcpError('invalid');
    // `workspaceId` is Hermios's own workspace UUID: the organization binding
    // and the key for cross-member record locks. `id` stays the member identity.
    return { displayName: label(profile.name ?? profile.email, 'Hermios member'), workspaceLabel: label(profile.nickname, 'Hermios workspace'),
      workspaceId: profile.workspaceId, profileId: profile.id, verifiedAt: now() };
  }

  // ── State ───────────────────────────────────────────────────────────────
  function pendingFor(key: string): Pending | null {
    for (const [state, entry] of pending) {
      if (entry.expiresAt <= now()) pending.delete(state);
      else if (entry.key === key) return entry;
    }
    return null;
  }

  async function state(): Promise<HermiosConnectionState> {
    const context = checkedContext(options.context()), key = memberEntry(context);
    const current = await load(key, context);
    const generation = current?.generation ?? 0;
    const view = (status: HermiosConnectionState['status'], account: HermiosConnectedAccount | null, reason: string | null): HermiosConnectionState => {
      const value = parseHermiosConnectionState({ version: 1, status, account: account && { ...account }, generation, reason });
      if (!value) throw new Error('Hermios connection state needs recovery.');
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

  async function start(): Promise<HermiosConnectionStart> {
    const context = checkedContext(options.context()), key = memberEntry(context);
    const generation = (await load(key, context))?.generation ?? 0;
    const redirectUri = redirect();
    const found = await discover();
    const clientId = await clientFor(found, redirectUri);
    for (const [state, entry] of pending) if (entry.key === key || entry.expiresAt <= now()) pending.delete(state);
    if (pending.size >= 200) throw unavailable();
    const verifier = random(32).toString('base64url'), state = random(32).toString('base64url');
    const url = new URL(found.authorize);
    for (const [name, value] of Object.entries({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE, state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })) url.searchParams.set(name, value);
    const result = parseHermiosConnectionStart({ authorizeUrl: url.toString() });
    if (!result) throw unavailable(REASONS.notVerified);
    pending.set(state, { key, context, generation, verifier, redirectUri, clientId, expiresAt: now() + STATE_LIFETIME });
    return result;
  }

  async function callback(query: URLSearchParams): Promise<HermiosCallbackPage> {
    const stateValue = query.get('state') ?? '';
    const entry = pending.get(stateValue);
    if (!entry || query.getAll('state').length !== 1) return page('expired');
    pending.delete(stateValue); // single use, whatever happens next
    if (entry.expiresAt <= now()) return page('expired');
    if (query.has('error')) return page('cancelled');
    const code = query.get('code');
    if (!opaque(code, 2048) || query.getAll('code').length !== 1) return page('failed');
    let current: HermiosConnectionContext;
    try { current = checkedContext(options.context()); } catch { return page('changed'); }
    if (!sameContext(current, entry.context)) return page('changed');
    try {
      const found = await discover();
      const iss = query.get('iss');
      if ((iss !== null || found.issParameter) && iss !== issuer) return page('failed');
      if (((await load(entry.key, entry.context))?.generation ?? 0) !== entry.generation) return page('changed');
      const result = await tokenRequest(found, { grant_type: 'authorization_code', code, redirect_uri: entry.redirectUri, code_verifier: entry.verifier }, entry.clientId, null);
      if (!result.ok) return page('failed');
      let account: HermiosConnectedAccount;
      try { account = accountFrom(await profileWith(result.tokens.accessToken)); }
      catch { void revoke(result.tokens); return page('failed'); }
      const outcome = await serial(entry.key, async () => {
        const latest = await load(entry.key, entry.context);
        // Re-check after every await: a disconnect, another connect or a member switch wins.
        if ((latest?.generation ?? 0) !== entry.generation) return { kind: 'changed' as const, replaced: null };
        try { if (!sameContext(checkedContext(options.context()), entry.context)) return { kind: 'changed' as const, replaced: null }; }
        catch { return { kind: 'changed' as const, replaced: null }; }
        await save(entry.key, { version: 1, companyId: entry.context.companyId, memberId: entry.context.memberId,
          generation: entry.generation + 1, status: 'connected', reason: null, account, tokens: result.tokens });
        transient.delete(entry.key);
        return { kind: 'connected' as const, replaced: latest?.tokens ?? null };
      });
      if (outcome.kind !== 'connected') { void revoke(result.tokens); return page('changed'); }
      // A reconnect or switch replaces the old grant; retire it without blocking.
      void revoke(outcome.replaced);
      return page('connected');
    } catch { return page('failed'); }
  }

  async function check(): Promise<HermiosConnectionState> {
    const context = checkedContext(options.context()), key = memberEntry(context);
    const current = await load(key, context);
    if (!current || current.status !== 'connected' || !current.account) return state();
    const generation = current.generation, bound = current.account;
    try {
      let token = await accessTokenFor(context, generation), profile: HermiosProfile;
      try { profile = await profileWith(token); }
      catch (error) {
        if (!(error instanceof HermiosMcpError) || error.code !== 'unauthorized') throw error;
        await refreshed(key, context, generation, token);
        token = await accessTokenFor(context, generation);
        try { profile = await profileWith(token); }
        catch (again) {
          if (!(again instanceof HermiosMcpError) || again.code !== 'unauthorized') throw again;
          throw reconnect();
        }
      }
      let retired: Tokens | null = null;
      await serial(key, async () => {
        const latest = await load(key, context);
        if (!latest || latest.generation !== generation || latest.status !== 'connected') return;
        // A connection saved before Hermios returned a workspace id carries the
        // `membership:<id>` placeholder; its first real workspace is bound once.
        const placeholder = bound.workspaceId === `membership:${bound.profileId}`;
        if (profile.id !== bound.profileId || (!placeholder && profile.workspaceId !== bound.workspaceId)) {
          // Another member or workspace: a new generation, so nothing mounted
          // against the old binding can act; the person connects again.
          retired = latest.tokens;
          await save(key, { ...latest, generation: latest.generation + 1, status: 'needs_reconnect', reason: REASONS.accountChanged, tokens: null });
          return;
        }
        await save(key, { ...latest, ...(placeholder ? { generation: latest.generation + 1 } : {}), account: accountFrom(profile) });
      });
      void revoke(retired);
      transient.delete(key);
    } catch (error) {
      if (error instanceof HermiosConnectionError && error.code === 'needs_reconnect') {
        await serial(key, async () => {
          const latest = await load(key, context);
          if (latest && latest.generation === generation && latest.status === 'connected') {
            await save(key, { ...latest, status: 'needs_reconnect', reason: REASONS.signInAgain, tokens: null });
          }
        });
      } else if (error instanceof HermiosMcpError || (error instanceof HermiosConnectionError && error.code === 'unavailable')) {
        // Transport or unverified reply: keep the tokens, report unavailable.
        transient.set(key, { generation, reason: REASONS.unreachable });
      } else if (!(error instanceof HermiosConnectionError)) throw error;
    }
    return state();
  }

  async function disconnect(): Promise<HermiosConnectionState> {
    const context = checkedContext(options.context()), key = memberEntry(context);
    for (const [state, entry] of pending) if (entry.key === key) pending.delete(state);
    const removed = await serial(key, async () => {
      const current = await load(key, context);
      await save(key, { version: 1, companyId: context.companyId, memberId: context.memberId,
        generation: (current?.generation ?? 0) + 1, status: 'not_connected', reason: null, account: null, tokens: null });
      transient.delete(key);
      return current?.tokens ?? null;
    });
    await revoke(removed);
    return state();
  }

  const emptyBody = (body: unknown) => body === undefined || (object(body) && Object.keys(body).length === 0);

  return {
    accessTokenFor,
    callback,
    state,
    async handle(path: string, method: string, body?: unknown): Promise<{ status: number; body: unknown }> {
      try {
        if (path === HERMIOS_CONNECTION_API) {
          if (method !== 'GET') return { status: 405, body: { error: 'Use the Hermios connection controls.' } };
          return { status: 200, body: await state() };
        }
        const action = path === HERMIOS_CONNECTION_START_API ? start : path === HERMIOS_CONNECTION_CHECK_API ? check :
          path === HERMIOS_CONNECTION_DISCONNECT_API ? disconnect : null;
        if (!action) return { status: 404, body: { error: 'Unknown Hermios connection action.' } };
        if (method !== 'POST') return { status: 405, body: { error: 'Use the Hermios connection controls.' } };
        if (!emptyBody(body)) return { status: 400, body: { error: 'This action takes no options.' } };
        return { status: 200, body: await action() };
      } catch (error) {
        if (error instanceof HermiosConnectionError) return { status: error.status, body: { error: error.message, code: error.code } };
        return { status: 500, body: { error: 'The Hermios connection could not be updated. Try again.' } };
      }
    },
    close() {
      closing.abort();
      pending.clear();
    },
  };
}
