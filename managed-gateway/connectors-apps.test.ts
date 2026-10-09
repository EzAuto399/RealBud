import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManagedConnectors, newConnectorCredential, validateConnectorDevices, type ConnectorDevice } from './connectors.ts';
import { composioAuthConfigClient, managedAuthConfigName, oauthAppsFromEnv, type ComposioAuthConfigClient } from './composio-auth-config.ts';
import { composioAppAdapter, type AppBinding, type ComposioAppAdapter } from './composio-apps.ts';
import { fixture, reviewedMailParams, gmailProfileTransport } from './testing.ts';
import { GatewayError } from './contracts.ts';
import { classifyAppTool } from '../shared/app-tool-policy.ts';

/** Two offices, one installation each. Office B's project key and config must
 * never appear in anything office A does. */
function setup() {
  const f = fixture();
  f.ledger.provisionTenant({ ...f.tenant, companyId: 'company-b', licenseId: 'license-b' });
  const a = newConnectorCredential(), b = newConnectorCredential();
  const device = (id: string, company: string, license: string, credential: { tokenHash: string }, extra: Partial<ConnectorDevice> = {}): ConnectorDevice => ({
    id, companyId: company, licenseId: license, memberId: id, installationId: id, profile: 'property', tokenHash: credential.tokenHash, active: true,
    expiresAt: f.now() + 3600_000, projectKeyEnv: `REALBUD_COMPOSIO_PROJECT_${company.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`, authConfigId: `ac_gmail_${company}`, userId: `installation-${id}`, apps: ['gmail'], ...extra });
  let devices: ConnectorDevice[] = [device('install-a', f.tenant.companyId, f.tenant.licenseId, a), device('install-b', 'company-b', 'license-b', b)];
  const secrets: Record<string, string> = { REALBUD_COMPOSIO_PROJECT_COMPANY_A: 'ak_fictional_office_a', REALBUD_COMPOSIO_PROJECT_COMPANY_B: 'ak_fictional_office_b' };
  const admitted: { deviceId: string; app: string }[] = [];
  const admitApp = (deviceId: string, app: string) => { admitted.push({ deviceId, app }); devices = devices.map(d => d.id === deviceId && !d.apps!.includes(app) ? { ...d, apps: [...d.apps!, app] } : d); };
  // Composio auth-config surface keyed by project key: each office sees only its own configs.
  const configs = new Map<string, Record<string, unknown>[]>(); let creates = 0; const toolkitLookups: string[] = []; const createBodies: unknown[] = [];
  let createDelay = 0; let refuseLink = 0;
  const authConfigs = composioAuthConfigClient({ fetch: async (url, init) => {
    const key = new Headers(init.headers).get('x-api-key')!; assert.ok(key.startsWith('ak_fictional_office_')); assert.equal(new Headers(init.headers).get('x-org-api-key'), null);
    const u = new URL(url);
    const toolkit = /\/toolkits\/([^/]+)$/.exec(u.pathname)?.[1];
    if (toolkit) { toolkitLookups.push(`${key}:${toolkit}`); return toolkit === 'nosuchapp' ? new Response('', { status: 404 }) : Response.json({ slug: toolkit, composio_managed_auth_schemes: ['apikeyonly', 'keyapp'].includes(toolkit) ? [] : ['OAUTH2'],
      ...(toolkit === 'keyapp' ? { auth_config_details: [{ mode: 'API_KEY', fields: { auth_config_creation: { required: [] }, connected_account_initiation: { required: [{ name: 'generic_api_key' }] } } }] } : {}) }); }
    assert.ok(u.pathname.endsWith('/auth_configs'));
    if (init.method === 'POST') {
      if (createDelay) await new Promise(r => setTimeout(r, createDelay));
      const body = JSON.parse(init.body as string) as { toolkit: { slug: string }; auth_config: { name: string; type: string; authScheme?: string; credentials?: unknown } };
      const id = `ac_${body.toolkit.slug}_${++creates}`; createBodies.push(body);
      const custom = body.auth_config.type === 'use_custom_auth';
      configs.set(key, [...(configs.get(key) ?? []), { id, name: body.auth_config.name, toolkit: { slug: body.toolkit.slug }, auth_scheme: custom ? body.auth_config.authScheme : 'OAUTH2', is_composio_managed: !custom, status: 'ENABLED' }]);
      return Response.json({ auth_config: { id } }, { status: 201 });
    }
    const slug = u.searchParams.get('toolkit_slug');
    return Response.json({ items: (configs.get(key) ?? []).filter(c => (c.toolkit as { slug: string }).slug === slug), next_cursor: null });
  } });
  // Generic adapter fake: records every binding it is handed.
  const bindings: { op: string; slug: string; binding: AppBinding }[] = [];
  const accounts = new Map<string, { id: string; status: string }[]>();
  const apps: ComposioAppAdapter = {
    async upsertTrigger() { throw new Error('unused'); }, async setTriggerStatus() { throw new Error('unused'); },
    async listAccounts(binding, slug) { bindings.push({ op: 'accounts', slug, binding }); return accounts.get(`${binding.apiKey}:${binding.authConfigId}:${binding.userId}`) ?? []; },
    async authorize(binding) { bindings.push({ op: 'authorize', slug: '', binding }); if (refuseLink) throw Object.assign(new Error('Connected app: the provider refused the request.'), { status: refuseLink }); return { url: 'https://connect.composio.dev/link/fictional', accountId: `acct_${binding.userId}`, expiresAt: new Date(f.now() + 600_000).toISOString() }; },
    async listTools(binding, slug) { bindings.push({ op: 'tools', slug, binding }); const up = slug.toUpperCase(); return [
      { name: `${up}_LIST_INVOICES`, description: 'list', inputSchema: { type: 'object', properties: {} }, policy: 'read' },
      { name: `${up}_CREATE_INVOICE`, description: 'create', inputSchema: { type: 'object', properties: {} }, policy: 'review' },
      { name: `${up}_DELETE_INVOICE`, description: 'delete', inputSchema: { type: 'object', properties: {} }, policy: 'blocked' } ]; },
    async execute(binding, slug, tool, args) { bindings.push({ op: `execute:${tool}`, slug, binding }); return { content: [{ type: 'text', text: JSON.stringify({ tool, args }) }] }; },
  };
  let gmailCalls = 0;
  const make = (overrides: Partial<ConstructorParameters<typeof ManagedConnectors>[0]> = {}) => new ManagedConnectors({ ledger: f.ledger, devices: () => devices, secret: name => secrets[name],
    access: async () => { gmailCalls++; return { checkedAt: new Date(f.now()).toISOString(), services: { gmail: { connected: false, status: 'NOT_CONNECTED', accounts: [], accountSelectionRequired: false } }, tools: { available: false, names: [] } }; },
    authConfigs, admitApp, apps, mailProfile: gmailProfileTransport, ...overrides });
  const request = (token: string, path: string, body?: unknown, session?: string) => ({ token, profile: 'property', method: body === undefined ? 'GET' : 'POST', path, body, session, signal: new AbortController().signal });
  return { f, a, b, make, request, createBodies, devices: () => devices, set: (next: ConnectorDevice[]) => { devices = next; }, admitted, bindings, accounts, authConfigs, creates: () => creates, toolkitLookups, gmailCalls: () => gmailCalls, setCreateDelay: (ms: number) => { createDelay = ms; }, refuseLink: (status: number) => { refuseLink = status; } };
}

test('"connect xero" admits the app on demand into its own office project, then links the installation user', async () => {
  const s = setup(); try {
    const broker = s.make();
    const reply = await broker.handle(s.request(s.a.token, '/v1/connectors/authorize', { app: 'xero' }));
    assert.deepEqual(reply.body, { url: 'https://connect.composio.dev/link/fictional' });
    // One toolkit lookup and one managed config, both under office A's key only.
    assert.deepEqual(s.toolkitLookups, ['ak_fictional_office_a:xero']); assert.equal(s.creates(), 1);
    const link = s.bindings.find(b => b.op === 'authorize')!;
    assert.equal(link.binding.apiKey, 'ak_fictional_office_a'); assert.equal(link.binding.authConfigId, 'ac_xero_1'); assert.equal(link.binding.userId, 'installation-install-a'); assert.equal(link.binding.accountId, undefined);
    // The device's registry allowlist gained the app; the Gmail binding is untouched.
    assert.deepEqual(s.admitted, [{ deviceId: 'install-a', app: 'xero' }]);
    assert.deepEqual(s.devices()[0]!.apps, ['gmail', 'xero']); assert.equal(s.devices()[0]!.authConfigId, 'ac_gmail_company-a');
    assert.deepEqual(s.devices()[1]!.apps, ['gmail']);
    // A repeat returns the live link without another config, lookup or link.
    assert.deepEqual((await broker.handle(s.request(s.a.token, '/v1/connectors/authorize', { app: 'xero' }))).body, reply.body);
    assert.equal(s.creates(), 1); assert.equal(s.bindings.filter(b => b.op === 'authorize').length, 1); assert.equal(s.toolkitLookups.length, 1);
    // Audit lines carry identifiers, never the project key.
    const journal = JSON.stringify(s.f.ledger.db.all('SELECT * FROM events'));
    assert.ok(journal.includes('connector_app_admitted') && !journal.includes('ak_fictional'));
  } finally { s.f.close(); }
});

test('a second office connecting the same app gets its own config under its own key; neither office sees the other', async () => {
  const s = setup(); try {
    const broker = s.make();
    await broker.handle(s.request(s.a.token, '/v1/connectors/authorize', { app: 'xero' }));
    await broker.handle(s.request(s.b.token, '/v1/connectors/authorize', { app: 'xero' }));
    assert.equal(s.creates(), 2);
    const links = s.bindings.filter(b => b.op === 'authorize');
    assert.deepEqual(links.map(l => [l.binding.apiKey, l.binding.authConfigId, l.binding.userId]), [['ak_fictional_office_a', 'ac_xero_1', 'installation-install-a'], ['ak_fictional_office_b', 'ac_xero_2', 'installation-install-b']]);
    // A third installation of office A reuses office A's config: no create, no lookup.
    const c = newConnectorCredential();
    s.set([...s.devices(), { ...s.devices()[0]!, id: 'install-c', memberId: 'install-c', installationId: 'install-c', tokenHash: c.tokenHash, userId: 'installation-install-c', apps: ['gmail'] }]);
    await broker.handle(s.request(c.token, '/v1/connectors/authorize', { app: 'xero' }));
    assert.equal(s.creates(), 2); assert.equal(s.toolkitLookups.length, 2);
    assert.equal(s.bindings.filter(b => b.op === 'authorize').at(-1)!.binding.authConfigId, 'ac_xero_1');
  } finally { s.f.close(); }
});

test('concurrent first connects of one app in one office create exactly one config', async () => {
  const s = setup(); try {
    s.setCreateDelay(20);
    const broker = s.make();
    const c = newConnectorCredential();
    s.set([...s.devices(), { ...s.devices()[0]!, id: 'install-c', memberId: 'install-c', installationId: 'install-c', tokenHash: c.tokenHash, userId: 'installation-install-c' }]);
    const [one, two] = await Promise.all([broker.handle(s.request(s.a.token, '/v1/connectors/authorize', { app: 'slack' })), broker.handle(s.request(c.token, '/v1/connectors/authorize', { app: 'slack' }))]);
    assert.equal(one.status, 200); assert.equal(two.status, 200);
    assert.equal(s.creates(), 1);
    assert.deepEqual(new Set(s.bindings.filter(b => b.op === 'authorize').map(b => b.binding.authConfigId)), new Set(['ac_slack_1']));
  } finally { s.f.close(); }
});

test('an unknown toolkit, one without managed auth, a bad slug and Gmail itself are never admitted this way', async () => {
  const s = setup(); try {
    const broker = s.make();
    await assert.rejects(() => broker.handle(s.request(s.a.token, '/v1/connectors/authorize', { app: 'nosuchapp' })), /connector_app_unavailable/);
    await assert.rejects(() => broker.handle(s.request(s.a.token, '/v1/connectors/authorize', { app: 'apikeyonly' })), /connector_app_unavailable/);
    for (const app of ['Xero', 'xero;drop', '../gmail', '', 42]) await assert.rejects(() => broker.handle(s.request(s.a.token, '/v1/connectors/authorize', { app })), /connector_app_not_admitted/);
    assert.equal(s.creates(), 0); assert.deepEqual(s.admitted, []);
    // Gmail keeps its own path: no toolkit lookup, no config create, the device's binding.
    await assert.rejects(() => broker.handle(s.request(s.a.token, '/v1/connectors/authorize', { app: 'gmail' })), /connector_check_failed|Gmail/);
    assert.equal(s.toolkitLookups.length, 2); assert.equal(s.creates(), 0);
    // Without admission composed, the old refusal stands and nothing is written.
    const plain = s.make({ authConfigs: undefined, admitApp: undefined });
    await assert.rejects(() => plain.handle(s.request(s.a.token, '/v1/connectors/authorize', { app: 'xero' })), /connector_app_not_admitted/);
    assert.deepEqual(s.admitted, []);
  } finally { s.f.close(); }
});

test('an API-key app is admitted with a key config and the same hosted link; RealBud never holds the key', async () => {
  const s = setup(); try {
    const broker = s.make();
    const reply = await broker.handle(s.request(s.a.token, '/v1/connectors/authorize', { app: 'keyapp' }));
    assert.deepEqual(reply.body, { url: 'https://connect.composio.dev/link/fictional' });
    assert.deepEqual(s.toolkitLookups, ['ak_fictional_office_a:keyapp']);
    // The config holds no secret: the person types the key on Composio's page.
    assert.deepEqual(s.createBodies, [{ toolkit: { slug: 'keyapp' }, auth_config: { type: 'use_custom_auth', authScheme: 'API_KEY', name: 'realbud-keyapp-key-v1', credentials: {} } }]);
    assert.equal(s.bindings.find(b => b.op === 'authorize')!.binding.authConfigId, 'ac_keyapp_1');
    assert.deepEqual(s.admitted, [{ deviceId: 'install-a', app: 'keyapp' }]);
    // Office B's computer reuses nothing of office A's.
    await broker.handle(s.request(s.b.token, '/v1/connectors/authorize', { app: 'keyapp' }));
    assert.equal(s.creates(), 2); assert.deepEqual(s.toolkitLookups, ['ak_fictional_office_a:keyapp', 'ak_fictional_office_b:keyapp']);
  } finally { s.f.close(); }
});

test('an uncertain config create is held for the office and never repeated', async () => {
  const s = setup(); try {
    let posts = 0;
    const flaky: ComposioAuthConfigClient = { ...s.authConfigs, resolveGmail: s.authConfigs.resolveGmail, toolkitAuth: async () => 'managed' as const,
      async resolveAuthConfig(o) { if (o.allowCreate) { o.beforeCreate(); posts++; } throw Object.assign(new Error('connector_auth_config_create_unconfirmed'), { code: 'connector_auth_config_create_unconfirmed' }); } };
    const broker = s.make({ authConfigs: flaky });
    await assert.rejects(() => broker.handle(s.request(s.a.token, '/v1/connectors/authorize', { app: 'xero' })));
    await assert.rejects(() => broker.handle(s.request(s.a.token, '/v1/connectors/authorize', { app: 'xero' })));
    assert.equal(posts, 1); assert.deepEqual(s.admitted, []);
    assert.equal(s.f.ledger.db.get<{ state: string }>('SELECT state FROM connector_office_apps WHERE company=? AND app=?', s.f.tenant.companyId, 'xero')!.state, 'pending');
  } finally { s.f.close(); }
});

test('status reports every admitted app; a connected app exposes only its read and review tools, and MCP refuses a blocked one', async () => {
  const s = setup(); try {
    const broker = s.make();
    await broker.handle(s.request(s.a.token, '/v1/connectors/authorize', { app: 'xero' }));
    // Not yet signed in: listed, not connected, no tools.
    let status = await broker.handle(s.request(s.a.token, '/v1/connectors/status'));
    let body = status.body as { services: Record<string, { connected: boolean; status: string }>; tools: { available: boolean; names: string[] }; apps: string[] };
    assert.deepEqual(body.apps, ['gmail', 'xero']); assert.equal(body.services.xero!.connected, false); assert.deepEqual(body.tools, { available: false, names: [] });
    // The sign-in completed at the provider under this installation's own user.
    s.accounts.set('ak_fictional_office_a:ac_xero_1:installation-install-a', [{ id: 'acct_installation-install-a', status: 'ACTIVE' }]);
    status = await broker.handle(s.request(s.a.token, '/v1/connectors/status'));
    body = status.body as typeof body;
    assert.equal(body.services.xero!.connected, true); assert.deepEqual(body.tools, { available: true, names: ['XERO_LIST_INVOICES', 'XERO_CREATE_INVOICE'] });
    assert.ok(!JSON.stringify(body).includes('ak_fictional') && !JSON.stringify(body).includes('ac_xero'));
    // Office B's status shows none of this.
    const other = (await broker.handle(s.request(s.b.token, '/v1/connectors/status'))).body as typeof body;
    assert.deepEqual(other.apps, ['gmail']); assert.equal(other.services.xero, undefined);
    // MCP: list carries classified annotations; a read executes with the bound
    // account; a blocked tool is refused before the adapter is asked.
    const opened = await broker.handle(s.request(s.a.token, '/v1/connectors/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize' }));
    const listed = await broker.handle(s.request(s.a.token, '/v1/connectors/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, opened.session));
    const tools = (listed.body as { result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] } }).result.tools;
    assert.deepEqual(tools.map(t => [t.name, t.annotations.readOnlyHint]), [['XERO_LIST_INVOICES', true], ['XERO_CREATE_INVOICE', false]]);
    const read = await broker.handle(s.request(s.a.token, '/v1/connectors/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'XERO_LIST_INVOICES', arguments: { page: 1 } } }, opened.session));
    assert.equal((read.body as { result: { isError?: boolean } }).result.isError, undefined);
    const executed = s.bindings.find(b => b.op === 'execute:XERO_LIST_INVOICES')!;
    assert.equal(executed.binding.accountId, 'acct_installation-install-a'); assert.equal(executed.binding.apiKey, 'ak_fictional_office_a');
    const blocked = await broker.handle(s.request(s.a.token, '/v1/connectors/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'XERO_DELETE_INVOICE', arguments: {} } }, opened.session));
    assert.equal((blocked.body as { result: { isError?: boolean } }).result.isError, true);
    const foreign = await broker.handle(s.request(s.a.token, '/v1/connectors/mcp', { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'SLACK_LIST_CHANNELS', arguments: {} } }, opened.session));
    assert.equal((foreign.body as { result: { isError?: boolean } }).result.isError, true);
    assert.equal(s.bindings.filter(b => b.op.startsWith('execute:')).length, 1);
  } finally { s.f.close(); }
});

test('Ask runs the full Gmail toolkit under the mailbox policy, only on a verified account, and never lists or runs a blocked tool', async () => {
  const s = setup(); try {
    s.set(s.devices().map(d => d.id === 'install-a' ? { ...d, accountId: 'acct_gmail_a' } : d));
    let connected = true; const executed: { tool: string; accountId?: string; apiKey: string; args: unknown }[] = [];
    const names = ['GMAIL_LIST_THREADS', 'GMAIL_CREATE_EMAIL_DRAFT', 'GMAIL_SEND_EMAIL', 'GMAIL_SEND_DRAFT', 'GMAIL_MOVE_TO_TRASH', 'GMAIL_DELETE_MESSAGE', 'GMAIL_CREATE_FILTER', 'GMAIL_UPDATE_VACATION_SETTINGS'];
    const apps: ComposioAppAdapter = {
      async listAccounts() { return []; }, async authorize() { throw new Error('unused'); },
      async upsertTrigger() { throw new Error('unused'); }, async setTriggerStatus() { throw new Error('unused'); },
      // As the real adapter does: every toolkit tool, classified by the shared policy (Composio's own hints included).
      async listTools(_binding, slug) { return names.map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {} }, policy: classifyAppTool(name, { app: slug, annotations: name === 'GMAIL_SEND_DRAFT' ? { destructiveHint: true } : undefined }) })); },
      async execute(binding, slug, tool, args) { assert.equal(slug, 'gmail'); executed.push({ tool, accountId: binding.accountId, apiKey: binding.apiKey, args }); return { content: [{ type: 'text', text: '{}' }] }; },
    };
    const broker = s.make({ apps, access: async binding => ({ checkedAt: new Date(s.f.now()).toISOString(), services: { gmail: { connected, status: connected ? 'ACTIVE' : 'NOT_CONNECTED',
      accounts: connected ? [{ id: binding.accountId!, status: 'ACTIVE' }] : [], accountSelectionRequired: false } }, tools: { available: connected, names: [] } }) });
    const rpc = (id: number, method: string, params?: unknown, session?: string) => broker.handle(s.request(s.a.token, '/v1/connectors/mcp', { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }, session));
    const opened = await rpc(1, 'initialize');
    const listed = (await rpc(2, 'tools/list', undefined, opened.session)).body as { result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] } };
    assert.deepEqual(listed.result.tools.map(t => [t.name, t.annotations.readOnlyHint]), [['GMAIL_LIST_THREADS', true], ['GMAIL_CREATE_EMAIL_DRAFT', true], ['GMAIL_SEND_EMAIL', false], ['GMAIL_SEND_DRAFT', false], ['GMAIL_MOVE_TO_TRASH', false]]);
    const send = await rpc(3, 'tools/call', reviewedMailParams(opened, { name: 'GMAIL_SEND_EMAIL', arguments: { recipient_email: 'tenant@example.test', body: 'Hi' } }), opened.session);
    assert.equal((send.body as { result: { isError?: boolean } }).result.isError, undefined);
    assert.deepEqual(executed, [{ tool: 'GMAIL_SEND_EMAIL', accountId: 'acct_gmail_a', apiKey: 'ak_fictional_office_a', args: { recipient_email: 'tenant@example.test', body: 'Hi' } }]);
    for (const name of ['GMAIL_DELETE_MESSAGE', 'GMAIL_CREATE_FILTER', 'GMAIL_UPDATE_VACATION_SETTINGS', 'GMAIL_NOT_A_TOOL']) {
      const refused = await rpc(4, 'tools/call', { name, arguments: {} }, opened.session);
      assert.equal((refused.body as { result: { isError?: boolean } }).result.isError, true, name);
    }
    assert.equal(executed.length, 1);
    // A fresh session whose account no longer verifies runs nothing.
    connected = false;
    const later = await rpc(5, 'initialize');
    await assert.rejects(() => rpc(6, 'tools/call', { name: 'GMAIL_LIST_THREADS', arguments: {} }, later.session), /connector_account_not_connected/);
    assert.equal(executed.length, 1);
  } finally { s.f.close(); }
});

test('an office shared mailbox keeps the three bounded reads it was granted; the gateway blocks by arguments too', async () => {
  const s = setup(); const realFetch = globalThis.fetch; const upstream: string[] = [];
  globalThis.fetch = (async (url: string | URL) => { upstream.push(String(url)); throw new Error('no network in tests'); }) as typeof fetch;
  try {
    const executed: string[] = [];
    const apps: ComposioAppAdapter = { async listAccounts() { return []; }, async authorize() { throw new Error('unused'); },
      async upsertTrigger() { throw new Error('unused'); }, async setTriggerStatus() { throw new Error('unused'); },
      async listTools() { return []; }, async execute(_b, _s, tool) { executed.push(tool); return { content: [] }; } };
    const broker = s.make({ apps, access: async binding => ({ checkedAt: new Date(s.f.now()).toISOString(), services: { gmail: { connected: true, status: 'ACTIVE', accounts: [{ id: binding.accountId!, status: 'ACTIVE' }], accountSelectionRequired: false } }, tools: { available: true, names: [] } }) });
    // The office granted this desktop its shared mailbox before the 2026-10-02 decision.
    const policy = { mode: 'shared' as const, revision: 4, grants: [] as string[] };
    Object.assign(broker.officeMailbox, { policy: () => policy, binding: () => ({ apiKey: 'ak_fictional_office_a', authConfigId: 'ac_gmail_company-a', userId: 'office-owner', accountId: 'acct_shared' }) });
    const rpc = (id: number, method: string, params?: unknown, session?: string) => broker.handle({ ...s.request(s.a.token, '/v1/connectors/mcp', { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }, session), policyRevision: 4 });
    const opened = await rpc(1, 'initialize');
    for (const name of ['GMAIL_SEND_EMAIL', 'GMAIL_CREATE_EMAIL_DRAFT', 'GMAIL_ADD_LABEL_TO_EMAIL']) {
      const reply = await rpc(2, 'tools/call', reviewedMailParams(opened, { name, arguments: {} }), opened.session);
      const result = (reply.body as { result: { isError?: boolean; content: { text: string }[] } }).result;
      assert.equal(result.isError, true, name); assert.match(result.content[0]!.text, /three fixed Gmail read tools/);
    }
    assert.deepEqual(upstream, []); assert.deepEqual(executed, []);
  } finally { globalThis.fetch = realFetch; s.f.close(); }
});

test('new app links return to RealBud without changing the office binding or upstream endpoint', async () => {
  const binding = { apiKey: 'ak_fictional_office_a', authConfigId: 'ac_xero', userId: 'installation-a', callback_url: 'https://untrusted.invalid/' };
  const result = { redirect_url: 'https://connect.composio.dev/link/fictional', connected_account_id: 'ca_fictional', expires_at: new Date(Date.now() + 600_000).toISOString() };
  let calls = 0;
  const adapter = composioAppAdapter({ base: 'https://composio.example.invalid/api/v3.1', fetch: async (url, init) => {
    calls++;
    assert.equal(url, 'https://composio.example.invalid/api/v3.1/connected_accounts/link');
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).get('x-api-key'), binding.apiKey);
    assert.deepEqual(JSON.parse(String(init.body)), { auth_config_id: binding.authConfigId, user_id: binding.userId,
      callback_url: 'https://realbud-managed-gateway.fly.dev/connections/complete' });
    return Response.json({ ...result, link_token: 'not-projected' });
  } });
  assert.deepEqual(await adapter.authorize(binding, new AbortController().signal), {
    url: result.redirect_url, accountId: result.connected_account_id, expiresAt: result.expires_at,
  });
  assert.equal(calls, 1);
});

test('the generic adapter refuses a call whose arguments cancel or decline an event', async () => {
  const adapter = composioAppAdapter({ fetch: async () => { throw new Error('must not be reached'); } });
  const binding = { apiKey: 'ak_fictional_office_a', authConfigId: 'ac_cal', userId: 'installation-a', accountId: 'acct_cal' };
  await assert.rejects(() => adapter.execute(binding, 'googlecalendar', 'GOOGLECALENDAR_PATCH_EVENT', { event_id: 'e1', status: 'cancelled' }, new AbortController().signal), /outside the connected-app boundary/);
  await assert.rejects(() => adapter.execute(binding, 'outlook', 'OUTLOOK_DECLINE_EVENT', { event_id: 'e1' }, new AbortController().signal), /outside the connected-app boundary/);
  await assert.rejects(() => adapter.execute(binding, 'googlecalendar', 'GOOGLECALENDAR_PATCH_EVENT', { event_id: 'e1', summary: 'Moved' }, new AbortController().signal), /must not be reached|interrupted/);
});

test('a registry written before on-demand admission reads as Gmail-only and its Gmail binding is unchanged', () => {
  const s = setup(); try {
    const legacy = { ...s.devices()[0]! }; delete (legacy as Partial<ConnectorDevice>).apps;
    const [read] = validateConnectorDevices({ version: 1, devices: [legacy] });
    assert.deepEqual(read!.apps, ['gmail']); assert.equal(read!.authConfigId, 'ac_gmail_company-a');
    assert.equal(managedAuthConfigName('gmail'), 'realbud-gmail-managed-v2'); assert.equal(managedAuthConfigName('xero'), 'realbud-xero-managed-v1');
  } finally { s.f.close(); }
});

test('a definitive refusal clears the journaled intent (config or link); an uncertain one stays held', async () => {
  const s = setup(); try {
    // Config create refused outright: the pending row is removed and the next ask may create again.
    let allowCreates: boolean[] = [];
    const refusing: ComposioAuthConfigClient = { resolveGmail: s.authConfigs.resolveGmail, toolkitAuth: async () => 'managed' as const,
      async resolveAuthConfig(o) { allowCreates.push(o.allowCreate); if (o.allowCreate) o.beforeCreate(); throw new GatewayError('connector_auth_config_rejected', 400); } };
    await assert.rejects(() => s.make({ authConfigs: refusing }).handle(s.request(s.a.token, '/v1/connectors/authorize', { app: 'xero' })), /connector_auth_config_rejected/);
    assert.equal(s.f.ledger.db.get('SELECT state FROM connector_office_apps WHERE company=? AND app=?', s.f.tenant.companyId, 'xero'), undefined);
    await assert.rejects(() => s.make({ authConfigs: refusing }).handle(s.request(s.a.token, '/v1/connectors/authorize', { app: 'xero' })), /connector_auth_config_rejected/);
    assert.deepEqual(allowCreates, [true, true]); assert.deepEqual(s.admitted, []);
    const events = () => JSON.stringify(s.f.ledger.db.all('SELECT kind FROM events'));
    assert.ok(events().includes('connector_app_config_rejected'));
    // Link refused outright (4xx): the unknown row is cleared; the next ask links afresh.
    const broker = s.make();
    s.refuseLink(403);
    await assert.rejects(() => broker.handle(s.request(s.a.token, '/v1/connectors/authorize', { app: 'slack' })), /connector_link_rejected/);
    assert.equal(s.f.ledger.db.get('SELECT state FROM connector_app_links WHERE device=? AND app=?', 'install-a', 'slack'), undefined);
    assert.ok(events().includes('connector_link_rejected'));
    s.refuseLink(0);
    assert.equal((await broker.handle(s.request(s.a.token, '/v1/connectors/authorize', { app: 'slack' }))).status, 200);
    assert.equal(s.f.ledger.db.get<{ state: string }>('SELECT state FROM connector_app_links WHERE device=? AND app=?', 'install-a', 'slack')!.state, 'ready');
    // A rate limit or timeout is uncertain: the row stays `unknown` and the next ask is held.
    s.refuseLink(429);
    await assert.rejects(() => broker.handle(s.request(s.a.token, '/v1/connectors/authorize', { app: 'notion' })));
    assert.equal(s.f.ledger.db.get<{ state: string }>('SELECT state FROM connector_app_links WHERE device=? AND app=?', 'install-a', 'notion')!.state, 'unknown');
    s.refuseLink(0);
    await assert.rejects(() => broker.handle(s.request(s.a.token, '/v1/connectors/authorize', { app: 'notion' })), /connector_link_outcome_unknown/);
  } finally { s.f.close(); }
});

test('connecting another app does not break a session in flight, and tool names route to the longest namespace', async () => {
  const s = setup(); try {
    const broker = s.make();
    await broker.handle(s.request(s.a.token, '/v1/connectors/authorize', { app: 'google' }));
    await broker.handle(s.request(s.a.token, '/v1/connectors/authorize', { app: 'google_calendar' }));
    // Each link's own account completed at the provider under the installation's user.
    s.accounts.set('ak_fictional_office_a:ac_google_1:installation-install-a', [{ id: 'acct_installation-install-a', status: 'ACTIVE' }]);
    s.accounts.set('ak_fictional_office_a:ac_google_calendar_2:installation-install-a', [{ id: 'acct_installation-install-a', status: 'ACTIVE' }]);
    const opened = await broker.handle(s.request(s.a.token, '/v1/connectors/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize' }));
    // Admitting a third app mid-session: the session's binding is unchanged.
    await broker.handle(s.request(s.a.token, '/v1/connectors/authorize', { app: 'xero' }));
    assert.deepEqual(s.devices()[0]!.apps, ['gmail', 'google', 'google_calendar', 'xero']);
    const read = await broker.handle(s.request(s.a.token, '/v1/connectors/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'GOOGLE_CALENDAR_LIST_INVOICES', arguments: {} } }, opened.session));
    assert.equal((read.body as { result: { isError?: boolean } }).result.isError, undefined, JSON.stringify(read.body));
    const executed = s.bindings.filter(b => b.op === 'execute:GOOGLE_CALENDAR_LIST_INVOICES');
    assert.equal(executed.length, 1); assert.equal(executed[0]!.slug, 'google_calendar'); assert.equal(executed[0]!.binding.authConfigId, 'ac_google_calendar_2');
    // A registry change to anything but the allowlist still ends the session.
    s.set(s.devices().map(d => d.id === 'install-a' ? { ...d, userId: 'installation-other' } : d));
    await assert.rejects(() => broker.handle(s.request(s.a.token, '/v1/connectors/mcp', { jsonrpc: '2.0', id: 3, method: 'ping' }, opened.session)), /connector_session_expired|connector_binding_changed/);
  } finally { s.f.close(); }
});

test('with RealBud\'s own Google client, a new Google app gets an own-client config while the bound Gmail config and a ready managed app stay as they were', async () => {
  const s = setup(); try {
    const posted: { slug: string; type: string; name: string; secret: unknown }[] = [];
    const store: Record<string, unknown>[] = [{ id: 'ac_drive_managed', name: 'realbud-googledrive-managed-v1', toolkit: { slug: 'googledrive' }, auth_scheme: 'OAUTH2', is_composio_managed: true, status: 'ENABLED' }];
    const authConfigs = composioAuthConfigClient({ oauthApps: oauthAppsFromEnv({ REALBUD_OAUTH_GOOGLE_CLIENT_ID: 'fictional.apps.googleusercontent.com', REALBUD_OAUTH_GOOGLE_CLIENT_SECRET: 'fictional-own-secret' }), fetch: async (url, init) => {
      const u = new URL(url); const toolkit = /\/toolkits\/([^/]+)$/.exec(u.pathname)?.[1];
      if (toolkit) return Response.json({ slug: toolkit, composio_managed_auth_schemes: ['OAUTH2'] });
      if (init.method === 'POST') {
        const body = JSON.parse(init.body as string) as { toolkit: { slug: string }; auth_config: { type: string; name: string; credentials?: Record<string, unknown> } };
        posted.push({ slug: body.toolkit.slug, type: body.auth_config.type, name: body.auth_config.name, secret: body.auth_config.credentials?.client_secret });
        store.push({ id: `ac_${body.toolkit.slug}_own`, name: body.auth_config.name, toolkit: body.toolkit, auth_scheme: 'OAUTH2', is_composio_managed: false, status: 'ENABLED' });
        return Response.json({ auth_config: { id: `ac_${body.toolkit.slug}_own` } }, { status: 201 });
      }
      return Response.json({ items: store.filter(c => (c.toolkit as { slug: string }).slug === u.searchParams.get('toolkit_slug')), next_cursor: null });
    } });
    // Office A already admitted Drive under the managed config; that row is kept.
    const broker = s.make({ authConfigs });
    s.f.ledger.db.run('INSERT INTO connector_office_apps(company,app,state,auth_config,created) VALUES(?,?,?,?,?)', s.f.tenant.companyId, 'googledrive', 'ready', 'ac_drive_managed', s.f.now());
    const reply = await broker.handle(s.request(s.a.token, '/v1/connectors/authorize', { app: 'googlecalendar' }));
    assert.equal(JSON.stringify(reply.body).includes('fictional-own-secret'), false);
    assert.deepEqual(posted, [{ slug: 'googlecalendar', type: 'use_custom_auth', name: 'realbud-googlecalendar-own-v1', secret: 'fictional-own-secret' }]);
    assert.equal(s.bindings.find(b => b.op === 'authorize')!.binding.authConfigId, 'ac_googlecalendar_own');
    await broker.handle(s.request(s.a.token, '/v1/connectors/authorize', { app: 'googledrive' }));
    assert.equal(posted.length, 1);
    assert.equal(s.bindings.filter(b => b.op === 'authorize').at(-1)!.binding.authConfigId, 'ac_drive_managed');
    // The device's Gmail binding is exactly what provisioning wrote.
    assert.equal(s.devices()[0]!.authConfigId, 'ac_gmail_company-a');
  } finally { s.f.close(); }
});

test('fixed sender profile survives initialize abort, rejects sender overrides and rechecks the current account/address before a reviewed send', async () => {
  const s = setup(); try {
    s.set(s.devices().map(d => d.id === 'install-a' ? { ...d, accountId: 'acct_gmail_a' } : d));
    const executed: string[] = [], profileSignals: AbortSignal[] = [];
    let address = 'verified@example.test';
    const apps: ComposioAppAdapter = { async listAccounts() { return []; }, async authorize() { throw Error('unused'); }, async upsertTrigger() { throw Error('unused'); }, async setTriggerStatus() {},
      async listTools() { return [{ name: 'GMAIL_SEND_EMAIL', description: 'send', inputSchema: { type: 'object', properties: { user_id: { type: 'string' }, from: { type: 'string' } } }, policy: 'review' }]; },
      async execute(binding) { executed.push(binding.accountId!); return { content: [{ type: 'text', text: '{}' }] }; } };
    const broker = s.make({ apps, access: async binding => ({ checkedAt: '', services: { gmail: { connected: true, status: 'ACTIVE', accounts: [{ id: binding.accountId!, label: 'misleading alias', status: 'ACTIVE' }], accountSelectionRequired: false } }, tools: { available: false, names: [] } }),
      mailProfile: binding => ({ async request(_method, _params, signal) { profileSignals.push(signal); signal.throwIfAborted(); return { content: [{ type: 'text', text: JSON.stringify({ accountId: binding.accountId, emailAddress: address, messagesTotal: 0, threadsTotal: 0 }) }] }; } }) });
    const initial = new AbortController();
    const opened = await broker.handle({ ...s.request(s.a.token, '/v1/connectors/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize' }), signal: initial.signal });
    initial.abort();
    const params = reviewedMailParams(opened, { name: 'GMAIL_SEND_EMAIL', arguments: { recipient_email: 'tenant@example.test', body: 'Hello', user_id: 'me' } });
    const rpc = (call: unknown) => broker.handle(s.request(s.a.token, '/v1/connectors/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: call }, opened.session));
    const reviewed = (params as { _meta: { realbudReviewedMailBinding: { companyId?: string } } })._meta.realbudReviewedMailBinding;
    assert.equal(reviewed.companyId, 'company-a');
    await assert.rejects(() => rpc({ ...params, _meta: { realbudReviewedMailBinding: { ...reviewed, companyId: 'company-b' } } }), /connector_mail_review_binding_changed/);
    assert.deepEqual(executed, []);
    await rpc(params); assert.deepEqual(executed, ['acct_gmail_a']); assert.notEqual(profileSignals.at(-1), initial.signal);
    for (const override of [{ user_id: 'other' }, { sender: 'other@example.test' }, { from: 'alias@example.test' }, { mailbox_id: 'other' }, { connected_account_id: 'other' }, { message: { from: 'other@example.test' } }])
      await assert.rejects(() => rpc({ ...params, arguments: { ...(params.arguments as Record<string, unknown>), ...override } }), /connector_mail_sender_identity_required/);
    assert.deepEqual(executed, ['acct_gmail_a']);
    address = 'changed@example.test'; await assert.rejects(() => rpc(params), /connector_mail_sender_identity_changed/);
    assert.deepEqual(executed, ['acct_gmail_a']);
    // The connected account ID and address alone cannot carry an approval to
    // another tenant, even if that ID is reused by the connector provider.
    const originals = s.devices();
    for (const change of [{ accountId: 'acct_gmail_b' }, { companyId: 'company-b', licenseId: 'license-b' }]) {
      s.set(originals.map(d => d.id === 'install-a' ? { ...d, ...change } : d));
      await assert.rejects(() => rpc(params), /connector_session_expired/);
    }
    assert.deepEqual(executed, ['acct_gmail_a']);
  } finally { s.f.close(); }
});
