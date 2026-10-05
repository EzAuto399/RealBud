// Browser receipt for the five-computer cap and the per-computer AI checks.
//
// Real built Next (REALBUD_WEBSITE_DIR, default website/), real disposable
// PostgreSQL with every portal migration applied in filename order, and a local
// REST bridge that replaces the PostgREST transport only: every installation row
// is created by the real RPCs (issue, redeem, record provisioning, report, report
// model key, revoke). The only stub is the Modelvia HTTP API, answered by a
// loopback FIXTURE with fictional usage; it is never evidence of a real Modelvia
// account, key or customer.
//
// Covers: Account → Computers "5 of 5 computers" where a disconnect still
// finishing holds a place, Pair unavailable at the cap (aria-disabled, still
// focusable, its reason announced) and the SQL refusal behind it, the "Not using
// its own AI key" badge; AI usage & billing "By computer" table and its two flags,
// an unknown project named in words, and office credits above charges (negative net) read as a credit.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
if (process.env.REALBUD_TEST_POSTGRES !== '1') throw new Error('ENVIRONMENT-GATED, NOT RUN (not a pass): set REALBUD_TEST_POSTGRES=1 (and REALBUD_TEST_POSTGRES_BIN), build the website, and set PLAYWRIGHT_MODULE.');
if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to the installed playwright module.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'website');
const website = resolve(process.env.REALBUD_WEBSITE_DIR ?? source);
const output = join(root, 'outputs/computer-cap-2026-10-04'); mkdirSync(output, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), 'rb-computer-cap-'));
const exec = promisify(execFile);
const bin = process.env.REALBUD_TEST_POSTGRES_BIN ?? '/opt/homebrew/opt/postgresql@16/bin';
const run = (cmd, args) => exec(join(bin, cmd), args, { maxBuffer: 4 * 1024 * 1024 });
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const serviceKey = randomBytes(32).toString('hex'), authSecret = randomBytes(32).toString('hex'), platformKey = randomBytes(16).toString('hex');
const office = 'fixture-office-a', owner = 'owner-a@example.test', customer = 'customer-fixture-office-a';
const listable = new Set(['id', 'label', 'platform', 'app_version', 'worker_version', 'worker_ready', 'linked_at', 'last_seen_at', 'revoked_at', 'provisioning_attempted_at', 'provisioned_at', 'revocation_pending_at', 'apps', 'model_key_id', 'reported_model_key_id', 'model_key_rejected_at']);
const rpcArgs = { realbud_issue_pairing: ['p_company', 'p_actor', 'p_code_hash'], realbud_revoke_installation: ['p_company', 'p_actor', 'p_id'], realbud_clear_revocation_pending: ['p_company', 'p_actor', 'p_id'], realbud_account_commands: ['p_company', 'p_actor', 'p_cursor'], realbud_take_rate_limit: ['p_scope', 'p_key', 'p_per_minute'] };
const children = [], checks = [], violations = [], modelviaCalls = [], tableReads = [];
let browser, bridge, logs = '', started = false;
const sql = async text => (await run('psql', ['-h', temp, '-d', 'postgres', '-XAt', '-v', 'ON_ERROR_STOP=1', '-c', text])).stdout.trim();
const rpc = text => sql(`set role service_role; select to_jsonb(${text})`).then(value => JSON.parse(value.replace(/^SET\n/, '')));
const hex = () => randomBytes(32).toString('hex');
async function port() { const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function ready(url) { for (let i = 0; i < 150; i++) { try { if ((await fetch(url)).ok) return; } catch { } await new Promise(r => setTimeout(r, 200)); } throw new Error('Server startup failed: ' + logs.slice(-2000)); }
async function shoot(page, name) { await page.setViewportSize({ width: 1280, height: 900 }); await page.waitForTimeout(250); await page.screenshot({ path: join(output, `${name}.png`), fullPage: true }); }
/** One computer, created the way a real desktop creates one. */
async function pairComputer(label, keyId) {
  const code = hex(), token = hex(), id = randomUUID();
  await rpc(`realbud_issue_pairing(${quote(office)},${quote(owner)},${quote(code)})`);
  await rpc(`realbud_redeem_installation(${quote(code)},${quote(id)},${quote(token)},${quote(label)},'darwin','0.1.30')`);
  await rpc(`realbud_record_provisioning(${quote(id)},'host-${id.slice(0, 8)}','proj-${id.slice(0, 8)}','key-${id.slice(0, 8)}',array['gmail'])`);
  await rpc(`realbud_report_installation(${quote(token)},'0.1.30','Hermes Agent v0.21.3',true)`);
  await rpc(`realbud_report_model_key(${quote(token)},${quote(keyId ?? `key-${id.slice(0, 8)}`)})`);
  return { id, token, label, project: `rb-${id}` };
}

// Fictional Modelvia analytics for the office and for each project read.
const now = Date.now(), period = new Date(now + 36_000_000).toISOString().slice(0, 7);
const zero = { samples: 0, p50Ms: null, p95Ms: null };
const tokens = n => ({ input: String(n), output: String(n / 2), cacheRead: '0', cacheWrite: '0', totalInput: String(n) });
const money = nano => ({ customerGrossNanoAud: String(nano), customerCreditsNanoAud: '0', customerNetNanoAud: String(nano), unknownCustomerPriceRequests: 0 });
const summary = rows => ({ requests: rows.length, settled: rows.length, pending: 0, unknown: 0,
  tokens: tokens(rows.reduce((t, r) => t + Number(r.tokens.input), 0)), money: money(rows.reduce((t, r) => t + Number(r.money.customerNetNanoAud), 0)),
  latency: { total: zero, routing: zero, provider: zero, firstToken: zero }, routing: { jevSelected: 0, jevAbstained: 0, jevFailed: 0, jevSkipped: 0 } });
let requests = [];
const analytics = projectId => {
  const rows = projectId ? requests.filter(r => r.projectId === projectId) : requests;
  const byProject = [...new Set(rows.map(r => r.projectId))].map(p => ({ key: p, projectId: p, requests: rows.filter(r => r.projectId === p).length }));
  // The office report carries credits above its charges: a signed negative net (A$50 credit).
  const totals = summary(rows);
  if (!projectId) totals.money = { ...totals.money, customerCreditsNanoAud: String(Number(totals.money.customerGrossNanoAud) + 50_000_000_000), customerNetNanoAud: '-50000000000' };
  return { schemaVersion: 1, scope: { role: 'customer', customerId: customer }, period, generatedAt: now, summary: totals,
    byModel: [], byProject, byDay: [], recentRequests: rows, coverage: { requests: rows.length, timedRequests: 0, legacyUntimedRequests: rows.length } };
};
const usageSummary = () => ({ period, requests: requests.length, tokens: { input: '0', output: '0' }, money: { customerNetNanoAud: '-50000000000' }, monthlyCapNanoAud: '200000000000', remainingNanoAud: '190000000000', updatedAt: now });

try {
  // 1. Disposable PostgreSQL with every portal migration, in filename order.
  await run('initdb', ['-D', join(temp, 'data'), '--auth=trust', '--no-locale', '--encoding=UTF8']);
  await run('pg_ctl', ['-D', join(temp, 'data'), '-l', join(temp, 'log'), '-o', `-k ${temp} -c listen_addresses=''`, '-w', 'start']); started = true;
  // Supabase provides these roles and the storage schema the baseline writes to.
  await sql(`create role anon; create role authenticated; create role service_role bypassrls; create schema storage; create table storage.buckets(id text primary key, name text not null, public boolean not null, file_size_limit bigint);`);
  // The migrations and session code come from the same website tree that was built.
  const migrations = readdirSync(join(website, 'supabase/migrations')).filter(f => f.endsWith('.sql')).sort();
  for (const file of migrations) await run('psql', ['-h', temp, '-d', 'postgres', '-XAtq', '-v', 'ON_ERROR_STOP=1', '-f', join(website, 'supabase/migrations', file)]);
  await sql(`insert into billing_accounts(clerk_user_id,company_id,email,agency_label,role,disabled_at,created_at) values (${quote(owner)},${quote(office)},${quote(owner)},'Fixture Office A','billing_owner',null,0)`);

  // 2. PostgREST transport only; authority stays in SQL. Plus the Modelvia FIXTURE.
  bridge = createServer(async (req, res) => {
    const send = (status, body) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      if (url.pathname.startsWith('/v1/')) {
        if (req.headers.authorization !== `Bearer ${platformKey}` || req.method !== 'GET') return send(401, { error: 'fixture_platform_key' });
        const prefix = `/v1/client/customers/${customer}/`;
        if (!url.pathname.startsWith(prefix)) return send(404, { error: 'fixture_route_denied' });
        const operation = url.pathname.slice(prefix.length);
        modelviaCalls.push(operation + (url.searchParams.get('projectId') ? `?projectId` : ''));
        if (operation === 'analytics') return send(200, analytics(url.searchParams.get('projectId')));
        if (operation === 'usage-summary') return send(200, usageSummary());
        return send(404, { error: 'fixture_route_denied' });
      }
      if (req.headers.apikey !== serviceKey || req.headers.authorization !== `Bearer ${serviceKey}`) return send(401, { message: 'fixture_auth_required' });
      const name = url.pathname.replace('/rest/v1/rpc/', '');
      let value;
      if (req.method === 'GET' && url.pathname === '/rest/v1/billing_accounts') {
        const email = url.searchParams.get('email');
        if (!email?.startsWith('eq.')) return send(400, { message: 'fixture_filter' });
        value = JSON.parse(await sql(`select coalesce(jsonb_agg(x),'[]'::jsonb) from (select clerk_user_id,company_id,email,agency_label,role,disabled_at from billing_accounts where email=${quote(email.slice(3))}) x`));
      } else if (req.method === 'GET' && url.pathname === '/rest/v1/office_installations') {
        const company = url.searchParams.get('company_id');
        if (!company?.startsWith('eq.')) return send(400, { message: 'fixture_filter' });
        const columns = (url.searchParams.get('select') ?? '').split(',').map(c => c.trim()).filter(Boolean);
        if (!columns.length || columns.some(c => !listable.has(c))) { violations.push(columns.join(',')); return send(400, { message: 'fixture_column_denied' }); }
        // Exactly the filters the routes send; anything else is a violation.
        const where = [`company_id=${quote(company.slice(3))}`]; let order = '', limit = '';
        for (const [key, value] of url.searchParams) {
          if (key === 'select' || key === 'company_id') continue;
          if (key === 'or' && value === '(revoked_at.is.null,revocation_pending_at.not.is.null)') where.push('(revoked_at is null or revocation_pending_at is not null)');
          else if (key === 'revoked_at' && value === 'not.is.null') where.push('revoked_at is not null');
          else if (key === 'id' && /^in\.\([0-9a-f-]{36}(,[0-9a-f-]{36})*\)$/.test(value)) where.push(`id in (${value.slice(4, -1).split(',').map(quote).join(',')})`);
          else if (key === 'order' && value === 'linked_at.desc') order = ' order by linked_at desc';
          else if (key === 'limit' && /^\d{1,4}$/.test(value)) limit = ` limit ${value}`;
          else { violations.push(`${key}=${value}`); return send(400, { message: 'fixture_filter' }); }
        }
        tableReads.push([...url.searchParams.keys()].filter(k => k !== 'select').sort().join('&'));
        value = JSON.parse(await sql(`select coalesce(jsonb_agg(x),'[]'::jsonb) from (select ${columns.join(',')} from office_installations where ${where.join(' and ')}${order}${limit}) x`));
      } else if (req.method === 'POST' && Object.hasOwn(rpcArgs, name) && url.pathname === `/rest/v1/rpc/${name}`) {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const keys = rpcArgs[name];
        if (Object.keys(body).length !== keys.length || keys.some(k => !Object.hasOwn(body, k))) return send(400, { message: 'fixture_rpc_shape' });
        value = JSON.parse((await sql(`set role service_role; select to_jsonb(${name}(${keys.map(k => body[k] === null ? 'null' : quote(body[k])).join(',')}))`)).replace(/^SET\n/, ''));
      } else { violations.push(`${req.method} ${url.pathname}`); return send(404, { message: 'fixture_route_denied' }); }
      return send(200, value);
    } catch (error) {
      const message = error?.stderr?.match(/ERROR:\s+(\w+)/)?.[1];
      return send(400, { message: message ?? 'fixture_database_error', code: 'P0001', details: null, hint: null });
    }
  });
  bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening');
  const backend = `http://127.0.0.1:${bridge.address().port}`;
  const sitePort = await port(); const site = `http://127.0.0.1:${sitePort}`;
  const child = spawn(process.execPath, [join(website, 'node_modules/next/dist/bin/next'), 'start', '-p', String(sitePort), '-H', '127.0.0.1'], { cwd: website, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: temp, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', REALBUD_AUTH_SECRET: authSecret, SUPABASE_URL: backend, SUPABASE_SERVICE_ROLE_KEY: serviceKey,
      REALBUD_SITE_ORIGIN: site, REALBUD_EXTRA_ORIGINS: site, PLATFORM_API_URL: backend, PLATFORM_CLIENT_KEY: platformKey, REALBUD_PLATFORM_CUSTOMERS_JSON: JSON.stringify({ [office]: customer }) } });
  children.push(child); child.stdout.on('data', b => { logs += b; }); child.stderr.on('data', b => { logs += b; });
  await ready(site + '/');
  process.env.REALBUD_AUTH_SECRET = authSecret;
  const { mintSession } = await import(join(website, 'lib/session.ts'));
  const cookie = await mintSession(owner);
  const headers = { origin: site, 'content-type': 'application/json', cookie: `rb_session=${cookie}` };

  // 3. One disconnected computer whose gateway cleanup is still owed (it holds a
  // place: its key may still work), then four active; one reports another office's key.
  const retired = await pairComputer('Old laptop');
  assert.equal((await rpc(`realbud_revoke_installation(${quote(office)},${quote(owner)},${quote(retired.id)})`)).cleanupOwed, true);
  const computers = [];
  for (const label of ['Front desk Mac', 'Back office PC', 'Property team laptop']) computers.push(await pairComputer(label));
  const borrowed = await pairComputer('Reception Mac', 'key-from-another-office');
  computers.push(borrowed);
  // Back office PC's desktop reports that its own key was refused upstream.
  assert.equal(await rpc(`realbud_report_model_key_rejected(${quote(computers[1].token)},true)`), true);
  assert.equal(await sql(`select count(*) from office_installations where company_id=${quote(office)} and revoked_at is null`), '4');
  assert.equal(await sql(`select realbud_installations_held(${quote(office)})`), '5');
  const issue = await fetch(site + '/api/account/installations', { method: 'POST', headers, body: '{}' });
  assert.equal(issue.status, 409);
  assert.deepEqual(await issue.json(), { error: 'This office already has 5 computers. Disconnect one to pair another.' });
  checks.push('with four active computers and one disconnect still finishing, a new pairing code is refused by SQL (installation_limit) and the route answers 409 with the plain sentence');

  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies([{ name: 'rb_session', value: cookie, url: site, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  const pairPosts = []; page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/api/account/installations')) pairPosts.push(r.url()); });

  // 4. Computers page at the cap.
  await page.goto(site + '/account/installations');
  await page.getByRole('heading', { name: 'Reception Mac' }).waitFor();
  await page.getByText('5 of 5 computers. 1 disconnected computer still takes a place until its disconnect is finished.', { exact: true }).waitFor();
  const pair = page.getByRole('button', { name: 'Pair a new computer', exact: true });
  assert.equal(await pair.getAttribute('aria-disabled'), 'true', 'Pair is unavailable at five');
  assert.equal(await pair.evaluate(button => button.disabled), false, 'but not natively disabled, so it stays focusable and its reason is announced');
  assert.equal(await page.locator('#installation-limit-note').innerText(), 'This office already has 5 computers. Disconnect one to pair another.');
  assert.equal(await pair.getAttribute('aria-describedby'), 'installation-limit-note');
  await pair.focus();
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Pair a new computer');
  // It must also look unavailable: the same muted fill as a natively disabled button, hover included.
  const look = () => pair.evaluate(button => {
    const probe = document.createElement('i'); probe.style.background = 'var(--soft)'; document.body.append(probe);
    const soft = getComputedStyle(probe).backgroundColor; probe.remove();
    const style = getComputedStyle(button); return [style.cursor, style.backgroundColor === soft];
  });
  assert.deepEqual(await look(), ['not-allowed', true]);
  await pair.hover(); assert.deepEqual(await look(), ['not-allowed', true]);
  await page.keyboard.press('Enter'); await pair.click({ force: true }); await page.waitForTimeout(300);
  assert.deepEqual(pairPosts, [], 'activating it sends nothing');
  checks.push('Computers shows "5 of 5 computers" and says the finishing disconnect still takes a place; Pair a new computer is aria-disabled, focusable, described by the limit sentence, muted like a disabled button (also on hover), and Enter or click sends nothing');
  const badge = card => page.locator('.installation-card').filter({ hasText: card }).locator('.badge');
  assert.match(await badge('Reception Mac').innerText(), /Not using its own AI key$/);
  await page.getByText('This computer reported an AI key that was not set up for it. Disconnect it and pair it again, or contact support.', { exact: true }).waitFor();
  for (const label of ['Front desk Mac', 'Property team laptop']) assert.doesNotMatch(await badge(label).innerText(), /AI key/);
  assert.match(await badge('Back office PC').innerText(), /AI key was refused$/);
  await page.getByText("Bud's AI key stopped working. Disconnect this computer and pair it again, or contact support.", { exact: true }).waitFor();
  checks.push('Back office PC, whose desktop reported its key refused (realbud_report_model_key_rejected), carries "AI key was refused" with its help sentence');
  // Provisioned and revoked with no gateway here: its cleanup is still owed.
  assert.match(await badge('Old laptop').innerText(), /Revocation pending$/);
  const listed = await (await fetch(site + '/api/account/installations', { headers })).text();
  assert.ok(!/key-from-another-office|"model_key_id"|"reported_model_key_id"|"model_key_rejected_at"/.test(listed), 'the browser receives only the flags, never a key id');
  checks.push('Reception Mac, which reported another office\'s key id, carries "Not using its own AI key"; matching computers do not; the list response carries no key id');
  await shoot(page, 'computers-at-cap-1280');

  // 5. AI usage & billing: By computer table and flags, from the Modelvia FIXTURE.
  // After the revoke above, so the disconnected computer's use reads as later.
  const at = Date.now();
  const request = (projectId, n, nano) => ({ requestId: `fixture-${randomUUID()}`, createdAt: at + n, projectId, environment: 'production', state: 'settled', model: 'fixture-model', tokens: tokens(1000), money: money(nano), timing: null });
  requests = [
    ...[0, 1, 2].map(n => request(computers[0].project, n, 120_000_000)),
    ...[3, 4].map(n => request(borrowed.project, n, 80_000_000)),
    request(retired.project, 5, 50_000_000),
    request('rb-fixture-unknown-project', 6, 30_000_000),
  ];
  await page.goto(site + '/account/ai-billing');
  await page.getByRole('heading', { name: 'By computer', exact: true }).waitFor({ timeout: 30_000 });
  await page.getByText('Old laptop is disconnected but still using AI', { exact: true }).waitFor();
  await page.getByText('AI use was recorded after this computer was disconnected.', { exact: false }).waitFor();
  await page.getByText('AI used outside your computers', { exact: true }).waitFor();
  const unknownNote = await page.getByText('came from a project that is not one of your linked computers', { exact: false }).innerText();
  assert.equal(unknownNote, '1 request this month came from a project that is not one of your linked computers. Contact RealBud support so we can check it.');
  const table = page.locator('article[aria-labelledby="usage-computers-heading"] table');
  const tableText = await table.innerText();
  for (const label of ['Front desk Mac', 'Reception Mac', 'Back office PC', 'Property team laptop']) assert.match(tableText, new RegExp(label));
  assert.doesNotMatch(tableText, /Not linked to a computer/, 'every request is attributed');
  const unknownRow = await table.locator('tr').filter({ hasText: 'Unknown project' }).innerText();
  assert.match(unknownRow, /Not one of your computers/);
  assert.doesNotMatch(tableText, /rb-fixture-unknown-project/, 'the raw project id never shows');
  assert.match(await table.locator('tr').filter({ hasText: 'Office credits' }).innerText(), /A\$\d[\d,]*\.\d\d credit/);
  await page.getByText('A$50.00 credit', { exact: true }).first().waitFor();
  assert.doesNotMatch(await page.locator('main').innerText(), /-A\$/, 'a credit is said in words, never as a minus sign');
  checks.push('an unknown project reads "Unknown project" with "Not one of your computers" (no raw id); office credits above charges (net -A$50) read "A$50.00 credit" and the remainder shows as an "Office credits" row, never as an outage or a hidden zero');
  checks.push('AI usage & billing shows "By computer" with every active computer and both flags: a disconnected computer with AI use recorded after its disconnect (no inexact count), and use from a project that is not one of the office\'s computers (no raw project id in the warning)');
  await page.locator('article[aria-labelledby="usage-computers-heading"]').scrollIntoViewIfNeeded();
  await shoot(page, 'ai-usage-by-computer-1280');

  assert.deepEqual(errors, []);
  assert.deepEqual(violations, []);
  // Both routes read held computers unbounded; only revoked history is capped.
  assert.ok(tableReads.includes('company_id&or'), tableReads.join(' | '));
  assert.ok(tableReads.includes('company_id&limit&order&revoked_at'), tableReads.join(' | '));
  assert.ok(tableReads.includes('company_id&id&limit'), tableReads.join(' | '));
  checks.push('installation reads: held computers unbounded (or=revoked_at null or revocation pending), revoked history capped at 200, used projects resolved by id in batches bounded to their own length');
  const receipt = {
    topic: 'computer-cap-2026-10-04: five-computer cap, key mismatch badge, AI usage by computer',
    date: new Date().toISOString(),
    proofLayer: 'local source + built Next (scratch copy) + disposable PostgreSQL with all portal migrations, headless Chromium',
    website, migrations, checks, modelviaCalls: [...new Set(modelviaCalls)],
    screenshots: ['computers-at-cap-1280.png', 'ai-usage-by-computer-1280.png'],
    limits: [
      'Modelvia is a loopback FIXTURE with fictional usage; no real Modelvia account, key or customer.',
      'Fixture office and fictional accounts only; no deployed site, gateway or customer data.',
      'Desktop width (1280) only; Chromium only; no screen reader was run.',
      'The key mismatch was reported through the real SQL RPC directly, not by a running desktop.',
      'Revocation pending is produced by revoking through the SQL RPC with no gateway; no gateway cleanup was attempted.',
      'The negative net (A$50 credit) is exercised in both the office total card (usage-summary) and the analytics path (Usage details / By computer).',
    ],
  };
  writeFileSync(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(`PASS: ${checks.length} checks. ${checks.join('; ')}. Receipt: ${join(output, 'receipt.json')}`);
} finally {
  await browser?.close();
  for (const child of children) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), new Promise(r => setTimeout(r, 5000))]); if (child.exitCode === null) child.kill('SIGKILL'); }
  if (bridge) { bridge.closeAllConnections(); await new Promise(r => bridge.close(r)); }
  if (started) await run('pg_ctl', ['-D', join(temp, 'data'), '-m', 'immediate', '-w', 'stop']);
  rmSync(temp, { recursive: true, force: true });
}
