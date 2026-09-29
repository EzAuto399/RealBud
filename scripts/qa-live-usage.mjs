#!/usr/bin/env node
/**
 * Real-time usage QA, end to end, against a LOCALLY RUN Modelvia gateway built
 * from its own branch source. Nothing hosted, nothing paid, no real provider.
 *
 *   pnpm qa:live-usage
 *
 * What it proves, in order (each step is timed and recorded in receipt.json):
 *   1. Modelvia boots from a detached git worktree of `codex/neon-release`
 *      (its own server.ts, SQLite ledger, fixed routing, one direct route).
 *   2. A fictional tenant, rate card, client `realbud-qa` and customer
 *      `fictional-office` are seeded through Modelvia's own operator HTTP API.
 *   3. OUR managed gateway (managed-gateway/server.ts) boots with
 *      REALBUD_ENABLE_PROVIDER=1 pointed at that local Modelvia, a temp secrets
 *      directory and a FAKE Composio organisation endpoint.
 *   4. Our provision route mints one installation: a Modelvia project
 *      `rb-qa-…` now exists (operator read) and one `rbk_` key was returned once.
 *   5. A real POST /v1/chat/completions with that key and NO Idempotency-Key
 *      header is admitted, dispatched and settled in Modelvia's ledger.
 *   6. Modelvia's customer analytics counts it, and our own
 *      `installationUsageSummary` reducer produces the desktop card shape.
 *   7. Revoking through our gateway refuses the next completion (401/403) and
 *      analytics does not grow.
 *
 * WHAT IT DOES NOT PROVE. The provider upstream is a local fake: the pinned
 * DeepSeek endpoint is answered in-process by a loader supplied on Modelvia's
 * command line, so no third-party provider is contacted and no model ran. There
 * is no hosted Modelvia, no Composio organisation, no Hermes worker and no
 * customer. Every identity here is fictional. See `limits` in the receipt.
 */
import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODELVIA_REPO = process.env.REALBUD_QA_MODELVIA_REPO ?? '/Users/yoda/projects/modelvia';
const MODELVIA_BRANCH = process.env.REALBUD_QA_MODELVIA_BRANCH ?? 'codex/neon-release';
/** Supply an existing worktree to reuse it; otherwise one is created and removed. */
const SUPPLIED_WORKTREE = process.env.REALBUD_QA_MODELVIA_WORKTREE ?? '';
const MV_PORT = Number(process.env.REALBUD_QA_MODELVIA_PORT ?? 18971);
const RB_PORT = Number(process.env.REALBUD_QA_GATEWAY_PORT ?? 18972);
const COMPOSIO_PORT = Number(process.env.REALBUD_QA_COMPOSIO_PORT ?? 18973);
const OUT_DIR = process.env.REALBUD_QA_OUT ?? join(ROOT, 'outputs', `live-usage-${new Date().toISOString().slice(0, 10)}`);

const COMPANY_ID = 'fictional-office-co';
const CLIENT_ID = 'realbud-qa';
const CUSTOMER_ID = 'fictional-office';
const ENVIRONMENT = 'development';
const MODEL = 'deepseek-chat';
const RATE_VERSION = 'qa-live-usage-1';
const INSTALLATION_ID = `qa-${randomUUID()}`;
const MODEL_PROJECT_ID = `rb-${INSTALLATION_ID}`;
/** Brisbane civil clock, the same period Modelvia and our website default to. */
const PERIOD = new Date(Date.now() + 36_000_000).toISOString().slice(0, 7);

const MONTHLY_CAP = '10000000000';
const REQUEST_CAP = '1000000000';

const PORTAL_SECRET = 'fictional-realbud-portal-secret-live-usage-qa';
/** Our gateway's own operator bearer secret (office AI access); distinct from the portal secret by design. */
const RB_OPERATOR_SECRET = 'fictional-realbud-operator-secret-live-usage-qa';
const MV_PORTAL_SECRET = 'fictional-modelvia-portal-secret-live-usage';
const MV_OPERATOR_SECRET = 'fictional-modelvia-operator-secret-live-usage';

const MV_BASE = `http://127.0.0.1:${MV_PORT}`;
const RB_BASE = `http://127.0.0.1:${RB_PORT}`;

// ---------------------------------------------------------------------------
// Step bookkeeping
// ---------------------------------------------------------------------------
const steps = [];
let failed = null;
async function step(name, work) {
  const started = Date.now();
  const entry = { name, status: 'running', elapsedMs: 0, detail: '' };
  steps.push(entry);
  try {
    const detail = await work(entry);
    entry.status = 'passed';
    entry.elapsedMs = Date.now() - started;
    if (typeof detail === 'string') entry.detail = detail;
    process.stdout.write(`ok    ${name} (${entry.elapsedMs} ms)${entry.detail ? ` — ${entry.detail}` : ''}\n`);
    return detail;
  } catch (error) {
    entry.status = 'failed';
    entry.elapsedMs = Date.now() - started;
    entry.detail = error instanceof Error ? error.message : String(error);
    failed ??= entry;
    process.stdout.write(`FAIL  ${name} (${entry.elapsedMs} ms) — ${entry.detail}\n`);
    throw error;
  }
}
function assert(condition, message) { if (!condition) throw new Error(message); }

// ---------------------------------------------------------------------------
// Small HTTP helpers
// ---------------------------------------------------------------------------
async function call(base, method, path, { token, body, headers = {}, timeoutMs = 60_000 } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: response.status, body: parsed, text, requestId: response.headers.get('x-request-id') };
}
/** Modelvia operator bearer: aud-scoped HMAC, minted fresh so it never ages out. */
function operatorToken(subject = 'fictional-live-usage-operator') {
  const now = Date.now();
  const payload = Buffer.from(JSON.stringify({ aud: 'managed-ai-operator', subject, iat: now, exp: now + 290_000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', MV_OPERATOR_SECRET).update(payload).digest('base64url')}`;
}
/** RealBud operator bearer (managed-gateway/operator-token.ts): exactly subject, role, iat, exp; five minutes at most. */
function realbudOperatorToken(email = 'fictional-operator@example.invalid') {
  const now = Date.now();
  const payload = Buffer.from(JSON.stringify({ subject: `operator:${email}`, role: 'realbud_operator', iat: now, exp: now + 290_000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', RB_OPERATOR_SECRET).update(payload).digest('base64url')}`;
}
function portalToken(secret, companyId = COMPANY_ID) {
  const now = Date.now();
  const payload = Buffer.from(JSON.stringify({ subject: 'fictional-live-usage-owner', companyId, role: 'billing_owner', iat: now, exp: now + 290_000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}
async function waitForHealth(base, child, label, budgetMs = 45_000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} exited early with code ${child.exitCode}: ${child.log.slice(-600)}`);
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) { await response.body?.cancel().catch(() => {}); return; }
    } catch { /* not listening yet */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`${label} never became healthy: ${child.log.slice(-600)}`);
}
function launch(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  child.log = '';
  const collect = chunk => { child.log = (child.log + chunk.toString('utf8')).slice(-8000); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise(resolve => child.once('exit', () => resolve(true))),
    new Promise(resolve => setTimeout(() => resolve(false), 8000)),
  ]);
  if (!exited) child.kill('SIGKILL');
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const workspace = mkdtempSync(join(tmpdir(), 'realbud-qa-live-usage-'));
let worktree = SUPPLIED_WORKTREE;
let createdWorktree = false;
let modelvia = null, gateway = null, composio = null;
const facts = { installationId: INSTALLATION_ID, modelProjectId: MODEL_PROJECT_ID, period: PERIOD };

try {
  await step('modelvia-worktree', () => {
    if (!worktree) {
      worktree = join(workspace, 'modelvia-worktree');
      execFileSync('git', ['-C', MODELVIA_REPO, 'worktree', 'add', '--detach', worktree, MODELVIA_BRANCH], { stdio: 'pipe' });
      createdWorktree = true;
    }
    assert(existsSync(join(worktree, 'managed-gateway', 'server.ts')), 'worktree has no managed-gateway/server.ts');
    // Reuse the sibling checkout's installed dependencies rather than a fresh
    // install: node_modules is untracked, so the branch source stays untouched.
    const modules = join(worktree, 'managed-gateway', 'node_modules');
    if (!existsSync(modules)) {
      const source = join(MODELVIA_REPO, 'managed-gateway', 'node_modules');
      assert(existsSync(source), `install Modelvia gateway dependencies first (${source} is missing)`);
      symlinkSync(source, modules);
    }
    const head = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    facts.modelviaCommit = head;
    facts.modelviaBranch = MODELVIA_BRANCH;
    return `${MODELVIA_BRANCH} @ ${head.slice(0, 12)}`;
  });

  await step('modelvia-boot', async () => {
    // One reviewed direct route. The catalogue is operator-owned input, not a
    // provider key's side effect, so it is written explicitly here.
    const catalog = join(workspace, 'route-catalog.json');
    writeFileSync(catalog, JSON.stringify([{
      model: MODEL, configuration: 'qa-live-usage', provider: 'deepseek', profile: 'fast',
      capabilities: ['text'], thinking: 'disabled', maximumOutputTokens: 64, costNanoAud: '1000',
    }], null, 2));
    // The fake upstream. DeepSeek's endpoint is pinned inside Modelvia, so the
    // only honest way to complete a request without a real provider is to answer
    // that exact URL in Modelvia's own process. Everything else still goes out.
    const hook = join(workspace, 'fictional-upstream.mjs');
    writeFileSync(hook, `const real=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
  const url=String(input instanceof Request?input.url:input);
  if(!url.startsWith('https://api.deepseek.com'))return real(input,init);
  const id='fictional-local-qa-'+Math.random().toString(16).slice(2,10);
  const frames=[
    {id,model:'${MODEL}',choices:[{index:0,delta:{role:'assistant',content:'Fictional local QA reply. No model ran.'},finish_reason:null}]},
    {id,model:'${MODEL}',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:12,completion_tokens:8,total_tokens:20,prompt_cache_hit_tokens:4,prompt_cache_miss_tokens:8}},
  ];
  return new Response(frames.map(f=>'data: '+JSON.stringify(f)+String.fromCharCode(10,10)).join('')+'data: [DONE]'+String.fromCharCode(10,10),
    {status:200,headers:{'content-type':'text/event-stream'}});
};
`);
    modelvia = launch(process.execPath, ['--experimental-strip-types', '--import', pathToFileURL(hook).href, 'server.ts'], {
      cwd: join(worktree, 'managed-gateway'),
      env: {
        PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '',
        PORT: String(MV_PORT), PLATFORM_BIND_HOST: '127.0.0.1',
        REALBUD_GATEWAY_DATA: join(workspace, 'modelvia-data'),
        REALBUD_FINGERPRINT_KEY: 'a1'.repeat(32),
        REALBUD_GATEWAY_PORTAL_SECRET: MV_PORTAL_SECRET,
        REALBUD_GATEWAY_OPERATOR_SECRET: MV_OPERATOR_SECRET,
        REALBUD_PAYMENT_MODE: 'local',
        REALBUD_ALLOWED_ORIGINS: MV_BASE,
        MODELVIA_LEDGER_BACKEND: 'sqlite',
        REALBUD_ENABLE_PROVIDER: '1',
        DEEPSEEK_API_KEY: 'fictional-local-qa-provider-key',
        DEEPSEEK_MAX_OUTPUT: '64',
        DEEPSEEK_CONTEXT: '1000',
        DEEPSEEK_TERMS_REF: 'fictional-live-usage-qa',
        DEEPSEEK_APPROVED_UNTIL: String(Date.now() + 2_592_000_000),
        PLATFORM_ROUTE_CATALOG_FILE: catalog,
        PLATFORM_ROUTING_MODE: 'fixed',
        PLATFORM_SHUTDOWN_DRAIN_MS: '1000',
      },
    });
    await waitForHealth(MV_BASE, modelvia, 'modelvia');
    const health = await call(MV_BASE, 'GET', '/health');
    assert(health.status === 200, `modelvia /health ${health.status}`);
    return `listening on ${MV_BASE}`;
  });

  await step('modelvia-seed', async () => {
    const now = Date.now();
    const operator = operatorToken();
    const post = async (path, body) => {
      const result = await call(MV_BASE, 'POST', path, { token: operator, body });
      assert(result.status === 200, `${path} → ${result.status} ${result.text.slice(0, 200)}`);
      return result.body;
    };
    await post('/v1/operator/billing-accounts', {
      companyId: COMPANY_ID, licenseId: 'fictional-live-usage-license', active: true,
      serviceExpiresAt: now + 2_592_000_000, customerName: 'Fictional Office (QA only)',
      customerAddress: '1 Fictional Street, Brisbane QLD', goLiveAt: now - 60_000,
      goLiveEvidence: 'fictional-live-usage-qa', includedUntil: now - 60_000, plan: 'platform',
      monthlyCapNanoAud: MONTHLY_CAP, requestCapNanoAud: REQUEST_CAP, maxConcurrent: 10,
      creditLimitNanoAud: MONTHLY_CAP,
    });
    const unit = { nanoAud: '1000', perUnits: 1000 };
    await post('/v1/operator/rates', {
      version: RATE_VERSION, currency: 'AUD', gstInclusive: true, gstBasisPoints: 1000,
      publishedAt: now - 1000, effectiveAt: now - 1000,
      models: [{ model: MODEL, label: 'Fictional QA text', units: { input_tokens: unit, cache_read_tokens: unit, output_tokens: unit } }],
    });
    const cards = await call(MV_BASE, 'GET', '/v1/operator/rates', { token: operator });
    const published = (cards.body?.rates ?? []).find(row => row.card.version === RATE_VERSION);
    assert(published, 'published rate card not readable');
    await post('/v1/operator/rates/accept', { companyId: COMPANY_ID, version: RATE_VERSION, digest: published.digest, acceptanceReference: 'fictional-live-usage-acceptance' });
    const common = { active: true, monthlyCapNanoAud: MONTHLY_CAP, maxConcurrent: 10, allowedModels: [MODEL], version: 0 };
    await post('/v1/operator/clients', { ...common, id: CLIENT_ID, name: 'RealBud QA (fictional)', billingMode: 'customer' });
    await post('/v1/operator/customers', { ...common, id: CUSTOMER_ID, name: 'Fictional office', clientId: CLIENT_ID, billingCompanyId: COMPANY_ID });
    const clientKey = await post('/v1/operator/client-keys', { clientId: CLIENT_ID, label: 'fictional-live-usage-reader' });
    assert(typeof clientKey?.key === 'string' && clientKey.key.length > 20, 'no client integration key returned');
    facts.clientKey = clientKey.key;
    return `client ${CLIENT_ID}, customer ${CUSTOMER_ID}, rates ${RATE_VERSION} accepted`;
  });

  await step('fake-composio', async () => {
    // Stands in for project and project-scoped auth-config calls. A fake is
    // never evidence of a real Composio project or Google OAuth grant.
    // It remembers what it created, so a second installation of the same company
    // finds the company project instead of looking like an orphaned key.
    const projects = [], authConfigs = [];
    composio = createServer(async (req, res) => {
      const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (req.method === 'GET' && req.url?.startsWith('/org/owner/project/list')) return send(200, { items: projects.map(({ id, name }) => ({ id, name })) });
      if (req.method === 'POST' && req.url?.startsWith('/org/owner/project/new')) {
        const project = { id: `pr_fictional_qa_${projects.length + 1}`, name: `realbud-${COMPANY_ID}` };
        projects.push(project);
        return send(200, { ...project, api_key: 'ak_fictional_live_usage_project_key' });
      }
      if (req.method === 'GET' && req.url?.startsWith('/auth_configs?')) {
        assert(req.headers['x-api-key'] === 'ak_fictional_live_usage_project_key');
        return send(200, { items: authConfigs, next_cursor: null });
      }
      if (req.method === 'POST' && req.url === '/auth_configs') {
        assert(req.headers['x-api-key'] === 'ak_fictional_live_usage_project_key');
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        assert(JSON.stringify(body) === JSON.stringify({ toolkit: { slug: 'gmail' }, auth_config: { type: 'use_composio_managed_auth', name: 'realbud-gmail-readonly-v1', credentials: { scopes: 'https://www.googleapis.com/auth/gmail.readonly' } } }), 'unexpected fictional Gmail auth config request');
        const authConfig = { id: 'ac_fictional_readonly', name: body.auth_config.name, toolkit: { slug: 'gmail' }, auth_scheme: 'OAUTH2', is_composio_managed: true, status: 'ENABLED', credentials: body.auth_config.credentials };
        authConfigs.push(authConfig);
        return send(201, { auth_config: { id: authConfig.id } });
      }
      return send(404, { error: 'not_found' });
    });
    await new Promise((resolve, reject) => { composio.once('error', reject); composio.listen(COMPOSIO_PORT, '127.0.0.1', resolve); });
    return `fictional Composio org endpoint on 127.0.0.1:${COMPOSIO_PORT}`;
  });

  await step('realbud-gateway-boot', async () => {
    const dataDir = join(workspace, 'realbud-data');
    mkdirSync(dataDir, { recursive: true });
    // Seed our own ledger tenant before the server opens the file: provisioning
    // reads it for the spend cap it applies at Modelvia.
    const { LedgerDatabase } = await import(pathToFileURL(join(ROOT, 'managed-gateway', 'database.ts')).href);
    const { UsageLedger } = await import(pathToFileURL(join(ROOT, 'managed-gateway', 'ledger.ts')).href);
    const { twoMonthsAfter } = await import(pathToFileURL(join(ROOT, 'managed-gateway', 'money.ts')).href);
    const db = new LedgerDatabase(join(dataDir, 'ledger.sqlite'));
    try {
      const ledger = new UsageLedger(db, Date.now);
      const goLiveAt = Date.now() - 60_000;
      ledger.provisionTenant({
        companyId: COMPANY_ID, licenseId: 'fictional-live-usage-license', active: true,
        serviceExpiresAt: Date.now() + 2_592_000_000, customerName: 'Fictional Office (QA only)',
        customerAddress: '1 Fictional Street, Brisbane QLD', goLiveAt,
        goLiveEvidence: 'fictional-live-usage-qa', includedUntil: twoMonthsAfter(goLiveAt),
        monthlyCapNanoAud: MONTHLY_CAP, requestCapNanoAud: REQUEST_CAP, maxConcurrent: 10,
      });
    } finally { db.close(); }

    gateway = launch(process.execPath, ['--experimental-strip-types', 'server.ts'], {
      cwd: join(ROOT, 'managed-gateway'),
      env: {
        PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '',
        PORT: String(RB_PORT),
        REALBUD_GATEWAY_DATA: dataDir,
        REALBUD_GATEWAY_PORTAL_SECRET: PORTAL_SECRET,
        REALBUD_GATEWAY_OPERATOR_SECRET: RB_OPERATOR_SECRET,
        // Care-fee collection stays off: this QA proves AI usage at Modelvia, not Square.
        REALBUD_PAYMENT_MODE: 'local',
        REALBUD_ALLOWED_ORIGINS: RB_BASE,
        REALBUD_ENABLE_PROVIDER: '1',
        REALBUD_GATEWAY_SECRETS_DIR: join(workspace, 'gateway-secrets'),
        REALBUD_GATEWAY_CONNECTOR_REGISTRY: join(workspace, 'registry', 'devices.json'),
        REALBUD_GATEWAY_PUBLIC_ORIGIN: 'https://fictional-live-usage.invalid',
        REALBUD_COMPOSIO_ORG_KEY: 'fictional-live-usage-org-key',
        REALBUD_COMPOSIO_API_BASE: `http://127.0.0.1:${COMPOSIO_PORT}`,
        REALBUD_MODELVIA_BASE_URL: MV_BASE,
        // The gateway mints a fresh two-minute operator bearer per call from these.
        REALBUD_MODELVIA_OPERATOR_SECRET: MV_OPERATOR_SECRET,
        REALBUD_MODELVIA_OPERATOR_SUBJECT: 'fictional-live-usage-vendor',
        REALBUD_MODELVIA_CLIENT_ID: CLIENT_ID,
        REALBUD_MODELVIA_ENVIRONMENT: ENVIRONMENT,
        REALBUD_MODELVIA_MODELS: MODEL,
      },
    });
    await waitForHealth(RB_BASE, gateway, 'realbud-gateway');
    assert(/"provisioning":"composed"/.test(gateway.log), `provisioning not composed: ${gateway.log.slice(-400)}`);
    return `listening on ${RB_BASE}, provisioning composed`;
  });

  const provisioned = await step('provision-installation', async entry => {
    const token = portalToken(PORTAL_SECRET);
    const first = await call(RB_BASE, 'POST', '/v1/portal/installations/provision', {
      token, body: { companyId: COMPANY_ID, installationId: INSTALLATION_ID, customerId: CUSTOMER_ID, profile: 'property' },
    });
    assert(first.status === 200, `provision → ${first.status} ${first.text.slice(0, 300)}`);
    const descriptor = first.body.provisioning;
    assert(/^rbk_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/.test(descriptor.model.key ?? ''), 'no rbk_ model key returned');
    assert(descriptor.model.projectId === MODEL_PROJECT_ID, `unexpected model project ${descriptor.model.projectId}`);
    assert(descriptor.model.baseUrl === `${MV_BASE}/v1`, `unexpected serving base ${descriptor.model.baseUrl}`);
    facts.modelKeyId = descriptor.model.keyId;
    facts.spendCapLabel = descriptor.model.spendCapLabel;

    // The Modelvia project really exists, read back through its operator API.
    const projects = await call(MV_BASE, 'GET', '/v1/operator/projects', { token: operatorToken() });
    assert(projects.status === 200, `operator projects → ${projects.status}`);
    const project = (projects.body?.accounts ?? []).find(account => account.id === MODEL_PROJECT_ID);
    assert(project, `${MODEL_PROJECT_ID} not found at Modelvia`);
    assert(project.customerId === CUSTOMER_ID && project.clientId === CLIENT_ID, 'project is not under the seeded customer');
    assert(project.monthlyCapNanoAud === MONTHLY_CAP && project.requestCapNanoAud === REQUEST_CAP, 'ledger caps were not applied to the project');

    // The secret is returned exactly once.
    const repeat = await call(RB_BASE, 'POST', '/v1/portal/installations/provision', {
      token, body: { companyId: COMPANY_ID, installationId: INSTALLATION_ID, customerId: CUSTOMER_ID, profile: 'property' },
    });
    assert(repeat.status === 200 && repeat.body.provisioning.model.key === undefined && repeat.body.provisioning.connector.credential === undefined,
      'a repeat provision re-issued secret material');
    // The key itself never reaches stdout or the receipt; only its record id does.
    entry.detail = `project ${MODEL_PROJECT_ID}, one rbk_ key (id ${descriptor.model.keyId}) issued once`;
    return { key: descriptor.model.key };
  });

  const modelKey = provisioned.key;
  await step('completion-no-idempotency-key', async entry => {
    const result = await call(MV_BASE, 'POST', '/v1/chat/completions', {
      token: modelKey,
      body: { model: 'auto', messages: [{ role: 'user', content: 'FICTIONAL QA: reply with one short sentence.' }], max_tokens: 32 },
      timeoutMs: 120_000,
    });
    // Either outcome is acceptable; an unadmitted request is not.
    assert([200, 502, 503].includes(result.status), `completion → ${result.status} ${result.text.slice(0, 300)}`);
    facts.completionStatus = result.status;
    if (result.status !== 200) {
      facts.completionOutcome = `provider_unavailable:${result.body?.error ?? 'unknown'}`;
      // Admission must still be visible in the ledger even when dispatch failed.
      const analytics = await call(MV_BASE, 'GET', `/v1/client/customers/${CUSTOMER_ID}/analytics?period=${PERIOD}`, { token: facts.clientKey });
      assert(analytics.status === 200 && analytics.body.summary.requests >= 1, 'a refused provider call was not recorded');
      entry.detail = `admitted and recorded, provider unavailable (${result.body?.error ?? 'unknown'})`;
      return;
    }
    const requestId = result.requestId ?? result.body?.id?.replace(/^chatcmpl-/, '');
    assert(typeof result.body?.choices?.[0]?.message?.content === 'string', 'no completion content returned');
    assert(requestId, 'no X-Request-Id on the completion');
    const receipt = await call(MV_BASE, 'GET', `/v1/requests/${requestId}`, { token: modelKey });
    assert(receipt.status === 200 && receipt.body.state === 'settled', `receipt ${receipt.status} state ${receipt.body?.state}`);
    assert(receipt.body.projectId === MODEL_PROJECT_ID, 'receipt is not scoped to this installation project');
    assert(receipt.body.pricingContract === 2, 'receipt does not identify price contract 2');
    // This fixture is a direct customer. Resale and client-funded project keys
    // can carry retail or withheld prices; a missing amount must never mean zero.
    assert(receipt.body.priceBasis === 'direct', `unexpected price basis ${receipt.body.priceBasis}`);
    assert(typeof receipt.body.chargedNanoAud === 'string' && /^\d+$/.test(receipt.body.chargedNanoAud), 'direct price is not an exact decimal amount');
    facts.completionOutcome = 'settled';
    facts.chargedNanoAud = receipt.body.chargedNanoAud;
    facts.pricingContract = receipt.body.pricingContract;
    facts.priceBasis = receipt.body.priceBasis;
    facts.priceAudience = receipt.body.priceAudience;
    entry.detail = `request ${requestId} settled, ${receipt.body.priceBasis} price ${receipt.body.chargedNanoAud} nanoAUD (contract ${receipt.body.pricingContract})`;
  });

  const before = await step('analytics-counts-the-request', async entry => {
    const direct = await call(MV_BASE, 'GET', `/v1/client/customers/${CUSTOMER_ID}/analytics?period=${PERIOD}`, { token: facts.clientKey });
    assert(direct.status === 200, `analytics → ${direct.status} ${direct.text.slice(0, 200)}`);
    assert(direct.body.scope?.customerId === CUSTOMER_ID && direct.body.period === PERIOD, 'analytics returned another scope');
    assert(direct.body.summary.requests >= 1, `analytics counted ${direct.body.summary.requests} requests`);

    // Our own desktop reducer, over our own website projection of that document.
    const analyticsModule = await import(pathToFileURL(join(ROOT, 'website', 'lib', 'platform-analytics.ts')).href);
    const env = { PLATFORM_API_URL: MV_BASE, PLATFORM_CLIENT_KEY: facts.clientKey, REALBUD_PLATFORM_CUSTOMERS_JSON: JSON.stringify({ [COMPANY_ID]: CUSTOMER_ID }) };
    const projected = await analyticsModule.platformAnalytics({ companyId: COMPANY_ID, role: 'billing_owner' }, env, new URLSearchParams({ period: PERIOD }));
    assert(projected.status === 200, `platformAnalytics → ${projected.status}`);
    const summary = analyticsModule.installationUsageSummary(await projected.json());
    assert(summary.period === PERIOD, 'summary period mismatch');
    assert(Number.isSafeInteger(summary.requests) && summary.requests >= 1, 'summary lost the request count');
    assert(/^\d+$/.test(summary.tokens.input) && /^\d+$/.test(summary.tokens.output), 'summary token totals are not decimal strings');
    assert(summary.money.customerNetNanoAud === null || /^\d+$/.test(summary.money.customerNetNanoAud), 'summary amount is not a decimal string');
    assert(Number.isSafeInteger(summary.updatedAt) && summary.updatedAt > 0, 'summary has no generatedAt');
    const exposed = JSON.stringify(summary);
    for (const hidden of ['platformFee', 'clientMarkup', 'providerCost', facts.clientKey, modelKey]) assert(!exposed.includes(hidden), `desktop summary leaked ${hidden}`);
    facts.installationUsageSummary = summary;
    entry.detail = `${direct.body.summary.requests} request(s), desktop summary in=${summary.tokens.input} out=${summary.tokens.output} net=${summary.money.customerNetNanoAud}`;
    return { requests: direct.body.summary.requests, summary };
  });

  await step('revoke-refuses-further-usage', async () => {
    const token = portalToken(PORTAL_SECRET);
    const revoked = await call(RB_BASE, 'POST', '/v1/portal/installations/revoke', { token, body: { companyId: COMPANY_ID, installationId: INSTALLATION_ID } });
    assert(revoked.status === 200, `revoke → ${revoked.status} ${revoked.text.slice(0, 300)}`);
    assert(revoked.body.revoked.modelKeyRevoked === true && revoked.body.revoked.modelKeyId === facts.modelKeyId, 'revocation did not name the minted key');
    assert(revoked.body.revoked.modelProjectRetained === MODEL_PROJECT_ID, 'the billing project was not retained');

    const second = await call(MV_BASE, 'POST', '/v1/chat/completions', {
      token: modelKey,
      body: { model: 'auto', messages: [{ role: 'user', content: 'FICTIONAL QA: this must be refused.' }], max_tokens: 32 },
    });
    assert([401, 403].includes(second.status), `revoked key still admitted: ${second.status} ${second.text.slice(0, 200)}`);
    facts.refusedStatus = second.status;
    facts.refusedError = typeof second.body?.error === 'string' ? second.body.error : second.body?.error?.code ?? null;

    const after = await call(MV_BASE, 'GET', `/v1/client/customers/${CUSTOMER_ID}/analytics?period=${PERIOD}`, { token: facts.clientKey });
    assert(after.status === 200, `analytics after revoke → ${after.status}`);
    assert(after.body.summary.requests === before.requests, `analytics grew after revocation: ${before.requests} → ${after.body.summary.requests}`);
    return `revoked key refused ${second.status} ${facts.refusedError ?? ''}, analytics still ${after.body.summary.requests}`;
  });

  // A provision whose reply was lost left a Modelvia project and one labelled key
  // behind, with no record in our ledger. Provisioning again must use that
  // project, rotate the orphaned key (old secret refused, new one works) and
  // leave exactly one live key, with no operator involved.
  const LOST_ID = `qa-${randomUUID()}`, LOST_PROJECT = `rb-${LOST_ID}`;
  await step('lost-reply-recovers-by-rotation', async () => {
    const operator = operatorToken();
    const projects = await call(MV_BASE, 'GET', '/v1/operator/projects', { token: operator });
    const template = (projects.body?.accounts ?? []).find(account => account.id === MODEL_PROJECT_ID);
    assert(template, 'the first installation project is needed as a template');
    const { version: _version, ...shape } = template;
    const created = await call(MV_BASE, 'POST', '/v1/operator/projects', { token: operator, body: { ...shape, id: LOST_PROJECT, name: `RealBud ${LOST_ID}`, version: 0 } });
    assert(created.status === 200, `pre-create project → ${created.status} ${created.text.slice(0, 200)}`);
    const orphan = await call(MV_BASE, 'POST', '/v1/operator/keys', { token: operator, body: { projectId: LOST_PROJECT, environment: ENVIRONMENT, label: `${COMPANY_ID}:${LOST_ID}` } });
    assert(orphan.status === 200 && typeof orphan.body?.key === 'string', `pre-mint orphan key → ${orphan.status} ${orphan.text.slice(0, 200)}`);

    const token = portalToken(PORTAL_SECRET);
    const recovered = await call(RB_BASE, 'POST', '/v1/portal/installations/provision', {
      token, body: { companyId: COMPANY_ID, installationId: LOST_ID, customerId: CUSTOMER_ID, profile: 'property' },
    });
    assert(recovered.status === 200, `provision after a lost reply → ${recovered.status} ${recovered.text.slice(0, 300)}`);
    const fresh = recovered.body.provisioning?.model?.key;
    assert(/^rbk_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/.test(fresh ?? ''), 'no fresh rbk_ key after recovery');
    assert(recovered.body.provisioning.model.projectId === LOST_PROJECT, 'recovery did not use the existing project');
    assert(fresh !== orphan.body.key, 'the orphaned secret was handed out again');

    const keys = await call(MV_BASE, 'GET', `/v1/operator/keys?projectId=${encodeURIComponent(LOST_PROJECT)}&environment=${encodeURIComponent(ENVIRONMENT)}`, { token: operator });
    const live = (keys.body?.keys ?? []).filter(key => !key.revokedAt);
    assert(live.length === 1, `expected one live key after recovery, found ${live.length}`);

    const ask = content => call(MV_BASE, 'POST', '/v1/chat/completions', { token: ask.key, body: { model: 'auto', messages: [{ role: 'user', content }], max_tokens: 32 } });
    ask.key = orphan.body.key; const old = await ask('FICTIONAL QA: the rotated secret must be refused.');
    assert([401, 403].includes(old.status), `the orphaned secret still works: ${old.status}`);
    ask.key = fresh; const works = await ask('FICTIONAL QA: the recovered key works.');
    assert(works.status === 200, `the recovered key was refused: ${works.status} ${works.text.slice(0, 200)}`);
    facts.lostReply = { projectId: LOST_PROJECT, liveKeys: live.length, orphanRefused: old.status };
    return `project ${LOST_PROJECT} reused, orphan refused ${old.status}, new key answered 200, 1 live key`;
  });

  // A cap change made by a RealBud operator (the Offices page) reaches every
  // provisioned Modelvia project. Caps are Modelvia's: the portal has no limits
  // route, so the operator route is the one write path.
  await step('cap-change-reaches-modelvia', async () => {
    const monthly = String(BigInt(MONTHLY_CAP) * 2n);
    const changed = await call(RB_BASE, 'POST', '/v1/operator/offices/ai-access', { token: realbudOperatorToken(), body: {
      companyId: COMPANY_ID, customerId: CUSTOMER_ID, name: 'Fictional Office (QA only)', access: { mode: 'custom', monthlyCapNanoAud: monthly } } });
    assert(changed.status === 200, `office ai-access → ${changed.status} ${changed.text.slice(0, 300)}`);
    assert((await call(RB_BASE, 'POST', '/v1/portal/limits', { token: portalToken(PORTAL_SECRET), body: {} })).status === 404, 'the portal limits route still exists');
    const projects = await call(MV_BASE, 'GET', '/v1/operator/projects', { token: operatorToken() });
    const accounts = projects.body?.accounts ?? [];
    // Only installations still in service are synced; the revoked first one keeps
    // its project for billing but has no live key, so its caps are left alone.
    const live = accounts.find(account => account.id === LOST_PROJECT);
    const revoked = accounts.find(account => account.id === MODEL_PROJECT_ID);
    assert(live && live.monthlyCapNanoAud === monthly, `${LOST_PROJECT} kept its old caps`);
    assert(revoked && revoked.monthlyCapNanoAud === MONTHLY_CAP, 'the revoked installation project was changed');
    facts.capSync = { monthlyCapNanoAud: monthly, synced: LOST_PROJECT, leftAlone: MODEL_PROJECT_ID, reply: changed.body?.projects ?? null };
    return `monthly cap ${monthly} nanoAUD on the live installation's Modelvia project through the operator route; the revoked one left as it was`;
  });
} catch {
  /* the failing step is already recorded; the receipt is written below */
} finally {
  await stop(gateway);
  await stop(modelvia);
  if (composio) await new Promise(resolve => composio.close(resolve));

  mkdirSync(OUT_DIR, { recursive: true });
  const receipt = {
    check: 'realbud-live-usage',
    layer: 'local-modelvia-branch',
    checkedAt: new Date().toISOString(),
    node: process.version,
    modelvia: { repository: MODELVIA_REPO, branch: facts.modelviaBranch ?? MODELVIA_BRANCH, commit: facts.modelviaCommit ?? null, origin: MV_BASE },
    realbudGateway: { origin: RB_BASE, source: join(ROOT, 'managed-gateway', 'server.ts') },
    tenant: { companyId: COMPANY_ID, clientId: CLIENT_ID, customerId: CUSTOMER_ID, environment: ENVIRONMENT, model: MODEL, fictional: true },
    installation: { installationId: INSTALLATION_ID, modelProjectId: MODEL_PROJECT_ID, modelKeyId: facts.modelKeyId ?? null, spendCapLabel: facts.spendCapLabel ?? null },
    usage: {
      period: PERIOD,
      completionStatus: facts.completionStatus ?? null,
      completionOutcome: facts.completionOutcome ?? null,
      chargedNanoAud: facts.chargedNanoAud ?? null,
      pricingContract: facts.pricingContract ?? null,
      priceBasis: facts.priceBasis ?? null,
      priceAudience: facts.priceAudience ?? null,
      idempotencyKeyHeaderSent: false,
      afterRevokeStatus: facts.refusedStatus ?? null,
      afterRevokeError: facts.refusedError ?? null,
      installationUsageSummary: facts.installationUsageSummary ?? null,
    },
    steps: steps.map(({ name, status, elapsedMs, detail }) => ({ name, status, elapsedMs, detail })),
    totalElapsedMs: steps.reduce((sum, entry) => sum + entry.elapsedMs, 0),
    passed: !failed,
    ...(failed ? { failedStep: failed.name, failure: failed.detail } : {}),
    limits: [
      'Local only: Modelvia ran from a detached git worktree of its own branch on loopback. No hosted Modelvia, no api.modelvia.dev, no deployment.',
      'No real model provider. The pinned DeepSeek endpoint was answered in-process by a fictional upstream supplied on Modelvia\'s command line; no third-party provider was contacted and no model ran.',
      'The Composio organisation surface was a local fake (list + create only). No Composio project, no OAuth credential and no real ak_ key exist.',
      'Every identity is fictional: company, client, customer, licence, rate card, operator and portal principals. None of it is customer evidence.',
      'No Hermes worker, no desktop app, no browser and no customer session took part. The desktop card shape was checked by running the reducer, not by rendering a screen.',
      'No money moved and no payment surface was exercised; the rate card and caps are invented for this run.',
      'Modelvia gateway dependencies were reused from the sibling checkout\'s node_modules rather than a fresh npm ci.',
    ],
  };
  writeFileSync(join(OUT_DIR, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  rmSync(workspace, { recursive: true, force: true });
  if (createdWorktree) {
    try { execFileSync('git', ['-C', MODELVIA_REPO, 'worktree', 'remove', '--force', worktree], { stdio: 'pipe' }); }
    catch { /* the workspace is already gone; prune on the next run */ }
    try { execFileSync('git', ['-C', MODELVIA_REPO, 'worktree', 'prune'], { stdio: 'pipe' }); } catch { /* best effort */ }
  }

  process.stdout.write(`\nreceipt: ${join(OUT_DIR, 'receipt.json')}\n`);
  if (failed) {
    process.stdout.write(`\nFAILED STEP: ${failed.name} — ${failed.detail}\n`);
    process.stdout.write(`${steps.filter(entry => entry !== failed).map(entry => `  ${entry.status.padEnd(6)} ${entry.name} (${entry.elapsedMs} ms)`).join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${steps.length}/${steps.length} steps passed in ${receipt.totalElapsedMs} ms — fictional tenant, local Modelvia, no real provider.\n`);
  }
}
