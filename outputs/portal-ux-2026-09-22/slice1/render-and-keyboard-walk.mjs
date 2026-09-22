/** Slice-1 render + keyboard walk. Real built Next on the command-site harness
 * (real disposable PostgreSQL); no route interception, no stubbed RPCs. */
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startCommandSite } from '/Users/yoda/projects/RealBud/website/scripts/testing/command-site.mjs';

const output = '/Users/yoda/projects/RealBud/outputs/portal-ux-2026-09-22/slice1';
await mkdir(output, { recursive: true });
if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);

let site, browser;
const errors = [], external = [], notes = [];
const receipt = { ok: false, notes };
try {
  site = await startCommandSite();
  const http = async (path, body, headers, method = 'POST') => {
    const response = await fetch(site.origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  // One paired computer so the list renders rows rather than the empty state.
  const pairing = await http('/api/account/installations', {}, site.headers('a'));
  assert.equal(pairing.status, 201);
  const id = randomUUID(), token = randomBytes(32).toString('hex');
  const deviceHeaders = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const redeemed = await http('/api/installations/redeem', { code: pairing.body.code, id, token, label: 'Reception Mac', platform: 'darwin', appVersion: '0.1.0' }, deviceHeaders);
  assert.equal(redeemed.status, 200);
  await http('/api/installations/report', { appVersion: '0.1.0', workerVersion: '0.4.2', workerReady: true }, deviceHeaders);

  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const shot = async (path, name, width, height, colorScheme) => {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme });
    await context.addCookies([{ name: 'rb_session', value: site.cookie('a').slice('rb_session='.length), url: site.origin, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (new URL(r.url()).origin !== site.origin) external.push(r.url()); });
    await page.goto(site.origin + path);
    await page.getByRole('heading', { level: 1 }).waitFor();
    await page.waitForTimeout(400);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    assert.ok(overflow, `horizontal overflow at ${width} ${name}`);
    await page.screenshot({ path: join(output, name), fullPage: true });
    await context.close();
  };
  for (const scheme of ['light', 'dark'])
    for (const [w, h] of [[360, 780], [768, 1024], [1280, 900]])
      await shot('/account/installations', `installations-${w}-${scheme}.png`, w, h, scheme);
  if (process.env.UI_CHECK_ROUTE)
    for (const scheme of ['light', 'dark'])
      await shot('/account/ui-check', `components-1280-${scheme}.png`, 1280, 900, scheme);
  notes.push('screenshots: /account/installations at 360, 768, 1280 in light and dark; component check at 1280');

  // Keyboard walk on the real page.
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies([{ name: 'rb_session', value: site.cookie('a').slice('rb_session='.length), url: site.origin, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(site.origin + '/account/installations');
  await page.getByRole('heading', { level: 1 }).waitFor();
  const focused = () => page.evaluate(() => {
    const a = document.activeElement;
    if (!a) return 'none';
    const ring = getComputedStyle(a).outlineWidth;
    return `${a.tagName.toLowerCase()}${a.getAttribute('aria-current') ? '[current]' : ''}: ${(a.textContent || a.getAttribute('aria-label') || '').trim().slice(0, 40)} (outline ${ring})`;
  });
  const walk = [];
  await page.evaluate(() => document.body.focus());
  await page.keyboard.press('Tab');
  for (let i = 0; i < 12; i++) { walk.push(await focused()); await page.keyboard.press('Tab'); }
  notes.push({ tabOrder: walk });

  if (process.env.UI_CHECK_ROUTE) {
  // ConfirmDialog: open with the keyboard, check focus moves in, Escape closes,
  // focus returns to the trigger.
  await page.goto(site.origin + '/account/ui-check');
  await page.getByRole('button', { name: 'Disconnect this computer' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('dialog').waitFor();
  const inside = await page.evaluate(() => ({
    modal: document.querySelector('dialog')?.matches(':modal') ?? false,
    focus: document.activeElement?.textContent?.trim(),
    labelledby: !!document.querySelector('dialog')?.getAttribute('aria-labelledby'),
    describedby: !!document.querySelector('dialog')?.getAttribute('aria-describedby'),
  }));
  await page.screenshot({ path: join(output, 'confirm-dialog-1280-light.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => ({
    open: !!document.querySelector('dialog'),
    focus: document.activeElement?.textContent?.trim(),
  }));
  notes.push({ dialogOpen: inside, afterEscape: after });
  assert.equal(inside.modal, true);
  assert.equal(inside.focus, 'Cancel');
  assert.equal(inside.labelledby && inside.describedby, true);
  assert.equal(after.open, false);
  assert.equal(after.focus, 'Disconnect this computer');
  }
  await context.close();

  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.deepEqual(site.stats().violations, []);
  receipt.ok = true;
  receipt.browserErrors = errors;
  receipt.offOriginRequests = external;
  receipt.layers = { portal: 'actual built Next and rendered React', database: 'actual disposable PostgreSQL', execution: 'none needed' };
} finally {
  await browser?.close();
  await site?.stop();
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
}
console.log(JSON.stringify(receipt, null, 2));
