import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readServiceEntitlement } from '../server/service-entitlement.ts';
import { LedgerDatabase } from './database.ts';
import { UsageLedger } from './ledger.ts';
import { issueDesktopServiceEntitlement, runServiceEntitlementIssuerCli } from './service-entitlement-issuer.ts';

const NOW = Date.now();
const DAY = 86_400_000;
const COMPANY = 'company-fictional';
const HOST = 'install-fictional';
const LICENSE = 'license-fictional';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'realbud-service-issuer-'));
  const db = new LedgerDatabase(join(root, 'ledger.sqlite'));
  let clock = NOW;
  const ledger = new UsageLedger(db, () => clock);
  ledger.putEntitlement({ companyId: COMPANY, licenseId: LICENSE, active: true, goLiveAt: NOW - DAY,
    serviceExpiresAt: NOW + 400 * DAY, customerName: 'Fictional Office', customerAddress: 'Fictional address',
    goLiveEvidence: 'fictional-ticket' }, 'fictional-ticket');
  db.run('CREATE TABLE installation_provisioning (tenant TEXT, installation TEXT, state TEXT, body TEXT, created INTEGER, PRIMARY KEY(tenant,installation))');
  const ready = { state: 'ready', deviceId: HOST, descriptor: { service: { companyId: COMPANY, hostInstallationId: HOST } } };
  db.run('INSERT INTO installation_provisioning(tenant,installation,state,body,created) VALUES(?,?,?,?,?)', COMPANY, HOST, 'ready', JSON.stringify(ready), NOW);
  const registryPath = join(root, 'connectors.json');
  const device = { id: HOST, companyId: COMPANY, licenseId: LICENSE, memberId: HOST, installationId: HOST,
    profile: 'property', tokenHash: 'a'.repeat(64), active: true, expiresAt: NOW + DAY,
    projectKeyEnv: 'REALBUD_COMPOSIO_PROJECT_FICTIONAL', authConfigId: 'auth-fictional', userId: 'user-fictional', apps: ['gmail'] };
  const saveRegistry = (patch: Record<string, unknown> = {}) => writeFileSync(registryPath,
    JSON.stringify({ version: 1, devices: [{ ...device, ...patch }] }), { mode: 0o600 });
  saveRegistry();
  const keys = generateKeyPairSync('ed25519');
  return { root, db, ledger, registryPath, keys, saveRegistry, setClock: (value: number) => { clock = value; },
    issue: () => issueDesktopServiceEntitlement({ ledger, registryPath, companyId: COMPANY, hostInstallationId: HOST,
      keyId: 'fictional-issuer', privateKey: keys.privateKey }),
    close: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('issues only a signed grant for the ready enrolled host and active tenant, with bounded expiry', () => {
  const f = fixture();
  try {
    const { bundle } = f.issue();
    const payload = JSON.parse(bundle.entitlement.payload);
    assert.equal(payload.licenseId, LICENSE);
    assert.equal(payload.companyId, COMPANY);
    assert.equal(payload.hostInstallationId, HOST);
    assert.equal(payload.expiresAt, NOW + 366 * DAY);
    assert.deepEqual(payload.capabilities, ['computer-use', 'connected-tools', 'reasoning', 'voice']);
    const grant = join(f.root, 'grant.json'), trust = join(f.root, 'trust.json');
    writeFileSync(grant, JSON.stringify(bundle.entitlement));
    writeFileSync(trust, JSON.stringify(bundle.trust));
    assert.equal(readServiceEntitlement({ managed: true, path: grant, trustedKeysPath: trust,
      companyId: COMPANY, hostInstallationId: HOST, now: NOW }).state, 'active');
    assert.doesNotMatch(JSON.stringify(bundle), /PRIVATE KEY/);
  } finally { f.close(); }
});

test('refuses suspended/expired offices, revoked hosts and mismatched bindings', () => {
  const f = fixture();
  try {
    f.ledger.setService(COMPANY, false, NOW + DAY, 'fictional-suspend');
    assert.throws(f.issue, /service_unavailable/);
    f.ledger.setService(COMPANY, true, NOW, 'fictional-expire');
    assert.throws(f.issue, /service_unavailable/);
    f.ledger.setService(COMPANY, true, NOW + DAY, 'fictional-resume');
    f.saveRegistry({ active: false });
    assert.throws(f.issue, /service_host_unavailable/);
    f.saveRegistry({ active: true, companyId: 'foreign-company' });
    assert.throws(f.issue, /service_host_unavailable/);
    f.saveRegistry({ active: true, installationId: 'foreign-installation' });
    assert.throws(f.issue, /service_host_unavailable/);
    f.saveRegistry({ active: true, licenseId: 'foreign-license' });
    assert.throws(f.issue, /service_host_unavailable/);
    f.saveRegistry();
    f.db.run("UPDATE installation_provisioning SET body=? WHERE tenant=? AND installation=?",
      JSON.stringify({ state: 'ready', deviceId: HOST, descriptor: { service: { companyId: 'foreign-company', hostInstallationId: HOST } } }), COMPANY, HOST);
    assert.throws(f.issue, /service_installation_unavailable/);
    f.db.run("UPDATE installation_provisioning SET state='revoked' WHERE tenant=? AND installation=?", COMPANY, HOST);
    assert.throws(f.issue, /service_installation_unavailable/);
  } finally { f.close(); }
});

test('operator command writes a private public bundle and never prints key material', () => {
  const f = fixture();
  try {
    const keyPath = join(f.root, 'signing-key.pem');
    writeFileSync(keyPath, f.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const output = join(f.root, 'bundle.json');
    const lines: string[] = [], errors: string[] = [];
    const env = { REALBUD_GATEWAY_DATA: f.root, REALBUD_GATEWAY_CONNECTOR_REGISTRY: f.registryPath };
    assert.equal(runServiceEntitlementIssuerCli(['--company', COMPANY, '--installation', HOST,
      '--key-id', 'fictional-issuer', '--key-file', keyPath, '--out', output], env, line => lines.push(line), line => errors.push(line)), 0);
    assert.equal(errors.length, 0);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(output, 'utf8')).entitlement.keyId, 'fictional-issuer');
    assert.equal(JSON.parse(lines[0]!).result, 'issued');
    assert.doesNotMatch(lines.join('') + errors.join('') + readFileSync(output, 'utf8'), /PRIVATE KEY/);
    assert.equal(runServiceEntitlementIssuerCli(['--company', COMPANY, '--installation', HOST,
      '--key-id', 'fictional-issuer', '--key-file', keyPath, '--out', output], env, line => lines.push(line), line => errors.push(line)), 1);
    assert.deepEqual(JSON.parse(errors.at(-1)!), { error: 'service_issuer_failed' });
  } finally { f.close(); }
});
