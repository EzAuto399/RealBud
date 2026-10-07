import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fixture } from './testing.ts';
import { ManagedConnectors, newConnectorCredential, type ConnectorDevice } from './connectors.ts';
import { composioWebhookClient, EVENT_RETENTION_MS, webhookSecretName, WEBHOOK_EVENTS } from './composio-triggers.ts';
import { composioAppAdapter, composioProjectRest, type AppBinding } from './composio-apps.ts';
import type { HttpTransport } from './composio-org.ts';
import { createGatewayServer } from './http.ts';
import { fileSecretStore, InstallationProvisioning } from './provisioning.ts';

// Every value here is fictional.
const SECRET = 'whsec_fictional_signing_secret_0001', OLD_SECRET = 'whsec_fictional_signing_secret_0000';
const PROJECT_KEY = 'ak_fictional_project_key_for_tests';
const SWITCH = { app: 'gmail', event: 'new-message' };

function setup() {
  const f = fixture();
  f.ledger.provisionTenant({ ...f.tenant, companyId: 'company-b', licenseId: 'license-b' });
  const tokens = new Map<string, string>();
  const device = (id: string, companyId = 'company-a'): ConnectorDevice => {
    const credential = newConnectorCredential(); tokens.set(id, credential.token);
    return { id, companyId, licenseId: companyId === 'company-a' ? 'license-a' : 'license-b', memberId: id, installationId: id, profile: 'property', tokenHash: credential.tokenHash,
      active: true, expiresAt: f.now() + 3600_000, projectKeyEnv: `REALBUD_COMPOSIO_PROJECT_${companyId.toUpperCase().replace('-', '_')}`, authConfigId: 'ac_gmail',
      userId: `installation-${id}`, accountId: `ca_${id}`, apps: ['gmail'] };
  };
  const devices = [device('dev-a1'), device('dev-a2'), device('dev-b1', 'company-b')];
  const secrets: Record<string, string> = { REALBUD_COMPOSIO_PROJECT_COMPANY_A: PROJECT_KEY, REALBUD_COMPOSIO_PROJECT_COMPANY_B: `${PROJECT_KEY}_b`,
    [webhookSecretName('company-a')]: SECRET, [webhookSecretName('company-b')]: 'whsec_fictional_other_office_secret' };
  const calls: unknown[][] = [];
  let hold: Promise<void> | undefined, failStatus = false;
  const apps = {
    async listAccounts() { return []; }, async authorize(): Promise<never> { throw new Error('unused'); },
    async listTools() { return []; }, async execute(): Promise<never> { throw new Error('unused'); },
    async upsertTrigger(binding: AppBinding, slug: string, config: Record<string, unknown>) { calls.push(['upsert', binding.apiKey, binding.userId, binding.accountId, slug, config]); return `ti_${binding.userId.replace(/[^A-Za-z0-9]/g, '')}`; },
    async setTriggerStatus(_binding: unknown, id: string, enabled: boolean) { calls.push(['status', id, enabled]); if (failStatus) throw new Error('provider unavailable'); },
  };
  const access = async (binding: { accountId?: string }) => {
    if (hold) await hold;
    return { checkedAt: new Date(f.now()).toISOString(), services: { gmail: { connected: true, status: 'ACTIVE', accounts: [{ id: binding.accountId!, status: 'ACTIVE' }], accountSelectionRequired: false } }, tools: { available: true, names: [] } };
  };
  const broker = new ManagedConnectors({ ledger: f.ledger, devices: () => devices, secret: name => secrets[name], access: access as never, apps });
  const request = (id: string, path: string, body?: unknown, policyRevision?: number) => broker.handle({ token: tokens.get(id)!, profile: 'property', method: body === undefined ? 'GET' : 'POST',
    path, body, ...(policyRevision === undefined ? {} : { policyRevision }), signal: new AbortController().signal });
  const sign = (raw: string, { id = 'msg_1', at = f.now(), secret = SECRET } = {}) => {
    const timestamp = String(Math.floor(at / 1000));
    return { id, timestamp, signature: `v1,${createHmac('sha256', secret).update(`${id}.${timestamp}.${raw}`).digest('base64')}` };
  };
  const message = (who: string, overrides: Record<string, unknown> = {}) => ({ id: 'msg_payload', type: 'composio.trigger.message', timestamp: new Date(f.now()).toISOString(),
    metadata: { log_id: 'log_1', trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE', trigger_id: `ti_installation${who.replace(/[^A-Za-z0-9]/g, '')}`, connected_account_id: `ca_${who}`, auth_config_id: 'ac_gmail', user_id: `installation-${who}` },
    data: { message_id: `gm_${who.replace(/[^A-Za-z0-9]/g, '')}`, subject: 'PRIVATE SUBJECT', sender: 'private-sender@example.invalid', messageText: 'PRIVATE BODY TEXT' }, ...overrides });
  const deliver = (company: string, payload: unknown, options: Parameters<typeof sign>[1] = {}) => {
    const raw = JSON.stringify(payload); return broker.triggers.webhook(company, sign(raw, options), Buffer.from(raw));
  };
  const enable = (id: string) => request(id, '/v1/connectors/triggers', { ...SWITCH, enabled: true });
  return { f, broker, devices, request, sign, message, deliver, enable, calls, secrets,
    hold: (value?: Promise<void>) => { hold = value; }, failStatus: (value: boolean) => { failStatus = value; } };
}

test('the trigger switch binds the gateway\'s own account to the one allowlisted trigger; the caller names neither', async () => {
  const s = setup(); try {
    const on = await s.enable('dev-a1');
    assert.deepEqual(on.body, { app: 'gmail', event: 'new-message', source: 'personal', enabled: true, state: 'enabled' });
    // The office project key, the device's own provider user and account, a fixed slug and config; then an explicit enable.
    assert.deepEqual(s.calls, [['upsert', PROJECT_KEY, 'installation-dev-a1', 'ca_dev-a1', 'GMAIL_NEW_GMAIL_MESSAGE', { interval: 15 }], ['status', 'ti_installationdeva1', true]]);
    for (const [body, code] of [[{ ...SWITCH, enabled: true, accountId: 'ca_dev-a2' }, /invalid_fields/], [{ app: 'gmail', event: 'all-mail', enabled: true }, /connector_trigger_not_allowed/],
      [{ app: 'slack', event: 'new-message', enabled: true }, /connector_trigger_not_allowed/], [{ ...SWITCH, enabled: 'yes' }, /invalid_fields/]] as const) {
      await assert.rejects(() => s.request('dev-a1', '/v1/connectors/triggers', body), code);
    }
    assert.equal(s.calls.length, 2);
    const status = await s.request('dev-a1', '/v1/connectors/status');
    assert.deepEqual((status.body as { triggers: unknown }).triggers, [{ app: 'gmail', event: 'new-message', source: 'personal', state: 'enabled' }]);
    // Another computer of the office does not see this one's trigger.
    assert.deepEqual(((await s.request('dev-a2', '/v1/connectors/status')).body as { triggers: unknown }).triggers, []);
    const off = await s.request('dev-a1', '/v1/connectors/triggers', { ...SWITCH, enabled: false });
    assert.deepEqual(off.body, { app: 'gmail', event: 'new-message', source: 'personal', enabled: false, state: 'disabled' });
    assert.deepEqual(s.calls.at(-1), ['status', 'ti_installationdeva1', false]);
  } finally { s.f.close(); }
});

test('webhook signatures: a bad or missing signature and a stale or future timestamp are refused; a rotated multi-signature is accepted', async () => {
  const s = setup(); try {
    await s.enable('dev-a1');
    const raw = JSON.stringify(s.message('dev-a1'));
    assert.throws(() => s.broker.triggers.webhook('company-a', s.sign(raw, { secret: 'whsec_fictional_wrong_secret_000' }), Buffer.from(raw)), /invalid_composio_signature/);
    assert.throws(() => s.broker.triggers.webhook('company-a', s.sign(raw), Buffer.from(raw.replace('dev-a1', 'dev-a2'))), /invalid_composio_signature/);
    assert.throws(() => s.broker.triggers.webhook('company-a', { ...s.sign(raw), signature: undefined }, Buffer.from(raw)), /invalid_composio_signature/);
    assert.throws(() => s.broker.triggers.webhook('company-a', { ...s.sign(raw), signature: 'v1,short' }, Buffer.from(raw)), /invalid_composio_signature/);
    // An office with no webhook secret answers exactly like a bad signature.
    assert.throws(() => s.broker.triggers.webhook('company-c', s.sign(raw), Buffer.from(raw)), /invalid_composio_signature/);
    assert.throws(() => s.deliver('company-a', s.message('dev-a1'), { at: s.f.now() - 301_000 }), /stale_composio_event/);
    assert.throws(() => s.deliver('company-a', s.message('dev-a1'), { at: s.f.now() + 301_000 }), /stale_composio_event/);
    // During rotation Composio signs with the old and the new secret; any one valid signature admits it.
    const old = s.sign(raw, { secret: OLD_SECRET }), current = s.sign(raw);
    assert.deepEqual(s.broker.triggers.webhook('company-a', { ...current, signature: `${old.signature} ${current.signature}` }, Buffer.from(raw)), { received: true });
    assert.deepEqual(s.deliver('company-a', s.message('dev-a1'), { id: 'msg_2', at: s.f.now() - 299_000 }), { received: true });
    // Composio's docs also accept a bare base64 signature with no `v1,` prefix.
    const bare = s.sign(raw, { id: 'msg_3' });
    assert.deepEqual(s.broker.triggers.webhook('company-a', { ...bare, signature: bare.signature.slice(3) }, Buffer.from(raw)), { received: true });
  } finally { s.f.close(); }
});

test('a duplicate delivery answers replayed, a different body under the same id conflicts, and payload data is never stored', async () => {
  const s = setup(); try {
    await s.enable('dev-a1');
    assert.deepEqual(s.deliver('company-a', s.message('dev-a1')), { received: true });
    assert.deepEqual(s.deliver('company-a', s.message('dev-a1')), { received: true, replayed: true });
    assert.throws(() => s.deliver('company-a', s.message('dev-a1', { data: { message_id: 'gm_other' } })), /composio_event_conflict/);
    const rows = s.f.ledger.db.all<Record<string, unknown>>('SELECT * FROM composio_events');
    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0]!).sort(), ['company', 'digest', 'kind', 'provider_msg_id', 'received', 'seq', 'trigger_id', 'user_id', 'webhook_id']);
    assert.equal(rows[0]!.provider_msg_id, 'gm_deva1');
    // Nothing from `data` but the message id reaches any table, the audit chain included.
    const tables = s.f.ledger.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'");
    const everything = JSON.stringify(tables.map(({ name }) => s.f.ledger.db.all(`SELECT * FROM "${name}"`)));
    for (const secret of ['PRIVATE SUBJECT', 'private-sender', 'PRIVATE BODY', SECRET, PROJECT_KEY]) assert.equal(everything.includes(secret), false, secret);
    assert.ok(s.f.ledger.db.get("SELECT seq FROM events WHERE kind='composio_event_received'"));
  } finally { s.f.close(); }
});

test('a trigger id outside this office\'s registry, or with another account or user, is refused', async () => {
  const s = setup(); try {
    await s.enable('dev-a1'); await s.enable('dev-b1');
    // Signed with office A's secret, naming office B's trigger.
    assert.throws(() => s.deliver('company-a', s.message('dev-b1')), /composio_trigger_unknown/);
    assert.throws(() => s.deliver('company-a', s.message('dev-a1', { metadata: { ...s.message('dev-a1').metadata, connected_account_id: 'ca_dev-a2' } })), /composio_trigger_unknown/);
    assert.throws(() => s.deliver('company-a', s.message('dev-a1', { metadata: { ...s.message('dev-a1').metadata, user_id: 'installation-dev-a2' } })), /composio_trigger_unknown/);
    assert.throws(() => s.deliver('company-a', s.message('dev-a1', { metadata: { ...s.message('dev-a1').metadata, trigger_id: 'ti_unknown' } })), /composio_trigger_unknown/);
    assert.equal(s.f.ledger.db.get<{ count: number }>('SELECT count(*) AS count FROM composio_events')!.count, 0);
    assert.ok(s.f.ledger.db.get("SELECT seq FROM events WHERE kind='composio_event_refused'"));
  } finally { s.f.close(); }
});

test('a pull returns only this computer\'s events: never another computer\'s or another office\'s, and acknowledged rows go', async () => {
  const s = setup(); try {
    for (const id of ['dev-a1', 'dev-a2', 'dev-b1']) await s.enable(id);
    s.deliver('company-a', s.message('dev-a1'), { id: 'msg_a1' });
    s.deliver('company-a', s.message('dev-a2'), { id: 'msg_a2' });
    const raw = JSON.stringify(s.message('dev-b1'));
    s.broker.triggers.webhook('company-b', s.sign(raw, { id: 'msg_b1', secret: s.secrets[webhookSecretName('company-b')] }), Buffer.from(raw));
    const pull = async (id: string, after = 0) => (await s.request(id, '/v1/connectors/events', { after })).body as { events: Array<Record<string, unknown>>; cursor: number; gap: boolean; more: boolean };
    const a1 = await pull('dev-a1');
    assert.deepEqual(a1.events, [{ seq: 1, kind: 'message', source: 'personal', app: 'gmail', event: 'new-message', messageId: 'gm_deva1', receivedAt: new Date(s.f.now()).toISOString() }]);
    assert.equal(a1.gap, false); assert.equal(a1.more, false); assert.equal(a1.cursor, 3);
    assert.deepEqual((await pull('dev-a2')).events.map(event => event.seq), [2]);
    assert.deepEqual((await pull('dev-b1')).events.map(event => event.seq), [3]);
    // Acknowledging up to the cursor removes this computer's own rows only.
    assert.deepEqual((await pull('dev-a1', a1.cursor)).events, []);
    assert.deepEqual(s.f.ledger.db.all<{ seq: number }>('SELECT seq FROM composio_events ORDER BY seq').map(row => row.seq), [2, 3]);
    await assert.rejects(() => s.request('dev-a1', '/v1/connectors/events', { after: -1 }), /invalid_integer/);
    await assert.rejects(() => s.request('dev-a1', '/v1/connectors/events', { after: 0, user: 'installation-dev-a2' }), /invalid_fields/);
  } finally { s.f.close(); }
});

test('the event pull skips the per-device busy lock and the mailbox policy revision check', async () => {
  const s = setup(); try {
    await s.enable('dev-a1'); s.deliver('company-a', s.message('dev-a1'));
    let release!: () => void; s.hold(new Promise<void>(resolve => { release = resolve; }));
    const status = s.request('dev-a1', '/v1/connectors/status');
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(() => s.request('dev-a1', '/v1/connectors/triggers', { ...SWITCH, enabled: false }), /connector_busy/);
    assert.equal(((await s.request('dev-a1', '/v1/connectors/events', { after: 0 })).body as { events: unknown[] }).events.length, 1);
    release(); await status; s.hold();
    // The owner moves the mailbox policy: other routes wait for review, the pull does not.
    await s.broker.officeMailbox.handle(s.f.owner, 'policy', { mode: 'both', expectedRevision: 0 }, async () => {});
    await assert.rejects(() => s.request('dev-a1', '/v1/connectors/triggers', { ...SWITCH, enabled: false }), /office_mailbox_review_required/);
    assert.equal((await s.request('dev-a1', '/v1/connectors/events', { after: 0 })).status, 200);
  } finally { s.f.close(); }
});

test('rows older than seven days go unread and the pull says gap; a cursor ahead of the ledger also says gap', async () => {
  const s = setup(); try {
    await s.enable('dev-a1');
    s.deliver('company-a', s.message('dev-a1'), { id: 'msg_old' });
    s.f.setTime(s.f.now() + EVENT_RETENTION_MS + 1);
    s.deliver('company-a', s.message('dev-a1'), { id: 'msg_new' });
    const pull = async (id: string, after: number) => (await s.request(id, '/v1/connectors/events', { after })).body as { events: Array<{ seq: number }>; cursor: number; gap: boolean };
    const first = await pull('dev-a1', 0);
    assert.equal(first.gap, true); assert.deepEqual(first.events.map(event => event.seq), [2]); assert.equal(first.cursor, 2);
    const next = await pull('dev-a1', first.cursor);
    assert.equal(next.gap, false); assert.deepEqual(next.events, []);
    // Nothing of dev-a2's aged out: no gap there.
    assert.equal((await pull('dev-a2', 0)).gap, false);
    const ahead = await pull('dev-a1', 999);
    assert.equal(ahead.gap, true); assert.equal(ahead.cursor, 2);
  } finally { s.f.close(); }
});

test('an expired account and a provider-disabled trigger show on status; other deliveries are ignored, not stored', async () => {
  const s = setup(); try {
    await s.enable('dev-a1'); await s.enable('dev-a2');
    const account = (who: string, type: string) => ({ id: 'msg_x', type, metadata: { connected_account_id: `ca_${who}`, user_id: `installation-${who}`, auth_config_id: 'ac_gmail' }, data: { reason: 'PRIVATE REASON' } });
    assert.deepEqual(s.deliver('company-a', account('dev-a1', 'composio.connected_account.expired'), { id: 'msg_exp' }), { received: true });
    assert.deepEqual(s.deliver('company-a', { ...s.message('dev-a2'), type: 'composio.trigger.disabled' }, { id: 'msg_dis' }), { received: true });
    const state = async (id: string) => ((await s.request(id, '/v1/connectors/status')).body as { triggers: Array<{ state: string }> }).triggers.map(row => row.state);
    assert.deepEqual(await state('dev-a1'), ['expired']);
    assert.deepEqual(await state('dev-a2'), ['provider_disabled']);
    // A message for a trigger that is not enabled, an account no trigger uses and an unknown type are acknowledged and dropped.
    assert.deepEqual(s.deliver('company-a', s.message('dev-a1'), { id: 'msg_late' }), { received: true, ignored: true });
    assert.deepEqual(s.deliver('company-a', account('dev-b1', 'composio.connected_account.expired'), { id: 'msg_foreign_account' }), { received: true, ignored: true });
    assert.deepEqual(s.deliver('company-a', { type: 'composio.something.new', metadata: {} }, { id: 'msg_unknown' }), { received: true, ignored: true });
    assert.deepEqual(s.f.ledger.db.all<{ kind: string }>('SELECT kind FROM composio_events ORDER BY seq').map(row => row.kind), ['account_expired', 'trigger_disabled']);
    // Re-enabling after a reconnect brings the trigger back.
    await s.enable('dev-a1');
    assert.deepEqual(await state('dev-a1'), ['enabled']);
  } finally { s.f.close(); }
});

test('a mailbox mode change stops personal triggers when the office goes shared, even if the provider call fails', async () => {
  const s = setup(); try {
    await s.enable('dev-a1'); await s.enable('dev-b1');
    s.failStatus(true);
    await s.broker.officeMailbox.handle(s.f.owner, 'policy', { mode: 'shared', expectedRevision: 0 }, async () => {});
    assert.deepEqual(s.calls.at(-1), ['status', 'ti_installationdeva1', false]);
    const rows = s.f.ledger.db.all<{ trigger_id: string; state: string }>('SELECT trigger_id, state FROM composio_triggers ORDER BY trigger_id').map(row => ({ ...row }));
    // Office A's trigger is off locally (its events are dropped); office B's is untouched.
    assert.deepEqual(rows, [{ trigger_id: 'ti_installationdeva1', state: 'disabled' }, { trigger_id: 'ti_installationdevb1', state: 'enabled' }]);
    assert.ok(s.f.ledger.db.get("SELECT seq FROM events WHERE kind='composio_trigger_disable_unconfirmed'"));
    assert.deepEqual(s.deliver('company-a', s.message('dev-a1')), { received: true, ignored: true });
  } finally { s.f.close(); }
});

test('the signed webhook route reads the raw body, answers 200 fast and refuses a bad signature or an oversized body', async () => {
  const s = setup();
  const server = createGatewayServer({ allowedOrigins: new Set(), portal: { async authenticate() { throw new Error('No portal identity'); } }, connectors: s.broker });
  const bare = createGatewayServer({ allowedOrigins: new Set(), portal: { async authenticate() { throw new Error('No portal identity'); } } });
  try {
    await s.enable('dev-a1');
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); await new Promise<void>(resolve => bare.listen(0, '127.0.0.1', resolve));
    const post = async (target: typeof server, path: string, raw: string, headers: Record<string, string>) => {
      const response = await fetch(`http://127.0.0.1:${(target.address() as AddressInfo).port}${path}`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', ...headers } });
      return { status: response.status, body: await response.json() };
    };
    const raw = JSON.stringify(s.message('dev-a1')), signed = s.sign(raw);
    const headers = { 'webhook-id': signed.id, 'webhook-timestamp': signed.timestamp, 'webhook-signature': signed.signature };
    assert.deepEqual(await post(server, '/v1/webhooks/composio/company-a', raw, headers), { status: 200, body: { received: true } });
    assert.deepEqual(await post(server, '/v1/webhooks/composio/company-a', raw, headers), { status: 200, body: { received: true, replayed: true } });
    assert.deepEqual(await post(server, '/v1/webhooks/composio/company-b', raw, headers), { status: 401, body: { error: 'invalid_composio_signature' } });
    assert.deepEqual(await post(server, '/v1/webhooks/composio/company-a', raw, { ...headers, 'webhook-signature': 'v1,' + 'A'.repeat(43) + '=' }), { status: 401, body: { error: 'invalid_composio_signature' } });
    assert.equal((await post(server, '/v1/webhooks/composio/company-a', 'x'.repeat(256_001), headers)).status, 413);
    assert.deepEqual(await post(bare, '/v1/webhooks/composio/company-a', raw, headers), { status: 503, body: { error: 'connectors_unavailable' } });
  } finally { server.close(); bare.close(); s.f.close(); }
});

test('the project REST call sends PATCH and DELETE with the office key, and the adapter manages triggers through it', async () => {
  const seen: Array<{ url: string; method?: string; body?: unknown; key?: string }> = [];
  let reply: () => Response = () => Response.json({});
  const fetchStub: HttpTransport = async (url, init) => {
    seen.push({ url, method: init.method, body: init.body === undefined ? undefined : JSON.parse(String(init.body)), key: (init.headers as Record<string, string>)['x-api-key'] });
    return reply();
  };
  const rest = composioProjectRest({ fetch: fetchStub, base: 'https://composio.example.invalid/api/v3.1' }), signal = new AbortController().signal;
  assert.deepEqual(await rest({ apiKey: PROJECT_KEY }, '/trigger_instances/manage/ti_1', signal, { method: 'PATCH', body: { status: 'disable' } }), {});
  reply = () => new Response(null, { status: 204 });
  assert.deepEqual(await rest({ apiKey: PROJECT_KEY }, '/trigger_instances/manage/ti_1', signal, { method: 'DELETE' }), {});
  reply = () => Response.json({ deleted: true });
  assert.deepEqual(await rest({ apiKey: PROJECT_KEY }, '/trigger_instances/manage/ti_2', signal, { method: 'DELETE' }), { deleted: true });
  assert.deepEqual(seen.map(({ method, body, key }) => ({ method, body, key })), [
    { method: 'PATCH', body: { status: 'disable' }, key: PROJECT_KEY }, { method: 'DELETE', body: undefined, key: PROJECT_KEY }, { method: 'DELETE', body: undefined, key: PROJECT_KEY }]);
  reply = () => new Response('{"error":"' + PROJECT_KEY + '"}', { status: 404 });
  await assert.rejects(() => rest({ apiKey: PROJECT_KEY }, '/trigger_instances/manage/ti_3', signal, { method: 'DELETE' }), (error: Error) => !error.message.includes(PROJECT_KEY) && /refused/.test(error.message));

  seen.length = 0;
  const adapter = composioAppAdapter({ fetch: fetchStub, base: 'https://composio.example.invalid/api/v3.1' });
  const binding = { apiKey: PROJECT_KEY, authConfigId: 'ac_gmail', userId: 'installation-dev-a1', accountId: 'ca_dev-a1' };
  reply = () => Response.json({ trigger_id: 'ti_fictional1' });
  assert.equal(await adapter.upsertTrigger(binding, 'GMAIL_NEW_GMAIL_MESSAGE', { interval: 15 }, signal), 'ti_fictional1');
  reply = () => Response.json({ status: 'success' });
  await adapter.setTriggerStatus({ apiKey: PROJECT_KEY }, 'ti_fictional1', false, signal);
  assert.deepEqual(seen.map(({ url, method, body }) => ({ url, method, body })), [
    { url: 'https://composio.example.invalid/api/v3.1/trigger_instances/GMAIL_NEW_GMAIL_MESSAGE/upsert', method: 'POST', body: { connected_account_id: 'ca_dev-a1', trigger_config: { interval: 15 } } },
    { url: 'https://composio.example.invalid/api/v3.1/trigger_instances/manage/ti_fictional1', method: 'PATCH', body: { status: 'disable' } }]);
  await assert.rejects(() => adapter.upsertTrigger({ ...binding, accountId: undefined }, 'GMAIL_NEW_GMAIL_MESSAGE', {}, signal), /no connected account/);
  await assert.rejects(() => adapter.setTriggerStatus({ apiKey: PROJECT_KEY }, '../tools/execute/X', false, signal), /invalid/);
  reply = () => Response.json({ trigger_id: 'not-a-trigger' });
  await assert.rejects(() => adapter.upsertTrigger(binding, 'GMAIL_NEW_GMAIL_MESSAGE', {}, signal), /trigger instance id/);
});

test('ensureOfficeProject creates the office webhook subscription once, stores its secret and never logs it; a lost secret is rotated', async () => {
  const f = fixture(), root = mkdtempSync(join(tmpdir(), 'realbud-webhooks-'));
  const SUBSCRIPTION_SECRET = 'whsec_fictional_subscription_secret_1', ROTATED_SECRET = 'whsec_fictional_subscription_secret_2';
  const subscriptions: Array<{ id: string; webhook_url: string }> = [], requests: Array<{ url: string; method?: string; body?: unknown; key?: string }> = [];
  const fetchStub: HttpTransport = async (url, init) => {
    requests.push({ url, method: init.method, body: init.body === undefined ? undefined : JSON.parse(String(init.body)), key: (init.headers as Record<string, string>)['x-api-key'] });
    const path = new URL(url).pathname;
    if (path === '/api/v3.1/webhook_subscriptions' && init.method === 'GET') return Response.json({ items: subscriptions });
    if (path === '/api/v3.1/webhook_subscriptions' && init.method === 'POST') {
      const body = JSON.parse(String(init.body)); subscriptions.push({ id: 'ws_fictional', webhook_url: body.webhook_url });
      return Response.json({ id: 'ws_fictional', secret: SUBSCRIPTION_SECRET });
    }
    if (path === '/api/v3.1/webhook_subscriptions/ws_fictional/rotate_secret' && init.method === 'POST') return Response.json({ secret: ROTATED_SECRET });
    throw new Error(`unexpected ${init.method} ${path}`);
  };
  const projects: Array<{ id: string; name: string }> = [];
  const org = { async listProjects() { return [...projects]; }, async createProject(name: string) { projects.push({ id: 'pr_1', name }); return { id: 'pr_1', name, apiKey: PROJECT_KEY }; },
    async deleteProject(): Promise<never> { throw new Error('unused'); } };
  const secrets = fileSecretStore(join(root, 'secrets'));
  const make = (baseUrl = 'https://gateway.example.invalid') => new InstallationProvisioning({ ledger: f.ledger, registry: join(root, 'registry.json'), endpoint: 'https://gateway.example.invalid',
    secrets, org, modelvia: {} as never, authConfigs: {} as never, webhooks: { baseUrl, client: composioWebhookClient({ fetch: fetchStub }) } });
  const logged: string[] = [], original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const name of ['log', 'warn', 'error', 'info'] as const) console[name] = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    const provisioning = make();
    await provisioning.ensureOfficeProject('company-a', '', { requireTenant: true });
    await provisioning.ensureOfficeProject('company-a', '', { requireTenant: true });
    const created = requests.filter(entry => entry.method === 'POST');
    assert.equal(created.length, 1);
    assert.deepEqual(created[0], { url: 'https://backend.composio.dev/api/v3.1/webhook_subscriptions', method: 'POST', key: PROJECT_KEY,
      body: { webhook_url: 'https://gateway.example.invalid/v1/webhooks/composio/company-a', enabled_events: [...WEBHOOK_EVENTS], version: 'V3' } });
    assert.equal(secrets.read(webhookSecretName('company-a')), SUBSCRIPTION_SECRET);
    // A secret lost from the store is replaced by rotating the existing subscription, never by a second one.
    secrets.remove(webhookSecretName('company-a'));
    await make().ensureOfficeProject('company-a');
    assert.equal(requests.filter(entry => entry.method === 'POST' && entry.url.endsWith('/webhook_subscriptions')).length, 1);
    assert.equal(secrets.read(webhookSecretName('company-a')), ROTATED_SECRET);
    // A subscription pointing elsewhere is held for an operator.
    secrets.remove(webhookSecretName('company-a'));
    await assert.rejects(() => make('https://other-gateway.example.invalid').ensureOfficeProject('company-a'), /connector_webhook_url_mismatch/);
    assert.throws(() => make('http://gateway.example.invalid/path'), /connector_webhook_base_invalid/);
    const audit = JSON.stringify(f.ledger.db.all('SELECT * FROM events'));
    assert.ok(audit.includes('connector_webhook_subscribed'));
    for (const value of [SUBSCRIPTION_SECRET, ROTATED_SECRET, PROJECT_KEY]) {
      assert.equal(audit.includes(value), false);
      assert.equal(logged.join('\n').includes(value), false);
    }
  } finally {
    Object.assign(console, original);
    f.close(); rmSync(root, { recursive: true, force: true });
  }
});
