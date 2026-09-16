import { execFile } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Windows mode bits are not an ACL. Use the built-in ACL API without placing a
// secret, verifier, or interpolated path in a command, its output, or arguments.
// Existing paths are verify-only. Newly owned directories and files may be restricted
// before content is written. This does not protect secrets from the OS admin.
const WINDOWS_ACL = `
$ErrorActionPreference = 'Stop'
$path = $env:REALBUD_WINDOWS_FILE_PRIVACY_PATH
$kind = $env:REALBUD_WINDOWS_FILE_PRIVACY_KIND
$action = $env:REALBUD_WINDOWS_FILE_PRIVACY_ACTION
if ($kind -ne 'directory' -and $kind -ne 'file') { exit 9 }
if ($action -ne 'restrict' -and $action -ne 'verify') { exit 9 }
$directory = $kind -eq 'directory'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$cursor = $path
$target = $true
while ($true) {
  $attrs = [System.IO.File]::GetAttributes($cursor)
  if (($attrs -band [System.IO.FileAttributes]::ReparsePoint) -eq [System.IO.FileAttributes]::ReparsePoint) { exit 6 }
  if ($target) {
    $isDir = ($attrs -band [System.IO.FileAttributes]::Directory) -eq [System.IO.FileAttributes]::Directory
    if ($directory -ne $isDir) { exit 7 }
    $target = $false
  }
  $parent = [System.IO.Path]::GetDirectoryName($cursor)
  if ([string]::IsNullOrEmpty($parent) -or $parent -eq $cursor) { break }
  $cursor = $parent
}
if ($action -eq 'restrict') {
  if ($directory) { $acl = New-Object System.Security.AccessControl.DirectorySecurity }
  else { $acl = New-Object System.Security.AccessControl.FileSecurity }
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($principal in @($sid, $system)) {
    if ($directory) { $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow') }
    else { $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($principal, 'FullControl', 'Allow') }
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $path -AclObject $acl
}
$actual = Get-Acl -LiteralPath $path
if (-not $actual.AreAccessRulesProtected) { exit 5 }
$allowed = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
if ($allowed -notcontains $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { exit 2 }
$usable = $false
foreach ($rule in $actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow') {
    if ($allowed -notcontains $rule.IdentityReference.Value) { exit 3 }
    if ($rule.IdentityReference.Value -eq $sid.Value -and (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl)) { $usable = $true }
  }
}
if (-not $usable) { exit 4 }
`;

const WINDOWS_ACL_ENCODED = Buffer.from(WINDOWS_ACL, 'utf16le').toString('base64');

const UNAVAILABLE =
  'Windows privacy verification is unavailable. Use the trusted installer account.';
const UNVERIFIED =
  'Windows file privacy could not be verified. Use a private directory owned by the trusted installer account.';

export async function windowsFilePrivacy(
  path: string,
  kind: 'file' | 'directory',
  restrict = false,
): Promise<void> {
  if (process.platform !== 'win32') {
    return;
  }
  if (
    path.includes('\0') ||
    !isAbsolute(path) ||
    (kind !== 'file' && kind !== 'directory')
  ) {
    throw new Error(UNVERIFIED);
  }
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || systemRoot.includes('\0') || !isAbsolute(systemRoot)) {
    throw new Error(UNAVAILABLE);
  }
  const powershell = join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  try {
    await execFileAsync(
      powershell,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', WINDOWS_ACL_ENCODED],
      {
        env: {
          ...process.env,
          REALBUD_WINDOWS_FILE_PRIVACY_PATH: path,
          REALBUD_WINDOWS_FILE_PRIVACY_KIND: kind,
          REALBUD_WINDOWS_FILE_PRIVACY_ACTION: restrict ? 'restrict' : 'verify',
        },
        shell: false,
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 4096,
      },
    );
  } catch {
    throw new Error(UNVERIFIED);
  }
}
