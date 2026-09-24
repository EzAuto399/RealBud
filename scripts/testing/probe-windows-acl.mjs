// Windows-only probe: runs the private-storage ACL admission in the situations
// the unit suite and the installed service use, and prints only the module's
// own bounded failure fields. No path, identity or native message is printed.
// Run: node --experimental-strip-types scripts/testing/probe-windows-acl.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { windowsFilePrivacy, windowsFilePrivacySync, windowsFilePrivacyBatchSync } from '../../server/windows-file-privacy.ts';

if (process.platform !== 'win32') { console.log('probe-windows-acl: not win32, nothing to do'); process.exit(0); }
const roots = [['TEMP', tmpdir()], ['RUNNER_TEMP', process.env.RUNNER_TEMP], ['USERPROFILE', process.env.USERPROFILE]].filter(([, p]) => p);
const homes = [['inherited-home', null], ['relocated-home', mkdtempSync(join(tmpdir(), 'omb-test-home-'))]];
const rows = [];
const describe = error => {
  const e = error && typeof error === 'object' ? error : {};
  return { category: e.category ?? null, exit: e.nativeExitCode ?? null, detail: e.detail ?? null, timedOut: e.timedOut ?? null, name: e.name ?? String(error).slice(0, 60) };
};
for (const [homeLabel, home] of homes) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  if (home) { process.env.HOME = home; process.env.USERPROFILE = home; }
  for (const [rootLabel, root] of roots) {
    const dir = mkdtempSync(join(root, 'rb-acl-probe-'));
    const file = join(dir, 'entry.json'); writeFileSync(file, '{}');
    const nested = join(dir, 'nested'); mkdirSync(nested);
    const cases = [
      ['dir restrict sync', () => windowsFilePrivacySync(dir, 'directory', true)],
      ['dir verify sync', () => windowsFilePrivacySync(dir, 'directory')],
      ['file restrict async', () => windowsFilePrivacy(file, 'file', true)],
      ['file verify async', () => windowsFilePrivacy(file, 'file')],
      ['batch nested', () => windowsFilePrivacyBatchSync([{ path: nested, kind: 'directory', action: 'restrict' }, { path: nested, kind: 'directory', action: 'verify' }])],
    ];
    for (const [label, run] of cases) {
      const started = Date.now();
      let outcome = 'ok';
      try { await run(); } catch (error) { outcome = describe(error); }
      rows.push({ home: homeLabel, root: rootLabel, case: label, ms: Date.now() - started, outcome });
    }
    rmSync(dir, { recursive: true, force: true });
  }
  process.env.HOME = saved.HOME; process.env.USERPROFILE = saved.USERPROFILE;
}
for (const row of rows) console.log(JSON.stringify(row));
const failed = rows.filter(r => r.outcome !== 'ok').length;
console.log(`probe-windows-acl: ${rows.length - failed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
