/**
 * Cross-component contract: a descriptor the managed gateway really builds
 * (`managed-gateway/provisioning.ts`, over fake Composio and Modelvia) must be
 * accepted by the desktop's parser (`shared/office-link.ts`) and applied by
 * the desktop's grant path (`server/worker-model-access.ts`), for every cap an
 * office can hold. Before 25 September 2026 the gateway's label was 82
 * characters and the parser stopped at 80, so a link failed only after the
 * website had already recorded the installation as provisioned.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fixture } from '../managed-gateway/testing.ts';
import { fileSecretStore, InstallationProvisioning, SPEND_CAP_LABEL_MAX, type ProvisioningDescriptor } from '../managed-gateway/provisioning.ts';
import type { ComposioOrgClient } from '../managed-gateway/composio-org.ts';
import type { ModelviaClient, ModelviaCustomer } from '../managed-gateway/modelvia-keys.ts';
import { parseInstallationProvisioning } from '../shared/office-link.ts';
import { createWorkerModelAccess, setWorkerModelGrant } from './worker-model-access.ts';
import { HERMES_PIN } from './hermes-pin.ts';
import { privateFixtureDirectory, privateFixtureRoot, writePrivateFixtureFile, WINDOWS_PROFILE_TEST_OPTIONS } from './testing/private-profile-fixture.ts';

const roots: string[] = [];
afterEach(() => { setWorkerModelGrant({ state: 'none' }); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** The gateway as production composes it, over stateless vendor fakes. */
function gateway(customer: ModelviaCustomer) {
  const f = fixture();
  const root = mkdtempSync(join(tmpdir(), 'realbud-contract-gateway-')); roots.push(root);
  const org: ComposioOrgClient = {
    async listProjects() { return []; },
    async createProject(name) { return { id: 'pr_fictional_contract', name, apiKey: 'ak_fictional_office_project_key_' }; },
    async deleteProject() { throw new Error('not used'); },
  };
  let minted = 0;
  const modelvia: ModelviaClient = {
    environment: 'production',
    async findCustomer(customerId) { return customerId === 'cus-fictional-office' ? { ...customer } : null; },
    async createProject(input) { return { projectId: input.projectId, created: true }; },
    async findProject() { return undefined; },
    async mint() { minted++; const keyId = minted.toString(16).padStart(16, '0'); return { key: `rbk_${keyId}_${'A'.repeat(43)}`, keyId, baseUrl: 'https://api.modelvia.dev/v1' }; },
    async listKeys() { return []; },
    async rotate() { throw new Error('not used'); },
    async revoke() {},
    async updateProjectCaps() { return { updated: true, version: 2 }; },
  };
  const provisioning = new InstallationProvisioning({ ledger: f.ledger, registry: join(root, 'registry', 'devices.json'), endpoint: 'https://managed.example.invalid',
    secrets: fileSecretStore(join(root, 'secrets')), org, modelvia, authConfigs: { gmail: 'ac-fictional-readonly' } });
  const provision = async (installationId: string) => (await provisioning.provision(f.owner, { companyId: f.tenant.companyId, installationId, customerId: 'cus-fictional-office', profile: HERMES_PIN.profile })).provisioning;
  return { f, provision, close: () => f.close() };
}

/** The desktop's grant path over a private worker profile, as the installed pack lays it out. */
function desktop() {
  const root = privateFixtureRoot(join(tmpdir(), 'realbud-contract-desktop-')); roots.push(root);
  const hermesRoot = join(root, 'hermes');
  privateFixtureDirectory(join(hermesRoot, 'profiles', HERMES_PIN.profile));
  writePrivateFixtureFile(join(hermesRoot, 'profiles', HERMES_PIN.profile, 'SOUL.md'), '# RealBud\n');
  const saved: unknown[] = [];
  return { root, saved, access: createWorkerModelAccess({ directory: root, key: Buffer.alloc(32, 7), hermesRoot, saveConfig: patch => { saved.push(patch); } }) };
}

/** As the website forwards it: one JSON round trip, nothing reshaped. */
const wire = (descriptor: ProvisioningDescriptor): unknown => JSON.parse(JSON.stringify(descriptor));

describe('gateway descriptor → desktop grant', WINDOWS_PROFILE_TEST_OPTIONS, () => {
  it.each([
    ['A$1 a month, one turn at a time', { active: true, monthlyCapNanoAud: '1000000000', maxConcurrent: 1 }, 'A$1/month, A$1/request, 1 at once'],
    ['the A$200 default, two at once', { active: true, monthlyCapNanoAud: '200000000000', maxConcurrent: 2 }, 'A$200/month, A$1/request, 2 at once'],
    ['the A$10,000 ceiling, one hundred at once', { active: true, monthlyCapNanoAud: '10000000000000', maxConcurrent: 100 }, 'A$10,000/month, A$1/request, 100 at once'],
  ])('applies the descriptor the gateway builds for %s', async (_name, customer, label) => {
    const g = gateway(customer); const d = desktop();
    try {
      const descriptor = await g.provision('install-one');
      expect(descriptor.model.spendCapLabel).toBe(label);
      expect(descriptor.model.spendCapLabel.length).toBeLessThanOrEqual(SPEND_CAP_LABEL_MAX);
      // Both project identifiers travel: the connector's is metadata the
      // website records, the model's is the installation's Modelvia project.
      expect(descriptor.connector.projectId).toBe('pr_fictional_contract');
      expect(descriptor.model.projectId).toBe('rb-install-one');

      const parsed = parseInstallationProvisioning(wire(descriptor));
      if (!parsed || 'skipped' in parsed) throw new Error('the desktop refused the gateway descriptor');
      expect(parsed.service).toEqual({ companyId: g.f.tenant.companyId, hostInstallationId: 'install-one' });
      expect(parsed.connector).toEqual({ endpoint: 'https://managed.example.invalid', credential: descriptor.connector.credential, profile: HERMES_PIN.profile, apps: ['gmail'] });
      expect(parsed.model).toEqual({ provider: 'modelvia', baseUrl: 'https://api.modelvia.dev/v1', projectId: 'rb-install-one', key: descriptor.model.key, keyId: descriptor.model.keyId, spendCapLabel: label });

      await d.access.apply(parsed, 'fictional-link-id');
      expect(await d.access.state()).toMatchObject({ provisioned: true, withdrawn: false, installationId: 'fictional-link-id', projectId: 'rb-install-one', keyId: descriptor.model.keyId, baseUrl: 'https://api.modelvia.dev/v1', spendCapLabel: label, apps: ['gmail'] });
      expect(await d.access.env()).toEqual({ OPENAI_BASE_URL: 'https://api.modelvia.dev/v1', OPENAI_API_KEY: descriptor.model.key });
      // The scoped connector credential reaches the workspace; the office's project key never left the gateway.
      expect(d.saved).toEqual([{ composio: { managed: { endpoint: 'https://managed.example.invalid', credential: descriptor.connector.credential, profile: HERMES_PIN.profile }, key: '', apiKey: '', url: '', selectedAccounts: {} } }]);
      expect(JSON.stringify(descriptor)).not.toContain('ak_fictional');
    } finally { g.close(); }
  });

  it('accepts the repeat descriptor shape (no secrets) at the parser only as a malformed grant, never as a skip', async () => {
    const g = gateway({ active: true, monthlyCapNanoAud: '200000000000', maxConcurrent: 2 });
    try {
      await g.provision('install-one');
      // The website never forwards this one (it reports `provisioning_attempt_requires_review`
      // instead); if it ever did, the desktop must refuse it rather than half-apply.
      const repeat = await g.provision('install-one');
      expect(repeat.model.key).toBeUndefined();
      expect(() => parseInstallationProvisioning(wire(repeat))).toThrow(/cannot accept/);
    } finally { g.close(); }
  });
});
