/**
 * Offline provisioning smoke. Trusted operator tooling — never an HTTP route.
 *
 *   cd managed-gateway
 *   node --experimental-strip-types sandbox-smoke.ts
 *
 * Runs installation provisioning (provision → connector status → revoke)
 * against injected fakes for the Composio organisation surface, the Modelvia
 * customer read and key minting. It proves the wiring, not the providers: a fake
 * is never evidence that a real organisation key, a real Composio project, a
 * real Modelvia customer or a real Modelvia key was exercised. It uses a
 * throwaway in-memory ledger, reaches no network and prints no secret.
 *
 * The former Square sandbox leg was removed with the gateway's billing
 * (24 September 2026): Modelvia is the only source of AI rates, caps, usage and
 * invoices.
 *
 * Exit code 0 means every provisioning check passed against the fakes.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './testing.ts';
import { ManagedConnectors } from './connectors.ts';
import { fileSecretStore, InstallationProvisioning, type ProvisioningDescriptor } from './provisioning.ts';
import type { ComposioOrgClient } from './composio-org.ts';
import type { ModelviaClient } from './modelvia-keys.ts';

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`);
}

/**
 * Provision an installation, use the issued connector credential against the
 * connector broker, then revoke it. Every provider is a fake: the Composio
 * organisation surface, the Modelvia customer read and key mint, and the Gmail
 * adapter. Nothing here reaches a network, and nothing here proves a real provider.
 */
async function provisioningLeg(): Promise<void> {
  const f = fixture();
  const root = mkdtempSync(join(tmpdir(), 'realbud-smoke-provisioning-'));
  const registry = join(root, 'registry', 'devices.json');
  const projects: { id: string; name: string }[] = [];
  const deleted: string[] = [], revokedKeys: string[] = [];
  const org: ComposioOrgClient = {
    async listProjects() { return projects.map(project => ({ ...project })); },
    async createProject(name) { const project = { id: `pr_smoke_${projects.length + 1}`, name }; projects.push(project); return { ...project, apiKey: 'ak_fictional_smoke_project_key' }; },
    async deleteProject(id) { deleted.push(id); return { revokeJobId: 'job-fictional-smoke' }; },
  };
  const modelProjects: unknown[] = [];
  const modelvia: ModelviaClient = {
    environment: 'production',
    async findCustomer() { return { active: true, monthlyCapNanoAud: '100000000000', maxConcurrent: 4 }; },
    async createProject(input) { modelProjects.push(input); return { projectId: input.projectId, created: true }; },
    async mint() { return { key: `rbk_00112233445566aa_${'S'.repeat(43)}`, keyId: '00112233445566aa', baseUrl: 'https://api.modelvia.dev/v1' }; },
    async revoke(keyId) { revokedKeys.push(keyId); },
    // The smoke only takes the new-project path; recovery paths have their own tests.
    async findProject() { return undefined; },
    async listKeys() { return []; },
    async rotate() { throw new Error('The sandbox smoke never rotates a key.'); },
    async updateProjectCaps() { return { updated: false, version: 0 }; },
  };
  const secrets = fileSecretStore(join(root, 'secrets'));
  try {
    const provisioning = new InstallationProvisioning({ ledger: f.ledger, registry, endpoint: 'https://managed.example.invalid',
      secrets, org, modelvia, authConfigs: { gmail: 'ac-fictional-readonly' } });
    const request = { companyId: f.tenant.companyId, installationId: 'install-smoke', customerId: 'cus-fictional-smoke', profile: 'property' };

    const first = (await provisioning.provision(f.owner, request)).provisioning as ProvisioningDescriptor;
    check('provision issues one scoped connector credential', /^rbc_[a-f0-9]{64}$/.test(first.connector.credential ?? ''), `apps ${first.connector.apps.join(',')}, project ${first.connector.projectId}`);
    check('provision creates one Modelvia project, capped from the customer',
      modelProjects.length === 1 && first.model.projectId === 'rb-install-smoke', `project ${first.model.projectId}`);
    check('provision issues one model key under that project', Boolean(first.model.key) && first.model.keyId === '00112233445566aa', first.model.spendCapLabel);

    const repeat = (await provisioning.provision(f.owner, request)).provisioning as ProvisioningDescriptor;
    check('repeat provision returns the same descriptor without secrets',
      repeat.connector.credential === undefined && repeat.model.key === undefined
      && repeat.model.keyId === first.model.keyId && repeat.connector.projectId === first.connector.projectId,
      `project id ${repeat.connector.projectId} still reported`);
    check('repeat provision mints nothing new', projects.length === 1 && modelProjects.length === 1, `${projects.length} Composio project, ${modelProjects.length} Modelvia project`);

    // The issued credential is what the desktop presents; the registry admits a hash.
    const connectors = new ManagedConnectors({ ledger: f.ledger, devices: () => JSON.parse(readFileSync(registry, 'utf8')).devices,
      secret: name => secrets.read(name),
      access: async () => ({ checkedAt: new Date(f.now()).toISOString(), services: { gmail: { connected: true, status: 'ACTIVE', accounts: [], accountSelectionRequired: true } }, tools: { available: true, names: ['GMAIL_GET_PROFILE'] } }) });
    const status = await connectors.handle({ token: first.connector.credential!, profile: 'property', method: 'GET', path: '/v1/connectors/status', signal: new AbortController().signal });
    check('connector status accepts the issued credential', status.status === 200 && (status.body as { managed: boolean }).managed === true, `apps ${(status.body as { apps: string[] }).apps.join(',')}`);
    check('connector status returns no project key', !JSON.stringify(status.body).includes('ak_fictional'), 'response carries no ak_ value');

    let deniedApp = 'not refused';
    try { await connectors.handle({ token: first.connector.credential!, profile: 'property', method: 'POST', path: '/v1/connectors/authorize', body: { app: 'slack' }, signal: new AbortController().signal }); }
    catch (cause) { deniedApp = cause instanceof Error ? cause.message : String(cause); }
    check('an app outside the allowlist is refused', deniedApp === 'connector_app_not_admitted', deniedApp);

    const revoked = (await provisioning.revoke(f.owner, { companyId: f.tenant.companyId, installationId: 'install-smoke' })).revoked;
    check('revoke deactivates the device and the model key', revoked.connectorDeactivated === true && revokedKeys.length === 1, `model key ${revoked.modelKeyId}`);
    check('revoke leaves the Composio project alone by default', revoked.projectDeleted === false && deleted.length === 0, 'deleteProject was not requested');
    check('revoke retains the Modelvia project for billing history', revoked.modelProjectRetained === 'rb-install-smoke', 'its caps still bound any key under it');

    let afterRevoke = 'still served';
    try { await connectors.handle({ token: first.connector.credential!, profile: 'property', method: 'GET', path: '/v1/connectors/status', signal: new AbortController().signal }); }
    catch (cause) { afterRevoke = cause instanceof Error ? cause.message : String(cause); }
    check('the revoked credential no longer reaches the adapter', afterRevoke === 'connector_access_denied', afterRevoke);
  } finally { rmSync(root, { recursive: true, force: true }); f.close(); }
}

async function main(): Promise<number> {
  process.stdout.write('Installation provisioning against FAKES. Offline; proves wiring, not providers.\n\n');
  await provisioningLeg();
  const failed = checks.filter((row) => !row.ok);
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} provisioning checks passed${failed.length ? ` — FAILED: ${failed.map((r) => r.name).join(', ')}` : ''}\n`);
  return failed.length ? 1 : 0;
}

process.exitCode = await main();
