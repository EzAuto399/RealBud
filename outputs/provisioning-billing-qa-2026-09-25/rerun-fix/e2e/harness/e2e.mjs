// Provisioning QA rig (25 Sep 2026). Real desktop link code -> real website
// route handlers (SQL in a disposable PostgreSQL) -> real RealBud gateway
// process -> real local Modelvia process (origin/main, sqlite, fictional
// in-process provider) + fictional Composio org server. Loopback only.
// Fictional offices. No hosted vendor, no paid call, no source edits.
import assert from 'node:assert/strict';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHmac, randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const execRaw = promisify(execFile);
const exec = (cmd, args, opts = {}) => execRaw(cmd, args, { ...opts, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });

const VARIANT = process.env.VARIANT; const ROOT = process.env.RB_ROOT; const OUT = process.env.OUT;
const SCRATCH = process.env.QA_SCRATCH; const MV = process.env.MV_TREE;
const MODELS = process.env.QA_MODELS ?? '';           // '' -> gateway default ('auto')
const BILLING = process.env.QA_BILLING_MODE ?? 'customer';
const ONLY = (process.env.QA_ONLY ?? '').split(',').filter(Boolean);
assert(VARIANT && ROOT && OUT && SCRATCH && MV);
mkdirSync(OUT, { recursive: true });
const run = mkdtempSync(join(SCRATCH, `run-${VARIANT}-`));
const home = join(run, 'home'), data = join(home, 'data'); mkdirSync(data, { recursive: true, mode: 0o700 });
Object.assign(process.env, { HOME: home, USERPROFILE: home, REALBUD_DATA_DIR: data, REALBUD_HERMES_HOME: join(data, 'hermes'), HERMES_HOME: join(data, 'hermes') });

const model = 'deepseek-chat';
const portalSecret = 'fictional-qa-portal-secret-2026-09-25-xxxxxxxx';
const gwOperatorSecret = 'fictional-qa-rb-operator-secret-2026-09-25-yyyy';
const mvSecret = 'fictional-qa-modelvia-operator-secret-2026-09-25';
const CLIENT = 'rb-client-qa';
const receipt = { at: new Date().toISOString(), variant: VARIANT, root: ROOT, models: MODELS || '(gateway default: auto)', billingMode: BILLING, proofLayer: 'Local source: real desktop office-link + website route handlers (real SQL, disposable PostgreSQL) + real RealBud gateway process + real local Modelvia origin/main process; fictional Composio org and fictional upstream model provider. No hosted vendor.', scenarios: {} };
const redact = s => String(s).replace(/\brbk_[A-Za-z0-9_-]+/g, m => m.slice(0, 12) + '…').replace(/\brbc_[A-Za-z0-9_-]+/g, 'rbc_…').replace(/\bak_[A-Za-z0-9_-]+/g, 'ak_…');
const save = () => writeFileSync(join(OUT, `receipt-${VARIANT}.json`), redact(JSON.stringify(receipt, null, 2)) + '\n');
let current;
function check(name, ok, detail) { const entry = { name, passed: !!ok, ...(detail === undefined ? {} : { detail }) }; current.checks.push(entry); console.log(`${ok ? 'PASS' : 'FAIL'} [${current.id}] ${name}${detail !== undefined ? ' ' + redact(JSON.stringify(detail)).slice(0, 300) : ''}`); return !!ok; }
async function scenario(id, title, fn) {
  if (ONLY.length && !ONLY.includes(id)) return;
  current = receipt.scenarios[id] = { id, title, checks: [] }; const t = performance.now();
  try { await fn(); } catch (e) { current.error = redact(e?.stack ?? e).slice(0, 1500); console.log(`ERROR [${id}] ${redact(e?.message ?? e)}`); }
  current.elapsedMs = Math.round(performance.now() - t);
  current.result = current.error ? 'error' : current.checks.every(c => c.passed) ? 'pass' : 'fail'; save();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function freePort() { const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const n = s.address().port; await new Promise(r => s.close(r)); return n; }
const children = [];
function launch(name, args, env, cwd) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.log = ''; for (const st of [child.stdout, child.stderr]) st.on('data', b => { child.log = (child.log + redact(b.toString())).slice(-30000); });
  children.push(child); return child;
}
async function until(fn, label, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return; } catch {} await sleep(150); } throw new Error('timeout ' + label); }

// ---- loopback-only fetch in this process; fictional hosts are rewritten ----
const realFetch = globalThis.fetch;
const faults = { gateway: 'normal', slow: [] };
let gwPort;
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === 'string' ? input : input.url ?? String(input));
  if (u.hostname === 'rb-gateway.fictional.test') {
    const target = `http://127.0.0.1:${gwPort}${u.pathname}${u.search}`;
    const provision = u.pathname === '/v1/portal/installations/provision';
    if (faults.gateway === 'down') throw new TypeError('fetch failed');
    if (provision && faults.gateway === 'lose-provision-reply') {
      faults.gateway = 'normal';
      const r = await realFetch(target, { ...init, signal: undefined }); faults.lostReply = { status: r.status, body: await r.text() };
      throw new TypeError('socket hang up');
    }
    if (provision && faults.gateway === 'slow') {
      faults.gateway = 'normal';
      const started = Date.now();
      const upstream = realFetch(target, { ...init, signal: undefined }).then(async r => ({ status: r.status, body: await r.text(), ms: Date.now() - started }));
      faults.slow.push(upstream);
      await new Promise((resolve, reject) => { const t = setTimeout(resolve, faults.slowMs ?? 12_000); init.signal?.addEventListener('abort', () => { clearTimeout(t); reject(init.signal.reason ?? new Error('aborted')); }, { once: true }); });
      const r = await upstream; return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json' } });
    }
    const r = await realFetch(target, init); return new Response(r.body, { status: r.status, headers: r.headers });
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Error('QA denied non-loopback fetch: ' + u.hostname);
  return realFetch(input, init);
};

// ---- PostgreSQL with the website's real migrations ----
const PGBIN = process.env.REALBUD_TEST_POSTGRES_BIN ?? '/opt/homebrew/opt/postgresql@16/bin';
const pgPort = await freePort(); const pgData = join(run, 'pg');
await exec(join(PGBIN, 'initdb'), ['-D', pgData, '--auth=trust', '--no-locale', '--encoding=UTF8']);
await exec(join(PGBIN, 'pg_ctl'), ['-D', pgData, '-l', join(run, 'pg.log'), '-o', `-p ${pgPort} -c listen_addresses=127.0.0.1 -c unix_socket_directories=''`, '-w', 'start']);
const sql = async text => (await exec(join(PGBIN, 'psql'), ['-h', '127.0.0.1', '-p', String(pgPort), '-d', 'postgres', '-XAt', '-v', 'ON_ERROR_STOP=1', '-c', text], { maxBuffer: 8 << 20 })).stdout.trim();
const lit = v => v === null || v === undefined ? 'null' : typeof v === 'boolean' ? String(v) : Array.isArray(v) ? `array[${v.map(lit).join(',')}]::text[]` : `'${String(v).replaceAll("'", "''")}'`;
const rpcLog = [];
globalThis.__rbDb = { async rpc(name, args) {
  assert(/^realbud_[a-z_]+$/.test(name));
  const call = `select public.${name}(${Object.entries(args).map(([k, v]) => `${k} => ${lit(v)}`).join(', ')})::text`;
  try {
    const out = (await sql(`set role service_role; ${call}`)).replace(/^SET\n?/, '');
    let value; try { value = out === '' ? null : JSON.parse(out); } catch { value = out; }
    rpcLog.push({ name, ok: true }); return { data: value, error: null };
  } catch (e) { const m = /ERROR:\s+([^\n]+)/.exec(e.stderr ?? '')?.[1] ?? 'rpc_failed'; rpcLog.push({ name, error: m }); return { data: null, error: { message: m } }; }
} };
const offices = ['office-alpha', 'office-bravo', 'office-charlie', 'office-delta'];
await sql(`create role anon; create role authenticated; create role service_role bypassrls; create table billing_accounts (company_id text, email text, agency_label text, role text, disabled_at bigint); grant select on billing_accounts to service_role;
  insert into billing_accounts values ${offices.map(o => `('${o}','owner@${o}.example.test','Fictional ${o}','billing_owner',null)`).join(',')};`);
for (const m of ['202609200001_installations.sql', '202609220006_installation_provisioning.sql', '202609220007_report_provisioning_scope.sql', '202609240001_provisioning_attempt_revoke.sql', '202609240003_release_provisioning_attempt.sql'])
  await sql(readFileSync(join(ROOT, 'website/supabase/migrations', m), 'utf8'));
const row = async id => JSON.parse(await sql(`select row_to_json(o)::text from office_installations o where id='${id}'`) || 'null');

// ---- local Modelvia (origin/main) with a fictional upstream ----
const mvPort = await freePort(); const mvBase = `http://127.0.0.1:${mvPort}`;
writeFileSync(join(run, 'catalog.json'), JSON.stringify([{ model, configuration: 'qa-fixed', provider: 'deepseek', profile: 'fast', capabilities: ['text', 'tools'], thinking: 'disabled', maximumOutputTokens: 256, contextLength: 65536, costNanoAud: '1000' }]));
writeFileSync(join(run, 'guard.mjs'), `const f=globalThis.fetch;globalThis.fetch=async(i,n)=>{const u=new URL(i instanceof Request?i.url:String(i));if(u.hostname==='api.deepseek.com')return f(i,n);if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw new Error('QA denied nonloopback fetch');return f(i,n);};\n`);
writeFileSync(join(run, 'provider.mjs'), `import {appendFileSync} from 'node:fs';const real=globalThis.fetch;globalThis.fetch=async(input,init)=>{const u=new URL(input instanceof Request?input.url:String(input));if(u.hostname!=='api.deepseek.com')return real(input,init);const body=JSON.parse(init.body);appendFileSync(${JSON.stringify(join(run, 'upstream.jsonl'))},JSON.stringify({model:body.model,stream:body.stream})+'\\n');const id='fictional-'+Math.random().toString(16).slice(2);const usage={prompt_tokens:123,completion_tokens:1,total_tokens:124,prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:123};if(!body.stream)return Response.json({id,object:'chat.completion',model:body.model,choices:[{index:0,message:{role:'assistant',content:'OK'},finish_reason:'stop'}],usage});const frames=[{id,model:body.model,choices:[{index:0,delta:{role:'assistant',content:'OK'},finish_reason:null}]},{id,model:body.model,choices:[{index:0,delta:{},finish_reason:'stop'}],usage}];return new Response(frames.map(v=>'data: '+JSON.stringify(v)+'\\n\\n').join('')+'data: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}});};\n`);
const mv = launch('modelvia', ['--experimental-strip-types', '--import', join(run, 'provider.mjs'), '--import', join(run, 'guard.mjs'), 'server.ts'], {
  PATH: dirname(process.execPath) + ':/usr/bin:/bin', HOME: home, PORT: String(mvPort), PLATFORM_BIND_HOST: '127.0.0.1', REALBUD_GATEWAY_DATA: join(run, 'mv-data'), REALBUD_FINGERPRINT_KEY: 'a1'.repeat(32), REALBUD_GATEWAY_PORTAL_SECRET: 'fictional-qa-modelvia-portal-secret-xxxxxxxxxxxx', REALBUD_GATEWAY_OPERATOR_SECRET: mvSecret, REALBUD_PAYMENT_MODE: 'local', REALBUD_ALLOWED_ORIGINS: mvBase, MODELVIA_LEDGER_BACKEND: 'sqlite', REALBUD_ENABLE_PROVIDER: '1', DEEPSEEK_API_KEY: 'fictional-upstream-key', DEEPSEEK_MODEL: model, DEEPSEEK_MAX_OUTPUT: '256', DEEPSEEK_CONTEXT: '65536', DEEPSEEK_TERMS_REF: 'fictional-qa', DEEPSEEK_APPROVED_UNTIL: String(Date.now() + 6 * 3600000), PLATFORM_ROUTE_CATALOG_FILE: join(run, 'catalog.json'), PLATFORM_ROUTING_MODE: 'fixed', PLATFORM_SHUTDOWN_DRAIN_MS: '1000',
}, join(MV, 'managed-gateway'));
await until(async () => { if (mv.exitCode !== null) throw new Error('modelvia exited: ' + mv.log.slice(-3000)); return (await realFetch(mvBase + '/health')).status === 200; }, 'modelvia', 60000).catch(e => { console.log(mv.log.slice(-4000)); throw e; });
const bearer = (secret, payload) => { const now = Date.now(), text = Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + 120000 })).toString('base64url'); return text + '.' + createHmac('sha256', secret).update(text).digest('base64url'); };
const mvOp = () => bearer(mvSecret, { aud: 'managed-ai-operator', subject: 'fictional-qa-operator' });
async function mvCall(path, body, method = body === undefined ? 'GET' : 'POST') {
  const r = await realFetch(mvBase + path, { method, headers: { authorization: `Bearer ${mvOp()}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; } return { status: r.status, body: json };
}
async function mvPost(path, body) { const r = await mvCall(path, body); if (r.status !== 200 && r.status !== 201) throw new Error(`${path} ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; }
const t0 = Date.now(); const HUGE = '1000000000000';
const billingCompanies = ['office-alpha', 'office-bravo', 'office-charlie', 'office-delta', ...(BILLING === 'client' ? ['realbud-vendor'] : [])];
for (const company of billingCompanies)
  await mvPost('/v1/operator/billing-accounts', { companyId: company, licenseId: `lic-${company}`, active: true, serviceExpiresAt: t0 + 6 * 3600000, customerName: `Fictional ${company}`, customerAddress: '1 Fictional Street', goLiveAt: t0 - 60000, goLiveEvidence: 'fictional-qa', includedUntil: t0 - 60000, plan: 'platform', monthlyCapNanoAud: HUGE, requestCapNanoAud: HUGE, maxConcurrent: 4, creditLimitNanoAud: HUGE });
const unit = { nanoAud: '1000', perUnits: 1000 };
await mvPost('/v1/operator/rates', { version: 'qa-rate-1', currency: 'AUD', gstInclusive: true, gstBasisPoints: 1000, publishedAt: t0 - 1000, effectiveAt: t0 - 1000, models: [{ model, label: 'Fictional QA', units: { input_tokens: unit, cache_read_tokens: unit, output_tokens: unit } }] });
const card = (await mvCall('/v1/operator/rates')).body.rates.find(x => x.card.version === 'qa-rate-1');
for (const company of billingCompanies) await mvPost('/v1/operator/rates/accept', { companyId: company, version: 'qa-rate-1', digest: card.digest, acceptanceReference: 'fictional-qa' });
const allowed = [model, 'auto'];
await mvPost('/v1/operator/clients', { id: CLIENT, name: 'RealBud QA client', active: true, monthlyCapNanoAud: HUGE, maxConcurrent: 20, allowedModels: allowed, version: 0, billingMode: BILLING, ...(BILLING === 'client' ? { billingCompanyId: 'realbud-vendor' } : {}) });
await mvPost('/v1/operator/customers', { id: 'cust-alpha', name: 'Fictional Alpha Realty', clientId: CLIENT, ...(BILLING === 'customer' ? { billingCompanyId: 'office-alpha' } : {}), active: true, monthlyCapNanoAud: '50000000000', maxConcurrent: 2, allowedModels: allowed, version: 0 });
await mvPost('/v1/operator/customers', { id: 'realbud-office-bravo', name: 'Fictional Bravo Property', clientId: CLIENT, ...(BILLING === 'customer' ? { billingCompanyId: 'office-bravo' } : {}), active: true, monthlyCapNanoAud: '20000000000', maxConcurrent: 1, allowedModels: allowed, version: 0 });
const mvProjects = async () => (await mvCall('/v1/operator/projects')).body.accounts;
const mvCustomers = async () => (await mvCall('/v1/operator/customers')).body.accounts;
const mvKeys = async project => (await mvCall(`/v1/operator/keys?${new URLSearchParams({ projectId: project, environment: 'development' })}`)).body.keys;
async function infer(key, requestModel = 'auto') {
  const r = await realFetch(mvBase + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'idempotency-key': randomBytes(8).toString('hex') }, body: JSON.stringify({ model: requestModel, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 16 }) });
  const text = await r.text(); let code; try { code = JSON.parse(text)?.error?.code ?? JSON.parse(text)?.error; } catch {} return { status: r.status, code: typeof code === 'string' ? code : undefined };
}

// ---- fictional Composio organisation ----
const composio = { projects: [], created: [], deleted: [], keys: {} };
const composioServer = createServer(async (req, res) => {
  const send = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (!req.headers['x-org-api-key']) return send(401, { error: 'no org key' });
  if (req.method === 'GET' && req.url.startsWith('/org/owner/project/list')) return send(200, { items: composio.projects.map(({ id, name }) => ({ id, name })) });
  if (req.method === 'POST' && req.url.startsWith('/org/owner/project/new')) {
    const chunks = []; for await (const c of req) chunks.push(c); const body = JSON.parse(Buffer.concat(chunks).toString());
    const p = { id: `pr_qa${composio.created.length + 1}${randomBytes(3).toString('hex')}`, name: body.name }; const key = `ak_${randomBytes(18).toString('hex')}`;
    composio.projects.push(p); composio.created.push({ ...p, shouldCreateKey: body.should_create_api_key }); composio.keys[p.id] = key; return send(200, { ...p, api_key: key });
  }
  const del = /^\/org\/owner\/project\/(pr_[A-Za-z0-9_-]+)\?revoke_on_delete=true$/.exec(req.url);
  if (req.method === 'DELETE' && del) { composio.projects = composio.projects.filter(p => p.id !== del[1]); composio.deleted.push(del[1]); return send(200, { status: 'success', revoke_job_id: 'job_' + del[1] }); }
  send(404, {});
});
composioServer.listen(0, '127.0.0.1'); await once(composioServer, 'listening');
const composioBase = `http://127.0.0.1:${composioServer.address().port}`;

// ---- real RealBud gateway (this variant's source) ----
const gwData = join(run, 'gw'); mkdirSync(gwData);
{
  const { LedgerDatabase } = await import(join(ROOT, 'managed-gateway/database.ts'));
  const { UsageLedger } = await import(join(ROOT, 'managed-gateway/ledger.ts'));
  const { twoMonthsAfter } = await import(join(ROOT, 'managed-gateway/money.ts'));
  const db = new LedgerDatabase(join(gwData, 'ledger.sqlite'));
  try { const live = Date.now() - 60000; const l = new UsageLedger(db, Date.now);
    for (const o of offices) l.provisionTenant({ companyId: o, licenseId: `lic-${o}`, active: true, serviceExpiresAt: Date.now() + 6 * 3600000, customerName: `Fictional ${o}`, customerAddress: '1 Fictional Street', goLiveAt: live, goLiveEvidence: 'fictional-qa', includedUntil: twoMonthsAfter(live), monthlyCapNanoAud: HUGE, requestCapNanoAud: '1000000000', maxConcurrent: 4 });
  } finally { db.close(); }
}
gwPort = await freePort();
const secretsDir = join(run, 'gw-secrets'), registry = join(run, 'gw-registry/devices.json');
writeFileSync(join(run, 'gw-rewrite.mjs'), `const f=globalThis.fetch;globalThis.fetch=async(i,n)=>{const u=new URL(i instanceof Request?i.url:String(i));if(u.hostname==='modelvia.fictional.test'){const r=await f('http://127.0.0.1:${mvPort}'+u.pathname+u.search,n);return new Response(r.body,{status:r.status,headers:r.headers});}return f(i,n);};\n`);
const gateway = launch('realbud-gateway', ['--experimental-strip-types', '--import', join(run, 'guard.mjs'), '--import', join(run, 'gw-rewrite.mjs'), 'server.ts'], {
  HOME: home, PATH: dirname(process.execPath) + ':/usr/bin:/bin', PORT: String(gwPort), REALBUD_GATEWAY_DATA: gwData, REALBUD_GATEWAY_PORTAL_SECRET: portalSecret, REALBUD_GATEWAY_OPERATOR_SECRET: gwOperatorSecret, REALBUD_PAYMENT_MODE: 'local', REALBUD_ALLOWED_ORIGINS: `http://127.0.0.1:${gwPort}`, REALBUD_ENABLE_PROVIDER: '1', REALBUD_GATEWAY_SECRETS_DIR: secretsDir, REALBUD_GATEWAY_CONNECTOR_REGISTRY: registry, REALBUD_GATEWAY_PUBLIC_ORIGIN: 'https://rb-gateway.fictional.test', REALBUD_COMPOSIO_ORG_KEY: 'fictional-qa-org-key', REALBUD_COMPOSIO_AUTH_CONFIG_GMAIL: 'ac_fictional_readonly', REALBUD_COMPOSIO_API_BASE: composioBase, REALBUD_MODELVIA_BASE_URL: 'https://modelvia.fictional.test', REALBUD_MODELVIA_OPERATOR_SECRET: mvSecret, REALBUD_MODELVIA_OPERATOR_SUBJECT: 'fictional-qa-vendor', REALBUD_MODELVIA_CLIENT_ID: CLIENT, REALBUD_MODELVIA_ENVIRONMENT: 'development', ...(MODELS ? { REALBUD_MODELVIA_MODELS: MODELS } : {}),
}, join(ROOT, 'managed-gateway'));
if (process.env.QA_EXPECT_UNCONFIGURED) {
  await until(async () => { const r = await realFetch(`http://127.0.0.1:${gwPort}/ready`); receipt.ready = { status: r.status, body: await r.json() }; return true; }, 'gateway ready read', 45000);
  current = receipt.scenarios.A1b = { id: 'A1b', title: `REALBUD_MODELVIA_MODELS=${MODELS || '(unset)'}: gateway refuses to compose provisioning`, checks: [] };
  check('/ready 503 provisioning_unconfigured:REALBUD_MODELVIA_MODELS', receipt.ready.status === 503 && receipt.ready.body?.error === 'provisioning_unconfigured:REALBUD_MODELVIA_MODELS', receipt.ready);
  const prov = await realFetch(`http://127.0.0.1:${gwPort}/v1/portal/installations/provision`, { method: 'POST', headers: { authorization: 'Bearer x', 'content-type': 'application/json' }, body: '{}' });
  check('provision route answers 503 without composing (nothing minted)', prov.status === 503 || prov.status === 401, { status: prov.status });
  const mvp = (await mvCall('/v1/operator/projects')).body.accounts.filter(p => p.id.startsWith('rb-'));
  check('no Modelvia project created', mvp.length === 0);
  current.result = current.checks.every(c => c.passed) ? 'pass' : 'fail'; receipt.summary = { A1b: current.result }; save(); console.log('SUMMARY', JSON.stringify(receipt.summary));
  for (const c of children) c.kill('SIGTERM'); composioServer.close(); await exec(join(PGBIN, 'pg_ctl'), ['-D', pgData, '-m', 'fast', 'stop']).catch(() => {}); process.exit(0);
}
await until(async () => { if (gateway.exitCode !== null) throw new Error('gateway exited ' + gateway.log.slice(-3000)); return (await realFetch(`http://127.0.0.1:${gwPort}/ready`)).status === 200; }, 'gateway', 45000).catch(e => { console.log(gateway.log.slice(-3000)); throw e; });
const gwDirect = async (path, body, token) => { const r = await realFetch(`http://127.0.0.1:${gwPort}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const portalToken = (companyId, installationId) => { const now = Date.now(); const p = Buffer.from(JSON.stringify({ subject: `installation:${installationId}`, companyId, role: 'billing_owner', iat: now, exp: now + 300000 })).toString('base64url').replace(/=+$/, ''); return `${p}.${createHmac('sha256', portalSecret).update(p).digest('base64url')}`; };
const { signOperatorToken } = await import(join(ROOT, 'managed-gateway/operator-token.ts'));
const setAiAccess = (companyId, customerId, access) => gwDirect('/v1/operator/offices/ai-access', { companyId, customerId, name: `Fictional ${companyId}`, access }, signOperatorToken('qa-operator@example.test', gwOperatorSecret));
const gwProvisioning = async () => {
  const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(join(gwData, 'ledger.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT tenant, installation, state, body FROM installation_provisioning').all().map(r => ({ ...r, body: JSON.parse(r.body) })); } finally { db.close(); }
};
const registryDevices = () => existsSync(registry) ? JSON.parse(readFileSync(registry, 'utf8')).devices : [];

// ---- website (this variant's real route handlers) ----
Object.assign(process.env, { REALBUD_GATEWAY_URL: 'https://rb-gateway.fictional.test', PLATFORM_API_URL: 'https://modelvia.fictional.test', REALBUD_GATEWAY_PORTAL_SECRET: portalSecret, REALBUD_PLATFORM_CUSTOMERS_JSON: '{"office-alpha":"cust-alpha"}' });
const redeemRoute = await import(join(ROOT, 'website/app/api/installations/redeem/route.ts'));
const reportRoute = await import(join(ROOT, 'website/app/api/installations/report/route.ts'));
const { secretHash, createPairingCode } = await import(join(ROOT, 'website/lib/installation-contract.ts'));
async function issueCode(company) { const code = createPairingCode(); await sql(`set role service_role; select realbud_issue_pairing('${company}','owner@${company}.example.test','${secretHash(code)}')`); return code; }

// ---- real desktop link + model access (this variant's source) ----
const { createOfficeLink } = await import(join(ROOT, 'server/office-link.ts'));
const { createWorkerModelAccess, setWorkerModelGrant } = await import(join(ROOT, 'server/worker-model-access.ts'));
const { privateFixtureRoot, privateFixtureDirectory, writePrivateFixtureFile } = await import(join(ROOT, 'server/testing/private-profile-fixture.ts'));
const websiteReplies = [];
function desk(name) {
  const root = privateFixtureRoot(join(run, `desk-${name}-`)); const hermesRoot = join(root, 'hermes'), profile = join(hermesRoot, 'profiles', 'property');
  privateFixtureDirectory(hermesRoot); privateFixtureDirectory(join(hermesRoot, 'profiles')); privateFixtureDirectory(profile); writePrivateFixtureFile(join(profile, 'SOUL.md'), '# Fictional profile\n');
  const d = { name, root, lose: {}, configs: [], replies: [] };
  d.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname.split('/api/installations/')[1];
    const handler = (route === 'redeem' ? redeemRoute : route === 'report' ? reportRoute : {})[init.method ?? 'GET'];
    if (!handler) return Response.json({ error: 'not_found' }, { status: 404 });
    let body = init.body;
    const res = await handler(new Request(url, { method: init.method, headers: init.headers, body }));
    const text = await res.text(); let parsed; try { parsed = JSON.parse(text); } catch {}
    const summary = { route, method: init.method, status: res.status, provisioning: parsed?.provisioning ? (parsed.provisioning.skipped ? { skipped: parsed.provisioning.skipped } : { keyId: parsed.provisioning.model?.keyId, hasKey: !!parsed.provisioning.model?.key, hasCredential: !!parsed.provisioning.connector?.credential }) : undefined, needsProvisioning: body ? JSON.parse(body).needsProvisioning : undefined };
    d.replies.push(summary); websiteReplies.push({ desk: name, ...summary });
    if (d.lose[route] > 0) { d.lose[route]--; d.lostCredential = parsed?.provisioning?.connector?.credential; throw new TypeError('reply lost on the way to the desktop'); }
    return new Response(text, { status: res.status, headers: res.headers });
  };
  d.access = createWorkerModelAccess({ directory: root, key: randomBytes(32), hermesRoot, saveConfig: patch => { d.configs.push(patch); } });
  d.app = createOfficeLink({ directory: root, appVersion: '0.1.19', fetch: d.fetch, origin: 'http://127.0.0.1:9', provisioning: { ...d.access, active: async () => (await d.access.state()).provisioned }, report: async () => ({ appVersion: '0.1.19', workerVersion: null, workerReady: true }) });
  d.env = async () => d.app.modelAccessEnv(d.access.env);
  d.id = () => JSON.parse(readFileSync(join(root, 'office-link/link.json'), 'utf8')).id;
  d.token = () => JSON.parse(readFileSync(join(root, 'office-link/link.json'), 'utf8')).token;
  return d;
}
function scanFor(dir, needles) { const hits = []; const walk = p => { for (const e of readdirSync(p, { withFileTypes: true })) { const f = join(p, e.name); if (e.isDirectory()) walk(f); else if (e.isFile() && statSync(f).size < 8e6) { const b = readFileSync(f); for (const n of needles) if (n && b.includes(Buffer.from(n))) hits.push(f.slice(dir.length + 1)); } } }; if (existsSync(dir)) walk(dir); return hits; }
const pgText = async () => sql(`select coalesce(string_agg(row_to_json(o)::text, E'\\n'),'') from office_installations o`);

const state = {};
// =========================== SCENARIOS ===========================
await scenario('A1', 'Office Alpha, first computer: key auto-issued, project under the office customer, caps, label, vault-only key; Composio office project + ak_ on gateway only', async () => {
  const d = state.a1 = desk('alpha-1'); const code = await issueCode('office-alpha');
  await d.app.link({ code, label: 'Alpha reception Mac' });
  const st = await d.app.status(); check('desktop linked and provisioned', st.state === 'linked' && st.provisioned === true, { state: st.state, provisioned: st.provisioned, skipped: st.provisioningSkipped });
  const env = await d.env(); const key = env.OPENAI_API_KEY; d.key = key;
  check('rbk_ model key delivered to the worker env', /^rbk_/.test(key ?? ''), { prefix: key?.slice(0, 4), baseUrl: env.OPENAI_BASE_URL });
  const id = d.id(); state.a1FirstId = id; const pid = `rb-${id}`;
  const project = (await mvProjects()).find(p => p.id === pid);
  check('Modelvia project rb-<installationId> exists', !!project, { projectId: pid });
  check('project sits under the office customer (cust-alpha) and RealBud client', project?.customerId === 'cust-alpha' && project?.clientId === CLIENT, { customerId: project?.customerId, clientId: project?.clientId });
  check('project caps copied from customer (A$50/month, 2 at once, request = min(A$1, monthly))', project?.monthlyCapNanoAud === '50000000000' && project?.maxConcurrent === 2 && project?.requestCapNanoAud === '1000000000', { monthly: project?.monthlyCapNanoAud, request: project?.requestCapNanoAud, maxConcurrent: project?.maxConcurrent });
  check('project allowedModels', true, { allowedModels: project?.allowedModels, environments: project?.environments, name: project?.name });
  const keys = await mvKeys(pid); const live = keys.filter(k => !k.revokedAt);
  check('exactly one live key, labelled <companyId>:<installationId>', live.length === 1 && live[0].label === `office-alpha:${id}`, { keys: keys.map(k => ({ id: k.id, label: k.label, revoked: !!k.revokedAt, expiresAt: k.expiresAt ?? null })) });
  check('delivered key belongs to that key record', key?.startsWith(`rbk_${live[0]?.id}_`));
  const sqlRow = await row(id);
  check('website row records identifiers only', sqlRow?.provisioned_at && sqlRow.model_key_id === live[0]?.id && /^pr_/.test(sqlRow.composio_project_id ?? ''), { model_key_id: sqlRow?.model_key_id, composio_project_id: sqlRow?.composio_project_id, connector_device_id: sqlRow?.connector_device_id });
  const autoCall = await infer(key, 'auto'); const explicit = await infer(key, model);
  check('worker key can serve with model "auto" (gateway default model policy)', autoCall.status === 200, autoCall);
  check('worker key can serve with explicit catalogue model', explicit.status === 200, explicit);
  state.alphaProject = composio.projects.find(p => p.name === 'realbud-office-alpha');
  check('Composio project realbud-office-alpha created once', composio.created.filter(p => p.name === 'realbud-office-alpha').length === 1 && !!state.alphaProject, { created: composio.created.map(p => p.name) });
  const secretFile = join(secretsDir, 'REALBUD_COMPOSIO_PROJECT_OFFICE_ALPHA');
  check('ak_ stored on the gateway secret store (0600)', existsSync(secretFile) && readFileSync(secretFile, 'utf8').trim() === composio.keys[state.alphaProject?.id] && (statSync(secretFile).mode & 0o077) === 0);
  const dev = registryDevices().find(x => x.id === id);
  check('registry device: office project key reference, hash only', dev?.projectKeyEnv === 'REALBUD_COMPOSIO_PROJECT_OFFICE_ALPHA' && !!dev?.tokenHash && dev.active, { projectKeyEnv: dev?.projectKeyEnv, userId: dev?.userId, memberId: dev?.memberId });
  const cred = d.configs.at(-1)?.composio?.managed?.credential; d.cred = cred;
  check('rbc_ per-computer connector credential delivered to the desktop', /^rbc_/.test(cred ?? ''));
  const ak = composio.keys[state.alphaProject?.id];
  const deskHits = scanFor(d.root, [key, cred, ak]); const dataHits = scanFor(data, [key, cred, ak]);
  check('no plaintext rbk_/rbc_/ak_ in desktop files (vault is encrypted)', deskHits.length === 0 && dataHits.length === 0, { deskHits, dataHits });
  const pg = await pgText(); check('website database holds no rbk_/rbc_/ak_', !/rbk_|rbc_|ak_/.test(pg));
  check('desktop never received ak_ in any reply or config', !JSON.stringify(d.configs).includes('ak_'));
  const gwLedger = readFileSync(join(gwData, 'ledger.sqlite'));
  check('gateway ledger holds no rbk_/rbc_/ak_ material', !gwLedger.includes(Buffer.from(key)) && !gwLedger.includes(Buffer.from(cred)) && !gwLedger.includes(Buffer.from(ak)));
});

await scenario('A2', 'Office Alpha, second computer: separate project/key, same Composio office project and ak_, distinct rbc_', async () => {
  const d = state.a2 = desk('alpha-2'); await d.app.link({ code: await issueCode('office-alpha'), label: 'Alpha manager PC' });
  const st = await d.app.status(); check('linked and provisioned', st.provisioned === true);
  const id1 = state.a1.id(), id2 = d.id(); const env = await d.env(); d.key = env.OPENAI_API_KEY; d.cred = d.configs.at(-1)?.composio?.managed?.credential;
  const p2 = (await mvProjects()).find(p => p.id === `rb-${id2}`);
  check('second project rb-<id2> under the same customer', p2?.customerId === 'cust-alpha' && id1 !== id2, { projectId: p2?.id });
  check('different model key', d.key && d.key !== state.a1.key && (await row(id2)).model_key_id !== (await row(id1)).model_key_id);
  check('Composio: no second project; same pr_ recorded', composio.created.filter(p => p.name === 'realbud-office-alpha').length === 1 && (await row(id2)).composio_project_id === (await row(id1)).composio_project_id);
  const devs = registryDevices(); const d1 = devs.find(x => x.id === id1), d2 = devs.find(x => x.id === id2);
  check('both devices use the same office ak_ reference; different credential hashes', d1.projectKeyEnv === d2.projectKeyEnv && d1.tokenHash !== d2.tokenHash && d.cred !== state.a1.cred, { projectKeyEnv: d2.projectKeyEnv, userIds: [d1.userId, d2.userId] });
  check('second key serves', (await infer(d.key, model)).status === 200);
});

await scenario('A3', 'Office Bravo: different customer (derived realbud-<companyId>), own Composio project + ak_, no cross-over', async () => {
  const d = state.b1 = desk('bravo-1'); await d.app.link({ code: await issueCode('office-bravo'), label: 'Bravo Mac' });
  check('linked and provisioned', (await d.app.status()).provisioned === true);
  const id = d.id(); const env = await d.env(); d.key = env.OPENAI_API_KEY;
  const p = (await mvProjects()).find(x => x.id === `rb-${id}`);
  check('project under realbud-office-bravo with Bravo caps (A$20, 1 at once)', p?.customerId === 'realbud-office-bravo' && p.monthlyCapNanoAud === '20000000000' && p.maxConcurrent === 1, { customerId: p?.customerId });
  const alphaProjects = (await mvProjects()).filter(x => x.customerId === 'cust-alpha').map(x => x.id);
  check('no Bravo project under Alpha customer', !alphaProjects.includes(`rb-${id}`));
  const bravoProject = composio.projects.find(x => x.name === 'realbud-office-bravo');
  check('own Composio project realbud-office-bravo with a different ak_', !!bravoProject && bravoProject.id !== state.alphaProject.id && composio.keys[bravoProject.id] !== composio.keys[state.alphaProject.id]);
  const dev = registryDevices().find(x => x.id === id);
  check('device references Bravo key only', dev?.projectKeyEnv === 'REALBUD_COMPOSIO_PROJECT_OFFICE_BRAVO' && dev.companyId === 'office-bravo');
  // Cross-office: an Alpha installation token cannot provision into Bravo's customer.
  const cross = await gwDirect('/v1/portal/installations/provision', { companyId: 'office-alpha', installationId: '99999999-9999-4999-8999-999999999999', customerId: 'realbud-office-bravo', profile: 'property' }, portalToken('office-alpha', '99999999-9999-4999-8999-999999999999'));
  const crossRecord = (await gwProvisioning()).some(x => x.installation === '99999999-9999-4999-8999-999999999999');
  const crossProject = (await mvProjects()).some(x => x.id === 'rb-99999999-9999-4999-8999-999999999999');
  check('gateway refuses Alpha principal naming Bravo customer: 403 modelvia_customer_not_bound, nothing created', cross.status === 403 && cross.body?.error === 'modelvia_customer_not_bound' && !crossRecord && !crossProject, { status: cross.status, error: cross.body?.error, gatewayRecord: crossRecord, modelviaProject: crossProject });
  state.crossProbe = cross;
  const wrongCompany = await gwDirect('/v1/portal/installations/provision', { companyId: 'office-bravo', installationId: id, customerId: 'realbud-office-bravo', profile: 'property' }, portalToken('office-alpha', id));
  check('gateway refuses a body company that differs from the signed principal', wrongCompany.status === 403, { status: wrongCompany.status, error: wrongCompany.body?.error });
});

await scenario('A4', 'Lost redeem reply to the desktop after the website recorded provisioning', async () => {
  const d = state.lost = desk('alpha-lost'); d.lose.redeem = 1; const code = await issueCode('office-alpha');
  let threw = false; try { await d.app.link({ code, label: 'Alpha lost-reply Mac' }); } catch { threw = true; }
  check('first redeem reply lost (desktop sees an error)', threw);
  const id = d.id(); const firstKeyId = (await row(id))?.model_key_id;
  check('website recorded provisioning for the first reply', !!(await row(id))?.provisioned_at, { firstKeyId });
  await d.app.link({ code, label: 'Alpha lost-reply Mac' }); await d.app.report(); await d.app.report();
  const st = await d.app.status(); const env = await d.env();
  const keys = await mvKeys(`rb-${id}`);
  current.observed = { provisioned: st.provisioned, skipped: st.provisioningSkipped, hasKey: !!env.OPENAI_API_KEY, keys: keys.map(k => ({ id: k.id, revoked: !!k.revokedAt })), replies: d.replies };
  if (VARIANT === 'main') {
    check('MAIN: computer stays stranded (linked, no grant, no stated reason)', st.state === 'linked' && st.provisioned === false && !env.OPENAI_API_KEY, current.observed);
    check('MAIN: gateway still holds one live key nobody has', keys.filter(k => !k.revokedAt).length === 1);
  } else {
    check('FIX: retry redeem redelivers; computer provisioned', st.provisioned === true && /^rbk_/.test(env.OPENAI_API_KEY ?? ''), { provisioned: st.provisioned });
    check('FIX: lost key revoked, exactly one live key (rotated, same label)', keys.filter(k => !k.revokedAt).length === 1 && keys.find(k => k.id === firstKeyId)?.revokedAt, current.observed.keys);
    check('FIX: new key serves', (await infer(env.OPENAI_API_KEY, model)).status === 200);
    check('FIX: later check-ins do not rotate again', (await mvKeys(`rb-${id}`)).length === keys.length);
    const sha = v => createHash('sha256').update(v).digest('hex'); const dev = registryDevices().find(x => x.id === id); const newCred = d.configs.at(-1)?.composio?.managed?.credential;
    check('FIX: connector device now holds the new rbc_ hash; the lost rbc_ no longer matches', !!d.lostCredential && dev?.tokenHash === sha(newCred) && dev.tokenHash !== sha(d.lostCredential) && dev.active);
  }
});

await scenario('A5', 'Lost report reply to the desktop (grant carried by a check-in after a gateway outage)', async () => {
  const d = desk('bravo-lostreport'); faults.gateway = 'down';
  await d.app.link({ code: await issueCode('office-bravo'), label: 'Bravo lost-report PC' });
  const st0 = await d.app.status(); const id = d.id();
  check('gateway down at link: linked, skipped provisioning_gateway_not_ready, claim not spent', st0.state === 'linked' && st0.provisioned === false && (await row(id)).provisioning_attempted_at === null, { skipped: st0.provisioningSkipped });
  faults.gateway = 'normal'; d.lose.report = 1;
  try { await d.app.report(); } catch {}
  check('website recorded provisioning on the lost check-in', !!(await row(id)).provisioned_at);
  await d.app.report(); await d.app.report();
  const st = await d.app.status(); const env = await d.env();
  current.observed = { provisioned: st.provisioned, hasKey: !!env.OPENAI_API_KEY, replies: d.replies.map(r => ({ route: r.route, provisioning: r.provisioning, needsProvisioning: r.needsProvisioning })) };
  if (VARIANT === 'main') check('MAIN: stranded after the lost check-in reply', st.provisioned === false && !env.OPENAI_API_KEY, current.observed);
  else check('FIX: next check-in asks (needsProvisioning) and receives redelivered keys', st.provisioned === true && /^rbk_/.test(env.OPENAI_API_KEY ?? ''), current.observed);
  state.gwDownRecovered = d;
});

await scenario('A6', 'Website<-gateway reply lost (gateway minted, website never saw it)', async () => {
  const d = desk('alpha-gwlost'); faults.gateway = 'lose-provision-reply';
  await d.app.link({ code: await issueCode('office-alpha'), label: 'Alpha gw-lost Mac' });
  const id = d.id(); await d.app.report(); await d.app.report();
  const st = await d.app.status(); const r = await row(id); const gw = (await gwProvisioning()).find(x => x.installation === id);
  const keys = await mvKeys(`rb-${id}`);
  current.observed = { deskProvisioned: st.provisioned, skipped: st.provisioningSkipped, attemptedAt: !!r.provisioning_attempted_at, provisionedAt: !!r.provisioned_at, gatewayState: gw?.state, liveKeys: keys.filter(k => !k.revokedAt).length, lostReplyStatus: faults.lostReply?.status };
  check('gateway reached ready and minted a live key', gw?.state === 'ready' && keys.filter(k => !k.revokedAt).length === 1, current.observed);
  const env = await d.env(); current.observed.keys = keys.map(k => ({ id: k.id, revoked: !!k.revokedAt }));
  const projects = (await mvProjects()).filter(p => p.id === `rb-${id}`).length;
  check('next check-in reconciles: desktop provisioned, website recorded ids', st.provisioned === true && !!r.provisioned_at && r.model_key_id === keys.find(k => !k.revokedAt)?.id, current.observed);
  check('one mint (one project, one original key), lost key revoked, one live key', projects === 1 && keys.length === 2 && keys.filter(k => !k.revokedAt).length === 1, current.observed.keys);
  check('reconciled key serves', (await infer(env.OPENAI_API_KEY, model)).status === 200);
});

await scenario('A7', 'Slow gateway (>10 s) on the provision call', async () => {
  const d = desk('alpha-slow'); faults.gateway = 'slow'; const t = performance.now();
  await d.app.link({ code: await issueCode('office-alpha'), label: 'Alpha slow Mac' });
  const linkMs = Math.round(performance.now() - t); const id = d.id();
  const upstream = await Promise.all(faults.slow.splice(0)); await d.app.report();
  const st = await d.app.status(); const r = await row(id); const gw = (await gwProvisioning()).find(x => x.installation === id);
  current.observed = { linkMs, gatewayStatus: upstream[0]?.status, deskProvisioned: st.provisioned, skipped: st.provisioningSkipped, attemptedAt: !!r.provisioning_attempted_at, provisionedAt: !!r.provisioned_at, gatewayState: gw?.state };
  check('12 s gateway: within the 35 s provision bound, link completes provisioned in one pass', linkMs >= 12000 && linkMs < 20000 && st.provisioned === true && !!r.provisioned_at && (await mvKeys(`rb-${id}`)).length === 1, current.observed);
});

await scenario('A7b', 'Very slow gateway (40 s) on the provision call', async () => {
  const d = desk('alpha-veryslow'); faults.gateway = 'slow'; faults.slowMs = 40_000; const t = performance.now();
  await d.app.link({ code: await issueCode('office-alpha'), label: 'Alpha very-slow Mac' }); faults.slowMs = undefined;
  const linkMs = Math.round(performance.now() - t); const id = d.id();
  const st0 = await d.app.status(); const r0 = await row(id);
  const upstream = await Promise.all(faults.slow.splice(0)); await d.app.report();
  const st = await d.app.status(); const r = await row(id); const keys = await mvKeys(`rb-${id}`); const env = await d.env();
  current.observed = { linkMs, afterLink: { provisioned: st0.provisioned, skipped: st0.provisioningSkipped, attempted: !!r0.provisioning_attempted_at }, gatewayStatus: upstream[0]?.status, afterCheckIn: { provisioned: st.provisioned, recorded: !!r.provisioned_at }, keys: keys.map(k => ({ id: k.id, revoked: !!k.revokedAt })) };
  check('website gives up near its 35 s bound; link completes without a grant', linkMs >= 35000 && linkMs < 45000 && st0.state === 'linked' && st0.provisioned === false, current.observed);
  check('next check-in reconciles: provisioned, one live key, first key revoked, key serves', st.provisioned === true && !!r.provisioned_at && keys.length === 2 && keys.filter(k => !k.revokedAt).length === 1 && (await infer(env.OPENAI_API_KEY, model)).status === 200, current.observed);
});

await scenario('A8', 'Concurrent retries', async () => {
  // (a) Two check-ins race for one unprovisioned installation.
  const d = desk('bravo-race'); faults.gateway = 'down'; await d.app.link({ code: await issueCode('office-bravo'), label: 'Bravo race PC' }); faults.gateway = 'normal';
  const id = d.id(), token = d.token();
  const post = () => reportRoute.POST(new Request('http://127.0.0.1:9/api/installations/report', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ appVersion: '0.1.19', workerVersion: null, workerReady: true }) })).then(r => r.json());
  const [x, y] = await Promise.all([post(), post()]);
  const got = [x, y].map(v => v.provisioning ? (v.provisioning.skipped ?? (v.provisioning.model?.key ? 'keys' : 'descriptor')) : 'none');
  const keys = await mvKeys(`rb-${id}`);
  check('two concurrent check-ins: one mint, one key', got.filter(v => v === 'keys').length === 1 && keys.length === 1, { outcomes: got, keys: keys.length });
  // (b) Two provision calls straight at the gateway for one fresh installation.
  const fresh = '77777777-7777-4777-8777-777777777777';
  const body = { companyId: 'office-bravo', installationId: fresh, customerId: 'realbud-office-bravo', profile: 'property' };
  const both = await Promise.all([gwDirect('/v1/portal/installations/provision', body, portalToken('office-bravo', fresh)), gwDirect('/v1/portal/installations/provision', body, portalToken('office-bravo', fresh))]);
  const k2 = await mvKeys(`rb-${fresh}`);
  check('two concurrent gateway provisions: one 200 with keys, the other refused 409, one key', both.filter(b => b.status === 200 && b.body?.provisioning?.model?.key).length === 1 && k2.length === 1, both.map(b => ({ status: b.status, error: b.body?.error, hasKey: !!b.body?.provisioning?.model?.key })));
  const repeat = await gwDirect('/v1/portal/installations/provision', body, portalToken('office-bravo', fresh));
  check('a plain repeat after ready returns identifiers only, no rotation', repeat.status === 200 && !repeat.body?.provisioning?.model?.key && (await mvKeys(`rb-${fresh}`)).length === 1);
  if (VARIANT === 'fix') {
    const rb = { ...body, redeliver: true };
    const re = await Promise.all([gwDirect('/v1/portal/installations/provision', rb, portalToken('office-bravo', fresh)), gwDirect('/v1/portal/installations/provision', rb, portalToken('office-bravo', fresh))]);
    const k3 = await mvKeys(`rb-${fresh}`);
    check('FIX: two concurrent redeliveries: exactly one rotates, one live key', re.filter(b => b.status === 200 && b.body?.provisioning?.model?.key).length === 1 && k3.filter(k => !k.revokedAt).length === 1, re.map(b => ({ status: b.status, error: b.body?.error })));
  }
});

await scenario('A9', 'Revoke (desktop disconnect) stops the key and the connector device', async () => {
  const d = state.a1; const id = d.id();
  check('key serves before revoke', (await infer(d.key, model)).status === 200);
  await d.app.disconnect();
  const keys = await mvKeys(`rb-${id}`); const dev = registryDevices().find(x => x.id === id); const r = await row(id);
  const after = await infer(d.key, model);
  check('Modelvia key revoked; inference refused', keys.every(k => k.revokedAt) && after.status >= 400, { status: after.status, code: after.code });
  check('connector device deactivated', dev?.active === false);
  check('website row revoked and cleanup cleared', !!r.revoked_at && r.revocation_pending_at === null);
  check('project retained for billing history; Composio office project kept (other computers use it)', (await mvProjects()).some(p => p.id === `rb-${id}`) && composio.projects.some(p => p.id === state.alphaProject.id));
  check('Alpha second computer unaffected', (await infer(state.a2.key, model)).status === 200);
});

await scenario('A10', 'Reinstall on the same machine (same desktop data dir, new code)', async () => {
  const d = state.a1;
  await d.app.link({ code: await issueCode('office-alpha'), label: 'Alpha reception Mac (reinstalled)' });
  const id = d.id(); const env = await d.env();
  check('new installation id, new project, new key; old revoked', id !== state.a1FirstId && (await d.app.status()).provisioned === true && env.OPENAI_API_KEY !== d.key && (await infer(env.OPENAI_API_KEY, model)).status === 200, { newProject: `rb-${id}` });
  check('still one Composio project for the office', composio.created.filter(p => p.name === 'realbud-office-alpha').length === 1);
});

await scenario('A11', 'Office with no Modelvia customer: modelvia_customer_not_ready, then operator creates access; cap exceeded; cap raise; disable', async () => {
  const d = desk('charlie-1'); await d.app.link({ code: await issueCode('office-charlie'), label: 'Charlie Mac' });
  const st0 = await d.app.status(); const id = d.id();
  check('skipped modelvia_customer_not_ready; claim released', st0.provisioned === false && st0.provisioningSkipped === 'modelvia_customer_not_ready' && (await row(id)).provisioning_attempted_at === null, { skipped: st0.provisioningSkipped });
  const created = await setAiAccess('office-charlie', 'realbud-office-charlie', { mode: 'custom', monthlyCapNanoAud: '5000' });
  const cc = (await mvCustomers()).find(x => x.id === 'realbud-office-charlie');
  check('operator office AI access creates the customer (tiny custom cap A$0.000005) bound billingCompanyId=office-charlie', created.status === 200 && cc?.billingCompanyId === (BILLING === 'customer' ? 'office-charlie' : undefined), { status: created.status, body: created.body, billingCompanyId: cc?.billingCompanyId ?? null, payer: cc?.payer ?? null });
  await d.app.report(); const st = await d.app.status(); const env = await d.env();
  check('next check-in provisions', st.provisioned === true && /^rbk_/.test(env.OPENAI_API_KEY ?? ''), { skipped: st.provisioningSkipped });
  const p = (await mvProjects()).find(x => x.id === `rb-${id}`); const c = (await mvCustomers()).find(x => x.id === 'realbud-office-charlie');
  check('project caps follow tiny customer cap (request cap clamped to monthly)', p?.monthlyCapNanoAud === '5000' && p?.requestCapNanoAud === '5000', { project: p && { monthly: p.monthlyCapNanoAud, request: p.requestCapNanoAud, maxConcurrent: p.maxConcurrent }, customer: c && { billingCompanyId: c.billingCompanyId ?? null, payer: c.payer ?? null, allowedModels: c.allowedModels } });
  const capped = await infer(env.OPENAI_API_KEY, model);
  check('cap exceeded: request refused before any upstream call (402)', capped.status === 402, capped);
  const raised = await setAiAccess('office-charlie', 'realbud-office-charlie', { mode: 'default' });
  const p2 = (await mvProjects()).find(x => x.id === `rb-${id}`);
  check('operator raises to default A$200: pushed to the installation project', raised.status === 200 && p2?.monthlyCapNanoAud === '200000000000', { projects: raised.body?.projects, monthly: p2?.monthlyCapNanoAud });
  const served = await infer(env.OPENAI_API_KEY, model);
  check('serves after cap raise', served.status === 200, served);
  const disabled = await setAiAccess('office-charlie', 'realbud-office-charlie', { mode: 'disabled' });
  const refused = await infer(env.OPENAI_API_KEY, model);
  check('disabled office: serving refused (spend stops)', disabled.status === 200 && refused.status >= 400, { status: refused.status, code: refused.code });
});

await scenario('A12', 'No platform customer binding (no_platform_customer), then binding restored', async () => {
  const saved = process.env.REALBUD_PLATFORM_CUSTOMERS_JSON; delete process.env.REALBUD_PLATFORM_CUSTOMERS_JSON;
  const d = desk('delta-1');
  try { await d.app.link({ code: await issueCode('office-delta'), label: 'Delta Mac' }); } finally { process.env.REALBUD_PLATFORM_CUSTOMERS_JSON = saved; }
  const st = await d.app.status(); const id = d.id();
  check('skipped no_platform_customer; no gateway call; claim not spent', st.provisioned === false && st.provisioningSkipped === 'no_platform_customer' && (await row(id)).provisioning_attempted_at === null && !(await gwProvisioning()).some(x => x.installation === id), { skipped: st.provisioningSkipped });
  await d.app.report(); const st2 = await d.app.status();
  check('after binding restored, next check-in reaches the gateway (Delta has no Modelvia customer yet -> modelvia_customer_not_ready)', st2.provisioningSkipped === 'modelvia_customer_not_ready', { skipped: st2.provisioningSkipped });
});

if (process.env.QA_DIAG) await scenario('D0', 'Diagnostics: raw Modelvia answers behind two failures', async () => {
  const asOfficeAccess = await mvCall('/v1/operator/customers', { id: 'realbud-office-diag', name: 'Fictional diag', active: true, monthlyCapNanoAud: '5000', maxConcurrent: 2, allowedModels: MODELS ? MODELS.split(',') : ['auto'], version: 0, clientId: CLIENT });
  check('customer create exactly as setCustomerAccess sends it (no billingCompanyId)', asOfficeAccess.status === 200, { status: asOfficeAccess.status, body: asOfficeAccess.body });
  const withBilling = await mvCall('/v1/operator/customers', { id: 'realbud-office-diag2', name: 'Fictional diag 2', active: true, monthlyCapNanoAud: '5000', maxConcurrent: 2, allowedModels: MODELS ? MODELS.split(',') : ['auto'], version: 0, clientId: CLIENT, billingCompanyId: 'office-charlie' });
  check('same with billingCompanyId', withBilling.status === 200, { status: withBilling.status, body: withBilling.body });
  const ck = await mvCall('/v1/operator/client-keys', { clientId: CLIENT, label: 'qa-reader' });
  const models = await realFetch(mvBase + '/v1/models', { headers: { authorization: `Bearer ${state.a2?.key}` } }).then(r => r.json()).catch(e => String(e));
  check('/v1/models for an installation key', true, { models: JSON.stringify(models).slice(0, 400) });
});

// Composio summary for C.
receipt.composio = { projectsCreated: composio.created.map(p => ({ name: p.name, shouldCreateKey: p.shouldCreateKey })), deleted: composio.deleted.length, akFiles: existsSync(secretsDir) ? readdirSync(secretsDir) : [],
  registry: registryDevices().map(x => ({ id: x.id.slice(0, 8), companyId: x.companyId, projectKeyEnv: x.projectKeyEnv, active: x.active, userId: x.userId.slice(0, 21) })) };
receipt.akLeak = { websiteReplies: websiteReplies.length, websiteDb: /ak_/.test(await pgText()), deskConfigs: [state.a1, state.a2, state.b1].filter(Boolean).some(d => JSON.stringify(d.configs).includes('ak_')) };
receipt.rpcErrors = rpcLog.filter(x => x.error);
receipt.summary = Object.fromEntries(Object.values(receipt.scenarios).map(s => [s.id, s.result]));
save(); console.log('SUMMARY', JSON.stringify(receipt.summary));
writeFileSync(join(OUT, `gateway-${VARIANT}.log`), gateway.log); writeFileSync(join(OUT, `modelvia-${VARIANT}.log`), mv.log.slice(-15000));
for (const c of children) c.kill('SIGTERM'); composioServer.close();
await exec(join(PGBIN, 'pg_ctl'), ['-D', pgData, '-m', 'fast', 'stop']).catch(() => {});
process.exit(0);
