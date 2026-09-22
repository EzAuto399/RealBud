import { execFile, execFileSync } from 'node:child_process';
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
$stage = 20
try {
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$cursor = $path
$target = $true
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
  Set-Acl -LiteralPath $path -AclObject $acl
}
$stage = 25
$actual = Get-Acl -LiteralPath $path
$stage = 26
if (-not $actual.AreAccessRulesProtected) { exit 5 }
$allowed = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
if ($allowed -notcontains $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { exit 2 }
$usable = $false
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
  # Never emit the exception: native messages can contain a path or identity.
  exit $stage
}
exit 0
`;

const WINDOWS_ACL_ENCODED = Buffer.from(WINDOWS_ACL, 'utf16le').toString('base64');

const UNAVAILABLE =
  'Windows privacy verification is unavailable. Use the trusted installer account.';
const UNVERIFIED =
  'Windows file privacy could not be verified. Use a private directory owned by the trusted installer account.';

const NATIVE_FAILURES = {
  2: 'owner-not-allowed',
  3: 'grant-not-allowed',
  4: 'target-full-control-missing',
  5: 'inheritance-not-protected',
  6: 'target-reparse-point',
  7: 'target-kind-mismatch',
  8: 'ancestor-reparse-point',
  9: 'invalid-invocation',
  10: 'deny-rule-present',
  20: 'identity-unavailable',
  21: 'target-inspection-failed',
  22: 'ancestor-inspection-failed',
  23: 'descriptor-construction-failed',
  24: 'acl-apply-failed',
  25: 'acl-read-failed',
  26: 'acl-inspection-failed',
} as const;

type PrivacyFailure = (typeof NATIVE_FAILURES)[keyof typeof NATIVE_FAILURES]
  | 'invalid-path-or-kind' | 'system-root-unavailable' | 'powershell-not-found'
  | 'powershell-launch-denied' | 'output-limit-exceeded' | 'process-terminated'
  | 'native-command-failed';

class WindowsFilePrivacyError extends Error {
  readonly category: PrivacyFailure;
  readonly nativeExitCode: number | null;

  constructor(category: PrivacyFailure, nativeExitCode: number | null = null, unavailable = false) {
    super(`${unavailable ? UNAVAILABLE : UNVERIFIED} [windows-acl:${category}; exit=${nativeExitCode ?? 'unavailable'}]`);
    this.name = 'WindowsFilePrivacyError';
    this.category = category;
    this.nativeExitCode = nativeExitCode;
  }
}

function nativeFailure(error: unknown): WindowsFilePrivacyError {
  const failure = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const code = failure.code;
  const exit = typeof code === 'number' && Number.isInteger(code) && code >= 0 && code <= 0xffff_ffff ? code : null;
  let category: PrivacyFailure = 'native-command-failed';
  if (code === 'ENOENT') category = 'powershell-not-found';
  else if (code === 'EACCES' || code === 'EPERM') category = 'powershell-launch-denied';
  else if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') category = 'output-limit-exceeded';
  else if (failure.killed === true) category = 'process-terminated';
  else if (exit !== null) category = NATIVE_FAILURES[exit as keyof typeof NATIVE_FAILURES] ?? 'native-command-failed';
  // Do not retain native stderr/stdout, command, signal, path, SID, or cause.
  return new WindowsFilePrivacyError(category, exit);
}

function privacyInvocation(
  path: string,
  kind: 'file' | 'directory',
  restrict = false,
): { executable: string; args: string[]; env: NodeJS.ProcessEnv } | null {
  if (process.platform !== 'win32') {
    return null;
  }
  if (
    path.includes('\0') ||
    !isAbsolute(path) ||
    (kind !== 'file' && kind !== 'directory')
  ) {
    throw new WindowsFilePrivacyError('invalid-path-or-kind');
  }
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || systemRoot.includes('\0') || !isAbsolute(systemRoot)) {
    throw new WindowsFilePrivacyError('system-root-unavailable', null, true);
  }
  const powershell = join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  return {
    executable: powershell,
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', WINDOWS_ACL_ENCODED],
    env: {
      ...process.env,
      REALBUD_WINDOWS_FILE_PRIVACY_PATH: path,
      REALBUD_WINDOWS_FILE_PRIVACY_KIND: kind,
      REALBUD_WINDOWS_FILE_PRIVACY_ACTION: restrict ? 'restrict' : 'verify',
    },
  };
}

export async function windowsFilePrivacy(
  path: string,
  kind: 'file' | 'directory',
  restrict = false,
): Promise<void> {
  const invocation = privacyInvocation(path, kind, restrict);
  if (!invocation) return;
  try {
    await execFileAsync(
      invocation.executable,
      invocation.args,
      {
        env: invocation.env,
        shell: false,
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 4096,
      },
    );
  } catch (error) {
    throw nativeFailure(error);
  }
}

/** The same policy for existing synchronous installer/profile call paths. */
export function windowsFilePrivacySync(path: string, kind: 'file' | 'directory', restrict = false): void {
  const invocation = privacyInvocation(path, kind, restrict);
  if (!invocation) return;
  try {
    execFileSync(invocation.executable, invocation.args, {
      env: invocation.env, shell: false, windowsHide: true, timeout: 15_000,
      maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // execFileSync reports a numeric process exit as status, not code.
    const failure = error && typeof error === 'object' ? error as Record<string, unknown> : {};
    throw nativeFailure({
      code: failure.code === 'ENOBUFS' ? 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' : failure.code ?? failure.status,
      killed: failure.killed === true || failure.code === 'ETIMEDOUT',
    });
  }
}
