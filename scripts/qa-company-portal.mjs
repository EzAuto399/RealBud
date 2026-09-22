// Actual application/UI + built Next + two disposable PostgreSQL authorities.
// Only the fixed website origin is redirected to the fixture; no real accounts.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createCompanyInstallation } from '../server/company-installation.ts';
import { serviceSmokeEnv } from './service-smoke-env.mjs';
import { startCommandSite } from '../website/scripts/testing/command-site.mjs';
import { Pool } from 'pg';
import { parseCompanyPairing } from '../server/company/host-certificate.ts';
import { requestCompanyHost } from '../server/company/host-transport.ts';

if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = process.cwd(), output = resolve(process.env.QA_OUTPUT ?? 'outputs/company-portal-2026-09-22/gui-source');
const resources = process.env.REALBUD_QA_RESOURCES ? resolve(process.env.REALBUD_QA_RESOURCES) : null;
mkdirSync(output, { recursive: true });
// Slice 3 portal UX evidence: portal renders at phone, tablet and desktop widths.
const uxOutput = resolve(process.env.PORTAL_UX_OUTPUT ?? join(root, 'outputs/portal-ux-2026-09-22/slice3/company-portal'));
const uxWidths = [360, 768, 1280], uxLayout = [];
mkdirSync(uxOutput, { recursive: true });
const temp = mkdtempSync(join(realpathSync(tmpdir()), 'rb-company-portal-')), data = join(temp, 'data'); mkdirSync(data);
const key = randomBytes(32), bin = realpathSync(process.env.REALBUD_TEST_POSTGRES_BIN ?? '/opt/homebrew/opt/postgresql@16/bin');
const checks = [], errors = [], mutations = []; const wire = join(temp, 'wire.jsonl'), drop = join(temp, 'drop-redeem');
let setup, site, browser, child, closed, base, token, logs = '', ownerToken, ownerId;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await closed; } finally { clearTimeout(timer); }
}
async function start() {
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--import', join(temp, 'website-preload.mjs'), resources ? join(resources, 'server/bootstrap.js') : join(root, 'server/bootstrap.ts')], { cwd: resources ?? root,
    env: { ...serviceSmokeEnv({ executable: process.execPath, home: temp, data, scratch: temp, port }),
      REALBUD_MANAGED_SERVICE: '0', REALBUD_TEST_LAB: '1', REALBUD_DESK_KEY: key.toString('hex'),
      REALBUD_COMPANY_POSTGRES_BIN: bin, OMB_STATIC_DIR: resources ? join(resources, 'ui') : join(root, 'dist') }, stdio: ['ignore', 'pipe', 'pipe'] });
  closed = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', part => { logs = (logs + part).slice(-60000); });
  let healthy = false;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null || child.signalCode) break;
    try { healthy = (await (await fetch(base + '/api/health', { signal: AbortSignal.timeout(300) })).json()).pid === child.pid; } catch { /* starting */ }
    if (healthy) break; await wait(100);
  }
  assert(healthy, logs); token = (await (await fetch(base + '/api/session')).json()).token;
}
async function app(path, body, expected = 200) {
  const response = await fetch(base + '/api/company/' + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-realbud-session': token, 'x-realbud-member-session': ownerToken },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
}
const pass = value => { checks.push(value); console.log('PASS ' + value); };
try {
  site = await startCommandSite({ companyPortal: true });
  writeFileSync(join(temp, 'website-preload.mjs'), `import{existsSync,unlinkSync,appendFileSync}from'node:fs';import{createHash}from'node:crypto';const original=globalThis.fetch;globalThis.fetch=async(input,init)=>{const url=String(input);if(url.startsWith('https://realbud.app/')){const result=await original(${JSON.stringify(site.origin)}+url.slice('https://realbud.app'.length),init);const path=new URL(url).pathname;appendFileSync(${JSON.stringify(wire)},JSON.stringify({path,ok:result.ok,bodyDigest:createHash('sha256').update(String(init?.body??'')).digest('hex')})+'\\n');if(path==='/api/company-portal/redeem'&&result.ok&&existsSync(${JSON.stringify(drop)})){unlinkSync(${JSON.stringify(drop)});throw new TypeError('Fictional lost committed proof reply');}Object.defineProperty(result,'url',{value:url});return result;}if(new URL(url).hostname!=='127.0.0.1')throw new Error('Fixture external transport denied');return original(input,init);};`, { mode: 0o600 });
  writeFileSync(join(data, 'config.json'), JSON.stringify({ profile: { name: 'Practice owner' }, instances: { fixture: { driver: 'not-a-real-driver' } } }), { mode: 0o600 });
  setup = createCompanyInstallation({ dataDirectory: data, binaryDirectory: bin, previewEnabled: true, privateStateKey: key,
    hasAdminSession: () => true, authorizeAdmin: () => ({ ok: true, expiresAt: Date.now() + 60_000 }) });
  const prepare = (path, body, member = '') => setup.handle('/api/company/' + path, body === undefined ? 'GET' : 'POST', { headers: { 'x-realbud-member-session': member } }, body);
  assert.equal((await prepare('setup', {})).status, 200);
  const created = await prepare('create', { name: 'Fictional Acacia Agency', ownerName: 'Practice owner', credential: { loginName: 'practice.owner', password: 'Fictional-company-password-2026' } });
  assert.equal(created.status, 201); ownerToken = created.body.memberToken; ownerId = created.body.member.id;
  assert.equal((await prepare('network', { hostname: '127.0.0.1' }, ownerToken)).status, 200);
  await setup.close(); setup = undefined; await start();
  assert.equal((await app('me')).member.id, ownerId);
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.addInitScript(value => { localStorage.setItem('realbud.first-run-done', '1'); sessionStorage.setItem('realbud.company-member-session', value); }, ownerToken);
  let page = await context.newPage();
  const observe = p => { p.on('pageerror', e => errors.push(e.message)); p.on('request', request => {
    if (request.url().includes('/api/company/portal-bindings/') && request.method() === 'POST') {
      const body = request.postDataJSON(); mutations.push({ path: new URL(request.url()).pathname, requestId: body.requestId ?? null,
        bodyDigest: createHash('sha256').update(request.postData()).digest('hex') });
    }
  }); };
  observe(page);
  const open = async () => {
    await page.goto(base + '/#/you');
    const office = page.locator('details').filter({ has: page.getByText('This office', { exact: true }) }).first();
    await office.waitFor(); await office.evaluate(node => { node.open = true; });
    const summary = page.locator('summary').filter({ hasText: /^Company member website identity$/ }); await summary.waitFor();
    await summary.evaluate(node => { node.parentElement.open = true; });
  };
  const card = () => page.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^Company member website identity$/ }) }).last();
  await open(); await card().getByLabel('Active member', { exact: true }).selectOption(ownerId);
  await card().getByRole('button', { name: 'Create member mapping', exact: true }).click();
  const mapCode = await card().getByLabel('Member mapping code', { exact: true }).inputValue();
  const original = (await app('portal-bindings/list', { offset: 0, limit: 20 })).bindings[0];
  assert.equal(original.phase, 'pending'); assert.equal(original.memberId, ownerId);
  await card().scrollIntoViewIfNeeded(); await page.screenshot({ path: join(output, 'desktop-mapping-pending.png') });
  pass('Actual owned office database, current network certificate and authenticated owner create a durable member-specific challenge through the desktop UI.');

  const login = async email => {
    const hash = site.otp({ id: randomUUID(), email, aud: 'authenticated', role: 'authenticated', email_confirmed_at: new Date(Date.now()-10_000).toISOString(), app_metadata: {}, user_metadata: {} });
    const response = await fetch(site.origin + '/auth/callback?token_hash=' + hash + '&type=email', { redirect: 'manual' });
    assert.equal(new URL(response.headers.get('location')).pathname, '/account'); return response.headers.getSetCookie().find(value => value.startsWith('rb_session=')).split(';')[0];
  };
  const cookie = await login(site.accounts.a.email);
  const portalContext = await browser.newContext({ viewport: { width: 1100, height: 950 } });
  await portalContext.addCookies([{ name: 'rb_session', value: cookie.slice('rb_session='.length), url: site.origin, httpOnly: true, sameSite: 'Lax' }]);
  const portal = await portalContext.newPage(); portal.on('pageerror', e => errors.push(e.message));
  // Selectors below exercise the actual attended portal screen, including exact retries.
  const issueThroughUi = async (code, loseReply = false) => {
    await portal.goto(site.origin + '/account/company-portal');
    await portal.getByLabel('Code from the RealBud company settings', { exact: true }).fill(code);
    await portal.getByRole('button', { name: 'Inspect mapping details', exact: true }).click();
    await portal.getByRole('checkbox').check();
    if (loseReply) site.loseNextRpcReply('realbud_company_portal_issue');
    await portal.getByRole('button', { name: /^(Issue my member identity proof|Issue separate confirmation proof)$/ }).click();
    if (loseReply) { await portal.getByRole('alert').waitFor(); await portal.getByRole('button', { name: 'Retry saved proof request', exact: true }).click(); }
    await portal.locator('#company-identity-proof').waitFor();
    return portal.locator('#company-identity-proof').inputValue();
  };
  const identityProof = await issueThroughUi(mapCode, true);
  let lost = false;
  await page.route('**/api/company/portal-bindings/accept', async route => {
    const result = await route.fetch();
    if (!lost) { lost = true; assert.equal(result.status(), 200); await route.abort('failed'); } else await route.fulfill({ response: result });
  });
  await card().getByLabel('Member identity proof', { exact: true }).fill(identityProof);
  await card().getByRole('button', { name: 'Record my verified website identity', exact: true }).click();
  await card().getByRole('button', { name: 'Retry saved mapping request', exact: true }).waitFor();
  await card().getByRole('button', { name: 'Retry saved mapping request', exact: true }).click();
  await card().getByLabel('Member confirmation code', { exact: true }).waitFor();
  const candidate = (await app('portal-bindings/list', { offset: 0, limit: 20 })).bindings[0];
  assert.equal(candidate.id, original.id); assert.equal(candidate.phase, 'candidate'); assert.equal(candidate.person.email, site.accounts.a.email);
  const accepts = mutations.filter(item => item.path.endsWith('/accept')); assert.equal(accepts.length, 2); assert.equal(accepts[0].bodyDigest, accepts[1].bodyDigest);
  pass('Fresh portal login issues a bounded proof through actual Next/PostgreSQL; lost issue and committed company acceptance replies recover exact saved requests and one candidate.');

  const confirmCode = await card().getByLabel('Member confirmation code', { exact: true }).inputValue();
  await page.close(); await stop(); await start(); page = await context.newPage(); observe(page); await open();
  assert.equal(await card().getByLabel('Member confirmation code', { exact: true }).inputValue(), confirmCode);
  const confirmationProof = await issueThroughUi(confirmCode);
  writeFileSync(drop, 'lose once', { mode: 0o600 });
  await card().getByLabel('Fresh member confirmation proof', { exact: true }).fill(confirmationProof);
  await card().getByRole('checkbox').check();
  await card().getByRole('button', { name: 'Confirm reviewed identity mapping', exact: true }).click();
  await card().getByRole('alert').waitFor(); await card().getByRole('button', { name: 'Retry saved mapping request', exact: true }).click();
  await card().getByText('Identity mapped', { exact: true }).waitFor();
  const confirmed = (await app('portal-bindings/list', { offset: 0, limit: 20 })).bindings[0];
  assert.equal(confirmed.id, original.id); assert.equal(confirmed.phase, 'confirmed'); assert.equal(confirmed.current, true);
  const pairing = parseCompanyPairing((await app('host-code')).hostCode);
  const sharedView = await requestCompanyHost({ ...pairing, path: '/api/company/portal-bindings/list', method: 'POST', memberToken: ownerToken, body: { offset: 0, limit: 20 } });
  assert.equal(sharedView.status, 200); assert.equal(sharedView.body.bindings[0].id, confirmed.id);
  const unauthed = await requestCompanyHost({ ...pairing, path: '/api/company/portal-bindings/list', method: 'POST', body: { offset: 0, limit: 20 } });
  assert.equal(unauthed.status, 401);
  const confirms = mutations.filter(item => item.path.endsWith('/confirm')); assert.equal(confirms.length, 2); assert.equal(confirms[0].bodyDigest, confirms[1].bodyDigest);
  pass('Cold desktop restart retains the same candidate and challenge. Lost committed website redemption retries the original nonce and receipt, then owner confirmation commits once. Actual pinned TLS exposes the same record only with a valid member session.');

  await card().scrollIntoViewIfNeeded(); await page.screenshot({ path: join(output, 'desktop-mapping-confirmed.png') });
  await page.setViewportSize({ width: 390, height: 844 }); await card().scrollIntoViewIfNeeded();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); await page.screenshot({ path: join(output, 'desktop-mapping-mobile.png') });
  await portal.setViewportSize({ width: 390, height: 844 });
  assert(await portal.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await portal.screenshot({ path: join(output, 'portal-mapping-mobile.png'), fullPage: true, mask: [portal.locator('#company-identity-proof')] });
  pass('Desktop and portal mapping screens render at desktop/mobile widths without horizontal overflow; proof codes are masked in captured evidence.');
  for (const width of uxWidths) {
    await portal.setViewportSize({ width, height: width === 360 ? 780 : 1000 });
    const measured = await portal.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
      wide: [...document.querySelectorAll('main *')].filter(el => el.getBoundingClientRect().right > innerWidth + 1)
        .map(el => ({ tag: el.tagName, class: String(el.className) })).slice(0, 10) }));
    uxLayout.push({ path: '/account/company-portal', width, ...measured });
    assert.ok(measured.scroll <= measured.width + 1, `/account/company-portal at ${width}px scrolls to ${measured.scroll}`);
    await portal.screenshot({ path: join(uxOutput, `company-portal-${width}.png`), fullPage: true, mask: [portal.locator('#company-identity-proof')] });
  }
  writeFileSync(join(uxOutput, 'layout.json'), JSON.stringify(uxLayout, null, 2));
  pass('The confirmed company-portal mapping screen renders at 360, 768 and 1280 with no horizontal overflow; proof codes stay masked. This screen has no ConfirmDialog: issuing a proof and reviewing a disconnect are plain button actions, not a modal, so there is no confirm-dialog keyboard contract to exercise here.');
  await card().getByRole('button', { name: 'Review disconnect', exact: true }).click();
  await card().getByRole('button', { name: 'Disconnect identity mapping', exact: true }).click();
  await card().getByText('Mapping disconnected', { exact: true }).waitFor();
  assert.equal((await app('portal-bindings/list', { offset: 0, limit: 20 })).bindings[0].current, false);
  const replay = { version: 1, bindingId: original.id, requestId: randomUUID(), expectedRevision: confirmed.revision, proofHandle: confirmationProof };
  await app('portal-bindings/confirm', replay, 409);
  await page.close(); await stop(); await start();
  const retained = (await app('portal-bindings/list', { offset: 0, limit: 20 })).bindings[0]; assert.equal(retained.phase, 'revoked'); assert.equal(retained.current, false);
  const runResponse = await fetch(base + '/api/job-runs', { headers: { 'x-realbud-session': token } });
  assert.equal(runResponse.status, 200); const executorRuns = (await runResponse.json()).runs.length; assert.equal(executorRuns, 0);
  const hostSettings = JSON.parse(readFileSync(join(data, 'company-installation/host.json'), 'utf8'));
  const company = new Pool({ host: '127.0.0.1', port: hostSettings.databasePort, database: 'realbud_company', user: 'realbud_admin',
    password: readFileSync(join(data, 'company-installation/postgres/credentials/admin'), 'utf8').trim(), max: 1 });
  let caseClaims;
  try { caseClaims = (await company.query('SELECT count(*)::int AS n FROM realbud_company.claim_receipts')).rows[0].n; assert.equal(caseClaims, 0); }
  finally { await company.end(); }
  pass('Explicit disconnect is terminal and survives another restart; stale proof submission cannot revive the mapping. No case claim, mailbox read or worker is started.');
  const proofs = JSON.parse(await site.sql(`select coalesce(jsonb_agg(jsonb_build_object('requestId',request_id,'redeemed',redemption_id is not null,'hasRawHandle',to_jsonb(p)::text like '%proofHandle%')),'[]'::jsonb) from company_portal_proofs p`));
  assert.equal(proofs.length, 2); assert(proofs.every(item => item.redeemed && !item.hasRawHandle));
  assert.deepEqual(errors, []); assert.deepEqual(site.stats().violations, []); assert.deepEqual(site.stats().authRejections, []);
  const requests = existsSync(wire) ? readFileSync(wire, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ ok: true, at: new Date().toISOString(), layer: `${resources ? 'Isolated compiled' : 'Source'} desktop HTTP/rendered UI, owned company PostgreSQL, built Next and separate website PostgreSQL; fictional identities only`, checks, errors, mutations, requests, caseClaims, executorRuns, site: site.stats(), limits: ['Identity mapping only; no department executor admission', 'No deployment, native installer or live customer proof'] }, null, 2));
} catch (error) { writeFileSync(join(output, 'failure.log'), logs + '\n' + (site?.logs() ?? '') + '\n' + String(error)); throw error; }
finally { await browser?.close(); await stop(); await setup?.close(); await site?.stop(); rmSync(temp, { recursive: true, force: true }); writeFileSync(join(output, 'cleanup.json'), JSON.stringify({ complete: true })); }
