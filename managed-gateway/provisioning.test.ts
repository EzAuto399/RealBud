import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './testing.ts';
import { createGatewayServer } from './http.ts';
import { validateConnectorDevices } from './connectors.ts';
import { composeProvisioning, fileSecretStore, InstallationProvisioning, PENDING_RESUME_AFTER_MS, PROVISIONING_ENV, type ProvisioningDescriptor } from './provisioning.ts';
import type { ComposioOrgClient, HttpTransport } from './composio-org.ts';
import type { ModelviaCaps, ModelviaClient, ModelviaProjectInput } from './modelvia-keys.ts';
import { GatewayError } from './contracts.ts';

const ORG_KEY = 'fictional-org-key-never-in-a-response';
const PROJECT_KEY = 'ak_fictional_project_key_for_tests';
const MODEL_KEY = `rbk_0123456789abcdef_${'A'.repeat(43)}`;
const CUSTOMER = 'cus-fictional-office';
/** Key ids the fake hands out in order; the first matches MODEL_KEY. */
const KEY_IDS = ['0123456789abcdef', 'fedcba9876543210', '00000000000000a3', '00000000000000b4'];
const synthetic = (keyId: string) => `rbk_${keyId}_${(keyId === KEY_IDS[0] ? 'A' : 'B').repeat(43)}`;

function harness() {
  const f = fixture();
  const root = mkdtempSync(join(tmpdir(), 'realbud-provisioning-'));
  const registry = join(root, 'registry', 'devices.json'), secretsDir = join(root, 'secrets');
  const org = { created: [] as string[], deleted: [] as string[], projects: [] as { id: string; name: string }[], orgKeyReads: 0 };
  /** A stateful stand-in for Modelvia: what it holds survives a lost reply,
   * which is the whole point of the recovery it exercises. `lose` performs the
   * named effect and then throws, as a reply lost on the wire would. */
  const modelvia = { projects: [] as unknown[], minted: [] as unknown[], revoked: [] as string[], rotated: [] as string[], capUpdates: [] as unknown[],
    held: new Map<string, ModelviaProjectInput & { active: boolean; environments: string[] }>(),
    keys: [] as { keyId: string; projectId: string; label: string; revokedAt?: number }[],
    lose: undefined as undefined | 'createProject' | 'mint' | 'rotate', failCaps: false };
  const lost = (effect: 'createProject' | 'mint' | 'rotate') => { if (modelvia.lose === effect) { modelvia.lose = undefined; throw new GatewayError('modelvia_unreachable', 502); } };
  const issue = (projectId: string, label: string) => {
    const keyId = KEY_IDS[modelvia.keys.length]!; modelvia.keys.push({ keyId, projectId, label });
    return { key: synthetic(keyId), keyId, baseUrl: 'https://api.modelvia.dev/v1' };
  };
  const orgClient: ComposioOrgClient = {
    async listProjects() { org.orgKeyReads++; return org.projects.map(p => ({ ...p })); },
    async createProject(name) { org.created.push(name); const project = { id: `pr_${org.created.length}`, name }; org.projects.push(project); return { ...project, apiKey: PROJECT_KEY }; },
    async deleteProject(id) { org.deleted.push(id); org.projects = org.projects.filter(p => p.id !== id); return { revokeJobId: 'job-fictional' }; },
  };
  const modelviaClient: ModelviaClient = {
    environment: 'production',
    async createProject(input) {
      modelvia.projects.push(input);
      if (modelvia.held.has(input.projectId)) return { projectId: input.projectId, created: false };
      modelvia.held.set(input.projectId, { ...input, active: true, environments: ['production'] });
      lost('createProject');
      return { projectId: input.projectId, created: true };
    },
    async findProject(projectId) {
      const held = modelvia.held.get(projectId);
      return held && { projectId, clientId: 'realbud', customerId: held.customerId, environments: held.environments, active: held.active, version: 1,
        monthlyCapNanoAud: held.monthlyCapNanoAud, requestCapNanoAud: held.requestCapNanoAud, maxConcurrent: held.maxConcurrent };
    },
    async mint(input) { modelvia.minted.push(input); const key = issue(input.projectId, input.label); lost('mint'); return key; },
    async listKeys(projectId, environment) {
      assert.equal(environment, 'production');
      return modelvia.keys.filter(key => key.projectId === projectId).map(key => ({ keyId: key.keyId, projectId, environment, label: key.label, ...(key.revokedAt ? { revokedAt: key.revokedAt } : {}) }));
    },
    async rotate(keyId) {
      const old = modelvia.keys.find(key => key.keyId === keyId && !key.revokedAt);
      if (!old) throw new GatewayError('modelvia_rejected', 502);
      modelvia.rotated.push(keyId); old.revokedAt = 1;
      const key = issue(old.projectId, old.label); lost('rotate');
      return { ...key, projectId: old.projectId, replaced: keyId };
    },
    async revoke(keyId) { modelvia.revoked.push(keyId); },
    async updateProjectCaps(projectId, caps: ModelviaCaps) {
      modelvia.capUpdates.push({ projectId, ...caps });
      if (modelvia.failCaps) throw new GatewayError('modelvia_unreachable', 502);
      const held = modelvia.held.get(projectId)!;
      const updated = held.monthlyCapNanoAud !== caps.monthlyCapNanoAud || held.requestCapNanoAud !== caps.requestCapNanoAud || held.maxConcurrent !== caps.maxConcurrent;
      Object.assign(held, caps);
      return { updated, version: 2 };
    },
  };
  const secrets = fileSecretStore(secretsDir);
  const make = (overrides: Partial<ConstructorParameters<typeof InstallationProvisioning>[0]> = {}) => new InstallationProvisioning({
    ledger: f.ledger, registry, endpoint: 'https://managed.example.invalid', secrets,
    org: orgClient, modelvia: modelviaClient, authConfigs: { gmail: 'ac-fictional-readonly' }, ...overrides,
  });
  const request = { companyId: f.tenant.companyId, installationId: 'install-one', customerId: CUSTOMER, profile: 'property' };
  return { f, root, registry, secretsDir, secrets, org, modelvia, orgClient, modelviaClient, make, request,
    devices: () => validateConnectorDevices(JSON.parse(readFileSync(registry, 'utf8'))),
    close: () => { rmSync(root, { recursive: true, force: true }); f.close(); } };
}

test('provision returns secret material once and the same descriptor on repeat without minting again', async () => {
  const h = harness(); try {
    const first = await h.make().provision(h.f.owner, h.request);
    const provisioning = first.provisioning as ProvisioningDescriptor;
    assert.equal(provisioning.version, 1);
    assert.deepEqual(provisioning.service, { companyId: h.f.tenant.companyId, hostInstallationId: 'install-one' });
    assert.equal(provisioning.connector.endpoint, 'https://managed.example.invalid');
    assert.deepEqual(provisioning.connector.apps, ['gmail']);
    // The portal records the Composio project id; the project key never leaves the service.
    assert.equal(provisioning.connector.projectId, 'pr_1');
    assert.match(provisioning.connector.credential!, /^rbc_[a-f0-9]{64}$/);
    assert.equal(provisioning.model.provider, 'modelvia');
    assert.equal(provisioning.model.baseUrl, 'https://api.modelvia.dev/v1');
    assert.equal(provisioning.model.key, MODEL_KEY);
    assert.equal(provisioning.model.keyId, '0123456789abcdef');
    // One Modelvia project per installation, under the company's customer, capped
    // from this gateway's ledger tenant. Request cap is clamped to the monthly cap.
    assert.equal(provisioning.model.projectId, 'rb-install-one');
    assert.deepEqual(h.modelvia.projects, [{ projectId: 'rb-install-one', name: 'RealBud installation install-one', customerId: CUSTOMER,
      monthlyCapNanoAud: h.f.tenant.monthlyCapNanoAud, requestCapNanoAud: h.f.tenant.requestCapNanoAud, maxConcurrent: h.f.tenant.maxConcurrent }]);
    assert.deepEqual(h.modelvia.minted, [{ projectId: 'rb-install-one', label: `${h.f.tenant.companyId}:install-one` }]);
    assert.equal(provisioning.model.spendCapLabel,
      `monthly-cap ${h.f.tenant.monthlyCapNanoAud} nanoAUD, request-cap ${h.f.tenant.requestCapNanoAud} nanoAUD, max-concurrent ${h.f.tenant.maxConcurrent}`);

    const second = await h.make().provision(h.f.owner, h.request);
    assert.equal(second.provisioning.connector.credential, undefined);
    assert.equal(second.provisioning.model.key, undefined);
    assert.deepEqual(second.provisioning.service, provisioning.service);
    assert.equal(second.provisioning.model.keyId, provisioning.model.keyId);
    assert.equal(second.provisioning.connector.projectId, 'pr_1');
    assert.equal(second.provisioning.model.projectId, 'rb-install-one');
    assert.equal(h.modelvia.projects.length, 1);
    // No second project, no second device, no second minted key.
    assert.deepEqual(h.org.created, [`realbud-${h.f.tenant.companyId}`]);
    assert.equal(h.modelvia.minted.length, 1);
    assert.equal(h.devices().length, 1);
    const device = h.devices()[0]!;
    assert.equal(device.installationId, 'install-one');
    assert.deepEqual(device.apps, ['gmail']);
    assert.equal(device.licenseId, h.f.tenant.licenseId);
    // The registry admits a hash, never the credential.
    assert.ok(!readFileSync(h.registry, 'utf8').includes(provisioning.connector.credential!));
  } finally { h.close(); }
});

test('the org key, the project key and issued credentials never reach a response or an audit line', async () => {
  const h = harness(); try {
    const result = await h.make().provision(h.f.owner, h.request);
    const credential = result.provisioning.connector.credential!;
    const events = h.f.ledger.db.all<{ body: string }>('SELECT body FROM events').map(row => row.body).join('\n');
    for (const secret of [ORG_KEY, PROJECT_KEY, credential, MODEL_KEY]) assert.ok(!events.includes(secret), `audit trail leaked ${secret.slice(0, 6)}…`);
    // The descriptor persisted for later reads holds no secret either.
    const stored = h.f.ledger.db.get<{ body: string }>('SELECT body FROM installation_provisioning WHERE tenant=?', h.f.tenant.companyId)!.body;
    for (const secret of [ORG_KEY, PROJECT_KEY, credential, MODEL_KEY]) assert.ok(!stored.includes(secret));
    assert.ok(stored.includes('0123456789abcdef'), 'the non-secret key id must be kept so revocation can reach it');
  } finally { h.close(); }
});

test('the secret store keeps the project key 0600 in a 0700 directory and never replaces one silently', async () => {
  const h = harness(); try {
    await h.make().provision(h.f.owner, h.request);
    const keyEnv = `REALBUD_COMPOSIO_PROJECT_${h.f.tenant.companyId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    assert.equal(h.secrets.read(keyEnv), PROJECT_KEY);
    if (process.platform !== 'win32') {
      assert.equal(statSync(join(h.secretsDir, keyEnv)).mode & 0o777, 0o600);
      assert.equal(statSync(h.secretsDir).mode & 0o777, 0o700);
    }
    assert.throws(() => h.secrets.write(keyEnv, 'ak_fictional_replacement'));
    assert.equal(h.secrets.read(keyEnv), PROJECT_KEY);
  } finally { h.close(); }
});

test('authority is the portal principal: role, company scope and service state gate before any external call', async () => {
  const h = harness(); try {
    const reader = { ...h.f.owner, role: 'billing_reader' as const };
    await assert.rejects(() => h.make().provision(reader, h.request), /forbidden/);
    await assert.rejects(() => h.make().provision(h.f.owner, { ...h.request, companyId: 'company-other' }), /company_scope_mismatch/);
    await assert.rejects(() => h.make().provision(h.f.owner, { ...h.request, extra: 1 }), /invalid_fields/);
    await assert.rejects(() => h.make().provision(h.f.owner, { ...h.request, profile: '../other' }), /invalid_connector_profile/);
    // The Modelvia customer is required, with no default, and must be path-safe.
    for (const customerId of [undefined, '', 'cus/../other', 'cus with space', 17]) {
      await assert.rejects(() => h.make().provision(h.f.owner, { ...h.request, customerId }), /invalid_modelvia_customer|invalid_fields/);
    }
    // `id()` admits ':' and '/', which a Modelvia project id cannot carry.
    await assert.rejects(() => h.make().provision(h.f.owner, { ...h.request, installationId: 'install/one' }), /installation_id_not_modelvia_safe/);
    h.f.ledger.setService(h.f.tenant.companyId, false, h.f.tenant.serviceExpiresAt, 'fixture-suspension');
    await assert.rejects(() => h.make().provision(h.f.owner, h.request), /service_unavailable/);
    assert.equal(h.org.orgKeyReads, 0); assert.equal(h.modelvia.minted.length, 0);
    assert.equal(existsSync(h.registry), false);
  } finally { h.close(); }
});

test('an unknown or unconfigured app is refused before any external call', async () => {
  const h = harness(); try {
    for (const apps of [['slack'], ['gmail', 'slack'], ['gmail', 'gmail'], [], 'gmail']) {
      await assert.rejects(() => h.make().provision(h.f.owner, { ...h.request, apps }));
    }
    await assert.rejects(() => h.make({ authConfigs: {} }).provision(h.f.owner, { ...h.request, apps: ['gmail'] }), /connector_app_not_admitted/);
    assert.equal(h.org.orgKeyReads, 0); assert.equal(h.modelvia.minted.length, 0);
  } finally { h.close(); }
});

const live = (h: ReturnType<typeof harness>) => h.modelvia.keys.filter(key => !key.revokedAt).map(key => key.keyId);
const later = (h: ReturnType<typeof harness>) => h.f.setTime(h.f.now() + PENDING_RESUME_AFTER_MS);

test('a lost mint reply is resumed by rotating the one labelled key, and a repeat after success rotates nothing', async () => {
  const h = harness(); try {
    h.modelvia.lose = 'mint';
    await assert.rejects(() => h.make().provision(h.f.owner, h.request), /modelvia_unreachable/);
    // The key exists at Modelvia; its only copy was in the lost reply.
    assert.deepEqual(live(h), ['0123456789abcdef']);
    const lostHash = h.devices()[0]!.tokenHash;
    // While that attempt could still be running, a retry is refused, not raced.
    await assert.rejects(() => h.make().provision(h.f.owner, h.request), /installation_provisioning_in_progress/);
    assert.equal(h.modelvia.projects.length, 1);

    later(h);
    const resumed = (await h.make().provision(h.f.owner, h.request)).provisioning;
    // Rotation revoked the lost copy and delivered a fresh one; nothing was minted twice.
    assert.deepEqual(h.modelvia.rotated, ['0123456789abcdef']);
    assert.equal(h.modelvia.minted.length, 1);
    assert.deepEqual(live(h), ['fedcba9876543210']);
    assert.equal(resumed.model.key, synthetic('fedcba9876543210'));
    assert.equal(resumed.model.keyId, 'fedcba9876543210');
    // The never-delivered connector credential was replaced, not duplicated.
    assert.match(resumed.connector.credential!, /^rbc_[a-f0-9]{64}$/);
    assert.equal(h.devices().length, 1);
    assert.notEqual(h.devices()[0]!.tokenHash, lostHash);
    assert.deepEqual(h.org.created, [`realbud-${h.f.tenant.companyId}`]);
    const provisioned = h.f.ledger.db.all<{ kind: string; body: string }>('SELECT kind,body FROM events').filter(row => row.kind === 'installation_provisioned');
    assert.equal(provisioned.length, 1);
    assert.equal(JSON.parse(provisioned[0]!.body).modelKeyRotatedFrom, '0123456789abcdef');
    assert.ok(!provisioned[0]!.body.includes(resumed.model.key!));

    // Delivered once: a repeat returns the descriptor without secrets and never rotates again.
    later(h);
    const repeat = (await h.make().provision(h.f.owner, h.request)).provisioning;
    assert.equal(repeat.model.key, undefined);
    assert.equal(repeat.connector.credential, undefined);
    assert.equal(repeat.model.keyId, 'fedcba9876543210');
    assert.deepEqual(h.modelvia.rotated, ['0123456789abcdef']);
    assert.equal(h.modelvia.projects.length, 2);
  } finally { h.close(); }
});

test('a lost project reply is resumed into that project and mints when it holds no key', async () => {
  const h = harness(); try {
    h.modelvia.lose = 'createProject';
    await assert.rejects(() => h.make().provision(h.f.owner, h.request), /modelvia_unreachable/);
    later(h);
    const resumed = (await h.make().provision(h.f.owner, h.request)).provisioning;
    assert.equal(resumed.model.key, MODEL_KEY);
    assert.deepEqual(h.modelvia.minted, [{ projectId: 'rb-install-one', label: `${h.f.tenant.companyId}:install-one` }]);
    assert.deepEqual(h.modelvia.rotated, []);
    // Adopted, not recreated; its caps are this tenant's.
    assert.equal(h.modelvia.held.size, 1);
    assert.deepEqual(h.modelvia.capUpdates, [{ projectId: 'rb-install-one', monthlyCapNanoAud: h.f.tenant.monthlyCapNanoAud,
      requestCapNanoAud: h.f.tenant.requestCapNanoAud, maxConcurrent: h.f.tenant.maxConcurrent }]);
  } finally { h.close(); }
});

test('a lost rotate reply rotates the replacement on the next resume', async () => {
  const h = harness(); try {
    h.modelvia.lose = 'mint';
    await assert.rejects(() => h.make().provision(h.f.owner, h.request));
    later(h); h.modelvia.lose = 'rotate';
    await assert.rejects(() => h.make().provision(h.f.owner, h.request), /modelvia_unreachable/);
    later(h);
    const resumed = (await h.make().provision(h.f.owner, h.request)).provisioning;
    assert.deepEqual(h.modelvia.rotated, ['0123456789abcdef', 'fedcba9876543210']);
    assert.deepEqual(live(h), ['00000000000000a3']);
    assert.equal(resumed.model.keyId, '00000000000000a3');
  } finally { h.close(); }
});

test('an existing project is adopted only when its keys can be attributed to this installation', async () => {
  const label = (h: ReturnType<typeof harness>) => `${h.f.tenant.companyId}:install-one`;
  const hold = (h: ReturnType<typeof harness>, keys: { label: string }[]) => {
    h.modelvia.held.set('rb-install-one', { projectId: 'rb-install-one', name: 'x', customerId: CUSTOMER, monthlyCapNanoAud: '1', requestCapNanoAud: '1', maxConcurrent: 1, active: true, environments: ['production'] });
    for (const key of keys) h.modelvia.keys.push({ keyId: KEY_IDS[h.modelvia.keys.length]!, projectId: 'rb-install-one', label: key.label });
  };
  // Two live keys: which one the desktop holds cannot be known.
  const two = harness(); try {
    hold(two, [{ label: label(two) }, { label: label(two) }]);
    await assert.rejects(() => two.make().provision(two.f.owner, two.request), /modelvia_keys_ambiguous/);
    assert.deepEqual(two.modelvia.rotated, []); assert.deepEqual(two.modelvia.minted, []); assert.deepEqual(live(two).length, 2);
  } finally { two.close(); }
  // One live key somebody else labelled is not ours to revoke by rotation.
  const foreign = harness(); try {
    hold(foreign, [{ label: 'company-other:install-one' }]);
    await assert.rejects(() => foreign.make().provision(foreign.f.owner, foreign.request), /modelvia_keys_ambiguous/);
    assert.deepEqual(foreign.modelvia.rotated, []); assert.deepEqual(foreign.modelvia.minted, []);
  } finally { foreign.close(); }
  // A project this ledger no longer records, holding our one labelled key: rotated.
  const orphan = harness(); try {
    hold(orphan, [{ label: label(orphan) }]);
    const result = (await orphan.make().provision(orphan.f.owner, orphan.request)).provisioning;
    assert.deepEqual(orphan.modelvia.rotated, ['0123456789abcdef']);
    assert.equal(result.model.keyId, 'fedcba9876543210');
  } finally { orphan.close(); }
  // A project under another customer is never adopted, and nothing is minted into it.
  const other = harness(); try {
    hold(other, []);
    other.modelvia.held.get('rb-install-one')!.customerId = 'cus-somebody-else';
    await assert.rejects(() => other.make().provision(other.f.owner, other.request), /modelvia_project_scope_mismatch/);
    assert.deepEqual(other.modelvia.minted, []); assert.deepEqual(other.modelvia.capUpdates, []);
  } finally { other.close(); }
});

test('a resume never takes over a connector device another attempt did not admit', async () => {
  const h = harness(); try {
    // A device with this id that this provisioning never journalled.
    h.modelvia.lose = 'mint';
    await assert.rejects(() => h.make().provision(h.f.owner, h.request));
    const row = h.f.ledger.db.get<{ body: string }>('SELECT body FROM installation_provisioning')!;
    const body = JSON.parse(row.body); delete body.deviceTokenHash;
    h.f.ledger.db.run('UPDATE installation_provisioning SET body=?', JSON.stringify(body));
    later(h);
    await assert.rejects(() => h.make().provision(h.f.owner, h.request), /connector_device_exists/);
    assert.deepEqual(h.modelvia.rotated, []);
    assert.equal(h.modelvia.projects.length, 1);
  } finally { h.close(); }
});

test('an attempt past its deadline stops before the key step and leaves it to a later resume', async () => {
  const h = harness(); try {
    h.modelvia.lose = 'mint';
    await assert.rejects(() => h.make().provision(h.f.owner, h.request));
    later(h);
    // This attempt stalls long enough that it must not start a key effect.
    const slow = h.make({ modelvia: { ...h.modelviaClient, async listKeys(projectId, environment) {
      h.f.setTime(h.f.now() + PENDING_RESUME_AFTER_MS / 2); return h.modelviaClient.listKeys(projectId, environment);
    } } });
    await assert.rejects(() => slow.provision(h.f.owner, h.request), /installation_provisioning_expired/);
    assert.deepEqual(h.modelvia.rotated, []);
    later(h);
    assert.equal((await h.make().provision(h.f.owner, h.request)).provisioning.model.keyId, 'fedcba9876543210');
  } finally { h.close(); }
});

test('of two concurrent resumes exactly one proceeds', async () => {
  const h = harness(); try {
    h.modelvia.lose = 'mint';
    await assert.rejects(() => h.make().provision(h.f.owner, h.request));
    later(h);
    const outcomes = await Promise.allSettled([h.make().provision(h.f.owner, h.request), h.make().provision(h.f.owner, h.request)]);
    assert.deepEqual(outcomes.map(outcome => outcome.status).sort(), ['fulfilled', 'rejected']);
    assert.match(String((outcomes.find(outcome => outcome.status === 'rejected') as PromiseRejectedResult).reason), /installation_provisioning_in_progress/);
    assert.deepEqual(h.modelvia.rotated, ['0123456789abcdef']);
    assert.equal(live(h).length, 1);
  } finally { h.close(); }
});

test('a cap change is pushed to every provisioned project, and a failed push is recorded and reported', async () => {
  const h = harness(); try {
    const provisioning = h.make();
    assert.deepEqual(await provisioning.syncCaps(h.f.owner), { state: 'none', projects: [] });
    await provisioning.provision(h.f.owner, h.request);
    const caps = { monthlyCapNanoAud: '50000000000', requestCapNanoAud: '500000000', maxConcurrent: 2 };
    h.f.ledger.setCaps(h.f.owner, caps);
    assert.deepEqual(await provisioning.syncCaps(h.f.owner), { state: 'synced', projects: [{ installationId: 'install-one', projectId: 'rb-install-one', state: 'synced' }] });
    assert.deepEqual(h.modelvia.capUpdates.at(-1), { projectId: 'rb-install-one', ...caps });
    assert.equal(h.modelvia.held.get('rb-install-one')!.monthlyCapNanoAud, '50000000000');

    h.modelvia.failCaps = true;
    h.f.ledger.setCaps(h.f.owner, { ...caps, monthlyCapNanoAud: '40000000000' });
    const failed = await provisioning.syncCaps(h.f.owner);
    assert.deepEqual(failed, { state: 'out_of_sync', projects: [{ installationId: 'install-one', projectId: 'rb-install-one', state: 'out_of_sync', error: 'modelvia_unreachable' }] });
    // The local change stands; the record says the project did not get it.
    assert.equal(h.f.ledger.tenant(h.f.tenant.companyId).monthlyCapNanoAud, '40000000000');
    const stored = JSON.parse(h.f.ledger.db.get<{ body: string }>('SELECT body FROM installation_provisioning')!.body);
    assert.equal(stored.modelviaCaps.state, 'out_of_sync');
    assert.equal(stored.modelviaCaps.monthlyCapNanoAud, '40000000000');
    const kinds = h.f.ledger.db.all<{ kind: string }>('SELECT kind FROM events').map(row => row.kind);
    assert.ok(kinds.includes('modelvia_caps_synced') && kinds.includes('modelvia_caps_out_of_sync'));
    await assert.rejects(() => provisioning.syncCaps({ ...h.f.owner, role: 'billing_reader' }), /forbidden/);
  } finally { h.close(); }
});

test('the project request cap is clamped to the monthly cap before it reaches Modelvia', async () => {
  const h = harness(); try {
    // A tenant whose per-request cap equals its monthly cap must not propose a
    // request cap above it: Modelvia rejects that with invalid_caps.
    h.f.ledger.setCaps(h.f.owner, { monthlyCapNanoAud: '1000000000', requestCapNanoAud: '1000000000', maxConcurrent: 2 });
    await h.make().provision(h.f.owner, h.request);
    const project = h.modelvia.projects[0] as { monthlyCapNanoAud: string; requestCapNanoAud: string; maxConcurrent: number };
    assert.equal(project.monthlyCapNanoAud, '1000000000');
    assert.equal(project.requestCapNanoAud, '1000000000');
    assert.equal(project.maxConcurrent, 2);
    assert.ok(BigInt(project.requestCapNanoAud) <= BigInt(project.monthlyCapNanoAud));
  } finally { h.close(); }
});

test('an existing project with no stored key, and a stored key with no project, both fail closed', async () => {
  const h = harness(); try {
    h.org.projects.push({ id: 'pr_existing', name: `realbud-${h.f.tenant.companyId}` });
    await assert.rejects(() => h.make().provision(h.f.owner, h.request), /connector_project_key_unavailable/);
    assert.deepEqual(h.org.created, []);

    const other = harness(); try {
      other.secrets.write(`REALBUD_COMPOSIO_PROJECT_${other.f.tenant.companyId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`, 'ak_fictional_orphan_key');
      await assert.rejects(() => other.make().provision(other.f.owner, other.request), /connector_project_key_orphaned/);
      assert.deepEqual(other.org.created, []);
    } finally { other.close(); }
  } finally { h.close(); }
});

test('revoke deactivates the device and the model key, and deletes the project only when asked', async () => {
  const h = harness(); try {
    await h.make().provision(h.f.owner, h.request);
    const kept = await h.make().revoke(h.f.owner, { companyId: h.f.tenant.companyId, installationId: 'install-one' });
    assert.deepEqual(kept.revoked, { companyId: h.f.tenant.companyId, installationId: 'install-one', connectorDeactivated: true, modelKeyRevoked: true, modelKeyId: '0123456789abcdef', modelProjectRetained: 'rb-install-one', projectDeleted: false });
    assert.equal(h.devices()[0]!.active, false);
    assert.deepEqual(h.modelvia.revoked, ['0123456789abcdef']);
    assert.deepEqual(h.org.deleted, []);
    // Repeat revoke returns the recorded outcome; no second irreversible act.
    const again = await h.make().revoke(h.f.owner, { companyId: h.f.tenant.companyId, installationId: 'install-one' });
    assert.deepEqual(again.revoked, kept.revoked);
    assert.deepEqual(h.modelvia.revoked, ['0123456789abcdef']);
    // Exactly one audit line for the revocation, with no secret in it.
    const lines = h.f.ledger.db.all<{ kind: string; body: string }>('SELECT kind,body FROM events').filter(row => row.kind === 'installation_revoked');
    assert.equal(lines.length, 1);
    assert.ok(!lines[0]!.body.includes(MODEL_KEY) && !lines[0]!.body.includes(PROJECT_KEY));
    // A provisioned installation cannot be silently re-provisioned after revocation.
    await assert.rejects(() => h.make().provision(h.f.owner, h.request), /installation_revoked/);
  } finally { h.close(); }
});

test('explicit deleteProject removes the Composio project and the stored project key', async () => {
  const h = harness(); try {
    await h.make().provision(h.f.owner, h.request);
    const keyEnv = `REALBUD_COMPOSIO_PROJECT_${h.f.tenant.companyId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    const result = await h.make().revoke(h.f.owner, { companyId: h.f.tenant.companyId, installationId: 'install-one', deleteProject: true });
    assert.equal(result.revoked.projectDeleted, true);
    assert.equal(result.revoked.revokeJobId, 'job-fictional');
    assert.deepEqual(h.org.deleted, ['pr_1']);
    assert.equal(h.secrets.read(keyEnv), undefined);
  } finally { h.close(); }
});

test('revoke refuses another company, an unknown installation and a non-boolean deleteProject', async () => {
  const h = harness(); try {
    await h.make().provision(h.f.owner, h.request);
    await assert.rejects(() => h.make().revoke({ ...h.f.owner, role: 'billing_reader' }, { companyId: h.f.tenant.companyId, installationId: 'install-one' }), /forbidden/);
    await assert.rejects(() => h.make().revoke(h.f.owner, { companyId: 'company-other', installationId: 'install-one' }), /company_scope_mismatch/);
    await assert.rejects(() => h.make().revoke(h.f.owner, { companyId: h.f.tenant.companyId, installationId: 'install-absent' }), /installation_not_provisioned/);
    await assert.rejects(() => h.make().revoke(h.f.owner, { companyId: h.f.tenant.companyId, installationId: 'install-one', deleteProject: 'yes' }), /invalid_fields/);
    assert.equal(h.devices()[0]!.active, true);
    assert.deepEqual(h.org.deleted, []); assert.deepEqual(h.modelvia.revoked, []);
  } finally { h.close(); }
});

test('the env resolver fails closed, names only the missing variable, and never a value', async () => {
  const h = harness(); try {
    const secret = 'fictional-org-key-value-must-not-appear';
    const full: NodeJS.ProcessEnv = {
      REALBUD_ENABLE_PROVIDER: '1',
      REALBUD_GATEWAY_SECRETS_DIR: h.secretsDir, REALBUD_GATEWAY_CONNECTOR_REGISTRY: h.registry,
      REALBUD_GATEWAY_PUBLIC_ORIGIN: 'https://managed.example.invalid',
      REALBUD_COMPOSIO_ORG_KEY: secret, REALBUD_COMPOSIO_AUTH_CONFIG_GMAIL: 'ac-fictional-readonly',
      REALBUD_MODELVIA_BASE_URL: 'https://api.modelvia.dev', REALBUD_MODELVIA_OPERATOR_SECRET: 'fictional-operator-secret-of-32-chars',
      REALBUD_MODELVIA_OPERATOR_SUBJECT: 'realbud-provisioning',
      REALBUD_MODELVIA_CLIENT_ID: 'realbud',
    };
    const never: HttpTransport = async () => { throw new Error('the resolver must not call out'); };
    const resolve = (env: NodeJS.ProcessEnv) => composeProvisioning({ env, ledger: h.f.ledger, fetch: never });

    assert.deepEqual(resolve({ ...full, REALBUD_ENABLE_PROVIDER: undefined }), { unavailable: 'provisioning_disabled' });
    assert.deepEqual(resolve({ ...full, REALBUD_ENABLE_PROVIDER: '0' }), { unavailable: 'provisioning_disabled' });
    for (const name of PROVISIONING_ENV) {
      for (const blank of [undefined, '', '   ']) {
        const result = resolve({ ...full, [name]: blank });
        assert.deepEqual(result, { unavailable: `provisioning_unconfigured:${name}` }, `${name} = ${JSON.stringify(blank)}`);
      }
    }
    // A malformed value is reported by code, and the value itself never appears.
    for (const broken of [{ REALBUD_GATEWAY_PUBLIC_ORIGIN: `http://${secret}.invalid` }, { REALBUD_MODELVIA_BASE_URL: `https://${secret}.invalid/v1` }, { REALBUD_MODELVIA_CLIENT_ID: `${secret} bad id` }, { REALBUD_MODELVIA_MODELS: ' , ' }, { REALBUD_MODELVIA_OPERATOR_SECRET: 'short' },
      { REALBUD_GATEWAY_SECRETS_DIR: `relative/${secret}` }, { REALBUD_MODELVIA_ENVIRONMENT: secret }]) {
      const result = resolve({ ...full, ...broken }) as { unavailable: string };
      assert.match(result.unavailable, /^provisioning_unconfigured:/);
      assert.ok(!result.unavailable.includes(secret), `reason leaked a value: ${result.unavailable}`);
    }
    const composed = resolve(full);
    assert.ok('provisioning' in composed);
    // Composition alone makes no provider call; the transport above would throw.
    const result = await (composed as { provisioning: InstallationProvisioning }).provisioning
      .provision(h.f.owner, h.request).then(() => 'called out', error => (error as Error).message);
    assert.equal(result, 'composio_unreachable');
  } finally { h.close(); }
});

test('the HTTP portal route provisions once, is unavailable when unconfigured, and leaks nothing on failure', async () => {
  const h = harness();
  const provisioning = h.make();
  const portal = { async authenticate(token: string) { if (token !== 'fictional-portal-token') throw new Error('no'); return h.f.owner; } };
  const server = createGatewayServer({ gateway: h.f.gateway(), billing: h.f.billing, allowedOrigins: new Set(), portal, provisioning });
  const bare = createGatewayServer({ gateway: h.f.gateway(), billing: h.f.billing, allowedOrigins: new Set(), portal });
  const misconfigured = createGatewayServer({ gateway: h.f.gateway(), billing: h.f.billing, allowedOrigins: new Set(), portal,
    provisioningUnavailable: 'provisioning_unconfigured:REALBUD_COMPOSIO_ORG_KEY' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  await new Promise<void>(resolve => bare.listen(0, '127.0.0.1', resolve));
  await new Promise<void>(resolve => misconfigured.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const bareBase = `http://127.0.0.1:${(bare.address() as { port: number }).port}`;
  const misconfiguredBase = `http://127.0.0.1:${(misconfigured.address() as { port: number }).port}`;
  const headers = { authorization: 'Bearer fictional-portal-token', 'content-type': 'application/json' };
  const post = (origin: string, path: string, body: unknown, extra: Record<string, string> = {}) =>
    fetch(`${origin}${path}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  try {
    // /ready is the platform health check: 200 only when provisioning is composed.
    const readyOk = await fetch(`${base}/ready`);
    assert.equal(readyOk.status, 200);
    assert.deepEqual(await readyOk.json(), { ready: true, provisioning: 'composed' });
    const readyBare = await fetch(`${bareBase}/ready`);
    assert.equal(readyBare.status, 503);
    assert.deepEqual(await readyBare.json(), { ready: false, error: 'provisioning_unavailable' });
    const readyNamed = await fetch(`${misconfiguredBase}/ready`);
    assert.equal(readyNamed.status, 503);
    assert.deepEqual(await readyNamed.json(), { ready: false, error: 'provisioning_unconfigured:REALBUD_COMPOSIO_ORG_KEY' });

    const unconfigured = await post(bareBase, '/v1/portal/installations/provision', h.request);
    assert.equal(unconfigured.status, 503);
    assert.deepEqual(await unconfigured.json(), { error: 'provisioning_unavailable' });
    // A misconfigured deployment names the variable to set, not its value.
    const named = await post(misconfiguredBase, '/v1/portal/installations/provision', h.request);
    assert.equal(named.status, 503);
    assert.deepEqual(await named.json(), { error: 'provisioning_unconfigured:REALBUD_COMPOSIO_ORG_KEY' });
    assert.equal((await fetch(`${base}/v1/portal/installations/provision`, { method: 'POST', body: '{}' })).status, 401);
    const denied = await post(base, '/v1/portal/installations/provision', { ...h.request, companyId: 'company-other' });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: 'company_scope_mismatch' });

    const created = await post(base, '/v1/portal/installations/provision', h.request);
    assert.equal(created.status, 200);
    const payload = await created.json() as { provisioning: ProvisioningDescriptor };
    assert.match(payload.provisioning.connector.credential!, /^rbc_[a-f0-9]{64}$/);

    const repeat = await post(base, '/v1/portal/installations/provision', h.request);
    const repeated = await repeat.json() as { provisioning: ProvisioningDescriptor };
    assert.equal(repeated.provisioning.connector.credential, undefined);
    assert.equal(repeated.provisioning.model.key, undefined);
    assert.equal(h.modelvia.minted.length, 1);

    assert.equal((await post(base, '/v1/portal/installations/revoke', { companyId: h.f.tenant.companyId, installationId: 'install-one' })).status, 200);
    assert.equal(h.devices()[0]!.active, false);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise<void>(resolve => bare.close(() => resolve()));
    await new Promise<void>(resolve => misconfigured.close(() => resolve()));
    h.close();
  }
});
