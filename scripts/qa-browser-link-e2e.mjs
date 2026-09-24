// Linking a computer through the browser, both sides at once, locally.
//
// The actual desktop server from source (server/bootstrap.ts) talks to the
// actual built Next website (website/scripts/testing/command-site.mjs) over
// loopback http, with a real disposable PostgreSQL behind the fixture
// PostgREST bridge. The desktop reaches the website through
// REALBUD_WEBSITE_ORIGIN, which server/office-link.ts accepts as a loopback
// http origin only with REALBUD_TEST_LAB=1 on a non-production build. The owner
// is played by fetch calls carrying a real signed-in session cookie, exactly as
// the approval page's button sends them.
//
//   node scripts/qa-browser-link-e2e.mjs [--out <dir>]
//
// Needs a current `website/.next` build (`cd website && npm run build`) and
// REALBUD_TEST_POSTGRES_BIN (default /opt/homebrew/opt/postgresql@16/bin).
// The receipt directory must not exist or must be empty: earlier evidence is
// never overwritten. No network beyond 127.0.0.1: a preload in the desktop
// process refuses and records any other fetch.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { serviceSmokeEnv } from './service-smoke-env.mjs';
import { startCommandSite } from '../website/scripts/testing/command-site.mjs';
import { isLinkRequestIssued, LINK_DISPLAY_CODE } from '../shared/installation-link.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const output = resolve(outIndex >= 0 ? args[outIndex + 1] : join(root, 'outputs/browser-link-e2e-2026-09-23'));
if (existsSync(output) && readdirSync(output).length) throw new Error(`Refusing to overwrite existing evidence in ${output}. Choose another --out.`);

// A stale website build would prove yesterday's routes, not today's.
const website = join(root, 'website');
const buildId = join(website, '.next/BUILD_ID');
if (!existsSync(buildId)) throw new Error('Build the website first: cd website && npm run build');
const builtAt = statSync(buildId).mtimeMs;
const newer = [];
const walk = dir => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
  if (['node_modules', '.next', '.git'].includes(entry.name)) continue;
  const path = join(dir, entry.name);
  if (entry.isDirectory()) walk(path); else if (/\.(tsx?|css|mjs)$/.test(entry.name) && statSync(path).mtimeMs > builtAt) newer.push(path);
} };
for (const dir of ['app', 'lib', 'components']) if (existsSync(join(website, dir))) walk(join(website, dir));
walk(join(root, 'shared'));
if (newer.length) throw new Error(`website/.next is older than ${newer.length} source file(s), e.g. ${newer[0]}. Run: cd website && npm run build`);

const wait = ms => new Promise(r => setTimeout(r, ms));
const temp = mkdtempSync(join(realpathSync(tmpdir()), 'rb-browser-link-e2e-'));
const checks = [], desktops = [];
const receipt = { at: new Date().toISOString(), ok: false,
  layer: 'Local HTTP: desktop server from source + actual built Next routes and pages + disposable PostgreSQL through the fixture PostgREST bridge, all on 127.0.0.1',
  limits: [
    'Not a deployed website, not https, not a packaged or installed desktop app; the loopback origin is accepted only with REALBUD_TEST_LAB=1.',
    'The owner approval is the same POST the approval page button sends, made with fetch and a real signed-in session cookie; no browser was rendered here (website/scripts/qa-installation-link.mjs renders the pages).',
    'The fixture PostgREST bridge replaces transport only; authority is the real SQL RPCs.',
    'Fictional companies, owners and computer names; no customer account, email delivery or live provider.',
    'The worker is a fake CLI that only answers --version, so workerReady in the report is a fixture value, not a Hermes readiness proof.',
    'Provisioning is recorded as observed on this fixture, not proven: see provisioning.',
  ],
  checks, provisioning: null, cleanup: false };

async function reservePort() { const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const port = s.address().port; await new Promise(r => s.close(r)); return port; }

/** One desktop: its own HOME and data directory, a fake worker CLI so nothing
 * installs or downloads, and a fetch guard that refuses any non-loopback host. */
async function startDesktop(name, websiteOrigin) {
  const home = join(temp, name), data = join(home, 'data');
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const denied = join(home, 'denied-fetches.json');
  writeFileSync(join(home, 'preload.mjs'), `import{appendFileSync}from'node:fs';const original=globalThis.fetch;globalThis.fetch=async(input,init)=>{const url=new URL(String(input instanceof Request?input.url:input));if(url.hostname!=='127.0.0.1'&&url.hostname!=='localhost'){appendFileSync(${JSON.stringify(denied)},JSON.stringify(url.origin)+'\\n');throw new Error('Test lab: non-loopback fetch refused');}return original(input,init);};`);
  writeFileSync(join(home, 'worker.mjs'), `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('Hermes Agent v0.21.3 (2026.9.14)');process.exit(0);}console.log('OK');`, { mode: 0o700 });
  const port = await reservePort(), base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', join(home, 'preload.mjs'), join(root, 'server/bootstrap.ts')], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...serviceSmokeEnv({ executable: process.execPath, home, data, scratch: home, port }),
      REALBUD_MANAGED_SERVICE: '0', REALBUD_TEST_LAB: '1', REALBUD_WEBSITE_ORIGIN: websiteOrigin,
      REALBUD_HERMES_CLI: join(home, 'worker.mjs'), OMB_STATIC_DIR: join(root, 'dist') },
  });
  const desktop = { name, home, data, denied, base, child, logs: '', closed: new Promise(r => child.once('close', r)) };
  for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { desktop.logs = (desktop.logs + b).slice(-40000); });
  desktops.push(desktop);
  let ready = false;
  for (let i = 0; i < 200 && child.exitCode === null; i++) {
    try { if ((await (await fetch(base + '/api/health', { signal: AbortSignal.timeout(400) })).json()).pid === child.pid) { ready = true; break; } } catch {}
    await wait(100);
  }
  assert.ok(ready, `${name} desktop did not start:\n${desktop.logs}`);
  desktop.session = (await (await fetch(base + '/api/session')).json()).token;
  desktop.api = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, { method, signal: AbortSignal.timeout(45000),
      headers: { 'content-type': 'application/json', 'x-realbud-session': desktop.session }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, text: await response.text(), get body() { return JSON.parse(this.text); } };
  };
  return desktop;
}
async function stopDesktop(desktop) {
  const { child } = desktop;
  if (child.exitCode !== null || child.signalCode) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  try { await desktop.closed; } finally { clearTimeout(timer); }
}
/** The saved desktop credential, read only to prove no response carries it. */
const savedToken = desktop => JSON.parse(readFileSync(join(desktop.data, 'office-link/link.json'), 'utf8')).token;
const savedId = desktop => JSON.parse(readFileSync(join(desktop.data, 'office-link/link.json'), 'utf8')).id;

let site;
try {
  site = await startCommandSite({ portalPeople: true });
  // Real sign-in: the fixture identity provider answers the OTP verify, and the
  // website's own callback issues the session cookie the approval page uses.
  const subjects = new Map();
  const signIn = async account => {
    const user = { id: subjects.get(account.email) ?? subjects.set(account.email, randomUUID()).get(account.email), email: account.email, aud: 'authenticated', role: 'authenticated',
      email_confirmed_at: new Date(Date.now() - 10_000).toISOString(), app_metadata: {}, user_metadata: {} };
    const callback = await fetch(`${site.origin}/auth/callback?token_hash=${site.otp(user)}&type=email`, { redirect: 'manual' });
    assert.equal(callback.status, 303);
    return callback.headers.getSetCookie().find(value => value.startsWith('rb_session=')).split(';')[0];
  };
  const owner = await signIn(site.accounts.a), reader = await signIn(site.accounts.reader), ownerB = await signIn(site.accounts.b);
  const web = async (path, cookie, method = 'GET', body) => {
    const response = await fetch(site.origin + path, { method, redirect: 'manual',
      headers: { 'content-type': 'application/json', origin: site.origin, ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: response.status, text, body: json };
  };
  const approve = (cookie, approvalId) => web('/api/account/installations/link-requests/approve', cookie, 'POST', { approvalId });
  checks.push('Website fixture: built Next on a disposable PostgreSQL; owner, reader and second-company owner signed in through the real /auth/callback.');

  // ---- 1. The desktop asks for an approval page. ----
  const front = await startDesktop('front-desk', site.origin);
  const started = await front.api('/api/office-link/browser-link', 'POST', { label: 'Fictional front desk' });
  assert.equal(started.status, 200, started.text);
  const pending = started.body;
  assert.equal(pending.state, 'pending');
  const { state: _state, ...issued } = pending;
  assert.ok(isLinkRequestIssued({ version: 1, purpose: 'installation-link-issued', ...issued }, site.origin), started.text);
  assert.ok(LINK_DISPLAY_CODE.test(pending.displayCode));
  const frontToken = savedToken(front), frontId = savedId(front);
  assert.ok(!started.text.includes(frontToken), 'browser-link reply carried the token');
  assert.equal((await front.api('/api/office-link/browser-link')).body.state, 'pending');
  const approvalId = new URL(pending.approvalUrl).pathname.slice('/link/'.length);
  checks.push('Desktop POST /api/office-link/browser-link returns pending with an approval URL on the website fixture origin (passes the shared isLinkRequestIssued contract) and a display code; the reply carries no token; a poll before approval stays pending.');

  // ---- 2. Only a signed-in owner can approve, from the website's own origin. ----
  assert.equal((await approve(reader, approvalId)).status, 403);
  assert.equal((await approve(null, approvalId)).status, 401);
  const foreign = await fetch(site.origin + '/api/account/installations/link-requests/approve', { method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://untrusted.example', cookie: owner }, body: JSON.stringify({ approvalId }) });
  assert.equal(foreign.status, 403);
  assert.equal((await front.api('/api/office-link/browser-link')).body.state, 'pending');
  checks.push('Approve is refused for the reader (403), with no session (401) and from a foreign Origin (403); the desktop still reads pending after each.');

  const approved = await approve(owner, approvalId);
  assert.deepEqual({ status: approved.status, body: approved.body }, { status: 200, body: { state: 'linked' } });
  assert.ok(!approved.text.includes(frontId) && !approved.text.includes(frontToken), 'approve reply carried installation identifiers');
  checks.push('Owner A approves with the same POST the approval page sends (same Origin, signed-in session, body {approvalId} only): 200 {state:"linked"}, with no installation id or credential in the browser reply.');

  // ---- 3. The desktop notices within its bounded poll. ----
  let view, polls = 0;
  const deadline = Date.now() + 30_000;
  for (;;) {
    polls++;
    const response = await front.api('/api/office-link/browser-link');
    assert.equal(response.status, 200, response.text);
    view = response.body;
    if (view.state === 'linked' || Date.now() > deadline) break;
    await wait(500);
  }
  assert.deepEqual(view, { state: 'linked', agencyLabel: site.accounts.a.label });
  let status;
  for (let i = 0; i < 60; i++) {
    const response = await front.api('/api/office-link');
    assert.ok(!response.text.includes(frontToken), 'GET /api/office-link carried the token');
    status = response.body;
    if (status.lastReportedAt || status.error) break;
    await wait(500);
  }
  assert.equal(status.state, 'linked');
  assert.equal(status.agencyLabel, site.accounts.a.label);
  assert.equal(status.id, frontId);
  assert.equal(status.browser, undefined);
  checks.push(`Desktop GET /api/office-link/browser-link turns linked with "${site.accounts.a.label}" after ${polls} poll(s); GET /api/office-link reads linked for that office with no pending browser request, and neither response ever contains the token.`);

  // ---- 4. The website shows this computer to company A only. ----
  const listA = await web('/api/account/installations', owner);
  assert.equal(listA.status, 200, listA.text);
  const row = listA.body.installations.find(r => r.id === frontId);
  assert.ok(row, listA.text);
  assert.equal(row.label, 'Fictional front desk');
  assert.equal(row.revoked_at, null);
  const listB = await web('/api/account/installations', ownerB);
  assert.equal(listB.status, 200, listB.text);
  assert.equal(listB.body.installations.some(r => r.id === frontId || r.label === 'Fictional front desk'), false);
  for (const list of [listA.text, listB.text]) assert.ok(!list.includes(frontToken));
  const linkedPage = await web(`/link/${approvalId}`, owner);
  assert.equal(linkedPage.status, 200); assert.match(linkedPage.text, /Computer linked/);
  checks.push('Website GET /api/account/installations for company A lists "Fictional front desk" under the desktop\'s own installation id; company B\'s list does not; the approval page for owner A now renders "Computer linked".');

  // ---- 5. Provisioning, as observed. ----
  const dbRow = JSON.parse(await site.sql(`select to_jsonb(x) from (select provisioned_at, model_key_id is not null as has_model_key, last_seen_at is not null as reported, worker_ready from office_installations where id = '${frontId}') x`));
  receipt.provisioning = {
    desktop: { provisioned: status.provisioned ?? null, lastReported: Boolean(status.lastReportedAt), error: status.error ?? null, serviceWithdrawn: status.serviceWithdrawn ?? false },
    website: { provisionedAt: dbRow.provisioned_at, modelKeyRecorded: dbRow.has_model_key, reportRecorded: dbRow.reported, workerReady: dbRow.worker_ready },
    reading: 'Skipped by the website, not by the desktop: the fixture sets REALBUD_GATEWAY_URL to its plain-http bridge and no portal secret, so gatewayProvisioningClient() returns null and the report reply carries no provisioning. The desktop therefore reads linked with provisioned=false. No model access was granted or faked.',
  };
  assert.equal(status.provisioned, false);
  assert.equal(dbRow.provisioned_at, null);
  checks.push(`Provisioning as observed: the first report ${status.lastReportedAt ? 'reached the website' : 'did not settle'}${status.error ? ` (desktop error: ${status.error})` : ''}; website provisioned_at is null and the desktop reads provisioned=false, because the fixture has no https gateway. Recorded as skipped, not as success.`);

  // ---- 6. Cancel: a second computer starts a request and abandons it. ----
  const back = await startDesktop('back-office', site.origin);
  const second = await back.api('/api/office-link/browser-link', 'POST', { label: 'Fictional back office' });
  assert.equal(second.status, 200, second.text);
  const secondId = savedId(back), secondApproval = new URL(second.body.approvalUrl).pathname.slice('/link/'.length);
  const cancelled = await back.api('/api/office-link/browser-link', 'DELETE');
  assert.equal(cancelled.status, 200, cancelled.text);
  assert.deepEqual(cancelled.body, { state: 'none' });
  assert.equal(existsSync(join(back.data, 'office-link/link.json')), false);
  assert.equal((await back.api('/api/office-link')).body.state, 'unlinked');
  assert.equal(await site.sql(`select state from office_link_requests where installation_id = '${secondId}'`), 'declined');
  const declinedPage = await web(`/link/${secondApproval}`, owner);
  assert.equal(declinedPage.status, 200); assert.match(declinedPage.text, /Request declined/);
  const late = await approve(owner, secondApproval);
  assert.equal(late.status, 409, late.text);
  assert.equal(await site.sql(`select count(*) from office_installations where id = '${secondId}'`), '0');
  assert.equal((await web('/api/account/installations', owner)).body.installations.some(r => r.id === secondId), false);
  checks.push('Cancel: a second desktop (own data dir and server) starts a request, then DELETE /api/office-link/browser-link answers {state:"none"}, removes its saved request and reads unlinked; the website row is declined, the approval page renders "Request declined", a late owner approve is refused 409 and no installation exists for it.');

  // ---- 7. Nothing left the loopback. ----
  for (const desktop of desktops) assert.equal(existsSync(desktop.denied), false, `${desktop.name} tried a non-loopback fetch: ${existsSync(desktop.denied) ? readFileSync(desktop.denied, 'utf8') : ''}`);
  const stats = site.stats();
  assert.deepEqual(stats.violations, []);
  receipt.site = { rpcCount: stats.rpcCount, bridgeViolations: stats.violations, databaseErrors: stats.databaseErrors, authRejections: stats.authRejections.length };
  checks.push('Neither desktop attempted a non-loopback fetch, and the website fixture bridge saw no unlisted route.');
  receipt.ok = true;
} catch (error) {
  receipt.error = String(error?.stack ?? error).slice(0, 4000);
  receipt.logs = { desktops: Object.fromEntries(desktops.map(d => [d.name, d.logs.slice(-6000)])), website: site?.logs?.().slice(-4000) ?? null };
  process.exitCode = 1;
} finally {
  for (const desktop of desktops) await stopDesktop(desktop).catch(() => {});
  await site?.stop().catch(() => {});
  rmSync(temp, { recursive: true, force: true });
  receipt.cleanup = desktops.every(d => d.child.exitCode !== null || d.child.signalCode) && !existsSync(temp);
  // The receipt names no token, approval id or approval URL.
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ ok: receipt.ok, output, checks: checks.length, provisioning: receipt.provisioning, error: receipt.error?.split('\n')[0] }, null, 2));
}
