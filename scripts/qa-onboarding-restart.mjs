// Real source renderer + loopback service, disposable fictional state only.
// Node 24+, PLAYWRIGHT_MODULE, optional CHROME_EXECUTABLE. No dist build.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { serviceSmokeEnv } from './service-smoke-env.mjs';

assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.QA_OUTPUT || join(root, 'outputs/broad-qa-2026-09-23/onboarding'));
const scratch = await mkdtemp(join(tmpdir(), 'fictional-onboarding-restart-'));
const checks = [], pageErrors = [], origins = [];
let service, closed, vite, browser, context, base, uiBase, token, failure, logs = '';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = async () => {
  const listener = createServer().listen(0, '127.0.0.1'); await once(listener, 'listening');
  const result = listener.address().port; await new Promise(resolve => listener.close(resolve)); return result;
};
const record = message => { checks.push(message); console.log(`PASS ${message}`); };
async function stop() {
  await vite?.close(); vite = undefined;
  if (service && service.exitCode === null && !service.signalCode) {
    service.kill('SIGTERM');
    await Promise.race([closed, wait(5000)]);
    if (service.exitCode === null && !service.signalCode) service.kill('SIGKILL');
    await closed;
  }
  service = undefined;
}
async function start(data) {
  await stop();
  await mkdir(data, { recursive: true, mode: 0o700 });
  const serverPort = await port(), uiPort = await port();
  base = `http://127.0.0.1:${serverPort}`; uiBase = `http://127.0.0.1:${uiPort}`;
  origins.push({ service: base, renderer: uiBase });
  process.env.OMB_UI_PORT = String(uiPort);
  service = spawn(process.execPath, [join(root, 'server/bootstrap.ts')], { cwd: root,
    env: { ...serviceSmokeEnv({ executable: process.execPath, home: scratch, data, scratch, port: serverPort }), REALBUD_MANAGED_SERVICE: '0', REALBUD_TEST_LAB: '1', OMB_UI_PORT: String(uiPort), OMB_STATIC_DIR: join(root, 'dist') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  closed = new Promise((resolve, reject) => { service.once('close', resolve); service.once('error', reject); });
  for (const stream of [service.stdout, service.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-20_000); });
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (service.exitCode !== null) break;
    const health = await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) }).then(r => r.json()).catch(() => null);
    if (health?.pid === service.pid) { ready = true; break; }
    await wait(100);
  }
  assert.ok(ready, 'Disposable service starts');
  assert.equal((await fetch(base + '/api/onboarding')).status, 401);
  token = (await (await fetch(base + '/api/session')).json()).token;
  vite = await createViteServer({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'warn',
    server: { host: '127.0.0.1', port: uiPort, strictPort: true, proxy: { '/api': { target: base, changeOrigin: true, ws: true } } },
  });
  await vite.listen();
}
async function request(path, method = 'GET', body) {
  const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-realbud-session': token }, signal: AbortSignal.timeout(15_000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); assert.ok(response.ok, `${path}: ${JSON.stringify(value)}`); return value;
}
async function open() {
  const page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(uiBase); return page;
}
async function rules(page, name) {
  await page.getByRole('heading', { name: 'Make the desk yours', exact: true }).waitFor();
  await page.getByLabel('Your name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('heading', { name: 'You stay in charge', exact: true }).waitFor();
}
async function finish(page) {
  await page.getByRole('button', { name: 'Open the sample desk first', exact: true }).click();
  await page.getByRole('heading', { name: 'You stay in charge', exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('region', { name: 'This morning', exact: true }).waitFor();
}
try {
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await context.route('**/*', route => new URL(route.request().url()).origin === uiBase ? route.continue() : route.abort());
  // A legacy origin flag is deliberately insufficient to mark a new seat done.
  await context.addInitScript(() => localStorage.setItem('realbud.first-run-done', '1'));
  const data = join(scratch, 'main');
  await start(data);
  let page = await open();
  await rules(page, 'Fictional QA Person');
  assert.equal((await request('/api/onboarding')).stage, 'office-rules');
  record('Fresh workspace ignores unscoped browser completion; profile submission only reaches rules');
  await page.close(); await start(data); page = await open();
  await page.getByRole('heading', { name: 'You stay in charge', exact: true }).waitFor();
  assert.equal((await request('/api/config')).profile.name, 'Fictional QA Person');
  record('Interrupted setup resumes rules after service restart at different service and renderer ports');
  await finish(page);
  assert.equal((await request('/api/onboarding')).stage, 'complete');
  await page.screenshot({ path: join(output, 'completed-390.png') });
  const overflow = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
  assert.ok(overflow.content <= overflow.width + 1, 'No 390px horizontal overflow');
  await page.close(); await start(data); page = await open();
  await page.getByRole('button', { name: 'Desk', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Make the desk yours', exact: true }).count(), 0);
  assert.equal((await request('/api/desk')).book.office.pmUser, 'Fictional QA Person');
  record('Completed welcome survives a second changed-port restart with the saved contact intact');
  await page.close();

  await start(join(scratch, 'restored'));
  await request('/api/desk/agency', 'PATCH', { office: { pmUser: 'Fictional Restored Contact' } });
  page = await open(); await rules(page, 'Fictional New Profile'); await finish(page);
  assert.equal((await request('/api/desk')).book.office.pmUser, 'Fictional Restored Contact');
  record('Replayed welcome preserves a restored book contact instead of overwriting it');
  await page.close();

  const sample = join(scratch, 'sample'); await start(sample); page = await open();
  await page.getByRole('button', { name: 'Explore the sample desk', exact: true }).click();
  await page.getByRole('heading', { name: 'You stay in charge', exact: true }).waitFor();
  await page.close(); await start(sample); page = await open();
  await page.getByRole('heading', { name: 'You stay in charge', exact: true }).waitFor();
  await finish(page); assert.equal((await request('/api/desk')).book.office.pmUser, 'Sample PM');
  record('Sample exploration retains its profile and can finish after a changed-port restart');
  await page.close();

  await stop(); const recovery = join(scratch, 'recovery'); await mkdir(recovery, { mode: 0o700 });
  await writeFile(join(recovery, 'desk.json'), '{fictional-protected-broken-book', { mode: 0o600 });
  await start(recovery); page = await open(); await rules(page, 'Fictional Recovery Person');
  await page.getByRole('button', { name: 'Open the sample desk first', exact: true }).click();
  await page.getByRole('button', { name: 'Open recovery', exact: true }).waitFor();
  assert.equal((await request('/api/onboarding')).stage, 'office-rules');
  await page.getByRole('button', { name: 'Open recovery', exact: true }).click();
  await page.getByRole('heading', { name: 'You stay in charge', exact: true }).waitFor({ state: 'hidden' });
  assert.equal((await request('/api/onboarding')).stage, 'recovery');
  const quarantined = (await readdir(recovery)).filter(name => name.startsWith('desk.json.quarantine-'));
  assert.equal(quarantined.length, 1);
  assert.equal(await readFile(join(recovery, quarantined[0]), 'utf8'), '{fictional-protected-broken-book');
  await page.close(); await start(recovery); page = await open();
  await page.getByRole('button', { name: 'You', exact: true }).waitFor();
  assert.match(page.url(), /you-recovery/);
  record('Protected book remains unchanged; recovery is saved separately and resumes after restart');
  assert.deepEqual(pageErrors, []); record('Zero renderer page errors throughout all six scenarios');
} catch (cause) { failure = cause instanceof Error ? cause.stack : String(cause); console.error(failure); }
finally {
  await context?.close(); await browser?.close(); await stop();
  await writeFile(join(output, 'receipt.json'), JSON.stringify({ at: new Date().toISOString(), layer: 'source-rendered-local', passed: !failure, node: process.version, checks, pageErrors, origins, failure: failure ?? null,
    limits: ['Disposable fictional state only; no real account, worker, model, hosted, bank or payment calls.', 'Source Vite renderer and local Node service; not a packaged or installed-device acceptance run.', 'Member isolation and asynchronous scope changes are covered by server/onboarding.test.ts, not separate physical devices.'] }, null, 2));
  if (failure) await writeFile(join(output, 'failure-service.log'), logs);
  await rm(scratch, { recursive: true, force: true });
}
if (failure) process.exitCode = 1;
