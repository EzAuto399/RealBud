// Connect over CDP to the sandboxed app and run a snippet.
// usage: node drive.mjs <cdp-port> <file-with-async-body.js>   (body gets page, shot(name), OUT, text())
import { readFileSync } from 'node:fs';
const { chromium } = await import('/Users/yoda/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs');
const OUT = '/Users/yoda/projects/RealBud/outputs/mac-installed-qa-0.1.19-2026-09-25';
const [cdp, file] = process.argv.slice(2);
let browser;
for (let i = 0; i < 60; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdp}`); break; } catch { await new Promise(r => setTimeout(r, 500)); } }
if (!browser) throw new Error('no CDP');
const ctx = browser.contexts()[0];
let page = ctx.pages().find(p => p.url().startsWith('http://127.0.0.1')) ?? ctx.pages()[0] ?? await ctx.waitForEvent('page');
page.setDefaultTimeout(15000);
const errors = []; page.on('pageerror', e => errors.push(e.message));
const shot = n => page.screenshot({ path: `${OUT}/${n}.png` });
const text = async () => (await page.evaluate(() => document.body.innerText)).slice(0, 4000);
const Fn = Object.getPrototypeOf(async function () {}).constructor;
try {
  const r = await new Fn('page', 'shot', 'text', 'OUT', 'ctx', readFileSync(file, 'utf8'))(page, shot, text, OUT, ctx);
  if (r !== undefined) console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 1));
} catch (e) { console.log('ERROR', e.message.split('\n').slice(0, 6).join('\n')); }
if (errors.length) console.log('PAGEERRORS', errors);
process.exit(0);
