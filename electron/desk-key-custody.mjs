// Only this module chooses the desktop key. Recovery evidence must never outrank
// a readable current book, or disappear when a different live key is rewrapped.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDecipheriv, randomBytes, randomUUID } from 'node:crypto';

const recovery = () => new Error('The saved workspace encryption key needs recovery. No replacement key was created.');

// Windows mode bits are not an ACL, so the POSIX mode/uid admission below is
// skipped on win32 and this is the substitute for the key directory and both
// key files. The script is byte-identical to WINDOWS_ACL in
// server/windows-file-privacy.ts (desk-key-custody.test.mjs fails on drift):
// Electron main loads plain .mjs out of the ASAR and cannot import the
// compiled server module, and the policy must not fork. Path, kind and action
// are passed as environment variables, never interpolated into the command or
// its arguments. The script applies an ordered list, so the server can pay for
// one cold powershell.exe instead of one per path; this caller only ever needs
// a single operation, so it omits REALBUD_WINDOWS_FILE_PRIVACY_COUNT and the
// script falls back to the unsuffixed PATH/KIND/ACTION triple passed below.
// A refusal caused by an exception writes one stderr line of numbers and a
// .NET type name; this caller keeps only the numeric exit, as before.
//
// What this policy does and does not claim, checked against the script below:
// the verifier reads the live descriptor as objects and compares it
// semantically — access rules protected (so no inherited ACE survives), owner
// in {current user, SYSTEM, Administrators}, every Allow ACE's principal in
// that same set, at least one non-InheritOnly FullControl grant to the current
// user, and any Deny ACE refused. It never compares SDDL text, so ACE order,
// formatting or an added-then-removed rule cannot make an unsafe descriptor
// look equal to a safe one. A descriptor that is unprotected, or protected with
// no usable grant (the null-DACL shape), is refused rather than repaired.
// Confidentiality therefore rests on each key file's own verified descriptor,
// which is why a pre-existing key directory is tolerated: the directory's ACL
// is not load-bearing for reading the key. Trusted by design, not defended
// against: the same user's other processes, SYSTEM, Administrators, a holder of
// SeBackupPrivilege, and any handle opened before the lockdown. A loose
// directory does still permit FILE_DELETE_CHILD swaps and planted reparse
// points; those are refused at open/verify time, not prevented.
const WINDOWS_ACL = `
$ErrorActionPreference = 'Stop'
$count = $env:REALBUD_WINDOWS_FILE_PRIVACY_COUNT
if ([string]::IsNullOrEmpty($count)) { $count = '1' }
if ($count -notmatch '^([1-9]|[1-5][0-9]|6[0-4])$') { exit 9 }
$total = [int]$count
# The innermost exception names the primitive that refused. Never the message,
# the path, the identity, or a second line.
function Report($reportStage, $reportIndex, $reportRecord) {
  $type = 'unknown'
  $hresult = 0
  $win32 = '-'
  try {
    $err = $reportRecord.Exception
    for ($depth = 0; $depth -lt 8 -and $err.InnerException -ne $null; $depth++) { $err = $err.InnerException }
    $type = $err.GetType().FullName
    $hresult = [int]$err.HResult
    if ($err -is [System.ComponentModel.Win32Exception]) { $win32 = [string][int]$err.NativeErrorCode }
    elseif ($err -is [System.IO.IOException] -and ($hresult -band -65536) -eq -2147024896) { $win32 = [string]($hresult -band 65535) }
  } catch { }
  $fqid = '-'
  try { $fqid = ([string]$reportRecord.FullyQualifiedErrorId) -replace '[^A-Za-z0-9_.,:-]', ''; if ($fqid.Length -gt 120) { $fqid = $fqid.Substring(0, 120) }; if ($fqid.Length -eq 0) { $fqid = '-' } } catch { }
  [Console]::Error.WriteLine("[windows-acl] stage=$reportStage index=$reportIndex type=$type hresult=$hresult win32=$win32 fqid=$fqid")
}
for ($index = 0; $index -lt $total; $index++) {
[Console]::Out.WriteLine($index)
$path = $env:REALBUD_WINDOWS_FILE_PRIVACY_PATH
$kind = $env:REALBUD_WINDOWS_FILE_PRIVACY_KIND
$action = $env:REALBUD_WINDOWS_FILE_PRIVACY_ACTION
if ($index -gt 0) {
  $path = [System.Environment]::GetEnvironmentVariable("REALBUD_WINDOWS_FILE_PRIVACY_PATH_" + $index)
  $kind = [System.Environment]::GetEnvironmentVariable("REALBUD_WINDOWS_FILE_PRIVACY_KIND_" + $index)
  $action = [System.Environment]::GetEnvironmentVariable("REALBUD_WINDOWS_FILE_PRIVACY_ACTION_" + $index)
}
if ([string]::IsNullOrEmpty($path)) { exit 9 }
if ($kind -ne 'directory' -and $kind -ne 'file') { exit 9 }
if ($action -ne 'restrict' -and $action -ne 'verify') { exit 9 }
$directory = $kind -eq 'directory'
$acl = $null
$actual = $null
$cursor = $path
$target = $true
$usable = $false
$stage = 20
try {
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$allowed = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
while ($true) {
  if ($target) { $stage = 21 } else { $stage = 22 }
  $attrs = [System.IO.File]::GetAttributes($cursor)
  if (($attrs -band [System.IO.FileAttributes]::ReparsePoint) -eq [System.IO.FileAttributes]::ReparsePoint) {
    if ($target) { exit 6 } else { exit 8 }
  }
  if ($target) {
    $isDir = ($attrs -band [System.IO.FileAttributes]::Directory) -eq [System.IO.FileAttributes]::Directory
    if ($directory -ne $isDir) { exit 7 }
    $target = $false
  }
  $stage = 22
  $parent = [System.IO.Path]::GetDirectoryName($cursor)
  if ([string]::IsNullOrEmpty($parent) -or $parent -eq $cursor) { break }
  $cursor = $parent
}
if ($action -eq 'restrict') {
  $stage = 23
  if ($directory) { $acl = New-Object System.Security.AccessControl.DirectorySecurity }
  else { $acl = New-Object System.Security.AccessControl.FileSecurity }
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($principal in @($sid, $system)) {
    if ($directory) { $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow') }
    else { $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($principal, 'FullControl', 'Allow') }
    $acl.AddAccessRule($rule)
  }
  $stage = 24
  if ($directory) { (New-Object System.IO.DirectoryInfo($path)).SetAccessControl($acl) }
  else { (New-Object System.IO.FileInfo($path)).SetAccessControl($acl) }
}
$stage = 25
if ($directory) { $actual = (New-Object System.IO.DirectoryInfo($path)).GetAccessControl() }
else { $actual = (New-Object System.IO.FileInfo($path)).GetAccessControl() }
$stage = 26
if (-not $actual.AreAccessRulesProtected) { exit 5 }
if ($allowed -notcontains $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { exit 2 }
foreach ($rule in $actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  # This is a conservative private-storage admission policy, not an effective
  # access calculation over the current token's enabled and deny-only groups.
  if ($rule.AccessControlType -eq 'Deny') { exit 10 }
  if ($rule.AccessControlType -eq 'Allow') {
    if ($allowed -notcontains $rule.IdentityReference.Value) { exit 3 }
    $targetGrant = ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0
    if ($targetGrant -and $rule.IdentityReference.Value -eq $sid.Value -and (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl)) { $usable = $true }
  }
}
if (-not $usable) { exit 4 }
} catch {
  # Never emit the exception object: native messages can contain a path or an
  # identity. Only the stage, the index, the type name and numeric codes.
  Report $stage $index $_
  exit $stage
}
}
exit 0
`;

const WINDOWS_ACL_ENCODED = Buffer.from(WINDOWS_ACL, 'utf16le').toString('base64');

function privacyRecovery(status) {
  const exit = Number.isInteger(status) ? status : 'unavailable';
  return new Error(`Windows privacy for the saved workspace encryption key needs recovery. No replacement key was created. [windows-acl exit=${exit}]`);
}

// PowerShell 5.1's FileSystem provider does not accept the Win32 namespaced
// form behind -LiteralPath, so strip it exactly as `literalPath` in
// server/windows-file-privacy.ts does and leave every other byte alone.
function literalPath(target) {
  if (target.startsWith('\\\\?\\UNC\\')) return `\\\\${target.slice(8)}`;
  if (target.startsWith('\\\\?\\')) return target.slice(4);
  return target;
}

/** No-op off win32, like the server helper. Tests inject a recording stand-in. */
export function windowsKeyPrivacy(rawTarget, kind, restrict = false) {
  if (process.platform !== 'win32') return;
  const systemRoot = process.env.SystemRoot;
  const target = literalPath(rawTarget);
  if (!systemRoot || systemRoot.includes('\0') || !path.isAbsolute(systemRoot) || target.includes('\0') || !path.isAbsolute(target)) throw privacyRecovery(null);
  try {
    execFileSync(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', WINDOWS_ACL_ENCODED], {
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath')),
          PSModulePath: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
          REALBUD_WINDOWS_FILE_PRIVACY_PATH: target,
          REALBUD_WINDOWS_FILE_PRIVACY_KIND: kind,
          REALBUD_WINDOWS_FILE_PRIVACY_ACTION: restrict ? 'restrict' : 'verify',
        },
        shell: false, windowsHide: true, timeout: 120_000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'],
      });
  } catch (error) {
    // Retain only the numeric exit; never the native stderr, command or path.
    throw privacyRecovery(error?.status);
  }
}

const hexKey = value => typeof value === 'string' && /^[a-fA-F0-9]{64}$/.test(value) ? value.toLowerCase() : null;
function rawHex(bytes) { return bytes?.length === 32 ? bytes.toString('hex') : hexKey(bytes?.toString('utf8').trim()); }
function readKeyFile(file, privacy) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw recovery(); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16384 || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw recovery();
  privacy(file, 'file');
  return fs.readFileSync(file);
}
export function deskEnvelopeOpens(hex, file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value?.v !== 1 || value.alg !== 'aes-256-gcm' || ['iv', 'tag', 'ct'].some(name => typeof value[name] !== 'string')) return false;
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(hex, 'hex'), Buffer.from(value.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    Buffer.concat([decipher.update(Buffer.from(value.ct, 'base64')), decipher.final()]);
    return true;
  } catch { return false; }
}
function existingEncryptedState(dir) {
  const names = fs.readdirSync(dir);
  if (names.some(name => name.startsWith('desk.json') || name.startsWith('desk.key') || name.startsWith('workflow-state.sqlite') || name.startsWith('private-workspace-restore'))) return true;
  const privateDir = path.join(dir, 'company-installation', 'private');
  try { if (fs.readdirSync(privateDir).length) return true; } catch (error) { if (error.code !== 'ENOENT') throw recovery(); }
  return false;
}
function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function durableWrite(file, bytes, privacy) {
  // The temp name is derived from the destination, so it is always a sibling in
  // the same directory and therefore the same volume: the rename is an NTFS
  // move that carries the protected descriptor, never a cross-volume copy that
  // would take the destination directory's inheritable ACEs instead.
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    // Restrict the new file before any key material reaches it.
    privacy(temp, 'file', true);
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
    // Re-verify the published name before this key counts as written. A restrict
    // or a post-rename verify that fails throws "needs recovery" and the caller
    // never receives a key, so no new identity is minted on a bad descriptor.
    privacy(file, 'file');
    syncDirectory(path.dirname(file));
  } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
}

/** safeStorage is injected by Electron; tests use a clearly labelled fixture. */
export function resolveDeskKey({ directory, safeStorage, environmentKey, smoke = false, windowsFilePrivacy = windowsKeyPrivacy }) {
  const privacy = windowsFilePrivacy;
  // Restrict a directory this start creates, and never re-admit one it did not:
  // older installations created the application root with an inherited DACL
  // (mode 755 on POSIX, which this module has always tolerated), and refusing
  // to open the key there would strand them. The key files below carry their
  // own protected descriptors, which do not depend on the parent's.
  const created = fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (created !== undefined) privacy(directory, 'directory', true);
  if (smoke) return { hex: randomBytes(32).toString('hex'), production: false };
  const rawPath = path.join(directory, 'desk.key'), wrapPath = path.join(directory, 'desk.key.wrap');
  const rawBytes = readKeyFile(rawPath, privacy), wrappedBytes = readKeyFile(wrapPath, privacy);
  const raw = rawHex(rawBytes), env = hexKey(environmentKey);
  let available = false, wrapped = null;
  try { available = safeStorage.isEncryptionAvailable(); } catch {}
  if (available && wrappedBytes) { try { wrapped = hexKey(safeStorage.decryptString(wrappedBytes)); } catch {} }
  const candidates = [...new Set([raw, wrapped, env].filter(Boolean))];
  const current = candidates.filter(key => deskEnvelopeOpens(key, path.join(directory, 'desk.json')));
  // A locked/unreadable wrapped key is not permission to mint a new identity.
  // An existing raw/recovery key may rescue it only if it opens the current book.
  if (wrappedBytes && !wrapped && current.length !== 1) throw recovery();
  let selected = current.length === 1 ? current[0] : candidates.length === 1 ? candidates[0] : null;
  if (!selected) {
    if (candidates.length || rawBytes || wrappedBytes || environmentKey || existingEncryptedState(directory)) throw recovery();
    // The source-mode server may create its usual private development key only
    // for a truly new workspace without encryption available.
    if (!available) return { hex: null, production: false };
    selected = randomBytes(32).toString('hex');
  }
  if (!available) return { hex: selected, production: false };
  const nextWrap = safeStorage.encryptString(selected);
  if (hexKey(safeStorage.decryptString(nextWrap)) !== selected) throw recovery();
  if (wrappedBytes && wrapped !== selected) {
    // Preserve an alternative or temporarily unreadable protected key before
    // replacing the main handle. A raw alternative is retained in place below.
    const recoveryPath = path.join(directory, `desk.key.wrap.recovery-${randomUUID()}`);
    const fd = fs.openSync(recoveryPath, 'wx', 0o600);
    // Written at its final name, so restrict before the bytes and verify after.
    try { privacy(recoveryPath, 'file', true); fs.writeFileSync(fd, wrappedBytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    privacy(recoveryPath, 'file');
    syncDirectory(directory);
  }
  durableWrite(wrapPath, nextWrap, privacy);
  if (raw && raw === selected && readKeyFile(rawPath, privacy)?.equals(rawBytes)) { fs.unlinkSync(rawPath); syncDirectory(directory); }
  return { hex: selected, production: true };
}
