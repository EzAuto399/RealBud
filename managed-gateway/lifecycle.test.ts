/**
 * Installation lifecycle through the production composition (composition.ts):
 * every computer of an office gets, exactly once, its own Modelvia project and
 * key and a Composio connector device whose office project key the connector
 * broker can actually read. The vendors are stateful fakes, fictional only; a
 * pass here is never evidence that a real Composio or Modelvia account was used.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './testing.ts';
import { LedgerDatabase } from './database.ts';
import { UsageLedger } from './ledger.ts';
import { GatewayError, type PortalPrincipal } from './contracts.ts';
import { createGatewayServer } from './http.ts';
import { composeGateway, type GatewayComposition } from './composition.ts';
import { validateConnectorDevices, type ConnectorOptions } from './connectors.ts';
import { fileSecretStore, InstallationProvisioning, PENDING_RESUME_AFTER_MS, type ProvisioningDescriptor, type SecretStore } from './provisioning.ts';
import { OfficeAiAccessService } from './office-ai-access.ts';
import { OPERATOR_ROLE, type OperatorPrincipal } from './operator-token.ts';
import type { ComposioOrgClient, HttpTransport } from './composio-org.ts';
import type { ModelviaCaps, ModelviaCustomer, ModelviaOperatorClient } from './modelvia-keys.ts';
import type { GmailReadOnlyBinding } from '../server/composio-gmail.ts';
import type { MailScanResult } from '../shared/mail-ingestion.ts';

const CUSTOMER = 'cus-fictional-office';
const ORG_KEY = 'fictional-org-key-never-in-a-response';
const PROJECT_KEY = 'ak_fictional_office_project_key_';
const ACCOUNT = 'account-fictional';
const CAPS = { monthlyCapNanoAud: '70000000000', maxConcurrent: 3 };
const PROJECT_CAPS = { monthlyCapNanoAud: '70000000000', requestCapNanoAud: '4000000000', maxConcurrent: 3 };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const failure = (promise: Promise<unknown>) => promise.then(() => undefined, error => error as GatewayError);

/** Composio and Modelvia as the gateway sees them. Their state survives a
 * gateway restart and a lost reply, as a remote service's would. */
function vendors() {
  const composio = { projects: [] as { id: string; name: string }[], created: [] as string[], deleted: [] as string[], lists: 0, deleteFails: false };
  const org: ComposioOrgClient = {
    async listProjects() { composio.lists++; await tick(); return composio.projects.map(project => ({ ...project })); },
    async createProject(name) {
      await tick(); composio.created.push(name);
      const project = { id: `pr_fictional${composio.created.length}`, name }; composio.projects.push(project);
      return { ...project, apiKey: `${PROJECT_KEY}${composio.created.length}` };
    },
    async deleteProject(id) {
      // Composio refuses a project it no longer holds, and a delete that fails is unconfirmed.
      if (composio.deleteFails || !composio.projects.some(project => project.id === id)) throw new GatewayError('composio_delete_unconfirmed', 502);
      composio.deleted.push(id); composio.projects = composio.projects.filter(project => project.id !== id);
      return { revokeJobId: `job-fictional-${id}` };
    },
  };
  const mv = {
    customer: { active: true, ...CAPS } as ModelviaCustomer | null, customerReads: 0,
    projects: new Map<string, ModelviaCaps & { customerId: string; active: boolean; environments: string[] }>(),
    keys: [] as { keyId: string; key: string; projectId: string; label: string; revokedAt?: number }[],
    minted: [] as string[], rotated: [] as string[], revoked: [] as string[], capUpdates: [] as ({ projectId: string } & ModelviaCaps)[],
    lose: undefined as undefined | 'mint', revokeFails: false,
  };
  const baseUrl = 'https://api.modelvia.dev/v1';
  const issue = (projectId: string, label: string) => {
    const n = mv.keys.length + 1, keyId = n.toString(16).padStart(16, '0');
    const entry = { keyId, key: `rbk_${keyId}_fictional_model_key_secret_${n}`, projectId, label }; mv.keys.push(entry);
    return entry;
  };
  const modelvia: ModelviaOperatorClient = {
    environment: 'production',
    async findCustomer(customerId) { mv.customerReads++; return customerId === CUSTOMER && mv.customer ? { ...mv.customer } : null; },
    async createProject(input) {
      if (mv.projects.has(input.projectId)) return { projectId: input.projectId, created: false };
      mv.projects.set(input.projectId, { customerId: input.customerId, active: true, environments: ['production'],
        monthlyCapNanoAud: input.monthlyCapNanoAud, requestCapNanoAud: input.requestCapNanoAud, maxConcurrent: input.maxConcurrent });
      return { projectId: input.projectId, created: true };
    },
    async findProject(projectId) {
      const held = mv.projects.get(projectId);
      return held && { projectId, clientId: 'realbud', version: 1, ...held };
    },
    async mint(input) {
      mv.minted.push(input.label); const key = issue(input.projectId, input.label);
      if (mv.lose === 'mint') { mv.lose = undefined; throw new GatewayError('modelvia_unreachable', 502); }
      return { key: key.key, keyId: key.keyId, baseUrl };
    },
    async listKeys(projectId, environment) {
      return mv.keys.filter(key => key.projectId === projectId).map(key => ({ keyId: key.keyId, projectId, environment, label: key.label, ...(key.revokedAt ? { revokedAt: key.revokedAt } : {}) }));
    },
    async rotate(keyId) {
      const old = mv.keys.find(key => key.keyId === keyId && !key.revokedAt);
      if (!old) throw new GatewayError('modelvia_rejected', 502);
      mv.rotated.push(keyId); old.revokedAt = 1;
      const key = issue(old.projectId, old.label);
      return { key: key.key, keyId: key.keyId, baseUrl, projectId: old.projectId, replaced: keyId };
    },
    async revoke(keyId) {
      if (mv.revokeFails) throw new GatewayError('modelvia_unreachable', 502);
      mv.revoked.push(keyId); const key = mv.keys.find(entry => entry.keyId === keyId); if (key && !key.revokedAt) key.revokedAt = 1;
    },
    async updateProjectCaps(projectId, caps) { mv.capUpdates.push({ projectId, ...caps }); Object.assign(mv.projects.get(projectId)!, caps); return { updated: true, version: 2 }; },
    async readCustomerRecord() { throw new Error('not used by these tests'); },
    async putCustomer() { throw new Error('not used by these tests'); },
    async setCustomerAccess(customerId, input) {
      assert.equal(customerId, CUSTOMER);
      const created = !mv.customer;
      mv.customer ??= { active: true, monthlyCapNanoAud: '200000000000', maxConcurrent: 2 };
      if (input.access.mode === 'disabled') mv.customer.active = false;
      else { mv.customer.active = true; mv.customer.monthlyCapNanoAud = input.access.mode === 'custom' ? input.access.monthlyCapNanoAud : '200000000000'; }
      return { active: mv.customer.active, monthlyCapNanoAud: mv.customer.monthlyCapNanoAud, created };
    },
  };
  /** A model of Modelvia's serving check, not Modelvia: a live key, in an active
   * project, under an active customer with a cap. */
  const serves = (key: string) => {
    const entry = mv.keys.find(candidate => candidate.key === key);
    const project = entry && mv.projects.get(entry.projectId);
    return Boolean(entry && !entry.revokedAt && project?.active && mv.customer?.active && BigInt(mv.customer.monthlyCapNanoAud) > 0n);
  };
  return { composio, org, mv, modelvia, serves };
}

/** One gateway over a file-backed ledger, secret store and registry, built by the
 * production composition. `restart()` drops every in-process object and composes
 * a fresh gateway over the same files. */
const authConfigResponse = () => Response.json({ items: [{ id: 'ac-fictional-readonly', name: 'realbud-gmail-readonly-v1', toolkit: { slug: 'gmail' }, auth_scheme: 'OAUTH2', is_composio_managed: true, status: 'ENABLED', credentials: { scopes: 'https://www.googleapis.com/auth/gmail.readonly' } }], next_cursor: null });

function lifecycle() {
  const root = mkdtempSync(join(tmpdir(), 'realbud-lifecycle-'));
  const dbPath = join(root, 'data', 'ledger.sqlite');
  const f = fixture(dbPath);
  let db = f.db, ledger = f.ledger;
  const v = vendors();
  const env: NodeJS.ProcessEnv = {
    REALBUD_ENABLE_PROVIDER: '1', REALBUD_GATEWAY_SECRETS_DIR: join(root, 'secrets'), REALBUD_GATEWAY_CONNECTOR_REGISTRY: join(root, 'registry', 'devices.json'),
    REALBUD_GATEWAY_PUBLIC_ORIGIN: 'https://managed.example.invalid', REALBUD_COMPOSIO_ORG_KEY: ORG_KEY,
    REALBUD_MODELVIA_BASE_URL: 'https://api.modelvia.dev', REALBUD_MODELVIA_SCOPED_SECRET: 'fictional-modelvia-operator-secret-32ch',
    REALBUD_MODELVIA_OPERATOR_SUBJECT: 'realbud-provisioning', REALBUD_MODELVIA_CLIENT_ID: 'realbud', REALBUD_MODELVIA_MODELS: 'fictional-model',
  };
  /** Every project key the Composio adapter was handed, in order. */
  const keysSeen: string[] = [];
  const connectorAdapters = {
    access: async (binding: GmailReadOnlyBinding) => {
      keysSeen.push(binding.apiKey);
      return { checkedAt: new Date(f.now()).toISOString(), services: { gmail: { connected: true, status: 'ACTIVE', accounts: [{ id: ACCOUNT, status: 'ACTIVE' }], accountSelectionRequired: false } }, tools: { available: true, names: ['GMAIL_GET_PROFILE'] } };
    },
    authorize: async (binding: GmailReadOnlyBinding) => {
      keysSeen.push(binding.apiKey);
      return { url: 'https://accounts.example.invalid/consent', accountId: ACCOUNT, expiresAt: new Date(f.now() + 600_000).toISOString() };
    },
    scan: async (binding: GmailReadOnlyBinding) => {
      keysSeen.push(binding.apiKey);
      return { accountId: ACCOUNT, windowStartAt: f.now() - 86_400_000, windowEndAt: f.now(), pages: 1, paginationComplete: true, threads: [], gaps: [] } satisfies MailScanResult;
    },
  } as unknown as Pick<ConnectorOptions, 'access' | 'authorize' | 'scan'>;
  const portal = { async authenticate(token: string) { if (token !== 'fictional-portal-token') throw new Error('no'); return f.owner; } };
  const never: HttpTransport = async (url, init) => { if (url.startsWith('https://backend.composio.dev/api/v3.1/auth_configs?') && init.method === 'GET') return authConfigResponse(); throw new Error('no network in tests'); };
  const compose = (): GatewayComposition => composeGateway({ env, ledger, fetch: never, portal, allowedOrigins: new Set(), org: v.org, modelvia: v.modelvia, connectorAdapters });
  let gateway = compose();
  const request = (installationId: string) => ({ companyId: f.tenant.companyId, installationId, customerId: CUSTOMER, profile: 'property' });
  const keyEnv = `REALBUD_COMPOSIO_PROJECT_${f.tenant.companyId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const later = () => f.setTime(f.now() + PENDING_RESUME_AFTER_MS);
  return {
    f, v, env, root, keyEnv, keysSeen, request, later,
    ledger: () => ledger,
    gateway: () => gateway,
    provisioning: () => gateway.server.provisioning!,
    provision: (installationId: string, actor: PortalPrincipal = f.owner) => gateway.server.provisioning!.provision(actor, request(installationId)),
    revoke: (installationId: string, deleteProject?: boolean) => gateway.server.provisioning!.revoke(f.owner, { companyId: f.tenant.companyId, installationId, ...(deleteProject === undefined ? {} : { deleteProject }) }),
    connector: (token: string, path = '/v1/connectors/status', method = 'GET', body?: unknown) =>
      gateway.server.connectors!.handle({ token, profile: 'property', method, path, body, signal: new AbortController().signal }),
    /** A fresh store over the same directory, as a restarted process would open. */
    secrets: (): SecretStore => fileSecretStore(env.REALBUD_GATEWAY_SECRETS_DIR!),
    devices: () => validateConnectorDevices(JSON.parse(readFileSync(env.REALBUD_GATEWAY_CONNECTOR_REGISTRY!, 'utf8'))),
    events: () => ledger.db.all<{ kind: string; body: string }>('SELECT kind, body FROM events'),
    restart: () => { db.close(); db = new LedgerDatabase(dbPath); ledger = new UsageLedger(db, f.now); gateway = compose(); },
    close: () => { try { db.close(); } catch { /* already closed */ } rmSync(root, { recursive: true, force: true }); },
  };
}
type Lifecycle = ReturnType<typeof lifecycle>;
const scanBody = (h: Lifecycle) => ({ expectedAccountId: ACCOUNT, scope: { windowStartAt: h.f.now() - 7 * 86_400_000, windowEndAt: h.f.now(), includeSent: true, maxMessages: 100, carryThreadIds: [] } });

// ---------------------------------------------------------------------------
// The confirmed defect: connectors read the store provisioning writes
// ---------------------------------------------------------------------------

test('composition: a freshly provisioned device reads its office key from the provisioning store for status, authorize and mail scan', async () => {
  const h = lifecycle(); try {
    assert.equal(h.gateway().provisioning, 'composed');
    const first = (await h.provision('install-one')).provisioning;
    // The key lives only in the store; the environment has no such variable.
    assert.equal(h.env[h.keyEnv], undefined);
    assert.equal(h.secrets().read(h.keyEnv), `${PROJECT_KEY}1`);
    const token = first.connector.credential!;
    const status = await h.connector(token);
    assert.equal(status.status, 200);
    assert.equal((status.body as { managed: boolean }).managed, true);
    assert.equal((await h.connector(token, '/v1/connectors/authorize', 'POST', { app: 'gmail' })).status, 200);
    const scan = await h.connector(token, '/v1/connectors/mail-scan', 'POST', scanBody(h));
    assert.equal((scan.body as MailScanResult).accountId, ACCOUNT);
    assert.deepEqual(h.keysSeen, [`${PROJECT_KEY}1`, `${PROJECT_KEY}1`, `${PROJECT_KEY}1`]);
    // Never reflected to the desktop.
    assert.ok(![status, scan].some(reply => JSON.stringify(reply).includes(PROJECT_KEY)));
  } finally { h.close(); }
});

test('composition: a key missing from the store is connector_not_configured, and a legacy key named in the environment still serves', async () => {
  const h = lifecycle(); try {
    const token = (await h.provision('install-one')).provisioning.connector.credential!;
    h.secrets().remove(h.keyEnv);
    assert.equal((await failure(h.connector(token)))?.code, 'connector_not_configured');
    assert.deepEqual(h.keysSeen, []);
    // A device the operator CLI registered before provisioning names a deployment variable.
    h.env[h.keyEnv] = 'ak_fictional_legacy_env_key';
    h.restart();
    assert.equal((await h.connector(token)).status, 200);
    assert.deepEqual(h.keysSeen, ['ak_fictional_legacy_env_key']);
    // The store wins over the environment when both hold a value.
    h.secrets().write(h.keyEnv, `${PROJECT_KEY}store`);
    await h.connector(token);
    assert.equal(h.keysSeen.at(-1), `${PROJECT_KEY}store`);
  } finally { h.close(); }
});

test('composition: the store is still read when provisioning is not composed', async () => {
  const h = lifecycle(); try {
    const token = (await h.provision('install-one')).provisioning.connector.credential!;
    h.env.REALBUD_ENABLE_PROVIDER = '0';
    h.restart();
    assert.equal(h.gateway().provisioning, 'provisioning_disabled');
    assert.equal((await h.connector(token)).status, 200);
    assert.deepEqual(h.keysSeen, [`${PROJECT_KEY}1`]);
  } finally { h.close(); }
});

test('composition: revoke with deleteProject removes the stored key and the connector is refused, across a restart', async () => {
  const h = lifecycle(); try {
    const token = (await h.provision('install-one')).provisioning.connector.credential!;
    h.restart();
    const revoked = (await h.revoke('install-one', true)).revoked;
    assert.equal(revoked.projectDeleted, true);
    assert.equal(h.secrets().read(h.keyEnv), undefined);
    assert.deepEqual(h.v.composio.deleted, ['pr_fictional1']);
    h.restart();
    assert.equal((await failure(h.connector(token)))?.code, 'connector_access_denied');
    assert.deepEqual(h.keysSeen, []);
  } finally { h.close(); }
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test('1. first computer: office Composio project created and key stored; Modelvia project under the customer with its caps; labelled key', async () => {
  const h = lifecycle(); try {
    const first = (await h.provision('install-one')).provisioning;
    assert.deepEqual(h.v.composio.created, [`realbud-${h.f.tenant.companyId}`]);
    assert.equal(first.connector.projectId, 'pr_fictional1');
    assert.equal(h.secrets().read(h.keyEnv), `${PROJECT_KEY}1`);
    assert.equal(first.model.projectId, 'rb-install-one');
    assert.deepEqual(h.v.mv.projects.get('rb-install-one'), { customerId: CUSTOMER, active: true, environments: ['production'], ...PROJECT_CAPS });
    assert.deepEqual(h.v.mv.minted, [`${h.f.tenant.companyId}:install-one`]);
    assert.ok(h.v.serves(first.model.key!));
    const device = h.devices()[0]!;
    assert.equal(device.projectKeyEnv, h.keyEnv);
    assert.equal(device.installationId, 'install-one');
  } finally { h.close(); }
});

test('2. second computer of the office reuses the office project and key and gets its own Modelvia project and key', async () => {
  const h = lifecycle(); try {
    const one = (await h.provision('install-one')).provisioning;
    const two = (await h.provision('install-two')).provisioning;
    assert.deepEqual(h.v.composio.created, [`realbud-${h.f.tenant.companyId}`]);
    assert.equal(two.connector.projectId, one.connector.projectId);
    assert.deepEqual([...h.v.mv.projects.keys()], ['rb-install-one', 'rb-install-two']);
    assert.deepEqual(h.v.mv.minted, [`${h.f.tenant.companyId}:install-one`, `${h.f.tenant.companyId}:install-two`]);
    assert.notEqual(one.model.key, two.model.key);
    assert.notEqual(one.connector.credential, two.connector.credential);
    assert.deepEqual(h.devices().map(device => device.projectKeyEnv), [h.keyEnv, h.keyEnv]);
    // Both computers' connectors reach Composio with the one office key.
    await h.connector(one.connector.credential!); await h.connector(two.connector.credential!);
    assert.deepEqual(h.keysSeen, [`${PROJECT_KEY}1`, `${PROJECT_KEY}1`]);
  } finally { h.close(); }
});

test('3. a repeat provision of a ready computer, after a restart, returns the stored descriptor without secrets and touches no vendor', async () => {
  const h = lifecycle(); try {
    const first = (await h.provision('install-one')).provisioning;
    const reads = h.v.mv.customerReads, lists = h.v.composio.lists;
    h.restart();
    const repeat = (await h.provision('install-one')).provisioning;
    assert.equal(repeat.model.key, undefined); assert.equal(repeat.connector.credential, undefined);
    const { key: _key, ...model } = first.model, { credential: _credential, ...connector } = first.connector;
    assert.deepEqual(repeat, { ...first, model, connector } satisfies ProvisioningDescriptor);
    assert.equal(h.v.mv.customerReads, reads); assert.equal(h.v.composio.lists, lists);
    assert.equal(h.v.mv.minted.length, 1); assert.deepEqual(h.v.mv.rotated, []);
    // The delivered credential still works after the restart.
    assert.equal((await h.connector(first.connector.credential!)).status, 200);
  } finally { h.close(); }
});

test('4. a lost mint reply is resumed after a restart and the window by rotating the one labelled key', async () => {
  const h = lifecycle(); try {
    h.v.mv.lose = 'mint';
    assert.equal((await failure(h.provision('install-one')))?.code, 'modelvia_unreachable');
    h.restart();
    // Inside the window the earlier attempt may still be running.
    assert.equal((await failure(h.provision('install-one')))?.code, 'installation_provisioning_in_progress');
    h.later(); h.restart();
    const resumed = (await h.provision('install-one')).provisioning;
    assert.deepEqual(h.v.mv.rotated, ['0000000000000001']);
    assert.equal(resumed.model.keyId, '0000000000000002');
    assert.equal(h.v.mv.keys.filter(key => !key.revokedAt).length, 1);
    assert.ok(h.v.serves(resumed.model.key!));
    assert.equal(h.v.mv.projects.size, 1); assert.equal(h.v.composio.created.length, 1); assert.equal(h.devices().length, 1);
    assert.equal((await h.connector(resumed.connector.credential!)).status, 200);
  } finally { h.close(); }
});

test('4. a resume that finds two keys it cannot attribute stops for an operator and touches no key', async () => {
  const h = lifecycle(); try {
    h.v.mv.lose = 'mint';
    await failure(h.provision('install-one'));
    // A second live key with the same label, made by nobody this ledger knows.
    h.v.mv.keys.push({ keyId: '00000000000000ff', key: 'rbk_00000000000000ff_fictional', projectId: 'rb-install-one', label: `${h.f.tenant.companyId}:install-one` });
    h.later(); h.restart();
    assert.equal((await failure(h.provision('install-one')))?.code, 'modelvia_keys_ambiguous');
    assert.deepEqual(h.v.mv.rotated, []); assert.equal(h.v.mv.minted.length, 1);
    assert.equal(h.v.mv.keys.filter(key => !key.revokedAt).length, 2);
  } finally { h.close(); }
});

test('5. a Composio project whose key could not be stored is deleted, and a later resume creates one cleanly', async () => {
  const h = lifecycle(); try {
    let fail = true;
    const store = h.secrets();
    const flaky: SecretStore = { read: name => store.read(name), remove: name => store.remove(name),
      write: (name, value) => { if (fail) { fail = false; throw new Error('disk full'); } store.write(name, value); } };
    const make = () => new InstallationProvisioning({ ledger: h.ledger(), registry: h.env.REALBUD_GATEWAY_CONNECTOR_REGISTRY!, endpoint: 'https://managed.example.invalid',
      secrets: flaky, org: h.v.org, modelvia: h.v.modelvia, authConfigs: { resolveGmail: async () => 'ac-fictional-readonly' } });
    const error = await failure(make().provision(h.f.owner, h.request('install-one')));
    assert.equal(error?.code, 'connector_project_key_unwritable');
    assert.deepEqual(h.v.composio.deleted, ['pr_fictional1']); assert.deepEqual(h.v.composio.projects, []);
    assert.equal(store.read(h.keyEnv), undefined);
    // Nothing after the Composio step ran.
    assert.equal(h.v.mv.projects.size, 0); assert.equal(existsSync(h.env.REALBUD_GATEWAY_CONNECTOR_REGISTRY!), false);
    const line = h.events().find(row => row.kind === 'connector_project_key_unwritable')!;
    assert.deepEqual(JSON.parse(line.body), { installationId: 'install-one', projectId: 'pr_fictional1', projectDeleted: true });
    h.later();
    const resumed = (await make().provision(h.f.owner, h.request('install-one'))).provisioning;
    assert.equal(resumed.connector.projectId, 'pr_fictional2');
    assert.equal(store.read(h.keyEnv), `${PROJECT_KEY}2`);
  } finally { h.close(); }
});

test('5. when neither the key write nor the cleanup delete succeeds, every later attempt stops for an operator', async () => {
  const h = lifecycle(); try {
    const store = h.secrets();
    const broken: SecretStore = { read: name => store.read(name), remove: name => store.remove(name), write: () => { throw new Error('disk full'); } };
    h.v.composio.deleteFails = true;
    const make = () => new InstallationProvisioning({ ledger: h.ledger(), registry: h.env.REALBUD_GATEWAY_CONNECTOR_REGISTRY!, endpoint: 'https://managed.example.invalid',
      secrets: broken, org: h.v.org, modelvia: h.v.modelvia, authConfigs: { resolveGmail: async () => 'ac-fictional-readonly' } });
    assert.equal((await failure(make().provision(h.f.owner, h.request('install-one'))))?.code, 'connector_project_key_unavailable');
    h.later();
    // The project is there without its key: never regenerated, never duplicated.
    assert.equal((await failure(h.provision('install-one')))?.code, 'connector_project_key_unavailable');
    assert.equal(h.v.composio.created.length, 1);
  } finally { h.close(); }
});

test('5. a stored key whose Composio project is gone, and two projects with the office name, both stop for an operator', async () => {
  const h = lifecycle(); try {
    h.secrets().write(h.keyEnv, `${PROJECT_KEY}orphan`);
    assert.equal((await failure(h.provision('install-one')))?.code, 'connector_project_key_orphaned');
    assert.deepEqual(h.v.composio.created, []);
  } finally { h.close(); }
  const twin = lifecycle(); try {
    twin.secrets().write(twin.keyEnv, `${PROJECT_KEY}held`);
    twin.v.composio.projects.push({ id: 'pr_fictionalA', name: `realbud-${twin.f.tenant.companyId}` }, { id: 'pr_fictionalB', name: `realbud-${twin.f.tenant.companyId}` });
    assert.equal((await failure(twin.provision('install-one')))?.code, 'connector_project_ambiguous');
    assert.deepEqual(twin.v.composio.created, []); assert.equal(twin.v.mv.projects.size, 0);
  } finally { twin.close(); }
});

test('5. two first computers of one office provisioning at once create one Composio project and both work', async () => {
  const h = lifecycle(); try {
    const [one, two] = await Promise.all([h.provision('install-one'), h.provision('install-two')]);
    assert.deepEqual(h.v.composio.created, [`realbud-${h.f.tenant.companyId}`]);
    assert.equal(one.provisioning.connector.projectId, two.provisioning.connector.projectId);
    assert.equal(h.devices().length, 2);
    await h.connector(one.provisioning.connector.credential!); await h.connector(two.provisioning.connector.credential!);
    assert.deepEqual(h.keysSeen, [`${PROJECT_KEY}1`, `${PROJECT_KEY}1`]);
  } finally { h.close(); }
});

test('6. deleting the office project is refused while another computer still uses it; the last computer may delete it', async () => {
  const h = lifecycle(); try {
    const one = (await h.provision('install-one')).provisioning, two = (await h.provision('install-two')).provisioning;
    const refused = await failure(h.revoke('install-one', true));
    assert.equal(refused?.code, 'connector_project_in_use'); assert.equal(refused?.status, 409);
    // Refused before any effect: install-one is still fully live.
    assert.deepEqual(h.devices().map(device => device.active), [true, true]);
    assert.deepEqual(h.v.mv.revoked, []); assert.deepEqual(h.v.composio.deleted, []);
    assert.equal((await h.connector(one.connector.credential!)).status, 200);
    // Revoking one computer without deleting leaves the other served with the office key.
    await h.revoke('install-one');
    assert.equal(h.secrets().read(h.keyEnv), `${PROJECT_KEY}1`);
    assert.equal((await h.connector(two.connector.credential!)).status, 200);
    assert.equal((await failure(h.connector(one.connector.credential!)))?.code, 'connector_access_denied');
    assert.ok(!h.v.serves(one.model.key!)); assert.ok(h.v.serves(two.model.key!));
    // The last computer of the office may delete the project and its key.
    assert.equal((await h.revoke('install-two', true)).revoked.projectDeleted, true);
    assert.equal(h.secrets().read(h.keyEnv), undefined);
    assert.deepEqual(h.v.composio.deleted, ['pr_fictional1']);
  } finally { h.close(); }
});

test('6. a pending computer also holds the office project, so deleting it is refused', async () => {
  const h = lifecycle(); try {
    await h.provision('install-one');
    h.v.mv.lose = 'mint';
    await failure(h.provision('install-two'));
    assert.equal((await failure(h.revoke('install-one', true)))?.code, 'connector_project_in_use');
  } finally { h.close(); }
});

test('6. revoke is idempotent across a restart, refuses a pending computer, and works after the entitlement lapsed', async () => {
  const h = lifecycle(); try {
    const one = (await h.provision('install-one')).provisioning;
    h.ledger().setService(h.f.tenant.companyId, true, h.f.now(), 'fixture-lapsed');
    assert.equal((await failure(h.provision('install-two')))?.code, 'service_unavailable');
    const first = (await h.revoke('install-one')).revoked;
    assert.equal(first.modelKeyRevoked, true);
    assert.ok(!h.v.serves(one.model.key!));
    h.restart();
    assert.deepEqual((await h.revoke('install-one')).revoked, first);
    assert.deepEqual(h.v.mv.revoked, [one.model.keyId]);
    assert.equal(h.events().filter(row => row.kind === 'installation_revoked').length, 1);
    // A revoked computer is never silently provisioned again.
    h.ledger().setService(h.f.tenant.companyId, true, h.f.now() + 86_400_000, 'fixture-renewed');
    assert.equal((await failure(h.provision('install-one')))?.code, 'installation_revoked');
    // A pending computer's outcome is unknown: revoke refuses rather than guess.
    h.v.mv.lose = 'mint';
    await failure(h.provision('install-two'));
    assert.equal((await failure(h.revoke('install-two')))?.code, 'installation_provisioning_outcome_unknown');
  } finally { h.close(); }
});

test('6. a revoke interrupted after its Modelvia call, or after the Composio delete, completes on retry', async () => {
  const h = lifecycle(); try {
    const one = (await h.provision('install-one')).provisioning;
    h.v.mv.revokeFails = true;
    assert.equal((await failure(h.revoke('install-one', true)))?.code, 'modelvia_unreachable');
    // Reads stopped first; nothing irreversible happened yet.
    assert.equal(h.devices()[0]!.active, false); assert.deepEqual(h.v.composio.deleted, []);
    h.v.mv.revokeFails = false;
    // Next, the delete goes through but the key removal fails, so the record stays ready.
    const store = h.secrets(); let fail = true;
    const flaky: SecretStore = { read: name => store.read(name), write: (name, value) => store.write(name, value),
      remove: name => { if (fail) { fail = false; throw new Error('io'); } store.remove(name); } };
    const make = () => new InstallationProvisioning({ ledger: h.ledger(), registry: h.env.REALBUD_GATEWAY_CONNECTOR_REGISTRY!, endpoint: 'https://managed.example.invalid',
      secrets: flaky, org: h.v.org, modelvia: h.v.modelvia, authConfigs: { resolveGmail: async () => 'ac-fictional-readonly' } });
    await assert.rejects(() => make().revoke(h.f.owner, { companyId: h.f.tenant.companyId, installationId: 'install-one', deleteProject: true }));
    assert.deepEqual(h.v.composio.deleted, ['pr_fictional1']);
    h.restart();
    const done = (await h.revoke('install-one', true)).revoked;
    assert.equal(done.projectDeleted, true); assert.equal(done.projectAlreadyAbsent, true);
    assert.deepEqual(h.v.composio.deleted, ['pr_fictional1']);
    assert.equal(h.secrets().read(h.keyEnv), undefined);
    assert.ok(!h.v.serves(one.model.key!));
  } finally { h.close(); }
});

test('7. a Modelvia customer not ready, and a missing, lapsed or suspended entitlement, are refused before any effect', async () => {
  const cases: { name: string; code: string; status: number; arrange: (h: Lifecycle) => PortalPrincipal }[] = [
    { name: 'missing customer', code: 'modelvia_customer_not_ready', status: 409, arrange: h => { h.v.mv.customer = null; return h.f.owner; } },
    { name: 'inactive customer', code: 'modelvia_customer_not_ready', status: 409, arrange: h => { h.v.mv.customer = { active: false, ...CAPS }; return h.f.owner; } },
    { name: 'zero cap', code: 'modelvia_customer_not_ready', status: 409, arrange: h => { h.v.mv.customer = { active: true, monthlyCapNanoAud: '0', maxConcurrent: 3 }; return h.f.owner; } },
    // The Modelvia client reports another platform client's customer as absent.
    { name: 'foreign customer', code: 'modelvia_customer_not_ready', status: 409, arrange: h => { h.v.modelvia.findCustomer = async () => null; return h.f.owner; } },
    { name: 'no entitlement', code: 'tenant_unavailable', status: 403, arrange: h => ({ ...h.f.owner, companyId: 'company-without-entitlement' }) },
    { name: 'lapsed entitlement', code: 'service_unavailable', status: 402, arrange: h => { h.ledger().setService(h.f.tenant.companyId, true, h.f.now(), 'fixture-lapsed'); return h.f.owner; } },
    { name: 'suspended entitlement', code: 'service_unavailable', status: 402, arrange: h => { h.ledger().setService(h.f.tenant.companyId, false, h.f.now() + 86_400_000, 'fixture-suspended'); return h.f.owner; } },
  ];
  for (const entry of cases) {
    const h = lifecycle(); try {
      const actor = entry.arrange(h);
      const body = { ...h.request('install-one'), companyId: actor.companyId };
      const error = await failure(h.provisioning().provision(actor, body));
      assert.equal(error?.code, entry.code, entry.name); assert.equal(error?.status, entry.status, entry.name);
      assert.equal(h.ledger().db.get('SELECT tenant FROM installation_provisioning'), undefined, entry.name);
      assert.equal(h.v.composio.lists, 0, entry.name); assert.equal(h.v.mv.projects.size, 0, entry.name);
      assert.equal(existsSync(h.env.REALBUD_GATEWAY_CONNECTOR_REGISTRY!), false, entry.name);
      if (entry.code !== 'modelvia_customer_not_ready') assert.equal(h.v.mv.customerReads, 0, entry.name);
    } finally { h.close(); }
  }
});

test('6. a computer removed while its first provision waits on Modelvia is never provisioned', async () => {
  const h = lifecycle(); try {
    const original = h.v.modelvia.findCustomer.bind(h.v.modelvia);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    h.v.modelvia.findCustomer = async (id: string) => { await gate; return original(id); };
    const provisioning = h.provisioning();
    const inFlight = failure(provisioning.provision(h.f.owner, h.request('install-one')));
    const revoked = await failure(provisioning.revoke(h.f.owner, { companyId: h.f.tenant.companyId, installationId: 'install-one' }));
    assert.equal(revoked?.code, 'installation_not_provisioned');
    release();
    assert.equal((await inFlight)?.code, 'installation_revoked');
    assert.equal(h.v.mv.projects.size, 0); assert.equal(h.v.composio.lists, 0);
    // A second removal and a later provision both see the tombstone.
    assert.equal((await failure(provisioning.provision(h.f.owner, h.request('install-one'))))?.code, 'installation_revoked');
    assert.equal((await failure(provisioning.revoke(h.f.owner, { companyId: h.f.tenant.companyId, installationId: 'install-one' })))?.code, 'installation_not_provisioned');
  } finally { h.close(); }
});

test('8. AI access disabled after provisioning stops serving and new provisioning; re-enabled with a new cap, it is pushed to every project', async () => {
  const h = lifecycle(); try {
    const one = (await h.provision('install-one')).provisioning, two = (await h.provision('install-two')).provisioning;
    const service = new OfficeAiAccessService({ ledger: h.ledger(), modelvia: h.v.modelvia });
    const operator: OperatorPrincipal = { subject: 'operator:ops@example.invalid', role: OPERATOR_ROLE };
    const set = (access: unknown) => service.set(operator, { companyId: h.f.tenant.companyId, customerId: CUSTOMER, name: 'Fictional Office', access });
    const disabled = await set({ mode: 'disabled' });
    assert.deepEqual(disabled.projects, []); assert.equal(h.v.mv.capUpdates.length, 0);
    // Modelvia (as modelled) refuses both computers' keys; the gateway refuses a new computer.
    assert.ok(!h.v.serves(one.model.key!) && !h.v.serves(two.model.key!));
    assert.equal((await failure(h.provision('install-three')))?.code, 'modelvia_customer_not_ready');
    // Existing connectors follow the entitlement, not AI access.
    assert.equal((await h.connector(one.connector.credential!)).status, 200);
    const enabled = await set({ mode: 'custom', monthlyCapNanoAud: '90000000000' });
    assert.deepEqual(enabled.projects, [{ installationId: 'install-one', state: 'applied' }, { installationId: 'install-two', state: 'applied' }]);
    assert.deepEqual(h.v.mv.capUpdates.map(update => [update.projectId, update.monthlyCapNanoAud, update.maxConcurrent]),
      [['rb-install-one', '90000000000', 3], ['rb-install-two', '90000000000', 3]]);
    assert.ok(h.v.serves(one.model.key!) && h.v.serves(two.model.key!));
    // The repeat descriptor reports the caps now in force, still without a key.
    const repeat = (await h.provision('install-one')).provisioning;
    assert.equal(repeat.model.spendCapLabel, 'A$90/month, A$4/request, 3 at once'); assert.equal(repeat.model.key, undefined);
  } finally { h.close(); }
});

test('10. the model key never reaches a log line, an audit line, a stored record, the registry or /ready', async () => {
  const h = lifecycle();
  const logged: string[] = [];
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const level of ['log', 'info', 'warn', 'error'] as const) console[level] = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  const server = createGatewayServer(h.gateway().server);
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { authorization: 'Bearer fictional-portal-token', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    h.v.mv.lose = 'mint';
    assert.equal((await post('/v1/portal/installations/provision', h.request('install-one'))).status, 502);
    h.later();
    const created = await post('/v1/portal/installations/provision', h.request('install-one'));
    assert.equal(created.status, 200);
    const delivered = (await created.json() as { provisioning: ProvisioningDescriptor }).provisioning;
    const repeat = await (await post('/v1/portal/installations/provision', h.request('install-one'))).text();
    const ready = await (await fetch(`${base}/ready`)).text();
    assert.deepEqual(JSON.parse(ready), { ready: true, provisioning: 'composed', modelviaOperator: 'configured', operatorAccess: 'missing' });
    assert.equal((await post('/v1/portal/installations/revoke', { companyId: h.f.tenant.companyId, installationId: 'install-one' })).status, 200);
    const modelKeys = h.v.mv.keys.map(key => key.key);
    assert.ok(modelKeys.includes(delivered.model.key!)); assert.equal(modelKeys.length, 2);
    const stored = h.ledger().db.all<{ body: string }>('SELECT body FROM installation_provisioning').map(row => row.body).join('\n');
    const audit = h.events().map(row => row.body).join('\n');
    const registry = readFileSync(h.env.REALBUD_GATEWAY_CONNECTOR_REGISTRY!, 'utf8');
    const secretFiles = readdirSync(h.env.REALBUD_GATEWAY_SECRETS_DIR!).map(name => readFileSync(join(h.env.REALBUD_GATEWAY_SECRETS_DIR!, name), 'utf8')).join('\n');
    // Both the lost key and the delivered one, plus the connector credential.
    for (const secret of [...modelKeys, delivered.connector.credential!]) {
      for (const [where, text] of [['logs', logged.join('\n')], ['audit', audit], ['stored record', stored], ['registry', registry], ['secret store', secretFiles], ['/ready', ready], ['repeat', repeat]] as const) {
        assert.ok(!text.includes(secret), `${where} carries ${secret.slice(0, 8)}…`);
      }
    }
    // The office project key is in the store and nowhere else.
    for (const text of [logged.join('\n'), audit, stored, registry, ready, repeat, JSON.stringify(delivered)]) assert.ok(!text.includes(PROJECT_KEY));
  } finally {
    Object.assign(console, original);
    await new Promise<void>(resolve => server.close(() => resolve()));
    h.close();
  }
});
