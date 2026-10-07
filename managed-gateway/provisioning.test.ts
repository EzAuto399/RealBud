import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture } from './testing.ts';
import { LedgerDatabase } from './database.ts';
import { UsageLedger } from './ledger.ts';
import { createGatewayServer } from './http.ts';
import { ManagedConnectors, validateConnectorDevices } from './connectors.ts';
import { bindOfficeCustomer, composeProvisioning, DEFAULT_REQUEST_CAP_NANO_AUD, fileSecretStore, InstallationProvisioning, nodeIo, PENDING_RESUME_AFTER_MS, projectCaps, PROVISIONING_ENV, SPEND_CAP_LABEL_MAX, spendCapLabel, updateRegistry, type DurableIo, type ProvisioningDescriptor } from './provisioning.ts';
import type { ComposioOrgClient, HttpTransport } from './composio-org.ts';
import { ModelviaRotationRefused, type ModelviaCaps, type ModelviaClient, type ModelviaCustomer, type ModelviaProjectInput } from './modelvia-keys.ts';
import { GatewayError } from './contracts.ts';
import { ComposioTriggers, triggerSpec } from './composio-triggers.ts';

const ORG_KEY = 'fictional-org-key-never-in-a-response';
const PROJECT_KEY = 'ak_fictional_project_key_for_tests';
const MODEL_KEY = `rbk_0123456789abcdef_${'A'.repeat(43)}`;
const CUSTOMER = 'cus-fictional-office';
/** Key ids the fake hands out in order; the first matches MODEL_KEY. */
const KEY_IDS = ['0123456789abcdef', 'fedcba9876543210', '00000000000000a3', '00000000000000b4'];
const synthetic = (keyId: string) => `rbk_${keyId}_${(keyId === KEY_IDS[0] ? 'A' : 'B').repeat(43)}`;
/** The office's Modelvia customer as the fake holds it. Deliberately different
 * from the fixture tenant's stored ledger caps, which must drive nothing. */
const CUSTOMER_CAPS = { monthlyCapNanoAud: '70000000000', maxConcurrent: 3 };
/** The request cap is the default A$4, below the customer's monthly cap. */
const PROJECT_CAPS = { monthlyCapNanoAud: '70000000000', requestCapNanoAud: '4000000000', maxConcurrent: 3 };
const SPEND_LABEL = 'A$70/month, A$4/request, 3 at once';

function harness(persistent = false, bound = true) {
  const root = mkdtempSync(join(tmpdir(), 'realbud-provisioning-'));
  const databasePath = persistent ? join(root, 'gateway.db') : ':memory:';
  const f = fixture(databasePath);
  // The operator binding the office AI access route records; fail-closed without it.
  if (bound) bindOfficeCustomer(f.ledger, f.tenant.companyId, CUSTOMER);
  let ledger = f.ledger;
  const registry = join(root, 'registry', 'devices.json'), secretsDir = join(root, 'secrets');
  const org = { created: [] as string[], deleted: [] as string[], projects: [] as { id: string; name: string }[], orgKeyReads: 0 };
  /** A stateful stand-in for Modelvia: what it holds survives a lost reply,
   * which is the whole point of the recovery it exercises. `lose` performs the
   * named effect and then throws, as a reply lost on the wire would. */
  const modelvia = { projects: [] as unknown[], minted: [] as unknown[], revoked: [] as string[], rotated: [] as string[], capUpdates: [] as unknown[],
    held: new Map<string, ModelviaProjectInput & { active: boolean; environments: string[] }>(),
    keys: [] as { keyId: string; projectId: string; label: string; revokedAt?: number }[],
    lose: undefined as undefined | 'createProject' | 'mint' | 'rotate',
    customer: { active: true, ...CUSTOMER_CAPS } as ModelviaCustomer | null, customerReads: 0 };
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
    async findCustomer(customerId) { modelvia.customerReads++; return customerId === CUSTOMER && modelvia.customer ? { ...modelvia.customer } : null; },
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
      const old = modelvia.keys.find(key => key.keyId === keyId);
      if (!old) throw new GatewayError('modelvia_rejected', 502);
      if (old.revokedAt) throw new ModelviaRotationRefused();
      modelvia.rotated.push(keyId); old.revokedAt = 1;
      const key = issue(old.projectId, old.label); lost('rotate');
      return { ...key, projectId: old.projectId, replaced: keyId };
    },
    async revoke(keyId) {
      modelvia.revoked.push(keyId);
      const key = modelvia.keys.find(key => key.keyId === keyId);
      if (key) key.revokedAt ??= 1;
    },
    async updateProjectCaps(projectId, caps: ModelviaCaps) {
      modelvia.capUpdates.push({ projectId, ...caps });
      const held = modelvia.held.get(projectId)!;
      const updated = held.monthlyCapNanoAud !== caps.monthlyCapNanoAud || held.requestCapNanoAud !== caps.requestCapNanoAud || held.maxConcurrent !== caps.maxConcurrent;
      Object.assign(held, caps);
      return { updated, version: 2 };
    },
  };
  const secrets = fileSecretStore(secretsDir);
  const make = (overrides: Partial<ConstructorParameters<typeof InstallationProvisioning>[0]> = {}) => new InstallationProvisioning({
    ledger, registry, endpoint: 'https://managed.example.invalid', secrets,
    org: orgClient, modelvia: modelviaClient, authConfigs: { resolveGmail: async () => 'ac-fictional-readonly' }, ...overrides,
  });
  const request = { companyId: f.tenant.companyId, installationId: 'install-one', customerId: CUSTOMER, profile: 'property' };
  return { f, root, registry, secretsDir, secrets, org, modelvia, orgClient, modelviaClient, make, request,
    devices: () => validateConnectorDevices(JSON.parse(readFileSync(registry, 'utf8'))),
    record: () => JSON.parse(ledger.db.get<{ body: string }>('SELECT body FROM installation_provisioning WHERE tenant=? AND installation=?', request.companyId, request.installationId)!.body),
    restart: () => { assert.ok(persistent); ledger.db.close(); ledger = new UsageLedger(new LedgerDatabase(databasePath), f.now); },
    close: () => { ledger.db.close(); rmSync(root, { recursive: true, force: true }); } };
}

function pause() {
  let resume!: () => void;
  const reached = new Promise<void>(resolve => { resume = resolve; });
  return { reached, resume };
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
    // from that customer: its monthly cap and concurrency, with the default request cap.
    assert.equal(provisioning.model.projectId, 'rb-install-one');
    assert.deepEqual(h.modelvia.projects, [{ projectId: 'rb-install-one', name: 'RealBud installation install-one', customerId: CUSTOMER, ...PROJECT_CAPS }]);
    assert.deepEqual(h.modelvia.minted, [{ projectId: 'rb-install-one', label: `${h.f.tenant.companyId}:install-one` }]);
    assert.equal(provisioning.model.spendCapLabel, SPEND_LABEL);
    assert.equal(h.modelvia.customerReads, 1);

    const second = await h.make().provision(h.f.owner, h.request);
    assert.equal(second.provisioning.connector.credential, undefined);
    assert.equal(second.provisioning.model.key, undefined);
    assert.deepEqual(second.provisioning.service, provisioning.service);
    assert.equal(second.provisioning.model.keyId, provisioning.model.keyId);
    assert.equal(second.provisioning.connector.projectId, 'pr_1');
    assert.equal(second.provisioning.model.projectId, 'rb-install-one');
    assert.equal(h.modelvia.projects.length, 1);
    // A delivered installation's repeat asks Modelvia nothing, not even the customer.
    assert.equal(h.modelvia.customerReads, 1);
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
    assert.equal(h.org.orgKeyReads, 0); assert.equal(h.modelvia.minted.length, 0); assert.equal(h.modelvia.customerReads, 0);
    assert.equal(existsSync(h.registry), false);
  } finally { h.close(); }
});

test('a malformed app list is refused before any external call; any toolkit slug is recorded for on-demand admission', async () => {
  const h = harness(); try {
    for (const apps of [['gmail', 'gmail'], [], 'gmail', ['Slack'], ['../gmail'], [1]]) {
      await assert.rejects(() => h.make().provision(h.f.owner, { ...h.request, apps }));
    }
    assert.equal(h.org.orgKeyReads, 0); assert.equal(h.modelvia.minted.length, 0);
    // No fixed app set: the office decides later, app by app, by asking Bud.
    const first = await h.make().provision(h.f.owner, { ...h.request, apps: ['gmail', 'slack'] });
    assert.deepEqual(first.provisioning.connector.apps, ['gmail', 'slack']);
    assert.deepEqual(h.devices()[0]!.apps, ['gmail', 'slack']);
    // A repeat naming another list is not a conflict: the recorded list stands.
    const repeat = await h.make().provision(h.f.owner, { ...h.request, apps: ['xero'] });
    assert.deepEqual(repeat.provisioning.connector.apps, ['gmail', 'slack']);
    assert.equal(repeat.provisioning.connector.credential, undefined);
    assert.equal(h.modelvia.minted.length, 1);
    // The office project path is idempotent on its own.
    const ensured = await h.make().ensureOfficeProject(h.request.companyId);
    assert.equal(ensured.projectId, first.provisioning.connector.projectId);
    assert.equal(h.org.created.length, 1);
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
    // Adopted, not recreated; its caps are the customer's.
    assert.equal(h.modelvia.held.size, 1);
    assert.deepEqual(h.modelvia.capUpdates, [{ projectId: 'rb-install-one', ...PROJECT_CAPS }]);
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

test('a lost reply after ready is redelivered: the one key is rotated and the connector credential replaced, nothing new created', async () => {
  const h = harness(); try {
    // The secret-bearing reply is delivered here and then lost on the way to the desktop.
    const lost = (await h.make().provision(h.f.owner, h.request)).provisioning;
    const lostHash = h.devices()[0]!.tokenHash;
    // A plain repeat still delivers nothing and rotates nothing.
    assert.equal((await h.make().provision(h.f.owner, h.request)).provisioning.model.key, undefined);
    assert.deepEqual(h.modelvia.rotated, []);

    const again = (await h.make().provision(h.f.owner, { ...h.request, redeliver: true })).provisioning;
    assert.deepEqual(h.modelvia.rotated, [lost.model.keyId]);
    assert.deepEqual(live(h), ['fedcba9876543210']);
    assert.equal(again.model.key, synthetic('fedcba9876543210'));
    assert.equal(again.model.keyId, 'fedcba9876543210');
    assert.match(again.connector.credential!, /^rbc_[a-f0-9]{64}$/);
    assert.notEqual(again.connector.credential, lost.connector.credential);
    // Same device, new hash: the undelivered credential no longer authenticates.
    assert.equal(h.devices().length, 1);
    assert.notEqual(h.devices()[0]!.tokenHash, lostHash);
    assert.equal(h.modelvia.minted.length, 1); assert.equal(h.modelvia.projects.length, 1);
    assert.deepEqual(h.org.created, [`realbud-${h.f.tenant.companyId}`]);
    assert.deepEqual({ ...again, connector: { ...again.connector, credential: undefined }, model: { ...again.model, key: undefined } },
      { ...lost, connector: { ...lost.connector, credential: undefined }, model: { ...lost.model, keyId: 'fedcba9876543210', key: undefined } });
    // The stored record follows the rotation, so a later revoke reaches the live key.
    const repeat = (await h.make().provision(h.f.owner, h.request)).provisioning;
    assert.equal(repeat.model.keyId, 'fedcba9876543210'); assert.equal(repeat.model.key, undefined);
    const events = h.f.ledger.db.all<{ kind: string; body: string }>('SELECT kind,body FROM events');
    const redelivered = events.filter(row => row.kind === 'installation_credentials_redelivered');
    assert.equal(redelivered.length, 1);
    assert.deepEqual(JSON.parse(redelivered[0]!.body), { installationId: 'install-one', modelKeyId: 'fedcba9876543210', modelKeyRotatedFrom: '0123456789abcdef' });
    const everything = events.map(row => row.body).join('\n') + h.f.ledger.db.get<{ body: string }>('SELECT body FROM installation_provisioning')!.body;
    for (const secret of [PROJECT_KEY, ORG_KEY, again.model.key!, again.connector.credential!, lost.model.key!]) assert.ok(!everything.includes(secret));
    assert.ok(!JSON.stringify(again).includes('ak_'));
    await h.make().revoke(h.f.owner, { companyId: h.f.tenant.companyId, installationId: 'install-one' });
    assert.deepEqual(h.modelvia.revoked, ['fedcba9876543210']);
  } finally { h.close(); }
});

test('an office Gmail grant follows its installation through redelivery, never through revoke, a mode change or another office', async () => {
  const h = harness(); try {
    const first = (await h.make().provision(h.f.owner, h.request)).provisioning;
    const company = h.f.tenant.companyId, account = 'shared-account-fictional';
    const connectors = new ManagedConnectors({ ledger: h.f.ledger, devices: () => h.devices(), secret: () => PROJECT_KEY,
      authorize: async () => ({ url: 'https://connect.example.invalid/oauth', accountId: account, expiresAt: new Date(h.f.now() + 60_000).toISOString() }),
      access: async () => ({ checkedAt: '', services: { gmail: { connected: true, status: 'ACTIVE', accounts: [{ id: account, status: 'ACTIVE' }], accountSelectionRequired: false } }, tools: { available: true, names: [] } }),
      transport: () => ({ async request() { return { content: [{ type: 'text', text: JSON.stringify({ accountId: account, emailAddress: 'office@example.invalid' }) }] }; } }) });
    const mailbox = connectors.officeMailbox, call = (op: string, body?: unknown) => mailbox.handle(h.f.owner, op, body, async () => {});
    const status = (token: string) => connectors.handle({ token, profile: 'property', method: 'GET', path: '/v1/connectors/status', policyRevision: mailbox.policy(company).revision, signal: new AbortController().signal });
    await call('policy', { mode: 'shared', expectedRevision: 0 }); await call('authorize', { expectedRevision: 1 });
    const review = await call('verify', { expectedRevision: 1 }) as { candidate: { accountId: string; emailAddress: string } };
    await call('confirm', { expectedRevision: 2, ...review.candidate });
    await call('grants', { expectedRevision: 3, installationId: 'install-one', allowed: true });
    assert.equal(((await status(first.connector.credential!)).body as { sourceKind: string }).sourceKind, 'office_shared');

    const again = (await h.make().provision(h.f.owner, { ...h.request, redeliver: true })).provisioning;
    // The old credential is dead; the new one still has the office mailbox, with no new revision to review.
    await assert.rejects(() => status(first.connector.credential!), /connector_access_denied/);
    const shared = (await status(again.connector.credential!)).body as { sourceKind: string; services: { gmail: { connected: boolean } } };
    assert.equal(shared.sourceKind, 'office_shared'); assert.equal(shared.services.gmail.connected, true);
    assert.equal(mailbox.policy(company).revision, 4); assert.equal(mailbox.policy(company).grants.length, 1);
    assert.ok(mailbox.readyForDevice(h.devices()[0]!));
    // Another office never matches, even with the same installation id and credential.
    assert.equal(mailbox.readyForDevice({ ...h.devices()[0]!, companyId: 'company-other' }), false);

    await h.make().revoke(h.f.owner, { companyId: company, installationId: 'install-one' });
    await assert.rejects(() => status(again.connector.credential!), /connector_access_denied/);
    assert.deepEqual((await call('status') as { installations: unknown[] }).installations, [{ installationId: 'install-one', active: false, allowed: false }]);
    await call('policy', { mode: 'personal', expectedRevision: 4 });
    assert.deepEqual(mailbox.policy(company).grants, []);
  } finally { h.close(); }
});

test('of two concurrent redeliveries exactly one rotates; another office, a revoked installation and a bad flag get nothing', async () => {
  const h = harness(); try {
    await h.make().provision(h.f.owner, h.request);
    const ask = () => h.make().provision(h.f.owner, { ...h.request, redeliver: true });
    const outcomes = await Promise.allSettled([ask(), ask()]);
    assert.deepEqual(outcomes.map(outcome => outcome.status).sort(), ['fulfilled', 'rejected']);
    assert.match(String((outcomes.find(outcome => outcome.status === 'rejected') as PromiseRejectedResult).reason), /installation_provisioning_in_progress/);
    assert.deepEqual(h.modelvia.rotated, ['0123456789abcdef']);
    assert.equal(live(h).length, 1);

    await assert.rejects(() => h.make().provision({ ...h.f.owner, companyId: 'company-other' }, { ...h.request, redeliver: true }), /company_scope_mismatch/);
    await assert.rejects(() => h.make().provision(h.f.owner, { ...h.request, redeliver: false }), /invalid_fields/);
    await h.make().revoke(h.f.owner, { companyId: h.f.tenant.companyId, installationId: 'install-one' });
    await assert.rejects(ask, /installation_revoked/);
    assert.deepEqual(h.modelvia.rotated, ['0123456789abcdef']);
  } finally { h.close(); }
});

test('a redelivery whose rotate reply is lost is taken over later and rotates the replacement', async () => {
  const h = harness(); try {
    await h.make().provision(h.f.owner, h.request);
    h.modelvia.lose = 'rotate';
    await assert.rejects(() => h.make().provision(h.f.owner, { ...h.request, redeliver: true }), /modelvia_unreachable/);
    await assert.rejects(() => h.make().provision(h.f.owner, { ...h.request, redeliver: true }), /installation_provisioning_in_progress/);
    later(h);
    const again = (await h.make().provision(h.f.owner, { ...h.request, redeliver: true })).provisioning;
    assert.deepEqual(h.modelvia.rotated, ['0123456789abcdef', 'fedcba9876543210']);
    assert.deepEqual(live(h), ['00000000000000a3']);
    assert.equal(again.model.keyId, '00000000000000a3');
    assert.equal(h.record().pendingRotations.length, 1);
    const removed = await h.make().revoke(h.f.owner, { companyId: h.request.companyId, installationId: h.request.installationId });
    assert.equal(removed.revoked.modelKeyRevoked, true);
    assert.equal(h.record().state, 'revoked');
    assert.deepEqual(h.record().pendingRotations, []);
    assert.deepEqual(live(h), []);
  } finally { h.close(); }
});

test('a fenced listing revokes the successor before a delayed rotation response returns', async () => {
  const h = harness(); try {
    await h.make().provision(h.f.owner, h.request);
    const racing = h.make({ modelvia: { ...h.modelviaClient, async rotate(keyId) {
      const rotated = await h.modelviaClient.rotate(keyId);
      assert.equal((await h.make().revoke(h.f.owner, { companyId: h.f.tenant.companyId, installationId: 'install-one' })).revoked.modelKeyRevoked, true);
      assert.equal(h.record().state, 'revoked');
      assert.deepEqual(live(h), []);
      return rotated;
    } } });
    await assert.rejects(() => racing.provision(h.f.owner, { ...h.request, redeliver: true }), /installation_provisioning_superseded/);
    // Reconciliation already confirmed both keys. The late reply must not
    // reopen cleanup or make an additional compensation request.
    assert.deepEqual(h.modelvia.revoked, ['0123456789abcdef', 'fedcba9876543210']);
    assert.equal(h.devices()[0]!.active, false);
    assert.deepEqual(live(h), []);
    assert.equal(h.record().state, 'revoked');
    assert.deepEqual(h.record().cleanupKeyIds, []);
    const removed = await h.make().revoke(h.f.owner, { companyId: h.request.companyId, installationId: h.request.installationId });
    assert.equal(removed.revoked.modelKeyRevoked, true);
    assert.deepEqual(removed.revoked.modelKeyIds, ['0123456789abcdef', 'fedcba9876543210']);
  } finally { h.close(); }
});

test('redelivery returning while predecessor revoke waits cannot deliver or overwrite the revocation claim', async () => {
  const h = harness(), rotated = pause(), releaseRotation = pause(), revoking = pause(), releaseRevoke = pause();
  try {
    await h.make().provision(h.f.owner, h.request);
    const service = h.make({ modelvia: { ...h.modelviaClient,
      async rotate(keyId) {
        const result = await h.modelviaClient.rotate(keyId);
        rotated.resume(); await releaseRotation.reached; return result;
      },
      async revoke(keyId) {
        if (keyId === KEY_IDS[0]) { revoking.resume(); await releaseRevoke.reached; }
        return h.modelviaClient.revoke(keyId);
      },
    } });
    const delivery = assert.rejects(service.provision(h.f.owner, { ...h.request, redeliver: true }), /installation_provisioning_superseded/);
    await rotated.reached;
    const removal = service.revoke(h.f.owner, { companyId: h.request.companyId, installationId: h.request.installationId });
    await revoking.reached;
    assert.equal(h.record().state, 'revoking');
    assert.equal(h.record().revocation, undefined);
    await assert.rejects(() => h.make().provision(h.f.owner, { ...h.request, redeliver: true }), /installation_revoked/);
    await assert.rejects(() => h.make().revoke(h.f.owner, { companyId: h.request.companyId, installationId: h.request.installationId }), /installation_revocation_in_progress/);
    releaseRotation.resume(); await delivery;
    releaseRevoke.resume();
    assert.equal((await removal).revoked.modelKeyRevoked, true);
    assert.deepEqual(live(h), []);
    assert.equal(h.record().state, 'revoked');
    assert.deepEqual(h.record().revocationWork.keyIds, KEY_IDS.slice(0, 2));
    assert.ok(!JSON.stringify(h.record()).includes(synthetic(KEY_IDS[1]!)));
  } finally { releaseRotation.resume(); releaseRevoke.resume(); h.close(); }
});

test('a late superseded rotation reply does not reopen an intermediate key confirmed revoked in the listing', async () => {
  const h = harness(), rotated = pause(), release = pause();
  try {
    await h.make().provision(h.f.owner, h.request);
    const delayed = h.make({ modelvia: { ...h.modelviaClient, async rotate(keyId) {
      const result = await h.modelviaClient.rotate(keyId);
      rotated.resume(); await release.reached; return result;
    } } });
    const rejected = assert.rejects(delayed.provision(h.f.owner, { ...h.request, redeliver: true }), /installation_provisioning_superseded/);
    await rotated.reached; later(h);
    const replacement = await h.make().provision(h.f.owner, { ...h.request, redeliver: true });
    assert.equal(replacement.provisioning.model.keyId, KEY_IDS[2]);
    await h.make().revoke(h.f.owner, { companyId: h.request.companyId, installationId: h.request.installationId });
    assert.equal(h.record().state, 'revoked');
    assert.ok(h.record().revocationWork.revokedKeyIds.includes(KEY_IDS[1]));
    const revoked = [...h.modelvia.revoked];
    release.resume(); await rejected;
    assert.equal(h.record().state, 'revoked');
    assert.deepEqual(h.record().cleanupKeyIds, []);
    assert.deepEqual(h.modelvia.revoked, revoked);
    assert.deepEqual(live(h), []);
  } finally { release.resume(); h.close(); }
});

test('failed successor compensation keeps its identifier and revoking state across a database restart', async () => {
  const h = harness(true);
  try {
    await h.make().provision(h.f.owner, h.request);
    const service = h.make({ modelvia: { ...h.modelviaClient,
      async rotate(keyId) {
        const result = await h.modelviaClient.rotate(keyId);
        const failedListing = h.make({ modelvia: { ...h.modelviaClient, async listKeys() { throw new GatewayError('modelvia_unreachable', 502); } } });
        await assert.rejects(() => failedListing.revoke(h.f.owner, { companyId: h.request.companyId, installationId: h.request.installationId }), /modelvia_unreachable/);
        return result;
      },
      async revoke() { throw new GatewayError('modelvia_unreachable', 502); },
    } });
    await assert.rejects(() => service.provision(h.f.owner, { ...h.request, redeliver: true }), /installation_provisioning_superseded/);
    assert.deepEqual(h.record().cleanupKeyIds, [KEY_IDS[1]]);
    assert.deepEqual(h.record().pendingRotations, []);
    assert.equal(h.record().revocation, undefined);
    assert.deepEqual(live(h), [KEY_IDS[1]]);
    h.restart();
    assert.equal(h.record().state, 'revoking');
    await assert.rejects(() => h.make().provision(h.f.owner, h.request), /installation_revoked/);
    const removed = await h.make().revoke(h.f.owner, { companyId: h.request.companyId, installationId: h.request.installationId });
    assert.equal(removed.revoked.modelKeyRevoked, true);
    assert.deepEqual(removed.revoked.modelKeyIds, KEY_IDS.slice(0, 2));
    assert.deepEqual(live(h), []);
    assert.deepEqual(h.record().cleanupKeyIds, []);
  } finally { h.close(); }
});

test('a predecessor fence completes cleanup before a delayed rotation is refused', async () => {
  const h = harness(true);
  try {
    await h.make().provision(h.f.owner, h.request);
    const entered = pause(), release = pause();
    const service = h.make({ modelvia: { ...h.modelviaClient, async rotate(keyId) {
      entered.resume(); await release.reached;
      return h.modelviaClient.rotate(keyId);
    } } });
    const redelivery = service.provision(h.f.owner, { ...h.request, redeliver: true });
    const rejected = assert.rejects(redelivery, error => error instanceof ModelviaRotationRefused);
    await entered.reached;
    assert.equal((await h.make().revoke(h.f.owner, { companyId: h.request.companyId, installationId: h.request.installationId })).revoked.modelKeyRevoked, true);
    assert.equal(h.record().state, 'revoked');
    release.resume(); await rejected;
    assert.deepEqual(h.record().pendingRotations, []);
    assert.equal(h.record().redelivery, undefined);
    h.restart();
    assert.equal((await h.make().revoke(h.f.owner, { companyId: h.request.companyId, installationId: h.request.installationId })).revoked.modelKeyRevoked, true);
    assert.deepEqual(h.modelvia.rotated, []);
    assert.deepEqual(live(h), []);
  } finally { h.close(); }
});

test('a lost rotation response is cleaned up automatically after fencing its predecessor', async () => {
  const h = harness(true);
  try {
    await h.make().provision(h.f.owner, h.request);
    h.modelvia.lose = 'rotate';
    await assert.rejects(() => h.make().provision(h.f.owner, { ...h.request, redeliver: true }), /modelvia_unreachable/);
    h.restart();
    let fencedListing = false;
    const service = h.make({ modelvia: { ...h.modelviaClient, async listKeys(project, environment) {
      assert.deepEqual(h.modelvia.revoked, [KEY_IDS[0]]);
      fencedListing = true;
      return h.modelviaClient.listKeys(project, environment);
    } } });
    assert.equal((await service.revoke(h.f.owner, { companyId: h.request.companyId, installationId: h.request.installationId })).revoked.modelKeyRevoked, true);
    assert.equal(fencedListing, true);
    assert.deepEqual(h.modelvia.revoked, KEY_IDS.slice(0, 2));
    assert.deepEqual(live(h), []);
    assert.equal(h.record().state, 'revoked');
    assert.deepEqual(h.record().pendingRotations, []);
  } finally { h.close(); }
});

test('failed, empty and stale listings preserve lost rotation cleanup through restart', async () => {
  const h = harness(true);
  try {
    await h.make().provision(h.f.owner, h.request);
    h.modelvia.lose = 'rotate';
    await assert.rejects(() => h.make().provision(h.f.owner, { ...h.request, redeliver: true }), /modelvia_unreachable/);
    const failedListing = h.make({ modelvia: { ...h.modelviaClient, async listKeys() { throw new GatewayError('modelvia_unreachable', 502); } } });
    await assert.rejects(() => failedListing.revoke(h.f.owner, { companyId: h.request.companyId, installationId: h.request.installationId }), /modelvia_unreachable/);
    const obligation = h.record().pendingRotations;
    assert.equal(obligation.length, 1);
    assert.equal(obligation[0].sourceKeyId, KEY_IDS[0]);
    h.restart(); later(h);
    const emptyListing = h.make({ modelvia: { ...h.modelviaClient, async listKeys() { return []; } } });
    await assert.rejects(() => emptyListing.revoke(h.f.owner, { companyId: h.request.companyId, installationId: h.request.installationId }), /installation_revocation_cleanup_pending/);
    assert.deepEqual(h.record().pendingRotations, obligation);
    assert.equal(h.record().state, 'revoking');
    assert.equal(h.record().revocation, undefined);
    assert.equal(h.devices()[0]!.active, false);
    assert.deepEqual(live(h), [KEY_IDS[1]]);
    const staleListing = h.make({ modelvia: { ...h.modelviaClient, async listKeys(project, environment) {
      return (await h.modelviaClient.listKeys(project, environment)).map(key => ({ ...key, revokedAt: undefined }));
    } } });
    await assert.rejects(() => staleListing.revoke(h.f.owner, { companyId: h.request.companyId, installationId: h.request.installationId }), /installation_revocation_cleanup_pending/);
    assert.deepEqual(h.record().pendingRotations, obligation);
    assert.equal((await h.make().revoke(h.f.owner, { companyId: h.request.companyId, installationId: h.request.installationId })).revoked.modelKeyRevoked, true);
    assert.deepEqual(live(h), []);
  } finally { h.close(); }
});

test('an initial revoke failure remains fenced and a restarted worker can retry its known key', async () => {
  const h = harness(true);
  try {
    await h.make().provision(h.f.owner, h.request);
    const failure = h.make({ modelvia: { ...h.modelviaClient, async revoke() { throw new GatewayError('modelvia_unreachable', 502); } } });
    await assert.rejects(() => failure.revoke(h.f.owner, { companyId: h.request.companyId, installationId: h.request.installationId }), /modelvia_unreachable/);
    assert.equal(h.record().state, 'revoking');
    assert.equal(h.record().revocationWork.attempt, undefined);
    h.restart();
    await assert.rejects(() => h.make().provision(h.f.owner, h.request), /installation_revoked/);
    assert.equal((await h.make().revoke(h.f.owner, { companyId: h.request.companyId, installationId: h.request.installationId })).revoked.modelKeyRevoked, true);
    assert.deepEqual(live(h), []);
  } finally { h.close(); }
});

test('revoking a pending install after a lost mint cancels it durably: restart, then the key is revoked and provision stays refused', async () => {
  const h = harness(true);
  try {
    const scope = { companyId: h.request.companyId, installationId: h.request.installationId };
    h.modelvia.lose = 'mint';
    await assert.rejects(() => h.make().provision(h.f.owner, h.request), /modelvia_unreachable/);
    assert.equal(h.record().state, 'pending');
    assert.deepEqual(live(h), [KEY_IDS[0]]);
    // The attempt could still be running: it is fenced now, its keys are listed later.
    await assert.rejects(() => h.make().revoke(h.f.owner, scope), /installation_revocation_in_progress/);
    assert.equal(h.record().state, 'revoking');
    assert.equal(h.record().attempt, undefined);
    assert.equal(h.devices()[0]!.active, false);
    assert.deepEqual(h.modelvia.revoked, []);
    h.restart();
    later(h);
    // A provision resuming after the cancellation never mints or rotates.
    await assert.rejects(() => h.make().provision(h.f.owner, h.request), /installation_revoked/);
    const done = await h.make().revoke(h.f.owner, scope);
    assert.deepEqual(done.revoked, { ...scope, connectorDeactivated: true, modelKeyRevoked: true, modelKeyIds: [KEY_IDS[0]], provisioningCancelled: true,
      modelProjectRetained: 'rb-install-one', projectDeleted: false });
    assert.deepEqual(h.modelvia.revoked, [KEY_IDS[0]]);
    assert.deepEqual(live(h), []);
    assert.equal(h.modelvia.minted.length, 1); assert.deepEqual(h.modelvia.rotated, []);
    // Idempotent, and a later provision for that installation is refused.
    assert.deepEqual((await h.make().revoke(h.f.owner, scope)).revoked, done.revoked);
    later(h);
    await assert.rejects(() => h.make().provision(h.f.owner, h.request), /installation_revoked/);
  } finally { h.close(); }
});

test('a provision fenced by a pending revoke while it was running never mints', async () => {
  const h = harness();
  try {
    const gate = pause(); let reached!: () => void; const arrived = new Promise<void>(resolve => { reached = resolve; });
    const slow = h.make({ modelvia: { ...h.modelviaClient, async createProject(input) { reached(); await gate.reached; return h.modelviaClient.createProject(input); } } });
    const running = slow.provision(h.f.owner, h.request);
    await arrived;
    await assert.rejects(() => h.make().revoke(h.f.owner, { companyId: h.request.companyId, installationId: h.request.installationId }), /installation_revocation_in_progress/);
    gate.resume();
    await assert.rejects(() => running, /installation_provisioning_superseded/);
    assert.deepEqual(h.modelvia.minted, []);
    later(h);
    const done = await h.make().revoke(h.f.owner, { companyId: h.request.companyId, installationId: h.request.installationId });
    assert.equal(done.revoked.provisioningCancelled, true);
    assert.equal(done.revoked.modelKeyIds, undefined);
    assert.deepEqual(h.modelvia.revoked, []);
  } finally { h.close(); }
});

test('a Modelvia outage while cancelling a pending install fails cleanly and a retry finishes it', async () => {
  const h = harness(true);
  try {
    const scope = { companyId: h.request.companyId, installationId: h.request.installationId };
    h.modelvia.lose = 'mint';
    await assert.rejects(() => h.make().provision(h.f.owner, h.request), /modelvia_unreachable/);
    later(h);
    const down = () => { throw new GatewayError('modelvia_unreachable', 502); };
    await assert.rejects(() => h.make({ modelvia: { ...h.modelviaClient, findProject: async () => down() } }).revoke(h.f.owner, scope), /modelvia_unreachable/);
    assert.equal(h.record().state, 'revoking');
    assert.equal(h.record().revocationWork.attempt, undefined);
    assert.equal(h.record().revocationWork.discovered, undefined);
    // Discovered, then the revoke itself fails: the found key stays journalled.
    await assert.rejects(() => h.make({ modelvia: { ...h.modelviaClient, revoke: async () => down() } }).revoke(h.f.owner, scope), /modelvia_unreachable/);
    assert.deepEqual(h.record().revocationWork.keyIds, [KEY_IDS[0]]);
    assert.deepEqual(live(h), [KEY_IDS[0]]);
    h.restart();
    const done = await h.make().revoke(h.f.owner, scope);
    assert.equal(done.revoked.modelKeyRevoked, true);
    assert.deepEqual(live(h), []);
    await assert.rejects(() => h.make().provision(h.f.owner, h.request), /installation_revoked/);
  } finally { h.close(); }
});

test('an unconfirmed predecessor fence never reaches reconciliation or erases the rotation intent', async () => {
  const h = harness(true);
  try {
    await h.make().provision(h.f.owner, h.request);
    h.modelvia.lose = 'rotate';
    await assert.rejects(() => h.make().provision(h.f.owner, { ...h.request, redeliver: true }), /modelvia_unreachable/);
    const pending = h.record().pendingRotations;
    let reads = 0;
    const failure = h.make({ modelvia: { ...h.modelviaClient,
      async revoke() { throw new GatewayError('modelvia_unreachable', 502); },
      async listKeys(project, environment) { reads++; return h.modelviaClient.listKeys(project, environment); },
    } });
    await assert.rejects(() => failure.revoke(h.f.owner, { companyId: h.request.companyId, installationId: h.request.installationId }), /modelvia_unreachable/);
    assert.equal(reads, 0);
    assert.deepEqual(h.record().pendingRotations, pending);
    assert.equal(h.record().revocation, undefined);
    h.restart();
    assert.deepEqual(h.record().pendingRotations, pending);
    assert.equal((await h.make().revoke(h.f.owner, { companyId: h.request.companyId, installationId: h.request.installationId })).revoked.modelKeyRevoked, true);
    assert.deepEqual(live(h), []);
  } finally { h.close(); }
});

test('a discovered successor remains journalled after cleanup failure and another installation label is untouched', async () => {
  const h = harness(true);
  try {
    await h.make().provision(h.f.owner, h.request);
    h.modelvia.lose = 'rotate';
    await assert.rejects(() => h.make().provision(h.f.owner, { ...h.request, redeliver: true }), /modelvia_unreachable/);
    const foreign = { keyId: KEY_IDS[2]!, projectId: h.modelvia.keys[0]!.projectId, label: 'company-other:install-other' };
    h.modelvia.keys.push(foreign);
    const failure = h.make({ modelvia: { ...h.modelviaClient, async revoke(keyId) {
      if (keyId === KEY_IDS[1]) throw new GatewayError('modelvia_unreachable', 502);
      return h.modelviaClient.revoke(keyId);
    } } });
    await assert.rejects(() => failure.revoke(h.f.owner, { companyId: h.request.companyId, installationId: h.request.installationId }), /modelvia_unreachable/);
    assert.deepEqual(h.record().cleanupKeyIds, [KEY_IDS[1]]);
    assert.deepEqual(h.record().pendingRotations, []);
    assert.equal(h.record().state, 'revoking');
    assert.equal(h.record().revocation, undefined);
    h.restart();
    assert.equal((await h.make().revoke(h.f.owner, { companyId: h.request.companyId, installationId: h.request.installationId })).revoked.modelKeyRevoked, true);
    assert.deepEqual(live(h), [foreign.keyId]);
    assert.equal(h.modelvia.revoked.includes(foreign.keyId), false);
  } finally { h.close(); }
});

test('an office can only provision into a Modelvia customer bound to it', async () => {
  // Customer-paid: Modelvia's billing account names the office.
  const other = harness(); try {
    other.modelvia.customer = { active: true, ...CUSTOMER_CAPS, billingCompanyId: 'company-other' };
    await assert.rejects(() => other.make().provision(other.f.owner, other.request), (error: unknown) =>
      error instanceof GatewayError && error.code === 'modelvia_customer_not_bound' && error.status === 403);
    assert.equal(other.modelvia.projects.length, 0); assert.equal(existsSync(other.registry), false);
    other.modelvia.customer = { active: true, ...CUSTOMER_CAPS, billingCompanyId: other.f.tenant.companyId };
    assert.ok((await other.make().provision(other.f.owner, other.request)).provisioning.model.key);
  } finally { other.close(); }
  // Client-paid: the operator binding decides, both ways.
  const bound = harness(false, false); try {
    bindOfficeCustomer(bound.f.ledger, 'company-other', CUSTOMER);
    await assert.rejects(() => bound.make().provision(bound.f.owner, bound.request), /modelvia_customer_not_bound/);
    bindOfficeCustomer(bound.f.ledger, 'company-other', 'cus-other-office');
    bindOfficeCustomer(bound.f.ledger, bound.f.tenant.companyId, 'cus-fictional-elsewhere');
    await assert.rejects(() => bound.make().provision(bound.f.owner, bound.request), /modelvia_customer_not_bound/);
    assert.throws(() => bindOfficeCustomer(bound.f.ledger, bound.f.tenant.companyId, 'cus-other-office'), /modelvia_customer_bound_elsewhere/);
    bindOfficeCustomer(bound.f.ledger, bound.f.tenant.companyId, CUSTOMER);
    assert.ok((await bound.make().provision(bound.f.owner, bound.request)).provisioning.model.key);
    assert.equal(bound.modelvia.projects.length, 1);
  } finally { bound.close(); }
});

test('a client-paid office with no operator binding is refused; a key is never redelivered or re-capped under a customer the office left', async () => {
  // Fail closed: the body names a customer, but no operator bound this office.
  const unbound = harness(false, false); try {
    await assert.rejects(() => unbound.make().provision(unbound.f.owner, unbound.request), (error: unknown) =>
      error instanceof GatewayError && error.code === 'office_customer_unbound' && error.status === 409);
    assert.equal(unbound.modelvia.projects.length, 0); assert.equal(unbound.modelvia.minted.length, 0); assert.equal(existsSync(unbound.registry), false);
    assert.equal(unbound.f.ledger.db.get('SELECT 1 AS x FROM installation_provisioning'), undefined);
  } finally { unbound.close(); }
  // Provisioned while bound; the operator cannot move the office while that
  // computer holds keys. A binding moved before that rule (raw SQL) still fails closed.
  const moved = harness(); try {
    await moved.make().provision(moved.f.owner, moved.request);
    assert.throws(() => bindOfficeCustomer(moved.f.ledger, moved.f.tenant.companyId, 'cus-office-new'), (error: unknown) =>
      error instanceof GatewayError && error.code === 'office_customer_rebind_has_installations' && error.status === 409);
    moved.f.ledger.db.run('UPDATE office_modelvia_customer SET customer=? WHERE tenant=?', 'cus-office-new', moved.f.tenant.companyId);
    await assert.rejects(() => moved.make().provision(moved.f.owner, { ...moved.request, redeliver: true }), /modelvia_customer_not_bound/);
    assert.deepEqual(moved.modelvia.rotated, []);
    assert.equal(moved.record().redelivery, undefined);
    assert.deepEqual(await moved.make().applyCustomerCaps(moved.f.tenant.companyId), [{ installationId: 'install-one', state: 'failed', error: 'modelvia_customer_not_bound' }]);
    assert.deepEqual(moved.modelvia.capUpdates, []);
    // Bound back to its customer, both work again.
    bindOfficeCustomer(moved.f.ledger, moved.f.tenant.companyId, CUSTOMER);
    assert.ok((await moved.make().provision(moved.f.owner, { ...moved.request, redeliver: true })).provisioning.model.key);
    assert.deepEqual(await moved.make().applyCustomerCaps(moved.f.tenant.companyId), [{ installationId: 'install-one', state: 'applied' }]);
  } finally { moved.close(); }
});

test('an office customer binding never moves while any installation holds keys under the old customer', async () => {
  const h = harness(); try {
    await h.make().provision(h.f.owner, h.request);
    const company = h.f.tenant.companyId;
    const refused = (fn: () => void) => assert.throws(fn, (error: unknown) =>
      error instanceof GatewayError && error.code === 'office_customer_rebind_has_installations' && error.status === 409);
    // Office A cannot leave CUSTOMER while install-one's project sits under it.
    refused(() => bindOfficeCustomer(h.f.ledger, company, 'cus-office-new'));
    // Even with A's binding gone (legacy state), CUSTOMER cannot go to office B.
    h.f.ledger.db.run('DELETE FROM office_modelvia_customer WHERE tenant=?', company);
    refused(() => bindOfficeCustomer(h.f.ledger, 'company-b', CUSTOMER));
    bindOfficeCustomer(h.f.ledger, company, CUSTOMER);
    // A revoking record still owes key cleanup, so it still blocks.
    h.f.ledger.db.run("UPDATE installation_provisioning SET state='revoking' WHERE tenant=?", company);
    refused(() => bindOfficeCustomer(h.f.ledger, company, 'cus-office-new'));
    h.f.ledger.db.run("UPDATE installation_provisioning SET state='ready' WHERE tenant=?", company);
    // Disconnected (fully revoked): the move is allowed, and the old customer is free for B.
    await h.make().revoke(h.f.owner, { companyId: company, installationId: 'install-one' });
    bindOfficeCustomer(h.f.ledger, company, 'cus-office-new');
    bindOfficeCustomer(h.f.ledger, 'company-b', CUSTOMER);
  } finally { h.close(); }
  // An operator move that lands while provisioning waits on Modelvia is seen
  // before the pending record is journalled, so nothing is minted under it.
  const race = harness(); try {
    const modelvia = { ...race.modelviaClient, async findCustomer(customerId: string) {
      const found = await race.modelviaClient.findCustomer(customerId);
      bindOfficeCustomer(race.f.ledger, race.f.tenant.companyId, 'cus-office-new');
      return found;
    } };
    await assert.rejects(() => race.make({ modelvia }).provision(race.f.owner, race.request), /modelvia_customer_not_bound/);
    assert.equal(race.f.ledger.db.get('SELECT 1 AS x FROM installation_provisioning'), undefined);
    assert.equal(race.modelvia.projects.length, 0); assert.equal(race.modelvia.minted.length, 0);
  } finally { race.close(); }
});

test('a redelivery already running is refused before Modelvia is asked; a completed one returns the new key id', async () => {
  const h = harness(); try {
    await h.make().provision(h.f.owner, h.request);
    const first = await h.make().provision(h.f.owner, { ...h.request, redeliver: true });
    // The website records the rotated key id from the descriptor.
    assert.equal(first.provisioning.model.keyId, h.record().keyId);
    assert.equal(first.provisioning.model.keyId, KEY_IDS[1]);
    assert.equal((await h.make().provision(h.f.owner, h.request)).provisioning.model.keyId, KEY_IDS[1]);
    h.f.ledger.db.run('UPDATE installation_provisioning SET body=? WHERE tenant=? AND installation=?',
      JSON.stringify({ ...h.record(), redelivery: { attempt: 'other', at: h.f.ledger.now(), phase: 'preparing' } }), h.request.companyId, h.request.installationId);
    const reads = h.modelvia.customerReads;
    await assert.rejects(() => h.make().provision(h.f.owner, { ...h.request, redeliver: true }), /installation_provisioning_in_progress/);
    assert.equal(h.modelvia.customerReads, reads);
  } finally { h.close(); }
});

test('a Modelvia customer that is missing, inactive, another client\'s or zero-capped is refused before any effect', async () => {
  for (const customer of [null, { active: false, ...CUSTOMER_CAPS }, { active: true, monthlyCapNanoAud: '0', maxConcurrent: 3 }, { active: true, monthlyCapNanoAud: '70000000000', maxConcurrent: 0 }]) {
    const h = harness(); try {
      // `null` is also what the client returns for a customer under another platform client.
      h.modelvia.customer = customer;
      const failure = await h.make().provision(h.f.owner, h.request).then(() => undefined, error => error as GatewayError);
      assert.ok(failure instanceof GatewayError, JSON.stringify(customer));
      assert.equal(failure.code, 'modelvia_customer_not_ready'); assert.equal(failure.status, 409);
      // Nothing journalled, no Composio call, no device, no Modelvia effect.
      assert.equal(h.f.ledger.db.get('SELECT tenant FROM installation_provisioning'), undefined);
      assert.equal(h.org.orgKeyReads, 0); assert.equal(existsSync(h.registry), false);
      assert.deepEqual(h.modelvia.projects, []); assert.deepEqual(h.modelvia.minted, []);
      // Once Modelvia's operator fixes the customer, the same request succeeds.
      h.modelvia.customer = { active: true, ...CUSTOMER_CAPS };
      assert.equal((await h.make().provision(h.f.owner, h.request)).provisioning.model.spendCapLabel, SPEND_LABEL);
    } finally { h.close(); }
  }
});

test('project caps come from the Modelvia customer, never from the ledger tenant', async () => {
  const h = harness(); try {
    // Stored ledger caps are legacy and must not reach Modelvia.
    h.f.ledger.setCaps(h.f.owner, { monthlyCapNanoAud: '1000000000', requestCapNanoAud: '1000000000', maxConcurrent: 2 });
    await h.make().provision(h.f.owner, h.request);
    const project = h.modelvia.projects[0] as ModelviaCaps;
    assert.deepEqual({ monthlyCapNanoAud: project.monthlyCapNanoAud, requestCapNanoAud: project.requestCapNanoAud, maxConcurrent: project.maxConcurrent }, PROJECT_CAPS);
    assert.ok(BigInt(project.requestCapNanoAud) <= BigInt(project.monthlyCapNanoAud));
    // A ready record no longer carries cap sync state.
    const stored = JSON.parse(h.f.ledger.db.get<{ body: string }>('SELECT body FROM installation_provisioning')!.body);
    assert.equal('modelviaCaps' in stored, false);
  } finally { h.close(); }
});

test('the request cap defaults to A$4 (the billing account\'s request cap), takes an override, and never exceeds the monthly cap', async () => {
  const customer = { active: true, monthlyCapNanoAud: '70000000000', maxConcurrent: 3 };
  assert.equal(DEFAULT_REQUEST_CAP_NANO_AUD, '4000000000');
  assert.deepEqual(projectCaps(customer), { monthlyCapNanoAud: '70000000000', requestCapNanoAud: '4000000000', maxConcurrent: 3 });
  assert.equal(projectCaps(customer, '5000000000').requestCapNanoAud, '5000000000');
  // Clamped to the monthly cap, which Modelvia requires.
  assert.equal(projectCaps({ ...customer, monthlyCapNanoAud: '500000000' }).requestCapNanoAud, '500000000');
  assert.equal(projectCaps(customer, '90000000000').requestCapNanoAud, '70000000000');

  const h = harness(); try {
    assert.throws(() => h.make({ requestCapNanoAud: '0' }), /modelvia_request_cap_invalid/);
    const env: NodeJS.ProcessEnv = {
      REALBUD_ENABLE_PROVIDER: '1', REALBUD_GATEWAY_SECRETS_DIR: h.secretsDir, REALBUD_GATEWAY_CONNECTOR_REGISTRY: h.registry,
      REALBUD_GATEWAY_PUBLIC_ORIGIN: 'https://managed.example.invalid', REALBUD_COMPOSIO_ORG_KEY: 'fictional-org-key',
      REALBUD_MODELVIA_BASE_URL: 'https://api.modelvia.dev', REALBUD_MODELVIA_SCOPED_SECRET: 'fictional-operator-secret-of-32-chars',
      REALBUD_MODELVIA_OPERATOR_SUBJECT: 'realbud-provisioning', REALBUD_MODELVIA_CLIENT_ID: 'realbud', REALBUD_MODELVIA_MODELS: 'fictional-model', REALBUD_MODELVIA_REQUEST_CAP_NANO_AUD: '2000000000',
    };
    const never: HttpTransport = async () => { throw new Error('the resolver must not call out'); };
    for (const bad of ['0', '-1', '1.5', '1e9', 'one', '0100']) {
      assert.deepEqual(composeProvisioning({ env: { ...env, REALBUD_MODELVIA_REQUEST_CAP_NANO_AUD: bad }, ledger: h.f.ledger, fetch: never }),
        { unavailable: 'provisioning_unconfigured:REALBUD_MODELVIA_REQUEST_CAP_NANO_AUD' }, bad);
    }
    const composed = composeProvisioning({ env, ledger: h.f.ledger, fetch: never, org: h.orgClient, modelvia: h.modelviaClient, authConfigs: { resolveGmail: async () => 'ac-fictional-readonly' } }) as { provisioning: InstallationProvisioning };
    const provisioned = (await composed.provisioning.provision(h.f.owner, h.request)).provisioning;
    assert.equal((h.modelvia.projects[0] as ModelviaCaps).requestCapNanoAud, '2000000000');
    assert.equal(provisioned.model.spendCapLabel, 'A$70/month, A$2/request, 3 at once');
  } finally { h.close(); }
});

/** Three delivered installations (one then revoked) and one still pending. */
async function capsHarness() {
  const h = harness();
  for (const installationId of ['install-one', 'install-two', 'install-three']) await h.make().provision(h.f.owner, { ...h.request, installationId });
  await h.make().revoke(h.f.owner, { companyId: h.f.tenant.companyId, installationId: 'install-three' });
  h.f.ledger.db.run('INSERT INTO installation_provisioning(tenant,installation,state,body,created) VALUES(?,?,?,?,?)', h.f.tenant.companyId, 'install-pending', 'pending',
    JSON.stringify({ state: 'pending', profile: 'property', apps: ['gmail'], customerId: CUSTOMER, modelProjectId: 'rb-install-pending', attempt: 'a', attemptAt: h.f.now() }), h.f.now());
  h.modelvia.capUpdates.length = 0; h.modelvia.customerReads = 0;
  // The office's Modelvia operator raises the customer's cap and concurrency.
  h.modelvia.customer = { active: true, monthlyCapNanoAud: '90000000000', maxConcurrent: 5 };
  return h;
}
const RAISED = { monthlyCapNanoAud: '90000000000', requestCapNanoAud: '4000000000', maxConcurrent: 5 };

test('applyCustomerCaps re-applies the customer caps to every ready project and skips pending and revoked ones', async () => {
  const h = await capsHarness(); try {
    const results = await h.make().applyCustomerCaps(h.f.tenant.companyId);
    assert.deepEqual(results, [{ installationId: 'install-one', state: 'applied' }, { installationId: 'install-two', state: 'applied' }]);
    assert.deepEqual(h.modelvia.capUpdates, [{ projectId: 'rb-install-one', ...RAISED }, { projectId: 'rb-install-two', ...RAISED }]);
    // One customer read for the one distinct customer.
    assert.equal(h.modelvia.customerReads, 1);
    // A repeat provision reports the caps now in force, still without secrets.
    const repeat = (await h.make().provision(h.f.owner, h.request)).provisioning;
    assert.equal(repeat.model.spendCapLabel, 'A$90/month, A$4/request, 5 at once');
    assert.equal(repeat.model.key, undefined);
    // Audit lines carry installation ids and states, never the customer id.
    const audit = h.f.ledger.db.all<{ kind: string; body: string }>("SELECT kind, body FROM events WHERE kind LIKE 'installation_caps_%'");
    assert.deepEqual(audit.map(row => row.kind), ['installation_caps_apply_requested', 'installation_caps_applied']);
    assert.ok(!audit.some(row => row.body.includes(CUSTOMER)));
    h.f.ledger.db.verify();
  } finally { h.close(); }
});

test('applyCustomerCaps reports a partial failure per installation and still applies the rest', async () => {
  const h = await capsHarness(); try {
    const modelvia: ModelviaClient = { ...h.modelviaClient, async updateProjectCaps(projectId, caps) {
      if (projectId === 'rb-install-one') throw new GatewayError('modelvia_unreachable', 502);
      return h.modelviaClient.updateProjectCaps(projectId, caps);
    } };
    const results = await h.make({ modelvia }).applyCustomerCaps(h.f.tenant.companyId);
    assert.deepEqual(results, [{ installationId: 'install-one', state: 'failed', error: 'modelvia_unreachable' }, { installationId: 'install-two', state: 'applied' }]);
    assert.deepEqual(h.modelvia.capUpdates, [{ projectId: 'rb-install-two', ...RAISED }]);
    // The failed installation keeps its old label; nothing claims caps that were not applied.
    assert.equal((await h.make().provision(h.f.owner, h.request)).provisioning.model.spendCapLabel, SPEND_LABEL);
    // An unexpected error becomes a fixed code, never its message.
    const broken: ModelviaClient = { ...h.modelviaClient, async updateProjectCaps() { throw new Error(`upstream said ${CUSTOMER}`); } };
    const again = await h.make({ modelvia: broken }).applyCustomerCaps(h.f.tenant.companyId);
    assert.deepEqual(again.map(entry => entry.error), ['modelvia_caps_failed', 'modelvia_caps_failed']);
  } finally { h.close(); }
});

test('applyCustomerCaps reports a customer that is not ready as failed without updating any project', async () => {
  for (const customer of [null, { active: false, monthlyCapNanoAud: '90000000000', maxConcurrent: 5 }, { active: true, monthlyCapNanoAud: '0', maxConcurrent: 5 }]) {
    const h = await capsHarness(); try {
      h.modelvia.customer = customer;
      const results = await h.make().applyCustomerCaps(h.f.tenant.companyId);
      assert.deepEqual(results, [{ installationId: 'install-one', state: 'failed', error: 'modelvia_customer_not_ready' }, { installationId: 'install-two', state: 'failed', error: 'modelvia_customer_not_ready' }]);
      assert.deepEqual(h.modelvia.capUpdates, []);
      assert.equal(h.modelvia.customerReads, 1);
    } finally { h.close(); }
  }
});

test('applyCustomerCaps runs one refresh per company at a time', async () => {
  const h = await capsHarness(); try {
    const order: string[] = []; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    const modelvia: ModelviaClient = { ...h.modelviaClient, async updateProjectCaps(projectId, caps) {
      order.push(`start ${projectId}`);
      if (first) { first = false; await gate; }
      order.push(`end ${projectId}`);
      return h.modelviaClient.updateProjectCaps(projectId, caps);
    } };
    const service = h.make({ modelvia });
    const one = service.applyCustomerCaps(h.f.tenant.companyId), two = service.applyCustomerCaps(h.f.tenant.companyId);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(order, ['start rb-install-one']);
    release();
    await Promise.all([one, two]);
    assert.deepEqual(order, ['start rb-install-one', 'end rb-install-one', 'start rb-install-two', 'end rb-install-two',
      'start rb-install-one', 'end rb-install-one', 'start rb-install-two', 'end rb-install-two']);
  } finally { h.close(); }
});

test('a ready record written with the old cap sync state still repeats and revokes', async () => {
  const h = harness(); try {
    await h.make().provision(h.f.owner, h.request);
    const row = h.f.ledger.db.get<{ body: string }>('SELECT body FROM installation_provisioning')!;
    const legacy = { ...JSON.parse(row.body), modelviaCaps: { state: 'out_of_sync', at: 1, error: 'modelvia_unreachable', monthlyCapNanoAud: '1', requestCapNanoAud: '1', maxConcurrent: 1 } };
    h.f.ledger.db.run('UPDATE installation_provisioning SET body=?', JSON.stringify(legacy));
    const repeat = (await h.make().provision(h.f.owner, h.request)).provisioning;
    assert.equal(repeat.model.keyId, '0123456789abcdef'); assert.equal(repeat.model.key, undefined);
    assert.equal((await h.make().revoke(h.f.owner, { companyId: h.f.tenant.companyId, installationId: 'install-one' })).revoked.modelKeyRevoked, true);
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

test('revoke turns off the installation\'s own event triggers and does not wait on the provider to confirm', async () => {
  const h = harness(); try {
    await h.make().provision(h.f.owner, h.request);
    const device = h.devices()[0]!, signal = new AbortController().signal;
    const fake = { async upsertTrigger(binding: { userId: string }) { return `ti_${binding.userId.replace(/[^A-Za-z0-9]/g, '')}`; }, async setTriggerStatus() {} };
    const triggers = new ComposioTriggers({ ledger: h.f.ledger, devices: () => h.devices(), secret: name => h.secrets.read(name), mailbox: { readyForDevice: () => false }, apps: fake });
    for (const userId of [device.userId, 'installation-another']) {
      await triggers.set(h.f.tenant.companyId, device.projectKeyEnv, { apiKey: PROJECT_KEY, authConfigId: device.authConfigId, userId, accountId: 'ca_fictional' }, triggerSpec('gmail', 'new-message'), true, signal);
    }
    const disabled: unknown[] = [];
    const result = await h.make({ triggerApps: { async setTriggerStatus(binding, id, enabled) { disabled.push([binding.apiKey === PROJECT_KEY, id, enabled]); throw new Error('provider unavailable'); } } })
      .revoke(h.f.owner, { companyId: h.f.tenant.companyId, installationId: 'install-one' });
    assert.equal(result.revoked.connectorDeactivated, true);
    assert.deepEqual(disabled, [[true, 'ti_installationinstallone', false]]);
    assert.deepEqual(h.f.ledger.db.all<{ trigger_id: string; state: string }>('SELECT trigger_id, state FROM composio_triggers ORDER BY trigger_id').map(row => ({ ...row })),
      [{ trigger_id: 'ti_installationanother', state: 'enabled' }, { trigger_id: 'ti_installationinstallone', state: 'disabled' }]);
    assert.ok(h.f.ledger.db.get("SELECT seq FROM events WHERE kind='composio_trigger_disable_unconfirmed'"));
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
      REALBUD_COMPOSIO_ORG_KEY: secret,
      REALBUD_MODELVIA_BASE_URL: 'https://api.modelvia.dev', REALBUD_MODELVIA_SCOPED_SECRET: 'fictional-operator-secret-of-32-chars',
      REALBUD_MODELVIA_OPERATOR_SUBJECT: 'realbud-provisioning',
      REALBUD_MODELVIA_CLIENT_ID: 'realbud', REALBUD_MODELVIA_MODELS: 'fictional-model',
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
    // The old global secret cannot bring provisioning online, even when present.
    assert.deepEqual(resolve({ ...full, REALBUD_MODELVIA_SCOPED_SECRET: undefined,
      REALBUD_MODELVIA_OPERATOR_SECRET: full.REALBUD_MODELVIA_SCOPED_SECRET }),
      { unavailable: 'provisioning_unconfigured:REALBUD_MODELVIA_SCOPED_SECRET' });
    assert.deepEqual(resolve({ ...full, REALBUD_MODELVIA_OPERATOR_SECRET: full.REALBUD_MODELVIA_SCOPED_SECRET }),
      { unavailable: 'provisioning_unconfigured:REALBUD_MODELVIA_SCOPED_SECRET' });
    // A malformed value is reported by code, and the value itself never appears.
    for (const broken of [{ REALBUD_GATEWAY_PUBLIC_ORIGIN: `http://${secret}.invalid` }, { REALBUD_MODELVIA_BASE_URL: `https://${secret}.invalid/v1` }, { REALBUD_MODELVIA_CLIENT_ID: `${secret} bad id` }, { REALBUD_MODELVIA_MODELS: ' , ' }, { REALBUD_MODELVIA_SCOPED_SECRET: 'short' },
      { REALBUD_GATEWAY_SECRETS_DIR: `relative/${secret}` }, { REALBUD_MODELVIA_ENVIRONMENT: secret }, { REALBUD_MODELVIA_REQUEST_CAP_NANO_AUD: secret }]) {
      const result = resolve({ ...full, ...broken }) as { unavailable: string };
      assert.match(result.unavailable, /^provisioning_unconfigured:/);
      assert.ok(!result.unavailable.includes(secret), `reason leaked a value: ${result.unavailable}`);
    }
    // No model default: `auto` is a request value, never an allowlist entry.
    for (const models of [undefined, 'auto', 'fictional-model, auto', 'AUTO'])
      assert.deepEqual(resolve({ ...full, REALBUD_MODELVIA_MODELS: models }), { unavailable: 'provisioning_unconfigured:REALBUD_MODELVIA_MODELS' });
    const composed = resolve(full);
    assert.ok('provisioning' in composed);
    // Composition alone makes no provider call; the transport above would throw.
    // The first call a provision makes is the Modelvia customer read.
    const result = await (composed as { provisioning: InstallationProvisioning }).provisioning
      .provision(h.f.owner, h.request).then(() => 'called out', error => (error as Error).message);
    assert.equal(result, 'modelvia_unreachable');
  } finally { h.close(); }
});

test('the HTTP portal route provisions once, is unavailable when unconfigured, and leaks nothing on failure', async () => {
  const h = harness();
  const provisioning = h.make();
  const portal = { async authenticate(token: string) { if (token !== 'fictional-portal-token') throw new Error('no'); return h.f.owner; } };
  const server = createGatewayServer({ allowedOrigins: new Set(), portal, provisioning });
  const bare = createGatewayServer({ allowedOrigins: new Set(), portal });
  const misconfigured = createGatewayServer({ allowedOrigins: new Set(), portal, modelviaOperator: 'configured',
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
    assert.deepEqual(await readyOk.json(), { ready: true, provisioning: 'composed', modelviaOperator: 'configured', operatorAccess: 'missing', serviceIssuer: 'missing' });
    const readyBare = await fetch(`${bareBase}/ready`);
    assert.equal(readyBare.status, 503);
    assert.deepEqual(await readyBare.json(), { ready: false, error: 'provisioning_unavailable', modelviaOperator: 'missing', operatorAccess: 'missing', serviceIssuer: 'missing' });
    const readyNamed = await fetch(`${misconfiguredBase}/ready`);
    assert.equal(readyNamed.status, 503);
    assert.deepEqual(await readyNamed.json(), { ready: false, error: 'provisioning_unconfigured:REALBUD_COMPOSIO_ORG_KEY', modelviaOperator: 'configured', operatorAccess: 'missing', serviceIssuer: 'missing' });

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

test('the spend cap label is short human text the desktop contract accepts for every cap Modelvia can hold', async () => {
  // Whole dollars print without cents; anything else prints to the cent.
  assert.equal(spendCapLabel({ monthlyCapNanoAud: '1000000000', requestCapNanoAud: '1000000000', maxConcurrent: 1 }), 'A$1/month, A$1/request, 1 at once');
  assert.equal(spendCapLabel({ monthlyCapNanoAud: '200000000000', requestCapNanoAud: '1000000000', maxConcurrent: 2 }), 'A$200/month, A$1/request, 2 at once');
  assert.equal(spendCapLabel({ monthlyCapNanoAud: '10000000000000', requestCapNanoAud: '500000000', maxConcurrent: 100 }), 'A$10,000/month, A$0.50/request, 100 at once');
  assert.equal(spendCapLabel({ monthlyCapNanoAud: '41230000000', requestCapNanoAud: '1999999999', maxConcurrent: 3 }), 'A$41.23/month, A$2/request, 3 at once');
  // The widest figures the cap validator admits (21 digits, concurrency 100)
  // still fit the desktop's bound, in printable ASCII only.
  const widest = spendCapLabel({ monthlyCapNanoAud: '9'.repeat(21), requestCapNanoAud: '9'.repeat(21), maxConcurrent: 100 });
  assert.ok(widest.length <= SPEND_CAP_LABEL_MAX, widest);
  assert.match(widest, /^[\x20-\x7e]+$/);
  // Through a real provision: the office's A$10,000 cap with 100 concurrent turns.
  const h = harness(); try {
    h.modelvia.customer = { active: true, monthlyCapNanoAud: '10000000000000', maxConcurrent: 100 };
    const label = (await h.make().provision(h.f.owner, h.request)).provisioning.model.spendCapLabel;
    assert.equal(label, 'A$10,000/month, A$4/request, 100 at once');
    assert.ok(label.length <= SPEND_CAP_LABEL_MAX);
    assert.ok(!label.includes('nanoAUD'));
  } finally { h.close(); }
});

test('three office installations reuse a verified config, another office uses its own project key and config', async () => {
  const h = harness(); try {
    const { composioAuthConfigClient, GMAIL_AUTH_CONFIG_NAME, GMAIL_READONLY_SCOPE } = await import('./composio-auth-config.ts');
    const configs = new Map<string, unknown[]>(); let creates = 0;
    const authConfigs = composioAuthConfigClient({ fetch: async (_url, init) => {
      const key = new Headers(init.headers).get('x-api-key')!;
      if (init.method === 'POST') {
        const id = `ac_office${++creates}`;
        configs.set(key, [{ id, name: GMAIL_AUTH_CONFIG_NAME, toolkit: { slug: 'gmail' }, auth_scheme: 'OAUTH2', is_composio_managed: true, status: 'ENABLED', credentials: { scopes: GMAIL_READONLY_SCOPE } }]);
        return Response.json({ auth_config: { id } }, { status: 201 });
      }
      return Response.json({ items: configs.get(key) ?? [] });
    } });
    const org = { ...h.orgClient, async createProject(name: string) { const p = await h.orgClient.createProject(name); return { ...p, apiKey: `${PROJECT_KEY}_${p.id}` }; } };
    for (const installationId of ['install-one', 'install-two', 'install-three']) await h.make({ authConfigs, org }).provision(h.f.owner, { ...h.request, installationId });
    assert.equal(creates, 1); assert.equal(h.org.created.length, 1);
    assert.deepEqual(h.devices().map(d => d.authConfigId), ['ac_office1', 'ac_office1', 'ac_office1']);
    const other = { ...h.f.owner, companyId: 'company-b' };
    h.f.ledger.provisionTenant({ ...h.f.tenant, companyId: 'company-b', licenseId: 'license-b' });
    // Another office provisions only under its own bound Modelvia customer.
    bindOfficeCustomer(h.f.ledger, 'company-b', 'cus-office-b');
    const modelviaB = { ...h.modelviaClient, async findCustomer(id: string) { return id === 'cus-office-b' ? { active: true, ...CUSTOMER_CAPS } : null; } };
    await h.make({ authConfigs, org, modelvia: modelviaB }).provision(other, { ...h.request, companyId: 'company-b', customerId: 'cus-office-b', installationId: 'install-four' });
    assert.equal(creates, 2); assert.equal(h.devices()[3]!.authConfigId, 'ac_office2');
  } finally { h.close(); }
});

test('a create intent recorded before managed-v2 does not hold back the v2 create; a v2 intent does', async () => {
  const h = harness(); try {
    const seen: boolean[] = [];
    const legacy = { gmailAuthConfigName: () => 'realbud-gmail-readonly-v1', async resolveGmail(o: { allowCreate: boolean; beforeCreate(): void }) { if (o.allowCreate) o.beforeCreate(); return 'ac_legacy'; } };
    await h.make({ authConfigs: { resolveGmail: legacy.resolveGmail } }).provision(h.f.owner, h.request);
    const v2 = { gmailAuthConfigName: () => 'realbud-gmail-managed-v2', async resolveGmail(o: { allowCreate: boolean; beforeCreate(): void }) {
      seen.push(o.allowCreate); if (o.allowCreate) o.beforeCreate(); return 'ac_v2'; } };
    // The first installation's marker has no name: it guarded the legacy config.
    await h.make({ authConfigs: v2 }).provision(h.f.owner, { ...h.request, installationId: 'install-two' });
    await h.make({ authConfigs: v2 }).provision(h.f.owner, { ...h.request, installationId: 'install-three' });
    assert.deepEqual(seen, [true, false]);
    assert.deepEqual(h.devices().map(d => d.authConfigId), ['ac_legacy', 'ac_v2', 'ac_v2']);
  } finally { h.close(); }
});

test('uncertain auth config intent survives restart and blocks another installation from creating again', async () => {
  const h = harness(); try {
    let creates = 0;
    const authConfigs = { async resolveGmail(o: { allowCreate: boolean; beforeCreate(): void }) { if (o.allowCreate) { o.beforeCreate(); creates++; } throw new GatewayError('connector_auth_config_create_unconfirmed', 409); } };
    await assert.rejects(h.make({ authConfigs }).provision(h.f.owner, h.request), /create_unconfirmed/);
    await assert.rejects(h.make({ authConfigs }).provision(h.f.owner, { ...h.request, installationId: 'install-two' }), /create_unconfirmed/);
    h.f.setTime(h.f.now() + PENDING_RESUME_AFTER_MS);
    await assert.rejects(h.make({ authConfigs }).provision(h.f.owner, h.request), /create_unconfirmed/);
    assert.equal(creates, 1); assert.equal(existsSync(h.registry), false); assert.equal(h.modelvia.minted.length, 0);
  } finally { h.close(); }
});

test('an own-client config with broadened scopes is refused before device admission and ready bindings are preserved', async () => {
  const h = harness(); try {
    await h.make().provision(h.f.owner, h.request);
    const original = h.devices()[0]!;
    const { composioAuthConfigClient, oauthAppsFromEnv } = await import('./composio-auth-config.ts');
    let reads = 0;
    const oauthApps = oauthAppsFromEnv({ REALBUD_OAUTH_GOOGLE_CLIENT_ID: 'fictional.apps.googleusercontent.com', REALBUD_OAUTH_GOOGLE_CLIENT_SECRET: 'fictional-own-secret' });
    const authConfigs = composioAuthConfigClient({ oauthApps, fetch: async () => { reads++; return Response.json({ items: [{ id: 'ac_unsafe', name: 'realbud-gmail-own-v1', toolkit: { slug: 'gmail' }, auth_scheme: 'OAUTH2', is_composio_managed: false, status: 'ENABLED', credentials: { scopes: 'https://mail.google.com/' } }] }); } });
    await assert.rejects(h.make({ authConfigs }).provision(h.f.owner, { ...h.request, installationId: 'install-two' }), /scopes_not_admitted/);
    assert.deepEqual(h.devices(), [original]); assert.equal(h.modelvia.minted.length, 1);
    await h.make({ authConfigs }).provision(h.f.owner, h.request);
    await h.make({ authConfigs }).provision(h.f.owner, { ...h.request, redeliver: true });
    assert.equal(reads, 1); assert.equal(h.devices()[0]!.authConfigId, original.authConfigId);
    assert.equal(h.devices()[0]!.projectKeyEnv, original.projectKeyEnv);
  } finally { h.close(); }
});

test('auth config create intent for a deleted project does not block a replacement office project', async () => {
  const h = harness(); try {
    const created: string[] = [];
    const authConfigs = { async resolveGmail(o: { projectKey: string; allowCreate: boolean; beforeCreate(): void }) {
      assert.equal(o.allowCreate, true); o.beforeCreate(); created.push(o.projectKey); return `ac_office${created.length}`;
    } };
    await h.make({ authConfigs }).provision(h.f.owner, h.request);
    await h.make({ authConfigs }).revoke(h.f.owner, { companyId: h.request.companyId, installationId: h.request.installationId, deleteProject: true });
    await h.make({ authConfigs }).provision(h.f.owner, { ...h.request, installationId: 'install-new' });
    assert.equal(created.length, 2); assert.equal(h.org.created.length, 2);
    assert.equal(h.devices().find(d => d.id === 'install-new')!.authConfigId, 'ac_office2');
  } finally { h.close(); }
});

// ---------------------------------------------------------------------------
// Registry and secret durability: ENOSPC or a kill at every write boundary
// ---------------------------------------------------------------------------

const SECRET_NAME_FIXTURE = 'REALBUD_COMPOSIO_PROJECT_FICTIONAL';
const SECRET_VALUE = `ak_fictional_durable_${'x'.repeat(64)}`;
const registryDevice = (id: string) => ({ id, companyId: 'company-fictional', licenseId: 'license-fictional', memberId: 'member-fictional',
  installationId: `install-${id}`, profile: 'property-fixture', active: true, expiresAt: Date.UTC(2030, 0, 1), projectKeyEnv: SECRET_NAME_FIXTURE,
  authConfigId: 'auth-fictional', userId: 'user-fictional', tokenHash: createHashHex(id) });
function createHashHex(text: string) { return Buffer.from(text.padEnd(32, '-').slice(0, 32)).toString('hex'); }
const ids = (registry: string) => (JSON.parse(readFileSync(registry, 'utf8')).devices as { id: string }[]).map(d => d.id);
const temps = (directory: string) => readdirSync(directory).filter(name => name.endsWith('.tmp'));
function durabilityRoot() {
  const root = mkdtempSync(join(tmpdir(), 'realbud-durability-'));
  const registry = join(root, 'server', 'devices.json'), secrets = join(root, 'secrets');
  updateRegistry(registry, () => ({ devices: [registryDevice('device-a')] }));
  return { root, registry, secrets, close: () => rmSync(root, { recursive: true, force: true }) };
}
/** Real file operations, except call number `failAt` fails with ENOSPC; a write
 * lands one byte first, as a filling disk does. */
function enospcAt(failAt: number) {
  let calls = 0; const state = { fired: false };
  const io = Object.fromEntries(Object.entries(nodeIo).map(([name, operation]) => [name, (...args: any[]) => {
    if (calls++ !== failAt) return (operation as (...a: any[]) => unknown)(...args);
    state.fired = true;
    if (name === 'writeSync') nodeIo.writeSync(args[0], (args[1] as Buffer).subarray(args[2], args[2] + 1), 0);
    throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
  }])) as unknown as DurableIo;
  return { io, state };
}

test('ENOSPC at every registry write boundary leaves the previous or next registry, no temp, and a usable lock', () => {
  for (let failAt = 0; ; failAt++) {
    const r = durabilityRoot(); try {
      const { io, state } = enospcAt(failAt);
      let threw = false;
      try { updateRegistry(r.registry, devices => ({ devices: [...devices, registryDevice('device-b')] }), io); } catch { threw = true; }
      if (!state.fired) { assert.equal(threw, false); assert.deepEqual(ids(r.registry), ['device-a', 'device-b']); assert.ok(failAt > 10); break; }
      // Only a failed cleanup of an already published file reports success.
      assert.ok([threw ? 'device-a' : '', 'device-a,device-b'].includes(ids(r.registry).join(',')), `boundary ${failAt}`);
      // The lock is released, or held by this (necessarily finished) process and
      // recovered; a stray temp from a failed cleanup is reconciled.
      updateRegistry(r.registry, devices => ({ devices: [...devices, registryDevice('device-c')] }));
      assert.ok(ids(r.registry).includes('device-c')); assert.equal(existsSync(`${r.registry}.lock`), false);
      assert.deepEqual(temps(join(r.root, 'server')), [], `boundary ${failAt}`);
    } finally { r.close(); }
  }
});

test('ENOSPC at every secret write boundary never admits a partial secret and leaves the name reusable', () => {
  for (let failAt = 0; ; failAt++) {
    const r = durabilityRoot(); try {
      const { io, state } = enospcAt(failAt);
      let threw = false;
      try { fileSecretStore(r.secrets, io).write(SECRET_NAME_FIXTURE, SECRET_VALUE); } catch { threw = true; }
      const store = fileSecretStore(r.secrets);
      if (!state.fired) { assert.equal(threw, false); assert.equal(store.read(SECRET_NAME_FIXTURE), SECRET_VALUE); assert.ok(failAt > 5); break; }
      // Restart reconciliation removed any temp copy of the secret.
      assert.deepEqual(temps(r.secrets), [], `boundary ${failAt}`);
      // A failed write leaves nothing behind, so the caller's cleanup (deleting
      // the project whose key it could not store) is complete. Only a failed
      // cleanup of an already published secret reports success.
      assert.equal(store.read(SECRET_NAME_FIXTURE), threw ? undefined : SECRET_VALUE, `boundary ${failAt}`);
      if (threw) { store.write(SECRET_NAME_FIXTURE, SECRET_VALUE); assert.equal(store.read(SECRET_NAME_FIXTURE), SECRET_VALUE); }
    } finally { r.close(); }
  }
});

test('a process killed at every registry or secret write boundary is reconciled on restart', () => {
  const provisioning = new URL('./provisioning.ts', import.meta.url).href;
  for (let killAt = 0; ; killAt++) {
    const r = durabilityRoot(); try {
      const program = `import { fileSecretStore, nodeIo, updateRegistry } from ${JSON.stringify(provisioning)};
        let calls = 0; const io = Object.fromEntries(Object.entries(nodeIo).map(([name, operation]) => [name, (...args) => {
          if (calls++ === ${killAt}) { process.kill(process.pid, 'SIGKILL'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }
          return operation(...args); }]));
        updateRegistry(${JSON.stringify(r.registry)}, devices => ({ devices: [...devices, ${JSON.stringify(registryDevice('device-b'))}] }), io);
        fileSecretStore(${JSON.stringify(r.secrets)}, io).write(${JSON.stringify(SECRET_NAME_FIXTURE)}, ${JSON.stringify(SECRET_VALUE)});`;
      const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', program], { encoding: 'utf8', timeout: 20_000 });
      if (child.signal !== 'SIGKILL') {
        assert.equal(child.status, 0, child.stderr); assert.ok(killAt > 15);
        assert.equal(fileSecretStore(r.secrets).read(SECRET_NAME_FIXTURE), SECRET_VALUE);
        break;
      }
      // Restart: the secret store reconciles its directory and the registry
      // writer recovers the dead owner's lock.
      const store = fileSecretStore(r.secrets);
      assert.ok([undefined, SECRET_VALUE].includes(store.read(SECRET_NAME_FIXTURE)), `boundary ${killAt}`);
      if (existsSync(r.secrets)) assert.deepEqual(temps(r.secrets), [], `boundary ${killAt}`);
      assert.ok(['device-a', 'device-a,device-b'].includes(ids(r.registry).join(',')), `boundary ${killAt}`);
      updateRegistry(r.registry, devices => ({ devices: [...devices, registryDevice('device-c')] }));
      assert.ok(ids(r.registry).includes('device-c'), `boundary ${killAt}`);
      assert.deepEqual(temps(join(r.root, 'server')), [], `boundary ${killAt}`);
      assert.equal(existsSync(`${r.registry}.lock`), false, `boundary ${killAt}`);
    } finally { r.close(); }
  }
});

test('a secret file cut short (no trailing newline) is never admitted', () => {
  const r = durabilityRoot(); try {
    mkdirSync(r.secrets, { mode: 0o700 });
    writeFileSync(join(r.secrets, SECRET_NAME_FIXTURE), SECRET_VALUE.slice(0, 20), { mode: 0o600 });
    assert.throws(() => fileSecretStore(r.secrets).read(SECRET_NAME_FIXTURE), (error: unknown) => error instanceof GatewayError && error.code === 'gateway_secret_unreadable');
  } finally { r.close(); }
});
