import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEntitlementCli } from './entitlement-cli.ts';
import { LedgerDatabase } from './database.ts';
import { UsageLedger } from './ledger.ts';
import { ledgerPath } from './local-env.ts';

const NOW = Date.parse('2026-09-24T00:00:00Z');
const SECRET = 'fictional-portal-secret-must-never-be-printed-0001';
const CREATE = ['set', '--company', 'company-fictional', '--evidence', 'operator-ticket-1', '--license', 'license-fictional',
  '--name', 'Fictional Realty Pty Ltd', '--address', '1 Example Street, Brisbane QLD', '--go-live', '2026-09-01T00:00:00Z',
  '--go-live-evidence', 'signed-order-fictional', '--expires', '2027-09-01T00:00:00Z'];
/** CREATE with one flag's value replaced. */
const creating = (flag: string, value: string) => CREATE.map((item, i) => CREATE[i - 1] === flag ? value : item);

function harness(options: { database?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'realbud-entitlement-'));
  const env = { REALBUD_GATEWAY_DATA: root, REALBUD_GATEWAY_PORTAL_SECRET: SECRET };
  // The server creates the database on first boot; the command never does.
  if (options.database !== false) new LedgerDatabase(ledgerPath(env)).close();
  const lines: string[] = [], errors: string[] = [];
  const run = (...argv: string[]) => runEntitlementCli(argv, { env, now: () => NOW, out: line => lines.push(line), err: line => errors.push(line) });
  const last = () => JSON.parse(lines.at(-1)!), lastError = () => JSON.parse(errors.find(line => line.startsWith('{'))!);
  const read = <T>(work: (ledger: UsageLedger) => T): T => { const db = new LedgerDatabase(ledgerPath(env)); try { return work(new UsageLedger(db, () => NOW)); } finally { db.close(); } };
  return { root, env, run, lines, errors, last, lastError, read, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('the command and the server open the same ledger database', () => {
  assert.equal(ledgerPath({ REALBUD_GATEWAY_DATA: '/data' }), '/data/ledger.sqlite');
  assert.equal(ledgerPath({}), join(process.cwd(), 'data', 'ledger.sqlite'));
});

test('set creates an entitlement the ledger then serves, with inert caps and nothing secret printed', () => {
  const h = harness(); try {
    assert.equal(h.run(...CREATE), 0);
    const created = h.last();
    assert.equal(created.result, 'created'); assert.equal(created.database, ledgerPath(h.env));
    assert.deepEqual(created.entitlement, { companyId: 'company-fictional', licenseId: 'license-fictional', active: true, serviceAvailable: true,
      goLiveAt: '2026-09-01T00:00:00.000Z', serviceExpiresAt: '2027-09-01T00:00:00.000Z', customerName: 'Fictional Realty Pty Ltd',
      customerAddress: '1 Example Street, Brisbane QLD', goLiveEvidence: 'signed-order-fictional' });
    // What provisioning and connectors read.
    const tenant = h.read(ledger => ledger.tenant('company-fictional'));
    assert.equal(tenant.licenseId, 'license-fictional'); assert.equal(tenant.active, true);
    // AI caps are Modelvia's: stored inert, never printed.
    assert.deepEqual([tenant.monthlyCapNanoAud, tenant.requestCapNanoAud, tenant.maxConcurrent], ['0', '0', 1]);
    assert.ok(!h.lines.join('\n').includes('CapNanoAud'));
    assert.ok(!h.lines.concat(h.errors).join('\n').includes(SECRET));
    const events = h.read(ledger => ledger.db.all<{ kind: string; body: string }>('SELECT kind, body FROM events'));
    assert.equal(events.length, 1); assert.equal(events[0]!.kind, 'tenant_provisioned'); assert.match(events[0]!.body, /operator-ticket-1/);

    assert.equal(h.run('get', '--company', 'company-fictional'), 0);
    assert.equal(h.last().result, 'found'); assert.deepEqual(h.last().entitlement, created.entitlement);
  } finally { h.close(); }
});

test('set on an existing company changes only the given fields and keeps the licence fixed', () => {
  const h = harness(); try {
    assert.equal(h.run(...CREATE, '--abn', '12345678901'), 0);
    assert.equal(h.run('set', '--company', 'company-fictional', '--evidence', 'operator-ticket-2', '--active', 'false'), 0);
    const suspended = h.last();
    assert.equal(suspended.result, 'updated');
    assert.equal(suspended.entitlement.active, false); assert.equal(suspended.entitlement.serviceAvailable, false);
    assert.equal(suspended.entitlement.customerAbn, '12345678901'); assert.equal(suspended.entitlement.customerName, 'Fictional Realty Pty Ltd');
    assert.equal(h.run('set', '--company', 'company-fictional', '--evidence', 'operator-ticket-3', '--active', 'true', '--expires', '2028-01-01', '--abn', 'none'), 0);
    assert.equal(h.last().entitlement.serviceExpiresAt, '2028-01-01T00:00:00.000Z'); assert.equal('customerAbn' in h.last().entitlement, false);
    assert.equal(h.read(ledger => ledger.tenant('company-fictional')).customerAbn, undefined);
    const kinds = h.read(ledger => ledger.db.all<{ kind: string }>('SELECT kind FROM events').map(row => row.kind));
    assert.deepEqual(kinds, ['tenant_provisioned', 'service_entitlement_updated', 'service_entitlement_updated']);

    // An expiry at or before go-live is refused on update too, and changes nothing.
    assert.equal(h.run('set', '--company', 'company-fictional', '--evidence', 'operator-ticket-5', '--expires', '2026-09-01'), 1);
    assert.equal(h.lastError().error, 'invalid_service_expiry');
    assert.equal(h.read(ledger => ledger.tenant('company-fictional')).serviceExpiresAt, Date.parse('2028-01-01'));
    h.errors.length = 0;
    assert.equal(h.run('set', '--company', 'company-fictional', '--evidence', 'operator-ticket-4', '--license', 'license-other'), 1);
    assert.equal(h.lastError().error, 'license_id_immutable');
    assert.equal(h.read(ledger => ledger.tenant('company-fictional')).licenseId, 'license-fictional');
  } finally { h.close(); }
});

test('invalid input is refused with a code and writes nothing', () => {
  const cases: [string[], string][] = [
    [[], 'invalid_arguments'],
    [['set', '--company', 'company-fictional'], 'invalid_arguments'],
    [['get', '--company', 'company-fictional', '--name', 'x'], 'invalid_arguments'],
    [['set', '--company', 'company-fictional', '--evidence', 'e', '--unknown', 'x'], 'invalid_arguments'],
    [['set', '--company', 'company-fictional', '--evidence', 'e', '--license', 'license-fictional'], 'entitlement_fields_required'],
    [creating('--go-live', '2027-01-01T00:00:00Z'), 'invalid_go_live'],
    [[...CREATE, '--abn', '123'], 'invalid_customer_abn'],
    [[...CREATE, '--active', 'maybe'], 'invalid_service_state'],
    [creating('--expires', 'next year'), 'invalid_time'],
    [creating('--expires', '2026-08-01T00:00:00Z'), 'invalid_service_expiry'],
    [creating('--expires', '2026-09-01T00:00:00Z'), 'invalid_service_expiry'],
    [creating('--company', 'company fictional'), 'invalid_id'],
    [creating('--name', '   '), 'customer_identity_required'],
    [['get', '--company', 'company-absent'], 'entitlement_not_found'],
  ];
  for (const [argv, code] of cases) {
    const h = harness(); try {
      assert.equal(h.run(...argv), 1, argv.join(' '));
      assert.equal(h.lastError().error, code, argv.join(' '));
      assert.equal(h.read(ledger => ledger.db.all('SELECT id FROM tenants').length), 0);
      assert.ok(!h.errors.join('\n').includes(SECRET)); assert.ok(!h.errors.join('\n').includes('at '));
    } finally { h.close(); }
  }
});

test('a missing database is refused rather than created, so a wrong data path cannot hide an entitlement', () => {
  const h = harness({ database: false }); try {
    assert.equal(h.run(...CREATE), 1);
    assert.equal(h.lastError().error, 'ledger_database_missing'); assert.equal(h.lastError().database, ledgerPath(h.env));
    assert.equal(existsSync(ledgerPath(h.env)), false);
  } finally { h.close(); }
});
