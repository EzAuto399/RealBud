import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { fixture } from './testing.ts';
import { createGatewayServer } from './http.ts';
import { GatewayError } from './contracts.ts';
import { modelviaKeyClient, parseOfficeAiAccess } from './modelvia-keys.ts';
import { composeOperatorRoutes, operatorAccessState } from './office-ai-access.ts';
import { signOperatorToken } from './operator-token.ts';
import { signPortalToken, verifyPortalToken } from './portal-token.ts';
import type { HttpTransport } from './composio-org.ts';

const OPERATOR_SECRET = 'fictional-gateway-operator-secret-000001';
const PORTAL_SECRET = 'fictional-gateway-portal-secret-00000001';
const CUSTOMER = 'cus-fictional-office';
const CUSTOMER_FIELDS = ['id', 'name', 'active', 'monthlyCapNanoAud', 'maxConcurrent', 'allowedModels', 'version', 'clientId', 'payer', 'billingCompanyId'];
const PROJECT_FIELDS = ['id', 'name', 'active', 'monthlyCapNanoAud', 'maxConcurrent', 'allowedModels', 'version', 'clientId', 'customerId', 'environments', 'requestCapNanoAud'];
type Row = Record<string, unknown>;

/** A stand-in with Modelvia's `accounts.put` rules: exact fields, optimistic
 * version (0 creates), immutable bindings. `conflicts` makes the next N customer
 * writes lose to another writer, who bumps the stored version. Fictional only. */
function fakeModelvia(options: { customers?: Row[]; projects?: Row[]; conflicts?: number; billingMode?: 'client' | 'customer' | 'mixed' } = {}) {
  const customers = new Map<string, Row>((options.customers ?? []).map(row => [row.id as string, { ...row }]));
  const projects = new Map<string, Row>((options.projects ?? []).map(row => [row.id as string, { ...row }]));
  const calls: { method: string; path: string; body?: Row }[] = [];
  let conflicts = options.conflicts ?? 0;
  const put = (table: Map<string, Row>, fields: string[], immutable: string[], body: Row) => {
    if (Object.keys(body).some(key => !fields.includes(key))) return Response.json({ error: 'invalid_fields' }, { status: 400 });
    const old = table.get(body.id as string);
    if (body.version !== ((old?.version as number | undefined) ?? 0)) return Response.json({ error: 'account_version_conflict' }, { status: 409 });
    if (old) for (const field of immutable) if (old[field] !== body[field]) return Response.json({ error: 'account_binding_immutable' }, { status: 409 });
    const saved: Row = { ...body, version: (body.version as number) + 1 };
    table.set(saved.id as string, saved);
    return Response.json(saved);
  };
  const fetchLike: HttpTransport = async (url, init) => {
    const path = new URL(url).pathname, body = init.body === undefined ? undefined : JSON.parse(String(init.body)) as Row;
    calls.push({ method: String(init.method), path, ...(body ? { body } : {}) });
    if (path === '/v1/operator/clients' && init.method === 'GET') return Response.json({ accounts: [{ id: 'realbud', billingMode: options.billingMode ?? 'client' }] });
    if (path === '/v1/operator/customers' && init.method === 'GET') return Response.json({ accounts: [...customers.values()] });
    if (path === '/v1/operator/customers') {
      if (conflicts > 0) {
        conflicts--;
        const old = customers.get(body!.id as string);
        if (old) customers.set(old.id as string, { ...old, version: (old.version as number) + 1, maxConcurrent: 5 });
        return Response.json({ error: 'account_version_conflict' }, { status: 409 });
      }
      return put(customers, CUSTOMER_FIELDS, ['clientId', 'payer', 'billingCompanyId'], body!);
    }
    if (path === '/v1/operator/projects' && init.method === 'GET') return Response.json({ accounts: [...projects.values()] });
    if (path === '/v1/operator/projects') return put(projects, PROJECT_FIELDS, ['clientId', 'customerId'], body!);
    return Response.json({ error: 'not_found' }, { status: 404 });
  };
  const client = modelviaKeyClient({ serviceOrigin: 'https://api.modelvia.dev', environment: 'production', clientId: 'realbud', allowedModels: ['auto'],
    operatorSecret: () => 'fictional-modelvia-operator-secret-32ch', operatorSubject: 'realbud-provisioning', fetch: fetchLike });
  const posts = () => calls.filter(call => call.method === 'POST');
  return { client, fetchLike, calls, posts, customers, projects };
}
const existing = (override: Row = {}): Row => ({ id: CUSTOMER, name: 'Fictional Office Pty Ltd', active: true, monthlyCapNanoAud: '100000000000', maxConcurrent: 4,
  allowedModels: ['auto'], version: 3, clientId: 'realbud', payer: 'client', billingCompanyId: 'billing-fictional', ...override });

// ---------------------------------------------------------------------------
// Modelvia customer client
// ---------------------------------------------------------------------------

test('default access creates the customer at version 0 under this client with A$200, two concurrent and the project models', async () => {
  const m = fakeModelvia();
  assert.deepEqual(await m.client.setCustomerAccess(CUSTOMER, { name: ' Fictional Office ', access: { mode: 'default' } }),
    { active: true, monthlyCapNanoAud: '200000000000', created: true });
  assert.deepEqual(m.posts().map(call => call.body), [{ id: CUSTOMER, name: 'Fictional Office', active: true, monthlyCapNanoAud: '200000000000',
    maxConcurrent: 2, allowedModels: ['auto'], version: 0, clientId: 'realbud' }]);
});

test('a custom cap updates the full record at its stored version and keeps name, concurrency and bindings', async () => {
  const m = fakeModelvia({ customers: [existing()] });
  assert.deepEqual(await m.client.setCustomerAccess(CUSTOMER, { name: 'Renamed Office', access: { mode: 'custom', monthlyCapNanoAud: '50000000000' } }),
    { active: true, monthlyCapNanoAud: '50000000000', created: false });
  assert.deepEqual(m.posts().map(call => call.body), [{ ...existing(), monthlyCapNanoAud: '50000000000' }]);
  assert.equal(m.customers.get(CUSTOMER)!.version, 4);
  // The same state again writes nothing.
  await m.client.setCustomerAccess(CUSTOMER, { name: 'Renamed Office', access: { mode: 'custom', monthlyCapNanoAud: '50000000000' } });
  assert.equal(m.posts().length, 1);
});

test('disabling sets active=false and leaves the cap; an absent customer is created disabled', async () => {
  const m = fakeModelvia({ customers: [existing()] });
  assert.deepEqual(await m.client.setCustomerAccess(CUSTOMER, { name: 'Fictional Office', access: { mode: 'disabled' } }),
    { active: false, monthlyCapNanoAud: '100000000000', created: false });
  assert.deepEqual(m.posts()[0]!.body, { ...existing(), active: false });
  const fresh = fakeModelvia();
  assert.deepEqual(await fresh.client.setCustomerAccess(CUSTOMER, { name: 'Fictional Office', access: { mode: 'disabled' } }),
    { active: false, monthlyCapNanoAud: '200000000000', created: true });
  // Re-enabling with default restores the A$200 cap.
  assert.deepEqual(await m.client.setCustomerAccess(CUSTOMER, { name: 'Fictional Office', access: { mode: 'default' } }),
    { active: true, monthlyCapNanoAud: '200000000000', created: false });
});

test('a customer under another client is refused and nothing is written', async () => {
  const m = fakeModelvia({ customers: [existing({ clientId: 'another-platform-client' })] });
  for (const access of [{ mode: 'default' }, { mode: 'disabled' }, { mode: 'custom', monthlyCapNanoAud: '1' }] as const) {
    await assert.rejects(() => m.client.setCustomerAccess(CUSTOMER, { name: 'Fictional Office', access }), (error: unknown) =>
      error instanceof GatewayError && error.code === 'modelvia_customer_foreign' && error.status === 409);
  }
  await assert.rejects(() => m.client.readCustomerRecord(CUSTOMER), /modelvia_customer_foreign/);
  // putCustomer refuses a foreign record before any request.
  await assert.rejects(() => m.client.putCustomer({ ...existing({ clientId: 'another-platform-client' }) } as never), /modelvia_customer_foreign/);
  assert.deepEqual(m.posts(), []);
});

test('a version conflict is retried once from a fresh read; a second one is reported', async () => {
  const m = fakeModelvia({ customers: [existing()], conflicts: 1 });
  assert.deepEqual(await m.client.setCustomerAccess(CUSTOMER, { name: 'Fictional Office', access: { mode: 'custom', monthlyCapNanoAud: '70000000000' } }),
    { active: true, monthlyCapNanoAud: '70000000000', created: false });
  assert.deepEqual(m.calls.map(call => `${call.method} ${call.path}`), ['GET /v1/operator/customers', 'POST /v1/operator/customers', 'GET /v1/operator/customers', 'POST /v1/operator/customers']);
  // The retry carries the other writer's version and its concurrency change.
  assert.equal(m.posts()[1]!.body!.version, 4);
  assert.equal(m.posts()[1]!.body!.maxConcurrent, 5);
  const stuck = fakeModelvia({ customers: [existing()], conflicts: 2 });
  await assert.rejects(() => stuck.client.setCustomerAccess(CUSTOMER, { name: 'Fictional Office', access: { mode: 'default' } }), (error: unknown) =>
    error instanceof GatewayError && error.code === 'modelvia_customer_version_conflict' && error.status === 409);
  assert.equal(stuck.posts().length, 2);
});

test('cap bounds: 1 nanoAUD to A$10,000, whole-number strings only, exact shapes', async () => {
  assert.deepEqual(parseOfficeAiAccess({ mode: 'custom', monthlyCapNanoAud: '1' }), { mode: 'custom', monthlyCapNanoAud: '1' });
  assert.deepEqual(parseOfficeAiAccess({ mode: 'custom', monthlyCapNanoAud: '10000000000000' }), { mode: 'custom', monthlyCapNanoAud: '10000000000000' });
  for (const bad of [{ mode: 'custom', monthlyCapNanoAud: '10000000000001' }, { mode: 'custom', monthlyCapNanoAud: '0' }, { mode: 'custom', monthlyCapNanoAud: '-1' },
    { mode: 'custom', monthlyCapNanoAud: '01' }, { mode: 'custom', monthlyCapNanoAud: 5 }, { mode: 'custom' }, { mode: 'default', monthlyCapNanoAud: '1' },
    { mode: 'disabled', extra: true }, { mode: 'unlimited' }, null, 'default', []]) {
    assert.throws(() => parseOfficeAiAccess(bad), /invalid_ai_access/, JSON.stringify(bad));
  }
  const m = fakeModelvia();
  await assert.rejects(() => m.client.setCustomerAccess(CUSTOMER, { name: 'Fictional Office', access: { mode: 'custom', monthlyCapNanoAud: '10000000000001' } }), /invalid_ai_access/);
  await assert.rejects(() => m.client.setCustomerAccess(CUSTOMER, { name: '  ', access: { mode: 'default' } }), /invalid_ai_access/);
  assert.deepEqual(m.calls, []);
});

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const ENV = { REALBUD_GATEWAY_PORTAL_SECRET: PORTAL_SECRET, REALBUD_GATEWAY_OPERATOR_SECRET: OPERATOR_SECRET, REALBUD_ENABLE_PROVIDER: '1',
  REALBUD_MODELVIA_BASE_URL: 'https://api.modelvia.dev', REALBUD_MODELVIA_OPERATOR_SECRET: 'fictional-modelvia-operator-secret-32ch',
  REALBUD_MODELVIA_OPERATOR_SUBJECT: 'realbud-provisioning', REALBUD_MODELVIA_CLIENT_ID: 'realbud', REALBUD_MODELVIA_MODELS: 'fictional-model' };
const PROJECT: Row = { id: 'rb-install-one', name: 'RealBud installation install-one', active: true, monthlyCapNanoAud: '100000000000', maxConcurrent: 4,
  allowedModels: ['auto'], version: 1, clientId: 'realbud', customerId: CUSTOMER, environments: ['production'], requestCapNanoAud: '1000000000' };

async function routeFixture(options: { env?: Record<string, string>; customers?: Row[] } = {}) {
  const f = fixture(), m = fakeModelvia({ customers: options.customers ?? [], projects: [PROJECT] });
  // One ready installation of company-a, as provisioning leaves it.
  f.ledger.db.run('CREATE TABLE IF NOT EXISTS installation_provisioning (tenant TEXT NOT NULL, installation TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(tenant,installation))');
  f.ledger.db.run('INSERT INTO installation_provisioning(tenant,installation,state,body,created) VALUES(?,?,?,?,?)', 'company-a', 'install-one', 'ready',
    JSON.stringify({ modelProjectId: 'rb-install-one', customerId: CUSTOMER, descriptor: { model: { spendCapLabel: 'old' } } }), 0);
  const env = { ...ENV, ...options.env };
  const operator = composeOperatorRoutes({ env, ledger: f.ledger, fetch: m.fetchLike });
  const server = createGatewayServer({ allowedOrigins: new Set(), operatorAccess: operatorAccessState(env), ...(operator ? { operator } : {}),
    portal: { async authenticate(bearer) { try { return verifyPortalToken(bearer, PORTAL_SECRET); } catch { throw new GatewayError('unauthenticated', 401); } } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); f.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, bearer: string | null, body: unknown) => {
    const response = await fetch(base + path, { method: 'POST', headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Row };
  };
  const events = () => f.ledger.db.all<{ kind: string; body: string }>("SELECT kind, body FROM events WHERE kind LIKE 'office_ai_access_%' ORDER BY seq");
  return { ...f, m, base, post, events };
}
const ROUTE = '/v1/operator/offices/ai-access';
const operatorToken = (secret = OPERATOR_SECRET) => signOperatorToken('ops@realbud.example', secret, Date.now(), 60_000);
const officeBody = (access: unknown) => ({ companyId: 'company-a', customerId: CUSTOMER, name: 'Fictional Office', access });

test('the route needs an operator token: none, a portal token or a portal-secret token is 401, and nothing reaches Modelvia', async () => {
  const r = await routeFixture();
  const portal = signPortalToken({ subject: 'owner-a', companyId: 'company-a', role: 'billing_owner' }, PORTAL_SECRET);
  for (const bearer of [null, portal, operatorToken(PORTAL_SECRET), 'x'.repeat(40)]) {
    assert.deepEqual(await r.post(ROUTE, bearer, officeBody({ mode: 'default' })), { status: 401, body: { error: 'operator_unauthenticated' } });
  }
  // And an operator token is not a portal principal.
  assert.deepEqual(await r.post('/v1/portal/installations/revoke', operatorToken(), { companyId: 'company-a', installationId: 'install-one' }),
    { status: 401, body: { error: 'unauthenticated' } });
  assert.deepEqual(r.m.calls, []);
  assert.deepEqual(r.events(), []);
});

test('operator routes are not composed without a distinct operator secret or without Modelvia operator configuration', async () => {
  for (const env of [{ REALBUD_GATEWAY_OPERATOR_SECRET: '' }, { REALBUD_GATEWAY_OPERATOR_SECRET: 'short' }, { REALBUD_GATEWAY_OPERATOR_SECRET: PORTAL_SECRET }]) {
    const r = await routeFixture({ env });
    assert.deepEqual(await r.post(ROUTE, operatorToken(), officeBody({ mode: 'default' })), { status: 503, body: { error: 'operator_unconfigured' } });
    const ready = await (await fetch(`${r.base}/ready`)).json() as Row;
    assert.equal(ready.operatorAccess, 'missing');
  }
  const noModelvia = await routeFixture({ env: { REALBUD_MODELVIA_CLIENT_ID: '' } });
  assert.deepEqual(await noModelvia.post(ROUTE, operatorToken(), officeBody({ mode: 'default' })), { status: 503, body: { error: 'operator_unconfigured' } });
  // Presence only: the secret is set, so /ready says configured, and makes no call.
  assert.equal(((await (await fetch(`${noModelvia.base}/ready`)).json()) as Row).operatorAccess, 'configured');
  assert.deepEqual(noModelvia.m.calls, []);
});

test('default and custom set the customer, push the cap to ready projects and audit without the customer id', async () => {
  const r = await routeFixture();
  const created = await r.post(ROUTE, operatorToken(), officeBody({ mode: 'default' }));
  assert.deepEqual(created, { status: 200, body: { customer: { active: true, monthlyCapNanoAud: '200000000000', created: true }, projects: [{ installationId: 'install-one', state: 'applied' }] } });
  assert.equal(r.m.projects.get('rb-install-one')!.monthlyCapNanoAud, '200000000000');
  assert.equal(r.m.projects.get('rb-install-one')!.maxConcurrent, 2);
  const custom = await r.post(ROUTE, operatorToken(), officeBody({ mode: 'custom', monthlyCapNanoAud: '350000000000' }));
  assert.deepEqual(custom.body, { customer: { active: true, monthlyCapNanoAud: '350000000000', created: false }, projects: [{ installationId: 'install-one', state: 'applied' }] });
  assert.equal(r.m.projects.get('rb-install-one')!.monthlyCapNanoAud, '350000000000');
  const events = r.events();
  assert.deepEqual(events.map(e => e.kind), ['office_ai_access_requested', 'office_ai_access_set', 'office_ai_access_requested', 'office_ai_access_set']);
  assert.deepEqual(JSON.parse(events[2]!.body), { subject: 'operator:ops@realbud.example', companyId: 'company-a', mode: 'custom', monthlyCapNanoAud: '350000000000' });
  for (const event of events) {
    assert(!event.body.includes(CUSTOMER), event.kind);
    assert(!event.body.includes(OPERATOR_SECRET) && !event.body.includes('fictional-modelvia-operator-secret'), event.kind);
  }
  assert(!JSON.stringify(custom.body).includes(CUSTOMER));
});

test('disabling writes active=false and pushes nothing to projects', async () => {
  const r = await routeFixture({ customers: [existing()] });
  const disabled = await r.post(ROUTE, operatorToken(), officeBody({ mode: 'disabled' }));
  assert.deepEqual(disabled, { status: 200, body: { customer: { active: false, monthlyCapNanoAud: '100000000000', created: false }, projects: [] } });
  assert.equal(r.m.customers.get(CUSTOMER)!.active, false);
  assert(!r.m.calls.some(call => call.path === '/v1/operator/projects'));
  assert.equal(r.m.projects.get('rb-install-one')!.version, 1);
  assert.deepEqual(JSON.parse(r.events()[0]!.body), { subject: 'operator:ops@realbud.example', companyId: 'company-a', mode: 'disabled' });
});

test('a foreign customer is 409 with no write; bad bodies and unknown companies are refused before Modelvia', async () => {
  const foreign = await routeFixture({ customers: [existing({ clientId: 'another-platform-client' })] });
  assert.deepEqual(await foreign.post(ROUTE, operatorToken(), officeBody({ mode: 'default' })), { status: 409, body: { error: 'modelvia_customer_foreign' } });
  assert.deepEqual(foreign.m.posts(), []);
  const r = await routeFixture();
  const cases: [unknown, number, string][] = [
    [officeBody({ mode: 'custom', monthlyCapNanoAud: '10000000000001' }), 400, 'invalid_ai_access'],
    [officeBody({ mode: 'custom', monthlyCapNanoAud: '0' }), 400, 'invalid_ai_access'],
    [{ ...officeBody({ mode: 'default' }), name: '' }, 400, 'invalid_ai_access'],
    [{ ...officeBody({ mode: 'default' }), extra: 1 }, 400, 'invalid_fields'],
    [{ ...officeBody({ mode: 'default' }), customerId: 'cus/../other' }, 400, 'invalid_modelvia_customer'],
    [{ ...officeBody({ mode: 'default' }), companyId: '../company' }, 400, 'invalid_id'],
    [{ ...officeBody({ mode: 'default' }), companyId: 'company-unentitled' }, 403, 'tenant_unavailable'],
  ];
  for (const [body, status, error] of cases) assert.deepEqual(await r.post(ROUTE, operatorToken(), body), { status, body: { error } }, JSON.stringify(body));
  assert.deepEqual(r.m.calls, []);
  assert.deepEqual(r.events(), []);
});
