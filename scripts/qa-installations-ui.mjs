// Browser receipt for the account Computers page (portal UX slice 2).
//
// Real built Next, real disposable PostgreSQL with the actual installation
// migrations, and a local REST bridge that replaces the PostgREST transport
// only: every row below is created by the real RPCs (issue, redeem, report,
// record provisioning) and both revokes go through the real DELETE route. No
// deployed service, no customer credential, no stubbed RPC.
//
// Build the website (`npm run build`) first; the desktop half additionally
// needs `dist/` and is recorded as skipped when it is absent.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to the installed playwright module.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const website = join(root, 'website');
const output = join(root, 'outputs/portal-ux-2026-09-22/slice2'); mkdirSync(output, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), 'rb-installations-ui-'));
const exec = promisify(execFile);
const bin = process.env.REALBUD_TEST_POSTGRES_BIN ?? '/opt/homebrew/opt/postgresql@16/bin';
const run = (cmd, args) => exec(join(bin, cmd), args, { maxBuffer: 1024 * 1024 });
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const serviceKey = randomBytes(32).toString('hex');
const authSecret = randomBytes(32).toString('hex');
const office = 'fixture-office', owner = 'owner@example.test', reader = 'reader@example.test';
const otherOffice = 'fixture-office-b', otherOwner = 'owner-b@example.test';
// Every column a browser may see. A token or credential column here would be a
// bug in the route, so the bridge refuses anything outside this list.
const listable = new Set(['id', 'label', 'platform', 'app_version', 'worker_version', 'worker_ready', 'linked_at', 'last_seen_at', 'revoked_at', 'provisioned_at', 'revocation_pending_at', 'apps']);
const rpcArgs = {
  realbud_issue_pairing: ['p_company', 'p_actor', 'p_code_hash'],
  realbud_revoke_installation: ['p_company', 'p_actor', 'p_id'],
  realbud_clear_revocation_pending: ['p_company', 'p_actor', 'p_id'],
  realbud_account_commands: ['p_company', 'p_actor', 'p_cursor'],
};
const children = []; const checks = []; const limits = [];
let browser, bridge, logs = '', started = false, selects = [], failList = false, desktop = 'skipped: no built dist/';
const sql = async text => (await run('psql', ['-h', temp, '-d', 'postgres', '-XAt', '-v', 'ON_ERROR_STOP=1', '-c', text])).stdout.trim();
const rpc = text => sql(`set role service_role; select to_jsonb(${text})`).then(value => JSON.parse(value.replace(/^SET\n/, '')));
async function port() { const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function ready(url, headers) { for (let i = 0; i < 150; i++) { try { if ((await fetch(url, { headers })).ok) return; } catch { } await new Promise(r => setTimeout(r, 200)); } throw new Error('Server startup failed: ' + logs.slice(-2000)); }
function start(args, cwd, env) { const child = spawn(process.execPath, args, { cwd, env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child); child.stdout.on('data', b => { logs += b; }); child.stderr.on('data', b => { logs += b; }); return child; }
const hex = () => randomBytes(32).toString('hex');
/** One computer, created exactly the way a real desktop creates one. */
async function pairComputer({ label, platform = 'darwin', app = '0.1.19', worker = 'Hermes Agent v0.21.3 (2026.9.14)', ready: workerReady = true, report = true, provision = false, apps = ['gmail'], company = office, actor = owner }) {
  const code = hex(), token = hex(), id = randomUUID();
  await rpc(`realbud_issue_pairing(${quote(company)},${quote(actor)},${quote(code)})`);
  await rpc(`realbud_redeem_installation(${quote(code)},${quote(id)},${quote(token)},${quote(label)},${quote(platform)},${quote(app)})`);
  if (provision) await rpc(`realbud_record_provisioning(${quote(id)},'host-${id.slice(0, 8)}','proj-${id.slice(0, 8)}','key-${id.slice(0, 8)}',array[${apps.map(quote).join(',')}])`);
  if (report) await rpc(`realbud_report_installation(${quote(token)},${quote(app)},${worker === null ? 'null' : quote(worker)},${workerReady})`);
  return { id, token, label };
}
const badgeOf = (page, label) => page.locator('.installation-card').filter({ hasText: label }).locator('.badge');
const cardButton = (page, label) => page.locator('.installation-card').filter({ hasText: label }).getByRole('button', { name: 'Disconnect this computer', exact: true });
async function shoot(page, name, width, height = 900) { await page.setViewportSize({ width, height }); await page.waitForTimeout(250); await page.screenshot({ path: join(output, `${name}.png`), fullPage: true }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name} overflows at ${width}`); }

try {
  // 1. Disposable PostgreSQL with the real portal migrations.
  await run('initdb', ['-D', join(temp, 'data'), '--auth=trust', '--no-locale', '--encoding=UTF8']);
  await run('pg_ctl', ['-D', join(temp, 'data'), '-l', join(temp, 'log'), '-o', `-k ${temp} -c listen_addresses=''`, '-w', 'start']); started = true;
  await sql(`create role anon; create role authenticated; create role service_role bypassrls;
    create table billing_accounts(clerk_user_id text primary key, company_id text not null, email text not null, agency_label text not null, role text not null, disabled_at bigint, created_at bigint not null default 0);
    grant select on billing_accounts to service_role;
    insert into billing_accounts(clerk_user_id,company_id,email,agency_label,role,disabled_at) values
      (${quote(owner)},${quote(office)},${quote(owner)},'Example Office · QA fixture','billing_owner',null),
      (${quote(reader)},${quote(office)},${quote(reader)},'Example Office · QA fixture','billing_reader',null),
      (${quote(otherOwner)},${quote(otherOffice)},${quote(otherOwner)},'Second Office · QA fixture','billing_owner',null);`);
  for (const file of ['202609200001_installations.sql', '202609220001_installation_commands.sql', '202609220006_installation_provisioning.sql', '202609220007_report_provisioning_scope.sql']) {
    await sql(await readFile(join(website, 'supabase/migrations', file), 'utf8'));
  }

  // 2. PostgREST transport only. Authority stays in the SQL functions.
  bridge = createServer(async (req, res) => {
    const send = (status, body) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
    try {
      if (req.headers.apikey !== serviceKey || req.headers.authorization !== `Bearer ${serviceKey}`) return send(401, { message: 'fixture_auth_required' });
      const url = new URL(req.url, 'http://127.0.0.1');
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const name = url.pathname.replace('/rest/v1/rpc/', '');
      let value;
      if (req.method === 'GET' && url.pathname === '/rest/v1/billing_accounts') {
        const email = url.searchParams.get('email');
        if (!email?.startsWith('eq.')) return send(400, { message: 'fixture_filter' });
        value = JSON.parse(await sql(`select coalesce(jsonb_agg(x),'[]'::jsonb) from (select clerk_user_id,company_id,email,agency_label,role,disabled_at from billing_accounts where email=${quote(email.slice(3))}) x`));
      } else if (req.method === 'GET' && url.pathname === '/rest/v1/office_installations') {
        if (failList) { failList = false; return send(500, { message: 'fixture_list_unavailable' }); }
        const company = url.searchParams.get('company_id');
        if (!company?.startsWith('eq.')) return send(400, { message: 'fixture_filter' });
        const columns = (url.searchParams.get('select') ?? '').split(',').map(c => c.trim()).filter(Boolean);
        if (!columns.length || columns.some(c => !listable.has(c))) return send(400, { message: 'fixture_column_denied' });
        selects.push(columns);
        value = JSON.parse(await sql(`select coalesce(jsonb_agg(x),'[]'::jsonb) from (select ${columns.join(',')} from office_installations where company_id=${quote(company.slice(3))} order by linked_at desc limit 200) x`));
      } else if (req.method === 'POST' && Object.hasOwn(rpcArgs, name) && url.pathname === `/rest/v1/rpc/${name}`) {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const keys = rpcArgs[name];
        if (Object.keys(body).length !== keys.length || keys.some(k => !Object.hasOwn(body, k))) return send(400, { message: 'fixture_rpc_shape' });
        const args = keys.map(k => { const v = body[k]; return v === null ? 'null' : typeof v === 'object' ? `${quote(JSON.stringify(v))}::jsonb` : typeof v === 'number' || typeof v === 'boolean' ? String(v) : quote(v); });
        value = JSON.parse((await sql(`set role service_role; select to_jsonb(${name}(${args.join(',')}))`)).replace(/^SET\n/, ''));
      } else return send(404, { message: 'fixture_route_denied' });
      return send(200, value);
    } catch (error) {
      const message = error?.stderr?.match(/ERROR:\s+(\w+)/)?.[1];
      return send(400, { message: message ?? 'fixture_database_error', code: 'P0001', details: null, hint: null });
    }
  });
  bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening');
  const backend = `http://127.0.0.1:${bridge.address().port}`;
  const sitePort = await port(); const site = `http://127.0.0.1:${sitePort}`;
  start([join(website, 'node_modules/next/dist/bin/next'), 'start', '-p', String(sitePort), '-H', '127.0.0.1'], website,
    { HOME: temp, NODE_ENV: 'production', REALBUD_AUTH_SECRET: authSecret, SUPABASE_URL: backend, SUPABASE_SERVICE_ROLE_KEY: serviceKey, REALBUD_SITE_ORIGIN: site, REALBUD_EXTRA_ORIGINS: site, REALBUD_GATEWAY_URL: backend, NEXT_TELEMETRY_DISABLED: '1' });
  await ready(site + '/');
  process.env.REALBUD_AUTH_SECRET = authSecret;
  const { mintSession } = await import(website + '/lib/session.ts');
  const cookieFor = async email => ({ name: 'rb_session', value: await mintSession(email), url: site, httpOnly: true, sameSite: 'Lax' });
  const headersFor = async email => ({ origin: site, 'content-type': 'application/json', cookie: `rb_session=${await mintSession(email)}` });

  // 3. Seven rows, oldest first, each reached the way the product reaches it.
  const retired = await pairComputer({ label: 'Retired Mac', provision: true });
  const old = await pairComputer({ label: 'Old laptop', platform: 'win32', report: false });
  await pairComputer({ label: 'New arrival', platform: 'linux', report: false });
  await pairComputer({ label: 'Front desk Mac', worker: null, ready: false });
  const stale = await pairComputer({ label: 'Back office PC', platform: 'win32', provision: true });
  await sql(`update office_installations set last_seen_at = now() - interval '2 hours' where id=${quote(stale.id)}`);
  await pairComputer({ label: 'Property team laptop', platform: 'win32', provision: true, ready: false, worker: 'Hermes Agent v0.21.2' });
  await pairComputer({ label: 'Reception Mac', provision: true, apps: ['gmail', 'google_drive'] });
  // The gateway is not configured here, so the portal revoke stands and the row
  // keeps its owed cleanup: exactly the "Revocation pending" the spec names.
  const revoke = await fetch(site + '/api/account/installations', { method: 'DELETE', headers: await headersFor(owner), body: JSON.stringify({ id: retired.id }) });
  assert.equal(revoke.status, 200);
  assert.equal(await sql(`select revocation_pending_at is not null from office_installations where id=${quote(retired.id)}`), 't');

  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  await context.addCookies([await cookieFor(owner)]);
  const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(site + '/account/installations');
  await page.getByRole('heading', { name: 'Reception Mac' }).waitFor();

  // 4. Six of the seven states are on screen now; the seventh arrives below.
  const expected = {
    'Reception Mac': 'Provisioned · Bud ready',
    'Property team laptop': 'Provisioned · Bud needs setup',
    'Back office PC': 'Last report is stale',
    'Front desk Mac': 'Provisioning pending',
    'New arrival': 'Waiting for first report',
    'Retired Mac': 'Revocation pending',
  };
  // The badge always carries a glyph and the words; the words are the meaning.
  for (const [label, badge] of Object.entries(expected)) {
    const text = (await badgeOf(page, label).innerText()).trim().split('\n');
    assert.match(text[0], /^[•✓!✕]$/, `${label} badge has a glyph`);
    assert.equal(text.at(-1).trim(), badge, label);
  }
  await page.getByText('The service is still being told; nothing runs on this computer meanwhile.', { exact: true }).waitFor();
  await page.getByText('Connected app types: gmail, google_drive', { exact: true }).waitFor();
  assert.ok(selects.at(-1).includes('provisioned_at') && selects.at(-1).includes('revocation_pending_at') && selects.at(-1).includes('apps'), 'route selects the provisioning columns');
  checks.push('six provisioning states render one badge each from the real columns, with connected app types');

  // 5. Pairing: countdown, copy confirmation, hide, then the ten-code limit.
  await page.getByRole('button', { name: 'Pair a new computer', exact: true }).click();
  await page.getByLabel('One-time pairing code').waitFor();
  assert.match(await page.getByLabel('One-time pairing code').inputValue(), /^rb1_[a-f0-9]{64}$/);
  const countdown = page.locator('.installation-pair .installation-note').first();
  const first = (await countdown.innerText()).match(/Expires in (\d{2}:\d{2})\./)?.[1];
  assert.ok(first, 'countdown reads mm:ss');
  assert.match(await page.locator('.installation-pair .sr-only[aria-live="polite"]').innerText(), /This code expires in about \d+ minutes\./);
  await page.waitForTimeout(1500);
  assert.notEqual((await countdown.innerText()).match(/Expires in (\d{2}:\d{2})\./)?.[1], first, 'countdown is live');
  await page.getByRole('button', { name: 'Copy code', exact: true }).click();
  await page.getByRole('button', { name: 'Copied', exact: true }).waitFor();
  await shoot(page, 'pairing-code-1280', 1280);
  await page.getByRole('button', { name: 'Copy code', exact: true }).waitFor({ timeout: 4000 });
  checks.push('pairing code shows a live mm:ss countdown, announces minutes only, confirms Copied for two seconds');
  for (let i = 0; i < 9; i++) await rpc(`realbud_issue_pairing(${quote(office)},${quote(owner)},${quote(hex())})`);
  await page.getByRole('button', { name: 'Pair a new computer', exact: true }).click();
  await page.getByText('This office already has ten live codes', { exact: true }).waitFor();
  await page.getByText(/Ten pairing codes are waiting to be used/).waitFor();
  assert.ok(!/\b[45]\d{2}\b/.test(await page.locator('.installations').innerText()), 'no HTTP status code on screen');
  await page.getByRole('button', { name: 'Hide code', exact: true }).click();
  checks.push('the ten live code limit is named in a notice with what to do, and no status code is shown');

  // 6. Revoke: Escape returns focus to the row, confirming disconnects it.
  await cardButton(page, 'New arrival').click();
  await page.getByRole('heading', { name: 'Disconnect New arrival?' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Cancel', exact: true }).evaluate(node => node === document.activeElement), true);
  await page.getByText('Records already on that computer are kept.', { exact: false }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('heading', { name: 'Disconnect New arrival?' }).waitFor({ state: 'detached' });
  assert.equal(await cardButton(page, 'New arrival').evaluate(node => node === document.activeElement), true, 'focus returns to the row control');
  await cardButton(page, 'Old laptop').click();
  await page.getByRole('button', { name: 'Disconnect Old laptop', exact: true }).click();
  await page.getByText('Old laptop is disconnected.', { exact: true }).waitFor();
  assert.equal((await badgeOf(page, 'Old laptop').innerText()).trim().split('\n').at(-1).trim(), 'Revoked');
  assert.equal(await sql(`select revocation_pending_at is null from office_installations where id=${quote(old.id)}`), 't');
  checks.push('the confirm dialog names the computer and the consequence, Escape returns focus to the row, confirming revokes through the real route');

  // 7. All seven states, at every width and in both themes.
  for (const width of [1280, 768, 360]) await shoot(page, `computers-${width}`, width);
  await page.emulateMedia({ colorScheme: 'dark' }); await shoot(page, 'computers-1280-dark', 1280);
  await page.emulateMedia({ colorScheme: 'light' });
  assert.equal(await page.locator('.badge').count(), 7);
  checks.push('seven states render together at 360, 768 and 1280, light and dark, with no horizontal overflow');

  // 8. Loading, error, empty and non-owner.
  const slow = await context.newPage();
  await slow.route('**/api/account/installations', async route => { await new Promise(r => setTimeout(r, 2500)); await route.continue(); });
  await slow.goto(site + '/account/installations', { waitUntil: 'commit' });
  await slow.locator('.skeleton[data-variant="card"]').first().waitFor();
  assert.equal(await slow.locator('.skeleton[data-variant="card"]').count(), 3);
  await shoot(slow, 'computers-loading-1280', 1280);
  await slow.close();
  failList = true;
  await page.reload();
  const alert = page.locator('.installations .notice[role="alert"]');
  await alert.waitFor();
  const alertText = await alert.innerText();
  assert.match(alertText, /Computer status could not be loaded/);
  assert.match(alertText, /status is unavailable/);
  assert.ok(!/\b[45]\d{2}\b/.test(alertText), 'the failure is named without a status code');
  await shoot(page, 'computers-error-1280', 1280);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('heading', { name: 'Reception Mac' }).waitFor();
  const empty = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await empty.addCookies([await cookieFor(otherOwner)]);
  const emptyPage = await empty.newPage();
  await emptyPage.goto(site + '/account/installations');
  await emptyPage.getByText('No computers yet', { exact: true }).waitFor();
  assert.equal(await emptyPage.getByRole('button', { name: 'Pair a new computer', exact: true }).count(), 1);
  await shoot(emptyPage, 'computers-empty-1280', 1280);
  const readerContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await readerContext.addCookies([await cookieFor(reader)]);
  const readerPage = await readerContext.newPage();
  await readerPage.goto(site + '/account/installations');
  await readerPage.getByText('Your account owner pairs computers', { exact: true }).waitFor();
  assert.equal(await readerPage.getByRole('button', { name: 'Disconnect this computer', exact: true }).count(), 0);
  assert.equal(await readerPage.getByRole('button', { name: 'Pair a new computer', exact: true }).count(), 0);
  await shoot(readerPage, 'computers-reader-1280', 1280);
  checks.push('loading shows three skeleton cards, a failed load shows an alert notice with Retry, an empty office and a reader each get their own notice');

  // 9. The gates the page depends on, unchanged.
  assert.equal((await fetch(site + '/api/account/installations', { method: 'POST', headers: { origin: 'https://untrusted.example', 'content-type': 'application/json', cookie: `rb_session=${await mintSession(owner)}` }, body: '{}' })).status, 403);
  assert.equal((await fetch(site + '/api/account/installations')).status, 401);
  assert.equal((await fetch(site + '/api/account/installations', { method: 'POST', headers: await headersFor(reader), body: '{}' })).status, 403);
  assert.equal((await fetch(site + '/api/account/installations', { method: 'DELETE', headers: await headersFor(reader), body: JSON.stringify({ id: old.id }) })).status, 403);
  const crossOffice = await fetch(site + '/api/account/installations', { headers: await headersFor(otherOwner) });
  assert.deepEqual((await crossOffice.json()).installations, []);
  assert.equal((await fetch(site + '/api/installations/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'bad' }) })).status, 400);
  assert.equal((await fetch(site + '/api/installations/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  checks.push('origin, session, owner-only and office isolation gates unchanged');

  // 10. The desktop side of the pairing sentence, when a build is present.
  if (existsSync(join(root, 'dist/index.html'))) {
    const data = join(temp, 'app-data'); mkdirSync(data);
    writeFileSync(join(data, 'config.json'), JSON.stringify({ instances: { ghost: { driver: 'not-a-real-driver', displayName: 'Offline fixture' } } }));
    const worker = join(temp, 'worker.mjs');
    writeFileSync(worker, `#!${process.execPath}\nconsole.log('Hermes Agent v0.21.3 (2026.9.14)');\n`); chmodSync(worker, 0o755);
    const desktopPort = await port(); const desk = `http://127.0.0.1:${desktopPort}`;
    start([join(root, 'server/index.ts')], root, { HOME: temp, USERPROFILE: temp, REALBUD_DATA_DIR: data, REALBUD_HERMES_CLI: worker, OMB_PORT: String(desktopPort), OMB_STATIC_DIR: join(root, 'dist'), VITEST: 'true' });
    await ready(desk + '/api/health');
    const appContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await appContext.addInitScript(() => localStorage.setItem('realbud.first-run-done', '1'));
    const app = await appContext.newPage(); app.on('pageerror', e => errors.push(e.message));
    await app.goto(desk + '/#you-office');
    await app.getByRole('button', { name: /^You\b/ }).first().click();
    const officeSection = app.locator('details').filter({ has: app.getByText('This office', { exact: true }) }).first();
    if (await officeSection.count()) await officeSection.evaluate(node => { node.open = true; });
    await app.getByText('Website account', { exact: true }).waitFor();
    await app.getByText('Website account', { exact: true }).scrollIntoViewIfNeeded();
    await app.screenshot({ path: join(output, 'desktop-website-account.png') });
    desktop = 'rendered (no link performed)';
    checks.push('the desktop half of the pairing sentence (You → This office → Website account) is present');
  } else limits.push('Desktop pairing screen not rendered: dist/ was not built for this run.');

  assert.deepEqual(errors, []);
  limits.push('Fixture office and fictional accounts only; no deployed gateway, Modelvia key or customer data.');
  limits.push('The managed gateway is deliberately unconfigured, so "Revocation pending" is the real unreachable-gateway path, not a simulated reply.');
  limits.push('The loading screenshot delays the real response by 2.5 s; no response body is replaced.');
  limits.push('Renders and keyboard behaviour are Chromium only; no screen reader was run.');
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({
    topic: 'portal-ux-2026-09-22 slice 2 — account Computers page',
    date: new Date().toISOString(),
    proofLayer: 'local source + built Next + disposable PostgreSQL in a headless browser',
    states: { ...expected, 'Old laptop': 'Revoked' },
    checks, desktop, limits,
    screenshots: ['computers-1280.png', 'computers-768.png', 'computers-360.png', 'computers-1280-dark.png', 'pairing-code-1280.png', 'computers-loading-1280.png', 'computers-error-1280.png', 'computers-empty-1280.png', 'computers-reader-1280.png'],
  }, null, 2) + '\n');
  console.log('PASS: ' + checks.join('; ') + `. Receipt: ${join(output, 'receipt.json')}`);
} finally {
  await browser?.close();
  for (const child of children) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), new Promise(r => setTimeout(r, 5000))]); if (child.exitCode === null) child.kill('SIGKILL'); }
  if (bridge) { bridge.closeAllConnections(); await new Promise(r => bridge.close(r)); }
  if (started) await run('pg_ctl', ['-D', join(temp, 'data'), '-m', 'immediate', '-w', 'stop']);
  rmSync(temp, { recursive: true, force: true });
}
