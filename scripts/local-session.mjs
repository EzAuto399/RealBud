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

/** Give a Playwright context's pages on exactly `origin` the owner's token, the
 * same way a developer pastes it: tab session storage, never a URL. */
export async function primeBrowserSession(context, origin, token) {
  const expected = new URL(origin).origin;
  await context.addInitScript(({ key, value, expected }) => {
    if (window.location.origin === expected) window.sessionStorage.setItem(key, value);
  }, { key: BROWSER_SESSION_KEY, value: token, expected });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dataDirectory = process.argv[2] ?? process.env.REALBUD_DATA_DIR ?? process.env.OMB_DATA_DIR ?? join(homedir(), '.realbud');
  process.stdout.write(`${await readSessionToken(dataDirectory, { timeoutMs: 0 })}\n`);
}
