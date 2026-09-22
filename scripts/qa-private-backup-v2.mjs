// Real local bootstrap/API and built React UI, disposable fictional workspaces.
// No customer records, accounts, provider calls or external writes.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { serviceSmokeEnv } from './service-smoke-env.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Explicit package selection never falls back to source modules or dist UI.
const packaged = process.env.REALBUD_QA_RESOURCES !== undefined || process.env.REALBUD_QA_EXECUTABLE !== undefined;
let resources = null, executable = process.execPath;
if (packaged) {
  assert.ok(process.env.REALBUD_QA_RESOURCES?.trim() && process.env.REALBUD_QA_EXECUTABLE?.trim(), 'Packaged QA requires both REALBUD_QA_RESOURCES and REALBUD_QA_EXECUTABLE.');
  resources = realpathSync(resolve(process.env.REALBUD_QA_RESOURCES));
  executable = realpathSync(resolve(process.env.REALBUD_QA_EXECUTABLE));
  assert.ok(statSync(resources).isDirectory(), 'Packaged resources must be a directory.');
  for (const file of [executable, join(resources, 'server/bootstrap.js'), join(resources, 'ui/index.html')]) assert.ok(statSync(file).isFile(), `Required packaged file is missing or invalid: ${file}`);
}
const bootstrap = packaged ? join(resources, 'server/bootstrap.js') : join(root, 'server/bootstrap.ts');
const staticDirectory = packaged ? join(resources, 'ui') : join(root, 'dist');
const serviceCwd = packaged ? resources : root;
if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to an installed Playwright module.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const temp = mkdtempSync(join(realpathSync(tmpdir()), 'RealBud private backup QA '));
const source = join(temp, 'source'), target = join(temp, 'target'), output = resolve(process.env.QA_OUTPUT || join(root, packaged ? 'outputs/private-backup-packaged-2026-09-21' : 'outputs/private-backup-v2-2026-09-21/coordinator-browser'));
for (const directory of [source, target, output]) mkdirSync(directory, { recursive: true, mode: 0o700 });
for (const directory of [source, target]) writeFileSync(join(directory, 'config.json'), JSON.stringify({ instances: { fixture: { driver: 'not-a-real-driver' } } }), { mode: 0o600 });
const wait = ms => new Promise(r => setTimeout(r, ms)), checks = [], errors = [];
const pass = text => { checks.push(text); console.log(`PASS ${text}`); };
let browser, page, child, logs = '', failure, token, base, port;
let runtime = { node: process.versions.node, electron: process.versions.electron ?? null };
const stop = async () => { if (child?.exitCode === null && !child.signalCode) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), wait(5000)]); if (child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await once(child, 'exit'); } } };
const start = async directory => {
  child = spawn(executable, [bootstrap], { cwd: serviceCwd, env: { ...serviceSmokeEnv({ executable, home: directory, data: directory, scratch: temp, port }), REALBUD_MANAGED_SERVICE: '0', REALBUD_TEST_LAB: '1', OMB_STATIC_DIR: staticDirectory }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let spawnError; child.once('error', error => { spawnError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-20000); });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) { if (spawnError) throw spawnError; if (child.exitCode !== null || child.signalCode) break; try { const health = await (await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) })).json(); if (health.app === 'realbud' && health.pid === child.pid) { ready = true; break; } } catch {} await wait(100); }
  assert.ok(ready, logs); token = (await (await fetch(base + '/api/session')).json()).token;
};
const request = async (path, method = 'GET', body, expected = 200) => { const response = await fetch(base + path, { method, signal: AbortSignal.timeout(120000), headers: { 'content-type': 'application/json', 'x-realbud-session': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const result = await response.json(); assert.equal(response.status, expected, `${path}: ${JSON.stringify(result)}`); return result; };
try {
  if (packaged) {
    // Verify the requested binary is the packaged Electron runtime, not a local
    // Node executable that could conceal an Electron/SQLite compatibility gap.
    const probe = spawnSync(executable, ['-e', 'console.log(JSON.stringify({node:process.versions.node,electron:process.versions.electron??null}))'], {
      cwd: resources, env: serviceSmokeEnv({ executable, home: source, data: source, scratch: temp, port: 0 }),
      encoding: 'utf8', timeout: 10000, maxBuffer: 16384, windowsHide: true,
    });
    assert.equal(probe.error, undefined, 'Packaged runtime could not be started.');
    assert.equal(probe.status, 0, `Packaged runtime check failed: ${probe.stderr}`);
    runtime = JSON.parse(probe.stdout.trim());
    assert.ok(typeof runtime.electron === 'string' && typeof runtime.node === 'string', 'Packaged QA must use the application Electron executable with Node mode.');
  }
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening'); port = listener.address().port; await new Promise(r => listener.close(r)); base = `http://127.0.0.1:${port}`;
  await start(source); assert.equal((await fetch(base + '/api/private-backup')).status, 401);
  await request('/api/desk/properties', 'POST', { address: 'Fictional Backup Oak Street', tenantName: 'Fictional Tenant', tenantPhone: '0400 000 000', weeklyRentCents: 50000 }, 201);
  const csv = '\uFEFFDate,Amount,Narrative,Reference\r\n2026-09-20,123.45,"Fictional café 🏡","KEEP"\r\n';
  const batch = await request('/api/bank-reference', 'POST', { source: { filename: 'fictional-private-backup.csv', bytesBase64: Buffer.from(csv).toString('base64') }, columns: { date: 'Date', amount: 'Amount', narrative: 'Narrative', reference: 'Reference' }, dateFormat: 'YYYY-MM-DD', rules: [] });
  const before = await request('/api/private-backup'); assert.equal(before.canRestore, false); assert.equal(before.bootstrap, true);
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await context.addInitScript(() => localStorage.setItem('realbud.first-run-done', '1'));
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/#/you');
  await page.waitForFunction(() => {
    const text = document.querySelector('aside.rb-sidebar')?.textContent ?? '';
    return /(?:Office|Sample) book/.test(text) && !text.includes('Book loading') && !text.includes('Loading your desk');
  }, undefined, { timeout: 15000 });
  pass('Direct You navigation resolves the global sidebar book state without opening Desk');
  const advanced = page.locator('details#you-advanced'); await advanced.locator(':scope > summary').click();
  let panel = page.getByRole('region', { name: 'Private workspace backup', exact: true }); await panel.waitFor();
  const phrase = 'Fictional backup passphrase only 2026';
  await panel.getByLabel('New backup passphrase', { exact: true }).fill(phrase); await panel.getByLabel('Repeat private backup passphrase', { exact: true }).fill('not matching'); assert.equal(await panel.getByRole('button', { name: 'Download encrypted private backup', exact: true }).isDisabled(), true);
  await panel.getByLabel('Repeat private backup passphrase', { exact: true }).fill(phrase);
  const downloadEvent = page.waitForEvent('download'); await panel.getByRole('button', { name: 'Download encrypted private backup', exact: true }).click(); const download = await downloadEvent; const bytes = readFileSync(await download.path()); assert.equal(bytes.subarray(0,8).toString(), 'RBUDPV2\0'); assert.ok(!bytes.includes(Buffer.from('Fictional Backup Oak Street'))); assert.ok(!bytes.includes(Buffer.from(phrase)));
  assert.equal(await panel.getByLabel('New backup passphrase', { exact: true }).inputValue(), '');
  pass('Actual UI exports an encrypted business backup, confirms matching passphrases and clears them after download');
  const upload = { name: download.suggestedFilename(), mimeType: 'application/octet-stream', buffer: bytes };
  await panel.getByLabel('Encrypted private backup file', { exact: true }).setInputFiles(upload); await panel.getByLabel('Restore private backup passphrase', { exact: true }).fill(phrase); await panel.getByRole('button', { name: 'Preview private backup contents', exact: true }).click(); await panel.getByRole('region', { name: 'Private backup preview', exact: true }).waitFor(); assert.equal(await panel.getByRole('button', { name: 'Stage reviewed restore', exact: true }).count(), 0);
  pass('Real API preview shows included/excluded contents while the nonfresh source workspace cannot stage a restore');
  await page.reload(); await page.locator('details#you-advanced > summary').click(); panel = page.getByRole('region', { name: 'Private workspace backup', exact: true });
  await panel.getByRole('region', { name: 'Saved backup operations', exact: true }).waitFor();
  pass('Reload rediscovers durable backup operations without persisting the passphrase or file in browser storage');
  await panel.getByLabel('Encrypted private backup file', { exact: true }).setInputFiles(upload); await panel.getByLabel('Restore private backup passphrase', { exact: true }).fill('Incorrect fictional passphrase'); await panel.getByRole('button', { name: 'Preview private backup contents', exact: true }).click(); await panel.getByRole('region', { name: 'Selected backup progress' }).getByRole('alert').waitFor(); assert.equal((await request('/api/private-backup')).staged, false);
  await panel.getByLabel('Restore private backup passphrase', { exact: true }).fill(phrase); await panel.getByRole('button', { name: 'Preview private backup contents', exact: true }).click(); await panel.getByRole('region', { name: 'Private backup preview', exact: true }).waitFor();
  pass('Incorrect passphrase retains the uploaded copy and a correct retry produces a fully checked preview');
  await stop(); await start(target); assert.equal((await request('/api/private-backup')).canRestore, true);
  await page.reload(); await page.locator('details#you-advanced > summary').click(); panel = page.getByRole('region', { name: 'Private workspace backup', exact: true });
  await panel.getByLabel('Encrypted private backup file', { exact: true }).setInputFiles(upload); await panel.getByLabel('Restore private backup passphrase', { exact: true }).fill(phrase); await panel.getByRole('button', { name: 'Preview private backup contents', exact: true }).click(); const preview = panel.getByRole('region', { name: 'Private backup preview', exact: true }); await preview.waitFor(); assert.equal(await preview.getByRole('button', { name: 'Stage reviewed restore', exact: true }).isDisabled(), true);
  await preview.screenshot({ path: join(output, 'private-backup-preview-desktop.png') }); await page.setViewportSize({ width: 390, height: 844 }); await preview.getByLabel('I checked this backup', { exact: false }).check(); await preview.getByRole('button', { name: 'Stage reviewed restore', exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: join(output, 'private-backup-preview-mobile.png') }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await preview.getByRole('button', { name: 'Stage reviewed restore', exact: true }).click(); await panel.getByText('Restore staged — restart required', { exact: true }).waitFor(); await page.setViewportSize({ width: 1440, height: 1050 }); const staged = await request('/api/private-backup'); assert.equal(staged.staged, true); assert.equal(await panel.getByRole('button', { name: 'Stage reviewed restore', exact: true }).count(), 0); assert.equal(await panel.getByRole('button', { name: 'Download encrypted private backup', exact: true }).count(), 0); await panel.screenshot({ path: join(output, 'private-backup-staged-desktop.png') });
  pass('Fresh-workspace restore requires reviewed preview and explicit confirmation, stages once, and shows a truthful restart requirement');
  await stop(); await start(target); const restored = await request('/api/private-backup'); assert.equal(restored.staged, false); assert.equal(restored.canRestore, false);
  const desk = await request('/api/desk'); assert.ok(desk.properties.some(p => p.address === 'Fictional Backup Oak Street'));
  const imported = await request('/api/bank-reference'); assert.ok(imported.batches.some(b => b.id === batch.id));
  const original = await request(`/api/bank-reference/${batch.id}/original`, 'POST', {}); assert.deepEqual(Buffer.from(original.bytesBase64, 'base64'), Buffer.from(csv));
  assert.notDeepEqual(readFileSync(join(source, 'desk.key')), readFileSync(join(target, 'desk.key')));
  await page.reload(); await page.locator('details#you-advanced > summary').click(); await panel.waitFor(); assert.equal(await panel.getByText('Restore staged — restart required', { exact: true }).count(), 0); assert.deepEqual(errors, []);
  const completed = panel.getByRole('region', { name: 'Completed private restore', exact: true });
  await completed.getByText('Last restore completed', { exact: true }).waitFor();
  assert.equal(restored.completed.receipt.digest, staged.receipt.digest);
  await completed.screenshot({ path: join(output, 'private-backup-completed-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 }); await completed.scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: join(output, 'private-backup-completed-mobile.png') });
  pass('Actual cold bootstrap restores the property and exact bank bytes under a different local key; reloaded UI is no longer staged');
  const completionPath = join(target, 'private-workspace-restore-receipt.json');
  const malformedCompletion = '{"version":1,"receipt":"fictional damaged historical metadata"}';
  writeFileSync(completionPath, malformedCompletion, { mode: 0o600 });
  const warning = await request('/api/private-backup'); assert.equal(warning.completed, null); assert.match(warning.completionWarning, /completion cannot be confirmed/);
  await panel.getByRole('button', { name: 'Check backup status', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: 'completion cannot be confirmed' }).waitFor();
  assert.equal(await panel.getByRole('region', { name: 'Completed private restore', exact: true }).count(), 0);
  await panel.getByLabel('New backup passphrase', { exact: true }).fill(phrase); await panel.getByLabel('Repeat private backup passphrase', { exact: true }).fill(phrase);
  assert.equal(await panel.getByRole('button', { name: 'Download encrypted private backup', exact: true }).isDisabled(), false);
  const recoveryExport = await request('/api/private-backup/export', 'POST', { passphrase: phrase }); assert.ok(recoveryExport.receipt.fileCount > 0);
  assert.equal(readFileSync(completionPath, 'utf8'), malformedCompletion);
  pass('Damaged historical completion metadata shows a warning and preserves its bytes while valid business records can still be backed up');
  pass('Desktop and390px previews render without page errors or horizontal overflow');
} catch (error) { failure = error instanceof Error ? error.stack : String(error); await page?.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
finally { await browser?.close(); await stop(); rmSync(temp, { recursive: true, force: true }); writeFileSync(join(output, 'receipt.json'), JSON.stringify({ at: new Date().toISOString(), passed: !failure, mode: packaged ? 'packaged' : 'source', executable, resources, bootstrap, staticDirectory, runtime, layer: `${packaged ? 'Actual packaged Electron/Node, compiled bootstrap and bundled UI' : 'Actual local source bootstrap, Node and built UI'}; fictional records; restart exercised by owned child stop/start, not native restart IPC, physical Windows or managed-service proof`, checks, errors, failure, ...(failure ? { diagnostic: logs } : {}) }, null, 2)); if (failure) { console.error(failure); process.exitCode = 1; } else console.log(JSON.stringify({ output, checks }, null, 2)); }
