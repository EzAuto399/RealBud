// Owner-side QA and tooling only. The per-boot session token is read from the
// service's private data directory, never from HTTP. Run directly to print the
// token for pasting into the browser development UI:
//   node scripts/local-session.mjs [data directory]
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLocalSession } from '../shared/local-session.mjs';
import { windowsKeyPrivacy } from '../electron/desk-key-custody.mjs';

/** Session storage key the renderer reads in a plain browser (no desktop bridge). */
export const BROWSER_SESSION_KEY = 'realbud.localSession';

/** The token of the service that owns `dataDirectory`. Waits briefly for a
 * service that is still starting; never falls back to anything else. */
export async function readSessionToken(dataDirectory, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = await readLocalSession(dataDirectory, { verifyWindowsPrivacy: windowsKeyPrivacy });
    if (record) return record.token;
    if (Date.now() >= deadline) throw new Error('The office service has not published its local session.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/** Session storage key that passes the office-link screen for this app session
 * (`LINK_GATE_LEFT` in src/lib/bud-setup.ts). In the app only recovery sets it. */
export const LINK_GATE_LEFT_KEY = 'realbud.linkGateLeft';

/** Give a Playwright context's pages on exactly `origin` the owner's token, the
 * same way a developer pastes it: tab session storage, never a URL. By default
 * this QA harness also passes the office-link screen for the session, so
 * scripts reach the shell on an unlinked fictional computer; no screen offers
 * that (only recovery passes it). `{ linkGate: true }` keeps the screen for
 * scripts that test linking or an unlinked computer. */
export async function primeBrowserSession(context, origin, token, { linkGate = false } = {}) {
  const expected = new URL(origin).origin;
  await context.addInitScript(({ key, value, expected, gateKey }) => {
    if (window.location.origin !== expected) return;
    window.sessionStorage.setItem(key, value);
    if (gateKey) window.sessionStorage.setItem(gateKey, '1');
  }, { key: BROWSER_SESSION_KEY, value: token, expected, gateKey: linkGate ? null : LINK_GATE_LEFT_KEY });
}

/** Contacts RealBud writes for a sample book; never a person (TRAINING_PERSON in src/lib/first-run.ts). */
const SAMPLE_CONTACTS = new Set(['sample pm', 'demo pm']);

/**
 * QA only, for disposable fictional workspaces. Reaches what first run's
 * removed "Open the sample desk first" reached, without a screen: the saved
 * setup completed, the office contact named exactly as `finish()` in
 * src/components/Onboarding.tsx names it (the saved profile name, else
 * "Sample PM", and only when no person is recorded yet), and the office-link
 * screen passed for this tab's session. Then reloads and waits for Desk.
 *
 * Call it once the welcome form has saved (the connect step shows) or on any
 * page of the app. Requests go from the page with its own session token, as
 * the app's `api()` sends them in a plain browser. It is not evidence that a
 * person completed or linked anything.
 */
export async function enterSampleDeskForQa(page) {
  const request = (path, method = 'GET', body) => page.evaluate(async ({ path, method, body, key }) => {
    const response = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-realbud-session': sessionStorage.getItem(key) ?? '' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  }, { path, method, body, key: BROWSER_SESSION_KEY });
  const desk = await request('/api/desk');
  const contact = String(desk?.book?.office?.pmUser ?? '').trim();
  if (!contact || SAMPLE_CONTACTS.has(contact.toLowerCase())) {
    const typed = String((await request('/api/config'))?.profile?.name ?? '').trim();
    await request('/api/desk/agency', 'PATCH', { office: { pmUser: typed || 'Sample PM' }, expectedWorkspaceId: desk.workspaceId, expectedRevision: desk.revision });
  }
  let saved = await request('/api/onboarding');
  for (const stage of ['office-rules', 'complete']) {
    if (saved.stage === 'complete') break;
    if (saved.stage === stage) continue;
    saved = await request('/api/onboarding', 'PUT', { expectedScope: saved.scope, expectedRevision: saved.revision, stage });
  }
  if (saved.stage !== 'complete') throw new Error(`Saved setup did not complete: ${JSON.stringify(saved)}`);
  await page.evaluate(key => sessionStorage.setItem(key, '1'), LINK_GATE_LEFT_KEY);
  await page.reload();
  await page.getByRole('heading', { name: 'Desk', exact: true }).waitFor();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dataDirectory = process.argv[2] ?? process.env.REALBUD_DATA_DIR ?? process.env.OMB_DATA_DIR ?? join(homedir(), '.realbud');
  process.stdout.write(`${await readSessionToken(dataDirectory, { timeoutMs: 0 })}\n`);
}
