import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fixture, FIXTURE_TIME } from './testing.ts';
import { createGatewayServer } from './http.ts';
import { GatewayError } from './contracts.ts';
import { LedgerDatabase } from './database.ts';
import { runEntitlementCli } from './entitlement-cli.ts';
import { ledgerPath } from './local-env.ts';
import { composeOperatorRoutes, operatorAccessState } from './office-ai-access.ts';
import { signOperatorToken } from './operator-token.ts';
import { signPortalToken, verifyPortalToken } from './portal-token.ts';

const OPERATOR_SECRET = 'fictional-gateway-operator-secret-000001';
const PORTAL_SECRET = 'fictional-gateway-portal-secret-00000001';
// Operator secret only: the entitlement route needs no Modelvia configuration.
const ENV = { REALBUD_GATEWAY_PORTAL_SECRET: PORTAL_SECRET, REALBUD_GATEWAY_OPERATOR_SECRET: OPERATOR_SECRET };
const ROUTE = '/v1/operator/offices/entitlement';
type Row = Record<string, unknown>;
const BODY = { companyId: 'company-new', licenseId: 'license-new', name: 'Fictional Realty Pty Ltd', address: '1 Example Street, Brisbane QLD',
  evidence: 'operator-ticket-1', goLiveEvidence: 'signed-order-fictional', goLive: '2026-09-01', expires: '2027-09-01' };
const ENTITLEMENT = { companyId: 'company-new', licenseId: 'license-new', active: true, serviceAvailable: true, goLiveAt: '2026-09-01T00:00:00.000Z',
  serviceExpiresAt: '2027-09-01T00:00:00.000Z', customerName: 'Fictional Realty Pty Ltd', customerAddress: '1 Example Street, Brisbane QLD' };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function routeFixture(env: Record<string, string> = ENV) {
  const f = fixture();
  const operator = composeOperatorRoutes({ env, ledger: f.ledger, fetch: async () => { throw new Error('no network in this test'); } });
  const server = createGatewayServer({ allowedOrigins: new Set(), operatorAccess: operatorAccessState(env), ...(operator ? { operator } : {}),
    portal: { async authenticate(bearer) { try { return verifyPortalToken(bearer, PORTAL_SECRET); } catch { throw new GatewayError('unauthenticated', 401); } } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); f.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, bearer: string | null, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as Row };
  };
  const put = (body: unknown, bearer: string | null = operatorToken()) => call('PUT', ROUTE, bearer, body);
  const get = (query: string, bearer: string | null = operatorToken()) => call('GET', `${ROUTE}${query}`, bearer);
  const tenants = () => f.ledger.db.all<{ id: string; body: string }>('SELECT id, body FROM tenants ORDER BY id');
  const events = () => f.ledger.db.all<{ kind: string; body: string }>("SELECT kind, body FROM events WHERE tenant='company-new' ORDER BY seq");
  return { ...f, put, get, tenants, events };
}
const operatorToken = (secret = OPERATOR_SECRET) => signOperatorToken('ops@realbud.example', secret, Date.now(), 60_000);

test('the route needs an operator token: none, a portal token or a portal-secret token is 401 and writes nothing', async () => {
  const r = await routeFixture();
  const before = r.tenants();
  const portal = signPortalToken({ subject: 'owner-a', companyId: 'company-a', role: 'billing_owner' }, PORTAL_SECRET);
  for (const bearer of [null, portal, operatorToken(PORTAL_SECRET), 'x'.repeat(40)]) {
    assert.deepEqual(await r.put(BODY, bearer), { status: 401, body: { error: 'operator_unauthenticated' } });
    assert.deepEqual(await r.get('?companyId=company-a', bearer), { status: 401, body: { error: 'operator_unauthenticated' } });
  }
  assert.deepEqual(r.tenants(), before);
  assert.deepEqual(r.events(), []);
  // Without a distinct operator secret nothing is composed.
  for (const env of [{ ...ENV, REALBUD_GATEWAY_OPERATOR_SECRET: '' }, { ...ENV, REALBUD_GATEWAY_OPERATOR_SECRET: PORTAL_SECRET }]) {
    const off = await routeFixture(env);
    assert.deepEqual(await off.put(BODY), { status: 503, body: { error: 'operator_unconfigured' } });
  }
});

test('create, unchanged, update and read back, with one audit line each and no ABN or evidence in the answer', async () => {
  const r = await routeFixture();
  assert.deepEqual(await r.get('?companyId=company-new'), { status: 404, body: { error: 'not_found' } });
  assert.deepEqual(await r.put(BODY), { status: 200, body: { result: 'created', entitlement: ENTITLEMENT } });
  // The same body again writes no entitlement change, even under new evidence.
  assert.deepEqual(await r.put(BODY), { status: 200, body: { result: 'unchanged', entitlement: ENTITLEMENT } });
  assert.deepEqual(await r.put({ ...BODY, evidence: 'operator-ticket-2' }), { status: 200, body: { result: 'unchanged', entitlement: ENTITLEMENT } });
  const suspended = await r.put({ ...BODY, evidence: 'operator-ticket-3', active: false, expires: '2028-01-01' });
  assert.deepEqual(suspended, { status: 200, body: { result: 'updated', entitlement: { ...ENTITLEMENT, active: false, serviceAvailable: false, serviceExpiresAt: '2028-01-01T00:00:00.000Z' } } });
  // `active` omitted keeps the stored value, as the command does.
  assert.equal((await r.put({ ...BODY, expires: '2028-01-01' })).body.result, 'unchanged');
  assert.deepEqual(await r.get('?companyId=company-new'), { status: 200, body: { entitlement: suspended.body.entitlement } });
  const events = r.events();
  assert.deepEqual(events.map(e => e.kind), ['tenant_provisioned', 'operator_entitlement_set', 'operator_entitlement_set', 'operator_entitlement_set',
    'service_entitlement_updated', 'operator_entitlement_set', 'operator_entitlement_set']);
  assert.deepEqual(events.filter(e => e.kind === 'operator_entitlement_set').map(e => JSON.parse(e.body)), ['created', 'unchanged', 'unchanged', 'updated', 'unchanged']
    .map(result => ({ subject: 'operator:ops@realbud.example', companyId: 'company-new', result })));
  for (const event of events) assert(!event.body.includes(OPERATOR_SECRET), event.kind);
});

test('a company bound to another licence is 409 license_id_immutable and keeps its licence', async () => {
  const r = await routeFixture();
  assert.equal((await r.put(BODY)).status, 200);
  assert.deepEqual(await r.put({ ...BODY, licenseId: 'license-other' }), { status: 409, body: { error: 'license_id_immutable' } });
  // The fixture's own office too.
  assert.deepEqual(await r.put({ ...BODY, companyId: 'company-a' }), { status: 409, body: { error: 'license_id_immutable' } });
  assert.equal(r.ledger.tenant('company-new').licenseId, 'license-new');
  assert.equal(r.ledger.tenant('company-a').licenseId, 'license-a');
});

test('invalid bodies are refused with the command codes and write nothing', async () => {
  const r = await routeFixture();
  const { companyId: _omitted, ...missingCompany } = BODY;
  const cases: [unknown, string][] = [
    [null, 'invalid_entitlement'], [[BODY], 'invalid_entitlement'], ['company-new', 'invalid_entitlement'],
    [missingCompany, 'invalid_entitlement'], [{ ...BODY, extra: 1 }, 'invalid_entitlement'], [{ ...BODY, abn: '12345678901' }, 'invalid_entitlement'],
    [{ ...BODY, name: '' }, 'invalid_entitlement'], [{ ...BODY, licenseId: 7 }, 'invalid_entitlement'], [{ ...BODY, active: 'true' }, 'invalid_entitlement'],
    // Same codes as `entitlement-cli.ts set` for the same input.
    [{ ...BODY, goLive: '2027-01-01' }, 'invalid_go_live'],
    [{ ...BODY, expires: '2026-08-01' }, 'invalid_service_expiry'],
    [{ ...BODY, expires: '2026-09-01' }, 'invalid_service_expiry'],
    [{ ...BODY, companyId: 'company fictional' }, 'invalid_id'],
    [{ ...BODY, name: '   ' }, 'customer_identity_required'],
    // Dates are YYYY-MM-DD calendar days only.
    [{ ...BODY, goLive: '2026-09-01T00:00:00Z' }, 'invalid_go_live'], [{ ...BODY, goLive: '2026-02-30' }, 'invalid_go_live'],
    [{ ...BODY, expires: 'next year' }, 'invalid_service_expiry'], [{ ...BODY, expires: '1790000000000' }, 'invalid_service_expiry'],
  ];
  for (const [body, error] of cases) assert.deepEqual(await r.put(body), { status: 400, body: { error } }, JSON.stringify(body));
  assert.deepEqual(r.tenants().map(t => t.id), ['company-a']);
  assert.deepEqual(r.events(), []);
  assert.deepEqual(await r.get(''), { status: 400, body: { error: 'invalid_entitlement' } });
  assert.deepEqual(await r.get('?companyId=../x'), { status: 400, body: { error: 'invalid_id' } });
  assert.deepEqual(await r.get('?companyId=company-a&extra=1'), { status: 400, body: { error: 'invalid_query' } });
});

test('the route stores exactly what `entitlement-cli.ts set` stores for the same entitlement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'realbud-entitlement-parity-'));
  try {
    const env = { REALBUD_GATEWAY_DATA: root };
    new LedgerDatabase(ledgerPath(env)).close();
    const lines: string[] = [];
    assert.equal(runEntitlementCli(['set', '--company', BODY.companyId, '--evidence', BODY.evidence, '--license', BODY.licenseId, '--name', BODY.name,
      '--address', BODY.address, '--go-live', BODY.goLive, '--go-live-evidence', BODY.goLiveEvidence, '--expires', BODY.expires],
    { env, now: () => FIXTURE_TIME, out: line => lines.push(line), err: () => {} }), 0);
    const db = new LedgerDatabase(ledgerPath(env));
    const byCli = db.get<{ body: string }>('SELECT body FROM tenants WHERE id=?', BODY.companyId)!.body;
    db.close();
    const r = await routeFixture();
    assert.equal((await r.put(BODY)).status, 200);
    assert.equal(r.tenants().find(t => t.id === BODY.companyId)!.body, byCli);
    // The route's entitlement is the command's view without ABN and evidence.
    const { goLiveEvidence: _evidence, ...cliView } = JSON.parse(lines[0]!).entitlement;
    assert.deepEqual(cliView, ENTITLEMENT);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('concurrent identical requests create once and report unchanged for the rest', async () => {
  const r = await routeFixture();
  const results = await Promise.all([r.put(BODY), r.put(BODY), r.put(BODY)]);
  assert.deepEqual(results.map(x => x.body.result).sort(), ['created', 'unchanged', 'unchanged']);
  assert.equal(r.events().filter(e => e.kind === 'tenant_provisioned').length, 1);
});
