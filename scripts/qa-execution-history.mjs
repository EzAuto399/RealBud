// Real legacy migration, HTTP and built UI. All receipts are fictional and
// settled. No worker is dispatched and no external account is configured.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serviceSmokeEnv } from './service-smoke-env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), temp = mkdtempSync(join(realpathSync(tmpdir()), 'RealBud history QA '));
const output = resolve(process.env.QA_OUTPUT || join(root, 'outputs/execution-history-2026-09-21')); mkdirSync(output, { recursive: true });
if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const checks = [], errors = [], wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const pass = message => { checks.push(message); console.log(`PASS ${message}`); };
let child, browser, page, logs = '', failure;
try {
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening'); const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`, data = join(temp, 'data'); mkdirSync(data);
  const save = (name, value) => writeFileSync(join(data, name), JSON.stringify(value), { mode: 0o600 });
  save('config.json', { instances: { fixture: { driver: 'not-a-real-driver' } } });
  const time = Date.UTC(2026, 8, 20), spec = { title: 'Fictional review', description: 'Fictional historical result', steps: ['Read fictional evidence'], allowedOrigins: [], evidence: 'Fictional receipt', capabilities: ['analyse'], limits: { maxRuntimeMinutes: 2, maxTurns: 6 } };
  const jobs = Array.from({ length: 55 }, (_, i) => ({ id: `fixture-job-${i}`, jobId: 'fixture-plan', jobTitle: `Fictional job ${i}`, jobRevision: 1, mode: 'prepare', status: 'completed', trigger: 'manual', scheduledFor: time + i, createdAt: time + i, startedAt: time + i, finishedAt: time + i + 1, idempotencyKey: `fixture-request-${i}`, attempt: 1, spec, evidence: [{ kind: 'output', at: time + i, note: `Fictional prepared output ${i} <invoice>` }], approvalRequests: [], detail: `Fictional completion ${i}` }));
  jobs[53].mode = 'attended'; jobs[52].mode = 'shadow';
  save('job-runs.json', { version: 1, runs: jobs });
  save('loops.json', { version: 3, timezone: 'Australia/Brisbane', state: Object.fromEntries(['morning-arrears', 'owner-letter', 'inbound-triage'].map(id => [id, { enabled: false, handledThrough: time }])), runs: [{ id: 'fixture-loop', loopId: 'inbound-triage', loopName: 'Fictional morning review', createdAt: time, scheduledFor: time, manual: true, status: 'completed', detail: 'Fictional review completed.' }] });
  child = spawn(process.execPath, [join(root, 'server/bootstrap.ts')], { cwd: root, env: { ...serviceSmokeEnv({ executable: process.execPath, home: temp, data, scratch: temp, port }), REALBUD_MANAGED_SERVICE: '0', REALBUD_TEST_LAB: '1', OMB_STATIC_DIR: join(root, 'dist') }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-20000); });
  let ready = false;
  for (let i = 0; i < 100; i++) { if (child.exitCode !== null) break; try { const health = await (await fetch(origin + '/api/health', { signal: AbortSignal.timeout(500) })).json(); if (health.pid === child.pid) { ready = true; break; } } catch {} await wait(100); }
  assert.ok(ready, logs);
  for (const path of ['/api/job-runs/history', '/api/loops/history']) assert.equal((await fetch(origin + path)).status, 401);
  const token = (await (await fetch(origin + '/api/session')).json()).token;
  const request = path => fetch(origin + path, { headers: { 'x-realbud-session': token } });
  assert.equal((await request('/api/job-runs/history?cursor=invalid')).status, 400);
  assert.equal((await request('/api/job-runs/history?limit=10000')).status, 400);
  const ids = [], cursors = []; let cursor = null;
  do { const response = await request(`/api/job-runs/history?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); assert.equal(response.status, 200); const result = await response.json(); ids.push(...result.runs.map(run => run.id)); cursor = result.nextCursor; if (cursor) { assert.ok(!cursors.includes(cursor)); cursors.push(cursor); } } while (cursor);
  assert.equal(ids.length, 55); assert.equal(new Set(ids).size, 55); assert.equal(ids[0], 'fixture-job-54'); assert.equal(ids.at(-1), 'fixture-job-0');
  pass('Authenticated history migrates all55legacy job receipts and pages them without loss or duplicates; malformed requests fail');
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1365, height: 1024 }, reducedMotion: 'reduce' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await context.addInitScript(() => localStorage.setItem('realbud.first-run-done', '1'));
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  let historyRequests = 0, failOlder = false;
  await page.route('**/api/job-runs/history?*', async route => { historyRequests++; if (failOlder && new URL(route.request().url()).searchParams.has('cursor')) { failOlder = false; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Fictional storage temporarily unavailable.' }) }); } return route.continue(); });
  await page.goto(origin + '/#/schedule'); await page.getByRole('heading', { name: 'Schedule', exact: true }).waitFor(); assert.equal(historyRequests, 0);
  const panel = page.locator('details').filter({ has: page.locator(':scope > summary', { hasText: 'Browse saved history' }) }).first();
  await panel.locator(':scope > summary').click(); await panel.getByText('Page 1 · 20 results', { exact: true }).waitFor();
  const attended = panel.locator('li').filter({ has: page.locator('summary', { hasText: /^Fictional job 53/ }) });
  await attended.getByText('Result unverified — check the site', { exact: true }).waitFor();
  await panel.locator('li').filter({ has: page.locator('summary', { hasText: /^Fictional job 52/ }) }).getByText(/^Rehearsal ·/).waitFor();
  await panel.locator('summary').filter({ hasText: /^Fictional job 54/ }).click(); await panel.getByText('Fictional prepared output 54 <invoice>', { exact: true }).first().waitFor(); assert.equal(await panel.locator('invoice').count(), 0);
  failOlder = true; await panel.getByRole('button', { name: 'Older results', exact: true }).click(); await panel.getByRole('alert').filter({ hasText: 'last loaded page is still shown' }).waitFor(); await panel.getByText('Page 1 · 20 results', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Older results', exact: true }).click(); await panel.getByText('Page 2 · 20 results', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Older results', exact: true }).click(); await panel.getByText('Page 3 · 15 results', { exact: true }).waitFor(); assert.equal(await panel.getByRole('button', { name: 'Older results', exact: true }).isDisabled(), true);
  await panel.getByRole('button', { name: 'Newer results', exact: true }).click(); await panel.getByText('Page 2 · 20 results', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Refresh history', exact: true }).click(); await panel.getByText('Page 1 · 20 results', { exact: true }).waitFor();
  pass('History loads on demand, renders evidence as text, pages forward/back, retains the current page on a read failure, and refreshes');
  await page.setViewportSize({ width: 390, height: 844 }); await panel.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(output, 'job-history-mobile.png') }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await panel.getByLabel('History to show').selectOption('routines'); await panel.getByText('Fictional morning review', { exact: true }).waitFor(); await panel.getByText('Page 1 · 1 result', { exact: true }).waitFor();
  await page.setViewportSize({ width: 1365, height: 1024 }); await panel.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(output, 'routine-history-desktop.png') });
  assert.deepEqual(errors, []); pass('Routine history switches independently and both desktop and390px views fit without page errors');
} catch (error) { failure = error.stack || String(error); await page?.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
finally {
  await browser?.close(); if (child?.exitCode === null && !child.signalCode) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), wait(5000)]); if (child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await once(child, 'exit'); } }
  rmSync(temp, { recursive: true, force: true }); writeFileSync(join(output, 'receipt.json'), JSON.stringify({ at: new Date().toISOString(), passed: !failure, layer: 'Real isolated source bootstrap, legacy migration and built UI; fictional settled receipts and injected read failure', checks, errors, failure, ...(failure ? { diagnostic: logs } : {}) }, null, 2)); if (failure) { console.error(failure); process.exitCode = 1; }
}
