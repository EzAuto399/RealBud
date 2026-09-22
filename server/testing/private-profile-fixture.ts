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
  onlyPrivateGrants: boolean;
  currentFullControl: boolean;
  hasDeny: boolean;
  sddlSha256: string;
}

// Independent observation code: no production verifier/script reuse. Return
// booleans and a descriptor digest only, never the native descriptor or SID.
const WITNESS = `
$ErrorActionPreference = 'Stop'
try {
  $current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $private = @($current, 'S-1-5-18', 'S-1-5-32-544')
  $paths = @($env:REALBUD_TEST_PROFILE_PATHS | ConvertFrom-Json)
  if ($paths.Count -lt 1 -or $paths.Count -gt 16) { exit 9 }
  $result = @(foreach ($path in $paths) {
    $item = if ([System.IO.Directory]::Exists($path)) { [System.IO.DirectoryInfo]::new($path) } else { [System.IO.FileInfo]::new($path) }
    $acl = $item.GetAccessControl()
    $onlyPrivate = $true; $fullControl = $false; $deny = $false
    foreach ($entry in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
      if ($entry.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Deny) { $deny = $true }
      if ($entry.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) {
        if ($private -notcontains $entry.IdentityReference.Value) { $onlyPrivate = $false }
        if ($entry.IdentityReference.Value -eq $current -and
            ($entry.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and
            ($entry.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl) { $fullControl = $true }
      }
    }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $digest = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($acl.Sddl))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    [pscustomobject]@{
      protected = $acl.AreAccessRulesProtected
      currentOwner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq $current
      onlyPrivateGrants = $onlyPrivate
      currentFullControl = $fullControl
      hasDeny = $deny
      sddlSha256 = $digest
    }
  })
  ConvertTo-Json -InputObject $result -Compress
} catch { exit 1 }
`;

const ADD_USERS_READ = `
$ErrorActionPreference = 'Stop'
try {
  $paths = @($env:REALBUD_TEST_PROFILE_PATHS | ConvertFrom-Json)
  if ($paths.Count -ne 1) { exit 9 }
  $item = if ([System.IO.Directory]::Exists($paths[0])) { [System.IO.DirectoryInfo]::new($paths[0]) } else { [System.IO.FileInfo]::new($paths[0]) }
  $acl = $item.GetAccessControl()
  $users = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($users, 'Read', 'Allow'))
  $item.SetAccessControl($acl)
} catch { exit 1 }
`;

function powershell(script: string, paths: string[]): string {
  if (process.platform !== 'win32' || paths.length < 1 || paths.length > 16) throw new Error('Windows fixture witness unavailable.');
  paths.forEach(assertOwned);
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot) || systemRoot.includes('\0')) throw new Error('Windows fixture witness unavailable.');
  try {
    return execFileSync(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        env: { ...process.env, REALBUD_TEST_PROFILE_PATHS: JSON.stringify(paths) },
        shell: false, windowsHide: true, timeout: 15_000, maxBuffer: 16_384,
        stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
      });
  } catch { throw new Error('Windows fixture witness failed.'); }
}

export function profileAclWitness(paths: string[]): ProfileAclWitness[] {
  const result: unknown = JSON.parse(powershell(WITNESS, paths));
  if (!Array.isArray(result) || result.length !== paths.length || result.some(value =>
    !value || typeof value !== 'object' || !/^[a-f0-9]{64}$/.test(value.sddlSha256) ||
    ['protected', 'currentOwner', 'onlyPrivateGrants', 'currentFullControl', 'hasDeny'].some(key => typeof value[key] !== 'boolean')
  )) throw new Error('Windows fixture witness returned invalid evidence.');
  return result as ProfileAclWitness[];
}

/** Deliberately unsafe ACL, restricted to paths below roots this helper created. */
export function addFixtureUsersRead(path: string): void { powershell(ADD_USERS_READ, [path]); }
