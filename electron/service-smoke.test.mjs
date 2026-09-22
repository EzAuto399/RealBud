import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, matchesGlob, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { serviceSmokeEnv } from '../scripts/service-smoke-env.mjs';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE_FIXTURE_SCRIPT = `$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
foreach ($item in @($env:REALBUD_FIXTURE_OBJECTS | ConvertFrom-Json)) {
  if ($item.directory) { $acl = [System.Security.AccessControl.DirectorySecurity]::new() }
  else { $acl = [System.Security.AccessControl.FileSecurity]::new() }
  $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false)
  foreach ($principal in @($sid, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
    if ($item.directory) { $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow') }
    else { $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', 'Allow') }
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $item.path -AclObject $acl
}`;
const BROAD_FIXTURE_SCRIPT = `$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:REALBUD_FIXTURE_BROAD_FILE
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'), 'Read', 'Allow'))
Set-Acl -LiteralPath $env:REALBUD_FIXTURE_BROAD_FILE -AclObject $acl`;

describe('installed Windows service acceptance', () => {
  it('selects the NSIS filename actually emitted by electron-builder', async () => {
    const builder = parse(await readFile(join(root, 'electron-builder.yml'), 'utf8'));
    const workflow = parse(await readFile(join(root, '.github/workflows/package-win.yml'), 'utf8'));
    const step = workflow.jobs.package.steps.find(step => step.name === 'Install and exercise the packaged Windows runtime');
    const glob = step.run.match(/Get-ChildItem (release\/[^\s)]+)/)?.[1];
    expect(glob).toBeTruthy();
    const filename = builder.nsis.artifactName.replace('${version}', '0.0.0-fixture').replace('${ext}', 'exe');
    expect(matchesGlob(`release/${filename}`, glob)).toBe(true);
    expect(matchesGlob('release/RealBud-0.0.0-fixture-x64.zip', glob)).toBe(false);
  });

  it('keeps Electron in Node mode and isolates both Windows and POSIX user data', () => {
    const env = serviceSmokeEnv({ executable: '/fixture/RealBud.exe', home: '/isolated/home', data: '/isolated/data', scratch: '/isolated', port: 12345 }, {
      HOME: '/customer/home', APPDATA: '/customer/roaming', LOCALAPPDATA: '/customer/local',
      PATH: '/customer/tools', NODE_OPTIONS: '--require customer.js', NODE_PATH: '/customer/modules',
      OPENAI_API_KEY: 'fictional-provider-key', COMPOSIO_API_KEY: 'fictional-connector-key',
      REALBUD_DATA_DIR: '/customer/data', ELECTRON_RUN_AS_NODE: '0', SystemRoot: 'C:\\Windows',
    });
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(env.HOME).toBe('/isolated/home');
    expect(env.USERPROFILE).toBe('/isolated/home');
    expect(env.APPDATA).toBe(join('/isolated/home', 'AppData', 'Roaming'));
    expect(env.LOCALAPPDATA).toBe(join('/isolated/home', 'AppData', 'Local'));
    expect(env.REALBUD_DATA_DIR).toBe('/isolated/data');
    expect(env.SystemRoot).toBe('C:\\Windows');
    for (const key of ['OPENAI_API_KEY', 'COMPOSIO_API_KEY', 'NODE_OPTIONS', 'NODE_PATH']) expect(env[key]).toBeUndefined();
  });

  it.each(['complete', 'missing compiled import', 'missing packaged safeguards', 'health without profile', 'false policy status', 'public profile', 'unsafe written policy', 'wrong skill bytes'])('checks explicit fresh-profile smoke boundaries: %s', async scenario => {
    const scratch = await mkdtemp(join(tmpdir(), 'RealBud installed service fixture '));
    try {
      const source = join(scratch, 'installed resources');
      for (const directory of ['server/company', 'shared', 'src']) await mkdir(join(source, directory), { recursive: true });
      const pack = join(source, 'pack', 'property');
      if (scenario !== 'missing packaged safeguards') {
        await mkdir(join(pack, 'skills', 'fictional-skill'), { recursive: true });
        for (const [name, contents] of Object.entries({
          'SOUL.md': '# Fictional smoke profile\n',
          'config.yaml': 'approvals:\n  mode: manual\nterminal:\n  home_mode: profile\nmemory:\n  write_approval: true\n',
          'distribution.yaml': 'name: fictional-smoke\n',
          'profile.yaml': 'description: Fictional smoke profile\n',
          'skills/fictional-skill/SKILL.md': '# Fictional bounded skill\n',
        })) await writeFile(join(pack, name), contents);
      }
      await writeFile(join(source, 'server/company/host-certificate.js'), 'export async function createHostCertificate() {}\n');
      // This is only a harness fixture. The real bundled server/TLS check is a
      // separate local/installed smoke, not inferred from this miniature server.
      await writeFile(join(source, 'server/bootstrap.js'), "await import('./index.js');\n");
      await writeFile(join(source, 'server/index.js'), scenario === 'missing compiled import' ? "import './missing-packaged-module.js';\n" : `
        import assert from 'node:assert/strict';
        import { createServer } from 'node:http';
        import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
        import { execFileSync } from 'node:child_process';
        import { dirname, join } from 'node:path';
        import { fileURLToPath } from 'node:url';
        assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1');
        assert.equal(process.env.OPENAI_API_KEY, undefined);
        const scenario = ${JSON.stringify(scenario)};
        const home = process.env.REALBUD_HERMES_HOME, profile = join(home, 'profiles', 'property');
        assert.equal(existsSync(home), false);
        if (scenario !== 'health without profile') {
          const pack = join(dirname(fileURLToPath(import.meta.url)), '..', 'pack', 'property');
          const directories = [home, join(home, 'profiles'), profile, join(profile, 'skills'), join(profile, 'skills', 'fictional-skill')];
          const copies = ['SOUL.md', 'config.yaml', 'distribution.yaml', 'profile.yaml', 'skills/fictional-skill/SKILL.md'];
          const files = [join(home, 'auth.json'), ...copies.map(name => join(profile, name))];
          for (const path of directories) mkdirSync(path, { mode: 0o700 });
          for (const path of files) writeFileSync(path, '', { mode: 0o600, flag: 'wx' });
          if (process.platform === 'win32') {
            // Prepare only empty, newly owned fake-server fixture objects. The
            // smoke's independent read-only witness must check their actual ACL.
            const script = ${JSON.stringify(PRIVATE_FIXTURE_SCRIPT)};
            execFileSync(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
              env: { ...process.env, REALBUD_FIXTURE_OBJECTS: JSON.stringify([...directories.map(path => ({ path, directory: true })), ...files.map(path => ({ path, directory: false }))]) },
              shell: false, windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
            });
          }
          for (const name of copies) writeFileSync(join(profile, name), readFileSync(join(pack, name)));
          writeFileSync(join(home, 'auth.json'), JSON.stringify({ version: 1, providers: {}, credential_pool: {} }));
          if (scenario === 'unsafe written policy') {
            const config = join(profile, 'config.yaml');
            writeFileSync(config, readFileSync(config, 'utf8').replace('write_approval: true', 'write_approval: false'));
          }
          if (scenario === 'wrong skill bytes') writeFileSync(join(profile, 'skills', 'fictional-skill', 'SKILL.md'), '# Incorrectly provisioned skill');
          if (scenario === 'public profile') {
            const path = join(profile, 'config.yaml');
            if (process.platform !== 'win32') chmodSync(path, 0o644);
            else {
              const script = ${JSON.stringify(BROAD_FIXTURE_SCRIPT)};
              execFileSync(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
                env: { ...process.env, REALBUD_FIXTURE_BROAD_FILE: path }, shell: false, windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
              });
            }
          }
        }
        const server = createServer((req, res) => {
          res.setHeader('content-type', 'application/json');
          if (req.url === '/api/health') return res.end(JSON.stringify({ app: 'realbud', pid: process.pid }));
          if (req.url === '/api/session') return res.end(JSON.stringify({ token: 'fictional-session' }));
          if (req.url === '/api/company/status' && req.headers['x-realbud-session'] === 'fictional-session') {
            return res.end(JSON.stringify({ storageAvailable: false }));
          }
          if (req.url === '/api/hermes' && req.headers['x-realbud-session'] === 'fictional-session') {
            return res.end(JSON.stringify({ pack: { installed: true, approvalsManual: true, workroomReady: scenario !== 'false policy status' }, homeDir: home, profileDir: profile, model: { attached: false }, ready: false }));
          }
          res.writeHead(401); res.end('{}');
        });
        server.listen(Number(process.env.OMB_PORT), '127.0.0.1');
      `);
      const receiptPath = join(scratch, 'receipt.json');
      let failure;
      try {
        await execute(process.execPath, [join(root, 'scripts/smoke-company-bundle.mjs'), receiptPath, source], {
          cwd: scratch, env: { ...process.env, OPENAI_API_KEY: 'fictional-must-not-inherit' }, timeout: 30000,
        });
      } catch (error) { failure = error; }
      const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
      expect(receipt.source).toBe(source);
      expect(receipt.packSource).toBe(pack);
      expect(receipt.cleanupComplete).toBe(true);
      expect(receipt.passed).toBe(scenario === 'complete');
      if (scenario !== 'complete') {
        expect(failure).toBeDefined();
        if (scenario === 'missing compiled import') expect(receipt.diagnostic).toContain('missing-packaged-module.js');
        if (scenario === 'public profile') expect(receipt.failure).toMatch(/not private|privacy verification failed/i);
        expect(receipt.profileProof).toBeUndefined();
      } else {
        expect(failure).toBeUndefined();
        expect(receipt.checks).toHaveLength(4);
        expect(receipt.profileProof).toMatchObject({ freshHome: true, installed: true, approvalsManual: true, workroomReady: true, modelAttached: false, workerReady: false, files: 6, directories: 5 });
        expect(receipt.timings.startupMs).toBeGreaterThanOrEqual(0);
        expect(receipt.timings.profileCheckMs).toBeGreaterThanOrEqual(0);
      }
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }, 35000);
});
