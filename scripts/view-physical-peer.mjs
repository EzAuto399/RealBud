// Resume only the named synthetic physical-Mac workspace for attended testing.
// The kit launcher owns the service and enforces its two-hour stop deadline.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
const kit = dirname(dirname(process.execPath));
assert.equal(JSON.parse(await readFile(join(kit, 'test-kit.json'), 'utf8')).kind, 'RealBud synthetic two-profile test kit');
const base = join(homedir(), '.realbud/test-lab/physical-macs-v2-2026-09-14');
await readFile(join(base, 'peer-test-identity.json'), 'utf8'); // Must already be enrolled by the rehearsal.
const child = spawn(process.execPath, [join(kit, 'scripts/start-test-lab.mjs'), 'client'], {
  cwd: kit, env: { PATH: dirname(process.execPath), HOME: homedir(), USERPROFILE: homedir(), TMPDIR: process.env.TMPDIR || '/tmp', LANG: 'C', LC_ALL: 'C', REALBUD_TEST_LAB_ROOT: base },
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});
child.on('message', async event => {
  if (event?.type !== 'realbud-test-ready') return;
  assert.match(event.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  await writeFile(join(homedir(), 'Downloads/realbud-test.webloc'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>URL</key><string>${event.url}</string></dict></plist>`, { mode: 0o600 });
  console.log('Ready. In a second Terminal window: open downloads/realbud-test.webloc');
});
child.on('error', () => { console.error('The test launcher could not start.'); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { if (child.connected) child.send({ type: 'realbud-test-stop' }); });
child.on('exit', code => { process.exitCode = code ?? 1; });
