// Windows-only probe: how long does a trivial Windows PowerShell 5.1 launch take
// under the environments RealBud's installed service and its tests use? Prints
// variant names and milliseconds only.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

if (process.platform !== 'win32') { console.log('probe-windows-powershell-env: not win32, nothing to do'); process.exit(0); }
const source = process.env;
const systemRoot = source.SystemRoot ?? 'C:\\Windows';
const exe = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const pick = names => Object.fromEntries(names.filter(n => source[n] !== undefined).map(n => [n, source[n]]));
const pinned = { PSModulePath: join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') };
const scratch = tmpdir();
const stripped = { ...pick(['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SystemDrive']), TMP: scratch, TEMP: scratch, ...pinned };
const profile = pick(['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN']);
const path = pick(['PATH', 'Path']);
const program = pick(['ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'CommonProgramFiles', 'ALLUSERSPROFILE', 'PUBLIC']);
const variants = [
  ['full', { ...source, ...pinned }],
  ['stripped', stripped],
  ['stripped+path', { ...stripped, ...path }],
  ['stripped+profile', { ...stripped, ...profile }],
  ['stripped+program', { ...stripped, ...program }],
  ['stripped+profile+path', { ...stripped, ...profile, ...path }],
  ['stripped+profile+path+program', { ...stripped, ...profile, ...path, ...program }],
];
const encoded = Buffer.from('exit 0', 'utf16le').toString('base64');
for (const [name, env] of variants) {
  const runs = [];
  for (let i = 0; i < 2; i++) {
    const started = Date.now();
    const result = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { env, windowsHide: true, timeout: 180_000, stdio: 'ignore' });
    runs.push({ ms: Date.now() - started, status: result.status, error: result.error?.code ?? null });
  }
  console.log(JSON.stringify({ variant: name, keys: Object.keys(env).length, runs }));
}
