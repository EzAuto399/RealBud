import { readSessionToken, primeBrowserSession } from './local-session.mjs';
// Desktop shell (decision 2026-10-05): built React UI from REALBUD_UI_DIR against a real,
// disposable local service. Fictional sample book only; never reads ~/.realbud or dist/.
// Node 24, PLAYWRIGHT_MODULE, REALBUD_UI_DIR (scratch `vite build --outDir`), optional CHROME_EXECUTABLE.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE to an installed Playwright module.');
assert.ok(process.env.REALBUD_UI_DIR, 'Set REALBUD_UI_DIR to a scratch `vite build --outDir` folder; dist/ is shared.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.QA_OUTPUT ?? join(root, 'outputs/desktop-shell-2026-10-05'));
mkdirSync(output, { recursive: true });
const temp = mkdtempSync(join(realpathSync(tmpdir()), 'fictional-desktop-shell-'));
const data = join(temp, 'data'); mkdirSync(data, { mode: 0o700 });
const checks = [], errors = [], screenshots = [], measurements = {};
let child, browser, page, win, failure, logs = '';
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
const pass = message => { checks.push(message); console.log(`PASS ${message}`); };
const until = async (check, message) => { for (let i = 0; i < 100; i++) { if (await check()) return; await wait(50); } assert.fail(message); };
const shot = async name => { await page.screenshot({ path: join(output, name), animations: 'disabled' }); screenshots.push(name); };
const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal document overflow');

try {
  const listener = createServer().listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolveClose => listener.close(resolveClose));
  const origin = `http://127.0.0.1:${port}`;
  writeFileSync(join(data, 'config.json'), JSON.stringify({ instances: { fixture: { driver: 'not-a-real-driver', displayName: 'Offline fixture' } } }), { mode: 0o600 });
  const worker = join(temp, 'worker.mjs');
  writeFileSync(worker, `#!${process.execPath}\nconsole.log('Hermes Agent v0.21.3 (2026.9.14)');\n`); chmodSync(worker, 0o755);
  child = spawn(process.execPath, [join(root, 'server/index.ts')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: temp, USERPROFILE: temp, REALBUD_DATA_DIR: data, REALBUD_HERMES_CLI: worker, OMB_PORT: String(port), OMB_STATIC_DIR: resolve(process.env.REALBUD_UI_DIR), ELECTRON_RUN_AS_NODE: '1', VITEST: 'true' } });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-20_000); });
  let ready = false;
  for (let i = 0; i < 100 && child.exitCode === null; i++) { try { if ((await fetch(origin + '/api/health')).ok) { ready = true; break; } } catch {} await wait(200); }
  assert.ok(ready, logs.slice(-1500));
  const token = await readSessionToken(data);
  const call = (path, method = 'GET', body) => fetch(origin + path, { method, headers: { 'x-realbud-session': token, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const views = async () => (await (await call('/api/workspace-tabs')).json()).state;

  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 940 }, reducedMotion: 'reduce' });
  await primeBrowserSession(context, origin, token);
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.getByLabel('Your name', { exact: true }).fill('Fictional Shell Reviewer');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Open the sample desk first', exact: true }).click();
  await page.getByRole('heading', { name: 'Desk', exact: true }).waitFor();

  // 1. Every region at 1440px.
  const nav = page.getByRole('navigation', { name: 'Main navigation', exact: true });
  const contextBar = page.getByRole('region', { name: 'Desk context', exact: true });
  const tabs = page.getByRole('tablist', { name: 'Desk views', exact: true });
  const panel = page.getByRole('complementary', { name: 'Side panel', exact: true });
  const status = page.getByRole('contentinfo', { name: 'Status bar', exact: true });
  const workspace = page.locator('aside.rb-sidebar').getByRole('button', { name: 'Workspace', exact: true });
  for (const region of [nav, contextBar, tabs, panel, status, workspace]) await region.waitFor();
  for (const name of ['Evidence', 'Approvals waiting', 'Today']) await panel.getByRole('region', { name, exact: true }).waitFor();
  assert.equal(await panel.getByRole('region', { name: 'Bud activity', exact: true }).count(), 0, 'Bud activity waits under More');
  await until(async () => /Sample book/.test(await status.innerText()), 'The status bar labels the sample book');
  const statusText = await status.innerText();
  assert.match(statusText, /Connected/); assert.doesNotMatch(statusText, /Spend/, 'No spend placeholder on an unlinked book'); assert.doesNotMatch(statusText, /Desk checked/, 'A sample check never reads as a live one');
  await nav.getByRole('button', { name: 'Desk', exact: true }).hover();
  await until(async () => (await nav.getByRole('button', { name: 'Desk', exact: true }).locator('.rb-rail-tip').evaluate(element => getComputedStyle(element).opacity)) === '1', 'The rail tooltip is visible on hover');
  measurements.desktop = { rail: (await page.locator('aside.rb-sidebar').boundingBox()).width, context: (await contextBar.boundingBox()).width, panel: (await panel.boundingBox()).width };
  await noOverflow(); await shot('01-desk-1440.png');
  pass('At 1440px the rail, Desk context, Desk views tabs, side panel (Evidence, Approvals waiting, Today) and status bar render; the status bar says Sample book');

  // 2. Rail navigation, shortcuts and #you-* deep links.
  for (const [name, hash] of [['Work', '#/ask'], ['Schedule', '#/schedule'], ['Desk', '#/desk']]) {
    await nav.getByRole('button', { name, exact: true }).click(); await page.waitForURL(url => url.hash === hash);
    assert.equal(await nav.getByRole('button', { name, exact: true }).getAttribute('aria-current'), 'page');
  }
  await page.getByRole('region', { name: 'Schedule context', exact: true }).count();
  await workspace.click(); await page.waitForURL(url => url.hash === '#/you');
  assert.equal(await workspace.getAttribute('aria-current'), 'page');
  assert.equal(await panel.count(), 0, 'The side panel belongs to Desk views');
  const modifier = await page.evaluate(() => /mac/i.test(navigator.userAgentData?.platform ?? navigator.platform) ? 'Meta' : 'Control');
  for (const [key, hash] of [['1', '#/desk'], ['2', '#/ask'], ['3', '#/schedule'], ['4', '#/you']]) {
    await page.keyboard.press(`${modifier}+${key}`); await page.waitForURL(url => url.hash === hash);
  }
  await page.evaluate(() => { location.hash = 'you-connected-apps'; });
  await page.locator('#you-connected-apps').waitFor();
  assert.equal(new URL(page.url()).hash, '#you-connected-apps');
  assert.equal(await workspace.getAttribute('aria-current'), 'page');
  await page.keyboard.press(`${modifier}+1`); await page.waitForURL(url => url.hash === '#/desk');
  pass('Rail buttons, ⌘/Ctrl 1–4 and a #you-connected-apps deep link reach their screens with aria-current kept');

  // 3. One tab row on Desk: Desk's Tasks / Hermios buttons share the row with the shell tabs.
  const tab = name => tabs.getByRole('tab', { name: new RegExp(`^${name}`) });
  const deskRow = page.locator('.pm-desk-header').getByRole('navigation', { name: 'Desk workspace', exact: true });
  assert.equal(await deskRow.getByRole('tablist', { name: 'Desk views', exact: true }).count(), 1, 'Shell tabs sit inside the Desk row');
  assert.equal(await page.locator('.rb-shell-tabbar').count(), 0, 'No second tab row on Desk');
  assert.equal(await tab('Today').count() + await tab('Tasks').count(), 0, 'Tasks is a Desk button, not a duplicate tab');
  await deskRow.getByRole('button', { name: /^Tasks/ }).waitFor(); await deskRow.getByRole('button', { name: 'Hermios', exact: true }).waitFor();
  await tab('Properties').click();
  await page.getByRole('heading', { name: 'Properties', exact: true }).waitFor();
  await tab('Properties').focus();
  await page.keyboard.press('ArrowRight');
  await until(async () => await tab('Bills').getAttribute('aria-selected') === 'true', 'ArrowRight selects Bills');
  await page.locator('[data-other-work="bills"]').waitFor();
  await page.keyboard.press('Home');
  await until(async () => await tab('Properties').getAttribute('aria-selected') === 'true', 'Home returns to Properties');
  assert.equal(await tabs.locator('[role="tab"][tabindex="0"]').count(), 1);
  await deskRow.getByRole('button', { name: /^Tasks/ }).click();
  await page.getByRole('heading', { name: 'Task queue', exact: true }).waitFor();
  pass('Desk shows one tab row: Tasks / Hermios plus Properties / Bills tabs that move with ArrowRight and Home');

  // 4. Panel width persists per member across reload.
  const handle = panel.getByRole('separator', { name: 'Resize side panel', exact: true });
  const before = Number(await handle.getAttribute('aria-valuenow'));
  await handle.focus();
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workspace-tabs' && response.request().method() === 'PUT');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
  assert.equal((await saved).status(), 200);
  assert.equal((await views()).shell.panelWidth, before + 48);
  const box = await handle.boundingBox();
  const dragged = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workspace-tabs' && response.request().method() === 'PUT');
  await page.mouse.move(box.x + 4, box.y + 200); await page.mouse.down(); await page.mouse.move(box.x - 36, box.y + 200, { steps: 4 }); await page.mouse.up();
  assert.equal((await dragged).status(), 200);
  const width = (await views()).shell.panelWidth;
  assert.ok(width >= before + 80 && width <= before + 92, `Dragging widened the panel (${width})`);
  await page.reload();
  await panel.waitFor();
  await until(async () => Math.abs((await panel.boundingBox()).width - width) <= 1, 'The saved width is restored after reload');
  measurements.panelWidth = { before, after: width };
  pass(`The side panel resizes by keyboard and pointer, saves ${before}→${width}px with a revision and keeps it after reload`);

  // 5. Hide a card, then Arrange Desk → Reset to recommended restores it.
  await page.locator('summary[aria-label="Morning brief options"]').click();
  await page.getByRole('group', { name: 'Morning brief options', exact: true }).getByRole('button', { name: 'Hide', exact: true }).click();
  await until(async () => (await views()).desk.sections.find(section => section.id === 'brief')?.visible === false, 'Hide saves the brief as hidden');
  // An unchecked book still shows its check warning, so the card stays and its menu offers Show.
  await page.locator('summary[aria-label="Morning brief options"]').click();
  await page.getByRole('group', { name: 'Morning brief options', exact: true }).getByRole('button', { name: 'Show on my Desk', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await panel.locator('summary[aria-label="Today options"]').click();
  await panel.getByRole('group', { name: 'Today options', exact: true }).getByRole('button', { name: 'Hide', exact: true }).click();
  await panel.getByRole('region', { name: 'Today', exact: true }).waitFor({ state: 'detached' });
  await panel.getByRole('button', { name: 'More panels', exact: true }).click();
  await panel.getByRole('button', { name: 'Show Today', exact: true }).waitFor();
  await shot('02-card-hidden.png');
  await contextBar.getByRole('button', { name: 'Arrange Desk', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Arrange Desk', exact: true });
  await sheet.waitFor();
  assert.equal(await sheet.getByRole('checkbox', { name: 'Show Morning brief on my Desk', exact: true }).isChecked(), false);
  assert.ok(await sheet.getByRole('checkbox', { name: 'Needs you always shows', exact: true }).isDisabled());
  assert.ok(await sheet.getByRole('checkbox', { name: 'Approvals waiting always shows', exact: true }).isDisabled());
  await shot('03-arrange-desk.png');
  await sheet.getByRole('button', { name: 'Reset to recommended', exact: true }).click();
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await sheet.getByText('Desk arrangement saved.', { exact: true }).waitFor();
  const restored = await views();
  assert.ok(restored.desk.sections.every(section => section.visible));
  assert.deepEqual(restored.shell.panels.filter(item => item.visible).map(item => item.id), ['evidence', 'approvals', 'today']);
  assert.equal(restored.shell.panelWidth, width, 'Reset keeps the chosen width');
  await page.keyboard.press('Escape'); await sheet.waitFor({ state: 'detached' });
  await page.locator('summary[aria-label="Morning brief options"]').click();
  await page.getByRole('group', { name: 'Morning brief options', exact: true }).getByRole('button', { name: 'Hide', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await panel.getByRole('region', { name: 'Today', exact: true }).waitFor();
  pass('Hide saves the Morning brief as hidden (its menu then offers Show on my Desk) and removes the Today panel; Arrange Desk → Reset to recommended → Save restores both and keeps the width');

  // 6. Safety cards cannot be hidden: UI offers no Hide and the API refuses.
  await page.locator('summary[aria-label="Needs you options"]').click();
  const queueMenu = page.getByRole('group', { name: 'Needs you options', exact: true });
  await queueMenu.getByText(/Always shown/).waitFor();
  assert.equal(await queueMenu.getByRole('button', { name: 'Hide', exact: true }).count(), 0);
  await page.keyboard.press('Escape');
  await panel.locator('summary[aria-label="Approvals waiting options"]').click();
  assert.equal(await panel.getByRole('group', { name: 'Approvals waiting options', exact: true }).getByRole('button', { name: 'Hide', exact: true }).count(), 0);
  await page.keyboard.press('Escape');
  const state = await views();
  const noQueue = await call('/api/workspace-tabs', 'PUT', { version: 2, expectedRevision: state.revision, tabs: state.tabs, desk: { sections: state.desk.sections.map(section => section.id === 'queue' ? { ...section, visible: false } : section) } });
  assert.equal(noQueue.status, 400);
  const noApprovals = await call('/api/workspace-tabs', 'PUT', { version: 2, expectedRevision: state.revision, tabs: state.tabs, desk: state.desk, shell: { ...state.shell, panels: state.shell.panels.map(item => item.id === 'approvals' ? { ...item, visible: false } : item) } });
  assert.equal(noApprovals.status, 400); assert.equal((await noApprovals.json()).code, 'invalid_shell');
  assert.equal((await views()).revision, state.revision, 'Refused writes change nothing');
  pass('Needs you and Approvals waiting offer no Hide in their menus or in Arrange Desk, and the API answers 400 to hiding either');

  // 7. Breakpoints.
  await page.setViewportSize({ width: 1100, height: 900 });
  await until(async () => !(await panel.isVisible()), 'At 1100px the panel starts closed');
  const toggle = page.getByRole('button', { name: 'Side panel', exact: true });
  await toggle.click();
  await until(async () => await panel.isVisible(), 'The drawer opens');
  assert.equal(await panel.evaluate(element => getComputedStyle(element).position), 'absolute');
  await noOverflow(); await shot('04-drawer-1100.png');
  await page.keyboard.press('Escape');
  await until(async () => !(await panel.isVisible()), 'Escape closes the drawer');
  pass('At 1100px the side panel is a drawer that opens from Side panel and closes with Escape');
  await page.setViewportSize({ width: 900, height: 900 });
  for (const hidden of [panel, status, toggle, contextBar]) await until(async () => !(await hidden.isVisible()), 'Panel, status bar, toggle and context sidebar hide at 900px');
  await nav.getByRole('button', { name: 'Desk', exact: true }).waitFor();
  await noOverflow(); await shot('05-narrow-900.png');
  pass('At 900px the side panel, status bar and context sidebar are hidden while the rail stays');
  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of ['Desk', 'Work', 'Schedule']) assert.ok(await nav.getByRole('button', { name, exact: true }).isVisible());
  assert.ok(await workspace.isVisible());
  await noOverflow(); await shot('06-phone-390.png');
  pass('At 390px the three doors and Workspace stay visible with no horizontal scroll');

  // 8. Windows chrome (emulated): the preload's platform signal, window.ogb.platform = 'win32'.
  assert.equal(await page.locator('.rb-win-titlebar').count(), 0, 'No Windows strip off Windows');
  // Set after connecting: a full ogb bridge would take the desktop session handshake, which a
  // browser page cannot. The shell reads the platform on render, so switching views applies it.
  win = page;
  await win.setViewportSize({ width: 1440, height: 940 });
  await win.evaluate(() => { window.ogb = { platform: 'win32' }; location.hash = '/ask'; });
  await win.waitForURL(url => url.hash === '#/ask');
  await win.evaluate(() => { location.hash = '/desk'; }); await win.waitForURL(url => url.hash === '#/desk');
  await win.getByRole('heading', { name: 'Desk', exact: true }).waitFor(); await win.locator('.rb-win-titlebar').waitFor();
  const caption = 140; // Windows' three 46px caption buttons, rounded up
  const chrome = async () => win.evaluate(caption => {
    const region = element => { for (let node = element; node; node = node.parentElement) { const value = getComputedStyle(node).getPropertyValue('-webkit-app-region').trim(); if (value === 'drag' || value === 'no-drag') return value; } return 'none'; };
    const strip = document.querySelector('.rb-win-titlebar'), stripBox = strip?.getBoundingClientRect();
    const controls = [...document.querySelectorAll('button, a[href], input, select, textarea, summary, [role="tab"], [role="separator"], [tabindex]:not([tabindex="-1"])')]
      .map(element => ({ element, box: element.getBoundingClientRect() })).filter(({ box }) => box.width > 0 && box.height > 0);
    const name = element => element.getAttribute('aria-label') || element.textContent.trim().slice(0, 40) || element.tagName;
    return {
      strip: strip ? { region: region(strip), height: stripBox.height, width: stripBox.width } : null,
      underCaption: controls.filter(({ box }) => box.top < stripBox.bottom && box.right > innerWidth - caption).map(({ element }) => name(element)),
      inStrip: controls.filter(({ box }) => box.top < stripBox.bottom).map(({ element }) => name(element)),
      dragControls: controls.filter(({ element }) => region(element) === 'drag').map(({ element }) => name(element)),
      railTop: region(document.querySelector('.rb-rail-top')),
      tabbarTop: document.querySelector('[role="tablist"][aria-label="Desk views"]')?.getBoundingClientRect().top ?? null,
      tabbarRight: document.querySelector('[role="tablist"][aria-label="Desk views"]')?.getBoundingClientRect().right ?? null,
      panelTop: document.querySelector('.rb-context-panel')?.getBoundingClientRect().top ?? null,
      width: innerWidth,
    };
  }, caption);
  const desk1440 = await chrome();
  assert.equal(desk1440.strip?.region, 'drag', 'The Windows title strip is a drag region');
  assert.equal(desk1440.strip.height, 40, 'The strip matches the 40px titleBarOverlay height');
  assert.equal(desk1440.strip.width, desk1440.width, 'The strip spans the window');
  assert.equal(desk1440.railTop, 'drag', 'The rail top drags on Windows');
  assert.deepEqual(desk1440.underCaption, [], 'Nothing interactive under the caption buttons');
  assert.deepEqual(desk1440.inStrip, [], 'Nothing interactive inside the strip');
  assert.deepEqual(desk1440.dragControls, [], 'Every control inside a drag region is no-drag');
  assert.ok(desk1440.tabbarTop >= desk1440.strip.height && desk1440.panelTop >= desk1440.strip.height, 'Tabs and side panel start below the caption buttons');
  await win.screenshot({ path: join(output, '08-windows-titlebar.png'), animations: 'disabled' }); screenshots.push('08-windows-titlebar.png');
  const windows = { desk1440 };
  for (const [hash, width] of [['#/ask', 1440], ['#/schedule', 1100], ['#/you', 960], ['#/desk', 1100]]) {
    await win.setViewportSize({ width, height: 900 });
    await win.evaluate(next => { location.hash = next; }, hash); await win.waitForURL(url => url.hash === hash); await wait(300);
    const seen = windows[`${hash.slice(2)}${width}`] = await chrome();
    assert.deepEqual([seen.underCaption, seen.inStrip, seen.dragControls], [[], [], []], `No control under the caption buttons, in the strip or left draggable at ${hash} ${width}px`);
  }
  measurements.windows = Object.fromEntries(Object.entries(windows).map(([key, value]) => [key, { strip: value.strip, railTop: value.railTop, tabbarTop: value.tabbarTop, tabbarRight: value.tabbarRight, panelTop: value.panelTop }]));
  win = undefined;
  pass('Emulated Windows (ogb.platform win32): a 40px full-width drag strip sits under the caption buttons, the rail top drags, and no control is under the buttons, in the strip or draggable on Desk, Work, Schedule and Workspace at 960–1440px');

  assert.deepEqual(errors, []);
  pass('No renderer page errors');
} catch (cause) {
  failure = cause instanceof Error ? cause.stack : String(cause);
  await (win ?? page)?.screenshot({ path: join(output, 'failure.png'), animations: 'disabled' }).catch(() => {});
  console.error(failure);
} finally {
  await browser?.close();
  if (child?.exitCode === null) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), wait(5000)]); if (child.exitCode === null) child.kill('SIGKILL'); }
  rmSync(temp, { recursive: true, force: true });
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ at: new Date().toISOString(), passed: !failure, layer: 'Built React UI (scratch build) in headless Chrome against a real disposable local service; fictional sample book', checks, measurements, screenshots, errors, failure: failure ?? null,
    limits: ['Fictional sample book and an offline fake worker; no customer records, accounts or browser profiles.', 'Not a packaged app or installed-device check.', 'The browser-task Stop and spend figures need a running task and a linked office; here they read as idle and "Spend not reported".'] }, null, 2) + '\n');
  if (failure) process.exitCode = 1;
}
