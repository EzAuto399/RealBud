/**
 * RealBud against the LIVE Modelvia contract (Modelvia `main` 49327ba, what
 * api.modelvia.dev served on 25 September 2026), end to end over HTTP shapes:
 * office AI access → commercial terms → provisioning → project key → first chat
 * → receipt, and the refusals a live office meets.
 *
 * `liveModelvia()` is a stand-in, not Modelvia. Each rule it applies names the
 * Modelvia source it copies:
 *   accounts   accounts.ts put: exact fields, optimistic version (0 creates),
 *              immutable bindings, payer rules by the client's billing mode
 *   policies   commercial.ts put: exact fields, active needs effectiveAt no more
 *              than 5 min behind server time, append-only ids, effective order,
 *              internal-cost billing needs payer/issuer client and fee 0
 *   keys       platform-admin.ts /v1/operator/keys, keys.ts key format
 *   chat       key-gateway.ts admission: idempotency before anything,
 *              `customer_terms_required` (ledger.ts:272), routes = served ∩
 *              client ∩ customer ∩ project allowlists, whole-route holds checked
 *              against request caps (402), 503 `model_route_unavailable`
 *   receipts   charge-presentation.ts: resale audience, `all_in`, `usedBy`,
 *              `withheld` for client-funded; http.ts error bodies
 * Served routes and holds are the live menu: `deepseek-v4.1-flash` (default) and
 * `kimi-k3`, holding up to about A$1.4 and A$3.27. Every identity is fictional;
 * nothing here reaches a network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { careTermsDraft, fixture } from './testing.ts';
import { CommercialTermsStore, resaleAcceptanceReference } from './commercial-terms.ts';
import { GatewayError } from './contracts.ts';
import type { ComposioOrgClient, HttpTransport } from './composio-org.ts';
import { customerTermsPolicy, DEFAULT_CLIENT_FUNDED_REFERENCE, modelviaKeyClient, TERMS_EFFECTIVE_LEAD_MS } from './modelvia-keys.ts';
import { composeOperatorRoutes } from './office-ai-access.ts';
import { OPERATOR_ROLE } from './operator-token.ts';
import { composeProvisioning, DEFAULT_REQUEST_CAP_NANO_AUD, type InstallationProvisioning } from './provisioning.ts';
import { modelviaRefusal, parseModelviaReceipt } from '../shared/modelvia-receipt.ts';

type Row = Record<string, unknown>;
const OPERATOR_SECRET = 'fictional-modelvia-operator-secret-32ch';
const CLIENT = 'realbud';
const BILLING_COMPANY = 'rbco_fictional_internal';
const LIVE_MODELS = 'deepseek-v4.1-flash,kimi-k3';
const FLASH_HOLD = 1_400_000_000n, KIMI_HOLD = 3_270_000_000n;
const SERVED = [{ model: 'deepseek-v4.1-flash', hold: FLASH_HOLD, default: true }, { model: 'kimi-k3', hold: KIMI_HOLD, default: false }];
const SKEW_MS = 5 * 60_000;
const RETRY_GRACE_MS = 30_000;

/** Modelvia's operator-token.ts verifier, as in modelvia-keys.test.ts. */
function operatorAuthorized(header: string | undefined, now: number): boolean {
  const token = /^Bearer (.+)$/.exec(header ?? '')?.[1];
  const [payload, signature] = token?.split('.') ?? [];
  if (!payload || !signature) return false;
  const expected = createHmac('sha256', OPERATOR_SECRET).update(payload).digest(), given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  const c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Row;
  return c.aud === 'managed-ai-operator' && typeof c.iat === 'number' && typeof c.exp === 'number' && c.exp > now && c.exp - c.iat <= 300_000;
}

function liveModelvia(options: { billingMode?: 'client' | 'customer' | 'mixed'; customers?: Row[]; policies?: Row[]; clientModels?: string[] } = {}) {
  const now = () => Date.now();
  const clients = new Map<string, Row>([[CLIENT, { id: CLIENT, name: 'RealBud', active: true, monthlyCapNanoAud: '10000000000', maxConcurrent: 4,
    allowedModels: options.clientModels ?? LIVE_MODELS.split(','), version: 1, billingMode: options.billingMode ?? 'client',
    ...(options.billingMode === 'customer' ? {} : { billingCompanyId: BILLING_COMPANY }) }]]);
  const customers = new Map<string, Row>((options.customers ?? []).map(row => [row.id as string, { ...row }]));
  const projects = new Map<string, Row>();
  const policies: Row[] = (options.policies ?? []).map(row => ({ ...row }));
  /** The internal-cost billing company: A$10/month, A$4 a request. */
  const tenant = { accountingTreatment: 'internal_cost', requestCapNanoAud: 4_000_000_000n };
  const keys = new Map<string, Row & { secret: string }>();
  const requests = new Map<string, Row>();
  const delivered = new Map<string, number>();
  const calls: { method: string; path: string; body?: Row; idempotencyKey?: string }[] = [];
  const fail = (status: number, code: string, extra: Row = {}) => Response.json({ error: code, ...extra }, { status });
  const openAiFail = (status: number, code: string, extra: Row = {}) => Response.json({ error: { message: code, type: status === 402 ? 'insufficient_quota' : status >= 500 ? 'server_error' : status === 401 ? 'authentication_error' : 'invalid_request_error', code, param: null }, ...extra }, { status });

  const effectivePayer = (customer: Row) => { const client = clients.get(customer.clientId as string)!; return client.billingMode === 'mixed' ? customer.payer : client.billingMode; };
  const policyInForce = (customerId: string) => policies.filter(p => p.customerId === customerId && p.clientId === CLIENT && p.state === 'active' && (p.effectiveAt as number) <= now())
    .sort((a, b) => (b.effectiveAt as number) - (a.effectiveAt as number))[0];
  const putAccount = (kind: 'customer' | 'project', table: Map<string, Row>, body: Row) => {
    const permitted = ['id', 'name', 'active', 'monthlyCapNanoAud', 'maxConcurrent', 'allowedModels', 'version',
      ...(kind === 'customer' ? ['clientId', 'payer', 'billingCompanyId'] : ['clientId', 'customerId', 'environments', 'requestCapNanoAud'])];
    if (Object.keys(body).some(key => !permitted.includes(key))) return fail(400, 'invalid_fields');
    if (!Array.isArray(body.allowedModels) || !body.allowedModels.length) return fail(400, 'invalid_model_policy');
    if (kind === 'project' && BigInt(body.requestCapNanoAud as string) > BigInt(body.monthlyCapNanoAud as string)) return fail(400, 'invalid_caps');
    const old = table.get(body.id as string);
    if (body.version !== ((old?.version as number | undefined) ?? 0)) return fail(409, 'account_version_conflict');
    if (old) for (const field of ['clientId', 'customerId', 'billingCompanyId', 'payer']) if (old[field] !== body[field]) return fail(409, 'account_binding_immutable');
    const client = clients.get(body.clientId as string);
    if (!client) return fail(404, 'account_not_found');
    if (kind === 'customer') {
      if (client.billingMode === 'mixed' ? !['client', 'customer'].includes(String(body.payer)) : body.payer !== undefined) return fail(400, 'invalid_payer');
      if ((effectivePayer(body) === 'customer') !== (typeof body.billingCompanyId === 'string')) return fail(400, 'invalid_billing_binding');
    }
    if (kind === 'project' && (customers.get(body.customerId as string)?.clientId !== client.id)) return fail(403, 'invalid_account_ancestry');
    const saved: Row = { ...body, version: (body.version as number) + 1 };
    table.set(saved.id as string, saved);
    return Response.json(saved);
  };
  const putPolicy = (body: Row) => {
    const fields = ['id', 'clientId', 'customerId', 'state', 'effectiveAt', 'payer', 'invoiceIssuer', 'collection', 'management', 'platformFeeBasisPoints', 'clientMarkupBasisPoints', 'acceptanceReference'];
    const optional = Object.hasOwn(body, 'customerBilling') ? 1 : 0;
    if (Object.keys(body).length !== fields.length + optional || !fields.every(key => Object.hasOwn(body, key))) return fail(400, 'invalid_fields');
    if (body.customerBilling === 'client_funded' && (body.payer !== 'client' || body.clientMarkupBasisPoints !== 0)) return fail(409, 'invalid_client_funded_policy');
    const customer = customers.get(body.customerId as string);
    if (!customer || customer.clientId !== body.clientId) return fail(403, 'invalid_account_ancestry');
    const payer = effectivePayer(customer);
    if (payer === 'client' && tenant.accountingTreatment === 'internal_cost' && (body.payer !== 'client' || body.invoiceIssuer !== 'client' || body.platformFeeBasisPoints !== 0)) return fail(409, 'invalid_internal_commercial_policy');
    if (body.state === 'active') {
      if (body.payer !== payer) return fail(409, 'payer_migration_required');
      if ((body.effectiveAt as number) < now() - SKEW_MS || !String(body.acceptanceReference).trim()) return fail(409, 'commercial_acceptance_required');
      if (body.collection !== 'invoice') return fail(409, 'hosted_collection_not_connected');
    }
    if (policies.some(p => p.id === body.id)) return fail(409, 'policy_version_exists');
    if (body.state === 'active' && policies.some(p => p.customerId === body.customerId && p.state === 'active' && (p.effectiveAt as number) >= (body.effectiveAt as number))) return fail(409, 'policy_effective_order');
    const saved = { ...body, createdAt: now(), createdBy: 'realbud-provisioning' };
    policies.push(saved);
    return Response.json(saved);
  };
  const mintKey = (projectId: string, environment: string, label?: string) => {
    const id = randomBytes(8).toString('hex'), secret = `rbk_${id}_${randomBytes(32).toString('base64url').slice(0, 43)}`;
    const record = { id, companyId: BILLING_COMPANY, project: projectId, environment, ...(label ? { label } : {}), createdAt: now() };
    keys.set(id, { ...record, secret });
    return { key: secret, record };
  };
  const receipt = (record: Row) => {
    const policy = record.policy as Row | undefined, resale = policy?.customerBilling === 'resale';
    const customer = customers.get(record.customerId as string)!;
    return {
      requestId: record.requestId, state: 'settled', clientId: CLIENT, customerId: record.customerId, projectId: record.projectId, environment: 'production',
      model: record.model, requestedModel: record.requestedModel, rateVersion: 'openrouter-2026-09-r2',
      units: { input_tokens: 812, cache_read_tokens: 0, output_tokens: 64 }, pricingContract: 2, priceAudience: 'resale_customer',
      ...(resale ? { priceBasis: 'retail', reservedNanoAud: record.holdNanoAud, chargedNanoAud: '1843000' } : { priceBasis: 'withheld' }),
      currency: 'AUD', replayAvailable: false, idempotencySource: record.idempotencySource,
      // all_in drops the routing fields and names the line.
      chargeDetail: 'all_in', description: 'AI usage',
      usedBy: resale ? { kind: 'customer', customerId: record.customerId, displayName: customer.name, projectId: record.projectId }
        : { kind: 'client_internal', clientId: CLIENT, displayName: 'RealBud (internal use)' },
    };
  };

  const chat = (headers: Record<string, string>, body: Row) => {
    const bearer = /^Bearer (rbk_([0-9a-f]{16})_.+)$/.exec(headers.authorization ?? '');
    const key = bearer && keys.get(bearer[2]!);
    if (!key || key.secret !== bearer![1]) return openAiFail(401, 'invalid_key');
    if (key.revokedAt !== undefined) return openAiFail(401, 'key_revoked');
    const project = projects.get(key.project as string)!, customer = customers.get(project.customerId as string)!, client = clients.get(CLIENT)!;
    if (!project.active || !customer.active || !client.active) return openAiFail(403, 'account_inactive');
    for (const field of Object.keys(body)) if (!['model', 'messages', 'stream', 'max_tokens', 'reasoning_effort', 'tools', 'tool_choice', 'stream_options', 'user', 'temperature'].includes(field)) return openAiFail(400, `unsupported_parameter:${field}`);
    const fingerprint = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    // Retries resolve first (key-gateway.ts `idempotency`/`duplicate`).
    const supplied = headers['idempotency-key'];
    const idem = supplied ? `supplied:${project.id}:${supplied}` : `derived:${key.id}:${fingerprint}`;
    const prior = requests.get(idem);
    if (prior) {
      if (prior.fingerprint !== fingerprint) return openAiFail(409, 'idempotency_conflict');
      const retry = supplied !== undefined || now() - (delivered.get(idem) ?? now()) <= RETRY_GRACE_MS;
      if (retry) return openAiFail(409, 'request_already_processed', { receipt: receipt(prior) });
    }
    // Terms (ledger.ts:272), before any reservation.
    const policy = policyInForce(customer.id as string);
    if (!policy && effectivePayer(customer) === 'client') return openAiFail(409, 'customer_terms_required');
    const allowed = [client, customer, project].reduce<string[]>((set, account) => set.filter(model => (account.allowedModels as string[]).includes(model)), SERVED.map(route => route.model));
    const permitted = SERVED.filter(route => allowed.includes(route.model) && (body.model === 'auto' || body.model === route.model));
    if (!permitted.length) return openAiFail(503, 'model_route_unavailable');
    let refusal: string | undefined;
    const eligible = permitted.filter(route => {
      if (route.hold > tenant.requestCapNanoAud) { refusal = 'request_cap_exceeded'; return false; }
      if (route.hold > BigInt(project.requestCapNanoAud as string)) { refusal = 'project_request_cap_exceeded'; return false; }
      return true;
    });
    if (!eligible.length) return openAiFail(402, refusal!);
    const route = eligible.find(r => r.default) ?? eligible[0]!;
    const requestId = `req_${randomBytes(8).toString('hex')}`;
    const record = { requestId, projectId: project.id, customerId: customer.id, model: route.model, requestedModel: body.model, holdNanoAud: route.hold.toString(),
      fingerprint, policy, idempotencySource: supplied ? 'supplied' : 'derived' };
    requests.set(idem, record); requests.set(requestId, record); delivered.set(idem, now());
    return new Response(JSON.stringify({ id: `chatcmpl-${requestId}`, object: 'chat.completion', created: 0, model: route.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'Fictional reply. No model ran.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 812, completion_tokens: 64, total_tokens: 876 } }), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': requestId } });
  };

  const fetchLike: HttpTransport = async (url, init) => {
    const parsed = new URL(url), path = parsed.pathname, method = String(init.method ?? 'GET');
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body)) as Row;
    calls.push({ method, path, ...(body ? { body } : {}), ...(headers['idempotency-key'] ? { idempotencyKey: headers['idempotency-key'] } : {}) });
    if (path === '/v1/chat/completions' && method === 'POST') return chat(headers, body ?? {});
    const receiptPath = /^\/v1\/requests\/([A-Za-z0-9_]+)$/.exec(path);
    if (receiptPath && method === 'GET') {
      const bearer = /^Bearer rbk_([0-9a-f]{16})_/.exec(headers.authorization ?? ''), key = bearer && keys.get(bearer[1]!), record = requests.get(receiptPath[1]!);
      if (!key || !record || record.projectId !== key.project) return openAiFail(404, 'request_not_found');
      return Response.json(receipt(record));
    }
    if (!path.startsWith('/v1/operator/')) return fail(404, 'not_found');
    if (!operatorAuthorized(headers.authorization, now())) return fail(401, 'unauthenticated');
    if (path === '/v1/operator/clients' && method === 'GET') return Response.json({ accounts: [...clients.values()] });
    if (path === '/v1/operator/customers' && method === 'GET') return Response.json({ accounts: [...customers.values()] });
    if (path === '/v1/operator/customers' && method === 'POST') return putAccount('customer', customers, body!);
    if (path === '/v1/operator/projects' && method === 'GET') return Response.json({ accounts: [...projects.values()] });
    if (path === '/v1/operator/projects' && method === 'POST') return putAccount('project', projects, body!);
    // Modelvia's node:http server stamps every response with a Date header (whole seconds).
    if (path === '/v1/operator/commercial-policies' && method === 'GET') return Response.json({ policies }, { headers: { date: new Date(now()).toUTCString() } });
    if (path === '/v1/operator/commercial-policies' && method === 'POST') return putPolicy(body!);
    if (path === '/v1/operator/keys' && method === 'GET') {
      const projectId = parsed.searchParams.get('projectId'), environment = parsed.searchParams.get('environment');
      return Response.json({ keys: [...keys.values()].filter(k => k.project === projectId && k.environment === environment).map(({ secret: _secret, ...record }) => record) });
    }
    if (path === '/v1/operator/keys' && method === 'POST') {
      const project = projects.get(body!.projectId as string);
      if (!project?.active || !customers.get(project.customerId as string)?.active) return fail(403, 'account_inactive');
      if (!(project.environments as string[]).includes(body!.environment as string)) return fail(403, 'environment_denied');
      return Response.json(mintKey(project.id as string, body!.environment as string, body!.label as string | undefined));
    }
    const action = /^\/v1\/operator\/keys\/([0-9a-f]{16})\/(revoke|rotate)$/.exec(path);
    if (action && method === 'POST') {
      const key = keys.get(action[1]!);
      if (!key) return fail(404, 'unknown_key');
      if (action[2] === 'revoke') { key.revokedAt ??= now(); const { secret: _secret, ...record } = key; return Response.json(record); }
      if (key.revokedAt !== undefined) return fail(409, 'key_revoked');
      key.revokedAt = now();
      return Response.json({ ...mintKey(key.project as string, key.environment as string, key.label as string | undefined), replaced: key.id });
    }
    return fail(404, 'not_found');
  };
  return { fetchLike, calls, customers, projects, policies, keys, requests, clients,
    posts: (path: string) => calls.filter(call => call.method === 'POST' && call.path === path) };
}

/** A fake Composio organisation: provisioning's other vendor, not under test here. */
function composio(): ComposioOrgClient & { created: string[] } {
  const projects: { id: string; name: string }[] = [], created: string[] = [];
  return { created,
    async listProjects() { return projects.map(p => ({ ...p })); },
    async createProject(name) { created.push(name); const project = { id: `pr_fictional${created.length}`, name }; projects.push(project); return { ...project, apiKey: 'ak_fictional_project_key' }; },
    async deleteProject() { return { revokeJobId: 'job-fictional' }; } };
}

/** The gateway as production composes it, over the stand-in. */
const authConfigResponse = () => Response.json({ items: [{ id: 'ac-fictional-readonly', name: 'realbud-gmail-readonly-v1', toolkit: { slug: 'gmail' }, auth_scheme: 'OAUTH2', is_composio_managed: true, status: 'ENABLED', credentials: { scopes: 'https://www.googleapis.com/auth/gmail.readonly' } }], next_cursor: null });

function gateway(m: ReturnType<typeof liveModelvia>, env: Record<string, string> = {}) {
  const f = fixture(), root = mkdtempSync(join(tmpdir(), 'realbud-live-contract-')), org = composio();
  const full: NodeJS.ProcessEnv = {
    REALBUD_ENABLE_PROVIDER: '1', REALBUD_GATEWAY_SECRETS_DIR: join(root, 'secrets'), REALBUD_GATEWAY_CONNECTOR_REGISTRY: join(root, 'registry', 'devices.json'),
    REALBUD_GATEWAY_PUBLIC_ORIGIN: 'https://managed.example.invalid', REALBUD_COMPOSIO_ORG_KEY: 'fictional-org-key',
    REALBUD_GATEWAY_OPERATOR_SECRET: 'fictional-gateway-operator-secret-000001', REALBUD_GATEWAY_PORTAL_SECRET: 'fictional-gateway-portal-secret-00000001',
    REALBUD_MODELVIA_BASE_URL: 'https://api.modelvia.dev', REALBUD_MODELVIA_OPERATOR_SECRET: OPERATOR_SECRET, REALBUD_MODELVIA_OPERATOR_SUBJECT: 'realbud-provisioning',
    REALBUD_MODELVIA_CLIENT_ID: CLIENT, REALBUD_MODELVIA_MODELS: LIVE_MODELS, REALBUD_MODELVIA_CLIENT_FUNDED_COMPANIES: 'company-a', ...env,
  };
  const operator = composeOperatorRoutes({ env: full, ledger: f.ledger, fetch: m.fetchLike });
  const composed = composeProvisioning({ env: full, ledger: f.ledger, fetch: async (url, init) => url.startsWith('https://backend.composio.dev/api/v3.1/auth_configs?') && init.method === 'GET' ? authConfigResponse() : m.fetchLike(url, init), org });
  assert.ok(operator?.officeAiAccess, 'office AI access is composed');
  assert.ok('provisioning' in composed, 'provisioning is composed');
  const actor = { subject: 'operator:ops@realbud.example', role: OPERATOR_ROLE } as const;
  return { f, org, operator: operator!, provisioning: (composed as { provisioning: InstallationProvisioning }).provisioning,
    setAccess: (customerId: string, access: Row = { mode: 'default' }, companyId = 'company-a') =>
      operator!.officeAiAccess!.set(actor, { companyId, customerId, name: 'Fictional Office A', access }),
    provision: (customerId: string, installationId = 'install-one') =>
      (composed as { provisioning: InstallationProvisioning }).provisioning.provision(f.owner, { companyId: 'company-a', installationId, customerId, profile: 'property' }),
    close: () => { rmSync(root, { recursive: true, force: true }); f.close(); } };
}
const chat = (m: ReturnType<typeof liveModelvia>, key: string, body: Row, idempotencyKey?: string) =>
  m.fetchLike('https://api.modelvia.dev/v1/chat/completions', { method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) }, body: JSON.stringify(body) });
const receiptOf = async (m: ReturnType<typeof liveModelvia>, key: string, requestId: string) =>
  parseModelviaReceipt(await (await m.fetchLike(`https://api.modelvia.dev/v1/requests/${requestId}`, { method: 'GET', headers: { authorization: `Bearer ${key}` } })).json());
const FIRST = { model: 'auto', messages: [{ role: 'user', content: 'FICTIONAL: say hello.' }], stream: false };

test('a brand-new office: access → client-funded terms → provision → key → first auto chat → withheld all-in receipt', async () => {
  const m = liveModelvia(), g = gateway(m); try {
    // 1. Office AI access creates the customer, then its commercial terms.
    const before = Date.now();
    const access = await g.setAccess('realbud-company-a');
    assert.deepEqual(access.customer, { active: true, monthlyCapNanoAud: '200000000000', created: true });
    assert.equal(access.terms?.state, 'active');
    assert.deepEqual({ ...access.terms, policyId: undefined }, { state: 'active', created: true, policyId: undefined, customerBilling: 'client_funded' });
    // The customer names the live route ids, never `auto`.
    assert.deepEqual(m.customers.get('realbud-company-a')!.allowedModels, ['deepseek-v4.1-flash', 'kimi-k3']);
    const [policy] = m.posts('/v1/operator/commercial-policies').map(call => call.body!);
    assert.deepEqual(Object.keys(policy!).sort(), ['acceptanceReference', 'clientId', 'clientMarkupBasisPoints', 'collection', 'customerBilling', 'customerId', 'effectiveAt',
      'id', 'invoiceIssuer', 'management', 'payer', 'platformFeeBasisPoints', 'state']);
    assert.deepEqual({ ...policy, id: undefined, effectiveAt: undefined }, { id: undefined, effectiveAt: undefined, clientId: CLIENT, customerId: 'realbud-company-a', state: 'active',
      payer: 'client', invoiceIssuer: 'client', collection: 'invoice', management: 'self_service', platformFeeBasisPoints: 0, clientMarkupBasisPoints: 0,
      acceptanceReference: DEFAULT_CLIENT_FUNDED_REFERENCE, customerBilling: 'client_funded' });
    // Stamped a minute early: inside Modelvia's five-minute skew, never in its future.
    assert.ok((policy!.effectiveAt as number) >= before - TERMS_EFFECTIVE_LEAD_MS && (policy!.effectiveAt as number) <= Date.now() - TERMS_EFFECTIVE_LEAD_MS);
    // The policy id is Modelvia's handle and carries no customer id, so it may be audited.
    assert.ok(!String(policy!.id).includes('company-a'));
    const audit = g.f.ledger.db.all<{ kind: string; body: string }>("SELECT kind, body FROM events WHERE kind='office_ai_access_set'");
    assert.equal(audit.length, 1); assert.ok(!audit[0]!.body.includes('realbud-company-a'));

    // 2. Provisioning finds the terms in force and mints one key.
    const { provisioning } = await g.provision('realbud-company-a');
    assert.match(provisioning.model.key!, /^rbk_[0-9a-f]{16}_/);
    assert.equal(provisioning.model.baseUrl, 'https://api.modelvia.dev/v1');
    const project = m.projects.get('rb-install-one')!;
    assert.deepEqual({ requestCapNanoAud: project.requestCapNanoAud, allowedModels: project.allowedModels, environments: project.environments },
      { requestCapNanoAud: DEFAULT_REQUEST_CAP_NANO_AUD, allowedModels: ['deepseek-v4.1-flash', 'kimi-k3'], environments: ['production'] });
    assert.equal(provisioning.model.spendCapLabel, 'A$200/month, A$4/request, 2 at once');

    // 3. The desktop's first call: `auto`, with an explicit key for this logical request.
    const first = await chat(m, provisioning.model.key!, FIRST, 'realbud-turn-0001');
    assert.equal(first.status, 200);
    const requestId = first.headers.get('x-request-id')!;
    assert.equal(((await first.json()) as Row).id, `chatcmpl-${requestId}`);

    // 4. Its receipt: resale audience, all-in, client-funded so the price is withheld.
    const receipt = await receiptOf(m, provisioning.model.key!, requestId);
    assert.deepEqual(receipt, { requestId, state: 'settled', model: 'deepseek-v4.1-flash', priceBasis: 'withheld', chargedNanoAud: null, reservedNanoAud: null,
      chargeDetail: 'all_in', description: 'AI usage', usedBy: { kind: 'client_internal', displayName: 'RealBud (internal use)' }, idempotencySource: 'supplied' });

    // 5. The same logical request again is its retry: 409 with the original receipt, never a second charge.
    const replay = await chat(m, provisioning.model.key!, FIRST, 'realbud-turn-0001');
    assert.equal(replay.status, 409);
    const refusal = modelviaRefusal(await replay.json());
    assert.equal(refusal?.code, 'request_already_processed');
    assert.equal(refusal?.receipt?.requestId, requestId);
    // A new logical request with a byte-identical body is admitted under its own key...
    const again = await chat(m, provisioning.model.key!, FIRST, 'realbud-turn-0002');
    assert.equal(again.status, 200); assert.notEqual(again.headers.get('x-request-id'), requestId);
    // ...where a header-less resend moments after delivery is refused as a retry.
    assert.equal((await chat(m, provisioning.model.key!, FIRST)).status, 200);
    const headerless = await chat(m, provisioning.model.key!, FIRST);
    assert.equal(headerless.status, 409);
    assert.equal(modelviaRefusal(await headerless.json())?.code, 'request_already_processed');
  } finally { g.close(); }
});

test('no key is issued into customer_terms_required: provisioning refuses before any effect until terms are in force', async () => {
  // An office outside the client-funded list, with no resale configuration: its
  // customer is created, but no terms are written.
  const m = liveModelvia(), g = gateway(m, { REALBUD_MODELVIA_CLIENT_FUNDED_COMPANIES: '' }); try {
    const access = await g.setAccess('realbud-company-a');
    assert.deepEqual(access.terms, { state: 'unconfigured' });
    assert.deepEqual(m.posts('/v1/operator/commercial-policies'), []);
    await assert.rejects(() => g.provision('realbud-company-a'), (error: unknown) =>
      error instanceof GatewayError && error.code === 'modelvia_customer_not_ready' && error.status === 409);
    assert.deepEqual(g.org.created, []); assert.equal(m.projects.size, 0); assert.equal(m.keys.size, 0);
    // What Modelvia itself answers for such a customer, had a key existed.
    m.projects.set('rb-direct', { id: 'rb-direct', name: 'Fictional', active: true, monthlyCapNanoAud: '200000000000', maxConcurrent: 2, allowedModels: LIVE_MODELS.split(','),
      version: 1, clientId: CLIENT, customerId: 'realbud-company-a', environments: ['production'], requestCapNanoAud: '4000000000' });
    const direct = modelviaKeyClient({ serviceOrigin: 'https://api.modelvia.dev', environment: 'production', clientId: CLIENT, allowedModels: LIVE_MODELS.split(','),
      operatorSecret: () => OPERATOR_SECRET, operatorSubject: 'realbud-provisioning', fetch: m.fetchLike });
    const { key } = await direct.mint({ projectId: 'rb-direct', label: 'fictional' });
    const refused = await chat(m, key, FIRST, 'realbud-turn-0001');
    assert.equal(refused.status, 409);
    assert.equal(modelviaRefusal(await refused.json())?.code, 'customer_terms_required');
    // Terms in force (here: the owner listing the office as client-funded) unblock both.
    const listed = gateway(m); try {
      assert.equal((await listed.setAccess('realbud-company-a')).terms?.state, 'active');
      assert.equal((await chat(m, key, FIRST, 'realbud-turn-0002')).status, 200);
      assert.match((await listed.provision('realbud-company-a')).provisioning.model.key!, /^rbk_/);
    } finally { listed.close(); }
  } finally { g.close(); }
});

test('an active policy already in force is kept exactly as it is, whatever it says', async () => {
  const live = { id: 'realbud-owner-internal-2026-09-25', clientId: CLIENT, customerId: 'realbud-owner', state: 'active', effectiveAt: Date.now() - 86_400_000,
    payer: 'client', invoiceIssuer: 'client', collection: 'invoice', management: 'self_service', platformFeeBasisPoints: 0, clientMarkupBasisPoints: 0,
    acceptanceReference: 'fictional-owner-acceptance', customerBilling: 'client_funded', createdAt: 0, createdBy: 'fictional' };
  const customer = { id: 'realbud-owner', name: 'Fictional Owner Office', active: true, monthlyCapNanoAud: '10000000000', maxConcurrent: 2, allowedModels: LIVE_MODELS.split(','), version: 4, clientId: CLIENT };
  const m = liveModelvia({ customers: [customer], policies: [live] }), g = gateway(m); try {
    const access = await g.setAccess('realbud-owner', { mode: 'custom', monthlyCapNanoAud: '10000000000' });
    assert.deepEqual(access.terms, { state: 'active', created: false, policyId: 'realbud-owner-internal-2026-09-25', customerBilling: 'client_funded' });
    assert.deepEqual(m.posts('/v1/operator/commercial-policies'), []);
    // A resale policy in force is not "corrected" to client-funded either: that is a dated migration.
    const resale = liveModelvia({ customers: [customer], policies: [{ ...live, id: 'fictional-resale', customerBilling: undefined, clientMarkupBasisPoints: 2000 }] });
    const h = gateway(resale); try {
      assert.deepEqual((await h.setAccess('realbud-owner', { mode: 'custom', monthlyCapNanoAud: '10000000000' })).terms,
        { state: 'active', created: false, policyId: 'fictional-resale', customerBilling: 'resale' });
      assert.deepEqual(resale.posts('/v1/operator/commercial-policies'), []);
    } finally { h.close(); }
  } finally { g.close(); }
});

test('resale is written only from explicit configuration, and its receipt is a retail all-in price for the customer', async () => {
  assert.deepEqual(customerTermsPolicy({ REALBUD_MODELVIA_RESALE_MARKUP_BASIS_POINTS: '2000' }), { unavailable: 'provisioning_unconfigured:REALBUD_MODELVIA_RESALE_TERMS_REFERENCE' });
  assert.deepEqual(customerTermsPolicy({ REALBUD_MODELVIA_RESALE_TERMS_REFERENCE: 'fictional-signed-order-7' }), { unavailable: 'provisioning_unconfigured:REALBUD_MODELVIA_RESALE_MARKUP_BASIS_POINTS' });
  for (const bad of ['-1', '100001', '1.5', '20%'])
    assert.deepEqual(customerTermsPolicy({ REALBUD_MODELVIA_RESALE_MARKUP_BASIS_POINTS: bad, REALBUD_MODELVIA_RESALE_TERMS_REFERENCE: 'fictional-signed-order-7' }),
      { unavailable: 'provisioning_unconfigured:REALBUD_MODELVIA_RESALE_MARKUP_BASIS_POINTS' }, bad);
  assert.deepEqual(customerTermsPolicy({ REALBUD_MODELVIA_CLIENT_FUNDED_COMPANIES: 'company-a,bad id' }), { unavailable: 'provisioning_unconfigured:REALBUD_MODELVIA_CLIENT_FUNDED_COMPANIES' });
  // A malformed terms variable leaves the operator write off rather than guessing.
  const f = fixture(); try {
    const routes = composeOperatorRoutes({ env: { REALBUD_GATEWAY_OPERATOR_SECRET: 'fictional-gateway-operator-secret-000001', REALBUD_GATEWAY_PORTAL_SECRET: 'fictional-gateway-portal-secret-00000001',
      REALBUD_ENABLE_PROVIDER: '1', REALBUD_MODELVIA_BASE_URL: 'https://api.modelvia.dev', REALBUD_MODELVIA_OPERATOR_SECRET: OPERATOR_SECRET, REALBUD_MODELVIA_OPERATOR_SUBJECT: 'realbud-provisioning',
      REALBUD_MODELVIA_CLIENT_ID: CLIENT, REALBUD_MODELVIA_MODELS: LIVE_MODELS, REALBUD_MODELVIA_RESALE_MARKUP_BASIS_POINTS: '2000' }, ledger: f.ledger, fetch: async () => { throw new Error('no call'); } });
    assert.equal(routes?.officeAiAccess, undefined);
  } finally { f.close(); }

  const m = liveModelvia(), g = gateway(m, { REALBUD_MODELVIA_CLIENT_FUNDED_COMPANIES: '', REALBUD_MODELVIA_RESALE_MARKUP_BASIS_POINTS: '3000',
    REALBUD_MODELVIA_RESALE_TERMS_REFERENCE: 'fictional-signed-order-7' }); try {
    // Until the office's billing owner accepts RealBud's terms carrying AI resale, nothing is written.
    assert.deepEqual((await g.setAccess('realbud-company-a')).terms, { state: 'acceptance_required' });
    assert.deepEqual(m.posts('/v1/operator/commercial-policies'), []);
    // The office is priced at the markup ITS accepted terms state, not the
    // deployment default (3000 here): 20% first, then 30% as a NEW policy.
    const store = new CommercialTermsStore(g.f.ledger, 'realbud-internal');
    const accept = (version: string, aiUsage: { billing: 'resale'; markupBasisPoints: number; termsReference: string }) => {
      const published = store.publish(careTermsDraft(g.f, version, '12500', { aiUsage }));
      return store.accept(g.f.owner, '2026-09', version, published.digest);
    };
    accept('care-v1', { billing: 'resale', markupBasisPoints: 2000, termsReference: 'fictional-signed-order-7' });
    const first = (await g.setAccess('realbud-company-a')).terms as Row;
    assert.deepEqual([first.state, first.created, first.clientMarkupBasisPoints, first.supersedes], ['active', true, 2000, undefined]);
    // Idempotent: the same accepted markup writes nothing more.
    assert.equal(((await g.setAccess('realbud-company-a')).terms as Row).created, false);
    const acceptance = accept('care-v2', { billing: 'resale', markupBasisPoints: 3000, termsReference: 'fictional-signed-order-7' });
    const second = (await g.setAccess('realbud-company-a')).terms as Row;
    assert.deepEqual([second.state, second.created, second.clientMarkupBasisPoints, second.supersedes], ['active', true, 3000, first.policyId]);
    const [older, policy] = m.posts('/v1/operator/commercial-policies').map(call => call.body!);
    assert.equal(older!.clientMarkupBasisPoints, 2000);
    assert.ok((policy!.effectiveAt as number) > (older!.effectiveAt as number), 'the new policy starts after the one it supersedes');
    // The office's own reference: RealBud's terms reference plus its acceptance digest.
    assert.deepEqual({ markup: policy!.clientMarkupBasisPoints, fee: policy!.platformFeeBasisPoints, reference: policy!.acceptanceReference, billing: policy!.customerBilling, payer: policy!.payer, issuer: policy!.invoiceIssuer },
      { markup: 3000, fee: 0, reference: resaleAcceptanceReference('fictional-signed-order-7', acceptance), billing: 'resale', payer: 'client', issuer: 'client' });
    assert.match(String(policy!.acceptanceReference), /^fictional-signed-order-7@[a-f0-9]{32}$/);
    const key = (await g.provision('realbud-company-a')).provisioning.model.key!;
    const answered = await chat(m, key, FIRST, 'realbud-turn-0001');
    const receipt = await receiptOf(m, key, answered.headers.get('x-request-id')!);
    assert.deepEqual({ basis: receipt.priceBasis, charged: receipt.chargedNanoAud, detail: receipt.chargeDetail, usedBy: receipt.usedBy },
      { basis: 'retail', charged: '1843000', detail: 'all_in', usedBy: { kind: 'customer', displayName: 'Fictional Office A' } });
  } finally { g.close(); }
});

test('request caps against whole-route holds: the A$4 default serves Kimi K3; the old A$1 refuses both routes with 402', async () => {
  const m = liveModelvia(), g = gateway(m); try {
    await g.setAccess('realbud-company-a');
    const key = (await g.provision('realbud-company-a')).provisioning.model.key!;
    assert.equal((await chat(m, key, { ...FIRST, model: 'kimi-k3' }, 'realbud-turn-k3')).status, 200);
    // The pre-fix default: every route's hold is above it.
    const old = gateway(m, { REALBUD_MODELVIA_REQUEST_CAP_NANO_AUD: '1000000000' }); try {
      const small = (await old.provision('realbud-company-a', 'install-two')).provisioning.model.key!;
      for (const model of ['kimi-k3', 'auto']) {
        const refused = await chat(m, small, { ...FIRST, model }, `realbud-turn-small-${model}`);
        assert.equal(refused.status, 402, model);
        assert.equal(modelviaRefusal(await refused.json())?.code, 'project_request_cap_exceeded', model);
      }
    } finally { old.close(); }
  } finally { g.close(); }
});

test('only the live route ids serve: retired ids and an `auto` allowlist entry reach no route', async () => {
  const m = liveModelvia(), g = gateway(m); try {
    await g.setAccess('realbud-company-a');
    const key = (await g.provision('realbud-company-a')).provisioning.model.key!;
    for (const model of ['hosted-canary-fast', 'hosted-canary-smart', 'deepseek-chat', 'deepseek-flash']) {
      const refused = await chat(m, key, { ...FIRST, model }, `realbud-turn-${model}`);
      assert.equal(refused.status, 503, model);
      assert.equal(modelviaRefusal(await refused.json())?.code, 'model_route_unavailable', model);
    }
  } finally { g.close(); }
  // `auto` is a request value. As an allowlist entry (the pre-fix default) it
  // matches no served route, so even an `auto` request finds none.
  const a = liveModelvia({ customers: [{ id: 'realbud-company-a', name: 'Fictional', active: true, monthlyCapNanoAud: '200000000000', maxConcurrent: 2, allowedModels: ['auto'], version: 1, clientId: CLIENT }],
    policies: [{ id: 'fictional-terms', clientId: CLIENT, customerId: 'realbud-company-a', state: 'active', effectiveAt: Date.now() - 60_000, payer: 'client', customerBilling: 'client_funded' }] });
  const old = modelviaKeyClient({ serviceOrigin: 'https://api.modelvia.dev', environment: 'production', clientId: CLIENT, allowedModels: ['auto'],
    operatorSecret: () => OPERATOR_SECRET, operatorSubject: 'realbud-provisioning', fetch: a.fetchLike });
  await old.createProject({ projectId: 'rb-auto', name: 'Fictional', customerId: 'realbud-company-a', monthlyCapNanoAud: '200000000000', requestCapNanoAud: '4000000000', maxConcurrent: 2 });
  const { key } = await old.mint({ projectId: 'rb-auto', label: 'fictional' });
  const none = await chat(a, key, FIRST, 'realbud-turn-auto');
  assert.equal(none.status, 503);
  assert.equal(modelviaRefusal(await none.json())?.code, 'model_route_unavailable');
});

test('terms writes survive races and refusals: a lost reply or a concurrent writer is re-read; skew and payer mismatches are named', async () => {
  const m = liveModelvia(), g = gateway(m); try {
    await g.setAccess('realbud-company-a');
    const direct = modelviaKeyClient({ serviceOrigin: 'https://api.modelvia.dev', environment: 'production', clientId: CLIENT, allowedModels: LIVE_MODELS.split(','),
      operatorSecret: () => OPERATOR_SECRET, operatorSubject: 'realbud-provisioning', fetch: m.fetchLike });
    // A repeat finds the policy in force and writes nothing.
    const posted = m.posts('/v1/operator/commercial-policies').length;
    assert.equal((await direct.ensureCustomerTerms('realbud-company-a', { customerBilling: 'client_funded', acceptanceReference: 'fictional-ref' })).created, false);
    assert.equal(m.posts('/v1/operator/commercial-policies').length, posted);
    assert.equal(await direct.customerTermsReadiness('realbud-company-a'), 'ready');
    assert.equal(await direct.customerTermsReadiness('realbud-missing'), 'customer_missing');
  } finally { g.close(); }

  // Modelvia's skew refusal (effectiveAt more than five minutes behind its clock)
  // and a payer mismatch are named, not retried. (A clock that far behind also
  // fails the operator token, whose window is two minutes.)
  const skew = liveModelvia({ customers: [{ id: 'realbud-company-a', name: 'Fictional', active: true, monthlyCapNanoAud: '200000000000', maxConcurrent: 2, allowedModels: LIVE_MODELS.split(','), version: 1, clientId: CLIENT }] });
  for (const [code, named] of [['commercial_acceptance_required', /modelvia_terms_clock_skew/], ['payer_migration_required', /modelvia_terms_payer_mismatch/], ['invalid_internal_commercial_policy', /modelvia_terms_refused/]] as const) {
    let posts = 0;
    const refusing: HttpTransport = async (url, init) => new URL(url).pathname === '/v1/operator/commercial-policies' && init.method === 'POST'
      ? (posts++, Response.json({ error: code }, { status: 409 })) : skew.fetchLike(url, init);
    const client = modelviaKeyClient({ serviceOrigin: 'https://api.modelvia.dev', environment: 'production', clientId: CLIENT, allowedModels: LIVE_MODELS.split(','),
      operatorSecret: () => OPERATOR_SECRET, operatorSubject: 'realbud-provisioning', fetch: refusing });
    await assert.rejects(() => client.ensureCustomerTerms('realbud-company-a', { customerBilling: 'client_funded', acceptanceReference: 'fictional-ref' }), named);
    assert.equal(posts, 1, code);
  }

  // Another writer lands a policy between our read and our write: the effective-order refusal is re-read into it.
  const race = liveModelvia({ customers: [{ id: 'realbud-company-a', name: 'Fictional', active: true, monthlyCapNanoAud: '200000000000', maxConcurrent: 2, allowedModels: LIVE_MODELS.split(','), version: 1, clientId: CLIENT }] });
  let raced = false;
  const racing: HttpTransport = async (url, init) => {
    if (!raced && new URL(url).pathname === '/v1/operator/commercial-policies' && init.method === 'POST') {
      raced = true;
      race.policies.push({ id: 'fictional-other-writer', clientId: CLIENT, customerId: 'realbud-company-a', state: 'active', effectiveAt: Date.now(), payer: 'client', customerBilling: 'client_funded' });
      return Response.json({ error: 'policy_effective_order' }, { status: 409 });
    }
    return race.fetchLike(url, init);
  };
  const racer = modelviaKeyClient({ serviceOrigin: 'https://api.modelvia.dev', environment: 'production', clientId: CLIENT, allowedModels: LIVE_MODELS.split(','),
    operatorSecret: () => OPERATOR_SECRET, operatorSubject: 'realbud-provisioning', fetch: racing });
  assert.deepEqual(await racer.ensureCustomerTerms('realbud-company-a', { customerBilling: 'client_funded', acceptanceReference: 'fictional-ref' }),
    { state: 'active', created: false, policyId: 'fictional-other-writer', customerBilling: 'client_funded' });

  // A customer that pays Modelvia itself needs no policy, and none is written.
  const own = liveModelvia({ billingMode: 'customer', customers: [{ id: 'realbud-company-a', name: 'Fictional', active: true, monthlyCapNanoAud: '200000000000', maxConcurrent: 2, allowedModels: LIVE_MODELS.split(','), version: 1, clientId: CLIENT, billingCompanyId: 'rbco_fictional_office' }] });
  const payer = modelviaKeyClient({ serviceOrigin: 'https://api.modelvia.dev', environment: 'production', clientId: CLIENT, allowedModels: LIVE_MODELS.split(','),
    operatorSecret: () => OPERATOR_SECRET, operatorSubject: 'realbud-provisioning', fetch: own.fetchLike });
  assert.deepEqual(await payer.ensureCustomerTerms('realbud-company-a', { customerBilling: 'client_funded', acceptanceReference: 'fictional-ref' }), { state: 'not_required', created: false });
  assert.equal(await payer.customerTermsReadiness('realbud-company-a'), 'ready');
  assert.deepEqual(own.posts('/v1/operator/commercial-policies'), []);
  // A customer that does not exist yet has no terms to write.
  await assert.rejects(() => payer.ensureCustomerTerms('realbud-nobody', { customerBilling: 'client_funded', acceptanceReference: 'fictional-ref' }), /modelvia_customer_not_ready/);
});
