/** Renders the permanent AuthUnavailable state from the built site with no
 * auth secret configured. No database needed: this path never reaches one. */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
const website = '/Users/yoda/projects/RealBud/website';
const output = '/Users/yoda/projects/RealBud/outputs/portal-ux-2026-09-22/slice1';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const port = 4599, origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [join(website, 'node_modules/next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], {
  cwd: website,
  env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', REALBUD_AUTH_SECRET: '', SUPABASE_URL: '', NEXT_PUBLIC_SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let browser;
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(origin + '/sign-in')).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE });
  for (const scheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: scheme });
    const page = await context.newPage();
    await page.goto(origin + '/sign-in');
    await page.getByRole('status').waitFor();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(output, `sign-in-unavailable-1280-${scheme}.png`), fullPage: true });
    const mobile = await browser.newContext({ viewport: { width: 360, height: 780 }, colorScheme: scheme });
    const small = await mobile.newPage();
    await small.goto(origin + '/sign-in');
    await small.getByRole('status').waitFor();
    await small.waitForTimeout(1500);
    console.log(scheme, 'no horizontal overflow:', await small.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await small.screenshot({ path: join(output, `sign-in-unavailable-360-${scheme}.png`), fullPage: true });
    await mobile.close();
    await context.close();
  }
  console.log('ok');
} finally {
  await browser?.close();
  child.kill('SIGTERM');
}
