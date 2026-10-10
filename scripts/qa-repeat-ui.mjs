// Disposable real API + built UI check of the Schedule repeat editor. All records and the worker are synthetic.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { readSessionToken, primeBrowserSession, enterSampleDeskForQa } from './local-session.mjs';
if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to an installed playwright module.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.QA_OUTPUT ?? join(root, 'outputs/repeat-ui-2026-10-09'));
mkdirSync(output, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), 'rb-repeat-ui-'));
let child, browser, logs = '';
try {
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(done => listener.close(done));
  const data = join(temp, 'data'); mkdirSync(data);
  writeFileSync(join(data, 'config.json'), JSON.stringify({ instances: { ghost: { driver: 'not-a-real-driver', displayName: 'Offline fixture' } } }));
  const worker = join(temp, 'worker.mjs');
  writeFileSync(worker, `#!${process.execPath}\nconsole.log('Hermes Agent v0.21.3 (2026.9.14)');\n`); chmodSync(worker, 0o755);
  const origin = `http://127.0.0.1:${port}`;
  child = spawn(process.env.REALBUD_SERVER_EXECUTABLE || process.execPath, [process.env.REALBUD_SERVER_ENTRY || join(root, 'server/index.ts')], { cwd: root,
    env: { PATH: process.env.PATH, HOME: temp, USERPROFILE: temp, REALBUD_DATA_DIR: data, REALBUD_HERMES_CLI: worker, OMB_PORT: String(port), OMB_STATIC_DIR: process.env.REALBUD_UI_DIR || join(root, 'dist'), ELECTRON_RUN_AS_NODE: '1', VITEST: 'true' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', bytes => { logs += bytes; }); child.stderr.on('data', bytes => { logs += bytes; });
  let ready = false;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(origin + '/api/health')).ok) { ready = true; break; } } catch {} await new Promise(done => setTimeout(done, 200)); }
  assert.ok(ready, logs.slice(-1500));
  const token = await readSessionToken(data);
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(origin + path, { method, headers: { 'x-realbud-session': token, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json(); assert.ok(response.ok, `${path}: ${JSON.stringify(result)}`); return result;
  };
  // A saved once-a-day job, so the Timing editor is available without a first try.
  const title = 'Practice repeat job';
  await request('/api/recipes', 'POST', { draft: { title, description: 'Review a fictional supplied record', steps: ['Read the supplied practice record'], allowedOrigins: [], evidence: 'Practice receipt', capabilities: ['read-files', 'analyse', 'draft'], limits: { maxRuntimeMinutes: 2, maxTurns: 6 }, schedule: { time: '09:00', weekdays: [1, 2, 3, 4, 5] }, status: 'shadow', expectedRevision: 0 } });

  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1365, height: 1024 } });
  await primeBrowserSession(context, origin, token);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.getByLabel('Your name', { exact: true }).fill('Fictional Repeat Reviewer');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  // First run has no sample-desk exit: the QA helper completes it as that button did and passes the office-link screen.
  await page.getByRole('heading', { name: 'Connect this computer to your office', exact: true }).waitFor();
  await enterSampleDeskForQa(page);
  const nav = page.getByRole('navigation', { name: 'Main navigation', exact: true });
  await nav.getByRole('button', { name: 'Schedule', exact: true }).click();
  await page.getByRole('button', { name: `Open job: ${title}`, exact: true }).click();
  const job = page.getByRole('dialog', { name: title, exact: true });
  await job.waitFor();
  await job.locator('summary').filter({ hasText: /^Timing$/ }).click();

  const repeat = job.getByRole('combobox', { name: 'Repeat', exact: true });
  assert.equal(await repeat.inputValue(), 'daily', 'A saved once-a-day job opens as once a day');
  await repeat.selectOption('minutes');
  const every = job.getByLabel('Minutes between runs', { exact: true });
  assert.equal(await job.getByLabel('From', { exact: true }).inputValue(), '09:00');
  assert.equal(await job.getByLabel('Until (optional)', { exact: true }).inputValue(), '17:00', 'Switching from once a day starts with office hours');
  await job.getByText("Each run counts toward your office's monthly AI limit.", { exact: true }).waitFor();
  const save = job.getByRole('button', { name: 'Save changes', exact: true });

  // Recovery in place: the reason sits beside the field and Save stays off with it.
  await every.fill('0');
  await job.getByText('Choose a whole number of minutes from 1 to 1440.', { exact: true }).waitFor();
  await job.getByText('Fix the timing before saving: Choose a whole number of minutes from 1 to 1440.', { exact: true }).waitFor();
  assert.equal(await save.isDisabled(), true);
  await every.fill('2');
  await job.getByLabel('Until (optional)', { exact: true }).fill('08:00');
  await job.getByText('Until must be later than From.', { exact: true }).waitFor();
  assert.equal(await save.isDisabled(), true);
  await job.getByLabel('Until (optional)', { exact: true }).fill('17:00');
  assert.equal(await save.isEnabled(), true);
  await page.screenshot({ animations: 'disabled', path: join(output, 'repeat-editor-desktop.png') });

  await save.click();
  await job.getByText(/^Plan saved\./).waitFor();
  const cadence = 'Every 2 minutes, 9:00 am–5:00 pm, weekdays';
  await job.getByText(new RegExp(`^${cadence}`)).first().waitFor();
  const saved = (await request('/api/recipes')).recipes.find(recipe => recipe.title === title);
  assert.deepEqual(saved.schedule, { time: '09:00', weekdays: [1, 2, 3, 4, 5], everyMinutes: 2, until: '17:00' }, 'The repeat round-trips through the saved job');
  await page.screenshot({ animations: 'disabled', path: join(output, 'repeat-saved-desktop.png') });

  // The mailbox ability stays labelled; without a known connected mailbox it is held with the fix beside it.
  const details = job.locator('summary').filter({ hasText: /^Edit job details$/ });
  if (!(await details.evaluate(element => element.parentElement.open))) await details.click();
  await job.locator('summary').filter({ hasText: /^Advanced · Sources and permissions$/ }).click();
  const mailbox = job.getByRole('checkbox', { name: 'Read the reviewed mailbox', exact: true });
  await mailbox.waitFor();
  await job.getByText('Bud reads your connected mailbox when this job runs; it never sends.', { exact: true }).waitFor();
  const mailboxHeld = await mailbox.isDisabled();
  if (mailboxHeld) {
    await job.getByText('Connect your mailbox in Workspace → Connected apps first.', { exact: true }).waitFor();
    await job.getByRole('button', { name: 'Open connected apps', exact: true }).waitFor();
  }
  await mailbox.scrollIntoViewIfNeeded();
  await page.screenshot({ animations: 'disabled', path: join(output, 'mailbox-ability-desktop.png') });

  await page.setViewportSize({ width: 390, height: 844 });
  await job.getByText(new RegExp(`^${cadence}`)).first().waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Job workspace fits phone width');
  await page.screenshot({ animations: 'disabled', path: join(output, 'repeat-saved-mobile.png') });
  await repeat.scrollIntoViewIfNeeded();
  const phoneControls = [repeat, every, job.getByLabel('From', { exact: true }), job.getByLabel('Until (optional)', { exact: true }), mailbox];
  if (mailboxHeld) phoneControls.push(job.getByRole('button', { name: 'Open connected apps', exact: true }));
  for (const control of phoneControls) {
    const box = await control.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390, `Control fits 390 px: ${JSON.stringify(box)}`);
  }
  for (const control of [repeat, every, job.getByLabel('From', { exact: true })]) assert.ok((await control.boundingBox()).height >= 44, '44 px target');
  assert.ok(await job.evaluate(root => root.scrollWidth <= root.clientWidth), 'Job panel has no horizontal scroll at 390 px');
  await page.screenshot({ animations: 'disabled', path: join(output, 'repeat-editor-mobile.png') });
  if (mailboxHeld) {
    // The fix beside the held ability opens the office connections, not a dead end.
    await job.getByRole('button', { name: 'Open connected apps', exact: true }).click();
    const apps = page.getByRole('navigation', { name: 'Setup sections', exact: true }).getByRole('button', { name: 'Apps', exact: true });
    await apps.waitFor();
    assert.equal(await apps.getAttribute('aria-pressed'), 'true');
    await page.screenshot({ animations: 'disabled', path: join(output, 'connected-apps-from-job-mobile.png') });
  }
  assert.deepEqual(errors, []);
  rmSync(join(output, 'failure.png'), { force: true });
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ checkedAt: new Date().toISOString(), layer: 'local-built-ui-with-real-api', realServer: true, syntheticBusinessRecords: true, fakeOfflineWorker: true,
    minuteRepeatSaved: saved.schedule, cadenceText: cadence, invalidMinutesHeldSave: true, windowEndBeforeStartHeldSave: true, aiLimitNoteShown: true, mailboxAbilityLabelled: true, mailboxAbilityHeldWithFix: mailboxHeld,
    desktop: 1365, mobile: 390, noHorizontalOverflow: true, pageErrors: errors,
    timingTargetsAtLeast44px: true,
    mailboxFixOpensConnectedApps: mailboxHeld,
    screenshots: ['repeat-editor-desktop.png', 'repeat-saved-desktop.png', 'mailbox-ability-desktop.png', 'repeat-saved-mobile.png', 'repeat-editor-mobile.png', ...(mailboxHeld ? ['connected-apps-from-job-mobile.png'] : [])],
    limits: ['Built React UI and isolated local service with a synthetic job and an offline worker; no installed-device, live integration or customer proof.', 'The repeat is saved but not approved, so no scheduled run fires and Stop now is not exercised here (unit tests cover it; the stop route belongs to another packet).', 'No office apps are connected in this fixture, so the mailbox ability is only seen in its held or unknown state; no mail is read and nothing is sent.'],
  }, null, 2) + '\n');
  console.log(`PASS: minute repeat edited, validated in place, saved and shown as "${cadence}"; mailbox ability labelled${mailboxHeld ? ' and held with its fix' : ''}; 390 px fits; zero page errors. Synthetic records only.`);
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) { await page.screenshot({ animations: 'disabled', path: join(output, 'failure.png') }).catch(() => {}); console.error((await page.getByRole('alert').allTextContents()).join(' | ')); }
  throw error;
} finally {
  await browser?.close();
  if (child) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), new Promise(done => setTimeout(done, 5000))]); if (child.exitCode === null) child.kill('SIGKILL'); }
  rmSync(temp, { recursive: true, force: true });
}
