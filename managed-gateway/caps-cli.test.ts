import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCapsCli } from './caps-cli.ts';
import { GatewayError } from './contracts.ts';
import { ledgerPath } from './local-env.ts';
import { fixture } from './testing.ts';
import type { ModelviaCaps, ModelviaClient, ModelviaCustomer } from './modelvia-keys.ts';

const CUSTOMER = 'cus-fictional-office';
const OPERATOR_SECRET = 'fictional-operator-secret-of-32-chars-never-printed';
const OPERATOR_ENV = { REALBUD_MODELVIA_BASE_URL: 'https://api.modelvia.dev', REALBUD_MODELVIA_OPERATOR_SECRET: OPERATOR_SECRET,
  REALBUD_MODELVIA_OPERATOR_SUBJECT: 'realbud-operator', REALBUD_MODELVIA_CLIENT_ID: 'realbud' };

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'realbud-caps-'));
  const env: NodeJS.ProcessEnv = { REALBUD_GATEWAY_DATA: root, ...OPERATOR_ENV };
  // The server's database with one entitled company and its provisioning rows.
  const f = fixture(ledgerPath(env)), companyId = f.tenant.companyId, now = f.now();
  f.ledger.db.run('CREATE TABLE IF NOT EXISTS installation_provisioning (tenant TEXT NOT NULL, installation TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(tenant,installation))');
  const row = (installation: string, state: string) => f.ledger.db.run('INSERT INTO installation_provisioning VALUES(?,?,?,?,?)', companyId, installation, state,
    JSON.stringify({ state, profile: 'property', apps: ['gmail'], customerId: CUSTOMER, modelProjectId: `rb-${installation}` }), now);
  row('install-one', 'ready'); row('install-two', 'ready'); row('install-gone', 'revoked');
  f.close();
  const calls = { reads: 0, updates: [] as unknown[] };
  let failOn: string | undefined;
  const modelvia = {
    environment: 'production',
    async findCustomer(id: string): Promise<ModelviaCustomer | null> { calls.reads++; return id === CUSTOMER ? { active: true, monthlyCapNanoAud: '90000000000', maxConcurrent: 5 } : null; },
    async updateProjectCaps(projectId: string, caps: ModelviaCaps) {
      if (projectId === failOn) throw new GatewayError('modelvia_unreachable', 502);
      calls.updates.push({ projectId, ...caps }); return { updated: true, version: 2 };
    },
  } as unknown as ModelviaClient;
  const lines: string[] = [], errors: string[] = [];
  const never = async () => { throw new Error('no network in tests'); };
  const run = (argv: string[], extra: NodeJS.ProcessEnv = {}) => runCapsCli(argv, { env: { ...env, ...extra }, now: () => now, fetch: never, modelvia,
    out: line => lines.push(line), err: line => errors.push(line) });
  return { companyId, calls, run, lines, errors, failOn: (id: string) => { failOn = id; }, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('apply refreshes every ready installation and prints installation ids and states only', async () => {
  const h = harness(); try {
    assert.equal(await h.run(['apply', '--company', h.companyId]), 0);
    const printed = JSON.parse(h.lines.at(-1)!);
    assert.equal(printed.result, 'applied');
    assert.deepEqual(printed.installations, [{ installationId: 'install-one', state: 'applied' }, { installationId: 'install-two', state: 'applied' }]);
    assert.deepEqual(h.calls.updates, [
      { projectId: 'rb-install-one', monthlyCapNanoAud: '90000000000', requestCapNanoAud: '1000000000', maxConcurrent: 5 },
      { projectId: 'rb-install-two', monthlyCapNanoAud: '90000000000', requestCapNanoAud: '1000000000', maxConcurrent: 5 }]);
    assert.equal(h.calls.reads, 1);
    const output = h.lines.concat(h.errors).join('\n');
    assert.ok(!output.includes(CUSTOMER)); assert.ok(!output.includes(OPERATOR_SECRET));
  } finally { h.close(); }
});

test('apply exits non-zero and reports a partial result when one installation fails', async () => {
  const h = harness(); try {
    h.failOn('rb-install-one');
    assert.equal(await h.run(['apply', '--company', h.companyId], { REALBUD_MODELVIA_REQUEST_CAP_NANO_AUD: '2000000000' }), 1);
    const printed = JSON.parse(h.lines.at(-1)!);
    assert.equal(printed.result, 'partial');
    assert.deepEqual(printed.installations, [{ installationId: 'install-one', state: 'failed', error: 'modelvia_unreachable' }, { installationId: 'install-two', state: 'applied' }]);
    assert.deepEqual(h.calls.updates, [{ projectId: 'rb-install-two', monthlyCapNanoAud: '90000000000', requestCapNanoAud: '2000000000', maxConcurrent: 5 }]);
  } finally { h.close(); }
});

test('apply refuses bad arguments, missing operator env, a bad request cap and an unknown company before any Modelvia call', async () => {
  const cases: [string[], NodeJS.ProcessEnv, string][] = [
    [['apply'], {}, 'invalid_arguments'],
    [['set', '--company', 'company-a'], {}, 'invalid_arguments'],
    [['apply', '--company', 'company-a', '--extra'], {}, 'invalid_arguments'],
    [['apply', '--company', 'company-a'], { REALBUD_MODELVIA_OPERATOR_SECRET: '' }, 'modelvia_unconfigured:REALBUD_MODELVIA_OPERATOR_SECRET'],
    [['apply', '--company', 'company-a'], { REALBUD_MODELVIA_OPERATOR_SECRET: 'short' }, 'provisioning_unconfigured:REALBUD_MODELVIA_OPERATOR_SECRET'],
    [['apply', '--company', 'company-a'], { REALBUD_MODELVIA_REQUEST_CAP_NANO_AUD: '0' }, 'provisioning_unconfigured:REALBUD_MODELVIA_REQUEST_CAP_NANO_AUD'],
    [['apply', '--company', 'company-absent'], {}, 'tenant_unavailable'],
  ];
  for (const [argv, env, code] of cases) {
    const h = harness(); try {
      assert.equal(await h.run(argv, env), 1, argv.join(' '));
      assert.equal(JSON.parse(h.errors[0]!).error, code, argv.join(' '));
      assert.equal(h.calls.reads, 0); assert.deepEqual(h.calls.updates, []);
      assert.ok(!h.errors.join('\n').includes(OPERATOR_SECRET));
    } finally { h.close(); }
  }
});
