#!/usr/bin/env node
// Kevin's and Sherry's day on macOS, one fresh office each: link the computer
// through the office link (link code) in the built UI, then the person's own
// daily flow on FICTIONAL data, with a PASS/FAIL receipt per step and
// screenshots at desktop widths 1280 and 1024.
//   Sherry (MacBook): morning priorities, supplier directory, maintenance
//     findings, inspection plan, approval cards (REI supplier refresh, rule change).
//   Kevin (Windows PC; this proves the logic on macOS): arrears on Desk, weekly
//     bills to the calendar (one and many, a duplicate), bank reconciliation
//     review (an ambiguous row held), the REI receipting upload approved once on
//     the fictional REI portal, approve then Stop.
// Both: empty states, restart mid-flow, a service blip with recovery,
// keyboard-only on the main path.
// Real source service (server/bootstrap.ts) behind the loopback-only guard of
// scripts/qa-clean-walkthrough.mjs. Loopback stand-ins: a lab website for
// realbud.app (link redeem + the Gmail connector), a fake Redbark, the fictional
// REI portal (server/testing/w1-lab.ts) and the deterministic Austin showcase
// worker (no model). No ~/.realbud, no live REI, Gmail, Redbark or Modelvia.
//
//   PLAYWRIGHT_MODULE=… CHROME_EXECUTABLE=… REALBUD_UI_DIR=<vite build> node scripts/qa-kevin-sherry-day.mjs [kevin|sherry]
//   (Node 24+; QA_OUTPUT optional, must be fresh)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serviceSmokeEnv } from './service-smoke-env.mjs';
import { readSessionToken } from './local-session.mjs';
import { completeFictionalOnboarding } from './qa-onboarding.mjs';
import { addDays, billFacts, localDate, seed } from './seed-austin-demo.mjs';

if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to an installed Playwright module.');
if (process.platform === 'win32') throw new Error('This is the macOS run; Windows is covered separately.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const showcase = join(root, 'pack/workflows/austin-showcase');
const uiDir = resolve(process.env.REALBUD_UI_DIR ?? join(root, 'dist'));
assert.ok(existsSync(join(uiDir, 'index.html')), `Build the UI first: no ${uiDir}/index.html`);
const DATE = new Date().toISOString().slice(0, 10);
const output = resolve(process.env.QA_OUTPUT ?? join(root, `outputs/kevin-sherry-qa-${DATE}`));
const people = process.argv[2] ? [process.argv[2]] : ['sherry', 'kevin'];
for (const who of people) {
  assert.ok(['kevin', 'sherry'].includes(who), `Unknown person ${who}`);
  assert.ok(!existsSync(join(output, who, 'receipt.json')), `Earlier evidence at ${join(output, who)} is preserved; choose a fresh QA_OUTPUT.`);
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const freePort = async () => { const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
const money = cents => (cents / 100).toFixed(2);
const property = code => seed.properties.find(p => p.code === code);
const until = async (check, label, ms = 30_000) => {
  const deadline = Date.now() + ms; let last;
  while (Date.now() < deadline) { last = await check().catch(e => e); if (last && !(last instanceof Error)) return last; await wait(150); }
  throw new Error(`Timed out: ${label}${last instanceof Error ? ` (${last.message})` : ''}`);
};
// A bank row whose reference names no tenant: the review must hold it, never guess.
const AMBIGUOUS = { id: 'txn_fk_demo-0042', daysAgo: 1, amountCents: 41000, reference: 'FICTIONAL BOND TOP UP' };

/** One person, one fresh temp home, one office link, one service. */
async function runPerson(who) {
  const out = join(output, who); mkdirSync(out, { recursive: true });
  const temp = mkdtempSync(join(realpathSync(tmpdir()), `fictional-${who}-day-`));
  const home = join(temp, 'home'), data = join(home, '.realbud');
  mkdirSync(data, { recursive: true, mode: 0o700 });
  assert.notEqual(realpathSync(data), resolve(homedir(), '.realbud'), 'Never point a QA run at the real ~/.realbud');
  const today = localDate();
  const CODE = `rb1_${(who === 'kevin' ? 'c3' : 'a1').repeat(32)}`, credential = `rbc_${'d'.repeat(64)}`;
  const PERSON = who === 'kevin' ? 'Fictional Kevin' : 'Fictional Sherry', OFFICE = 'Fictional Austin Demo Office (sample)';
  const GMAIL = seed.office.gmail.accountId;

  // ── lab website (realbud.app stand-in) + Gmail connector on one loopback origin ──
  const siteCalls = [], gmailCalls = { status: 0, scan: 0, history: 0 };
  const sentAt = daysAgo => Math.min(Date.parse(`${addDays(today, -daysAgo)}T00:00:00Z`) - 3_600_000, Date.now() - 60_000);
  const mail = (t, body) => ({ id: t.messageId, threadId: t.threadId, at: sentAt(t.daysAgo), direction: 'incoming', from: t.from, to: seed.office.gmail.address, subject: t.subject, body, bodyTruncated: false, attachments: [], ...(t.authResults ? { authResults: t.authResults } : {}) });
  const billBody = b => {
    const { invoiceDate, dueDate } = billFacts(b, today);
    const facts = `Fictional ${b.kind.toLowerCase()} invoice for ${b.property} ${property(b.property).address}. Invoice number ${b.invoiceId}. Supplier: ${b.vendor}. Kind: ${b.kind}. Invoice date ${invoiceDate}. Amount AUD ${money(b.amountCents)}. Due ${dueDate}. No payment is recorded.`;
    if (b.forwarded) return `Fictional note from the office: please file this one.\n\n---------- Forwarded message ----------\nFrom: ${b.vendor} <rates@fictional-council.example.invalid>\n${facts}`;
    if (b.corrected) return `This corrected invoice replaces the earlier ${b.invoiceId}; the amount and due date changed. ${facts}`;
    return facts;
  };
  const threads = [
    ...seed.mailbox.triage.map(t => ({ id: t.threadId, historyComplete: true, messages: [mail(t, `SYNTHETIC. ${t.body}`)] })),
    ...seed.mailbox.bills.map(b => ({ id: b.threadId, historyComplete: true, messages: [mail(b, `SYNTHETIC. ${billBody(b)}`)] })),
  ];
  let labOrigin = '';
  const lab = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const path = new URL(req.url, 'http://lab').pathname;
    res.setHeader('content-type', 'application/json');
    if (path.startsWith('/api/installations/')) {
      siteCalls.push(`${req.method} ${path}`);
      if (req.method === 'POST' && path === '/api/installations/redeem') {
        const body = JSON.parse(raw);
        if (body.code !== CODE) { res.writeHead(404); res.end('{}'); return; }
        res.end(JSON.stringify({ installationId: body.id, companyId: `fictional-austin-${who}-office`, agencyLabel: OFFICE, provisioning: { version: 1,
          service: { companyId: `fictional-austin-${who}-office`, hostInstallationId: `fictional-austin-${who}-host` },
          connector: { endpoint: labOrigin, credential, profile: 'property', apps: ['gmail'] },
          model: { provider: 'modelvia', baseUrl: 'https://model.fictional.invalid/v1', projectId: 'fictional-qa-project', keyId: 'fictional-qa-key', key: `rbk_${'f'.repeat(40)}`, spendCapLabel: 'Fictional deterministic worker only' } } }));
        return;
      }
      res.end('{}'); return;
    }
    if (req.headers.authorization !== `Bearer ${credential}` || req.headers['x-realbud-profile'] !== 'property') { res.writeHead(403); res.end('{"error":"fixture_denied"}'); return; }
    if (path === '/v1/connectors/status') {
      gmailCalls.status++;
      res.end(JSON.stringify({ managed: true, checkedAt: new Date().toISOString(), serviceExpiresAt: Date.now() + 3_600_000, services: { gmail: { connected: true, status: 'ACTIVE', accounts: [{ id: GMAIL, label: seed.office.gmail.label, status: 'ACTIVE' }], accountSelectionRequired: false } }, tools: { available: true, names: ['GMAIL_GET_PROFILE', 'GMAIL_LIST_THREADS', 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID'] } }));
      return;
    }
    if (path === '/v1/connectors/mail-scan' || path === '/v1/connectors/mail-history-scan') {
      const body = JSON.parse(raw), scope = body.scope;
      if (body.expectedAccountId !== GMAIL || !scope) { res.writeHead(409); res.end('{}'); return; }
      const history = path.endsWith('history-scan');
      gmailCalls[history ? 'history' : 'scan']++;
      const inWindow = threads.filter(t => t.messages.every(m => m.at >= scope.windowStartAt && m.at < scope.windowEndAt));
      res.end(JSON.stringify({ accountId: GMAIL, windowStartAt: scope.windowStartAt, windowEndAt: scope.windowEndAt, ...(history ? {} : { pages: 1, paginationComplete: true, gaps: [] }), threads: history ? inWindow : threads }));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  lab.listen(0, '127.0.0.1'); await once(lab, 'listening');
  labOrigin = `http://127.0.0.1:${lab.address().port}`;

  // ── fake Redbark: live REST shapes, synthetic key; the ambiguous row is Kevin's edge case ──
  const { FICTIONAL_REDBARK_KEY } = await import(pathToFileURL(join(root, 'server/testing/w1-lab.ts')).href);
  const A = seed.redbark.account, redbarkCalls = [];
  const ledger = [...seed.redbark.rows, AMBIGUOUS].map(row => {
    const date = addDays(today, -row.daysAgo), status = row.status ?? 'posted';
    return { id: row.id, object: 'transaction', account: A.id, status, date, datetime: `${addDays(date, -1)}T17:18:00.000Z`, post_date: status === 'posted' ? date : null,
      post_datetime: status === 'posted' ? `${addDays(date, -1)}T17:20:00.000Z` : null, value_date: null, value_datetime: null, description: `FICTIONAL PAYMENT ${row.reference}`,
      reference: row.reference, extended_description: null, amount: { amount: row.amountCents, currency: 'aud' }, direction: 'credit', provider_category: 'TRANSFER_IN',
      category: null, merchant_name: null, merchant_category_code: null, livemode: true };
  });
  const account = { id: A.id, object: 'account_item', connection: A.connection, provider: 'fiskil', category: 'banking', name: A.name, type: 'transaction',
    institution: { id: 'inst_fk_anz_fictional', name: 'ANZ (fictional)', logo: null }, account_number: `xxxx${A.last4}`, currency: 'aud', status: 'available',
    last_updated_at: `${today}T00:30:00.000Z`, livemode: true, created: '2026-08-21T09:30:00.000Z', updated: `${today}T00:30:00.000Z` };
  const redbark = createServer((req, res) => {
    const url = new URL(req.url, 'http://fake'), send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${FICTIONAL_REDBARK_KEY}` || !req.headers['redbark-version']) return send(401, { error: { type: 'authentication_error' } });
    redbarkCalls.push(url.pathname);
    const page = items => send(200, { object: 'list', data: items, next_page_url: null, previous_page_url: null });
    if (url.pathname === '/v2/accounts') return page([account]);
    if (url.pathname === '/v2/transactions') {
      const q = Object.fromEntries(url.searchParams);
      return page(ledger.filter(row => row.account === q.account && row.date >= q.from && row.date <= q.to && (q.include_pending !== 'false' || row.status === 'posted')).sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)));
    }
    send(404, { error: { type: 'invalid_request_error' } });
  });
  redbark.listen(0, '127.0.0.1'); await once(redbark, 'listening');
  const redbarkBase = `http://127.0.0.1:${redbark.address().port}`;

  // ── deterministic worker (Austin showcase demo worker) + loopback guard ──
  const worker = join(temp, 'demo-worker.mjs');
  writeFileSync(worker, `#!${process.execPath}\nconst DATA = ${JSON.stringify(data)};\nconst CHANGE = ${JSON.stringify(seed.sherryRules.scriptedChange)};\n${readFileSync(join(showcase, 'demo-worker.mjs'), 'utf8')}`, { mode: 0o700 });
  writeFileSync(join(temp, 'network-guard.mjs'), `const realFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw new Error('QA denied non-loopback fetch to '+url.origin);return realFetch(input,init);};`, { mode: 0o600 });

  // ── service ──
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  let child, childClosed, token = '', logs = '';
  async function startService() {
    const env = { ...serviceSmokeEnv({ executable: process.execPath, home, data, scratch: temp, port }), REALBUD_MANAGED_SERVICE: '0', REALBUD_TEST_LAB: '1',
      REALBUD_TEST_W1_FICTIONAL_REI: '1', REALBUD_TEST_REDBARK_BASE: redbarkBase, REALBUD_WEBSITE_ORIGIN: labOrigin, REALBUD_HERMES_CLI: worker, OMB_STATIC_DIR: uiDir };
    child = spawn(process.execPath, ['--import', join(temp, 'network-guard.mjs'), join(root, 'server/bootstrap.ts')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    childClosed = new Promise(r => child.once('close', r));
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-60_000); });
    for (let i = 0; i < 300 && child.exitCode === null; i++) {
      if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) }).then(r => r.json()).catch(() => null))?.pid === child.pid) { token = await readSessionToken(data); return; }
      await wait(100);
    }
    throw new Error(`service did not start\n${logs.slice(-3000)}`);
  }
  async function stopService() {
    if (!child || child.exitCode !== null || child.signalCode) return;
    child.kill('SIGTERM'); const force = setTimeout(() => child.kill('SIGKILL'), 8_000);
    try { await childClosed; } finally { clearTimeout(force); }
  }
  const api = async (path, method = 'GET', body, expected) => {
    const res = await fetch(base + path, { method, signal: AbortSignal.timeout(60_000), headers: { 'content-type': 'application/json', 'x-realbud-session': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await res.json().catch(() => null);
    if (expected !== undefined) assert.equal(res.status, expected, `${method} ${path}: ${JSON.stringify(value)}`);
    return value;
  };
  const ok = (path, method, body, status = 200) => api(path, method, body, status);
  const labAct = action => ok('/api/w1/lab', 'POST', { action });

  // ── browser: one desktop window with the Electron-like local-session bridge ──
  let browser, page;
  const pageErrors = [], denied = [];
  const steps = [], observations = [], productBugs = [];
  let shotIndex = 0, current = null;
  const shot = async label => {
    const file = `${String(++shotIndex).padStart(2, '0')}-${label}.png`;
    await page.screenshot({ path: join(out, file) }); current?.screenshots.push(file); return file;
  };
  async function step(n, name, fn) {
    current = { n, name, status: 'PASS', checks: [], screenshots: [] };
    console.log(`… ${who} ${n}. ${name}`);
    try { await fn(text => current.checks.push(text)); console.log(`PASS ${who} ${n}. ${name}`); }
    catch (error) {
      current.status = 'FAIL'; current.detail = error instanceof Error ? error.message.split('\n').slice(0, 4).join(' ') : String(error);
      await shot(`step${n}-failure`).catch(() => {});
      if (child && (child.exitCode !== null || child.signalCode)) await startService().catch(() => {});
      console.error(`FAIL ${who} ${n}. ${name}\n${error instanceof Error ? error.stack : error}`);
    }
    steps.push(current); current = null;
  }
  /** Desktop widths 1280 and 1024, no horizontal page scroll. */
  async function widths(label, target) {
    for (const width of [1280, 1024]) {
      await page.setViewportSize({ width, height: 900 }); await wait(250);
      if (target) await target.scrollIntoViewIfNeeded().catch(() => {});
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert.ok(overflow <= 1, `${label}: ${overflow}px horizontal scroll at ${width}px`);
      await shot(`${label}-${width}`);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  /** Keyboard only: Tab until a control with this accessible name has focus, then press. */
  async function pressByKeyboard(name, { key = 'Enter', max = 250, from } = {}) {
    if (from) await from.focus();
    for (let i = 0; i < max; i++) {
      await page.keyboard.press('Tab');
      const hit = await page.evaluate(wanted => {
        const el = document.activeElement; if (!el || el === document.body) return false;
        const label = (el.getAttribute('aria-label') ?? '').trim(), text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        return label === wanted || text === wanted;
      }, name);
      if (hit) { await page.keyboard.press(key); return; }
    }
    throw new Error(`Could not reach "${name}" by keyboard`);
  }
  async function railByKeyboard(name, hash) {
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : null));
    await pressByKeyboard(name);
    await until(async () => new URL(page.url()).hash.startsWith(hash), `${name} opens by keyboard`, 5_000);
  }
  const rail = name => page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name, exact: true });
  const loops = async () => (await ok('/api/loops')).runs ?? [];
  const latestRun = async id => (await loops()).filter(r => r.loopId === id).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
  async function openJob(name) {
    await rail('Schedule').click();
    await page.getByRole('button', { name: `Open job: ${name}`, exact: true }).click();
  }
  /** Schedule → job → (Resume) → Run now, by keyboard; waits for the run to settle. */
  async function runJob(name, id) {
    await openJob(name);
    const before = await latestRun(id);
    const dialog = page.getByRole('dialog', { name, exact: true });
    await dialog.waitFor();
    const resume = dialog.getByRole('button', { name: 'Resume', exact: true }), run = dialog.getByRole('button', { name: 'Run now', exact: true });
    if (await resume.count() && await run.isDisabled()) { await resume.focus(); await page.keyboard.press('Enter'); await until(async () => !(await run.isDisabled()), `${name} Run now enabled`, 10_000); }
    await run.focus(); await page.keyboard.press('Enter');
    const settled = await until(async () => { const r = await latestRun(id); return r && r.id !== before?.id && !['queued', 'running'].includes(r.status) ? r : null; }, `${id} run settles`, 90_000);
    const close = dialog.getByRole('button', { name: /^Close/ }).first();
    await close.focus(); await page.keyboard.press('Enter'); await dialog.waitFor({ state: 'hidden' });
    return settled;
  }
  async function openBills() {
    await rail('Desk').click();
    await page.getByRole('tablist', { name: 'Desk views', exact: true }).getByRole('tab', { name: /^Bills/ }).click();
    const panel = page.getByRole('region', { name: 'Source-linked bills and calendar' }); await panel.waitFor(); return panel;
  }
  const reconnects = async () => { await page.getByRole('status').filter({ hasText: /^App connected$/ }).waitFor({ timeout: 30_000 }); };

  /** Harness setup after the link: the fictional book, mail plans and workflow settings (API, like scripts/seed-austin-demo.mjs). */
  async function seedBook() {
    const notes = [];
    await completeFictionalOnboarding(ok);
    await ok('/api/hermes/apply-pack', 'POST', {});
    const pack = await ok(`/api/customer-packs/${seed.office.workflowPackId}/export`), preview = await ok('/api/customer-packs/preview', 'POST', { pack });
    await ok('/api/customer-packs/install', 'POST', { pack, expectedDigest: preview.digest });
    const recipes = (await ok('/api/recipes')).recipes;
    for (const id of ['wf-austin-accounts-inbox-triage', 'wf-austin-accounts-invoice-review', 'wf-austin-accounts-bill-exceptions']) {
      const recipe = recipes.find(r => r.id === id); assert.ok(recipe, `pack recipe ${id}`);
      await ok(`/api/recipes/${id}`, 'PATCH', { expectedRevision: recipe.revision, planApproved: true, status: 'active' });
    }
    const status = await ok('/api/hermes'); assert.ok(status.workerFingerprint, 'worker fingerprint');
    writeFileSync(join(data, 'hands-ping.json'), JSON.stringify({ at: Date.now(), ok: true, detail: 'Fictional demo worker readiness; not a live model test', kind: 'ping', workerFingerprint: status.workerFingerprint }), { mode: 0o600 });
    let setup = await ok('/api/agency-setup');
    setup = await ok('/api/agency-setup', 'PUT', { expectedRevision: setup.state.revision, settings: { ...setup.state.settings, agencyName: seed.office.agencyName, workflowPackId: seed.office.workflowPackId, timeZone: seed.office.timeZone } });
    const ids = {}; let snap;
    for (const p of seed.properties) {
      snap = await ok('/api/desk/properties', 'POST', { address: p.address, tenantName: p.tenant.name, tenantPhone: p.tenant.phone, weeklyRentCents: p.weeklyRentCents, propertyCode: p.code, ...(p.options ? { options: p.options } : {}) }, 201);
      ids[p.code] = snap.properties.find(item => item.propertyCode === p.code).id;
    }
    const csv = ['propertyCode,daysSinceDue,rentLanded,levyPaid', ...seed.reiLedger.rows.map(r => [r.code, r.daysSinceDue, r.rentLanded, r.levyPaid].join(','))].join('\n');
    const ledgerPreview = await ok('/api/desk/import/preview', 'POST', { csv });
    await ok('/api/desk/import', 'POST', { csv, expectedDigest: ledgerPreview.digest, expectedRevision: ledgerPreview.expectedRevision, observedAt: ledgerPreview.observedAt });
    notes.push(`${seed.properties.length} fictional properties and the REI ledger stub (CSV)`);
    await ok('/api/connected-apps/check', 'POST', {});
    setup = await ok('/api/agency-setup');
    setup = await ok('/api/agency-setup', 'PUT', { expectedRevision: setup.state.revision, settings: { ...setup.state.settings, gmailAccountId: GMAIL, selectedWorkflows: ['bills-calendar', 'morning-priorities'], propertyReferences: seed.properties.map(p => ({ propertyId: ids[p.code], reference: p.code, aliases: [p.address] })) } });
    setup = await ok('/api/agency-setup/check-gmail', 'POST', { expectedRevision: setup.state.revision });
    for (const id of ['morning-priorities', 'bills-calendar']) {
      const workflow = setup.workflows.find(w => w.id === id); assert.ok(workflow?.canReview, JSON.stringify(workflow));
      await ok(`/api/agency-setup/workflows/${id}/review`, 'POST', { expectedRevision: setup.state.revision, expectedEvidenceDigest: workflow.evidenceDigest });
      setup = await ok('/api/agency-setup');
    }
    for (let i = 0; i < 300; i++) { if ((await ok('/api/mail-workspace')).history?.state !== 'checking') break; await wait(100); }
    notes.push(`fictional Gmail inbox through the office link's connector: ${seed.mailbox.triage.length} morning items, ${seed.mailbox.bills.length} invoice mails; morning priorities and bills plans reviewed`);
    // REI business for W1 and the REI list refresh (both people), tenant references for Kevin's bank review.
    if (who === 'kevin') {
      const rules = seed.properties.map(p => ({ propertyId: p.code, reference: p.tenant.reiTenantRef, aliases: [p.tenant.reiTenantRef], tenant: p.tenant.name }));
      await ok('/api/bank-reference', 'POST', { csv: `Date,Amount,Narrative,Reference\n${addDays(today, -60)},1.00,FICTIONAL SEED,\n`, columns: { date: 'Date', amount: 'Amount', narrative: 'Narrative', reference: 'Reference' }, dateFormat: 'YYYY-MM-DD', rules });
      notes.push(`tenant reference directory (${rules.length})`);
    }
    await ok('/api/w1/settings', 'PUT', { account: A.id, reiBusiness: seed.office.rei.business, expectedRevision: 0 });
    notes.push(`fictional trust account ${A.id} → fictional REI business ${seed.office.rei.business}`);
    if (who === 'sherry') {
      notes.push(`${await seedMaintenanceHistory(ids)} reviewed maintenance invoices from last month (register, as in seed-austin-demo)`);
      const ruleState = await ok('/api/inspection-rules');
      await ok('/api/inspection-rules', 'PUT', { rules: seed.sherryRules.inspectionRules, expectedRevision: ruleState.revision });
      notes.push("Sherry's inspection rules");
    }
    const tabs = await ok('/api/workspace-tabs');
    if (tabs.state) await ok('/api/workspace-tabs', 'PUT', { version: 2, tabs: tabs.state.tabs, desk: { sections: tabs.state.desk.sections.map(s => ({ ...s, visible: true })) }, expectedRevision: tabs.state.revision });
    return { ids, notes };
  }
  async function seedMaintenanceHistory(ids) {
    const [{ SourceBillRegister, previewBillSource }, { WorkflowDatabase }] = await Promise.all([import('../server/source-bills.ts'), import('../server/workflow-database.ts')]);
    const db = new WorkflowDatabase({ dir: data });
    try {
      const register = new SourceBillRegister(db, { dataDir: data });
      const [y, m] = today.split('-').map(Number), last = new Date(Date.UTC(y, m - 2, 1));
      const day = n => `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, '0')}-${String(n).padStart(2, '0')}`;
      let count = 0;
      for (const inv of seed.mailbox.maintenance.invoices) {
        const date = day(inv.dayOfLastMonth), id = createHash('sha256').update(`kevin-sherry-${count}`).digest('hex').slice(0, 16);
        const source = { accountId: GMAIL, receiptId: 'fictional-kevin-sherry-receipt', threadId: `thread${id}`,
          message: { id, at: Date.parse(`${inv.receivedDayOfLastMonth ? day(inv.receivedDayOfLastMonth) : date}T00:30:00Z`), from: inv.from, subject: inv.subject, body: `SYNTHETIC. Fictional invoice ${inv.number} for ${inv.work}.`, bodyTruncated: false, attachments: [], ...(inv.authResults ? { authResults: inv.authResults } : {}) } };
        const facts = { propertyId: ids[inv.property], kind: inv.kind ?? 'Maintenance', vendor: inv.vendor, amountCents: inv.cents, currency: 'AUD', invoiceDate: date, dueDate: null, note: 'Synthetic history',
          invoiceNumber: inv.number, invoiceVersion: null, supplierReference: inv.ref ?? null, workDescription: inv.work };
        const body = { expectedSourceDigest: previewBillSource(source).digest, sourceReviewed: true, facts, reviewReason: 'Fictional earlier review (QA seed)' };
        try { register.accept(body, source, 'fictional-reviewer'); }
        catch (error) {
          if (error.code !== 'bill_duplicate_review_required') throw error;
          const check = register.duplicateCandidates({ expectedSourceDigest: body.expectedSourceDigest, facts }, source);
          register.accept({ ...body, duplicateReview: { reviewDigest: check.reviewDigest } }, source, 'fictional-reviewer');
        }
        count++;
      }
      return count;
    } finally { db.close?.(); }
  }

  const shared = { who, PERSON, OFFICE, CODE, today, api, ok, labAct, step, shot, widths, pressByKeyboard, railByKeyboard, rail, openJob, runJob, openBills, latestRun, reconnects, until,
    observations, productBugs, get page() { return page; }, startService, stopService, seedBook, gmailCalls, redbarkCalls, ledger };
  let failure = null;
  try {
    await startService();
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    // Electron main answers getLocalSession over IPC; this bridge does the same, so a restart reconnects the open window.
    await context.exposeFunction('__qaLocalSession', () => token);
    await context.addInitScript(() => { window.ogb = { getLocalSession: () => window.__qaLocalSession(), updater: { check: async () => {}, download: async () => {}, install: async () => {}, onState: cb => { cb({ status: 'idle' }); return () => {}; } } }; });
    await context.route('**/*', route => { const origin = new URL(route.request().url()).origin; if (origin === base) return route.continue(); denied.push(origin); return route.abort(); });
    page = await context.newPage(); page.setDefaultTimeout(20_000);
    page.on('pageerror', error => pageErrors.push(error.message));

    await step(1, 'Fresh office link (link code through the loopback website)', async c => {
      await page.goto(base);
      await page.getByRole('heading', { name: 'Make the desk yours', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Continue', exact: true }).isDisabled(), true, 'Continue waits for a name');
      c('Empty state: Continue is disabled until a name is entered');
      await page.getByRole('textbox', { name: 'Your name', exact: true }).focus();
      await page.keyboard.type(PERSON);
      await pressByKeyboard('Continue');
      await page.getByRole('heading', { name: 'Connect this computer to your office', exact: true }).waitFor();
      c(`Keyboard only: typed "${PERSON}" and pressed Continue`);
      await page.getByText('Use a link code instead', { exact: true }).click();
      await page.getByRole('textbox', { name: 'Link code' }).fill(CODE);
      await pressByKeyboard('Connect with this code', { from: page.getByRole('textbox', { name: 'Link code' }) });
      await page.getByRole('heading', { name: 'This computer is connected', exact: true }).waitFor({ timeout: 30_000 });
      const link = await ok('/api/office-link');
      assert.equal(link.state, 'linked'); assert.equal(link.agencyLabel, OFFICE); assert.equal(link.provisioned, true);
      assert.equal(siteCalls.filter(s => s === 'POST /api/installations/redeem').length, 1, 'one redeem');
      c(`Linked to "${OFFICE}" with one redeem on the loopback website; fictional model access provisioned`);
      await widths('linked');
      await pressByKeyboard('Continue to Bud setup');
      const dialog = page.getByRole('dialog', { name: 'Bud status', exact: true });
      await dialog.waitFor();
      await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
      c('Keyboard: Continue to Bud setup, Escape back to Work');
    });

    await step(2, 'Empty state before any work', async c => {
      await railByKeyboard('Desk', '#/desk');
      await page.getByRole('heading', { name: 'Start your office book', exact: true }).waitFor();
      c('Desk: empty office book ("Start your office book")');
      await widths('desk-empty');
      await flows[who].empty(shared, c);
    });

    let book;
    await step(3, 'Harness: fictional book, mail plans and settings for this office', async c => {
      book = await seedBook();
      for (const note of book.notes) c(note);
      await page.reload(); await reconnects();
      c('Not a UI step: the office data a person would set up over days, entered through the same HTTP routes the screens use');
    });
    if (steps.at(-1).status !== 'PASS') throw new Error('Seeding failed; the daily flow cannot run.');

    let n = 4;
    for (const [name, fn] of flows[who].steps) await step(n++, name, c => fn({ ...shared, ids: book.ids }, c));

    await step(n++, 'Service blip: down, Reconnecting, back, work continues', async c => {
      await closeDrawer(page);
      await stopService();
      await page.getByRole('status').filter({ hasText: /^Reconnecting$/ }).waitFor({ timeout: 30_000 });
      await shot('service-down');
      c('Service stopped: the window shows Reconnecting and stays open');
      await rail('Desk').click(); await wait(500);
      await startService();
      await reconnects();
      c('Service back on the same port: the open window reconnects without a reload');
      await flows[who].afterBlip(shared, c);
    });

    await step(n++, 'No renderer errors and no off-origin requests', async c => {
      assert.deepEqual(pageErrors, []); c('0 renderer page errors');
      assert.deepEqual([...new Set(denied)].filter(o => !/^(data|blob):/.test(o)), []); c('0 requests left the local service from the window');
      c(`Loopback website calls: ${siteCalls.length} (${[...new Set(siteCalls)].join(', ')}); Gmail fixture: ${JSON.stringify(gmailCalls)}; Redbark fake: ${redbarkCalls.length}`);
    });
  } catch (error) {
    failure = error instanceof Error ? error.stack : String(error);
    console.error(failure);
  } finally {
    await browser?.close().catch(() => {});
    await stopService().catch(() => {});
    await Promise.all([new Promise(r => lab.close(r)), new Promise(r => redbark.close(r))]);
    const passed = !failure && steps.length > 0 && steps.every(s => s.status === 'PASS');
    writeFileSync(join(out, 'receipt.json'), JSON.stringify({
      at: new Date().toISOString(), person: who, passed,
      layer: 'local tests: built React UI in headless Chrome against the real source service on one fresh temp home; loopback website, Gmail connector, Redbark and REI stand-ins; deterministic worker',
      platform: `${process.platform} ${process.arch}, Node ${process.version}`, today,
      steps: steps.map(({ n, name, status, detail, checks, screenshots }) => ({ n, name, status, ...(detail ? { detail } : {}), checks, screenshots })),
      productBugs, observations, rendererPageErrors: pageErrors, deniedOrigins: [...new Set(denied)],
      calls: { website: siteCalls, gmail: gmailCalls, redbark: redbarkCalls.length },
      ...(failure ? { failure } : {}),
      limits: [
        'Fictional office, people, properties, suppliers, bank rows and REI portal only; not customer acceptance.',
        'Source service plus built renderer in headless Chrome, not the packaged or installed app; Kevin\'s real machine is Windows and is covered separately.',
        'realbud.app is a loopback lab website (link-code redeem and status report). Gmail is a loopback fixture connector behind the office link\'s connector credential; Redbark is a loopback fake; REI is server/testing/fictional-rei-portal.ts through the real browser runtime, broker and recipe runner (w1-lab).',
        'Bud is the deterministic Austin showcase worker (no model). Its readiness receipt is written by the harness, as in seed-austin-demo.',
        'Office data (book, mail plans, W1 settings, maintenance history, inspection rules) is seeded over HTTP after the link; the supplier list and inspection history go through the screens.',
        'The person is simulated: REI sign-in and "processed in REI" are played on the fictional portal by the script.',
        'Desktop widths 1280 and 1024 only (no phone layouts by product direction).',
      ],
    }, null, 2));
    if (!passed) writeFileSync(join(out, 'service.log'), logs.slice(-30_000));
    try { rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (cause) { console.warn(`Temp home not removed: ${temp} (${cause.code ?? cause.message})`); }
    console.log(`${passed ? 'PASSED' : 'FAILED'} ${who}: ${steps.filter(s => s.status === 'PASS').length}/${steps.length} steps · receipt ${join(out, 'receipt.json')}`);
    return { who, passed, steps: steps.map(s => `${s.status} ${s.n}. ${s.name}`), productBugs };
  }
}

// ── Sherry: morning priorities, suppliers, maintenance findings, inspections, approval cards ──
const sherry = {
  async empty({ page, openBills, widths }, c) {
    await openBills();
    const maintenance = page.getByRole('region', { name: 'Maintenance checks' });
    await maintenance.getByText('Import the supplier list, then turn on Maintenance checks in Schedule.', { exact: true }).waitFor();
    c('Maintenance checks: empty, says to import the supplier list first');
    const inspections = page.getByRole('region', { name: 'Inspections', exact: true });
    await inspections.waitFor();
    c('Inspections panel present with no history');
    await widths('sherry-bills-empty', maintenance);
  },
  steps: [
    ['Morning priorities (keyboard: Schedule → job → Run now)', async ({ page, runJob, rail, widths, railByKeyboard }, c) => {
      await railByKeyboard('Schedule', '#/schedule');
      const run = await runJob('Morning priorities', 'inbound-triage');
      assert.ok(['awaiting-approval', 'completed', 'partial'].includes(run.status), JSON.stringify(run));
      c(`Run settled: ${run.status}${run.detail ? ` · ${run.detail}` : ''}`);
      await rail('Desk').click();
      const group = page.getByRole('group', { name: 'Other work', exact: true });
      if (!await group.isVisible().catch(() => false)) await page.locator('.desk-other-work > summary').click();
      await group.getByRole('button', { name: 'Mail priorities', exact: true }).click();
      const panel = page.getByRole('region', { name: 'Mail priorities and follow-ups' }); await panel.waitFor();
      for (const t of seed.mailbox.triage) await panel.getByText(t.subject, { exact: false }).first().waitFor();
      c(`All ${seed.mailbox.triage.length} fictional morning mails listed (many)`);
      await widths('sherry-morning-priorities', panel);
    }],
    ['Supplier directory: one supplier, then the full list', async ({ page, openBills, widths, api }, c) => {
      await openBills();
      const panel = page.getByRole('region', { name: 'Maintenance checks' });
      const lines = readFileSync(join(showcase, 'fixtures/supplier-directory.csv'), 'utf8').trim().split('\n');
      const input = panel.locator('input[type="file"]');
      await input.setInputFiles({ name: 'fictional-one-supplier.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.slice(0, 2).join('\n')) });
      const one = await panel.getByRole('status').filter({ hasText: /^Imported 1 / }).first().innerText();
      assert.match(one, /^Imported 1 supplier · /, `one supplier reads in the singular: "${one}"`);
      c(`One supplier: "${one}" (singular)`);
      await panel.getByText(/^1 supplier\b/).first().waitFor();
      await widths('sherry-one-supplier', panel);
      await input.setInputFiles({ name: 'fictional-suppliers.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n')) });
      await panel.getByText(`Imported ${lines.length - 1} suppliers · 0 without email · 0 conflicts.`, { exact: true }).waitFor();
      const review = await api('/api/maintenance-review');
      assert.equal(review.directory.suppliers, lines.length - 1);
      c(`Full list: ${lines.length - 1} suppliers imported through the Maintenance checks file control (many)`);
    }],
    ['Maintenance findings: run, chat card, open, review', async ({ page, runJob, rail, openBills, widths, api }, c) => {
      const run = await runJob('Maintenance checks', 'maintenance-review');
      assert.match(run.detail ?? '', /findings? to review/, JSON.stringify(run));
      c(`Run: ${run.detail}`);
      await rail('Work').click();
      const card = page.locator('div.rounded-2xl').filter({ hasText: /^Maintenance checks/ }).first();
      await card.waitFor({ timeout: 30_000 });
      await widths('sherry-chat-card', card);
      await card.getByRole('button', { name: /Open$/ }).click();
      await page.waitForURL(url => url.hash.startsWith('#/desk'));
      c('Chat card in Work; Open goes to Desk');
      await openBills();
      const panel = page.getByRole('region', { name: 'Maintenance checks' });
      const repeat = panel.getByRole('listitem', { name: /^Several invoices this month · 1 Fictional Oak Street/ });
      await repeat.waitFor();
      for (const text of ['FIC-PLUMB', 'Invoice INV-1001', 'Invoice INV-1002']) assert.ok((await repeat.innerText()).includes(text), `finding shows ${text}`);
      c('Repeat supplier: FIC-PLUMB on 1 Fictional Oak Street with INV-1001 and INV-1002 (reminder and forward counted once)');
      const held = panel.getByRole('listitem', { name: /^Sender needs checking/ });
      await held.first().waitFor();
      c(`Ambiguous/unknown sender held as "Sender needs checking" (${await held.count()}), never matched by display name or domain`);
      assert.equal(await panel.getByRole('listitem', { name: /^Sender not verified/ }).count(), 0, 'Gmail-confirmed supplier mail is not unverified');
      await widths('sherry-findings', panel);
      const name = await repeat.getAttribute('aria-label');
      await panel.getByRole('button', { name: `Mark seen: ${name}`, exact: true }).focus(); await page.keyboard.press('Enter');
      await panel.getByRole('button', { name: `Mark seen: ${name}`, exact: true }).waitFor({ state: 'detached' });
      c('Keyboard: Mark seen on the repeat-supplier finding');
      const review = await api('/api/maintenance-review');
      assert.equal(review.findings.find(f => f.finding.kind === 'multiple-invoices').state, 'seen');
    }],
    ['Restart mid-flow, then approve then Stop: REI supplier refresh', async ({ page, openBills, widths, ok, labAct, until, stopService, startService, reconnects, observations, productBugs, shot }, c) => {
      await labAct('handover');
      await openBills();
      const panel = page.getByRole('region', { name: 'Refresh supplier list from REI', exact: true });
      const before = (await ok('/api/rei-directory/status')).suppliers;
      await panel.getByRole('button', { name: 'Refresh supplier list from REI', exact: true }).click();
      await until(async () => (await ok('/api/rei-directory/status')).run?.signIn, 'supplier refresh waits for REI sign-in');
      await page.getByRole('region', { name: 'Sign in to REI Cloud', exact: true }).waitFor();
      c('Signed out at REI: the "Sign in to REI Cloud" handover shows; Bud never types a password');
      await panel.getByRole('button', { name: 'Stop', exact: true }).waitFor();
      c('Stop shows on the refresh while Bud waits at REI sign-in');
      const waiting = (await ok('/api/rei-directory/status')).run;
      let stale = false;
      await stopService(); await wait(3000); await startService(); await reconnects(); // a restart that takes a few seconds
      await wait(1500);
      const afterRestart = await ok('/api/rei-directory/status');
      assert.deepEqual(afterRestart.suppliers, before, 'nothing saved by the interrupted refresh');
      if (afterRestart.run?.id === waiting.id && afterRestart.run.signIn) c('Restart mid-flow: the same refresh still waits at REI sign-in');
      else {
        c(`Restart mid-flow: the manual refresh did not survive the restart (server: ${afterRestart.run ? afterRestart.run.phase : 'no run'}); nothing saved`);
        observations.push({ step: 'sherry-rei-refresh-restart', note: 'A manual "Refresh supplier list from REI" waiting at REI sign-in does not survive a service restart; nothing is saved. By design only the scheduled Supplier list check survives a restart (server/rei-directory-sync.ts header).' });
        // The panel polls through the blip with a bounded backoff (src/lib/run-poll.ts, at most 5 s apart) and reconciles with the server by itself.
        const refresh = panel.getByRole('button', { name: 'Refresh supplier list from REI', exact: true });
        stale = !(await until(async () => !(await refresh.isDisabled()) && !(await panel.getByText(/^Waiting for you to sign in to REI Cloud/).isVisible()), 'the open panel reconciles after the blip', 15_000).catch(() => false));
        if (!stale) c('The open panel reconciled with the server by itself after the blip: no waiting copy, Refresh available, no reopening');
        if (stale) {
          const file = await shot('sherry-stale-refresh-after-restart');
          productBugs.push({ title: 'REI list refresh panel stays on "Waiting for you to sign in... Bud carries on by itself" after a service blip; Refresh stays disabled',
            repro: ['Bills -> Maintenance checks -> "Refresh supplier list from REI" while REI is signed out (panel: "Waiting for you to sign in to REI Cloud. Bud carries on by itself once you\'re signed in")', 'Stop the local service, start it again; the window shows Reconnecting, then App connected', 'Wait: the panel keeps the waiting copy and "Refresh from REI" stays disabled, although GET /api/rei-directory/status has no run', 'Only leaving and reopening Bills clears it'],
            cause: 'src/components/ReiDirectoryRefresh.tsx polls with a setTimeout keyed on [status]; a failed poll is swallowed (.catch(() => {})) without changing status, so no further poll is scheduled. W1RunPanel in src/components/schedule/BankReferenceReview.tsx uses the same pattern while status.working.',
            screenshot: file });
          c('PRODUCT BUG: after the blip the panel still says Bud carries on by itself and Refresh stays disabled; polling stopped on the failed request (see productBugs)');
          await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Work', exact: true }).click();
          await openBills();
        }
        await until(async () => !(await refresh.isDisabled()), stale ? 'Refresh is available again after reopening Bills' : 'Refresh is available', 15_000);
        if (stale) c('Leaving and reopening Bills clears the stale panel; Refresh is available again');
        await labAct('handover');
        await refresh.focus(); await page.keyboard.press('Enter');
        await until(async () => (await ok('/api/rei-directory/status')).run?.signIn, 'refresh waits for REI sign-in again');
      }
      await labAct('sign-in');
      const card = panel.getByRole('group', { name: 'Approval for REI', exact: true });
      await card.getByText('Allow Bud to choose Export Only on REI\'s report?', { exact: true }).waitFor({ timeout: 60_000 });
      await widths('sherry-approval-export-only', card);
      await card.getByRole('button', { name: 'Allow', exact: true }).click();
      c('Approved once: Export Only');
      await card.getByText('Allow Bud to download REI\'s supplier list?', { exact: true }).waitFor({ timeout: 60_000 });
      await card.getByRole('button', { name: 'Stop', exact: true }).focus(); await page.keyboard.press('Enter');
      await card.waitFor({ state: 'detached', timeout: 30_000 });
      const after = await until(async () => { const s = await ok('/api/rei-directory/status'); return !s.run?.working ? s : null; }, 'refresh stops');
      assert.deepEqual(after.suppliers, before, 'the supplier list is unchanged after Stop');
      const effects = (await labAct('status')).effects;
      assert.ok(!effects.includes('download'), `nothing downloaded after Stop: ${effects}`);
      await widths('sherry-after-stop', panel);
      c(`Keyboard: Stop at the download card; the run ends (${after.run?.phase ?? 'no run'}${after.run?.message ? `: ${after.run.message}` : ''}); the saved REI supplier list is unchanged`);
      if (stale) throw new Error('Product bug: the REI refresh panel kept a stale "Bud carries on by itself" state after the service blip (flow completed after reopening Bills; see productBugs).');
    }],
    ['Inspection plan: history, draft, accept one', async ({ page, openBills, widths, ok, today }, c) => {
      await openBills();
      const panel = page.getByRole('region', { name: 'Inspections', exact: true });
      await panel.locator('input[type="file"]').setInputFiles({ name: 'fictional-inspection-history.csv', mimeType: 'text/csv', buffer: readFileSync(join(showcase, 'fixtures/inspection-history.csv')) });
      let view = await until(async () => { const v = await ok('/api/inspections'); return Object.keys(v.history?.records ?? {}).length ? v : null; }, 'history imported');
      c(`History imported through the file control: ${Object.keys(view.history.records).length} matched, ${view.history.unmatched.length} held`);
      const start = panel.getByLabel('Plan from', { exact: true });
      if (await start.count()) await start.fill(addDays(today, 1));
      await panel.getByRole('button', { name: /^(Draft plan|Redraft plan)$/ }).click();
      await panel.getByRole('list', { name: 'Draft plan by day', exact: true }).waitFor();
      view = await ok('/api/inspections');
      const plan = view.plan.draft.plan;
      assert.ok(plan.appointments.length > 0, 'draft has visits');
      c(`Draft: ${plan.appointments.length} visits, ${plan.holds.length} held (${[...new Set(plan.holds.map(h => h.kind))].join(', ') || 'none'}); labelled "not booked in Property Inspect"`);
      await widths('sherry-inspection-draft', panel);
      const pick = plan.appointments.find(a => a.status === 'draft');
      const row = panel.locator(`[data-appointment-id="${pick.id}"]`);
      await row.getByRole('checkbox').focus(); await page.keyboard.press('Space');
      await panel.getByRole('button', { name: 'Accept selected (1)', exact: true }).focus(); await page.keyboard.press('Enter');
      await panel.getByText('1 accepted into the plan.').waitFor();
      view = await ok('/api/inspections');
      assert.equal(view.plan.draft.plan.appointments.find(a => a.id === pick.id).status, 'accepted');
      c('Keyboard: selected one visit and accepted it (one item)');
    }],
    ['Approval card: Sherry asks Bud to change her maintenance rule', async ({ page, rail, widths, ok }, c) => {
      await rail('Work').click();
      const composer = page.getByRole('textbox', { name: 'Tell Bud what outcome you need', exact: true });
      await composer.fill(seed.sherryRules.scriptedChange.ask);
      await composer.focus(); await page.keyboard.press('Enter');
      const allow = page.getByRole('button', { name: 'Allow once', exact: true });
      await allow.waitFor({ timeout: 60_000 });
      const body = await page.locator('body').innerText();
      for (const text of ['maintenance month rule', 'invoice date → date received']) assert.ok(body.includes(text), `card shows "${text}"`);
      c('Card shows before → after in plain words (invoice date → date received)');
      await widths('sherry-rule-card');
      await allow.focus(); await page.keyboard.press('Enter');
      await page.getByText('Saved the maintenance month rule', { exact: false }).first().waitFor({ timeout: 60_000 });
      assert.equal((await ok('/api/maintenance-review')).rule.basis, 'receivedDate');
      c('Keyboard: Allow once saved the rule (basis receivedDate)');
    }],
    ['Restart at the end of the day: findings, suppliers, plan and rule are kept', async ({ page, ok, startService, stopService, reconnects, openBills, widths }, c) => {
      const before = { review: await ok('/api/maintenance-review'), inspections: await ok('/api/inspections') };
      await stopService(); await startService(); await reconnects();
      const review = await ok('/api/maintenance-review'), inspections = await ok('/api/inspections');
      assert.deepEqual(review.findings.map(f => [f.finding.id, f.state]), before.review.findings.map(f => [f.finding.id, f.state]));
      assert.equal(review.directory.suppliers, before.review.directory.suppliers);
      assert.deepEqual(review.rule, before.review.rule);
      assert.deepEqual(inspections.plan.draft.plan.appointments.map(a => [a.id, a.status]), before.inspections.plan.draft.plan.appointments.map(a => [a.id, a.status]));
      c('After a service restart: finding states, supplier list, accepted visit and the approved rule are unchanged');
      await openBills();
      await page.getByRole('region', { name: 'Maintenance checks' }).getByRole('listitem', { name: /^Several invoices this month/ }).waitFor();
      await widths('sherry-after-restart', page.getByRole('region', { name: 'Maintenance checks' }));
    }],
  ],
  async afterBlip({ page, openBills }, c) {
    await openBills();
    await page.getByRole('region', { name: 'Maintenance checks' }).getByRole('listitem', { name: /^Several invoices this month/ }).waitFor();
    c('Maintenance checks load again after the blip');
  },
};

// ── Kevin: arrears, weekly bills to the calendar, bank review, REI upload ──
/** Closes the open Schedule job drawer with the keyboard (focus Close, Enter). */
async function closeDrawer(page) {
  const close = page.getByRole('dialog').getByRole('button', { name: /^Close/ }).first();
  if (!await close.isVisible().catch(() => false)) return;
  await close.focus(); await page.keyboard.press('Enter'); await close.waitFor({ state: 'hidden' });
}
async function bankStrip(page) { return page.getByRole('region', { name: 'Bank import', exact: true }); }
const kevin = {
  async empty({ page, openBills, widths, openJob }, c) {
    const panel = await openBills();
    await panel.getByRole('region', { name: 'Bill calendar', exact: true }).waitFor();
    c('Bills and calendar opens with no accepted bills');
    await widths('kevin-bills-empty', panel);
    await openJob('Bank reference review');
    await page.getByRole('region', { name: 'Set up bank imports' }).or(page.getByRole('region', { name: 'Bank import', exact: true })).first().waitFor();
    c('Bank reference review: no import yet (set-up form before any settings)');
    await widths('kevin-bank-empty');
    await closeDrawer(page);
  },
  steps: [
    ['Arrears on Desk from the REI ledger', async ({ page, railByKeyboard, ok, widths }, c) => {
      await railByKeyboard('Desk', '#/desk');
      const desk = await ok('/api/desk');
      const late = seed.reiLedger.rows.filter(r => !r.rentLanded).map(r => property(r.code).address);
      const text = await page.locator('main').innerText();
      for (const address of late) assert.ok(text.includes(address.split(',')[0]), `Desk shows ${address}`);
      c(`Desk cards from the REI ledger: ${desk.drafts.length}; rent not landed for ${late.map(a => a.split(',')[0]).join(' and ')}`);
      await widths('kevin-arrears-desk');
    }],
    ['Weekly bills: run, accept one, see it on the calendar', async ({ page, runJob, openBills, widths, ok, ids, today, observations }, c) => {
      const run = await runJob('Weekly bills review', 'weekly-bills');
      c(`Run settled: ${run.status}${run.detail ? ` · ${run.detail}` : ''}`);
      const drafts = (await ok('/api/bill-review-drafts?filter=active&limit=20')).items;
      assert.ok(drafts.length >= 2, `many drafts (${drafts.length})`);
      c(`${drafts.length} review drafts (many) and 0 payable bills until accepted`);
      const bill = seed.mailbox.bills.find(b => b.threadId === 'c202'), draft = drafts.find(d => d.messageId === bill.messageId);
      const panel = await openBills();
      await widths('kevin-review-drafts', panel);
      await acceptBill(page, panel, draft, bill, ids, today, observations);
      const register = await ok(`/api/bill-register?from=${addDays(today, -30)}&to=${addDays(today, 90)}`);
      const accepted = register.occurrences.items.filter(o => o.source?.message?.id === bill.messageId);
      assert.equal(accepted.length, 1, 'one accepted bill');
      const { dueDate } = billFacts(bill, today);
      assert.equal(register.calendar.items.find(e => e.type === 'invoice-due' && e.billId === accepted[0].id)?.date, dueDate);
      await openDay(page, panel, dueDate);
      c(`${bill.vendor} ${bill.invoiceId} accepted (one item) and shown on the calendar due ${dueDate}`);
      await widths('kevin-calendar-due', panel.getByRole('region', { name: 'Bill calendar', exact: true }));
    }],
    ['Duplicate bill: the forwarded copy is held, not added twice', async ({ page, openBills, widths, ok, ids, today }, c) => {
      const drafts = (await ok('/api/bill-review-drafts?filter=active&limit=20')).items;
      const original = seed.mailbox.bills.find(b => b.threadId === 'c202'), fwd = seed.mailbox.bills.find(b => b.threadId === 'c203'), draft = drafts.find(d => d.messageId === fwd.messageId);
      assert.ok(draft, `forwarded draft: ${JSON.stringify(drafts.map(d => d.messageId))}`);
      const panel = await openBills();
      // Kevin types what the forwarded invoice says: the same FC-3304 facts as the original.
      const editor = await fillBill(page, panel, draft, { ...fwd, daysAgo: original.daysAgo, dueInDays: original.dueInDays }, ids, today);
      const matches = editor.getByRole('complementary', { name: 'Matching saved bills' });
      await matches.getByText('This invoice number already appears for the same property and vendor.', { exact: false }).waitFor();
      const accept = editor.getByRole('button', { name: 'Accept reviewed bill', exact: true });
      c(`Forwarded FC-3304: "This invoice number already appears for the same property and vendor…" with the saved bill listed; Accept ${await accept.isDisabled() ? 'is held (disabled)' : 'stays enabled'} until "I checked the matching bills…" is ticked`);
      await widths('kevin-duplicate-held', matches);
      if (!await accept.isDisabled()) {
        await accept.click();
        await editor.getByText(/matching bills|separate invoice/i).first().waitFor();
      }
      const register = await ok(`/api/bill-register?from=${addDays(today, -30)}&to=${addDays(today, 90)}`);
      assert.equal(register.occurrences.items.filter(o => o.source?.message?.id === fwd.messageId).length, 0, 'forwarded copy not saved as a second bill');
      assert.equal(register.occurrences.items.filter(o => o.facts?.invoiceNumber === original.invoiceId).length, 1, 'one FC-3304 bill');
      c('Register still holds one FC-3304 bill; the forwarded copy is not saved');
      await editor.getByRole('button', { name: 'Save for later', exact: true }).click();
      await editor.waitFor({ state: 'hidden' });
      c('Saved for later: the forwarded review stays in Saved bill reviews');
    }],
    ['Bank reconciliation review: pull, ambiguous row held, save', async ({ page, openJob, widths, ok, ledger }, c) => {
      await openJob('Bank reference review');
      const strip = await bankStrip(page);
      await strip.getByRole('button', { name: 'Start bank import', exact: true }).focus(); await page.keyboard.press('Enter');
      await strip.getByText('Review the pulled transactions', { exact: false }).first().waitFor({ timeout: 60_000 });
      await strip.getByRole('button', { name: 'Open pulled transactions', exact: true }).click();
      const cards = page.locator('article.border').filter({ has: page.getByLabel('Your decision', { exact: true }) });
      await cards.first().waitFor();
      const posted = ledger.filter(r => r.status === 'posted');
      assert.equal(await cards.count(), posted.length, `pending row left out (${await cards.count()} cards)`);
      await widths('kevin-bank-review', cards.first());
      const firstPass = page.getByRole('region', { name: 'First pass', exact: true });
      c(`First pass: "${(await firstPass.locator('p').first().innerText()).trim()}"`);
      const exceptionRow = firstPass.getByRole('list', { name: 'First-pass exceptions', exact: true }).getByRole('listitem').filter({ hasText: `Unknown reference ${AMBIGUOUS.reference}` });
      await exceptionRow.waitFor();
      assert.equal(await exceptionRow.getByRole('button', { name: 'Import', exact: true }).isDisabled(), true, 'Import is disabled for an unknown reference');
      c(`Ambiguous row "${AMBIGUOUS.reference}" (A$${money(AMBIGUOUS.amountCents)}) is an exception: "Unknown reference", Import disabled; Bud suggests no tenant`);
      await widths('kevin-bank-ambiguous', exceptionRow);
      await exceptionRow.getByRole('button', { name: 'Hold', exact: true }).focus(); await page.keyboard.press('Enter');
      let held = 0;
      for (let i = 0; i < posted.length; i++) {
        const card = cards.nth(i), heading = (await card.innerText()).split('\n')[0], ref = /FT-[A-Z0-9]+/.exec(heading)?.[0];
        const match = seed.properties.find(p => p.tenant.reiTenantRef === ref);
        const decision = card.getByLabel('Your decision', { exact: true });
        if (!match) {
          assert.ok(heading.includes(AMBIGUOUS.reference), `only the ambiguous row lacks a tenant reference: ${heading}`);
          if (await decision.inputValue() !== 'keep') await decision.selectOption('keep');
          await card.getByLabel('Review reason', { exact: true }).fill('Fictional: reference names no tenant; hold for Kevin');
          held++; continue;
        }
        await decision.selectOption(match.code);
        await card.getByLabel('Review reason', { exact: true }).fill('Fictional: reference matches the tenant directory');
      }
      assert.equal(held, 1, 'exactly one row held');
      await page.getByRole('button', { name: 'Save reviewed copy', exact: true }).click();
      await strip.getByText('Review saved', { exact: false }).first().waitFor();
      c(`${posted.length - held} rows imported to their tenant, 1 held with its original reference; reviewed copy saved`);
    }],
    ['Restart mid-flow: waiting for REI sign-in survives a restart', async ({ page, ok, stopService, startService, reconnects, widths, openJob }, c) => {
      const strip = await bankStrip(page);
      await strip.getByRole('button', { name: 'Continue', exact: true }).click();
      await strip.getByText('Waiting for you to sign in to REI', { exact: false }).first().waitFor({ timeout: 60_000 });
      const before = (await ok('/api/w1/status')).run;
      await widths('kevin-rei-sign-in', strip);
      c('Waiting for the person to sign in to REI; Bud never types a password');
      await stopService(); await startService(); await reconnects();
      const after = (await ok('/api/w1/status')).run;
      assert.equal(after.id, before.id); assert.equal(after.step, before.step);
      await closeDrawer(page);
      await openJob('Bank reference review');
      await (await bankStrip(page)).getByText('Waiting for you to sign in to REI', { exact: false }).first().waitFor({ timeout: 30_000 });
      c(`After a service restart the same run (${after.id.slice(0, 14)}…) still waits at REI sign-in`);
    }],
    ['REI receipting upload approved once on the fictional REI portal', async ({ page, ok, labAct, widths, until }, c) => {
      const strip = await bankStrip(page);
      await labAct('sign-in');
      await strip.getByRole('button', { name: 'Continue', exact: true }).click();
      const asks = [];
      for (let i = 0; i < 10; i++) {
        const now = await until(async () => { const v = await ok('/api/w1/status'); return v.ask || (!v.working && !['sign_in', 'upload'].includes(v.run?.step)) ? v : null; }, 'REI asks or moves past upload', 60_000);
        if (!now.ask) break;
        asks.push(now.ask.tool);
        const headline = now.ask.tool === 'browser_upload' ? 'Allow Bud to upload the reviewed file to REI?' : now.ask.tool === 'browser_download' ? "Allow Bud to download REI's receipt list to check the result?" : 'Allow this step in REI?';
        await strip.getByText(headline, { exact: true }).waitFor();
        if (now.ask.tool === 'browser_upload') await widths('kevin-upload-approval', strip);
        await strip.getByRole('button', { name: 'Allow', exact: true }).focus(); await page.keyboard.press('Enter');
        await until(async () => (await ok('/api/w1/status')).ask?.requestId !== now.ask.requestId, 'ask answered', 15_000);
      }
      assert.equal(asks.filter(t => t === 'browser_upload').length, 1, `upload approved once: ${asks}`);
      c(`REI asks answered by keyboard: ${asks.join(', ')} (the upload exactly once)`);
      await strip.getByText('Preview matches · Ready for you to process in REI', { exact: false }).first().waitFor({ timeout: 60_000 });
      const effects = (await labAct('status')).effects;
      assert.deepEqual(effects, ['upload'], `one upload, nothing posted: ${effects}`);
      c('Upload approved once; REI\'s preview matches; Bud pressed nothing that posts');
      await widths('kevin-preview-ready', strip);
    }],
    ['Approve then Stop: upload approved, then Stop at the result check, then finish', async ({ page, ok, labAct, widths, until }, c) => {
      const strip = await bankStrip(page);
      await labAct('process');
      const stop = strip.getByRole('button', { name: 'Stop', exact: true });
      await strip.getByRole('button', { name: "I've processed it in REI", exact: true }).click();
      const asked = strip.getByText("Allow Bud to download REI's receipt list to check the result?", { exact: true });
      // While the stage works (before REI's ask) the strip reads "Working…"; it may pass too quickly to see.
      const working = await until(async () => (await asked.isVisible()) ? 'ask' : (await strip.getByText('Working…', { exact: true }).isVisible()) ? ((await stop.isVisible()) ? 'working+stop' : 'working-no-stop') : null, 'the result check starts', 60_000);
      assert.notEqual(working, 'working-no-stop', 'Stop shows while the bank import works');
      if (working === 'working+stop') c('While Bud works on the result check the strip shows "Working…" with Stop');
      await asked.waitFor({ timeout: 60_000 });
      const offered = await strip.getByRole('button').allInnerTexts();
      assert.deepEqual(offered, ['Allow', "Don't allow", 'Stop'], `the strip offers Stop at the REI ask: ${offered}`);
      c(`At the result-check approval the strip offers: ${offered.join(' / ')}`);
      const effectsBefore = (await labAct('status')).effects;
      await stop.focus(); await page.keyboard.press('Enter');
      const stopped = await until(async () => { const s = await ok('/api/w1/status'); return !s.working && !s.ask ? s : null; }, 'the run stops after Stop');
      assert.notEqual(stopped.run.outcome, 'imported', 'not confirmed without the read-back');
      assert.match(stopped.note ?? '', /^Stopped\. Bud did nothing more in REI/, `Stop note: ${stopped.note}`);
      await strip.getByText('Stopped. Bud did nothing more in REI.', { exact: false }).first().waitFor();
      assert.equal(await stop.count(), 0, 'Stop leaves once nothing runs');
      assert.deepEqual((await labAct('status')).effects, effectsBefore, 'nothing more uploaded or downloaded after Stop');
      c(`Keyboard: Stop at the download ask; the run ends cleanly at "${stopped.run.step}", is not marked imported, the strip says "Stopped. Bud did nothing more in REI." and nothing more is uploaded (REI effects: ${effectsBefore.join(', ')})`);
      await widths('kevin-after-stop', strip);
      const trail = [];
      const allow = strip.getByRole('button', { name: 'Allow', exact: true }), next = strip.getByRole('button', { name: /^(Continue|Check again|Check REI|Try again)$/ }).first();
      for (let i = 0; i < 8; i++) {
        const state = await until(async () => {
          if (await strip.getByText('Last import confirmed', { exact: false }).first().isVisible()) return 'done';
          if (await allow.isVisible() && await allow.isEnabled()) return 'ask';
          if (await next.isVisible() && await next.isEnabled()) return 'next';
          return null;
        }, 'the strip offers the next action', 60_000);
        const now = await ok('/api/w1/status');
        trail.push(`${now.run.step}${now.run.attention ? `/${now.run.attention.reason}` : ''}${now.ask ? ` ask:${now.ask.tool}` : ''}`);
        if (state === 'done') break;
        if (state === 'ask') { trail.push('Allow'); await allow.click(); }
        else { trail.push(`press ${await next.innerText()}`); await next.click(); }
        await wait(500);
      }
      c(`After Stop: ${trail.join(' → ')}`);
      await strip.getByText('Last import confirmed', { exact: false }).first().waitFor({ timeout: 60_000 });
      const done = await ok('/api/w1/status');
      assert.equal(done.run.outcome, 'imported');
      c(`Resumed: read back ${done.readback.accepted} accepted · ${done.readback.rejected} rejected · ${done.readback.pending} pending`);
      assert.ok((await labAct('status')).effects.every(e => e === 'upload'), 'Bud pressed nothing that posts');
      await widths('kevin-readback', strip);
    }],
  ],
  async afterBlip({ page, openJob }, c) {
    await openJob('Bank reference review');
    await (await bankStrip(page)).getByText('Last import confirmed', { exact: false }).first().waitFor({ timeout: 30_000 });
    c('Bank import shows the confirmed import after the blip');
    await closeDrawer(page);
  },
};

async function fillBill(page, panel, draft, bill, ids, today) {
  await panel.locator(`[data-review-id="${draft.id}"]`).getByRole('button', { name: 'Continue saved review', exact: true }).click();
  const editor = panel.getByRole('form', { name: 'Review source bill' });
  await editor.getByRole('complementary', { name: 'Bill source evidence' }).waitFor();
  const { invoiceDate, dueDate } = billFacts(bill, today);
  await editor.getByLabel('Bill property', { exact: false }).selectOption(ids[bill.property]);
  await editor.getByLabel('Bill kind', { exact: false }).fill(bill.kind);
  await editor.getByLabel('Vendor', { exact: false }).fill(bill.vendor);
  await editor.getByLabel('Amount (AUD)', { exact: false }).fill(money(bill.amountCents));
  await editor.getByLabel('Invoice date, if confirmed', { exact: false }).fill(invoiceDate);
  await editor.getByLabel('Actual due date, if confirmed', { exact: false }).fill(dueDate);
  await editor.getByLabel('Invoice number, if confirmed', { exact: true }).fill(bill.invoiceId);
  await editor.getByLabel('Reason for this bill review', { exact: false }).fill('Fictional: checked against the synthetic original');
  await editor.getByLabel('I reviewed this source', { exact: false }).check();
  const ack = editor.getByLabel('I understand attachment contents', { exact: false }); if (await ack.count()) await ack.check();
  // The matching-bill check runs as facts change; a person presses Accept once it has finished.
  await editor.getByRole('complementary', { name: 'Matching saved bills' }).getByRole('button', { name: 'Recheck matching bills', exact: true }).waitFor();
  return editor;
}
async function acceptBill(page, panel, draft, bill, ids, today, observations) {
  const editor = await fillBill(page, panel, draft, bill, ids, today);
  const accept = editor.getByRole('button', { name: 'Accept reviewed bill', exact: true });
  await accept.focus(); await page.keyboard.press('Enter');
  if (!await editor.waitFor({ state: 'hidden', timeout: 8_000 }).then(() => true, () => false)) {
    observations.push({ step: 'weekly-bills', note: `Enter on a focused, ${await accept.isDisabled() ? 'disabled' : 'enabled'} "Accept reviewed bill" did not close the review within 8 s (focused: ${await accept.evaluate(el => el === document.activeElement)}); clicked instead.` });
    await accept.click();
  }
  try { await editor.waitFor({ state: 'hidden' }); }
  catch { throw new Error(`Accept did not close the review. Alerts: ${(await editor.locator('[role=alert], [role=status]').allInnerTexts()).join(' | ').replace(/\s+/g, ' ').slice(0, 900)}`); }
}
async function openDay(page, panel, dueDate) {
  const calendar = panel.getByRole('region', { name: 'Bill calendar', exact: true });
  const months = Array.from({ length: 12 }, (_, m) => new Intl.DateTimeFormat('en-AU', { month: 'long', timeZone: 'UTC' }).format(Date.UTC(2026, m, 1)));
  const [y, m, d] = dueDate.split('-').map(Number);
  const [shownMonth, shownYear] = (await calendar.getByRole('heading', { level: 4 }).innerText()).split(' ');
  for (let at = Number(shownYear) * 12 + months.indexOf(shownMonth); at < y * 12 + m - 1; at++) {
    await calendar.getByRole('button', { name: 'Next month', exact: true }).click();
    await calendar.getByRole('heading', { name: `${months[(at + 1) % 12]} ${Math.floor((at + 1) / 12)}`, exact: true }).waitFor();
  }
  await calendar.getByRole('button', { name: new RegExp(`^${d} ${months[m - 1]}:`) }).click();
  const label = await page.evaluate(v => new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${v}T00:00:00Z`)), dueDate);
  const day = calendar.getByRole('region', { name: `Bills on ${label}`, exact: true }); await day.waitFor();
  await day.getByText(`Due · ${label}`, { exact: true }).waitFor();
}

const flows = { sherry, kevin };
const results = [];
for (const who of people) results.push(await runPerson(who));
writeFileSync(join(output, 'summary.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
for (const r of results) { console.log(`\n${r.who}: ${r.passed ? 'PASSED' : 'FAILED'}`); for (const s of r.steps) console.log(`  ${s}`); }
if (!results.every(r => r.passed)) process.exitCode = 1;
