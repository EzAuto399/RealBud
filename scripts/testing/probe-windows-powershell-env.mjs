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
// What scripts/service-smoke-env.mjs hands the installed service: a fake home
// whose application-data directories do not exist and a PATH of one directory.
const fakeHome = join(scratch, 'rb-probe-fake-home-' + process.pid);
const smokeHome = { HOME: fakeHome, USERPROFILE: fakeHome, APPDATA: join(fakeHome, 'AppData', 'Roaming'), LOCALAPPDATA: join(fakeHome, 'AppData', 'Local') };
const exeDir = join(process.execPath, '..');
const variants = [
  ['smoke-like', { ...stripped, ...smokeHome, PATH: exeDir }],
  ['smoke-like+system32-path', { ...stripped, ...smokeHome, PATH: `${exeDir};${join(systemRoot, 'System32')};${join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')}` }],
  ['smoke-like+real-profile', { ...stripped, ...profile, PATH: exeDir }],
  ['full', { ...source, ...pinned }],
  ['stripped', stripped],
  ['stripped+path', { ...stripped, ...path }],
  ['stripped+profile', { ...stripped, ...profile }],
  ['stripped+program', { ...stripped, ...program }],
  ['stripped+profile+path', { ...stripped, ...profile, ...path }],
  ['stripped+profile+path+program', { ...stripped, ...profile, ...path, ...program }],
];
const commands = {
  exit: 'exit 0',
  // The same work with and without a cmdlet: New-Object auto-loads a module.
  dotnet: '$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl = New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); exit 0',
  'dotnet-new': '$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl = [System.Security.AccessControl.DirectorySecurity]::new(); $acl.SetOwner($sid); exit 0',
};
const wanted = new Set(['smoke-like', 'full', 'stripped']);
const only = process.argv.includes('--all') ? variants : variants.filter(([name]) => wanted.has(name));
console.log(JSON.stringify({ parent: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.versions.node}`, execPath: process.execPath.length > 0, cwd: process.cwd().length > 0 }));
for (const [name, env] of only) {
  for (const [command, text] of Object.entries(commands)) {
    const encoded = Buffer.from(text, 'utf16le').toString('base64');
    const runs = [];
    for (let i = 0; i < 2; i++) {
      const started = Date.now();
      const result = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { env, windowsHide: true, timeout: 180_000, stdio: 'ignore' });
      runs.push({ ms: Date.now() - started, status: result.status, error: result.error?.code ?? null });
    }
    console.log(JSON.stringify({ variant: name, command, keys: Object.keys(env).length, runs }));
  }
}
