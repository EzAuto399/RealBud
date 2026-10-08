// Source-rendered Bud status QA. Fictional status fixtures; no worker/provider calls.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROME_EXECUTABLE=/path/to/chrome node scripts/qa-bud-status.mjs [--baseline]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { serviceSmokeEnv } from './service-smoke-env.mjs';
import { readSessionToken, primeBrowserSession } from './local-session.mjs';

const serveOnly = process.argv.includes('--serve-only');
if (!serveOnly) assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE to an installed Playwright module.');
const chromium = serveOnly ? null : (await import(process.env.PLAYWRIGHT_MODULE)).chromium;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = process.argv.includes('--baseline');
const baselinePaths = ['src/components/ChatView.tsx', 'src/components/AskReadiness.tsx', 'src/components/BudSetupCard.tsx', 'src/components/ManagedBudStatus.tsx', 'src/components/WorkspaceSetup.tsx', 'src/components/AskWorkspaceSheet.tsx', 'src/lib/bud-setup.ts'];
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const testedPaths = [...baselinePaths, 'src/App.tsx', 'src/components/BudSetupScreen.tsx', 'src/lib/bud-status-monitor.ts', 'src/state/store.tsx', 'src/lib/boot-heal.ts', 'src/components/ConnectOffice.tsx', 'src/components/you/browser-link.ts'];
const sourceHashes = () => Object.fromEntries(testedPaths.filter(p => existsSync(join(root, p))).map(p => [p, createHash('sha256').update(readFileSync(join(root, p))).digest('hex')]));
const startHashes = sourceHashes();
const baselineSources = new Map(baseline ? baselinePaths.map(path => [join(root, path), execFileSync('git', ['show', `HEAD:${path}`], { cwd: root, encoding: 'utf8' })]) : []);
const output = resolve(process.env.QA_OUTPUT ?? join(root, 'outputs/bud-status-2026-09-27', baseline ? 'before' : 'after'));
assert.ok(!existsSync(output), 'Choose a fresh QA_OUTPUT; existing evidence is preserved.');
mkdirSync(output, { recursive: true });
const temp = mkdtempSync(join(realpathSync(tmpdir()), 'realbud-bud-status-'));
const data = join(temp, 'data'); mkdirSync(data, { mode: 0o700 });
const ready = {
  pin: { product: '0.21.3', tag: 'v2026.9.14', commit: 'fictional-fixture', profile: 'property' },
  cli: { installed: true, compatible: true, matchesPin: true, probeState: 'ok', versionText: 'Hermes Agent v0.21.3 (2026.9.14)' },
  pack: { installed: true, approvalsManual: true, workroomReady: true },
  homeDir: '/synthetic/home', profileDir: '/synthetic/home/profiles/property', installCommand: null, signInCommand: 'fictional-sign-in',
  ready: true, detail: 'Fictional verified readiness.', model: { attached: true, provider: 'openai-api', model: 'fictional-model' },
  modelAccess: { managed: true, withdrawn: false, attached: true, detail: 'Model access is managed by the RealBud service.' },
  lastPing: { at: Date.now(), ok: true, kind: 'ping', detail: 'Fictional private readiness check passed.' }, readyOnce: true,
};
const safeguards = { ...ready, ready: false, pack: { installed: true, approvalsManual: true, workroomReady: false }, lastPing: null };
let fixture = structuredClone(safeguards), failRefresh = false, delayRefresh = 0, managed = true;
let officeFixture = { state: 'unlinked' }, retryFailure = false, retryDelay = 0, officeReadInFlight = 0;
let qaConnected = true, qaRecovering = false;
const qaSubscribers = new Set();
const counts = { statusReads: 0, officeReads: 0, maxConcurrentOfficeReads: 0, hermesMutations: [], externalRequests: [] };
const checks = [], screenshots = [], errors = [], findings = [], observations = {};
let child, childClosed, vite, browser, page, stopFixture, logs = '', failure = null;
const wait = ms => new Promise(r => setTimeout(r, ms));
async function freePort() { const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function until(fn, label, timeout = 20_000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn().catch(() => false)) return; await wait(100); } throw new Error(`Timed out: ${label}`); }
const limits = [
  'Source renderer with real application store and real isolated local service; worker status and administrator policy are fictional network fixtures.',
  'The QA Vite server adds an in-memory state bridge to force offline/recovery states; production files are not modified by that instrumentation.',
  serveOnly
    ? 'Office-link writes and worker mutations are intercepted by fictional middleware. Browser egress is not independently audited in serve-only mode; no live provider, worker, customer account or installed application is part of this fixture.'
    : 'All Hermes API mutations and all non-loopback browser requests are intercepted. No provider, worker, customer account, installed application or hosted integration is exercised.',
  'Screenshots and keyboard checks prove source-rendered behavior only; no packaged, installed-device, live integration or customer acceptance is claimed.',
];
const missingWorker = { ...ready, ready: false, readyOnce: false, cli: { ...ready.cli, installed: false, probeState: 'missing' },
  pack: { installed: false, approvalsManual: false, workroomReady: false }, model: { attached: false, provider: null, model: null },
  modelAccess: { managed: false, withdrawn: false, attached: false, detail: '' }, lastPing: null,
  autoSetup: { state: 'idle', step: 0, total: 4, detail: '' } };
const installing = { ...missingWorker, model: ready.model, modelAccess: ready.modelAccess,
  // The receipt the service writes when its install starts (server/index.ts installOrRepair).
  lastPing: { at: Date.now(), ok: false, kind: 'ping', detail: 'Bud setup changed. Its private readiness check is still needed.' },
  autoSetup: { state: 'installing', code: 'installing', step: 1, total: 4, detail: 'Installing Bud' } };
const held = { ...installing, autoSetup: { state: 'held', code: 'held_failed', step: 1, total: 4, detail: 'Bud’s setup stopped before it finished. Your files are kept. Try again, or contact RealBud support.' } };
const setupPhases = {
  'managed-downloading': { state: 'installing', code: 'installing', step: 1, total: 4, detail: 'Downloading Bud' },
  'managed-components': { state: 'installing', code: 'installing', step: 1, total: 4, detail: 'Installing Bud’s components' },
  'managed-reuse': { state: 'installing', code: 'installing', step: 1, total: 4, detail: 'Checking already downloaded Bud' },
  'managed-model': { state: 'verifying', code: 'model', step: 3, total: 4, detail: 'Connecting Bud’s model' },
  'managed-readiness': { state: 'verifying', code: 'readiness', step: 4, total: 4, detail: 'Testing Bud on this computer' },
};
const scenarioNames = ['unlinked-missing-worker', 'linked-pending', 'linked-local-recovery', 'linked-preflight-recovery', 'relink-pending-old-withdrawal', 'managed-installing', ...Object.keys(setupPhases), 'held-retry-error', 'held-retry-success', 'recovery', 'withdrawn', 'revoked', 'ready'];
const qaState = () => ({ status: fixture, connected: qaConnected, recovering: qaRecovering });
function selectScenario(name) {
  assert.ok(scenarioNames.includes(name), 'Unknown fictional scenario.');
  qaConnected = true; qaRecovering = false; retryFailure = false; retryDelay = 0;
  officeFixture = { state: 'linked', agencyLabel: 'Fictional Harbour Agency', provisioned: true };
  if (name === 'unlinked-missing-worker') { fixture = structuredClone(missingWorker); officeFixture = { state: 'unlinked' }; }
  if (name === 'linked-pending') { fixture = structuredClone(missingWorker); officeFixture = { state: 'linked', agencyLabel: 'Fictional Harbour Agency', provisioned: false }; }
  if (name === 'linked-local-recovery') { fixture = structuredClone(missingWorker); officeFixture = { state: 'linked', agencyLabel: 'Fictional Harbour Agency', provisioned: false, error: 'Saved settings need recovery. The original file has been kept; restore or repair it before saving changes.' }; }
  if (name === 'linked-preflight-recovery') { fixture = structuredClone(missingWorker); officeFixture = { state: 'linked', agencyLabel: 'Fictional Harbour Agency', provisioned: false, error: "This computer's saved settings or private service storage need recovery. Your work is kept. Repair the local storage before retrying office setup." }; }
  if (name === 'relink-pending-old-withdrawal') {
    fixture = { ...structuredClone(held), modelAccess: { ...ready.modelAccess, withdrawn: true, attached: false, detail: 'The previous installation was withdrawn.' } };
    officeFixture = { state: 'linked', agencyLabel: 'New Fictional Agency', provisioned: false, error: 'This computer’s service setup needs local storage recovery. Existing settings are kept.' };
  }
  if (name === 'managed-installing') fixture = structuredClone(installing);
  if (setupPhases[name]) fixture = { ...structuredClone(installing), autoSetup: setupPhases[name] };
  if (name === 'held-retry-error' || name === 'held-retry-success') { fixture = structuredClone(held); retryFailure = name === 'held-retry-error'; retryDelay = 1200; }
  if (name === 'recovery') { fixture = structuredClone(held); qaRecovering = true; }
  if (name === 'withdrawn') { fixture = { ...structuredClone(held), modelAccess: { ...ready.modelAccess, withdrawn: true, attached: false, detail: 'Model access was withdrawn for this fictional computer. Your records are kept.' } }; officeFixture.serviceWithdrawn = true; }
  if (name === 'revoked') { fixture = { ...structuredClone(held), modelAccess: { ...ready.modelAccess, withdrawn: true, attached: false, detail: 'Fictional withdrawn detail.' } }; officeFixture = { state: 'revoked', label: 'Fictional Front Desk', agencyLabel: 'Fictional Harbour Agency', revokedAt: '2026-10-04T14:25:39.101Z', serviceWithdrawn: true }; }
  if (name === 'ready') fixture = structuredClone(ready);
  for (const response of qaSubscribers) response.write(`data: ${JSON.stringify(qaState())}\n\n`);
}
try {
  const port = await freePort(), uiPort = await freePort(), base = `http://127.0.0.1:${port}`, uiBase = `http://127.0.0.1:${uiPort}`;
  process.env.OMB_UI_PORT = String(uiPort);
  child = spawn(process.execPath, [join(root, 'server/bootstrap.ts')], { cwd: root, env: { ...serviceSmokeEnv({ executable: process.execPath, home: temp, data, scratch: temp, port }), REALBUD_TEST_LAB: '1', OMB_UI_PORT: String(uiPort), OMB_STATIC_DIR: join(root, 'dist') }, stdio: ['ignore', 'pipe', 'pipe'] });
  childClosed = new Promise((r, j) => { child.once('close', r); child.once('error', j); });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { logs = (logs + b).slice(-15_000); });
  await until(async () => (await (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).json()).pid === child.pid, 'isolated service startup');
  vite = await createViteServer({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'warn', plugins: [{ name: 'fictional-bud-status-bridge', enforce: 'pre', transform(code, id) {
    const path = id.split('?')[0]; if (baselineSources.has(path)) return baselineSources.get(path); if (path !== join(root, 'src/App.tsx')) return;
    const bridge = `const { state, dispatch } = useStore(); window.__budQa = { state, dispatch };${serveOnly ? `
      useEffect(() => {
        const events = new EventSource('/__qa/scenarios');
        const report = event => { const message = String(event.message || event.reason?.message || event.reason || 'Unknown renderer error').slice(0, 1000); navigator.sendBeacon('/__qa/client-error', JSON.stringify({ message })); };
        window.addEventListener('error', report);
        window.addEventListener('unhandledrejection', report);
        events.onmessage = event => {
          const next = JSON.parse(event.data), current = window.__budQa;
          current.dispatch({ type: 'connected', value: next.connected });
          current.dispatch({ type: 'hermesStatus', status: next.status });
          if (current.state.desk) current.dispatch({ type: 'deskSnapshot', snapshot: { ...current.state.desk, recovery: { ...(current.state.desk.recovery || {}), active: next.recovering } } });
          window.dispatchEvent(new Event('realbud-website-link-changed'));
        };
        return () => { events.close(); window.removeEventListener('error', report); window.removeEventListener('unhandledrejection', report); };
      }, []);` : ''}`;
    return code.replace('const { state, dispatch } = useStore();', bridge);
  }, configureServer(server) {
    if (!serveOnly) return;
    server.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url, uiBase), method = request.method;
      const json = (body, status = 200) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); };
      try {
        if (url.pathname === '/__qa/scenarios' && method === 'GET') { response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' }); response.write(': fictional scenario control\n\n'); qaSubscribers.add(response); request.on('close', () => qaSubscribers.delete(response)); return; }
        if (url.pathname === '/__qa/state' && method === 'GET') return json({ scenarioNames, fixture, officeFixture, counts, rendererPageErrors: errors, limits });
        if (url.pathname === '/__qa/stop' && method === 'POST') { json({ ok: true }); setImmediate(() => stopFixture?.()); return; }
        if (url.pathname === '/__qa/client-error' && method === 'POST') { let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 2048) return json({ error: 'Error report too large.' }, 413); } const message = JSON.parse(body).message; if (typeof message === 'string') errors.push(message.slice(0, 1000)); return json({ ok: true }); }
        if (url.pathname === '/__qa/scenario' && method === 'POST') { let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 1024) return json({ error: 'Fixture control too large.' }, 413); } selectScenario(JSON.parse(body).name); return json({ ok: true, ...qaState() }); }
        if (url.pathname === '/api/onboarding' && method === 'GET') return json({ version: 1, scope: 'a'.repeat(64), revision: 1, stage: 'complete' });
        if (url.pathname === '/api/config' && method === 'GET') { const body = await (await fetch(`${base}/api/config`, { headers: request.headers })).json(); body.serviceAdmin = { managed, configured: true, authenticated: false, expiresAt: null }; return json(body); }
        if (url.pathname === '/api/service-admin/status') return json({ managed, configured: true, authenticated: false, expiresAt: null });
        if (url.pathname === '/api/office-link' && method === 'GET') { counts.officeReads++; officeReadInFlight++; counts.maxConcurrentOfficeReads = Math.max(counts.maxConcurrentOfficeReads, officeReadInFlight); try { return json(officeFixture); } finally { officeReadInFlight--; } }
        if (url.pathname.startsWith('/api/office-link') && method !== 'GET') return json({ error: 'Fictional QA never links a real office.' }, 403);
        if (url.pathname === '/api/hermes' && method === 'GET') { counts.statusReads++; if (delayRefresh) await wait(delayRefresh); return json(fixture, failRefresh ? 503 : 200); }
        if (url.pathname === '/api/hermes/auto-setup/retry' && method === 'POST') {
          let body = ''; for await (const chunk of request) body += chunk;
          counts.hermesMutations.push({ path: url.pathname, managed, body });
          if (body !== '{}') return json({ error: 'The fixture only accepts the reviewed empty request.' }, 400);
          if (retryDelay) await wait(retryDelay);
          if (retryFailure) return json({ error: 'Fictional setup response unavailable.' }, 503);
          fixture = structuredClone(installing); return json({ autoSetup: fixture.autoSetup }, 202);
        }
        if (url.pathname === '/api/desk/recovery/auto') return json({ ok: false, error: 'Fictional recovery remains held.' });
        if (url.pathname.startsWith('/api/hermes') && method !== 'GET') { counts.hermesMutations.push({ path: url.pathname, managed }); return json({ error: 'Fictional QA blocks worker mutations.' }, 403); }
        if (url.pathname === '/api/hermes/model') return json({ model: { provider: 'custom:realbud', model: 'deepseek-v4.1-flash', choice: 'flash-high', keyPresent: true, keyHint: null, managed: true } });
        if (url.pathname === '/api/hermes/install/status') return json({ install: { state: 'idle', lines: [], startedAt: null, finishedAt: null, error: null } });
        return next();
      } catch (error) { return json({ error: error.message }, 400); }
    });
  } }], optimizeDeps: { entries: ['index.html'] }, server: { host: '127.0.0.1', port: uiPort, strictPort: true, proxy: { '/api': { target: base, changeOrigin: true, ws: true } } } });
  await vite.listen();
  if (serveOnly) {
    selectScenario('unlinked-missing-worker');
    const served = { uiBase, url: `${uiBase}/#/ask`, state: `${uiBase}/__qa/state`, scenario: `${uiBase}/__qa/scenario`, stop: `${uiBase}/__qa/stop`, scenarioNames, output, pid: process.pid, servicePid: child.pid, temporaryDirectory: temp };
    writeFileSync(join(output, 'fixture.json'), JSON.stringify(served, null, 2));
    console.log(JSON.stringify(served));
    await new Promise(resolve => { stopFixture = resolve; process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
    checks.push('Served isolated fictional renderer for a separately recorded CUA walkthrough; this process performed no browser actions.');
    for (const response of qaSubscribers) response.end();
  } else {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  await primeBrowserSession(context, uiBase, await readSessionToken(data));
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== uiBase) { counts.externalRequests.push(url.origin); return route.abort(); }
    const json = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/onboarding' && req.method() === 'GET') return json({ version: 1, scope: 'a'.repeat(64), revision: 1, stage: 'complete' });
    if (url.pathname === '/api/config' && req.method() === 'GET') { const res = await route.fetch(); const body = await res.json(); body.serviceAdmin = { managed, configured: true, authenticated: false, expiresAt: null }; return json(body); }
    if (url.pathname === '/api/service-admin/status') return json({ managed, configured: true, authenticated: false, expiresAt: null });
    if (url.pathname === '/api/hermes' && req.method() === 'GET') { counts.statusReads++; if (delayRefresh) await wait(delayRefresh); if (failRefresh) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Fictional status read failed.' }) }); return json(fixture); }
    if (url.pathname === '/api/desk/recovery/auto') return json({ ok: false, error: 'Fictional recovery remains held.' });
    if (url.pathname.startsWith('/api/hermes') && req.method() !== 'GET') { counts.hermesMutations.push({ path: url.pathname, managed }); return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Fictional QA blocks worker mutations.' }) }); }
    if (url.pathname === '/api/hermes/model') return json({ model: { provider: 'custom:realbud', model: 'deepseek-v4.1-flash', choice: 'flash-high', keyPresent: true, keyHint: null, managed: true } });
    if (url.pathname === '/api/hermes/install/status') return json({ install: { state: 'idle', lines: [], startedAt: null, finishedAt: null, error: null } });
    return route.continue();
  });
  page = await context.newPage(); page.setDefaultTimeout(15_000); page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${uiBase}/#/ask`);
  await page.locator('.ask-composer textarea').first().waitFor();
  await until(() => page.evaluate(() => window.__budQa?.state.connected === true), 'connected real store');
  const shot = async name => { await page.screenshot({ path: join(output, `${name}.png`), fullPage: true }); screenshots.push(`${name}.png`); };
  const composer = page.locator('.ask-composer textarea').first();
  const draft = 'Fictional unfinished repair request kept while checking Bud.';
  await composer.fill(draft);
  await shot('ask-safeguards-1280');
  const opener = page.getByRole('button', { name: baseline ? /^Finish Bud setup/ : /^View Bud status/ });
  await opener.focus(); await page.keyboard.press('Enter');
  await page.getByRole('dialog').waitFor();
  await page.getByRole('heading', { name: 'Bud on this computer', exact: true }).waitFor();
  await shot('bud-safeguards-1280');
  if (baseline) {
    checks.push('Baseline reproduced: Finish Bud setup opens a status card with Check again and service-administration navigation.');
    observations.baselineText = await page.getByRole('dialog').innerText();
  } else {
    const dialog = page.getByRole('dialog', { name: 'Bud status', exact: true });
    const panel = page.getByRole('region', { name: 'Bud status', exact: true });
    const readRows = () => panel.locator('dl > div').evaluateAll(rows => rows.map(row => ({ check: row.querySelector('dt').textContent, state: row.querySelector('dd').textContent })));
    assert.equal(await panel.getByRole('button', { name: /Finish Bud setup/ }).count(), 0);
    assert.match(await panel.innerText(), /private workroom is not ready/);
    assert.deepEqual(await readRows(), [
      { check: 'Download Bud', state: 'Ready' }, { check: 'Turn on approvals', state: 'Needs attention' },
      { check: 'Connect your office’s AI', state: 'Configured' }, { check: 'Test Bud', state: 'Waiting' },
    ]);
    checks.push('Staff safeguards hold identifies the missing workroom, shows four dependency-ordered facts and provides no false Finish setup action.');
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    assert.equal(await composer.inputValue(), draft);
    const restored = await opener.evaluate(el => el === document.activeElement);
    observations.focusAfterEscape = await page.evaluate(() => ({ tag: document.activeElement?.tagName, name: document.activeElement?.getAttribute('aria-label'), text: document.activeElement?.textContent?.slice(0, 100) }));
    if (!restored) findings.push('Escape after first lazy status open did not restore focus to its opener.');
    await opener.focus(); await page.keyboard.press('Enter'); await dialog.waitFor();
    for (let n = 0; n < 12; n++) { await page.keyboard.press('Tab'); assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true, `dialog keyboard focus escaped on Tab ${n + 1}`); }
    checks.push('Keyboard Enter opens status; twelve Tab presses stay inside; Escape preserves the Ask draft (focus restoration is recorded separately).');
    observations.widths = [];
    for (const width of [360, 390, 768, 1280, 1536]) {
      await page.setViewportSize({ width, height: width < 768 ? 844 : 960 });
      const measure = await dialog.evaluate(el => ({ documentWidth: document.documentElement.scrollWidth, viewport: innerWidth, dialogWidth: el.clientWidth, dialogScrollWidth: el.scrollWidth, headingVisible: (() => { const r = el.querySelector('h2').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })(), overflow: [...el.querySelectorAll('*')].filter(node => { const r = node.getBoundingClientRect(); return r.width && (r.left < -1 || r.right > innerWidth + 1); }).map(node => node.tagName + '.' + node.className).slice(0, 8) }));
      assert.ok(measure.documentWidth <= width + 1 && measure.dialogScrollWidth <= measure.dialogWidth + 1, `horizontal overflow at ${width}: ${JSON.stringify(measure)}`);
      assert.ok(measure.headingVisible, `heading outside viewport at ${width}`); assert.deepEqual(measure.overflow, []);
      observations.widths.push({ width, ...measure }); await shot(`bud-safeguards-${width}`);
    }
    checks.push('Safeguards status rendered at 360, 390, 768, 1280 and 1536 CSS px: heading visible, no document/modal overflow or offscreen content.');
    await page.setViewportSize({ width: 1280, height: 960 });
    await until(async () => await panel.getByRole('button', { name: 'Check again', exact: true }).isEnabled(), 'initial status read complete');
    delayRefresh = 700;
    await panel.getByRole('button', { name: 'Check again', exact: true }).click();
    const pendingButton = panel.getByRole('button', { name: 'Checking…', exact: true }); await pendingButton.waitFor(); assert.equal(await pendingButton.isDisabled(), true); await shot('bud-refresh-pending');
    delayRefresh = 0;
    await panel.getByRole('button', { name: 'Check again', exact: true }).waitFor();
    failRefresh = true; await panel.getByRole('button', { name: 'Check again', exact: true }).click();
    await panel.getByText('Status unavailable', { exact: true }).waitFor();
    assert.ok((await readRows()).every(row => row.state === 'Not checked')); await shot('bud-refresh-error');
    failRefresh = false; await panel.getByRole('button', { name: 'Check again', exact: true }).click();
    await panel.getByText('Service setup needed', { exact: true }).waitFor();
    checks.push('Manual refresh disables duplicate presses while pending; failed read clears stale readiness claims; retry restores observed status.');
    const beforeAuto = counts.statusReads; fixture = structuredClone(ready);
    await panel.getByText('Bud ready', { exact: true }).waitFor({ timeout: 18_000 });
    assert.ok(counts.statusReads - beforeAuto >= 1 && counts.statusReads - beforeAuto <= 2, 'automatic status refresh must stay bounded');
    assert.ok((await readRows()).every(row => row.state === 'Ready')); await shot('bud-ready-auto-refresh');
    checks.push('A later ready status is observed automatically within the 15-second read interval; bounded read refreshes update the visible facts without a model or repair request.');
    const setState = async (status, { connected = true, recovering = false } = {}) => {
      fixture = structuredClone(status);
      await page.evaluate(({ status, connected, recovering }) => { const { state, dispatch } = window.__budQa; dispatch({ type: 'connected', value: connected }); dispatch({ type: 'hermesStatus', status }); if (state.desk) dispatch({ type: 'deskSnapshot', snapshot: { ...state.desk, recovery: { ...(state.desk.recovery || {}), active: recovering } } }); }, { status, connected, recovering });
    };
    await setState(null); await panel.getByText('Checking Bud', { exact: true }).waitFor(); assert.ok((await readRows()).every(row => row.state === 'Not checked')); await shot('bud-checking');
    await setState({ ...ready, ready: false, lastPing: null }); await panel.getByText('Check needed', { exact: true }).waitFor(); await shot('bud-readiness-needed');
    await setState({ ...ready, ready: false, lastPing: null, model: { attached: false, provider: null, model: null }, modelAccess: { managed: false, withdrawn: false, attached: false, detail: '' } });
    await panel.getByRole('button', { name: 'Connect with this code', exact: true }).waitFor(); await shot('bud-model-needed');
    await setState({ ...ready, ready: false, model: { ...ready.model, attached: false }, modelAccess: { managed: true, withdrawn: true, attached: false, detail: 'Model access was withdrawn for this fictional computer. Your records are kept.' } });
    await panel.getByText('Disconnected from your office', { exact: true }).waitFor(); assert.equal(await panel.getByRole('button', { name: 'Connect with this code', exact: true }).count(), 0); await shot('bud-withdrawn');
    await setState(ready, { recovering: true }); await panel.getByText('Recovery needed', { exact: true }).waitFor(); assert.notEqual((await readRows()).at(-1).state, 'Ready'); await shot('bud-recovery');
    await setState(ready, { connected: false }); await panel.getByText('Reconnecting', { exact: true }).waitFor(); assert.ok((await readRows()).every(row => row.state === 'Not checked')); assert.equal(await panel.getByRole('button', { name: 'Check again', exact: true }).isDisabled(), true); await shot('bud-offline');
    await setState({ ...safeguards, cli: { ...ready.cli, matchesPin: false, compatible: false }, installerAvailable: true });
    await panel.getByText('Bud update blocked', { exact: true }).waitFor();
    await setState(safeguards); await panel.getByText('Service setup needed', { exact: true }).waitFor();
    assert.deepEqual(counts.hermesMutations.filter(row => row.managed), []);
    checks.push('Checking, readiness-needed, model-needed, withdrawn, recovery, offline and unsupported-worker states are rendered; staff issued no Hermes POST for readiness or repair.');
    await page.emulateMedia({ reducedMotion: 'reduce' }); await shot('bud-reduced-motion');
    observations.reducedMotion = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches); assert.equal(observations.reducedMotion, true);
    checks.push('Reduced-motion setting retains a readable, usable status panel.');
    await panel.getByRole('button', { name: 'Back to Work', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }); assert.equal(await composer.inputValue(), draft);
    const readsClosed = counts.statusReads; await page.evaluate(() => { for (let i = 0; i < 10; i++) window.dispatchEvent(new Event('focus')); }); await wait(300); observations.readsAfterCloseAndTenFocusEvents = counts.statusReads - readsClosed; assert.ok(counts.statusReads - readsClosed <= 1, 'closing the status panel permits one handoff read, never a focus-triggered loop');
    checks.push('Back to Work preserves the draft; ten repeated focus events after closing permit at most one handoff read for the surviving Ask observer.');
    managed = false;
    await page.evaluate(() => window.__budQa.dispatch({ type: 'serviceAdminStatus', status: { managed: false, configured: true, authenticated: false, expiresAt: null } }));
    await page.getByRole('button', { name: /^Finish Bud setup/ }).click();
    await page.getByRole('dialog', { name: 'Bud status', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Set up workroom', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Set up workroom', exact: true }).isEnabled(), true);
    await shot('bud-administrator-real-action');
    checks.push('An authorized development-administrator fixture opens the actual existing Set up workroom control; no setup mutation is executed.');
    const shell = page.locator('.rb-app-shell'), coverHeading = name => page.getByRole('heading', { level: 1, name, exact: true });
    const leave = page.getByRole('button', { name: 'Use RealBud without Bud for now', exact: true });
    await setState(installing); await coverHeading('Setting up Bud').waitFor();
    assert.equal(await shell.count(), 0); assert.equal(await composer.count(), 0); assert.equal(await leave.count(), 0);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k'); assert.equal(await shell.count(), 0);
    await shot('bud-setup-cover-installing');
    await setState({ ...installing, autoSetup: { state: 'waiting_retry', code: 'retry', step: 1, total: 4, nextRetryAt: Date.now() + 15 * 60_000, detail: '' } });
    await leave.waitFor(); assert.equal(await shell.count(), 0);
    await setState(installing); await page.waitForFunction(() => !document.body.textContent.includes('Use RealBud without Bud for now'));
    await setState(installing, { connected: false }); await leave.waitFor(); assert.equal(await shell.count(), 0);
    await setState({ ...installing, readyOnce: true }); await shell.waitFor();
    await setState(installing, { recovering: true }); await shell.waitFor();
    await setState(held); await coverHeading('Bud setup stopped').waitFor();
    assert.equal(await shell.count(), 0); await page.getByRole('button', { name: 'Try setup again', exact: true }).waitFor();
    await shot('bud-setup-cover-held');
    await leave.click(); await shell.waitFor();
    await setState(installing); await wait(500); assert.equal(await shell.count(), 1);
    await setState(ready); await shell.waitFor(); assert.equal(await coverHeading('Setting up Bud').count(), 0);
    await setState({ ...ready, ready: false, lastPing: null, readyOnce: false, autoSetup: { state: 'ready', code: 'ready', step: 4, total: 4, detail: 'Bud is ready.' } }); await wait(500);
    assert.equal(await shell.count(), 1); assert.equal(await coverHeading('Bud needs a check').count(), 0);
    checks.push('Bud’s first setup takes the whole window with no exit while it runs; waiting to retry, a held setup or a lost connection offer a way into RealBud; leaving is never undone by a later retry; a Bud already tested here, book recovery, a ready Bud and a needs-a-check Bud keep the shell.');
    observations.finalStaffMutations = counts.hermesMutations.filter(row => row.managed);

  }
  assert.equal(errors.length, 0, errors.join('\n'));
  if (!baseline) { const finalHashes = sourceHashes(); const changed = testedPaths.filter(path => startHashes[path] !== finalHashes[path]); assert.deepEqual(changed, [], 'source changed during the renderer run; rerun from a stable snapshot'); }
  }
} catch (error) { failure = error?.stack ?? String(error); console.error(failure); if (page && !page.isClosed()) { try { await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }); observations.failureState = await page.evaluate(() => ({ visible: document.visibilityState, text: document.querySelector('[role=dialog]')?.textContent, connected: window.__budQa?.state.connected, ready: window.__budQa?.state.hermes?.ready })); } catch {} } }
finally {
  await browser?.close(); await vite?.close();
  if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); const force = setTimeout(() => child.kill('SIGKILL'), 5_000); await childClosed; clearTimeout(force); }
  // The isolated service deliberately makes its relay configuration directory
  // read-only. Only after that service stops, unlock this fixture-owned path
  // for deletion; never change permissions on an installed app's workspace.
  const relayDirectory = join(data, 'ask-model-relay');
  if (existsSync(relayDirectory)) { const info = lstatSync(relayDirectory); if (info.isDirectory() && !info.isSymbolicLink()) chmodSync(relayDirectory, 0o700); }
  rmSync(temp, { recursive: true, force: true });
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ at: new Date().toISOString(), node: process.version, layer: 'source', baseline, serveOnly, passed: !serveOnly && failure === null && findings.length === 0, ...(serveOnly ? { uiProof: 'Recorded separately by the CUA operator; fixture serving alone is not UI acceptance.' } : {}), checks, findings, screenshots, rendererPageErrors: errors, observations, source: { revision: sourceRevision, startHashes, endHashes: sourceHashes(), baselineTransforms: baseline ? baselinePaths : [], fixtureFields: { safeguards, ready } }, network: counts, cleanup: { isolatedServiceStopped: true, temporaryDataRemoved: true }, limits, ...(failure ? { failure } : {}) }, null, 2));
}
if (failure || findings.length) process.exitCode = 1;
else console.log(JSON.stringify({ output, checks: checks.length, screenshots: screenshots.length }));
