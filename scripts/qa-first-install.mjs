#!/usr/bin/env node
// Production UI + isolated local server; installation responses are fixtures.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.env.QA_OUTPUT ?? join(root, 'outputs/first-install-2026-09-09/browser'));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const scratch = mkdtempSync(join(tmpdir(), 'bud-first-install-'));
const data = join(scratch, 'data'); mkdirSync(data); mkdirSync(out, { recursive: true });
writeFileSync(join(data, 'config.json'), JSON.stringify({ instances: { ghost: { driver: 'not-a-real-driver', displayName: 'Offline fixture' } } }));
let child, browser, page, logs = '';
const until = async (check, label) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check().catch(() => false)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${label}`);
};
try {
  const reservation = createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(root, 'server/index.ts')], { cwd: root, env: { PATH: process.env.PATH, HOME: scratch, USERPROFILE: scratch, REALBUD_HERMES_CLI: join(scratch, 'missing-worker'), REALBUD_DATA_DIR: data, VITEST: 'true', OMB_PORT: String(port), OMB_STATIC_DIR: join(root, 'dist') }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
  await until(async () => (await fetch(`${base}/api/health`)).ok, 'server startup');
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  let installed = false, job = { state: 'idle', error: null }, installs = 0, cancels = 0, failedReads = 0;
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await context.route('**/api/hermes', route => json(route, {
    pin: { product: '0.20.3', tag: 'v2026.8.16.2', commit: 'fixture', profile: 'property' },
    cli: { installed, compatible: installed, matchesPin: installed, probeState: installed ? 'ok' : 'missing', versionText: installed ? 'Hermes Agent v0.20.3 (2026.8.16.2)' : null },
    pack: { installed, approvalsManual: installed, workroomReady: installed },
    installCommand: null, installerAvailable: true, ready: false, detail: 'Fictional setup status', homeDir: '', profileDir: '', signInCommand: '',
    model: { attached: false, provider: null, model: null },
  }));
  await context.route('**/api/hermes/model', route => json(route, { model: { provider: null, model: null, keyPresent: false, keyHint: null } }));
  await context.route('**/api/hermes/install/status', route => failedReads-- > 0 ? json(route, { error: 'Fictional connection interruption' }, 503) : json(route, { install: job }));
  await context.route('**/api/hermes/install', route => {
    installs++;
    job = { state: 'running', error: null, progress: { detail: 'Preparing this computer', step: 1, total: 13 } };
    return json(route, { install: job }, 202);
  });
  await context.route('**/api/hermes/install/cancel', route => {
    cancels++; job = { state: 'failed', error: 'Setup stopped before it finished. Your property data is kept. Try again when you’re ready.' };
    return json(route, { install: job }, 202);
  });
  page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.getByRole('textbox', { name: 'Your name', exact: true }).fill('Fictional PM');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Continue to Bud setup', exact: true }).click();
  let setup = page.getByRole('dialog', { name: 'Set up Bud', exact: true }); await setup.waitFor();
  assert.equal(new URL(page.url()).hash, '#/ask', 'first-run setup remains on Ask');
  await page.locator('.ask-composer textarea').first().waitFor({ state: 'attached' });
  const install = setup.getByRole('button', { name: 'Install Bud', exact: true });
  await until(() => install.isEnabled(), 'Windows install available without shell command');
  await install.click();
  await setup.getByText('Preparing this computer', { exact: true }).waitFor();
  assert.equal(installs, 1);
  failedReads = 1;
  await setup.getByText(/Reconnecting to setup/).waitFor();
  await setup.getByText(/Reconnecting to setup/).waitFor({ state: 'hidden', timeout: 10000 });
  assert.equal(installs, 1, 'a failed progress read never repeats installation');
  await setup.getByRole('button', { name: 'Stop setup', exact: true }).click();
  await setup.getByText(/Setup stopped before it finished/).waitFor(); assert.equal(cancels, 1);
  await setup.getByRole('button', { name: 'Close Set up Bud', exact: true }).click();
  const composer = page.locator('.ask-composer textarea').first(); await composer.fill('Prepare a repair follow-up for my first property.');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('realbud:workspace-setup', { detail: 'bud' })));
  setup = page.getByRole('dialog', { name: 'Set up Bud', exact: true });
  await setup.getByText(/Setup stopped before it finished/).waitFor();
  await setup.getByRole('button', { name: 'Install Bud', exact: true }).click(); assert.equal(installs, 2);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no page overflow');
    const stop = setup.getByRole('button', { name: 'Stop setup', exact: true });
    await stop.scrollIntoViewIfNeeded(); assert.ok((await stop.boundingBox()).height >= 44, 'touch target');
    await page.screenshot({ path: join(out, `setup-${width}.png`) });
  }
  installed = true; job = { state: 'done', error: null };
  await setup.getByRole('button', { name: /Connect model/ }).first().waitFor({ timeout: 10000 });
  assert.equal(await setup.getByText('Bud is ready', { exact: true }).count(), 0, 'installed is not ready without a model check');
  await setup.getByRole('button', { name: 'Close Set up Bud', exact: true }).click();
  assert.equal(await composer.inputValue(), 'Prepare a repair follow-up for my first property.');
  assert.deepEqual(errors, []);
  const result = { passed: true, checks: ['fresh onboarding opens setup over Ask', 'Windows action enabled', 'progress recovers without duplicate install', 'cancel and retry', 'failure survives reopening panel', '320/390px layout and touch target', 'successful install advances to model connection', 'not ready prematurely', 'Ask draft preserved'], liveInstallation: false, liveProvider: false };
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  await page?.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  writeFileSync(join(out, 'failure.log'), `${error.stack}\n${logs}`); throw error;
} finally { await browser?.close(); child?.kill('SIGTERM'); rmSync(scratch, { recursive: true, force: true }); }
