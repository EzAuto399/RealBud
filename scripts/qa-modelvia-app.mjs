#!/usr/bin/env node
// Real desktop HTTP -> fixture website approval/report -> real local RealBud
// provisioning gateway -> real local Modelvia -> actual pinned Hermes.
// Website identity/approval, Composio and provider output are FICTIONAL.
// No hosted endpoints, user profile, PostgreSQL, builds or paid calls.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHmac, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serviceSmokeEnv } from './service-smoke-env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.env.REALBUD_QA_OUT ?? join(root, 'outputs/readiness-gaps-2026-09-23/app', new Date().toISOString().replaceAll(':', '-')));
assert(!existsSync(out), 'Use a fresh output directory; previous evidence is never overwritten.');
mkdirSync(out, { recursive: true, mode: 0o700 });
const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'realbud-modelvia-app-'));
const home = join(scratch, 'home'), data = join(home, 'data'), hermes = join(data, 'hermes');
for (const dir of [home, data, hermes]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const cli = process.env.REALBUD_QA_HERMES_CLI ?? '/Users/yoda/.realbud/hermes/runtimes/345cd2b057a452236de401d3534b8502a7465e8d-cfb3f08a9ee7/hermes-agent/venv/bin/hermes';
assert(existsSync(cli), 'The supported local Hermes CLI is required; no runtime is downloaded.');
assert(!existsSync(join(resolve(dirname(cli), '../..'), '.env')), 'Runtime has an external dotenv fallback; do not use it in this fixture.');
const mvRepo = process.env.REALBUD_QA_MODELVIA_REPO ?? '/Users/yoda/projects/modelvia';
const mvRevision = process.env.REALBUD_QA_MODELVIA_REVISION ?? 'd5a355dab049aca8e51d9290d2c6b618bae3e720';
const company = 'fictional-app-company', customer = 'fictional-app-customer', client = 'fictional-app-client';
const model = 'deepseek-chat', rateVersion = 'fictional-app-rate-1', cap = '1000000000';
const portalSecret = 'fictional-realbud-app-portal-secret-20260923';
const mvSecret = 'fictional-modelvia-app-operator-secret-20260923';
const password = 'Fictional-QA-administrator-20260923!';
const processes = [], servers = [], checks = [];
const receipt = { at: new Date().toISOString(), proofLayer: 'Local real app/server + pinned Hermes integration with fictional website, connector and provider', passed: false, checks, source: {}, limits: [
  'No hosted Modelvia, real website sign-in, customer account, Composio organisation or paid inference.',
  'Website approval/report is a controlled HTTP fixture; it does not prove the real Next/Supabase identity flow.',
  'Modelvia ledger/admission and RealBud provisioning/desktop routes are real local source; provider answers are synthetic.',
  'Trusted entitlement is signed by a disposable QA issuer; it is not a production service grant.',
  'No native Electron window, Windows machine, bank/email/calendar operation or same-LAN second-device acceptance.',
], cleanup: false };
let session, admin, desktop, websiteState, descriptor, modelKey, clientKey, mvBase, gatewayBase, appBase;
const redact = value => String(value).replace(/\brbk_[A-Za-z0-9_-]+/g, '[model-key]').replace(/\brbc_[A-Za-z0-9_-]+/g, '[connector-key]').replace(/\bak_[A-Za-z0-9_-]+/g, '[connector-project-key]').replaceAll(password, '[qa-admin-password]');
const save = () => writeFileSync(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 }); };
async function step(name, fn) {
  const entry = { name, passed: false, elapsedMs: 0 }; checks.push(entry); save();
  const start = performance.now();
  try { const detail = await fn(); if (detail !== undefined) entry.detail = detail; entry.passed = true; }
  catch (e) { entry.error = redact(e?.message ?? e); throw e; }
  finally { entry.elapsedMs = Math.round(performance.now() - start); save(); console.log(`${entry.passed ? 'PASS' : 'FAIL'} ${name} (${entry.elapsedMs}ms)`); }
}
async function port() { const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const n = s.address().port; await new Promise(r => s.close(r)); return n; }
async function serve(handler) { const s = createServer((req, res) => Promise.resolve(handler(req, res)).catch(error => { (receipt.fixtureErrors ??= []).push({ path: req.url?.split('?')[0], error: redact(error?.message ?? error) }); if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'fictional_fixture_failed' })); })); servers.push(s); s.listen(0, '127.0.0.1'); await once(s, 'listening'); return `http://127.0.0.1:${s.address().port}`; }
function launch(name, args, env, cwd = root) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.qaName = name; child.qaLog = ''; child.qaClosed = new Promise(r => child.once('close', r));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { child.qaLog = (child.qaLog + redact(b.toString())).slice(-20000); });
  processes.push(child); return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill('SIGTERM'); const timeout = setTimeout(() => child.kill('SIGKILL'), 6000);
  try { await child.qaClosed; } finally { clearTimeout(timeout); }
}
async function until(fn, label, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error(`Timed out waiting for ${label}`); }
async function call(base, path, { method = 'GET', body, token, headers = {}, timeout = 75000 } = {}) {
  assert.equal(new URL(base).hostname, '127.0.0.1', 'Fixture requests must stay on loopback.');
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout), redirect: 'error' });
  const text = await res.text(); let value; try { value = JSON.parse(text); } catch { value = null; }
  return { status: res.status, body: value, text, requestId: res.headers.get('x-request-id') };
}
const api = (path, method = 'GET', body, privileged = false) => call(appBase, path, { method, body, headers: { 'x-realbud-session': session, ...(privileged && admin ? { 'x-realbud-service-admin': admin } : {}) } });
const bearer = (secret, payload) => { const now = Date.now(), text = Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + 120000 })).toString('base64url'); return text + '.' + createHmac('sha256', secret).update(text).digest('base64url'); };
const operator = () => bearer(mvSecret, { aud: 'managed-ai-operator', subject: 'fictional-app-operator' });
const portal = () => bearer(portalSecret, { subject: 'fictional-app-owner', companyId: company, role: 'billing_owner' });
async function mvPost(path, body) { const r = await call(mvBase, path, { method: 'POST', body, token: operator() }); assert.equal(r.status, 200, `${path} ${r.status} ${redact(r.body?.error?.code ?? r.body?.error ?? '')}`); return r.body; }
const now = () => Date.now();
const issuer = generateKeyPairSync('ed25519');
let canonicalEntitlement;
function entitlement(host, patch = {}) {
  const payload = canonicalEntitlement({ schema: 1, companyId: company, hostInstallationId: host, licenseId: 'fictional-app-license', issuedAt: now() - 60000, notBefore: now() - 30000, expiresAt: now() + 3600000, capabilities: ['reasoning', 'connected-tools'], ...patch });
  write(join(data, 'service-entitlement.json'), { schema: 1, keyId: 'fictional-app-issuer', payload, signature: sign(null, Buffer.from(payload), issuer.privateKey).toString('base64url') });
}
try {
  await step('isolated-runtime-and-source', async () => {
    Object.assign(process.env, { HOME: home, USERPROFILE: home, REALBUD_DATA_DIR: data, REALBUD_HERMES_HOME: hermes, HERMES_HOME: hermes });
    const mvTree = join(scratch, 'modelvia'); mkdirSync(mvTree);
    const archive = execFileSync('git', ['-C', mvRepo, 'archive', mvRevision, 'managed-gateway'], { maxBuffer: 64 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', mvTree], { input: archive });
    const modules = join(mvRepo, 'managed-gateway/node_modules'); assert(existsSync(modules)); symlinkSync(modules, join(mvTree, 'managed-gateway/node_modules'));
    receipt.source = { realbudHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), modelviaRevision: execFileSync('git', ['-C', mvRepo, 'rev-parse', mvRevision], { encoding: 'utf8' }).trim(), modelviaSource: 'git archive, exact revision', hermesCli: cli, node: process.version };
    const { createServiceAdminPasswordVerifier } = await import('../server/service-admin.ts');
    ({ canonicalServiceEntitlementPayload: canonicalEntitlement } = await import('../server/service-entitlement.ts'));
    write(join(data, 'service-admin.json'), { version: 1, passwordVerifier: await createServiceAdminPasswordVerifier(password) });
    write(join(data, 'service-trust-keys.json'), { schema: 1, keys: [{ keyId: 'fictional-app-issuer', publicKeyPem: issuer.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] });
    write(join(data, 'config.json'), { instances: { hermes: { driver: 'hermesAgent', cli, workspace: join(data, 'vault') } } });
    const guard = `import net from 'node:net';\nconst originalListen=net.Server.prototype.listen;net.Server.prototype.listen=function(...args){if(args[1]==='0.0.0.0')args[1]='127.0.0.1';return originalListen.apply(this,args);};\nconst originalFetch=globalThis.fetch;globalThis.fetch=async(input,init)=>{const u=new URL(input instanceof Request?input.url:String(input));if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw new Error('QA denied nonloopback fetch');return originalFetch(input,init);};\n`;
    const captureWorker = `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {appendFileSync} from 'node:fs';\nconst actualExec=cp.execFile;cp.execFile=function(file,...args){const child=actualExec.call(this,file,...args);if(String(file).includes('hermes')&&!args[0]?.includes('--version'))for(const [name,stream] of [['stdout',child.stdout],['stderr',child.stderr]])stream?.on('data',b=>{const text=String(b).replace(/\\brbk_[A-Za-z0-9_-]+/g,'[model-key]').replace(/\\brbc_[A-Za-z0-9_-]+/g,'[connector-key]');appendFileSync(${JSON.stringify(join(scratch, 'worker-diagnostics.jsonl'))},JSON.stringify({stream:name,text:text.slice(0,10000)})+'\\n');});return child;};syncBuiltinESMExports();\n`;
    write(join(scratch, 'node-guard.mjs'), guard + captureWorker);
    write(join(scratch, 'provider-hook.mjs'), `import {appendFileSync,readFileSync} from 'node:fs';\nconst real=globalThis.fetch;globalThis.fetch=async(input,init)=>{const u=new URL(input instanceof Request?input.url:String(input));if(u.hostname!=='api.deepseek.com')return real(input,init);const body=JSON.parse(init.body);appendFileSync(${JSON.stringify(join(scratch, 'upstream.jsonl'))},JSON.stringify({model:body.model,stream:body.stream,messageCount:body.messages?.length,tools:body.tools?.map(t=>t.function?.name)??[],maxTokens:body.max_tokens??null})+'\\n');const mode=readFileSync(${JSON.stringify(join(scratch, 'provider-mode'))},'utf8');if(mode==='delay'||mode==='slow')await new Promise((resolve,reject)=>{const t=setTimeout(resolve,mode==='slow'?5000:70000);init.signal?.addEventListener('abort',()=>{clearTimeout(t);reject(init.signal.reason);},{once:true});});const id='fictional-app-'+Math.random().toString(16).slice(2);const frames=[{id,model:${JSON.stringify(model)},choices:[{index:0,delta:{role:'assistant',content:'OK'},finish_reason:null}]},{id,model:${JSON.stringify(model)},choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:123,completion_tokens:1,total_tokens:124,prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:123}}];return new Response(frames.map(v=>'data: '+JSON.stringify(v)+'\\n\\n').join('')+'data: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}});};\n`);
    write(join(scratch, 'provider-mode'), 'ok');
    const py = join(scratch, 'python-guard'); mkdirSync(py);
    write(join(py, 'sitecustomize.py'), `import sys,os\nfrom pathlib import Path\nroot=Path(os.environ['QA_SCRATCH']).resolve()\ndef guard(event,args):\n if event=='socket.connect' and isinstance(args[1],tuple) and args[1][0] not in {'127.0.0.1','localhost','::1'}: raise PermissionError('QA denied nonloopback connect')\n if event=='socket.getaddrinfo' and args[0] not in {'127.0.0.1','localhost','::1'}: raise PermissionError('QA denied nonloopback DNS')\n if event=='open' and isinstance(args[0],str):\n  path=Path(args[0]).resolve()\n  if path.name in {'.env','.op.env','auth.json','credentials.json'} and not path.is_relative_to(root): raise PermissionError('QA denied external credential file')\nsys.addaudithook(guard)\n`);
    return { disposableHome: true, noUserCredentialReads: true, sourceFilesModified: false };
  });
  await step('local-modelvia-and-fictional-billing', async () => {
    const mvPort = await port(); mvBase = `http://127.0.0.1:${mvPort}`;
    write(join(scratch, 'catalog.json'), [{ model, configuration: 'fictional-app-fixed', provider: 'deepseek', profile: 'fast', capabilities: ['text', 'tools'], thinking: 'disabled', maximumOutputTokens: 256, contextLength: 65536, costNanoAud: '1000' }]);
    const child = launch('modelvia', ['--experimental-strip-types', '--import', join(scratch, 'node-guard.mjs'), '--import', join(scratch, 'provider-hook.mjs'), 'server.ts'], {
      PATH: dirname(process.execPath) + ':/usr/bin:/bin', HOME: home, PORT: String(mvPort), PLATFORM_BIND_HOST: '127.0.0.1', REALBUD_GATEWAY_DATA: join(scratch, 'mv-data'), REALBUD_FINGERPRINT_KEY: 'a1'.repeat(32), REALBUD_GATEWAY_PORTAL_SECRET: 'fictional-app-modelvia-portal-secret', REALBUD_GATEWAY_OPERATOR_SECRET: mvSecret, REALBUD_PAYMENT_MODE: 'local', REALBUD_ALLOWED_ORIGINS: mvBase, MODELVIA_LEDGER_BACKEND: 'sqlite', REALBUD_ENABLE_PROVIDER: '1', DEEPSEEK_API_KEY: 'fictional-upstream-key', DEEPSEEK_MAX_OUTPUT: '256', DEEPSEEK_CONTEXT: '65536', DEEPSEEK_TERMS_REF: 'fictional-app-qa', DEEPSEEK_APPROVED_UNTIL: String(now() + 3600000), PLATFORM_ROUTE_CATALOG_FILE: join(scratch, 'catalog.json'), PLATFORM_ROUTING_MODE: 'fixed', PLATFORM_SHUTDOWN_DRAIN_MS: '1000',
    }, join(scratch, 'modelvia/managed-gateway'));
    await until(async () => { assert.equal(child.exitCode, null, child.qaLog.slice(-2000)); try { return (await call(mvBase, '/health', { timeout: 500 })).status === 200; } catch { return false; } }, 'Modelvia startup');
    const t = now();
    await mvPost('/v1/operator/billing-accounts', { companyId: company, licenseId: 'fictional-app-license', active: true, serviceExpiresAt: t + 3600000, customerName: 'Fictional app QA', customerAddress: '1 Fictional Street', goLiveAt: t - 60000, goLiveEvidence: 'fictional-app-qa', includedUntil: t - 60000, plan: 'platform', monthlyCapNanoAud: cap, requestCapNanoAud: cap, maxConcurrent: 1, creditLimitNanoAud: cap });
    const unit = { nanoAud: '1000', perUnits: 1000 };
    await mvPost('/v1/operator/rates', { version: rateVersion, currency: 'AUD', gstInclusive: true, gstBasisPoints: 1000, publishedAt: t - 1000, effectiveAt: t - 1000, models: [{ model, label: 'Fictional app QA', units: { input_tokens: unit, cache_read_tokens: unit, output_tokens: unit } }] });
    const cards = await call(mvBase, '/v1/operator/rates', { token: operator() }); const card = cards.body.rates.find(x => x.card.version === rateVersion);
    await mvPost('/v1/operator/rates/accept', { companyId: company, version: rateVersion, digest: card.digest, acceptanceReference: 'fictional-app-acceptance' });
    const common = { active: true, monthlyCapNanoAud: cap, maxConcurrent: 1, allowedModels: [model], version: 0 };
    await mvPost('/v1/operator/clients', { ...common, id: client, name: 'Fictional app client', billingMode: 'customer' });
    await mvPost('/v1/operator/customers', { ...common, id: customer, name: 'Fictional app customer', clientId: client, billingCompanyId: company });
    clientKey = (await mvPost('/v1/operator/client-keys', { clientId: client, label: 'fictional-app-reader' })).key;
    return { fixedModel: model, contextLength: 65536, outputCeiling: 256, maxConcurrent: 1, provider: 'in-process fictional SSE' };
  });
  await step('local-realbud-provisioning-gateway', async () => {
    const projects = [], authConfigs = [];
    const composio = await serve(async (req, res) => {
      const send = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method === 'GET' && req.url.startsWith('/org/owner/project/list')) return send({ items: projects });
      if (req.method === 'POST' && req.url.startsWith('/org/owner/project/new')) { const p = { id: 'pr_fictional_app', name: `realbud-${company}` }; projects.push(p); return send({ ...p, api_key: 'ak_fictional_app_project_key_only' }); }
      if (req.method === 'GET' && req.url.startsWith('/auth_configs?')) {
        assert.equal(req.headers['x-api-key'], 'ak_fictional_app_project_key_only');
        return send({ items: authConfigs, next_cursor: null });
      }
      if (req.method === 'POST' && req.url === '/auth_configs') {
        assert.equal(req.headers['x-api-key'], 'ak_fictional_app_project_key_only');
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        assert.deepEqual(body, { toolkit: { slug: 'gmail' }, auth_config: { type: 'use_composio_managed_auth', name: 'realbud-gmail-readonly-v1', credentials: { scopes: 'https://www.googleapis.com/auth/gmail.readonly' } } });
        const config = { id: 'ac_fictional_readonly', name: body.auth_config.name, toolkit: { slug: 'gmail' }, auth_scheme: 'OAUTH2', is_composio_managed: true, status: 'ENABLED', credentials: body.auth_config.credentials };
        authConfigs.push(config);
        return send({ auth_config: { id: config.id } }, 201);
      }
      res.writeHead(404).end();
    });
    const gatewayData = join(scratch, 'rb-gateway'); mkdirSync(gatewayData);
    const { LedgerDatabase } = await import('../managed-gateway/database.ts');
    const { UsageLedger } = await import('../managed-gateway/ledger.ts');
    const { twoMonthsAfter } = await import('../managed-gateway/money.ts');
    const db = new LedgerDatabase(join(gatewayData, 'ledger.sqlite'));
    try { const live = now() - 60000; new UsageLedger(db, Date.now).provisionTenant({ companyId: company, licenseId: 'fictional-app-license', active: true, serviceExpiresAt: now() + 3600000, customerName: 'Fictional app QA', customerAddress: '1 Fictional Street', goLiveAt: live, goLiveEvidence: 'fictional-app-qa', includedUntil: twoMonthsAfter(live), monthlyCapNanoAud: cap, requestCapNanoAud: cap, maxConcurrent: 1 }); } finally { db.close(); }
    const gatewayPort = await port(); gatewayBase = `http://127.0.0.1:${gatewayPort}`;
    const child = launch('realbud-gateway', ['--experimental-strip-types', '--import', join(scratch, 'node-guard.mjs'), 'server.ts'], {
      HOME: home, PATH: dirname(process.execPath) + ':/usr/bin:/bin', PORT: String(gatewayPort), REALBUD_GATEWAY_DATA: gatewayData, REALBUD_GATEWAY_PORTAL_SECRET: portalSecret, REALBUD_PAYMENT_MODE: 'local', REALBUD_ALLOWED_ORIGINS: gatewayBase, REALBUD_ENABLE_PROVIDER: '1', REALBUD_GATEWAY_SECRETS_DIR: join(scratch, 'gateway-secrets'), REALBUD_GATEWAY_CONNECTOR_REGISTRY: join(scratch, 'registry/devices.json'), REALBUD_GATEWAY_PUBLIC_ORIGIN: 'https://fictional-app-gateway.invalid', REALBUD_COMPOSIO_ORG_KEY: 'fictional-app-org-key', REALBUD_COMPOSIO_API_BASE: composio, REALBUD_MODELVIA_BASE_URL: mvBase, REALBUD_MODELVIA_OPERATOR_SECRET: mvSecret, REALBUD_MODELVIA_OPERATOR_SUBJECT: 'fictional-app-vendor', REALBUD_MODELVIA_CLIENT_ID: client, REALBUD_MODELVIA_ENVIRONMENT: 'development', REALBUD_MODELVIA_MODELS: model,
    }, join(root, 'managed-gateway'));
    await until(async () => { assert.equal(child.exitCode, null, child.qaLog.slice(-2000)); try { return (await call(gatewayBase, '/health', { timeout: 500 })).status === 200; } catch { return false; } }, 'RealBud gateway startup');
    assert.match(child.qaLog, /"provisioning":"composed"/);
    return { composio: 'fictional loopback organisation', provisioning: 'real gateway implementation' };
  });
  let websiteBase;
  await step('controlled-website-and-real-desktop', async () => {
    websiteBase = await serve(async (req, res) => {
      const chunks = []; for await (const c of req) chunks.push(c); const raw = Buffer.concat(chunks).toString(); const body = raw ? JSON.parse(raw) : {};
      const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
      if (req.method === 'POST' && req.url === '/api/installations/link-requests') {
        websiteState = { id: body.id, token: body.token, approved: false, expiresAt: new Date(now() + 600000).toISOString() };
        return send(201, { version: 1, purpose: 'installation-link-issued', approvalUrl: `${websiteBase}/link/${randomBytes(32).toString('base64url')}`, displayCode: 'ABCD-EFGH', expiresAt: websiteState.expiresAt });
      }
      if (!websiteState || req.headers.authorization !== `Bearer ${websiteState.token}`) return send(401, { error: 'Installation link is not active.' });
      if (req.url === '/api/installations/link-requests/status') return send(200, websiteState.approved
        ? { version: 1, purpose: 'installation-link-status', state: 'linked', companyId: company, agencyLabel: 'Fictional app QA office', installationId: websiteState.id }
        : { version: 1, purpose: 'installation-link-status', state: 'pending', expiresAt: websiteState.expiresAt });
      if (req.method === 'POST' && req.url === '/api/installations/report') {
        if (!descriptor) { const answer = await call(gatewayBase, '/v1/portal/installations/provision', { method: 'POST', token: portal(), body: { companyId: company, installationId: websiteState.id, customerId: customer, profile: 'property' } }); assert.equal(answer.status, 200, `gateway provisioning ${answer.status}`); descriptor = answer.body.provisioning; modelKey = descriptor.model.key; }
        if (!websiteState.delivered) { websiteState.delivered = true; return send(200, { ok: true, provisioning: descriptor }); }
        return send(200, { ok: true });
      }
      if (req.url.startsWith('/api/installations/usage')) return send(503, { error: 'Fictional usage projection not part of this fixture.' });
      return send(404, { error: 'not_found' });
    });
    const appPort = await port(); appBase = `http://127.0.0.1:${appPort}`;
    const env = { ...serviceSmokeEnv({ executable: process.execPath, home, data, scratch, port: appPort }), PATH: dirname(process.execPath) + ':/usr/bin:/bin',
      // The trusted admin policy keeps this service managed. Env production
      // flags stay off solely to admit the documented loopback website lab.
      REALBUD_MANAGED_SERVICE: '0', REALBUD_PRODUCTION: '0', REALBUD_TEST_LAB: '1', REALBUD_WEBSITE_ORIGIN: websiteBase, REALBUD_HERMES_CLI: cli, OMB_STATIC_DIR: join(root, 'dist'), PYTHONPATH: join(scratch, 'python-guard'), PYTHONDONTWRITEBYTECODE: '1', QA_SCRATCH: scratch, NO_PROXY: '*' };
    desktop = launch('desktop-service', ['--experimental-strip-types', '--import', join(scratch, 'node-guard.mjs'), 'server/index.ts'], env);
    await until(async () => { assert.equal(desktop.exitCode, null, desktop.qaLog.slice(-2000)); try { return (await call(appBase, '/api/health', { timeout: 500 })).body?.pid === desktop.pid; } catch { return false; } }, 'desktop startup', 45000);
    session = (await call(appBase, '/api/session')).body.token;
    const status = await api('/api/service-admin/status'); assert.equal(status.body.managed, true); assert.equal(status.body.authenticated, false);
    admin = (await api('/api/service-admin/login', 'POST', { password })).body.token; assert(admin);
    const pack = await api('/api/hermes/apply-pack', 'POST', {}, true); assert.equal(pack.status, 200, `pack ${pack.status}`);
    return { managedPolicy: true, entitlementEnforced: true, actualPinnedCli: true, websiteAuthority: 'fixture, no real sign-in', appOrigin: appBase };
  });
  await step('app-browser-link-consumes-real-provisioning', async () => {
    const pending = await api('/api/office-link/browser-link', 'POST', { label: 'Fictional app QA Mac' }); assert.equal(pending.status, 200); assert.equal(pending.body.state, 'pending');
    assert.equal((await api('/api/office-link/browser-link')).body.state, 'pending');
    websiteState.approved = true;
    const linked = await api('/api/office-link/browser-link'); assert.equal(linked.body.state, 'linked');
    await until(async () => { const status = (await api('/api/office-link')).body; receipt.lastLinkStatus = status; return status.provisioned === true; }, 'grant applied', 20000);
    const status = (await api('/api/office-link')).body;
    assert(!JSON.stringify(status).includes(modelKey)); assert(!JSON.stringify(status).includes(websiteState.token));
    assert.equal((await api('/api/service/status')).body.state, 'unconfigured');
    const profile = readFileSync(join(hermes, 'profiles/property/config.yaml'), 'utf8'); assert(profile.includes(mvBase)); assert(!profile.includes(modelKey));
    const dotenv = join(hermes, 'profiles/property/.env'); assert(!existsSync(dotenv) || !readFileSync(dotenv, 'utf8').includes(modelKey));
    const grant = JSON.parse(readFileSync(join(data, 'service-provisioning.json'), 'utf8')); assert.equal(grant.keyId, descriptor.model.keyId); assert(!JSON.stringify(grant).includes(modelKey));
    const keyFiles = [];
    const scan = dir => { for (const row of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, row.name); if (row.isDirectory()) scan(p); else if (row.isFile() && statSync(p).size < 4000000 && readFileSync(p).includes(Buffer.from(modelKey))) keyFiles.push(p.slice(data.length + 1)); } };
    scan(data); assert.deepEqual(keyFiles, [], 'plaintext model key must not occur in app data');
    return { linked: true, provisioned: true, modelKeyId: descriptor.model.keyId, projectId: descriptor.model.projectId, profileUsesGateway: true, plaintextKeyFiles: 0, serviceBeforeEntitlement: 'unconfigured' };
  });
  await step('wrong-bound-entitlement-refused-before-worker', async () => {
    entitlement('fictional-wrong-installation'); assert.equal((await api('/api/service/status')).body.state, 'invalid');
    const ping = await api('/api/hermes/test', 'POST', {}, true); assert.equal(ping.status, 200); assert.equal(ping.body.ok, false); assert.match(ping.body.detail, /entitlement|service/i);
    assert(!existsSync(join(scratch, 'upstream.jsonl')), 'invalid entitlement must not call provider');
    return { state: 'invalid', workerProviderCalls: 0, detail: ping.body.detail };
  });
  await step('trusted-entitlement-and-real-worker-readiness', async () => {
    entitlement(websiteState.id); assert.equal((await api('/api/service/status')).body.state, 'active');
    // The existing model route applies the selection and invokes the real ping.
    const connected = await api('/api/hermes/model', 'POST', { model, apiKey: '' }, true);
    assert.equal(connected.status, 200, `model selection ${connected.status}`); assert.equal(connected.body.ping?.ok, true, redact(connected.body.ping?.detail ?? connected.body.error ?? 'missing ping'));
    const tested = await api('/api/hermes/test', 'POST', {}, true); assert.equal(tested.status, 200); assert.equal(tested.body.ok, true, redact(tested.body.detail));
    const calls = readFileSync(join(scratch, 'upstream.jsonl'), 'utf8').trim().split('\n').map(x => JSON.parse(x));
    assert(calls.length >= 2); assert(calls.every(c => c.stream === true && c.tools.includes('tool_call')));
    const period = new Date(now() + 36000000).toISOString().slice(0, 7);
    const analytics = await call(mvBase, `/v1/client/customers/${customer}/analytics?period=${period}`, { token: clientKey }); assert.equal(analytics.status, 200);
    const requests = analytics.body.recentRequests ?? []; assert(requests.length >= 2);
    const settled = [];
    for (const row of requests) {
      const r = await call(mvBase, `/v1/requests/${row.requestId}`, { token: modelKey }); assert.equal(r.status, 200); assert.equal(r.body.state, 'settled'); assert.equal(r.body.projectId, descriptor.model.projectId);
      settled.push({ requestId: r.body.requestId, state: r.body.state, projectId: r.body.projectId, model: r.body.model, pricingContract: r.body.pricingContract, priceBasis: r.body.priceBasis, chargedNanoAud: r.body.chargedNanoAud, units: r.body.units });
    }
    receipt.workerCalls = calls; receipt.settled = settled;
    return { connectAndCheck: connected.body.ping, explicitReadiness: tested.body, actualWorkerProviderCalls: calls.length, settledRequests: settled.length };
  });
  await step('second-readiness-is-held-while-first-is-running', async () => {
    const count=()=>readFileSync(join(scratch,'upstream.jsonl'),'utf8').trim().split('\n').length;
    const before=count();write(join(scratch,'provider-mode'),'slow');
    const first=api('/api/hermes/test','POST',{},true);
    await until(async()=>count()>before,'first provider dispatch');
    const second=await api('/api/hermes/test','POST',{},true);
    assert.equal(second.body.ok,false);assert.match(second.body.detail,/another model request is still running/i);
    const completed=await first;assert.equal(completed.body.ok,true,completed.body.detail);assert.equal(count(),before+1);
    write(join(scratch,'provider-mode'),'ok');
    return {firstCompleted:true,secondRefused:true,providerCallsAdded:1,detail:second.body.detail};
  });
  await step('app-request-cap-refusal-without-provider-dispatch', async () => {
    const before=readFileSync(join(scratch,'upstream.jsonl'),'utf8').trim().split('\n').length;
    const list=await call(mvBase,'/v1/operator/projects',{token:operator()});
    const project=list.body.accounts.find(p=>p.id===descriptor.model.projectId);assert(project);
    const changed=await mvPost('/v1/operator/projects',{...project,requestCapNanoAud:'1'});
    const ping=await api('/api/hermes/test','POST',{},true);assert.equal(ping.body.ok,false);assert.match(ping.body.detail,/reserved capacity/i);
    assert.equal(readFileSync(join(scratch,'upstream.jsonl'),'utf8').trim().split('\n').length,before);
    await mvPost('/v1/operator/projects',{...changed,requestCapNanoAud:project.requestCapNanoAud});
    return {refused:true,providerCallsAdded:0,detail:ping.body.detail};
  });
  await step('slow-provider-times-out-and-keeps-local-service-responsive', async () => {
    const before=readFileSync(join(scratch,'upstream.jsonl'),'utf8').trim().split('\n').length;
    write(join(scratch,'provider-mode'),'delay');const started=performance.now();
    const pending=api('/api/hermes/test','POST',{},true);
    await until(async()=>readFileSync(join(scratch,'upstream.jsonl'),'utf8').trim().split('\n').length>before,'slow provider dispatch');
    const health=await api('/api/health');assert.equal(health.status,200);
    const ping=await pending;assert.equal(ping.body.ok,false);assert.match(ping.body.detail,/took too long/i);
    assert(performance.now()-started<70000,'readiness must not hang after timeout');
    assert.equal(readFileSync(join(scratch,'upstream.jsonl'),'utf8').trim().split('\n').length,before+1);
    const overview=await call(mvBase,'/v1/operator/overview',{token:operator()});
    const states=overview.body.requests.filter(r=>r.projectId===descriptor.model.projectId).map(r=>({id:r.id,state:r.state}));
    receipt.timeoutLedger=states;write(join(scratch,'provider-mode'),'ok');
    return {refused:true,localHealth:health.status,elapsedMs:Math.round(performance.now()-started),providerCallsAdded:1,detail:ping.body.detail,ledgerStates:states};
  });
  await step('revoked-model-key-refuses-real-worker-without-extra-charge', async () => {
    const before = readFileSync(join(scratch, 'upstream.jsonl'), 'utf8').trim().split('\n').length;
    await mvPost(`/v1/operator/keys/${descriptor.model.keyId}/revoke`, {});
    const ping = await api('/api/hermes/test', 'POST', {}, true); assert.equal(ping.status, 200); assert.equal(ping.body.ok, false);
    assert.match(ping.body.detail, /access was withdrawn/i); assert.equal(readFileSync(join(scratch, 'upstream.jsonl'), 'utf8').trim().split('\n').length, before);
    return { refused: true, providerCallsAdded: 0, detail: ping.body.detail };
  });
  receipt.passed = true;
} catch (error) {
  receipt.failure = redact(error?.stack ?? error); process.exitCode = 1;
} finally {
  for (const child of processes.slice().reverse()) { await stop(child); writeFileSync(join(out, child.qaName + '.log'), child.qaLog, { mode: 0o600 }); }
  for (const server of servers) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  for (const file of ['upstream.jsonl', 'worker-diagnostics.jsonl']) if (existsSync(join(scratch, file))) writeFileSync(join(out, file), redact(readFileSync(join(scratch, file), 'utf8')), { mode: 0o600 });
  modelKey = undefined; clientKey = undefined; descriptor = undefined; websiteState = undefined; admin = undefined; session = undefined;
  rmSync(scratch, { recursive: true, force: true }); receipt.cleanup = processes.every(p => p.exitCode !== null || p.signalCode !== null); receipt.completedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ passed: receipt.passed, checks: checks.length, failure: receipt.failure?.split('\n')[0], cleanup: receipt.cleanup, receipt: join(out, 'receipt.json') }, null, 2));
}
