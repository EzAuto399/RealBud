import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManagedConnectors, newConnectorCredential, type ConnectorDevice, type ConnectorOptions } from './connectors.ts';
import { composioAuthConfigClient, LEGACY_GMAIL_AUTH_CONFIG_NAME } from './composio-auth-config.ts';
import type { GmailReadOnlyBinding } from '../server/composio-gmail.ts';
import { fixture, gmailProfileTransport } from './testing.ts';

/** Devices provisioned on the legacy readonly-v1 Gmail config (Google blocks every
 * consent under it) move to managed-v2 on their next connect, unless an account
 * is active under their recorded config. Fictional keys and ids only. */
function setup(options: { rebind?: boolean; accountsUnder?: Record<string, string>; accessFails?: boolean } = {}) {
  const f = fixture();
  f.ledger.provisionTenant({ ...f.tenant, companyId: 'company-b', licenseId: 'license-b' });
  const a = newConnectorCredential(), a2 = newConnectorCredential(), b = newConnectorCredential();
  const device = (id: string, company: string, license: string, tokenHash: string, env: string): ConnectorDevice => ({
    id, companyId: company, licenseId: license, memberId: id, installationId: id, profile: 'property', tokenHash, active: true,
    expiresAt: f.now() + 3600_000, projectKeyEnv: env, authConfigId: 'ac_legacy_readonly', userId: `installation-${id}`, apps: ['gmail'] });
  let devices: ConnectorDevice[] = [
    device('install-a', f.tenant.companyId, f.tenant.licenseId, a.tokenHash, 'REALBUD_COMPOSIO_PROJECT_A'),
    device('install-a2', f.tenant.companyId, f.tenant.licenseId, a2.tokenHash, 'REALBUD_COMPOSIO_PROJECT_A'),
    device('install-b', 'company-b', 'license-b', b.tokenHash, 'REALBUD_COMPOSIO_PROJECT_B'),
  ];
  const secrets: Record<string, string> = { REALBUD_COMPOSIO_PROJECT_A: 'ak_fictional_office_a', REALBUD_COMPOSIO_PROJECT_B: 'ak_fictional_office_b' };
  // Each office project already holds the legacy config; POSTs record exactly what was asked.
  const configs = new Map<string, Record<string, unknown>[]>([
    ['ak_fictional_office_a', [{ id: 'ac_legacy_readonly', name: LEGACY_GMAIL_AUTH_CONFIG_NAME, toolkit: { slug: 'gmail' }, auth_scheme: 'OAUTH2', is_composio_managed: true, status: 'ENABLED', credentials: { scopes: 'https://www.googleapis.com/auth/gmail.readonly' } }]],
    ['ak_fictional_office_b', [{ id: 'ac_legacy_readonly', name: LEGACY_GMAIL_AUTH_CONFIG_NAME, toolkit: { slug: 'gmail' }, auth_scheme: 'OAUTH2', is_composio_managed: true, status: 'ENABLED', credentials: { scopes: 'https://www.googleapis.com/auth/gmail.readonly' } }]],
  ]);
  const posts: unknown[] = [];
  const authConfigs = composioAuthConfigClient({ fetch: async (url, init) => {
    const key = new Headers(init.headers).get('x-api-key')!;
    if (init.method === 'POST') {
      const body = JSON.parse(init.body as string) as { toolkit: { slug: string }; auth_config: { name: string } };
      posts.push(body); const id = `ac_v2_${key.slice(-1)}`;
      configs.set(key, [...configs.get(key)!, { id, name: body.auth_config.name, toolkit: { slug: 'gmail' }, auth_scheme: 'OAUTH2', is_composio_managed: true, status: 'ENABLED' }]);
      return Response.json({ auth_config: { id } }, { status: 201 });
    }
    assert.equal(new URL(url).searchParams.get('toolkit_slug'), 'gmail');
    return Response.json({ items: configs.get(key) ?? [], next_cursor: null });
  } });
  const accesses: GmailReadOnlyBinding[] = [], links: GmailReadOnlyBinding[] = [], rebinds: string[] = [];
  const opts: ConnectorOptions = {
    ledger: f.ledger, devices: () => devices, secret: name => secrets[name], authConfigs,
    access: async binding => {
      accesses.push(binding); if (options.accessFails) throw new Error('provider unavailable');
      const active = options.accountsUnder?.[`${binding.authConfigId}:${binding.userId}`];
      return { checkedAt: new Date(f.now()).toISOString(), services: { gmail: { connected: false, status: active ? 'ACTIVE' : 'NOT_CONNECTED', accounts: active ? [{ id: active, status: 'ACTIVE' }] : [], accountSelectionRequired: false } }, tools: { available: false, names: [] } };
    },
    authorize: async binding => { links.push(binding); return { url: 'https://connect.composio.dev/link/fictional', accountId: `ca_${binding.authConfigId}_${binding.userId}`, expiresAt: new Date(f.now() + 600_000).toISOString() }; },
    transport: binding => ({ async request() { return { content: [{ type: 'text', text: JSON.stringify({ accountId: binding.accountId, emailAddress: 'office@example.test' }) }] }; } }),
    ...(options.rebind === false ? {} : { rebindGmail: (deviceId: string, from: string, to: string) => {
      rebinds.push(`${deviceId}:${from}->${to}`);
      devices = devices.map(d => d.id === deviceId && d.authConfigId === from ? { ...d, authConfigId: to } : d);
    } }),
  };
  const broker = new ManagedConnectors(opts);
  const authorize = (token: string) => broker.handle({ token, profile: 'property', method: 'POST', path: '/v1/connectors/authorize', body: { app: 'gmail' }, signal: new AbortController().signal });
  const events = (kind: string) => f.ledger.db.all<{ tenant: string; body: string }>('SELECT * FROM events WHERE kind=?', kind);
  return { f, a, a2, b, broker, authorize, devices: () => devices, set: (next: ConnectorDevice[]) => { devices = next; }, posts, accesses, links, rebinds, events };
}

test('a device on the legacy Gmail config with no active account moves to managed-v2 (no scope override) and links under it', async () => {
  const s = setup(); try {
    const reply = await s.authorize(s.a.token);
    assert.deepEqual(reply.body, { url: 'https://connect.composio.dev/link/fictional' });
    assert.deepEqual(s.posts, [{ toolkit: { slug: 'gmail' }, auth_config: { type: 'use_composio_managed_auth', name: 'realbud-gmail-managed-v2' } }]);
    // The provider was asked about the recorded config first, under this device's own user.
    assert.equal(s.accesses[0]!.authConfigId, 'ac_legacy_readonly'); assert.equal(s.accesses[0]!.userId, 'installation-install-a');
    assert.equal(s.accesses[0]!.acceptComposioManagedScopes, true);
    assert.deepEqual(s.rebinds, ['install-a:ac_legacy_readonly->ac_v2_a']);
    assert.equal(s.links.length, 1); assert.equal(s.links[0]!.authConfigId, 'ac_v2_a'); assert.equal(s.links[0]!.acceptComposioManagedScopes, true);
    // Only that device moved; its office peer and the other office are untouched until they connect.
    assert.deepEqual(s.devices().map(d => d.authConfigId), ['ac_v2_a', 'ac_legacy_readonly', 'ac_legacy_readonly']);
    const [journal] = s.events('connector_gmail_rebound');
    assert.deepEqual(JSON.parse(journal!.body), { deviceId: 'install-a', installationId: 'install-a', from: 'ac_legacy_readonly', to: 'ac_v2_a' });
    assert.ok(!JSON.stringify(s.f.ledger.db.all('SELECT * FROM events')).includes('ak_fictional'));
    // A repeat returns the live link: no second config, provider check, rebind or link.
    assert.deepEqual((await s.authorize(s.a.token)).body, reply.body);
    assert.equal(s.posts.length, 1); assert.equal(s.rebinds.length, 1); assert.equal(s.links.length, 1); assert.equal(s.accesses.length, 1);
    // The office peer reuses the recorded v2 config without another create.
    await s.authorize(s.a2.token);
    assert.equal(s.posts.length, 1); assert.deepEqual(s.devices().map(d => d.authConfigId), ['ac_v2_a', 'ac_v2_a', 'ac_legacy_readonly']);
  } finally { s.f.close(); }
});

test('a link issued earlier under the legacy config is replaced by a v2 link once the provider confirms nothing is active', async () => {
  const t = setup(); try {
    // Before the fix was composed a link was issued under the legacy config (Google then blocked it).
    const old = new ManagedConnectors({ ledger: t.f.ledger, devices: () => t.devices(), secret: () => 'ak_fictional_office_a',
      authorize: async () => ({ url: 'https://connect.composio.dev/link/old', accountId: 'ca_blocked', expiresAt: new Date(t.f.now() + 600_000).toISOString() }) });
    await old.handle({ token: t.a.token, profile: 'property', method: 'POST', path: '/v1/connectors/authorize', body: { app: 'gmail' }, signal: new AbortController().signal });
    const reply = await t.authorize(t.a.token);
    assert.deepEqual(reply.body, { url: 'https://connect.composio.dev/link/fictional' });
    assert.equal(t.links.at(-1)!.authConfigId, 'ac_v2_a');
    const [requested] = t.events('connector_gmail_rebind_requested');
    assert.deepEqual(JSON.parse(requested!.body), { deviceId: 'install-a', from: 'ac_legacy_readonly', to: 'ac_v2_a', previousLinkState: 'ready', lapsedAccountId: 'ca_blocked' });
  } finally { t.f.close(); }
});

test('a device with an ACTIVE account under its recorded config, or a registry-pinned account, stays untouched', async () => {
  const s = setup({ accountsUnder: { 'ac_legacy_readonly:installation-install-a': 'ca_live' } }); try {
    await s.authorize(s.a.token);
    assert.deepEqual(s.rebinds, []); assert.equal(s.devices()[0]!.authConfigId, 'ac_legacy_readonly');
    assert.equal(s.links[0]!.authConfigId, 'ac_legacy_readonly');
  } finally { s.f.close(); }
  const t = setup(); try {
    t.set(t.devices().map(d => d.id === 'install-a' ? { ...d, accountId: 'ca_pinned' } : d));
    await assert.rejects(t.authorize(t.a.token), /connector_account_already_bound/);
    assert.deepEqual(t.rebinds, []); assert.equal(t.accesses.length, 0); assert.equal(t.posts.length, 0);
  } finally { t.f.close(); }
});

test('a provider that cannot confirm the recorded config holds the device where it is', async () => {
  const s = setup({ accessFails: true }); try {
    await assert.rejects(s.authorize(s.a.token), /connector_gmail_rebind_unconfirmed/);
    assert.deepEqual(s.rebinds, []); assert.equal(s.links.length, 0); assert.equal(s.devices()[0]!.authConfigId, 'ac_legacy_readonly');
  } finally { s.f.close(); }
});

test('without the rebinding seam composed a device keeps its recorded Gmail config', async () => {
  const s = setup({ rebind: false }); try {
    await s.authorize(s.a.token);
    assert.equal(s.posts.length, 0); assert.equal(s.accesses.length, 0); assert.equal(s.links[0]!.authConfigId, 'ac_legacy_readonly');
  } finally { s.f.close(); }
});

test('shared mailbox: every office device moves to v2 before the office link; one that cannot move keeps the conflict refusal', async () => {
  const s = setup(); try {
    const call = (op: string, body: unknown) => s.broker.officeMailbox.handle(s.f.owner, op, body, async () => {});
    await call('policy', { mode: 'shared', expectedRevision: 0 });
    await call('authorize', { expectedRevision: 1 });
    assert.deepEqual(s.devices().map(d => d.authConfigId), ['ac_v2_a', 'ac_v2_a', 'ac_legacy_readonly']);
    assert.equal(s.links.length, 1); assert.equal(s.links[0]!.authConfigId, 'ac_v2_a'); assert.match(s.links[0]!.userId, /^office_/);
    assert.equal(s.posts.length, 1);
  } finally { s.f.close(); }
  const t = setup({ accountsUnder: { 'ac_legacy_readonly:installation-install-a2': 'ca_live' } }); try {
    const call = (op: string, body: unknown) => t.broker.officeMailbox.handle(t.f.owner, op, body, async () => {});
    await call('policy', { mode: 'shared', expectedRevision: 0 });
    await assert.rejects(call('authorize', { expectedRevision: 1 }), /office_mailbox_configuration_conflict/);
    assert.deepEqual(t.devices().map(d => d.authConfigId), ['ac_v2_a', 'ac_legacy_readonly', 'ac_legacy_readonly']);
    assert.equal(t.links.length, 0);
  } finally { t.f.close(); }
});

test('composed registry rebinding moves only the named device and only while it still records the old config', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { composeAppAdmission } = await import('./composition.ts');
  const dir = mkdtempSync(join(tmpdir(), 'rebind-')); const registry = join(dir, 'devices.json');
  try {
    const entry = (id: string, tokenHash: string) => ({ id, companyId: 'company-a', licenseId: 'license-a', memberId: id, installationId: id, profile: 'property', tokenHash, active: true, expiresAt: 1, projectKeyEnv: 'REALBUD_COMPOSIO_PROJECT_A', authConfigId: 'ac_legacy_readonly', userId: `installation-${id}`, apps: ['gmail'] });
    writeFileSync(registry, JSON.stringify({ version: 1, devices: [entry('one', newConnectorCredential().tokenHash), entry('two', newConnectorCredential().tokenHash)] }));
    const { rebindGmail } = composeAppAdmission({ env: {}, fetch: async () => { throw new Error('no network'); }, registry });
    rebindGmail!('one', 'ac_legacy_readonly', 'ac_v2');
    rebindGmail!('two', 'ac_other', 'ac_v2'); // stale expectation: no change
    const read = () => (JSON.parse(readFileSync(registry, 'utf8')) as { devices: ConnectorDevice[] }).devices.map(d => d.authConfigId);
    assert.deepEqual(read(), ['ac_v2', 'ac_legacy_readonly']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the gateway verifies before initialize and blocked Gmail tools never execute on a verified session', async () => {
  const s = setup(); const realFetch = globalThis.fetch; const upstream: string[] = [];
  globalThis.fetch = (async (url: string | URL) => { upstream.push(String(url)); throw new Error('no network in tests'); }) as typeof fetch;
  try {
    const offline = new ManagedConnectors({ ledger: s.f.ledger, devices: () => s.devices(), secret: () => 'ak_fictional_office_a' });
    const rpc = (broker: ManagedConnectors, body: Record<string, unknown>, session?: string) => broker.handle({ token: s.a.token, profile: 'property', method: 'POST', path: '/v1/connectors/mcp', body: { jsonrpc: '2.0', ...body }, ...(session ? { session } : {}), signal: new AbortController().signal });
    await assert.rejects(() => rpc(offline, { id: 1, method: 'initialize' }), /connector_check_failed/);
    assert.ok(upstream.length > 0 && upstream.every(url => !url.includes('/tools/execute')));
    upstream.length = 0;
    s.set(s.devices().map(d => d.id === 'install-a' ? { ...d, accountId: 'ca_verified' } : d));
    const verified = new ManagedConnectors({ ledger: s.f.ledger, devices: () => s.devices(), secret: () => 'ak_fictional_office_a', mailProfile: gmailProfileTransport,
      access: async () => ({ checkedAt: '', services: { gmail: { connected: true, status: 'ACTIVE', accounts: [{ id: 'ca_verified', status: 'ACTIVE' }], accountSelectionRequired: false } }, tools: { available: false, names: [] } }) });
    const init = await rpc(verified, { id: 1, method: 'initialize' });
    for (const name of ['GMAIL_DELETE_MESSAGE', 'GMAIL_DELETE_THREAD', 'GMAIL_BATCH_DELETE_MESSAGES', 'GMAIL_CREATE_FILTER', 'GMAIL_UPDATE_VACATION_SETTINGS', 'GMAIL_UPDATE_SEND_AS', 'GMAIL_EMPTY_TRASH', 'SLACK_POST_MESSAGE']) {
      const reply = await rpc(verified, { id: 2, method: 'tools/call', params: { name, arguments: { message_id: 'abc' } } }, init.session);
      const result = (reply.body as { result: { isError: boolean; content: { text: string }[] } }).result;
      assert.equal(result.isError, true);
      assert.match(result.content[0]!.text, /outside|no complete reviewed/);
    }
    assert.equal(upstream.length, 0);
    await assert.rejects(() => rpc(verified, { id: 3, method: 'tools/call', params: { name: 'GMAIL_SEND_EMAIL', arguments: { recipient_email: 'someone@example.test' } } }, init.session), /connector_mail_review_binding_required/);
    assert.equal(upstream.length, 0);
  } finally { globalThis.fetch = realFetch; s.f.close(); }
});
