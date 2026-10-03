import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HERMIOS_CONNECTION_API, HERMIOS_CONNECTION_CHECK_API, HERMIOS_CONNECTION_DISCONNECT_API, HERMIOS_CONNECTION_REASONS,
  HERMIOS_CONNECTION_START_API, HERMIOS_OAUTH_CALLBACK_PATH, parseHermiosConnectionState,
} from '../shared/hermios-connection.ts';
import { createHermiosConnectionService, type HermiosConnectionContext } from './hermios-connection.ts';
import { createPrivateVault } from './private-vault.ts';
import { needsSession } from './session-auth.ts';

// Fictional Hermios: a local HTTP server standing in for api.hermios.app. The
// service still validates real https *.hermios.app endpoints; only the injected
// fetch maps those hosts onto this server. No real network, account or token.
interface Account { id: string; workspaceId: string; name: string; nickname: string }
const ALICE: Account = { id: 'fictional-membership-alice', workspaceId: '0a0a0a0a-0000-4000-8000-00000000a11c', name: 'Fictional Alice', nickname: 'Fictional Realty' };
const BOB: Account = { id: 'fictional-membership-bob', workspaceId: '0b0b0b0b-0000-4000-8000-000000000b0b', name: 'Fictional Bob', nickname: 'Fictional Other Org' };
const ISSUER = 'https://api.hermios.app';
const SECRET = /fictional-(?:access|refresh)-secret/;

let server: Server, base = '', t = 1_700_000_000_000, n = 0, revokeNetworkDown = false;
let hermios: ReturnType<typeof fictionalHermios>;

function fictionalHermios() {
  return {
    metadata: (): Record<string, unknown> => ({
      issuer: ISSUER, authorization_endpoint: `https://app.hermios.app/authorize?iss=${encodeURIComponent(ISSUER)}`,
      token_endpoint: `${ISSUER}/oauth/token`, registration_endpoint: `${ISSUER}/oauth/register`, revocation_endpoint: `${ISSUER}/oauth/revoke`,
      scopes_supported: ['api', 'profile'], response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'client_credentials', 'refresh_token'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
      authorization_response_iss_parameter_supported: true,
    }),
    metadataPatch: {} as Record<string, unknown>,
    registerStatus: 201,
    registrations: [] as Array<Record<string, unknown>>,
    codes: new Map<string, { challenge: string; redirectUri: string; clientId: string; account: Account }>(),
    tokenCalls: [] as URLSearchParams[],
    access: new Map<string, Account>(),
    refresh: new Map<string, Account>(),
    refreshMode: 'ok' as 'ok' | 'invalid_grant' | 'down',
    refreshDelay: 0,
    revokeStatus: 200,
    revokes: [] as URLSearchParams[],
    mcpDown: false,
    swapProfile: null as Account | null,
  };
}

function issue(account: Account) {
  const access = `fictional-access-secret-${++n}`, refresh = `fictional-refresh-secret-${n}`;
  hermios.access.set(access, account); hermios.refresh.set(refresh, account);
  return { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope: 'api profile' };
}

async function body(req: IncomingMessage) { let s = ''; for await (const c of req) s += c; return s; }

async function route(req: IncomingMessage): Promise<{ status: number; json?: unknown; headers?: Record<string, string> }> {
  const url = new URL(req.url ?? '/', 'http://fictional');
  if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') return { status: 200, json: { ...hermios.metadata(), ...hermios.metadataPatch } };
  if (req.method === 'POST' && url.pathname === '/oauth/register') {
    if (hermios.registerStatus === 429) return { status: 429, json: { error: 'too_many_requests' } };
    const input = JSON.parse(await body(req)); hermios.registrations.push(input);
    return { status: 201, json: { client_id: `fictional-client-${hermios.registrations.length}`, redirect_uris: input.redirect_uris, token_endpoint_auth_method: 'none', grant_types: input.grant_types } };
  }
  if (req.method === 'POST' && url.pathname === '/oauth/token') {
    const form = new URLSearchParams(await body(req)); hermios.tokenCalls.push(form);
    if (form.get('grant_type') === 'authorization_code') {
      const code = hermios.codes.get(form.get('code') ?? ''); hermios.codes.delete(form.get('code') ?? '');
      if (!code || code.clientId !== form.get('client_id') || code.redirectUri !== form.get('redirect_uri') ||
          createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== code.challenge) return { status: 400, json: { error: 'invalid_grant' } };
      return { status: 200, json: issue(code.account) };
    }
    if (form.get('grant_type') === 'refresh_token') {
      if (hermios.refreshDelay) await new Promise(r => setTimeout(r, hermios.refreshDelay));
      if (hermios.refreshMode === 'down') return { status: 503, json: { error: 'unavailable' } };
      const account = hermios.refresh.get(form.get('refresh_token') ?? '');
      if (hermios.refreshMode === 'invalid_grant' || !account) return { status: 400, json: { error: 'invalid_grant', error_description: `bad ${form.get('refresh_token')}` } };
      hermios.refresh.delete(form.get('refresh_token')!); // rotation
      return { status: 200, json: issue(account) };
    }
    return { status: 400, json: { error: 'unsupported_grant_type' } };
  }
  if (req.method === 'POST' && url.pathname === '/oauth/revoke') {
    hermios.revokes.push(new URLSearchParams(await body(req)));
    return { status: hermios.revokeStatus, json: {} };
  }
  if (req.method === 'POST' && url.pathname === '/mcp') {
    if (hermios.mcpDown) return { status: 502 };
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const account = hermios.access.get(token);
    if (!account) return { status: 401, json: { error: 'invalid_token' } };
    const message = JSON.parse(await body(req));
    if (message.method === 'initialize') return { status: 200, headers: { 'mcp-session-id': 'fictional-session' }, json: { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fictional-hermios', version: '0' } } } };
    if (message.method === 'notifications/initialized') return { status: 202 };
    if (message.method === 'tools/call' && message.params?.name === 'get_hermios_profile') {
      const who = hermios.swapProfile ?? account;
      const profile = { id: who.id, workspaceId: who.workspaceId, name: who.name, nickname: who.nickname };
      return { status: 200, json: { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(profile) }], structuredContent: profile, isError: false } } };
    }
    return { status: 400 };
  }
  return { status: 404 };
}

const fictionalFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname !== 'api.hermios.app') throw new TypeError('fictional network: unexpected host');
  if (revokeNetworkDown && url.pathname === '/oauth/revoke') throw new TypeError('fictional network: down');
  return fetch(`${base}${url.pathname}${url.search}`, init);
};

let directory = '', context: HermiosConnectionContext = { companyId: 'fictional-company', memberId: 'fictional-member-a' };
let redirectUri = `http://127.0.0.1:8799${HERMIOS_OAUTH_CALLBACK_PATH}`;
function service(overrides: Partial<Parameters<typeof createHermiosConnectionService>[0]> = {}) {
  return createHermiosConnectionService({ vault: createPrivateVault(directory, randomKey), context: () => context, redirectUri: () => redirectUri,
    fetch: fictionalFetch, now: () => t, ...overrides });
}
let randomKey = randomBytes(32);

/** The person's browser at Hermios: approve as `account`, return the callback query. */
function approve(authorizeUrl: string, account: Account) {
  const url = new URL(authorizeUrl), code = `fictional-code-${++n}`;
  hermios.codes.set(code, { challenge: url.searchParams.get('code_challenge')!, redirectUri: url.searchParams.get('redirect_uri')!, clientId: url.searchParams.get('client_id')!, account });
  return new URLSearchParams({ code, state: url.searchParams.get('state')!, iss: ISSUER });
}

async function connect(svc: ReturnType<typeof service>, account: Account = ALICE) {
  const started = await svc.handle(HERMIOS_CONNECTION_START_API, 'POST', {});
  expect(started.status).toBe(200);
  const page = await svc.callback(approve((started.body as { authorizeUrl: string }).authorizeUrl, account));
  return { started, page };
}

const filesUnder = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name); return statSync(path).isDirectory() ? filesUnder(path) : [path];
});

beforeEach(async () => {
  hermios = fictionalHermios(); t = 1_700_000_000_000; n = 0; revokeNetworkDown = false; randomKey = randomBytes(32);
  directory = mkdtempSync(join(tmpdir(), 'hermios-connection-'));
  context = { companyId: 'fictional-company', memberId: 'fictional-member-a' };
  redirectUri = `http://127.0.0.1:8799${HERMIOS_OAUTH_CALLBACK_PATH}`;
  server = createServer((req, res) => {
    route(req).then(result => {
      res.writeHead(result.status, { ...(result.json !== undefined ? { 'content-type': 'application/json' } : {}), ...result.headers });
      res.end(result.json !== undefined ? JSON.stringify(result.json) : undefined);
    }, () => { res.writeHead(500); res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { await new Promise(resolve => server.close(resolve)); });

describe('Hermios connection service', () => {
  it('connects with PKCE, the exact loopback redirect and a verified profile', async () => {
    const svc = service();
    const { started, page } = await connect(svc);
    const authorize = new URL((started.body as { authorizeUrl: string }).authorizeUrl);
    expect(authorize.origin).toBe('https://app.hermios.app');
    expect(authorize.searchParams.get('iss')).toBe(ISSUER);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(authorize.searchParams.get('scope')).toBe('api profile');
    expect(hermios.registrations).toEqual([expect.objectContaining({ redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] })]);

    const exchange = hermios.tokenCalls[0]!;
    expect(exchange.get('redirect_uri')).toBe(redirectUri);
    expect(createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url')).toBe(authorize.searchParams.get('code_challenge'));
    expect(authorize.toString()).not.toContain(exchange.get('code_verifier'));

    expect(page.status).toBe(200);
    expect(page.body).toContain('Hermios is connected. You can return to RealBud.');
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['content-security-policy']).toMatch(/^default-src 'none'; style-src 'sha256-/);
    expect(page.body).not.toMatch(/<script|https?:\/\//);

    const state = (await svc.handle(HERMIOS_CONNECTION_API, 'GET')).body;
    expect(parseHermiosConnectionState(state)).toEqual({ version: 1, status: 'connected', generation: 1, reason: null,
      account: { displayName: 'Fictional Alice', workspaceLabel: 'Fictional Realty', profileId: ALICE.id, workspaceId: ALICE.workspaceId, verifiedAt: t } });
    expect(await svc.accessTokenFor(context, 1)).toMatch(/^fictional-access-secret-/);

    // Tokens are encrypted at rest: no plaintext in any private file.
    for (const file of filesUnder(directory)) expect(readFileSync(file, 'utf8')).not.toMatch(SECRET);
  });

  it('registers once per redirect and again when the RealBud port changes', async () => {
    const svc = service();
    await connect(svc);
    await svc.handle(HERMIOS_CONNECTION_START_API, 'POST', {});
    expect(hermios.registrations).toHaveLength(1);
    redirectUri = `http://127.0.0.1:8800${HERMIOS_OAUTH_CALLBACK_PATH}`;
    const again = await svc.handle(HERMIOS_CONNECTION_START_API, 'POST', {});
    expect(hermios.registrations).toHaveLength(2);
    expect(new URL((again.body as { authorizeUrl: string }).authorizeUrl).searchParams.get('client_id')).toBe('fictional-client-2');
  });

  it('shows connecting while a sign-in is pending', async () => {
    const svc = service();
    await svc.handle(HERMIOS_CONNECTION_START_API, 'POST', {});
    expect((await svc.state()).status).toBe('connecting');
    t += 10 * 60_000 + 1;
    expect((await svc.state()).status).toBe('not_connected');
  });

  it('refuses a reused, expired, unknown or other-member state without exchanging a code', async () => {
    const svc = service();
    const started = await svc.handle(HERMIOS_CONNECTION_START_API, 'POST', {});
    const query = approve((started.body as { authorizeUrl: string }).authorizeUrl, ALICE);
    expect((await svc.callback(query)).status).toBe(200);
    const reused = await svc.callback(query);
    expect(reused.status).toBe(400);
    expect(reused.body).toContain('expired or was already used');
    expect(hermios.tokenCalls).toHaveLength(1);

    const unknown = await svc.callback(new URLSearchParams({ code: 'fictional-code-x', state: 'fictional-unknown' }));
    expect(unknown.body).toContain('expired or was already used');

    const late = await svc.handle(HERMIOS_CONNECTION_START_API, 'POST', {});
    const lateQuery = approve((late.body as { authorizeUrl: string }).authorizeUrl, ALICE);
    t += 10 * 60_000 + 1;
    expect((await svc.callback(lateQuery)).body).toContain('expired or was already used');

    const other = await svc.handle(HERMIOS_CONNECTION_START_API, 'POST', {});
    const otherQuery = approve((other.body as { authorizeUrl: string }).authorizeUrl, ALICE);
    context = { companyId: 'fictional-company', memberId: 'fictional-member-b' };
    expect((await svc.callback(otherQuery)).body).toContain('changed member');
    expect(hermios.tokenCalls).toHaveLength(1);
    // A wrong `iss` is a mix-up: no exchange either.
    context = { companyId: 'fictional-company', memberId: 'fictional-member-a' };
    const mixed = await svc.handle(HERMIOS_CONNECTION_START_API, 'POST', {});
    const mixedQuery = approve((mixed.body as { authorizeUrl: string }).authorizeUrl, ALICE);
    mixedQuery.set('iss', 'https://evil.example.test');
    expect((await svc.callback(mixedQuery)).status).toBe(400);
    expect(hermios.tokenCalls).toHaveLength(1);
  });

  it.each([
    ['a different issuer', { issuer: 'https://api.hermios.app.evil.example.test' }],
    ['a non-hermios token host', { token_endpoint: 'https://evil.example.test/oauth/token' }],
    ['a plain-http endpoint', { registration_endpoint: 'http://api.hermios.app/oauth/register' }],
    ['no S256', { code_challenge_methods_supported: ['plain'] }],
  ])('refuses discovery with %s', async (_label, patch) => {
    hermios.metadataPatch = patch;
    const result = await service().handle(HERMIOS_CONNECTION_START_API, 'POST', {});
    expect(result).toEqual({ status: 503, body: { error: HERMIOS_CONNECTION_REASONS.notVerified, code: 'unavailable' } });
    expect(hermios.registrations).toHaveLength(0);
  });

  it('reports a registration rate limit plainly', async () => {
    hermios.registerStatus = 429;
    const result = await service().handle(HERMIOS_CONNECTION_START_API, 'POST', {});
    expect(result).toEqual({ status: 503, body: { error: HERMIOS_CONNECTION_REASONS.registrationLimited, code: 'unavailable' } });
  });

  it('serializes refresh: two concurrent callers share one refresh', async () => {
    const svc = service();
    await connect(svc);
    const first = await svc.accessTokenFor(context, 1);
    t += 2 * 3600_000;
    hermios.refreshDelay = 30;
    const [a, b] = await Promise.all([svc.accessTokenFor(context, 1), svc.accessTokenFor(context, 1)]);
    expect(a).toBe(b);
    expect(a).not.toBe(first);
    expect(hermios.tokenCalls.filter(call => call.get('grant_type') === 'refresh_token')).toHaveLength(1);
    // The rotated refresh token replaced the old one atomically.
    t += 2 * 3600_000;
    await expect(svc.accessTokenFor(context, 1)).resolves.toMatch(/^fictional-access-secret-/);
  });

  it('marks invalid_grant as needs_reconnect and keeps tokens on a transport failure', async () => {
    const svc = service();
    await connect(svc);
    t += 2 * 3600_000;
    hermios.refreshMode = 'down';
    const down = await svc.handle(HERMIOS_CONNECTION_CHECK_API, 'POST', {});
    expect(down.body).toMatchObject({ status: 'unavailable', account: null, reason: HERMIOS_CONNECTION_REASONS.unreachable, generation: 1 });
    hermios.refreshMode = 'ok';
    expect((await svc.handle(HERMIOS_CONNECTION_CHECK_API, 'POST', {})).body).toMatchObject({ status: 'connected', generation: 1 });

    t += 2 * 3600_000;
    hermios.refreshMode = 'invalid_grant';
    const errors: string[] = [];
    await svc.accessTokenFor(context, 1).catch((error: Error) => errors.push(error.message));
    expect(errors).toEqual([HERMIOS_CONNECTION_REASONS.signInAgain]);
    const state = await svc.state();
    expect(state).toMatchObject({ status: 'needs_reconnect', reason: HERMIOS_CONNECTION_REASONS.signInAgain, account: { profileId: ALICE.id } });
    expect(parseHermiosConnectionState(state)).not.toBeNull();
  });

  it('check detects a changed Hermios account and asks to reconnect', async () => {
    const svc = service();
    await connect(svc);
    hermios.swapProfile = BOB;
    const result = await svc.handle(HERMIOS_CONNECTION_CHECK_API, 'POST', {});
    expect(result.body).toMatchObject({ status: 'needs_reconnect', reason: HERMIOS_CONNECTION_REASONS.accountChanged, generation: 2 });
    await expect(svc.accessTokenFor(context, 1)).rejects.toMatchObject({ code: 'stale' });
    await expect(svc.accessTokenFor(context, 2)).rejects.toMatchObject({ code: 'needs_reconnect' });
  });

  it('check binds the real workspace of a connection saved with the membership placeholder', async () => {
    const svc = service();
    await connect(svc);
    const vault = createPrivateVault(directory, randomKey);
    const entry = `hermios-member-${createHash('sha256').update(JSON.stringify(['hermios-connection-v1', context.companyId, context.memberId])).digest('hex').slice(0, 48)}`;
    const saved = await vault.read(entry) as { account: Record<string, unknown> };
    await vault.write(entry, { ...saved, account: { ...saved.account, workspaceId: `membership:${ALICE.id}` } });
    const result = await svc.handle(HERMIOS_CONNECTION_CHECK_API, 'POST', {});
    expect(result.body).toMatchObject({ status: 'connected', generation: 2, account: { workspaceId: ALICE.workspaceId, profileId: ALICE.id } });
    await expect(svc.accessTokenFor(context, 1)).rejects.toMatchObject({ code: 'stale' });
    expect(await svc.accessTokenFor(context, 2)).toMatch(SECRET);
  });

  it('check treats the same member in another Hermios workspace as a new generation', async () => {
    const svc = service();
    await connect(svc);
    hermios.swapProfile = { ...ALICE, workspaceId: BOB.workspaceId };
    const result = await svc.handle(HERMIOS_CONNECTION_CHECK_API, 'POST', {});
    expect(result.body).toMatchObject({ status: 'needs_reconnect', reason: HERMIOS_CONNECTION_REASONS.accountChanged, generation: 2 });
    await expect(svc.accessTokenFor(context, 1)).rejects.toMatchObject({ code: 'stale' });
  });

  it('starts a new generation on account switch and rejects the stale one', async () => {
    const svc = service();
    await connect(svc, ALICE);
    const old = await svc.accessTokenFor(context, 1);
    await connect(svc, BOB);
    const state = await svc.state();
    expect(state).toMatchObject({ status: 'connected', generation: 2, account: { profileId: BOB.id, workspaceLabel: 'Fictional Other Org' } });
    await expect(svc.accessTokenFor(context, 1)).rejects.toMatchObject({ code: 'stale' });
    expect(await svc.accessTokenFor(context, 2)).not.toBe(old);
    // A → B → A is a third generation, never the first one again.
    await connect(svc, ALICE);
    expect((await svc.state()).generation).toBe(3);
    await expect(svc.accessTokenFor(context, 1)).rejects.toMatchObject({ code: 'stale' });
    await new Promise(r => setTimeout(r, 20));
    expect(hermios.revokes.some(form => form.get('token') === old)).toBe(true);
  });

  it('disconnect clears locally even when revoke fails', async () => {
    const svc = service();
    await connect(svc);
    hermios.revokeStatus = 500;
    const result = await svc.handle(HERMIOS_CONNECTION_DISCONNECT_API, 'POST', {});
    expect(result).toEqual({ status: 200, body: { version: 1, status: 'not_connected', account: null, generation: 2, reason: null } });
    expect(hermios.revokes.length).toBeGreaterThan(0);
    await expect(svc.accessTokenFor(context, 1)).rejects.toMatchObject({ code: 'stale' });
    await expect(svc.accessTokenFor(context, 2)).rejects.toMatchObject({ code: 'not_connected' });
    // Revoke unreachable entirely: still cleared.
    await connect(svc);
    revokeNetworkDown = true;
    expect((await svc.handle(HERMIOS_CONNECTION_DISCONNECT_API, 'POST', {})).body).toMatchObject({ status: 'not_connected', generation: 4 });
  });

  it('keeps each member to their own connection', async () => {
    const svc = service();
    await connect(svc, ALICE);
    const alice = { ...context };
    context = { companyId: 'fictional-company', memberId: 'fictional-member-b' };
    expect((await svc.handle(HERMIOS_CONNECTION_API, 'GET')).body).toEqual({ version: 1, status: 'not_connected', account: null, generation: 0, reason: null });
    await expect(svc.accessTokenFor(context, 1)).rejects.toMatchObject({ code: 'stale' });
    // B disconnecting never touches A.
    await svc.handle(HERMIOS_CONNECTION_DISCONNECT_API, 'POST', {});
    context = alice;
    expect((await svc.state()).status).toBe('connected');
    expect(await svc.accessTokenFor(alice, 1)).toMatch(/^fictional-access-secret-/);
    // Another company with the same member key is a different binding.
    await expect(svc.accessTokenFor({ companyId: 'fictional-company-2', memberId: alice.memberId }, 1)).rejects.toMatchObject({ code: 'stale' });
  });

  it('never returns a token in any route response, page or error', async () => {
    const svc = service(), seen: string[] = [];
    const record = (value: unknown) => seen.push(JSON.stringify(value));
    const { page } = await connect(svc);
    record(page);
    for (const [path, method] of [[HERMIOS_CONNECTION_API, 'GET'], [HERMIOS_CONNECTION_CHECK_API, 'POST'], [HERMIOS_CONNECTION_START_API, 'POST'], [HERMIOS_CONNECTION_API, 'POST'], ['/api/hermios/connection/nope', 'POST']] as const) {
      record(await svc.handle(path, method, {}));
    }
    t += 2 * 3600_000; hermios.refreshMode = 'invalid_grant';
    await svc.accessTokenFor(context, 1).catch((error: Error) => record({ message: error.message, stack: error.stack }));
    record(await svc.handle(HERMIOS_CONNECTION_CHECK_API, 'POST', {}));
    record(await svc.handle(HERMIOS_CONNECTION_DISCONNECT_API, 'POST', {}));
    expect(seen.length).toBeGreaterThan(5);
    for (const text of seen) expect(text).not.toMatch(SECRET);
  });

  it('rejects options on actions and unknown methods', async () => {
    const svc = service();
    expect((await svc.handle(HERMIOS_CONNECTION_START_API, 'POST', { redirectUri: 'https://evil.example.test' })).status).toBe(400);
    expect((await svc.handle(HERMIOS_CONNECTION_START_API, 'GET')).status).toBe(405);
  });
});

describe('Hermios connection session boundary', () => {
  it('requires a RealBud session for the member routes but not the browser callback', () => {
    for (const path of [HERMIOS_CONNECTION_API, HERMIOS_CONNECTION_START_API, HERMIOS_CONNECTION_CHECK_API, HERMIOS_CONNECTION_DISCONNECT_API]) {
      expect(needsSession(path, 'POST')).toBe(true);
      expect(needsSession(path, 'GET')).toBe(true);
    }
    expect(needsSession(HERMIOS_OAUTH_CALLBACK_PATH, 'GET')).toBe(false);
  });
});
