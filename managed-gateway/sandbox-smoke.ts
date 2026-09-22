/**
 * Smoke test in two legs. Trusted operator tooling — never an HTTP route.
 *
 *   cd managed-gateway
 *   SQUARE_ACCESS_TOKEN=… node --experimental-strip-types sandbox-smoke.ts
 *
 * Leg 1 — installation provisioning, OFFLINE, against injected fakes for the
 * Composio organisation surface and Modelvia key minting. It always runs, and it
 * proves the wiring (provision → connector status → revoke), not the providers.
 * A fake is never evidence that a real organisation key, a real Composio project
 * or a real Modelvia key was exercised.
 *
 * Leg 2 — the real Square SANDBOX checks below. They need SQUARE_ACCESS_TOKEN and
 * are reported as SKIPPED, loudly, when it is absent.
 *
 * What this proves that unit tests cannot: the existing square.test.ts suite runs
 * against a hand-written fake of Square's API. It validates our logic against our
 * *assumption* of Square's request and response shapes. This script sends the same
 * calls to the real sandbox, so a wrong field name, a wrong API version, or a wrong
 * host shows up as a loud failure instead of a green test suite.
 *
 * Safety properties, in order of importance:
 *   1. The host is pinned to SANDBOX. It is never derived from the token or the
 *      environment, so this script cannot touch a real Square account.
 *   2. It creates a DRAFT invoice only. SquareBilling has no publishing, sending,
 *      charging or refund-creation method, so no money can move from here.
 *   3. It uses a throwaway in-memory ledger. No office data is read or written.
 *   4. It prints no token and no secret.
 *
 * Exit code 0 means every check passed against the real sandbox.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from './testing.ts';
import { SquareBilling } from './square.ts';
import { digest } from './ledger.ts';
import { ManagedConnectors } from './connectors.ts';
import { fileSecretStore, InstallationProvisioning, type ProvisioningDescriptor } from './provisioning.ts';
import type { ComposioOrgClient } from './composio-org.ts';
import type { ModelviaClient } from './modelvia-keys.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SANDBOX_HOST = 'https://connect.squareupsandbox.com';
const SQUARE_VERSION = '2026-08-19';
const NOTIFY_URL = process.env.SQUARE_NOTIFICATION_URL || 'https://realbud.app/api/webhooks/square';

function loadLocalEnv(): void {
  const file = resolve(HERE, '.env.local');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const cut = trimmed.indexOf('=');
    const key = trimmed.slice(0, cut).trim();
    if (key && process.env[key] === undefined) process.env[key] = trimmed.slice(cut + 1);
  }
}

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`);
}

/** Read-only discovery. Also the first real proof the token works at all. */
async function discover(token: string): Promise<{ merchantId: string; locationId: string; currency: string }> {
  const call = async (path: string) => {
    const response = await fetch(`${SANDBOX_HOST}${path}`, {
      headers: { Authorization: `Bearer ${token}`, 'Square-Version': SQUARE_VERSION },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${path} → HTTP ${response.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as Record<string, unknown>;
  };

  const merchantBody = (await call('/v2/merchants')) as { merchant?: { id?: string }; merchants?: { id?: string }[] };
  const merchantId = merchantBody.merchant?.id ?? merchantBody.merchants?.[0]?.id ?? '';
  if (!merchantId) throw new Error('the sandbox account returned no merchant id');

  const locationBody = (await call('/v2/locations')) as { locations?: { id?: string; currency?: string; status?: string }[] };
  const active = (locationBody.locations ?? []).find((row) => row.status === 'ACTIVE') ?? locationBody.locations?.[0];
  if (!active?.id) throw new Error('the sandbox account returned no location id');

  return { merchantId, locationId: active.id, currency: active.currency ?? '' };
}

/**
 * Leg 1. Provision an installation, use the issued connector credential against
 * the connector broker, then revoke it. Every provider is a fake: the Composio
 * organisation surface, the Modelvia key mint, and the Gmail adapter. Nothing
 * here reaches a network, and nothing here proves a real provider.
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
    check('provision creates one capped Modelvia project for the installation',
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
  loadLocalEnv();
  process.stdout.write('Leg 1 — installation provisioning against FAKES. Offline; proves wiring, not providers.\n\n');
  await provisioningLeg();

  const token = (process.env.SQUARE_ACCESS_TOKEN ?? '').trim();
  if (!token) {
    process.stdout.write('\nLeg 2 — Square SANDBOX: SKIPPED. SQUARE_ACCESS_TOKEN is not set, so nothing was proven against the real Square API.\n');
    process.stderr.write('Set SQUARE_ACCESS_TOKEN in managed-gateway/.env.local to run the Square sandbox leg.\n');
    const skipped = checks.filter((row) => !row.ok);
    process.stdout.write(`\n${checks.length - skipped.length}/${checks.length} provisioning checks passed${skipped.length ? ` — FAILED: ${skipped.map((r) => r.name).join(', ')}` : ''}\n`);
    return skipped.length ? 1 : 0;
  }
  process.stdout.write('\nLeg 2 — Square SANDBOX smoke — draft invoices only, no money can move.\n\n');

  // 1. The token works, and against which account.
  let ids: { merchantId: string; locationId: string; currency: string };
  try {
    ids = await discover(token);
  } catch (cause) {
    check('sandbox token authenticates', false, cause instanceof Error ? cause.message : String(cause));
    process.stdout.write('\nA sandbox token must be used against the sandbox host. If this failed with 401, the token is a production token or was rotated.\n');
    return 1;
  }
  check('sandbox token authenticates', true, `merchant ${ids.merchantId}, location ${ids.locationId}`);
  check('location is AUD', ids.currency === 'AUD', `currency reported as ${ids.currency || 'unknown'}`);

  // 2. Drive the real statement → draft-invoice flow through our own code path.
  const f = fixture();
  try {
    const square = new SquareBilling({
      ledger: f.ledger,
      secret: async () => token,
      notificationUrl: NOTIFY_URL,
      // Not used by the draft path; webhooks are verified in unit tests only.
      signatureKey: async () => 'sandbox-smoke-unused',
      environment: 'sandbox',
    });
    check('environment pinned to sandbox', square.environment === 'sandbox', SANDBOX_HOST);

    square.map({
      companyId: f.tenant.companyId,
      merchantId: ids.merchantId,
      customerId: 'sandbox-smoke-customer',
      locationId: ids.locationId,
      evidence: 'sandbox-smoke',
    });

    const statement = square.closeStatement(f.tenant.companyId, '2026-08', 'sandbox-smoke-care');
    check('GST-inclusive statement closes', statement.totalCents > 0, `A$${(statement.totalCents / 100).toFixed(2)} incl A$${(statement.gstCents / 100).toFixed(2)} GST`);
    square.accept(f.owner, statement.id, digest(statement));

    const link = await square.createDraft(f.owner, statement.id, '2026-09-30');
    check('real sandbox order created', Boolean(link.orderId), `order ${link.orderId}`);
    check('real sandbox DRAFT invoice created', Boolean(link.invoiceId), `invoice ${link.invoiceId}`);

    // 3. Idempotency against the real API: a repeat click must not create a second effect.
    const again = await square.createDraft(f.owner, statement.id, '2026-09-30');
    check('repeat create is idempotent', again.invoiceId === link.invoiceId, 'same invoice id returned');

    const summary = square.paymentSummary(f.owner, statement.id);
    check('no payment recorded (draft only)', summary.paidCents === 0 && summary.netReceivedCents === 0, `paid ${summary.paidCents}`);

    process.stdout.write(`\nDraft invoice ${link.invoiceId} exists in the Square sandbox. Nothing was sent, published or charged.\n`);
  } finally {
    f.close();
  }

  const failed = checks.filter((row) => !row.ok);
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length ? ` — FAILED: ${failed.map((r) => r.name).join(', ')}` : ''}\n`);
  return failed.length ? 1 : 0;
}

process.exitCode = await main();
