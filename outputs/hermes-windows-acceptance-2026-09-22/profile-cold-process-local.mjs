// Portable harness check only; this is not native Windows acceptance.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'realbud-profile-cold-local-')));
const home = join(root, 'owned-home');
Object.assign(process.env, { HOME: root, USERPROFILE: root, REALBUD_HERMES_HOME: home, REALBUD_DATA_DIR: join(root, 'data') });
for (const key of Object.keys(process.env)) if (/API_KEY$|_TOKEN$|_SECRET$|_PASSWORD$/.test(key)) delete process.env[key];
try {
  const moduleUrl = new URL('../../server/hermes-pack.ts', import.meta.url).href;
  const { ensurePropertyPack } = await import(moduleUrl);
  const installed = ensurePropertyPack(home);
  const path = join(installed.dir, 'config.yaml'), before = readFileSync(path);
  const script = `const { ensurePropertyPack } = await import(${JSON.stringify(moduleUrl)}); process.stdout.write(JSON.stringify(ensurePropertyPack(${JSON.stringify(home)}).wrote));`;
  const output = execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { env: process.env, shell: false, timeout: 60_000, maxBuffer: 4096 });
  if (JSON.stringify(JSON.parse(output.toString('utf8'))) !== '[]' || !readFileSync(path).equals(before)) throw new Error('Cold-process local harness failed.');
  console.log(JSON.stringify({ passed: true, platform: process.platform, proof: 'source import and cold-process preservation only; no native Windows execution' }));
} finally { rmSync(root, { recursive: true, force: true }); }
