// Test-owned fixtures only. Do not repair an existing customer/profile ACL.
import { closeSync, constants, lstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { windowsFilePrivacySync } from '../windows-file-privacy.ts';

export const WINDOWS_PROFILE_TEST_OPTIONS = process.platform === 'win32' ? { timeout: 120_000 } : {};
const ownedRoots = new Set<string>();

function assertOwned(path: string): void {
  if (!isAbsolute(path) || path.includes('\0') || ![...ownedRoots].some(root => {
    const child = relative(root, path);
    return !isAbsolute(child) && child !== '..' && !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`);
  })) throw new Error('Private fixture path is not test-owned.');
}

/** Canonical ancestry matters on macOS; the newly owned Windows root is empty. */
export function privateFixtureRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(prefix));
  try { windowsFilePrivacySync(root, 'directory', true); ownedRoots.add(root); return root; }
  catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}

/** Protect each new empty directory before creating its descendants. */
export function privateFixtureDirectory(path: string): void {
  assertOwned(path);
  let existing;
  try { existing = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('Invalid private fixture directory.');
    windowsFilePrivacySync(path, 'directory');
    return;
  }
  privateFixtureDirectory(dirname(path));
  mkdirSync(path, { mode: 0o700 });
  windowsFilePrivacySync(path, 'directory', true);
}

/** New fixture content follows ACL setup; overwrites retain the existing ACL. */
export function writePrivateFixtureFile(path: string, content: string | Buffer): void {
  assertOwned(path);
  let existing;
  try { existing = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) throw new Error('Invalid private fixture file.');
    writeFileSync(path, content);
    return;
  }
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    windowsFilePrivacySync(path, 'file', true);
    writeFileSync(fd, content);
  } finally { closeSync(fd); }
}

export interface ProfileAclWitness {
  protected: boolean;
  currentOwner: boolean;
  /** Owner is the account, SYSTEM or Administrators (an elevated token's default owner). */
  ownerAllowed: boolean;
  onlyPrivateGrants: boolean;
  currentFullControl: boolean;
  hasDeny: boolean;
  sddlSha256: string;
}

// Independent observation code: no production verifier/script reuse. Return
// booleans and a descriptor digest only, never the native descriptor or SID.
// No cmdlets (ConvertFrom-Json, ConvertTo-Json, New-Object...): each one
// auto-loads its module, which fails or costs ~23 s under the test runner, as
// in server/windows-file-privacy.ts. Paths arrive one per indexed environment
// variable, read by name, and each result leaves as one plain line.
export const WITNESS = `
$ErrorActionPreference = 'Stop'
try {
  $current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $allowed = @($current, 'S-1-5-18', 'S-1-5-32-544')
  $count = $env:REALBUD_TEST_PROFILE_COUNT
  if ($count -notmatch '^([1-9]|1[0-6])$') { exit 9 }
  $total = [int]$count
  for ($index = 0; $index -lt $total; $index++) {
    $path = [System.Environment]::GetEnvironmentVariable('REALBUD_TEST_PROFILE_PATH_' + $index)
    if ([string]::IsNullOrEmpty($path)) { exit 9 }
    if ([System.IO.Directory]::Exists($path)) { $item = [System.IO.DirectoryInfo]::new($path) } else { $item = [System.IO.FileInfo]::new($path) }
    $acl = $item.GetAccessControl()
    $onlyPrivate = $true; $fullControl = $false; $deny = $false
    foreach ($entry in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
      if ($entry.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Deny) { $deny = $true }
      if ($entry.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) {
        if ($allowed -notcontains $entry.IdentityReference.Value) { $onlyPrivate = $false }
        if ($entry.IdentityReference.Value -eq $current -and
            ($entry.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and
            ($entry.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl) { $fullControl = $true }
      }
    }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $digest = [System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($acl.Sddl))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    $owner = $ownerSid -eq $current
    $ownerAllowed = $allowed -contains $ownerSid
    [Console]::Out.WriteLine('witness ' + [int]$acl.AreAccessRulesProtected + ' ' + [int]$owner + ' ' + [int]$ownerAllowed + ' ' + [int]$onlyPrivate + ' ' + [int]$fullControl + ' ' + [int]$deny + ' ' + $digest)
  }
} catch { exit 1 }
`;

export const ADD_USERS_READ = `
$ErrorActionPreference = 'Stop'
try {
  if ($env:REALBUD_TEST_PROFILE_COUNT -ne '1') { exit 9 }
  $path = $env:REALBUD_TEST_PROFILE_PATH_0
  if ([string]::IsNullOrEmpty($path)) { exit 9 }
  if ([System.IO.Directory]::Exists($path)) { $item = [System.IO.DirectoryInfo]::new($path) } else { $item = [System.IO.FileInfo]::new($path) }
  $acl = $item.GetAccessControl()
  $users = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($users, [System.Security.AccessControl.FileSystemRights]::Read, [System.Security.AccessControl.AccessControlType]::Allow))
  $item.SetAccessControl($acl)
} catch { exit 1 }
`;

function powershell(script: string, paths: string[]): string {
  if (process.platform !== 'win32' || paths.length < 1 || paths.length > 16) throw new Error('Windows fixture witness unavailable.');
  paths.forEach(assertOwned);
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot) || systemRoot.includes('\0')) throw new Error('Windows fixture witness unavailable.');
  const env: NodeJS.ProcessEnv = { ...process.env, REALBUD_TEST_PROFILE_COUNT: String(paths.length) };
  // Keep Windows PowerShell 5.1 away from PowerShell 7 module roots, as the product does;
  // environment names are case-insensitive on Windows, so drop every spelling first.
  for (const name of Object.keys(env)) if (name.toLowerCase() === 'psmodulepath') delete env[name];
  env.PSModulePath = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  paths.forEach((path, index) => { env[`REALBUD_TEST_PROFILE_PATH_${index}`] = path; });
  try {
    return execFileSync(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        env, shell: false, windowsHide: true,
        // A cold Windows PowerShell 5.1 has taken 34 s to start on a hosted runner.
        timeout: 60_000, maxBuffer: 16_384,
        stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
      });
  } catch { throw new Error('Windows fixture witness failed.'); }
}

const WITNESS_LINE = /^witness ([01]) ([01]) ([01]) ([01]) ([01]) ([01]) ([a-f0-9]{64})$/;

export function profileAclWitness(paths: string[]): ProfileAclWitness[] {
  return parseProfileAclWitness(powershell(WITNESS, paths), paths.length);
}

/** One `witness p o a g f d sha256` line per requested path, in order, nothing else. */
export function parseProfileAclWitness(stdout: string, count: number): ProfileAclWitness[] {
  const found = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => WITNESS_LINE.exec(line));
  if (found.length !== count || found.some(match => !match)) throw new Error('Windows fixture witness returned invalid evidence.');
  return found.map(match => ({
    protected: match![1] === '1', currentOwner: match![2] === '1', ownerAllowed: match![3] === '1', onlyPrivateGrants: match![4] === '1',
    currentFullControl: match![5] === '1', hasDeny: match![6] === '1', sddlSha256: match![7]!,
  }));
}

/** Deliberately unsafe ACL, restricted to paths below roots this helper created. */
export function addFixtureUsersRead(path: string): void { powershell(ADD_USERS_READ, [path]); }
