// Loopback HTTP billing checks: real local Modelvia (origin/main archive, sqlite,
// in-process fictional DeepSeek-shaped provider) + real local RealBud managed
// gateway (provisioning, office AI access) + real website projection modules.
// Fictional companies, keys and amounts only. No non-loopback traffic.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SCR = '/private/tmp/claude-501/-Users-yoda-projects-RealBud/1e5b5f5f-34c1-402c-9819-6956729fe386/scratchpad/billing';
const OUT = process.env.OUT_DIR; assert(OUT);
const ROOT = '/Users/yoda/projects/RealBud';
const MVDIR = join(SCR, 'mv/managed-gateway');
const run = mkdtempSync(join(SCR, 'run-'));
const model = 'deepseek-chat', rateVersion = 'fictional-billing-rate-1', client = 'rb-platform';
const mvSecret = 'fictional-modelvia-billing-operator-secret-20260925';
const portalSecret = 'fictional-realbud-billing-portal-secret-20260925';
const rbOperatorSecret = 'fictional-realbud-billing-operator-secret-2026092500';
const results = [], processes = [], servers = [];
const redact = v => String(v).replace(/\brbk_[A-Za-z0-9_-]+/g, m => m.slice(0, 10) + '…').replace(/\brbc_[A-Za-z0-9_-]+/g, 'rbc_…').replace(/\bak_[A-Za-z0-9_-]+/g, 'ak_…');
async function check(id, scenario, expected, fn) {
  const row = { id, scenario, expected, actual: null, pass: false, evidence: 'billing/http-checks.json#' + id };
  try { row.actual = await fn(); row.pass = true; } catch (e) { row.actual = 'FAIL: ' + redact(e?.message ?? e).split('\n').slice(0, 5).join(' | '); }
  results.push(row); console.log(`${row.pass ? 'PASS' : 'FAIL'} ${id} -> ${redact(typeof row.actual === 'string' ? row.actual : JSON.stringify(row.actual)).slice(0, 700)}`);
}
const write = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v)); };
async function port() { const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const n = s.address().port; await new Promise(r => s.close(r)); return n; }
async function serve(handler) { const s = createServer((q, r) => Promise.resolve(handler(q, r)).catch(() => { if (!r.headersSent) r.writeHead(500); r.end('{}'); })); servers.push(s); s.listen(0, '127.0.0.1'); await once(s, 'listening'); return `http://127.0.0.1:${s.address().port}`; }
function launch(name, args, env, cwd) { const c = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); c.qaName = name; c.qaLog = ''; c.qaClosed = new Promise(r => c.once('close', r)); for (const s of [c.stdout, c.stderr]) s.on('data', b => { c.qaLog = (c.qaLog + redact(b.toString())).slice(-30000); }); processes.push(c); return c; }
async function stop(c) { if (!c || c.exitCode !== null || c.signalCode) return; c.kill('SIGTERM'); const t = setTimeout(() => c.kill('SIGKILL'), 6000); try { await c.qaClosed; } finally { clearTimeout(t); } }
async function until(fn, label, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error('timeout ' + label); }
async function call(base, path, { method = 'GET', body, token, headers = {}, timeout = 60000 } = {}) {
  assert.equal(new URL(base).hostname, '127.0.0.1');
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout), redirect: 'error' });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, body: json, requestId: res.headers.get('x-request-id') };
}
const hmacBearer = (secret, payload) => { const now = Date.now(), t = Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + 120000 })).toString('base64url'); return t + '.' + createHmac('sha256', secret).update(t).digest('base64url'); };
const mvOp = () => hmacBearer(mvSecret, { aud: 'managed-ai-operator', subject: 'fictional-billing-operator' });
const portal = company => hmacBearer(portalSecret, { subject: 'fictional-owner-' + company, companyId: company, role: 'billing_owner' });
let mvBase, gwBase, clientKey;
async function mvPost(path, body) { const r = await call(mvBase, path, { method: 'POST', body, token: mvOp() }); assert.equal(r.status, 200, `${path} ${r.status} ${JSON.stringify(r.body)}`); return r.body; }
const upstreamCount = () => existsSync(join(run, 'upstream.jsonl')) ? readFileSync(join(run, 'upstream.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length : 0;
const chat = (key, idem, content = 'Fictional billing ping') => call(mvBase, '/v1/chat/completions', { method: 'POST', token: key, headers: idem ? { 'idempotency-key': idem } : {}, body: { model, messages: [{ role: 'user', content }], max_tokens: 64, stream: false } });
const project = async id => (await call(mvBase, '/v1/operator/projects', { token: mvOp() })).body.accounts.find(p => p.id === id);
const request = async (key, id) => (await call(mvBase, `/v1/requests/${id}`, { token: key }));
const period = new Date(Date.now() + 36_000_000).toISOString().slice(0, 7);
const keys = {};
const receipt = { at: new Date().toISOString(), tier: 'Local source over loopback HTTP: real Modelvia (git archive origin/main, sqlite) with in-process fictional provider; real RealBud managed gateway; website modules. NOT hosted Modelvia, NOT real Square/Stripe, NOT real invoices.', source: {}, results };
try {
  // ---------- guards + fictional provider ----------
  write(join(run, 'guard.mjs'), `import net from 'node:net';const L=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){if(a[1]==='0.0.0.0')a[1]='127.0.0.1';return L.apply(this,a);};const F=globalThis.fetch;globalThis.fetch=async(i,n)=>{const u=new URL(i instanceof Request?i.url:String(i));if(!['127.0.0.1','localhost','[::1]','api.deepseek.com'].includes(u.hostname))throw new Error('QA denied nonloopback fetch '+u.hostname);return F(i,n);};\n`);
  write(join(run, 'provider.mjs'), `import {appendFileSync,readFileSync} from 'node:fs';const real=globalThis.fetch;globalThis.fetch=async(input,init)=>{const u=new URL(input instanceof Request?input.url:String(input));if(u.hostname!=='api.deepseek.com')return real(input,init);appendFileSync(${JSON.stringify(join(run, 'upstream.jsonl'))},JSON.stringify({at:Date.now()})+'\\n');const mode=readFileSync(${JSON.stringify(join(run, 'mode'))},'utf8');if(mode==='slow')await new Promise((res,rej)=>{const t=setTimeout(res,4000);init.signal?.addEventListener('abort',()=>{clearTimeout(t);rej(init.signal.reason);},{once:true});});const id='fictional-'+Math.random().toString(16).slice(2);const frames=[{id,model:${JSON.stringify(model)},choices:[{index:0,delta:{role:'assistant',content:'OK'},finish_reason:null}]},{id,model:${JSON.stringify(model)},choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1234,completion_tokens:50,total_tokens:1284,prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:1234}}];return new Response(frames.map(v=>'data: '+JSON.stringify(v)+'\\n\\n').join('')+'data: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}});};\n`);
  write(join(run, 'mode'), 'ok');
  // ---------- Modelvia ----------
  const mvPort = await port(); mvBase = `http://127.0.0.1:${mvPort}`;
  write(join(run, 'catalog.json'), [{ model, configuration: 'fictional-billing-fixed', provider: 'deepseek', profile: 'fast', capabilities: ['text', 'tools'], thinking: 'disabled', maximumOutputTokens: 256, contextLength: 65536, costNanoAud: '1000' }]);
  const mv = launch('modelvia', ['--experimental-strip-types', '--import', join(run, 'guard.mjs'), '--import', join(run, 'provider.mjs'), 'server.ts'], {
    PATH: dirname(process.execPath) + ':/usr/bin:/bin', HOME: run, PORT: String(mvPort), PLATFORM_BIND_HOST: '127.0.0.1', REALBUD_GATEWAY_DATA: join(run, 'mv-data'), REALBUD_FINGERPRINT_KEY: 'b2'.repeat(32), REALBUD_GATEWAY_PORTAL_SECRET: 'fictional-billing-modelvia-portal-secret', REALBUD_GATEWAY_OPERATOR_SECRET: mvSecret, REALBUD_PAYMENT_MODE: 'local', REALBUD_ALLOWED_ORIGINS: mvBase, MODELVIA_LEDGER_BACKEND: 'sqlite', REALBUD_ENABLE_PROVIDER: '1', DEEPSEEK_API_KEY: 'fictional-upstream-key', DEEPSEEK_MODEL: model, DEEPSEEK_MAX_OUTPUT: '256', DEEPSEEK_CONTEXT: '65536', DEEPSEEK_TERMS_REF: 'fictional-billing-qa', DEEPSEEK_APPROVED_UNTIL: String(Date.now() + 3600000), PLATFORM_ROUTE_CATALOG_FILE: join(run, 'catalog.json'), PLATFORM_ROUTING_MODE: 'fixed', PLATFORM_SHUTDOWN_DRAIN_MS: '1000',
  }, MVDIR);
  await until(async () => { assert.equal(mv.exitCode, null, mv.qaLog.slice(-1500)); try { return (await call(mvBase, '/health', { timeout: 500 })).status === 200; } catch { return false; } }, 'modelvia');
  const t = Date.now(), CAP = '100000000000';
  for (const office of ['office-a', 'office-b']) await mvPost('/v1/operator/billing-accounts', { companyId: office, licenseId: 'lic-' + office, active: true, serviceExpiresAt: t + 3600000, customerName: 'Fictional ' + office, customerAddress: '1 Fictional Street', goLiveAt: t - 60000, goLiveEvidence: 'fictional', includedUntil: t - 60000, plan: 'platform', monthlyCapNanoAud: CAP, requestCapNanoAud: CAP, maxConcurrent: 8, creditLimitNanoAud: CAP });
  await mvPost('/v1/operator/rates', { version: rateVersion, currency: 'AUD', gstInclusive: true, gstBasisPoints: 1000, publishedAt: t - 1000, effectiveAt: t - 1000, models: [{ model, label: 'Fictional billing model', units: { input_tokens: { nanoAud: '1500000', perUnits: 1000 }, cache_read_tokens: { nanoAud: '1500000', perUnits: 1000 }, output_tokens: { nanoAud: '7000001', perUnits: 1000 } } }] });
  const card = (await call(mvBase, '/v1/operator/rates', { token: mvOp() })).body.rates.find(x => x.card.version === rateVersion);
  for (const office of ['office-a', 'office-b']) await mvPost('/v1/operator/rates/accept', { companyId: office, version: rateVersion, digest: card.digest, acceptanceReference: 'fictional-acceptance-' + office });
  const common = { active: true, monthlyCapNanoAud: CAP, maxConcurrent: 4, allowedModels: [model], version: 0 };
  await mvPost('/v1/operator/clients', { ...common, id: client, name: 'Fictional RealBud platform', billingMode: 'customer' });
  for (const office of ['office-a', 'office-b']) await mvPost('/v1/operator/customers', { ...common, id: 'realbud-' + office, name: 'Fictional ' + office, clientId: client, billingCompanyId: office });
  clientKey = (await mvPost('/v1/operator/client-keys', { clientId: client, label: 'fictional-website-reader' })).key;
  // ---------- RealBud gateway ----------
  const projects = [];
  const composio = await serve(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c); const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const send = b => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.method === 'GET' && req.url.startsWith('/org/owner/project/list')) return send({ items: projects });
    if (req.method === 'POST' && req.url.startsWith('/org/owner/project/new')) { const p = { id: 'pr_fictional_' + projects.length, name: body.name }; projects.push(p); return send({ ...p, api_key: 'ak_fictional_project_key_' + projects.length }); }
    res.writeHead(404).end();
  });
  const gwData = join(run, 'rb-gateway'); mkdirSync(gwData);
  const { LedgerDatabase } = await import(pathToFileURL(join(ROOT, 'managed-gateway/database.ts')).href);
  const { UsageLedger } = await import(pathToFileURL(join(ROOT, 'managed-gateway/ledger.ts')).href);
  const { twoMonthsAfter } = await import(pathToFileURL(join(ROOT, 'managed-gateway/money.ts')).href);
  const { signOperatorToken } = await import(pathToFileURL(join(ROOT, 'managed-gateway/operator-token.ts')).href);
  { const db = new LedgerDatabase(join(gwData, 'ledger.sqlite')); try { const live = Date.now() - 60000; for (const office of ['office-a', 'office-b', 'office-c']) new UsageLedger(db, Date.now).provisionTenant({ companyId: office, licenseId: 'lic-' + office, active: true, serviceExpiresAt: Date.now() + 3600000, customerName: 'Fictional ' + office, customerAddress: '1 Fictional Street', goLiveAt: live, goLiveEvidence: 'fictional', includedUntil: twoMonthsAfter(live), monthlyCapNanoAud: CAP, requestCapNanoAud: '1000000000', maxConcurrent: 4 }); } finally { db.close(); } }
  const gwPort = await port(); gwBase = `http://127.0.0.1:${gwPort}`;
  const gw = launch('realbud-gateway', ['--experimental-strip-types', '--import', join(run, 'guard.mjs'), 'server.ts'], {
    HOME: run, PATH: dirname(process.execPath) + ':/usr/bin:/bin', PORT: String(gwPort), REALBUD_GATEWAY_DATA: gwData, REALBUD_GATEWAY_PORTAL_SECRET: portalSecret, REALBUD_GATEWAY_OPERATOR_SECRET: rbOperatorSecret, REALBUD_PAYMENT_MODE: 'local', REALBUD_ALLOWED_ORIGINS: gwBase, REALBUD_ENABLE_PROVIDER: '1', REALBUD_GATEWAY_SECRETS_DIR: join(run, 'gw-secrets'), REALBUD_GATEWAY_CONNECTOR_REGISTRY: join(run, 'registry/devices.json'), REALBUD_GATEWAY_PUBLIC_ORIGIN: 'https://fictional-billing-gateway.invalid', REALBUD_COMPOSIO_ORG_KEY: 'fictional-org-key', REALBUD_COMPOSIO_AUTH_CONFIG_GMAIL: 'ac-fictional-readonly', REALBUD_COMPOSIO_API_BASE: composio, REALBUD_MODELVIA_BASE_URL: mvBase, REALBUD_MODELVIA_OPERATOR_SECRET: mvSecret, REALBUD_MODELVIA_OPERATOR_SUBJECT: 'fictional-billing-vendor', REALBUD_MODELVIA_CLIENT_ID: client, REALBUD_MODELVIA_ENVIRONMENT: 'development', REALBUD_MODELVIA_MODELS: model,
  }, join(ROOT, 'managed-gateway'));
  await until(async () => { assert.equal(gw.exitCode, null, gw.qaLog.slice(-1500)); try { return (await call(gwBase, '/health', { timeout: 500 })).status === 200; } catch { return false; } }, 'gateway');
  const rbOp = () => signOperatorToken('fictional-operator@example.invalid', rbOperatorSecret);

  await check('H-provision', 'RealBud provisions rb-<installationId> projects under each office customer', '4 installations -> 4 projects; A under realbud-office-a, B under realbud-office-b; caps copied (monthly=customer, request=min(A$1,monthly))', async () => {
    const out = {};
    for (const [office, inst] of [['office-a', 'inst-a1'], ['office-a', 'inst-a2'], ['office-b', 'inst-b1'], ['office-b', 'inst-b2']]) {
      const r = await call(gwBase, '/v1/portal/installations/provision', { method: 'POST', token: portal(office), body: { companyId: office, installationId: inst, customerId: 'realbud-' + office, profile: 'property' } });
      assert.equal(r.status, 200, `${inst} ${r.status} ${JSON.stringify(r.body)}`);
      keys[inst] = { key: r.body.provisioning.model.key, keyId: r.body.provisioning.model.keyId, projectId: r.body.provisioning.model.projectId };
      const p = await project(keys[inst].projectId);
      out[inst] = { projectId: p.id, customerId: p.customerId, monthly: p.monthlyCapNanoAud, request: p.requestCapNanoAud, maxConcurrent: p.maxConcurrent, label: r.body.provisioning.model.spendCapLabel };
      assert.equal(p.customerId, 'realbud-' + office); assert.equal(p.monthlyCapNanoAud, CAP); assert.equal(p.requestCapNanoAud, '1000000000');
    }
    return out;
  });
  let firstA1;
  await check('H-usage-amount', 'Chat usage priced units x rate over HTTP, recorded on the installation project', 'units input 1234 (cache miss) / output 50 -> ceil(1234*1500000/1000)+ceil(50*7000001/1000)=1851000+350001=2201001 nano', async () => {
    const before = upstreamCount(); const r = await chat(keys['inst-a1'].key, 'idem-a1-1'); assert.equal(r.status, 200, JSON.stringify(r.body));
    const q = await request(keys['inst-a1'].key, r.requestId); firstA1 = r.requestId;
    assert.equal(q.body.state, 'settled'); assert.equal(q.body.projectId, keys['inst-a1'].projectId); assert.equal(q.body.chargedNanoAud, '2201001');
    assert.equal(upstreamCount(), before + 1);
    return { requestId: r.requestId, projectId: q.body.projectId, units: q.body.units, chargedNanoAud: q.body.chargedNanoAud, priceBasis: q.body.priceBasis };
  });
  await check('H-idempotency', 'Same Idempotency-Key twice (and concurrent) -> one charge, one provider call', 'replay answers the original receipt (same request id; 409 request_already_processed by design), no extra provider call; different body same key -> 409 idempotency_conflict', async () => {
    const before = upstreamCount();
    const again = await chat(keys['inst-a1'].key, 'idem-a1-1');
    const [c1, c2] = await Promise.all([chat(keys['inst-a1'].key, 'idem-a1-2'), chat(keys['inst-a1'].key, 'idem-a1-2')]);
    const conflict = await chat(keys['inst-a1'].key, 'idem-a1-1', 'A different fictional body');
    const added = upstreamCount() - before;
    assert.equal(again.status === 200 ? again.requestId : again.body?.receipt?.requestId, firstA1, `replay status ${again.status} ${JSON.stringify(again.body)?.slice(0, 300)}`);
    assert.equal(added, 1, `provider calls added ${added}`); assert.equal(conflict.status, 409);
    return { replay: { status: again.status, code: again.body?.error?.code, receiptRequestSame: again.body?.receipt?.requestId === firstA1, receiptState: again.body?.receipt?.state }, concurrentPair: [c1.status, c2.status, c1.requestId === c2.requestId || [c1.body?.error, c2.body?.error]], differentBody: [conflict.status, conflict.body?.error?.code ?? conflict.body?.error], providerCallsAdded: added };
  });
  await check('H-attribution', 'Per-office and per-installation attribution (Modelvia analytics + website projection)', 'A usage only in realbud-office-a; B only in B; B key cannot read A request; website usage per office matches', async () => {
    const a2 = await chat(keys['inst-a2'].key, 'idem-a2-1'), b1 = await chat(keys['inst-b1'].key, 'idem-b1-1');
    assert.equal(a2.status, 200); assert.equal(b1.status, 200);
    const cross = await request(keys['inst-b1'].key, firstA1);
    assert([403, 404].includes(cross.status), 'cross read ' + cross.status);
    const an = {}; for (const c of ['realbud-office-a', 'realbud-office-b']) an[c] = (await call(mvBase, `/v1/client/customers/${c}/analytics?period=${period}`, { token: clientKey })).body;
    const ov = (await call(mvBase, '/v1/operator/overview', { token: mvOp() })).body.requests;
    const byProject = {}; for (const r of ov) byProject[r.projectId] = (byProject[r.projectId] ?? 0) + 1;
    const idsA = new Set((an['realbud-office-a'].recentRequests ?? []).map(r => r.requestId)), idsB = new Set((an['realbud-office-b'].recentRequests ?? []).map(r => r.requestId));
    assert(idsA.has(firstA1) && idsA.has(a2.requestId) && !idsA.has(b1.requestId)); assert(idsB.has(b1.requestId) && !idsB.has(firstA1));
    // website projection (real module, loopback)
    const { platformUsage } = await import(pathToFileURL(join(ROOT, 'website/lib/platform-usage.ts')).href);
    const env = { PLATFORM_API_URL: mvBase, PLATFORM_CLIENT_KEY: clientKey, REALBUD_PLATFORM_CUSTOMERS_JSON: '{}' };
    const web = {}; for (const office of ['office-a', 'office-b']) { const res = await platformUsage({ companyId: office, role: 'billing_reader' }, env, new URLSearchParams({ period })); web[office] = { status: res.status, body: await res.json() }; }
    assert.equal(web['office-a'].status, 200, JSON.stringify(web['office-a'].body));
    assert.equal(web['office-b'].body.requests, 1); assert(web['office-a'].body.requests >= 3);
    const { platformBilling } = await import(pathToFileURL(join(ROOT, 'website/lib/platform-billing.ts')).href);
    const bill = {}; for (const office of ['office-a', 'office-b']) { const res = await platformBilling({ companyId: office, role: 'billing_reader' }, env, fetch, undefined, undefined, Date.now(), period); const body = await res.json(); bill[office] = { status: res.status, keys: Object.keys(body ?? {}).slice(0, 12), sample: JSON.stringify(body).slice(0, 300) }; }
    receipt.websiteBilling = bill;
    const b = BigInt(web['office-b'].body.money.customerNetNanoAud ?? '0');
    assert.equal(b, 2201001n);
    return { requestsByProject: byProject, crossKeyRead: cross.status, websiteBillingStatus: [bill['office-a'].status, bill['office-b'].status], websiteUsage: { a: { requests: web['office-a'].body.requests, net: web['office-a'].body.money.customerNetNanoAud }, b: { requests: web['office-b'].body.requests, net: web['office-b'].body.money.customerNetNanoAud } } };
  });
  let reserve;
  await check('H-request-cap', 'Per-request cap enforced over HTTP (402, no provider call)', 'project requestCap below reservation -> 402; provider calls +0; ledger rows +0', async () => {
    const p = await project(keys['inst-a2'].projectId); const before = upstreamCount();
    const beforeRows = (await call(mvBase, '/v1/operator/overview', { token: mvOp() })).body.requests.length;
    await mvPost('/v1/operator/projects', { ...p, requestCapNanoAud: '1000' });
    const r = await chat(keys['inst-a2'].key, 'idem-a2-cap');
    const afterRows = (await call(mvBase, '/v1/operator/overview', { token: mvOp() })).body.requests.length;
    const cur = await project(keys['inst-a2'].projectId); await mvPost('/v1/operator/projects', { ...cur, requestCapNanoAud: p.requestCapNanoAud });
    assert.equal(r.status, 402, JSON.stringify(r.body)); assert.equal(upstreamCount(), before); assert.equal(afterRows, beforeRows);
    reserve = 65536n * 1500n * 2n + (64n * 7000001n + 999n) / 1000n;
    return { status: r.status, error: r.body?.error?.code ?? r.body?.error, providerCallsAdded: 0, expectedReservationNano: reserve.toString() };
  });
  await check('H-monthly-hold', 'Monthly cap counts an in-flight reservation (hold)', 'with project cap = spent + 1.5 x reservation: 2nd concurrent request -> 402 while 1st in flight; after settle a new one is admitted', async () => {
    const p = await project(keys['inst-a2'].projectId);
    const spent = 0n;
    const ov = (await call(mvBase, '/v1/operator/overview', { token: mvOp() })).body.requests.filter(r => r.projectId === p.id);
    const used = await Promise.all(ov.map(async r => BigInt((await request(keys['inst-a2'].key, r.id)).body?.chargedNanoAud ?? '0')));
    const committed = used.reduce((s, x) => s + x, spent);
    const newMonthly = committed + reserve * 3n / 2n; await mvPost('/v1/operator/projects', { ...p, monthlyCapNanoAud: newMonthly.toString(), requestCapNanoAud: (BigInt(p.requestCapNanoAud) < newMonthly ? BigInt(p.requestCapNanoAud) : newMonthly).toString() });
    writeFileSync(join(run, 'mode'), 'slow');
    const first = chat(keys['inst-a2'].key, 'idem-a2-hold-1'); const before = upstreamCount();
    await until(async () => upstreamCount() > before, 'first dispatch', 10000);
    const second = await chat(keys['inst-a2'].key, 'idem-a2-hold-2');
    const f1 = await first; writeFileSync(join(run, 'mode'), 'ok');
    const third = await chat(keys['inst-a2'].key, 'idem-a2-hold-3');
    const cur = await project(keys['inst-a2'].projectId); await mvPost('/v1/operator/projects', { ...cur, monthlyCapNanoAud: p.monthlyCapNanoAud, requestCapNanoAud: p.requestCapNanoAud });
    assert.equal(f1.status, 200); assert.equal(second.status, 402, JSON.stringify(second.body)); assert.equal(third.status, 200, JSON.stringify(third.body));
    return { first: f1.status, secondWhileHeld: [second.status, second.body?.error?.code ?? second.body?.error], afterSettle: third.status, committedBefore: committed.toString() };
  });
  await check('H-cap-change', 'Mid-month cap change via RealBud office AI access -> applyCustomerCaps', 'custom A$5 for office-a: customer + both A projects -> 5e9 monthly, request min(A$1, A$5); B projects unchanged', async () => {
    const r = await call(gwBase, '/v1/operator/offices/ai-access', { method: 'POST', token: rbOp(), body: { companyId: 'office-a', customerId: 'realbud-office-a', name: 'Fictional office-a', access: { mode: 'custom', monthlyCapNanoAud: '5000000000' } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const pa1 = await project(keys['inst-a1'].projectId), pa2 = await project(keys['inst-a2'].projectId), pb1 = await project(keys['inst-b1'].projectId);
    assert.equal(pa1.monthlyCapNanoAud, '5000000000'); assert.equal(pa2.monthlyCapNanoAud, '5000000000'); assert.equal(pb1.monthlyCapNanoAud, CAP);
    const ok = await chat(keys['inst-a1'].key, 'idem-a1-after-cap'); assert.equal(ok.status, 200);
    // now lower to A$1 total: spent so far + reservation must exceed? report behaviour
    const low = await call(gwBase, '/v1/operator/offices/ai-access', { method: 'POST', token: rbOp(), body: { companyId: 'office-a', customerId: 'realbud-office-a', name: 'Fictional office-a', access: { mode: 'custom', monthlyCapNanoAud: '1000000000' } } });
    const pLow = await project(keys['inst-a1'].projectId);
    const restore = await call(gwBase, '/v1/operator/offices/ai-access', { method: 'POST', token: rbOp(), body: { companyId: 'office-a', customerId: 'realbud-office-a', name: 'Fictional office-a', access: { mode: 'custom', monthlyCapNanoAud: CAP } } });
    return { applied: r.body.projects, customer: r.body.customer, a1: pa1.monthlyCapNanoAud, a2: pa2.monthlyCapNanoAud, b1Unchanged: pb1.monthlyCapNanoAud, lowered: [low.status, pLow.monthlyCapNanoAud, pLow.requestCapNanoAud], restored: restore.status };
  });
  await check('H-revoke', 'RealBud installation revoke stops spend', 'revoked inst-a1 key -> 401 at Modelvia; provider +0; ledger rows +0; sibling inst-a2 still serves', async () => {
    const r = await call(gwBase, '/v1/portal/installations/revoke', { method: 'POST', token: portal('office-a'), body: { companyId: 'office-a', installationId: 'inst-a1' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const before = upstreamCount(), rows = (await call(mvBase, '/v1/operator/overview', { token: mvOp() })).body.requests.length;
    const refused = await chat(keys['inst-a1'].key, 'idem-a1-after-revoke');
    const rows2 = (await call(mvBase, '/v1/operator/overview', { token: mvOp() })).body.requests.length;
    const sib = await chat(keys['inst-a2'].key, 'idem-a2-after-sibling-revoke');
    assert.equal(refused.status, 401, JSON.stringify(refused.body)); assert.equal(upstreamCount(), before + 1); assert.equal(rows2, rows); assert.equal(sib.status, 200);
    const reprovision = await call(gwBase, '/v1/portal/installations/provision', { method: 'POST', token: portal('office-a'), body: { companyId: 'office-a', installationId: 'inst-a1', customerId: 'realbud-office-a', profile: 'property' } });
    return { revoke: r.body.revoked?.modelKeyRevoked, afterRevoke: [refused.status, refused.body?.error?.code ?? refused.body?.error], ledgerRowsAdded: rows2 - rows, sibling: sib.status, reprovisionRevoked: [reprovision.status, reprovision.body?.error] };
  });
  await check('H-cross-office-provision', 'Office A portal token provisioning into office B customer', 'refused (customer not bound to company) — else A installation spend bills to B', async () => {
    const r = await call(gwBase, '/v1/portal/installations/provision', { method: 'POST', token: portal('office-a'), body: { companyId: 'office-a', installationId: 'inst-a-cross', customerId: 'realbud-office-b', profile: 'property' } });
    const detail = { status: r.status, error: r.body?.error };
    if (r.status === 200) {
      const p = await project(r.body.provisioning.model.projectId);
      detail.projectCustomer = p.customerId; detail.billingAccount = 'office-b (customer realbud-office-b)';
      await call(gwBase, '/v1/portal/installations/revoke', { method: 'POST', token: portal('office-a'), body: { companyId: 'office-a', installationId: 'inst-a-cross' } });
      throw new Error('ACCEPTED: ' + JSON.stringify(detail));
    }
    return detail;
  });
  await check('H-disable', 'Office AI access Off (disabled customer) stops spend for all its installations', 'office-b disabled -> B keys refused (403) with no provider call; office A unaffected', async () => {
    const r = await call(gwBase, '/v1/operator/offices/ai-access', { method: 'POST', token: rbOp(), body: { companyId: 'office-b', customerId: 'realbud-office-b', name: 'Fictional office-b', access: { mode: 'disabled' } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const before = upstreamCount();
    const b1 = await chat(keys['inst-b1'].key, 'idem-b1-disabled'), b2 = await chat(keys['inst-b2'].key, 'idem-b2-disabled');
    const a2 = await chat(keys['inst-a2'].key, 'idem-a2-while-b-off');
    assert([401, 402, 403].includes(b1.status) && [401, 402, 403].includes(b2.status), `${b1.status} ${b2.status}`); assert.equal(upstreamCount(), before + 1); assert.equal(a2.status, 200);
    return { customer: r.body.customer, b1: [b1.status, b1.body?.error?.code ?? b1.body?.error], b2: [b2.status, b2.body?.error?.code ?? b2.body?.error], officeA: a2.status };
  });
  await check('H-new-office-access', 'Office AI access creates the Modelvia customer for a new office (Default)', 'created customer usable for a new office under the platform client', async () => {
    const r = await call(gwBase, '/v1/operator/offices/ai-access', { method: 'POST', token: rbOp(), body: { companyId: 'office-c', customerId: 'realbud-office-c', name: 'Fictional office-c', access: { mode: 'default' } } });
    // direct repro at Modelvia of the write office-ai-access makes for a new customer (no billingCompanyId)
    const direct = await call(mvBase, '/v1/operator/customers', { method: 'POST', token: mvOp(), body: { id: 'realbud-office-c-direct', name: 'Fictional office-c', active: true, monthlyCapNanoAud: '200000000000', maxConcurrent: 2, allowedModels: [model], version: 0, clientId: client } });
    receipt.newOfficeDirect = { status: direct.status, body: direct.body };
    assert.equal(r.status, 200, `status ${r.status} ${JSON.stringify(r.body)}; direct Modelvia write without billingCompanyId -> ${direct.status} ${JSON.stringify(direct.body)}`);
    return r.body;
  });
  receipt.upstreamCalls = upstreamCount();
  // ---------- close the month on the real sqlite ledger (module, clock = next month) ----------
  await stop(gw); await stop(mv);
  await check('H-invoice-close', 'Monthly invoices from the HTTP-recorded usage (Modelvia BillingService on the same sqlite ledger, clock next month)', 'office-a invoice = cents(sum A charges), GST=(total+5)/11, only A requests; office-b same; AUD gst-inclusive', async () => {
    const MVU = f => pathToFileURL(join(MVDIR, f)).href;
    const { LedgerDatabase: MvDb } = await import(MVU('database.ts')); const { UsageLedger: MvLedger } = await import(MVU('ledger.ts')); const { BillingService } = await import(MVU('billing.ts')); const { cents, gstCents } = await import(MVU('money.ts'));
    const next = new Date(Date.parse(period + '-01T00:00:00Z')); next.setUTCMonth(next.getUTCMonth() + 1); const clock = next.getTime() - 36_000_000 + 3_600_000;
    const db = new MvDb(join(run, 'mv-data/ledger.sqlite')); const ledger = new MvLedger(db, () => clock);
    try {
      const billing = new BillingService(ledger, undefined, { platformSupplier: { legalName: 'Fictional Platform Seller', product: 'Fictional AI', abn: '00000000000', gstRegistered: true } });
      const out = {};
      for (const office of ['office-a', 'office-b']) {
        const reqs = (await ledger.requests(office)).filter(r => r.state === 'settled');
        const inv = await billing.finalizeLocalInvoice(office, period);
        const expected = cents(reqs.reduce((s, r) => s + BigInt(r.chargedNanoAud), 0n));
        assert.equal(inv.totalCents, expected.toString()); assert.equal(inv.gstCents, gstCents(expected).toString()); assert.equal(inv.currency, 'AUD'); assert.equal(inv.gstInclusive, true);
        const ids = new Set(reqs.map(r => r.id)); assert(inv.lines.filter(l => l.requestId).every(l => ids.has(l.requestId)));
        out[office] = { invoice: inv.id, settledRequests: reqs.length, projects: [...new Set(reqs.map(r => r.project))], totalCents: inv.totalCents, gstCents: inv.gstCents, usageLines: inv.lines.filter(l => l.requestId).length };
      }
      return out;
    } finally { await db.close?.(); }
  });
} catch (e) { receipt.failure = redact(e?.stack ?? e); console.error(receipt.failure); process.exitCode = 1; }
finally {
  for (const c of processes.slice().reverse()) { await stop(c); writeFileSync(join(OUT, 'http-' + c.qaName + '.log'), c.qaLog); }
  for (const s of servers) { s.closeAllConnections(); await new Promise(r => s.close(r)); }
  receipt.passed = results.filter(r => r.pass).length; receipt.failed = results.filter(r => !r.pass).length;
  writeFileSync(join(OUT, 'http-checks.json'), redact(JSON.stringify(receipt, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2)) + '\n');
  rmSync(run, { recursive: true, force: true });
  console.log(JSON.stringify({ passed: receipt.passed, failed: receipt.failed }));
}
