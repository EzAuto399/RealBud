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
const windows = process.platform === 'win32';
// The fake server shells out to PowerShell to build its ACL fixture, and the
// first PowerShell of a CI job is cold. A tight bound killed the child before
// readiness, which the smoke could only report as "exited before readiness".
// These widen the wait; no assertion depends on any of them.
const FIXTURE_ACL_MS = windows ? 60_000 : 15_000;
const READY_MS = windows ? 120_000 : 25_000;
const SMOKE_TIMEOUT_MS = windows ? READY_MS + 20_000 : 30_000;
const CASE_TIMEOUT_MS = windows ? SMOKE_TIMEOUT_MS + 20_000 : 35_000;
const PRIVATE_FIXTURE_SCRIPT = `$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
# One variable per field per object, read by name and never interpolated - a
# single JSON array piped through @() does not survive Windows PowerShell 5.1
# (see ACL_WITNESS in scripts/smoke-company-bundle.mjs for the same hazard).
$count = [System.Environment]::GetEnvironmentVariable('REALBUD_FIXTURE_COUNT')
if ($count -notmatch '^([1-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-6])$') { throw 'invalid fixture count' }
for ($index = 0; $index -lt [int]$count; $index++) {
  $path = [System.Environment]::GetEnvironmentVariable('REALBUD_FIXTURE_PATH_' + $index)
  $kind = [System.Environment]::GetEnvironmentVariable('REALBUD_FIXTURE_KIND_' + $index)
  if ([string]::IsNullOrEmpty($path)) { throw 'missing fixture path' }
  if ($kind -ne 'directory' -and $kind -ne 'file') { throw 'invalid fixture kind' }
  if ($kind -eq 'directory') { $acl = [System.Security.AccessControl.DirectorySecurity]::new() }
  else { $acl = [System.Security.AccessControl.FileSecurity]::new() }
  $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false)
  foreach ($principal in @($sid, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
    if ($kind -eq 'directory') { $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow') }
    else { $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', 'Allow') }
    $acl.AddAccessRule($rule)
  }
  if ($kind -eq 'directory') { ([System.IO.DirectoryInfo]::new($path)).SetAccessControl($acl) }
  else { ([System.IO.FileInfo]::new($path)).SetAccessControl($acl) }
}`;
const BROAD_FIXTURE_SCRIPT = `$ErrorActionPreference = 'Stop'
$broad = [System.IO.FileInfo]::new($env:REALBUD_FIXTURE_BROAD_FILE)
$acl = $broad.GetAccessControl()
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'), 'Read', 'Allow'))
$broad.SetAccessControl($acl)`;

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
    expect(env.PSModulePath).toBe(join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'));
    for (const key of ['OPENAI_API_KEY', 'COMPOSIO_API_KEY', 'NODE_OPTIONS', 'NODE_PATH']) expect(env[key]).toBeUndefined();
    expect(serviceSmokeEnv({ executable: '/fixture/RealBud', home: '/isolated/home', data: '/isolated/data', scratch: '/isolated', port: 1 }, { PSModulePath: '/customer/modules' }).PSModulePath).toBeUndefined();
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
        // Windows startup cost is PowerShell. Report it on stderr after every
        // launch, failed ones included, so the receipt can price the wait.
        let psLaunches = 0, psMs = 0;
        function powershell(script, extra) {
          const started = Date.now(); psLaunches++;
          try {
            execFileSync(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
              env: { ...process.env, ...extra }, shell: false, windowsHide: true, timeout: ${FIXTURE_ACL_MS}, stdio: ['ignore', 'pipe', 'pipe'],
            });
          } finally {
            psMs += Date.now() - started;
            process.stderr.write('[smoke-powershell] launches=' + psLaunches + ' ms=' + psMs + '\\n');
          }
        }
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
            const fixtureObjects = [...directories.map(path => ({ path, directory: true })), ...files.map(path => ({ path, directory: false }))];
            const fixtureEnv = { REALBUD_FIXTURE_COUNT: String(fixtureObjects.length) };
            fixtureObjects.forEach((item, index) => {
              fixtureEnv['REALBUD_FIXTURE_PATH_' + index] = item.path;
              fixtureEnv['REALBUD_FIXTURE_KIND_' + index] = item.directory ? 'directory' : 'file';
            });
            powershell(${JSON.stringify(PRIVATE_FIXTURE_SCRIPT)}, fixtureEnv);
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
            else powershell(${JSON.stringify(BROAD_FIXTURE_SCRIPT)}, { REALBUD_FIXTURE_BROAD_FILE: path });
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
          cwd: scratch, timeout: SMOKE_TIMEOUT_MS,
          env: { ...process.env, OPENAI_API_KEY: 'fictional-must-not-inherit', REALBUD_SMOKE_READY_MS: String(READY_MS) },
        });
      } catch (error) { failure = error; }
      const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
      // Nobody can attach a debugger to the Windows runner, so every assertion
      // about this receipt carries what the receipt knows about the child.
      const why = JSON.stringify({
        failure: receipt.failure, child: receipt.child, timings: receipt.timings,
        powershell: receipt.powershell, witness: receipt.witness, diagnostic: receipt.diagnostic,
        stdoutTail: receipt.stdoutTail, bootLog: receipt.bootLog, healthTimeline: receipt.healthTimeline,
        objects: receipt.objects, layout: receipt.layout,
      }, null, 1);
      expect(receipt.source, why).toBe(source);
      expect(receipt.packSource, why).toBe(pack);
      expect(receipt.cleanupComplete, why).toBe(true);
      expect(receipt.passed, why).toBe(scenario === 'complete');
      expect(receipt.timings.watchdogMs, why).toBe(READY_MS);
      // 'missing packaged safeguards' is refused while copying the inputs, so
      // it is the one case with no child and no readiness wait to report.
      const spawned = scenario !== 'missing packaged safeguards';
      expect(receipt.timings.readinessMs === undefined, why).toBe(!spawned);
      if (spawned) expect(receipt.timings.readinessMs, why).toBeGreaterThanOrEqual(0);
      expect(receipt.child, why).toMatchObject({ killedByWatchdog: false });
      expect(receipt.child, why).toHaveProperty('exitCode');
      expect(receipt.child, why).toHaveProperty('signal');
      // Reported, not policed: a truncated stderr must not invent a new Windows
      // failure on top of the one being diagnosed.
      expect(typeof receipt.powershell.service.launches, why).toBe('number');
      expect(typeof receipt.powershell.service.refusals, why).toBe('number');
      // The count is the probe's own instrumentation, not something the product
      // reports about itself, and the receipt has to say which it is.
      expect(receipt.powershell.service.counter, why).toBe('probe entry child_process wrapper');
      expect(typeof receipt.powershell.witnessLaunches, why).toBe('number');
      // What each health attempt answered, per elapsed second. A wait that
      // never ends has to distinguish a refused port from an unanswered one.
      expect(Array.isArray(receipt.healthTimeline), why).toBe(true);
      expect(receipt.healthTimeline.length, why).toBeLessThanOrEqual(200);
      for (const bucket of receipt.healthTimeline) {
        expect(Number.isInteger(bucket.second) && bucket.second >= 0, why).toBe(true);
        for (const [outcome, count] of Object.entries(bucket.outcomes)) {
          expect(outcome, why).toMatch(/^(ready|refused|timeout|reset|other-responder|unreachable|http-\d{3}|[A-Z][A-Z0-9_]{1,20})$/);
          expect(count, why).toBeGreaterThan(0);
        }
      }
      if (spawned) {
        expect(receipt.healthTimeline.length, why).toBeGreaterThan(0);
        const outcomes = receipt.healthTimeline.flatMap(bucket => Object.keys(bucket.outcomes));
        expect(outcomes.includes('ready'), why).toBe(scenario !== 'missing compiled import');
      } else expect(receipt.healthTimeline, why).toEqual([]);
      // The witness is win32-only, so elsewhere the receipt must say plainly
      // that none ran rather than leave the field out.
      expect(receipt, why).toHaveProperty('witness');
      if (!windows) expect(receipt.witness, why).toBeNull();
      // Every receipt says what this host saw of the profile before any witness
      // ran, so a Windows refusal cannot be read as an absent profile without
      // the layout that would prove it. Relative names only.
      expect(receipt, why).toHaveProperty('objects');
      expect(receipt, why).toHaveProperty('layout');
      const inspected = ['complete', 'health without profile', 'public profile', 'unsafe written policy', 'wrong skill bytes'].includes(scenario);
      expect(Array.isArray(receipt.objects), why).toBe(inspected);
      if (inspected) {
        expect(receipt.objects.map(object => object.name), why).toEqual([
          '.', 'profiles', 'profiles/property', 'profiles/property/skills', 'profiles/property/skills/fictional-skill',
          'auth.json', 'profiles/property/SOUL.md', 'profiles/property/config.yaml', 'profiles/property/distribution.yaml',
          'profiles/property/profile.yaml', 'profiles/property/skills/fictional-skill/SKILL.md',
        ]);
        for (const object of receipt.objects) expect(object.chars, why).toBeGreaterThan(0);
        expect(receipt.objects.slice(0, 5).map(object => object.kind), why).toEqual(Array(5).fill('directory'));
        expect(receipt.objects.slice(5).map(object => object.kind), why).toEqual(Array(6).fill('file'));
      }
      // The one scenario where the profile genuinely is not there: the receipt
      // must name the absent object relatively and carry the layout it found.
      if (scenario === 'health without profile') {
        expect(receipt.objects.every(object => object.exists === false), why).toBe(true);
        expect(receipt.failure, why).toMatch(/Fresh profile is missing directory "\." \(11 of 11 objects absent\)/);
        expect(receipt.layout, why).toMatchObject({ home: ['«unreadable: ENOENT»'], profile: ['«unreadable: ENOENT»'] });
      } else if (inspected) {
        expect(receipt.objects.every(object => object.exists === true), why).toBe(true);
      }
      if (scenario !== 'complete') {
        expect(failure, why).toBeDefined();
        expect(typeof receipt.diagnostic, why).toBe('string');
        // A failure carries everything the child itself said, so a run that
        // wrote nothing to stderr is not the end of the diagnosis. Each is
        // present and either a string or an explicit null.
        for (const field of ['stdoutTail', 'bootLog']) {
          expect(receipt, why).toHaveProperty(field);
          expect(receipt[field] === null || typeof receipt[field] === 'string', why).toBe(true);
        }
        if (scenario === 'missing compiled import') {
          expect(receipt.diagnostic, why).toContain('missing-packaged-module.js');
          expect(receipt.child.exitCode, why).toBe(1);
        }
        if (scenario === 'public profile') {
          expect(receipt.failure, why).toMatch(/not private|privacy verification failed/i);
          // A users-readable ACE is rule 3, never the runner's own layout.
          if (windows) expect(receipt.witness, why).toMatchObject({ exitCode: 3, code: 3, rule: 'grant-not-allowed', depth: 0 });
        }
        expect(receipt.profileProof, why).toBeUndefined();
      } else {
        expect(failure, why).toBeUndefined();
        if (windows) expect(receipt.witness, why).toMatchObject({ exitCode: 0, code: null, rule: null });
        expect(receipt.checks, why).toHaveLength(4);
        expect(receipt.profileProof, why).toMatchObject({ freshHome: true, installed: true, approvalsManual: true, workroomReady: true, modelAttached: false, workerReady: false, files: 6, directories: 5 });
        expect(receipt.timings.startupMs, why).toBeGreaterThanOrEqual(0);
        expect(receipt.timings.profileCheckMs, why).toBeGreaterThanOrEqual(0);
      }
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }, CASE_TIMEOUT_MS);
});
