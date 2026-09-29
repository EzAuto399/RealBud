// Launch the INSTALLED RealBud.app against a disposable sandbox.
// usage: node launch.mjs <sandbox-name> <cdp-port> [extra electron args...]
// env QA_DATA_DIR overrides data dir; QA_OFFLINE=1 adds a blackhole proxy.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const SP = '/private/tmp/claude-501/-Users-yoda-projects-RealBud/1e5b5f5f-34c1-402c-9819-6956729fe386/scratchpad/qa';
const [name, cdp, ...extra] = process.argv.slice(2);
const box = join(SP, name), home = join(box, 'home'), data = process.env.QA_DATA_DIR || join(home, '.realbud'), userData = join(box, 'ud'), tmp = join(box, 'tmp');
for (const d of [home, userData, tmp]) mkdirSync(d, { recursive: true, mode: 0o700 });
if (!process.env.QA_DATA_DIR) mkdirSync(data, { recursive: true, mode: 0o700 });
// Keep desktop control (cua) off in the sandbox, as qa-business-desktop.mjs does.
if (!existsSync(join(userData, 'cua-human-pause.json'))) writeFileSync(join(userData, 'cua-human-pause.json'), JSON.stringify({ version: 1, paused: true }), { mode: 0o600 });
const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: tmp, LANG: 'en_US.UTF-8',
  REALBUD_DATA_DIR: data, REALBUD_LOG_DIR: join(box, 'logs') };
const args = [`--user-data-dir=${userData}`, `--remote-debugging-port=${cdp}`, '--use-mock-keychain', '--no-first-run', '--disable-component-update', ...extra];
if (process.env.QA_OFFLINE === '1') args.push('--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=127.0.0.1;localhost');
const out = openSync(join(box, `app-${Date.now()}.log`), 'a');
const child = spawn('/Applications/RealBud.app/Contents/MacOS/RealBud', args, { env, detached: true, stdio: ['ignore', out, out], cwd: home });
child.unref();
console.log(JSON.stringify({ pid: child.pid, box, data, userData }));
