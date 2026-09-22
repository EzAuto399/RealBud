// Run the compiled server outside the checkout so development node_modules
// cannot hide a missing packaged dependency. No native driver or model runs.
import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { serviceSmokeEnv } from './service-smoke-env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// /var is a macOS alias. A fresh fixture must use real ancestry, like the app.
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'RealBud package proof ')));
const out = resolve(process.argv[2] || join(root, 'outputs/company-bundle-proof.json'));
// An explicit source checks the installed artifact, not the checkout's build.
const source = resolve(process.argv[3] || join(root, 'dist-server'));
// electron-builder combines these inputs; an explicit artifact has no fallback.
const packSource = process.argv[3] ? join(source, 'pack', 'property') : join(root, 'pack', 'property');
let child, exited, timer, failure, stderr = '', stdout = '', cleanupComplete = false, timedOut = false;
let profileProof, startupMs, profileCheckMs, stderrDrained, stdoutDrained, readinessMs;
// What each `/api/health` attempt actually answered, bucketed per elapsed
// second. A run that never reaches readiness has to say whether the port was
// refused all the way (the service never listened), timing out (it listened
// but never answered), or answering something else (a foreign responder).
const healthTimeline = [];
let exitCode = null, exitSignal = null, witnessLaunches = 0, witnessMs = 0, witnessReport = null;
// What this host saw of the fresh profile before any witness ran, and the
// layout it actually found. Relative names only: an absolute path carries the
// runner's account and workspace. `null` means inspection never got that far.
let profileObjects = null, profileLayout = null;
const checks = [];
const execute = promisify(execFile);
const requiredProfileFiles = ['SOUL.md', 'config.yaml', 'distribution.yaml', 'profile.yaml'];
// A developer machine starts the compiled service in seconds, so the default
// readiness window stays 25s. A harness that knows it is paying for cold
// PowerShell may widen it; the receipt records the window actually used.
//
// A traced Windows boot pays eleven sequential `powershell.exe` admissions
// before `listen` (five for the private profile, three for the workspace
// identity, three for the backup operation store). That is a few seconds once
// each launch succeeds; it was the whole window while each one failed after
// ~35s on `Set-Acl`/`Get-Acl` module auto-load. The receipt now carries the
// launches actually made, so a future overrun says which of the two it is.
const readyMs = Math.min(Math.max(Number(process.env.REALBUD_SMOKE_READY_MS) || 25_000, 5_000), 180_000);
const readinessAttempts = Math.ceil(readyMs / 166);

// This script must also run from an installed package, where the compiled
// server's redactor is not importable. Conservative shapes only: no generic
// hex or base64 heuristics, so a diagnostic stays readable.
const SECRET_SHAPES = [
  /\b(?:rbk|rbc|mgt|ak|ck|ntn|npm|ghp|gho|ghu|ghs|ghr|secret)_[A-Za-z0-9_-]{12,}/g,
  /\b(?:sk|xai|xox[abposr])-[A-Za-z0-9_-]{12,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];
const SECRET_VALUES = [
  /(\bBearer\s+)([A-Za-z0-9._~+/=-]{12,})/g,
  /\b((?:api[_-]?key|apikey|secret|token|password|authorization)s?["']?\s*[=:]\s*["']?)([A-Za-z0-9._~+/=-]{8,})/gi,
];
// Windows startup cost is dominated by PowerShell launches, so the compiled
// service reports its own count and elapsed time on stderr and the receipt
// carries them next to this script's own ACL witness. No path, SID or
// descriptor is in the marker.
const POWERSHELL_MARKER = /\[smoke-powershell\] launches=(\d+) ms=(\d+)/g;
// The product's own refusal line, written once per failed ACL operation. Only
// its count is kept here; `diagnostic` already carries the lines themselves.
const WINDOWS_ACL_MARKER = /\[windows-acl\] /g;
function servicePowershellFrom(text) {
  let last = null;
  for (const match of text.matchAll(POWERSHELL_MARKER)) last = match;
  return {
    launches: last ? Number(last[1]) : 0, ms: last ? Number(last[2]) : 0,
    refusals: (text.match(WINDOWS_ACL_MARKER) ?? []).length,
    // The compiled service does not count its own launches; the probe's entry
    // module wraps `child_process` for this run only, passing every call
    // through untouched. Say so, so nobody reads this as a product metric.
    counter: 'probe entry child_process wrapper',
  };
}

// The probe's entry module. It counts the child's own `powershell.exe`
// launches — the dominant Windows startup cost — and otherwise does exactly
// what it did before: generate a certificate (importing `selfsigned` alone
// misses its ASN.1 initialization and crypto path), then start the service.
// The wrapper forwards the executable, arguments, environment and result
// unchanged and writes one stderr line of two integers per launch; a failure
// to install it is swallowed, because a missing count must never be the reason
// a service does not start. Both imports are dynamic so the wrapper is in
// place before any module that captures `execFile` is linked.
const PROBE_ENTRY = `import { createRequire, syncBuiltinESMExports } from 'node:module';
const childProcess = createRequire(import.meta.url)('node:child_process');
const PROMISIFY = Symbol.for('nodejs.util.promisify.custom');
let launches = 0, elapsed = 0;
const powershell = file => typeof file === 'string' && /powershell\\.exe$/i.test(file);
const mark = started => {
  elapsed += Math.round(performance.now() - started);
  process.stderr.write('[smoke-powershell] launches=' + launches + ' ms=' + elapsed + '\\n');
};
try {
  const realSync = childProcess.execFileSync;
  childProcess.execFileSync = function (file, ...rest) {
    if (!powershell(file)) return realSync.call(this, file, ...rest);
    const started = performance.now(); launches++;
    try { return realSync.call(this, file, ...rest); } finally { mark(started); }
  };
  const realFile = childProcess.execFile, realPromise = realFile[PROMISIFY];
  const wrapped = function (file, ...rest) {
    const done = rest.at(-1);
    if (!powershell(file) || typeof done !== 'function') return realFile.call(this, file, ...rest);
    const started = performance.now(); launches++;
    return realFile.call(this, file, ...rest.slice(0, -1), (...answer) => { mark(started); done(...answer); });
  };
  if (typeof realPromise === 'function') {
    wrapped[PROMISIFY] = function (file, ...rest) {
      if (!powershell(file)) return realPromise.call(this, file, ...rest);
      const started = performance.now(); launches++;
      return realPromise.call(this, file, ...rest).then(
        answer => { mark(started); return answer; },
        error => { mark(started); throw error; },
      );
    };
  }
  childProcess.execFile = wrapped;
  syncBuiltinESMExports();
} catch { /* the count is diagnostic only; never let it hold up the service */ }
const { createHostCertificate } = await import('./server/company/host-certificate.js');
await createHostCertificate('127.0.0.1');
await import('./server/bootstrap.js');
`;

/** One `/api/health` attempt, bucketed into the elapsed second it ran in. */
function noteHealth(elapsedMs, outcome) {
  const second = Math.floor(elapsedMs / 1000);
  let bucket = healthTimeline.at(-1);
  if (!bucket || bucket.second !== second) {
    // 180 s is the widest watchdog this script accepts, so the list is bounded.
    if (healthTimeline.length >= 200) return;
    bucket = { second, outcomes: {} };
    healthTimeline.push(bucket);
  }
  bucket.outcomes[outcome] = (bucket.outcomes[outcome] ?? 0) + 1;
}
/**
 * The service's own boot trail (`server/oplog.ts`), bounded and masked like
 * any other diagnostic. The log is already written through the compiled
 * redactor; this adds the probe's own conservative matcher on top, because an
 * installed package does not let this script import that redactor. `null`
 * means there is no usable log, which is itself an answer: a service that
 * never reached `oplog` never got past its startup admissions.
 */
async function bootLogFrom(path, limit = 40) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_000_000) return null;
    return diagnosticFrom((await readFile(path, 'utf8')).slice(-64_000), limit) || null;
  } catch { return null; }
}
/** Fixed tokens only: a native error message can name a path or an account. */
function healthFailure(error) {
  const name = error?.name, code = error?.cause?.code ?? error?.code;
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ECONNRESET') return 'reset';
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,20}$/.test(code)) return code;
  return 'unreachable';
}
/** Last `limit` non-empty stderr lines, with credential-shaped values masked. */
function diagnosticFrom(text, limit = 20) {
  let out = text;
  for (const shape of SECRET_SHAPES) out = out.replace(shape, match => `«redacted ${match.length} chars»`);
  for (const shape of SECRET_VALUES) out = out.replace(shape, (_m, lead, value) => `${lead}«redacted ${value.length} chars»`);
  return out.split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean).slice(-limit).join('\n');
}

// Independent read-only ACL witness, not the production verifier or a repair.
// No descriptor, SID, or path is returned by PowerShell: a refusal writes one
// compact JSON line of integers and a fixed rule name, and exits with a code
// per rule so a real privacy defect is never confused with a runner layout.
// Codes follow server/windows-file-privacy.ts where the rule is the same
// (2 owner, 3 ACE principal, 4 no usable grant, 5 not protected, 6 reparse
// point, 7 kind mismatch, 9 bad input, 10 deny) and add 8 missing, 11 reparse
// point above the disposable root, 12 unprotected ancestor above it, and
// 13 too long / 14 attributes denied / 15 otherwise unreadable for a target
// this host could stat but PowerShell could not. 20-26 are the verifier's
// inspection stages.
//
// `exit` inside a `try` is not caught by PowerShell's `catch`, but this script
// must not depend on that: a rule refusal records its code and throws, and the
// one `catch` decides what to emit.
const ACL_WITNESS = Buffer.from(`
$ErrorActionPreference = 'Stop'
$stageRules = @{ 9 = 'invalid-invocation'; 20 = 'identity-unavailable'; 21 = 'target-inspection-failed'; 22 = 'ancestor-inspection-failed'; 25 = 'acl-read-failed'; 26 = 'acl-inspection-failed' }
$failCode = 0
$failRule = ''
$stage = 20
$index = -1
$depth = 0
$size = 0
function Refuse($code, $name) { $script:failCode = $code; $script:failRule = $name; throw 'witness refused' }
function Note($code, $name, $at, $level, $chars) { [Console]::Out.Write('{"code":' + $code + ',"rule":"' + $name + '","index":' + $at + ',"depth":' + $level + ',"chars":' + $chars + '}') }
try {
  $current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $allowed = @($current, 'S-1-5-18', 'S-1-5-32-544')
  $stage = 9
  $full = $env:REALBUD_SMOKE_WITNESS_FULL_ANCESTRY -eq '1'
  $root = $env:REALBUD_SMOKE_PRIVATE_ROOT
  if ([string]::IsNullOrEmpty($root)) { Refuse 9 'invalid-invocation' }
  $root = $root.TrimEnd('\\')
  $count = [System.Environment]::GetEnvironmentVariable('REALBUD_SMOKE_PRIVATE_COUNT')
  if ($count -notmatch '^([1-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-6])$') { Refuse 9 'invalid-invocation' }
  $total = [int]$count
  for ($index = 0; $index -lt $total; $index++) {
    $depth = 0
    $size = 0
    $stage = 21
    # One variable per field per object, read by name and never interpolated -
    # the delivery server/windows-file-privacy.ts already proves on this host.
    # A single JSON array did not survive Windows PowerShell 5.1: a Package
    # Windows run received 11 characters where this host sent an 89-character
    # path, because ConvertFrom-Json piped through @() unwraps and reshapes.
    $path = [System.Environment]::GetEnvironmentVariable('REALBUD_SMOKE_PRIVATE_PATH_' + $index)
    $kind = [System.Environment]::GetEnvironmentVariable('REALBUD_SMOKE_PRIVATE_KIND_' + $index)
    if ([string]::IsNullOrEmpty($path)) { Refuse 9 'invalid-invocation' }
    $size = $path.Length
    if ($kind -ne 'directory' -and $kind -ne 'file') { Refuse 9 'invalid-invocation' }
    $wantDirectory = $kind -eq 'directory'
    # Directory.Exists/File.Exists answer false for every failure alike - a real
    # absence, a path past MAX_PATH, a denied query - so a refusal could not say
    # which. GetAttributes throws the reason, and the reason gets its own code.
    try { $attributes = [IO.File]::GetAttributes($path) }
    catch {
      $reason = $_.Exception
      while ($reason.InnerException) { $reason = $reason.InnerException }
      switch ($reason.GetType().Name) {
        'DirectoryNotFoundException' { Refuse 8 'missing' }
        'FileNotFoundException' { Refuse 8 'missing' }
        'PathTooLongException' { Refuse 13 'path-too-long' }
        'UnauthorizedAccessException' { Refuse 14 'attributes-access-denied' }
        default { Refuse 15 'target-attributes-unreadable' }
      }
    }
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Refuse 6 'reparse-point' }
    if ($wantDirectory -ne ((($attributes -band [IO.FileAttributes]::Directory) -ne 0))) { Refuse 7 'kind-mismatch' }
    # Bounded ancestry: the profile tree and the disposable root containing it.
    # The runner's own layout above that root is not this proof's business, and
    # the product verifier refuses a junction on its own paths independently.
    $cursor = [IO.Path]::GetDirectoryName($path)
    $above = $false
    $depth = 1
    while (-not [string]::IsNullOrEmpty($cursor) -and $depth -le 64) {
      $stage = 22
      $ancestor = [IO.File]::GetAttributes($cursor)
      if (($ancestor -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        if ($above) { Refuse 11 'ancestor-reparse-point-above-root' } else { Refuse 6 'reparse-point' }
      }
      if ($above) {
        $stage = 25
        if (-not (New-Object System.IO.DirectoryInfo($cursor)).GetAccessControl().AreAccessRulesProtected) { Refuse 12 'ancestor-not-protected' }
      }
      if ($cursor.TrimEnd('\\') -eq $root) {
        if (-not $full) { break }
        $above = $true
      }
      $next = [IO.Path]::GetDirectoryName($cursor)
      if ([string]::IsNullOrEmpty($next) -or $next -eq $cursor) { break }
      $cursor = $next
      $depth++
    }
    $depth = 0
    $stage = 25
    if ($wantDirectory) { $acl = (New-Object System.IO.DirectoryInfo($path)).GetAccessControl() }
    else { $acl = (New-Object System.IO.FileInfo($path)).GetAccessControl() }
    $stage = 26
    if (-not $acl.AreAccessRulesProtected) { Refuse 5 'not-protected' }
    if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $current) { Refuse 2 'owner-not-allowed' }
    $usable = $false
    foreach ($ace in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
      if ($ace.AccessControlType -eq 'Deny') { Refuse 10 'deny-rule-present' }
      if ($allowed -notcontains $ace.IdentityReference.Value) { Refuse 3 'grant-not-allowed' }
      if ($ace.IdentityReference.Value -eq $current -and
          ($ace.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and
          ($ace.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl) { $usable = $true }
    }
    if (-not $usable) { Refuse 4 'target-full-control-missing' }
  }
  [Console]::Out.Write('private')
} catch {
  # Never emit the exception: a native message can carry a path or an identity.
  if ($failCode -ne 0) { Note $failCode $failRule $index $depth $size; exit $failCode }
  $name = $stageRules[$stage]
  if (-not $name) { $name = 'witness-failed' }
  Note $stage $name $index $depth $size
  exit $stage
}
`, 'utf16le').toString('base64');

/**
 * The witness's own account of a run: process outcome plus the parsed refusal
 * line. Only integers and a known-shaped rule name are kept, so no native text
 * reaches the receipt.
 */
function witnessReportFrom({ exitCode, signal, stdout, stderr }) {
  let code = null, rule = null, index = null, depth = null, chars = null;
  const line = String(stdout ?? '').trim();
  if (line.startsWith('{') && line.length <= 512) {
    try {
      const parsed = JSON.parse(line);
      if (Number.isInteger(parsed.code)) code = parsed.code;
      if (typeof parsed.rule === 'string' && /^[a-z][a-z-]{0,48}$/.test(parsed.rule)) rule = parsed.rule;
      if (Number.isInteger(parsed.index)) index = parsed.index;
      if (Number.isInteger(parsed.depth)) depth = parsed.depth;
      // Character count only, never the path: it settles whether PowerShell
      // received the same string this host stat'd, or a truncated one.
      if (Number.isInteger(parsed.chars)) chars = parsed.chars;
    } catch { /* an unparsable line is reported as no rule, never echoed */ }
  }
  return { exitCode, signal, code, rule, index, depth, chars, stderrTail: diagnosticFrom(String(stderr ?? ''), 10) };
}

async function assertMissing(path) {
  await assert.rejects(lstat(path), error => error?.code === 'ENOENT', 'Fresh fixture contains unexpected profile state');
}
/** Name inside the private home; an absolute path names the runner's account. */
function relativeTo(root, path) {
  if (path === root) return '.';
  return path.startsWith(root + sep) ? path.slice(root.length + 1).split(sep).join('/') : '«outside the private home»';
}
/** The layout actually on disk: relative names of `root` and its children. */
async function layoutOf(root, home) {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { return [`«unreadable: ${error?.code ?? 'error'}»`]; }
  const names = [];
  for (const entry of entries.slice(0, 64)) {
    const name = relativeTo(home, join(root, entry.name));
    names.push(entry.isDirectory() ? `${name}/` : name);
    if (!entry.isDirectory()) continue;
    try {
      for (const child of (await readdir(join(root, entry.name), { withFileTypes: true })).slice(0, 64)) {
        const path = relativeTo(home, join(root, entry.name, child.name));
        names.push(child.isDirectory() ? `${path}/` : path);
      }
    } catch (error) { names.push(`${name}/«unreadable: ${error?.code ?? 'error'}»`); }
  }
  return names;
}
async function inspectProfile(home, pack, status, env) {
  const profile = join(home, 'profiles', 'property');
  assert.deepEqual(status.pack, { installed: true, approvalsManual: true, workroomReady: true }, 'Fresh private profile is not usable');
  assert.equal(status.homeDir, home, 'Service used another Hermes home');
  assert.equal(status.profileDir, profile, 'Service used another profile');
  assert.equal(status.model?.attached, false, 'Fresh fixture unexpectedly has a model login');
  assert.equal(status.ready, false, 'An unconfigured worker must remain held');
  const objects = [home, join(home, 'profiles'), profile].map(path => ({ path, directory: true }));
  const files = [join(home, 'auth.json'), ...requiredProfileFiles.map(name => join(profile, name))];
  const copies = ['SOUL.md', 'distribution.yaml', 'profile.yaml'].map(name => ({ from: join(pack, name), to: join(profile, name) }));
  await assertMissing(join(profile, '.env'));
  async function skills(from, to, depth = 0) {
    assert.ok(depth <= 12 && objects.length + files.length <= 256, 'Shipped skill inventory exceeds smoke bound');
    objects.push({ path: to, directory: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink(), 'Shipped skill contains an alias');
      if (entry.isDirectory()) await skills(join(from, entry.name), join(to, entry.name), depth + 1);
      else {
        assert.ok(entry.isFile(), 'Shipped skill is not a regular file');
        const path = join(to, entry.name); files.push(path);
        copies.push({ from: join(from, entry.name), to: path });
      }
    }
  }
  await skills(join(pack, 'skills'), join(profile, 'skills'));
  assert.ok(objects.length + files.length <= 256, 'Shipped skill inventory exceeds smoke bound');
  objects.push(...files.map(path => ({ path, directory: false })));
  // What this host sees, recorded before any witness runs. A Windows refusal
  // that names an object this host did stat is a witness or path-delivery
  // fault, not an absent profile, and the two can no longer be confused.
  profileObjects = [];
  for (const item of objects) {
    const kind = item.directory ? 'directory' : 'file';
    let exists = false;
    try {
      const stat = await lstat(item.path);
      exists = item.directory ? stat.isDirectory() : stat.isFile();
    } catch { exists = false; }
    profileObjects.push({ name: relativeTo(home, item.path), kind, exists, chars: item.path.length });
  }
  const absent = profileObjects.filter(item => !item.exists);
  if (absent.length) {
    profileLayout = { home: await layoutOf(home, home), profile: await layoutOf(profile, home) };
    throw new Error(`Fresh profile is missing ${absent[0].kind} "${absent[0].name}" (${absent.length} of ${profileObjects.length} objects absent); private home layout ${JSON.stringify(profileLayout.home)}`);
  }
  const before = [];
  for (const item of objects) {
    const stat = await lstat(item.path, { bigint: true });
    assert.ok(!stat.isSymbolicLink() && (item.directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n), 'Profile contains an alias or unexpected object');
    if (process.platform !== 'win32') {
      assert.equal(stat.mode & 0o077n, 0n, 'Profile is not private');
      assert.equal(stat.uid, BigInt(process.getuid()), 'Profile has an unexpected owner');
    }
    before.push(stat);
  }
  if (process.platform === 'win32') {
    assert.ok(env.SystemRoot && isAbsolute(env.SystemRoot) && !env.SystemRoot.includes('\0'), 'Windows ACL witness unavailable');
    assert.ok(objects.length >= 1 && objects.length <= 256, 'Windows ACL witness object count out of bounds');
    // One variable per field per object, matching server/windows-file-privacy.ts.
    // `profileObjects[i].chars` above records what this host sent for object i,
    // so the receipt compares the length sent with the length PowerShell read.
    const witnessEnv = {
      ...env, REALBUD_SMOKE_PRIVATE_COUNT: String(objects.length), REALBUD_SMOKE_PRIVATE_ROOT: scratch,
      // Off by default: above the disposable root the layout belongs to the
      // host, so a hosted runner is expected to report 11 or 12 here.
      REALBUD_SMOKE_WITNESS_FULL_ANCESTRY: process.env.REALBUD_SMOKE_WITNESS_FULL_ANCESTRY === '1' ? '1' : '',
    };
    objects.forEach((item, index) => {
      assert.ok(typeof item.path === 'string' && item.path && !item.path.includes('\0'), 'Windows ACL witness path is unusable');
      witnessEnv[`REALBUD_SMOKE_PRIVATE_PATH_${index}`] = item.path;
      witnessEnv[`REALBUD_SMOKE_PRIVATE_KIND_${index}`] = item.directory ? 'directory' : 'file';
    });
    let witness;
    const witnessStarted = performance.now();
    witnessLaunches++;
    try {
      witness = await execute(join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', ACL_WITNESS], {
        env: witnessEnv, shell: false, windowsHide: true,
        // A cold Windows PowerShell 5.1 on a hosted runner took 34 s to start in run 35715811161; 15 s made the witness fail before it ran.
        timeout: 120_000, maxBuffer: 4096,
      });
    } catch (error) {
      witnessReport = witnessReportFrom({
        exitCode: Number.isInteger(error?.code) ? error.code : null,
        signal: error?.signal ?? null, stdout: error?.stdout, stderr: error?.stderr,
      });
      const reported = witnessReport.exitCode ?? (typeof error?.code === 'string' ? error.code : 'unavailable');
      // The witness may not say which object it refused on, so the receipt
      // carries the layout this host found and the refused object's own name.
      profileLayout = { home: await layoutOf(home, home), profile: await layoutOf(profile, home) };
      const refused = profileObjects[witnessReport.index] ?? null;
      throw new Error(`Fresh profile Windows privacy verification failed (exit ${reported}, rule ${witnessReport.rule ?? 'unreported'}`
        + `${refused ? `, object "${refused.name}" ${refused.kind}, ${refused.chars} chars here and ${witnessReport.chars ?? 'unreported'} there` : ''})`);
    } finally { witnessMs += Math.round(performance.now() - witnessStarted); }
    witnessReport = witnessReportFrom({ exitCode: 0, signal: null, stdout: witness.stdout, stderr: witness.stderr });
    assert.equal(witness.stdout, 'private', 'Windows ACL witness did not confirm privacy');
  }
  for (const { from, to } of copies) assert.deepEqual(await readFile(to), await readFile(from), 'Shipped safeguard or skill bytes were not provisioned');
  const config = await readFile(join(profile, 'config.yaml'), 'utf8');
  assert.match(config, /^approvals:\s*\n\s+mode:\s*manual\s*$/m);
  assert.match(config, /^\s+home_mode:\s*profile\s*$/m);
  assert.match(config, /^\s+write_approval:\s*true\s*$/m);
  assert.deepEqual(JSON.parse(await readFile(join(home, 'auth.json'), 'utf8')), { version: 1, providers: {}, credential_pool: {} });
  for (let index = 0; index < objects.length; index++) {
    const after = await lstat(objects[index].path, { bigint: true }), prior = before[index];
    assert.deepEqual([after.dev, after.ino, after.mode, after.size, after.mtimeNs, after.ctimeNs, after.nlink], [prior.dev, prior.ino, prior.mode, prior.size, prior.mtimeNs, prior.ctimeNs, prior.nlink], 'Profile changed during read-only privacy inspection');
  }
  return { freshHome: true, installed: true, approvalsManual: true, workroomReady: true, modelAttached: false, workerReady: false,
    privacy: process.platform === 'win32' ? 'independent protected Windows DACL witness' : 'POSIX owner and private mode', files: files.length, directories: objects.length - files.length };
}
try {
  const resources = join(scratch, 'resources');
  for (const directory of ['server', 'shared', 'src']) {
    await cp(join(source, directory), join(resources, directory), { recursive: true });
  }
  await cp(packSource, join(resources, 'pack', 'property'), { recursive: true });
  for (const name of requiredProfileFiles) assert.ok((await lstat(join(resources, 'pack', 'property', name))).isFile(), `Missing shipped ${name}`);
  await writeFile(join(resources, 'package.json'), '{"type":"module"}\n');
  const home = join(scratch, 'home'); const data = join(home, '.realbud');
  await mkdir(data, { recursive: true, mode: 0o700 });
  await writeFile(join(data, 'config.json'), JSON.stringify({ instances: { fixture: { driver: 'not-a-real-driver' } } }));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  // Check certificate generation too: importing selfsigned alone misses its
  // ASN.1 initialization and crypto path.
  const entry = join(resources, 'proof.mjs');
  await writeFile(entry, PROBE_ENTRY);
  const env = serviceSmokeEnv({ executable: process.execPath, home, data, scratch, port });
  await assertMissing(env.REALBUD_HERMES_HOME);
  const started = performance.now();
  // stdout is captured too: a compiled service that fails before its first
  // stderr byte still prints `realbud server on …`, and a run that reported an
  // empty diagnostic could not say whether that line had been reached.
  child = spawn(process.execPath, [entry], { cwd: scratch, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => { exitCode = code; exitSignal = signal; resolve(code); });
  });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-16_000); });
  child.stdout.on('data', bytes => { stdout = (stdout + bytes).slice(-16_000); });
  // Windows can emit 'exit' before the stderr pipe has been read, which left a
  // crashed child with an empty diagnostic and a run that could not explain
  // itself. Wait for the pipe, not the process.
  stderrDrained = once(child.stderr, 'close').then(() => {}, () => {});
  stdoutDrained = once(child.stdout, 'close').then(() => {}, () => {});
  timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, readyMs);
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  // Recorded even when readiness never arrives: how long the child was given
  // is half of what a Windows failure has to explain.
  try {
    // Time-based, not attempt-based: a refused connection returns in a few
    // milliseconds, so a fixed attempt count exhausted itself in 16 s on a
    // Windows runner whose cold service needs 35-51 s.
    for (let attempt = 0; attempt < readinessAttempts || performance.now() - started < readyMs; attempt++) {
      if (performance.now() - started >= readyMs) break;
      if (child.exitCode !== null || child.signalCode) throw new Error('Compiled service exited before readiness');
      const attemptedAt = performance.now() - started;
      let outcome = 'unreachable';
      const health = await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) })
        .then(async r => {
          if (!r.ok) { outcome = `http-${r.status}`; return null; }
          const body = await r.json();
          outcome = body?.app === 'realbud' && body.pid === child.pid ? 'ready' : 'other-responder';
          return body;
        })
        .catch(error => { outcome = healthFailure(error); return null; });
      noteHealth(attemptedAt, outcome);
      if (health?.app === 'realbud' && health.pid === child.pid) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } finally { readinessMs = Math.round(performance.now() - started); }
  assert.ok(ready, 'Compiled service readiness'); checks.push('Compiled server starts outside checkout without node_modules');
  startupMs = Math.round(performance.now() - started);
  const session = await fetch(base + '/api/session').then(r => r.json());
  const response = await fetch(base + '/api/company/status', { headers: { 'x-realbud-session': session.token } });
  assert.equal(response.status, 200); assert.equal((await response.json()).storageAvailable, false);
  checks.push('Packaged PostgreSQL driver loads; unprovisioned company status is usable');
  checks.push('Packaged TLS certificate generator executes successfully');
  const checked = performance.now();
  const hermesResponse = await fetch(base + '/api/hermes', { headers: { 'x-realbud-session': session.token }, signal: AbortSignal.timeout(10_000) });
  assert.equal(hermesResponse.status, 200, 'Private profile status is unavailable');
  profileProof = await inspectProfile(env.REALBUD_HERMES_HOME, join(resources, 'pack', 'property'), await hermesResponse.json(), env);
  profileCheckMs = Math.round(performance.now() - checked);
  assert.equal(timedOut, false, `Compiled service probe exceeded its ${Math.round(readyMs / 1000)}-second watchdog`);
  assert.equal(child.exitCode, null, 'Compiled service stopped before profile proof completed');
  assert.equal(child.signalCode, null, 'Compiled service was terminated before profile proof completed');
  checks.push('Fresh private Hermes profile has shipped safeguards and skills, private storage, and no model credentials');
} catch (error) { failure = error instanceof Error ? error.message : 'Package probe failed'; }
finally {
  if (child && child.exitCode === null && !child.signalCode) {
    child.kill('SIGTERM'); const forced = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited.catch(() => {}); clearTimeout(forced);
  }
  clearTimeout(timer);
  const drained = [stderrDrained, stdoutDrained].filter(Boolean);
  if (drained.length) {
    await Promise.race([Promise.all(drained), new Promise(resolve => { setTimeout(resolve, 2_000).unref(); })]);
  }
  // Read before the disposable fixture is removed. When readiness never
  // arrives, the service's own boot trail under the data directory is the only
  // account of what it was doing while this probe waited.
  const bootLog = failure ? await bootLogFrom(join(scratch, 'home', '.realbud', 'realbud.log')) : null;
  await rm(scratch, { recursive: true, force: true }); cleanupComplete = true;
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify({ passed: !failure, platform: process.platform, arch: process.arch, node: process.version,
    source, packSource, runtime: process.versions.electron ? 'installed Electron/Node' : 'Node',
    proofLayer: 'Compiled service and fresh private profile from the selected inputs; not Hermes runtime installation, model access, GUI or two-device acceptance',
    timings: { startupMs, readinessMs, profileCheckMs, watchdogMs: readyMs, readinessAttempts, perHealthRequestMs: 500 }, profileProof,
    // Recorded whether or not the probe failed: a child that exited is the one
    // fact the earlier receipt could not report.
    child: { exitCode, signal: exitSignal, killedByWatchdog: timedOut },
    powershell: { service: servicePowershellFrom(stderr), witnessLaunches, witnessMs },
    // The witness's own outcome, recorded whether it confirmed privacy or
    // refused, so a Windows failure names its rule instead of one exit 1.
    // `null` means no witness ran: not a win32 host, or the probe failed first.
    witness: witnessReport,
    // Every object the witness was asked about, as this host saw it, and the
    // layout actually on disk when an object was absent or a witness refused.
    // Relative names only. `null` means inspection never reached them.
    objects: profileObjects, layout: profileLayout,
    // What each health attempt answered, per elapsed second. Recorded on a
    // pass too: the shape of a passing wait is the baseline a failing one is
    // read against.
    healthTimeline,
    checks, failure, cleanupComplete,
    // On a failure, everything the child itself said: its last stderr and
    // stdout lines and its own boot trail, each bounded and masked through the
    // same conservative matcher. `null` means the child wrote none.
    ...(failure ? { diagnostic: diagnosticFrom(stderr), stdoutTail: diagnosticFrom(stdout, 10) || null, bootLog } : {}) }, null, 2) + '\n');
  console.log(`${failure ? 'FAILED' : 'PASSED'} compiled company bundle: ${out}`);
  process.exitCode = failure ? 1 : 0;
}
