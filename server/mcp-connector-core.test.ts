import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { connectorCallbackPath, connectorConnectionApi, connectorRoute, parseConnectorState } from '../shared/mcp-connector.ts';
import { createServer } from 'node:http';
import { createMcpConnector, McpToolError, readCapped, scrubCredentials, nextPageToken, officeAuthority, pinnedTransport, publicServerAddress, type ConnectorAuthority, type ConnectorReceipt, type McpConnectorConfig, type PinnedAddress } from './mcp-connector-core.ts';
import { createPrivateVault } from './private-vault.ts';
import { needsSession } from './session-auth.ts';
import { createWorkLedger } from './work-ledger.ts';
import { fictionalConnectorService } from './testing/fictional-mcp-connector.ts';

const MCP = 'https://mcp.fictional-books.example', AUTH = 'https://auth.fictional-books.example';
const SECRET = /fictional-(?:access|refresh)-secret/;
const CONFIG: McpConnectorConfig = {
  id: 'fictional-books', label: 'Fictional Books', serverUrl: `${MCP}/mcp`, scopes: ['books:read'], authorizationServer: AUTH,
  allowlist: { list_books: 'read', delete_book: 'consequential' }, defaultArgs: { context: 'fictional' },
  verify: async call => `${(await call('list_books', {})).total} books`,
};
const req = {} as IncomingMessage;
let fake: ReturnType<typeof fictionalConnectorService>, directory = '', key = randomBytes(32), authority: ConnectorAuthority = 'manage', t = 0;
let principal = 'member:fictional-owner', stillManages: () => Promise<boolean> = async () => true;
const grant = async () => ({ authority, principal, stillManages: () => stillManages() });
let receipts: ConnectorReceipt[] = [];

function connector(config: McpConnectorConfig = CONFIG) {
  return createMcpConnector(config, { vault: createPrivateVault(directory, key), workspaceId: () => 'fictional-workspace', authorize: grant,
    redirectBase: () => 'http://127.0.0.1:8799', transport: fake.fetch, resolve: fake.resolve, now: () => t, audit: entry => receipts.push(entry) });
}
async function connect(c: ReturnType<typeof connector>) {
  const started = await c.handle('start', 'POST', req, {});
  expect(started.status).toBe(200);
  const authorizeUrl = (started.body as { authorizeUrl: string }).authorizeUrl;
  return { authorizeUrl, page: await c.callback(fake.approve(authorizeUrl)) };
}
const filesUnder = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name); return statSync(path).isDirectory() ? filesUnder(path) : [path];
});

beforeEach(() => {
  fake = fictionalConnectorService({ mcpOrigin: MCP, authOrigin: AUTH, scopes: ['books:read', 'books:write'], tools: { list_books: () => ({ total: 3 }), delete_book: () => ({ ok: true }) } });
  fake.s.grantScope = 'books:read';
  directory = mkdtempSync(join(tmpdir(), 'mcp-connector-')); key = randomBytes(32); authority = 'manage'; t = 1_700_000_000_000; receipts = [];
  principal = 'member:fictional-owner'; stillManages = async () => true;
});

describe('connector OAuth', () => {
  it('counts an open sign-in as waiting on the person for an update restart, until it completes, lapses or closes', async () => {
    const ledger = createWorkLedger(), idle = { working: 0, waiting: 0, byKind: {} };
    const c = createMcpConnector(CONFIG, { vault: createPrivateVault(directory, key), workspaceId: () => 'fictional-workspace', authorize: grant,
      redirectBase: () => 'http://127.0.0.1:8799', transport: fake.fetch, resolve: fake.resolve, now: () => t, workLedger: ledger });
    expect(ledger.snapshot()).toEqual(idle);
    const started = await c.handle('start', 'POST', req, {});
    const authorizeUrl = (started.body as { authorizeUrl: string }).authorizeUrl;
    expect(ledger.snapshot()).toEqual({ working: 0, waiting: 1, byKind: { 'connector-sign-in': { working: 0, waiting: 1 } } });
    // Counts only: never the state or link.
    expect(JSON.stringify(ledger.snapshot())).not.toContain(new URL(authorizeUrl).searchParams.get('state')!);
    expect((await c.callback(fake.approve(authorizeUrl))).status).toBe(200);
    expect(ledger.snapshot()).toEqual(idle);
    await c.handle('start', 'POST', req, {});
    expect(ledger.snapshot().waiting).toBe(1);
    c.close();
    expect(ledger.snapshot()).toEqual(idle);
  });

  it('keeps every vault name within 80 characters, even for a 40-character id, and keeps short ids on their existing key', async () => {
    const id = `f${'x'.repeat(39)}`;
    const long = connector({ ...CONFIG, id });
    expect(await long.state()).toMatchObject({ connector: id, status: 'not_connected' });
    await connect(long);
    expect(await long.state()).toMatchObject({ status: 'connected' });
    const names = readdirSync(join(directory, 'company-installation', 'private')).map(name => name.slice(0, -5));
    expect(names.every(name => name.length <= 80)).toBe(true);
    expect(names).toContain(`connector-${id}-${createHash('sha256').update(JSON.stringify(['mcp-connector-v1', id, 'fictional-workspace'])).digest('hex').slice(0, 29)}`);
    await connect(connector());
    expect(readdirSync(join(directory, 'company-installation', 'private'))).toContain(
      `connector-fictional-books-${createHash('sha256').update(JSON.stringify(['mcp-connector-v1', 'fictional-books', 'fictional-workspace'])).digest('hex').slice(0, 48)}.json`);
  });

  it('discovers from the 401, registers a public client per redirect, uses PKCE S256 and the requested scopes only', async () => {
    const c = connector();
    const { authorizeUrl, page } = await connect(c);
    const authorize = new URL(authorizeUrl);
    expect(fake.s.requests[0]).toBe(`${MCP}/mcp`);
    expect(authorize.origin).toBe(AUTH);
    expect(authorize.searchParams.get('scope')).toBe('books:read');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:8799${connectorCallbackPath('fictional-books')}`);
    expect(authorize.searchParams.get('resource')).toBe(MCP);
    expect(fake.s.registrations).toEqual([expect.objectContaining({ token_endpoint_auth_method: 'none', scope: 'books:read' })]);
    const exchange = fake.s.tokenCalls[0]!;
    expect(createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url')).toBe(authorize.searchParams.get('code_challenge'));
    expect(authorizeUrl).not.toContain(exchange.get('code_verifier'));
    expect(page.status).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['content-security-policy']).toMatch(/^default-src 'none'; style-src 'sha256-/);
    expect(page.body).not.toMatch(/<script|https?:\/\//);
    expect(parseConnectorState((await c.handle('state', 'GET', req)).body, 'fictional-books'))
      .toMatchObject({ status: 'connected', generation: 1, canManage: true, account: { label: '3 books', verifiedAt: t } });
    for (const file of filesUnder(directory)) expect(readFileSync(file, 'utf8')).not.toMatch(SECRET);
    await c.handle('start', 'POST', req, {});
    expect(fake.s.registrations).toHaveLength(1);
  });

  it('refuses a reused, expired, unknown or wrong-issuer state without exchanging a code', async () => {
    const c = connector();
    const started = await c.handle('start', 'POST', req, {});
    const query = fake.approve((started.body as { authorizeUrl: string }).authorizeUrl);
    expect((await c.callback(query)).status).toBe(200);
    expect((await c.callback(query)).body).toContain('expired or was already used');
    expect((await c.callback(new URLSearchParams({ code: 'x', state: 'fictional-unknown' }))).status).toBe(400);
    const late = await c.handle('start', 'POST', req, {});
    const lateQuery = fake.approve((late.body as { authorizeUrl: string }).authorizeUrl);
    t += 10 * 60_000 + 1;
    expect((await c.callback(lateQuery)).body).toContain('expired or was already used');
    const mixed = await c.handle('start', 'POST', req, {});
    expect((await c.callback(fake.approve((mixed.body as { authorizeUrl: string }).authorizeUrl, 'https://evil.example.test'))).status).toBe(400);
    expect(fake.s.tokenCalls).toHaveLength(1);
  });

  it('refuses a grant broader than requested, keeps nothing and revokes it', async () => {
    fake.s.grantScope = 'books:read books:write';
    const c = connector();
    expect((await connect(c)).page.body).toContain('more access than RealBud asked for');
    expect((await c.handle('state', 'GET', req)).body).toMatchObject({ status: 'not_connected' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fake.s.revokes.length).toBeGreaterThan(0);
  });

  it.each([
    ['an authorization server other than the pinned one', () => { fake.s.resourcePatch = { authorization_servers: ['https://auth.other.example'] }; }],
    ['a token endpoint on another origin', () => { fake.s.metadataPatch = { token_endpoint: 'https://evil.example.test/oauth/token' }; }],
    ['no S256', () => { fake.s.metadataPatch = { code_challenge_methods_supported: ['plain'] }; }],
    ['scopes the server does not offer', () => { fake.s.resourcePatch = { scopes_supported: ['other:read'] }; }],
  ])('refuses discovery with %s', async (_label, patch) => {
    patch();
    expect((await connector().handle('start', 'POST', req, {})).status).toBe(503);
    expect(fake.s.registrations).toHaveLength(0);
    expect(fake.s.requests.every(url => url.startsWith(MCP) || url.startsWith(AUTH))).toBe(true);
  });

  it('lets only the office owner or an admin connect or disconnect; members read status', async () => {
    authority = 'read';
    const c = connector();
    expect(await c.handle('start', 'POST', req, {})).toMatchObject({ status: 403, body: { code: 'forbidden' } });
    expect(await c.handle('disconnect', 'POST', req, {})).toMatchObject({ status: 403 });
    expect(fake.s.requests).toHaveLength(0);
    expect((await c.handle('state', 'GET', req)).body).toMatchObject({ status: 'not_connected', canManage: false });
    authority = 'manage'; await connect(c); authority = 'read';
    expect((await c.handle('state', 'GET', req)).body).toMatchObject({ status: 'connected', canManage: false });
    expect((await c.handle('check', 'POST', req, {})).body).toMatchObject({ status: 'connected' });
  });

  it('serializes refresh across concurrent reads, then invalid_grant needs a reconnect', async () => {
    const c = connector();
    await connect(c);
    t += 3600_000; fake.s.refreshDelay = 20;
    await Promise.all([c.read(call => call('list_books', {})), c.read(call => call('list_books', {})), c.read(call => call('list_books', {}))]);
    expect(fake.s.tokenCalls.filter(call => call.get('grant_type') === 'refresh_token')).toHaveLength(1);
    t += 3600_000; fake.s.refreshMode = 'invalid_grant';
    await expect(c.read(call => call('list_books', {}))).rejects.toMatchObject({ code: 'needs_reconnect' });
    expect((await c.handle('state', 'GET', req)).body).toMatchObject({ status: 'needs_reconnect' });
  });

  it('disconnect clears locally even when revoke fails', async () => {
    const c = connector();
    await connect(c);
    fake.s.revokeDown = true;
    expect(await c.handle('disconnect', 'POST', req, {})).toMatchObject({ status: 200, body: { status: 'not_connected', generation: 2 } });
    await expect(c.read(call => call('list_books', {}))).rejects.toMatchObject({ code: 'not_connected' });
    for (const file of filesUnder(directory)) expect(readFileSync(file, 'utf8')).not.toMatch(SECRET);
  });

  it('check keeps the tokens and reads unavailable when the server is down', async () => {
    const c = connector();
    await connect(c);
    fake.s.mcpDown = true;
    expect((await c.handle('check', 'POST', req, {})).body).toMatchObject({ status: 'unavailable' });
    fake.s.mcpDown = false;
    expect((await c.handle('check', 'POST', req, {})).body).toMatchObject({ status: 'connected' });
  });
});

describe('connector MCP client', () => {
  it('refuses non-allowlisted and non-read tools before any request, with a receipt and no bodies', async () => {
    const c = connector();
    await connect(c);
    const before = fake.s.requests.length;
    for (const tool of ['delete_book', 'run_sync', 'constructor']) await expect(c.read(call => call(tool, {}))).rejects.toEqual(new McpToolError('refused'));
    expect(fake.s.requests).toHaveLength(before);
    expect(receipts.filter(entry => entry.outcome === 'refused').map(entry => entry.tool)).toEqual(['delete_book', 'run_sync', 'constructor']);
    await c.read(call => call('list_books', {}));
    expect(fake.s.calls.at(-1)).toEqual({ name: 'list_books', args: { context: 'fictional' } });
    expect(receipts.at(-1)).toEqual({ connector: 'fictional-books', tool: 'list_books', outcome: 'succeeded', at: t });
    expect(JSON.stringify(c.receipts())).not.toMatch(SECRET);
  });

  it('takes only the page token from next_page_url, never its host', () => {
    const seen = new Set<string>();
    expect(nextPageToken({ next_page_url: 'https://api.redbark.internal/v2/transactions?page=tok-1' }, seen)).toBe('tok-1');
    expect(() => nextPageToken({ next_page_url: 'https://api.redbark.internal/v2/transactions?page=tok-1' }, seen)).toThrow(McpToolError);
    expect(nextPageToken({ next_page_url: null }, seen)).toBeNull();
  });
});

describe('connector server URL', () => {
  const resolveTo = (address: string) => async () => [{ address }];
  it.each([
    ['plain http', 'http://mcp.example.test/mcp', resolveTo('93.184.216.34')],
    ['loopback', 'https://mcp.example.test/mcp', resolveTo('127.0.0.1')],
    ['private', 'https://mcp.example.test/mcp', resolveTo('10.1.2.3')],
    ['link-local metadata', 'https://mcp.example.test/mcp', resolveTo('169.254.169.254')],
    ['an IPv6 loopback literal', 'https://[::1]/mcp', resolveTo('93.184.216.34')],
    ['localhost', 'https://localhost/mcp', resolveTo('93.184.216.34')],
  ])('refuses %s', async (_label, url, resolve) => {
    await expect(publicServerAddress(url, resolve)).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('accepts a public https server', async () => {
    await expect(publicServerAddress('https://mcp.example.test/mcp', resolveTo('93.184.216.34'))).resolves.toEqual({ address: '93.184.216.34', family: 4 });
  });
});

describe('security review regressions', () => {
  const startUrl = async (c: ReturnType<typeof connector>) => ((await c.handle('start', 'POST', req, {})).body as { authorizeUrl: string }).authorizeUrl;

  it('refuses a callback once the initiating owner lost authority, before any code exchange', async () => {
    const c = connector();
    const authorizeUrl = await startUrl(c);
    stillManages = async () => false;
    const page = await c.callback(fake.approve(authorizeUrl));
    expect(page.status).toBe(400);
    expect(page.body).toContain('Only the office owner or an administrator can finish this connection');
    expect(fake.s.tokenCalls).toHaveLength(0);
    expect((await c.handle('state', 'GET', req)).body).toMatchObject({ status: 'not_connected' });
  });

  it('discards and revokes tokens when authority is lost between exchange and commit', async () => {
    const c = connector();
    const authorizeUrl = await startUrl(c);
    let checks = 0;
    stillManages = async () => ++checks === 1;
    const page = await c.callback(fake.approve(authorizeUrl));
    expect(page.status).toBe(400);
    expect(fake.s.tokenCalls).toHaveLength(1);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fake.s.revokes.length).toBeGreaterThan(0);
    expect((await c.handle('state', 'GET', req)).body).toMatchObject({ status: 'not_connected' });
    for (const file of filesUnder(directory)) expect(readFileSync(file, 'utf8')).not.toMatch(SECRET);
  });

  it('drops a pending sign-in when the same person no longer manages', async () => {
    const c = connector();
    const authorizeUrl = await startUrl(c);
    expect((await c.handle('state', 'GET', req)).body).toMatchObject({ status: 'connecting' });
    authority = 'read';
    expect((await c.handle('state', 'GET', req)).body).toMatchObject({ status: 'not_connected' });
    expect((await c.callback(fake.approve(authorizeUrl))).body).toContain('expired or was already used');
  });

  it('stops paging and returns nothing once disconnected, even when remote revocation fails', async () => {
    const c = connector();
    await c.callback(fake.approve(await startUrl(c)));
    fake.s.revokeDown = true;
    const before = fake.s.calls.length;
    await expect(c.read(async call => {
      await call('list_books', {});
      await c.handle('disconnect', 'POST', req, {});
      return call('list_books', {});
    })).rejects.toMatchObject({ code: 'not_connected' });
    expect(fake.s.calls.length - before).toBe(1);
    await expect(c.read(async call => { const value = await call('list_books', {}); return value; })).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('refuses a result read after its connection was disconnected', async () => {
    const c = connector();
    await c.callback(fake.approve(await startUrl(c)));
    await expect(c.read(async call => { const value = await call('list_books', {}); await c.handle('disconnect', 'POST', req, {}); return value; }))
      .rejects.toMatchObject({ code: 'not_connected' });
  });

  it('cancels an oversized OAuth response as soon as the byte cap is passed', async () => {
    let pulled = 0, cancelled = false;
    const endless = () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { pulled += 64 * 1024; controller.enqueue(new Uint8Array(64 * 1024).fill(32)); },
      cancel() { cancelled = true; },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const c = createMcpConnector(CONFIG, { vault: createPrivateVault(directory, key), workspaceId: () => 'fictional-workspace', authorize: grant,
      redirectBase: () => 'http://127.0.0.1:8799', now: () => t, resolve: fake.resolve,
      transport: (url, init) => url.endsWith('/.well-known/oauth-protected-resource') ? Promise.resolve(endless()) : fake.fetch(url, init) });
    expect((await c.handle('start', 'POST', req, {})).status).toBe(503);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(512 * 1024);
    await expect(readCapped(new Response('x'.repeat(11)), 10)).rejects.toBeInstanceOf(McpToolError);
    await expect(readCapped(new Response('x'.repeat(10)), 10)).resolves.toBe('x'.repeat(10));
  });
});

describe('add-by-URL security regressions', () => {
  const HEADER = { ...CONFIG, auth: 'header' as const, scopes: [] };
  const token = 'fictional-access-secret-header-1';

  it('refuses to save an access token once the person lost authority while it was being checked', async () => {
    fake.s.access.add(token);
    const c = connector(HEADER);
    stillManages = async () => false;
    expect(await c.handle('token', 'POST', req, { token })).toMatchObject({ status: 403 });
    expect((await c.handle('state', 'GET', req)).body).toMatchObject({ status: 'not_connected' });
    for (const file of filesUnder(directory)) expect(readFileSync(file, 'utf8')).not.toContain(token);
  });

  it('never resurrects credentials after removal, even if verification finishes later', async () => {
    fake.s.access.add(token);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const c = createMcpConnector(HEADER, { vault: createPrivateVault(directory, key), workspaceId: () => 'fictional-workspace', authorize: grant,
      redirectBase: () => 'http://127.0.0.1:8799', resolve: fake.resolve, now: () => t,
      transport: async (url, init) => { if (String(init.body).includes('tools/call')) await gate; return fake.fetch(url, init); } });
    const pending = c.handle('token', 'POST', req, { token });
    await new Promise(resolve => setTimeout(resolve, 20));
    await c.purge();
    release();
    expect((await pending).status).toBeGreaterThanOrEqual(400);
    expect(filesUnder(directory).filter(file => !file.includes('registry'))).toEqual([]);
  });

  it('rechecks the policy right before dispatch: a tool quarantined mid-call is never sent', async () => {
    let allow: Record<string, 'read'> = { list_books: 'read' }, armed = false;
    const c = createMcpConnector({ ...CONFIG, allowlist: () => allow }, { vault: createPrivateVault(directory, key), workspaceId: () => 'fictional-workspace', authorize: grant,
      redirectBase: () => 'http://127.0.0.1:8799', resolve: fake.resolve, now: () => t,
      transport: async (url, init) => { if (armed && String(init.body).includes('"initialize"')) allow = {}; return fake.fetch(url, init); } });
    await c.callback(fake.approve(((await c.handle('start', 'POST', req, {})).body as { authorizeUrl: string }).authorizeUrl));
    armed = true;
    const before = fake.s.calls.length;
    await expect(c.read(call => call('list_books', {}))).rejects.toEqual(new McpToolError('refused'));
    expect(fake.s.calls.length).toBe(before);
  });

  it('scrubs an echoed bearer from a result before it leaves the core', async () => {
    fake = fictionalConnectorService({ mcpOrigin: MCP, authOrigin: AUTH, scopes: ['books:read'], tools: { list_books: () => ({ total: 3, echo: [...fake.s.access].join(' ') }) } });
    fake.s.grantScope = 'books:read';
    const c = connector();
    await connect(c);
    const result = await c.read(call => call('list_books', {}));
    expect(JSON.stringify(result)).not.toMatch(SECRET);
    expect(JSON.stringify(result)).toContain('[redacted]');
  });

  it('scrubs every accepted credential exactly, at any length and with any characters', () => {
    expect(scrubCredentials({ 'k-ab"c': 'x ab"c y', list: ['ab"c'], n: 1 }, ['ab"c'])).toEqual({ 'k-[redacted]': 'x [redacted] y', list: ['[redacted]'], n: 1 });
  });

  it('keeps DNS resolution inside the request deadline', async () => {
    const stalled = () => new Promise<Array<{ address: string }>>(() => {});
    const started = Date.now();
    await expect(publicServerAddress('https://mcp.example.test/mcp', stalled, AbortSignal.timeout(30))).rejects.toMatchObject({ code: 'unavailable' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('connector egress pinning', () => {
  it('pins each request to the address it checked and refuses a name that turns private', async () => {
    const pinned: Array<{ url: string; address: string }> = [];
    let answer = '93.184.216.34';
    const c = createMcpConnector(CONFIG, { vault: createPrivateVault(directory, key), workspaceId: () => 'fictional-workspace', authorize: grant,
      redirectBase: () => 'http://127.0.0.1:8799', now: () => t, resolve: async () => [{ address: answer }],
      transport: (url, init, address: PinnedAddress) => { pinned.push({ url, address: address.address }); return fake.fetch(url, init); } });
    const authorizeUrl = ((await c.handle('start', 'POST', req, {})).body as { authorizeUrl: string }).authorizeUrl;
    expect(pinned.length).toBeGreaterThan(0);
    expect(pinned.every(entry => entry.address === '93.184.216.34')).toBe(true);
    // Public at check time, private by the time the token request connects.
    answer = '10.0.0.7';
    const sent = pinned.length;
    const page = await c.callback(fake.approve(authorizeUrl));
    expect(page.status).toBe(400);
    expect(pinned).toHaveLength(sent);
    expect(fake.s.tokenCalls).toHaveLength(0);
  });

  it('connects to the pinned address even when the host name resolves elsewhere', async () => {
    const server = createServer((request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ host: request.headers.host, method: request.method })); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as { port: number }).port;
      // `rebind.fictional.invalid` does not resolve; only the pinned lookup can reach the server.
      const response = await pinnedTransport(`http://rebind.fictional.invalid:${port}/mcp`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000) }, { address: '127.0.0.1', family: 4 });
      expect(await response.json()).toEqual({ host: `rebind.fictional.invalid:${port}`, method: 'POST' });
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});

describe('office authority', () => {
  const me = (status: number, member: Record<string, unknown> | null) => async () => ({ status, body: member ? { company: { id: 'fictional-company' }, member } : { error: 'x' } });
  const authority = async (seat: string | null, reply: ReturnType<typeof me>, admin = false) => (await officeAuthority({ serviceAdmin: () => admin, seatIdentity: async () => seat, companyMe: reply })(req)).authority;
  it('gives a single-seat install manage', async () => { expect(await authority(null, me(401, null))).toBe('manage'); });
  it('gives the company owner on this seat manage', async () => { expect(await authority('fictional-seat-1', me(200, { id: 'fictional-seat-1', role: 'owner' }))).toBe('manage'); });
  it('gives a company member read', async () => { expect(await authority('fictional-seat-1', me(200, { id: 'fictional-seat-1', role: 'member' }))).toBe('read'); });
  it('reads when the session is missing or another member', async () => {
    expect(await authority('fictional-seat-1', me(401, null))).toBe('read');
    expect(await authority('fictional-seat-1', me(200, { id: 'fictional-seat-2', role: 'owner' }))).toBe('read');
  });
  it('re-checks the same identity: a transferred or revoked owner no longer manages', async () => {
    let role = 'owner', seat: string | null = 'fictional-seat-1';
    const granted = await officeAuthority({ serviceAdmin: () => false, seatIdentity: async () => seat, companyMe: async () => ({ status: 200, body: { member: { id: 'fictional-seat-1', role } } }) })(req);
    expect(granted).toMatchObject({ authority: 'manage', principal: 'member:fictional-seat-1' });
    expect(await granted.stillManages()).toBe(true);
    role = 'member';
    expect(await granted.stillManages()).toBe(false);
    role = 'owner'; seat = null;
    expect(await granted.stillManages()).toBe(false);
  });
  it('gives a service admin manage', async () => { expect(await authority('fictional-seat-1', me(401, null), true)).toBe('manage'); });
});

describe('connector routes', () => {
  it('maps generic and alias paths and keeps the callback outside the session gate', () => {
    expect(connectorRoute(connectorConnectionApi('redbark'))).toEqual({ id: 'redbark', action: 'state' });
    expect(connectorRoute('/api/connectors/redbark/connection/start')).toEqual({ id: 'redbark', action: 'start' });
    expect(connectorRoute('/api/connectors/redbark/oauth/callback')).toEqual({ id: 'redbark', action: 'callback' });
    expect(connectorRoute('/api/redbark/connection/disconnect')).toEqual({ id: 'redbark', action: 'disconnect' });
    expect(connectorRoute('/api/redbark/oauth/callback')).toEqual({ id: 'redbark', action: 'callback' });
    expect(connectorRoute('/api/connectors/Bad_Id/connection')).toBeNull();
    expect(connectorRoute('/api/connectors/redbark/connection/other')).toBeNull();
    expect(needsSession('/api/connectors/redbark/connection')).toBe(true);
    expect(needsSession('/api/connectors/redbark/connection/start', 'POST')).toBe(true);
    expect(needsSession('/api/redbark/connection/start', 'POST')).toBe(true);
    expect(needsSession('/api/connectors/redbark/oauth/callback')).toBe(false);
    expect(needsSession('/api/redbark/oauth/callback')).toBe(false);
  });
});

describe("live connection signals across generations", () => {
  it("rejects a resumed older generation without aborting the current one", async () => {
    const { createLiveSignals } = await import("./mcp-connector-core.ts");
    const signals = createLiveSignals();
    const first = signals.signal("redbark:ws", 1);
    const second = signals.signal("redbark:ws", 2);
    expect(first.aborted).toBe(true);
    // The delayed generation-1 read resumes after the reconnect.
    const resumedOld = signals.signal("redbark:ws", 1);
    expect(resumedOld.aborted).toBe(true);
    expect(second.aborted).toBe(false);
    expect(signals.signal("redbark:ws", 2)).toBe(second);
    signals.retire("redbark:ws");
    expect(second.aborted).toBe(true);
  });
});

describe("credential scrubbing fails closed on deep nesting", () => {
  const nest = (depth: number, leaf: unknown) => { let value: unknown = leaf; for (let i = 0; i < depth; i++) value = { inner: value }; return value; };
  it("scrubs within the depth limit and refuses anything deeper, never passing it through", async () => {
    const { scrubCredentials, McpToolError } = await import("./mcp-connector-core.ts");
    const secret = "tok123";
    expect(JSON.stringify(scrubCredentials(nest(60, `echo ${secret}`), [secret]))).not.toContain(secret);
    // At depth 65 the leaf string is still scrubbed; any object beyond the walk limit is refused.
    expect(JSON.stringify(scrubCredentials(nest(65, `echo ${secret}`), [secret]))).not.toContain(secret);
    expect(() => scrubCredentials(nest(65, []), [secret])).toThrow(McpToolError);
    for (const depth of [66, 67, 200]) {
      expect(() => scrubCredentials(nest(depth, `echo ${secret}`), [secret])).toThrow(McpToolError);
      expect(() => scrubCredentials(nest(depth, { token: secret }), [secret])).toThrow(McpToolError);
    }
  });
});
