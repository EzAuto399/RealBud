// Source-rendered Bud status QA. Fictional status fixtures; no worker/provider calls.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROME_EXECUTABLE=/path/to/chrome node scripts/qa-bud-status.mjs [--baseline]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { serviceSmokeEnv } from './service-smoke-env.mjs';

assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE to an installed Playwright module.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = process.argv.includes('--baseline');
const baselinePaths = ['src/components/ChatView.tsx', 'src/components/AskReadiness.tsx', 'src/components/BudSetupCard.tsx', 'src/components/ManagedBudStatus.tsx', 'src/components/WorkspaceSetup.tsx', 'src/components/AskWorkspaceSheet.tsx', 'src/lib/bud-setup.ts'];
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const testedPaths = [...baselinePaths, 'src/App.tsx', 'src/lib/bud-status-monitor.ts', 'src/state/store.tsx', 'src/lib/boot-heal.ts'];
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
  lastPing: { at: Date.now(), ok: true, kind: 'ping', detail: 'Fictional private readiness check passed.' },
};
const safeguards = { ...ready, ready: false, pack: { installed: true, approvalsManual: true, workroomReady: false }, lastPing: null };
let fixture = structuredClone(safeguards), failRefresh = false, delayRefresh = 0, managed = true;
const counts = { statusReads: 0, hermesMutations: [], externalRequests: [] };
const checks = [], screenshots = [], errors = [], findings = [], observations = {};
let child, childClosed, vite, browser, page, logs = '', failure = null;
const wait = ms => new Promise(r => setTimeout(r, ms));
async function freePort() { const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function until(fn, label, timeout = 20_000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn().catch(() => false)) return; await wait(100); } throw new Error(`Timed out: ${label}`); }
const limits = [
  'Source renderer with real application store and real isolated local service; worker status and administrator policy are fictional network fixtures.',
  'The QA Vite server adds an in-memory state bridge to force offline/recovery states; production files are not modified by that instrumentation.',
  'All Hermes API mutations and all non-loopback browser requests are intercepted. No provider, worker, customer account, installed application or hosted integration is exercised.',
  'Screenshots and keyboard checks prove source-rendered behavior only; no packaged, installed-device, live integration or customer acceptance is claimed.',
];
try {
  const port = await freePort(), uiPort = await freePort(), base = `http://127.0.0.1:${port}`, uiBase = `http://127.0.0.1:${uiPort}`;
  process.env.OMB_UI_PORT = String(uiPort);
  child = spawn(process.execPath, [join(root, 'server/bootstrap.ts')], { cwd: root, env: { ...serviceSmokeEnv({ executable: process.execPath, home: temp, data, scratch: temp, port }), REALBUD_TEST_LAB: '1', OMB_UI_PORT: String(uiPort), OMB_STATIC_DIR: join(root, 'dist') }, stdio: ['ignore', 'pipe', 'pipe'] });
  childClosed = new Promise((r, j) => { child.once('close', r); child.once('error', j); });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { logs = (logs + b).slice(-15_000); });
  await until(async () => (await (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).json()).pid === child.pid, 'isolated service startup');
  vite = await createViteServer({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'warn', plugins: [{ name: 'fictional-bud-status-bridge', enforce: 'pre', transform(code, id) { const path = id.split('?')[0]; if (baselineSources.has(path)) return baselineSources.get(path); if (path !== join(root, 'src/App.tsx')) return; return code.replace('const { state, dispatch } = useStore();', 'const { state, dispatch } = useStore(); window.__budQa = { state, dispatch };'); } }], server: { host: '127.0.0.1', port: uiPort, strictPort: true, proxy: { '/api': { target: base, changeOrigin: true, ws: true } } } });
  await vite.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
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
      { check: 'Bud installed', state: 'Ready' }, { check: 'Property safeguards', state: 'Needs attention' },
      { check: 'Model connection', state: 'Configured' }, { check: 'Private readiness check', state: 'Waiting' },
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
    await panel.getByRole('button', { name: 'Connect to your office', exact: true }).waitFor(); await shot('bud-model-needed');
    await setState({ ...ready, ready: false, model: { ...ready.model, attached: false }, modelAccess: { managed: true, withdrawn: true, attached: false, detail: 'Model access was withdrawn for this fictional computer. Your records are kept.' } });
    await panel.getByText('Model access withdrawn', { exact: true }).waitFor(); assert.equal(await panel.getByRole('button', { name: 'Connect to your office', exact: true }).count(), 0); await shot('bud-withdrawn');
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
    await panel.getByRole('button', { name: 'Return to Ask', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }); assert.equal(await composer.inputValue(), draft);
    const readsClosed = counts.statusReads; await page.evaluate(() => { for (let i = 0; i < 10; i++) window.dispatchEvent(new Event('focus')); }); await wait(300); observations.readsAfterCloseAndTenFocusEvents = counts.statusReads - readsClosed; assert.ok(counts.statusReads - readsClosed <= 1, 'closing the status panel permits one handoff read, never a focus-triggered loop');
    checks.push('Return to Ask preserves the draft; ten repeated focus events after closing permit at most one handoff read for the surviving Ask observer.');
    managed = false;
    await page.evaluate(() => window.__budQa.dispatch({ type: 'serviceAdminStatus', status: { managed: false, configured: true, authenticated: false, expiresAt: null } }));
    await page.getByRole('button', { name: /^Finish Bud setup/ }).click();
    await page.getByRole('dialog', { name: 'Bud status', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Set up workroom', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Set up workroom', exact: true }).isEnabled(), true);
    await shot('bud-administrator-real-action');
    checks.push('An authorized development-administrator fixture opens the actual existing Set up workroom control; no setup mutation is executed.');
    observations.finalStaffMutations = counts.hermesMutations.filter(row => row.managed);

  }
  assert.equal(errors.length, 0, errors.join('\n'));
  if (!baseline) { const finalHashes = sourceHashes(); const changed = testedPaths.filter(path => startHashes[path] !== finalHashes[path]); assert.deepEqual(changed, [], 'source changed during the renderer run; rerun from a stable snapshot'); }
} catch (error) { failure = error?.stack ?? String(error); console.error(failure); if (page && !page.isClosed()) { try { await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }); observations.failureState = await page.evaluate(() => ({ visible: document.visibilityState, text: document.querySelector('[role=dialog]')?.textContent, connected: window.__budQa?.state.connected, ready: window.__budQa?.state.hermes?.ready })); } catch {} } }
finally {
  await browser?.close(); await vite?.close();
  if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); const force = setTimeout(() => child.kill('SIGKILL'), 5_000); await childClosed; clearTimeout(force); }
  rmSync(temp, { recursive: true, force: true });
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ at: new Date().toISOString(), node: process.version, layer: 'source', baseline, passed: failure === null && findings.length === 0, checks, findings, screenshots, rendererPageErrors: errors, observations, source: { revision: sourceRevision, startHashes, endHashes: sourceHashes(), baselineTransforms: baseline ? baselinePaths : [], fixtureFields: { safeguards, ready } }, network: counts, cleanup: { isolatedServiceStopped: true, temporaryDataRemoved: true }, limits, ...(failure ? { failure } : {}) }, null, 2));
}
if (failure || findings.length) process.exitCode = 1;
else console.log(JSON.stringify({ output, checks: checks.length, screenshots: screenshots.length }));
