import { execFile, execFileSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Windows mode bits are not an ACL. Use the built-in ACL API without placing a
// secret, verifier, or interpolated path in a command, its output, or arguments.
// Existing paths are verify-only. Newly owned directories and files may be restricted
// before content is written. This does not protect secrets from the OS admin.
//
// A cold powershell.exe costs seconds, so one process applies a whole ordered
// list: operation i reads REALBUD_WINDOWS_FILE_PRIVACY_{PATH,KIND,ACTION} with
// an `_i` suffix for i > 0, so a one-operation batch is byte-for-byte the same
// invocation as before. Values are read by name, never interpolated. The list
// stops at the first failure with today's numeric exit code; the attempted
// index (an integer, never a path or identity) is echoed so the caller can say
// which operation refused.
const WINDOWS_ACL = `
$ErrorActionPreference = 'Stop'
$count = $env:REALBUD_WINDOWS_FILE_PRIVACY_COUNT
if ([string]::IsNullOrEmpty($count)) { $count = '1' }
if ($count -notmatch '^([1-9]|[1-5][0-9]|6[0-4])$') { exit 9 }
$total = [int]$count
$stage = 20
try {
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$allowed = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
} catch {
  exit $stage
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
$stage = 20
try {
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

/** One ordered admission. `verify` never repairs; `restrict` owns a new object. */
export type WindowsFilePrivacyOperation = {
  path: string;
  kind: 'file' | 'directory';
  action: 'restrict' | 'verify';
};
/** `applied` is false only where this policy does not run (not win32). */
export type WindowsFilePrivacyResult = WindowsFilePrivacyOperation & { applied: boolean };

// Each operation costs three more environment entries and one more path in the
// child's environment block, so the list is capped; the script refuses a count
// above this too, and a caller with more work splits it across processes.
const MAX_OPERATIONS = 64;

class WindowsFilePrivacyError extends Error {
  readonly category: PrivacyFailure;
  readonly nativeExitCode: number | null;
  /** Which operation of a batch refused; null when it is not known. */
  readonly operationIndex: number | null;

  constructor(
    category: PrivacyFailure, nativeExitCode: number | null = null, unavailable = false,
    operationIndex: number | null = null, operationCount = 1,
  ) {
    // A one-operation batch keeps today's exact diagnostic suffix.
    const where = operationCount > 1 && operationIndex !== null ? `; operation=${operationIndex}/${operationCount}` : '';
    super(`${unavailable ? UNAVAILABLE : UNVERIFIED} [windows-acl:${category}; exit=${nativeExitCode ?? 'unavailable'}${where}]`);
    this.name = 'WindowsFilePrivacyError';
    this.category = category;
    this.nativeExitCode = nativeExitCode;
    this.operationIndex = operationCount > 1 ? operationIndex : null;
  }
}

/** The script echoes the index it attempted; take that integer and nothing else. */
function attemptedIndex(stdout: unknown, count: number): number | null {
  const text = typeof stdout === 'string' ? stdout : Buffer.isBuffer(stdout) ? stdout.toString('utf8') : '';
  const last = text.split(/\r?\n/).filter(line => /^[0-9]{1,3}$/.test(line)).at(-1);
  if (last === undefined) return null;
  const index = Number(last);
  return index >= 0 && index < count ? index : null;
}

function nativeFailure(error: unknown, operationIndex: number | null = null, operationCount = 1): WindowsFilePrivacyError {
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
  return new WindowsFilePrivacyError(category, exit, false, operationIndex, operationCount);
}

function privacyInvocation(
  operations: WindowsFilePrivacyOperation[],
): { executable: string; args: string[]; env: NodeJS.ProcessEnv } | null {
  if (process.platform !== 'win32') {
    return null;
  }
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > MAX_OPERATIONS) {
    throw new WindowsFilePrivacyError('invalid-path-or-kind');
  }
  const env: NodeJS.ProcessEnv = { ...process.env, REALBUD_WINDOWS_FILE_PRIVACY_COUNT: String(operations.length) };
  operations.forEach((operation, index) => {
    const { path, kind, action } = operation ?? ({} as Partial<WindowsFilePrivacyOperation>);
    if (
      typeof path !== 'string' ||
      path.includes('\0') ||
      !isAbsolute(path) ||
      (kind !== 'file' && kind !== 'directory') ||
      (action !== 'restrict' && action !== 'verify')
    ) {
      throw new WindowsFilePrivacyError('invalid-path-or-kind', null, false, index, operations.length);
    }
    // Read by name inside the script; never interpolated into a command.
    const suffix = index === 0 ? '' : `_${index}`;
    env[`REALBUD_WINDOWS_FILE_PRIVACY_PATH${suffix}`] = path;
    env[`REALBUD_WINDOWS_FILE_PRIVACY_KIND${suffix}`] = kind;
    env[`REALBUD_WINDOWS_FILE_PRIVACY_ACTION${suffix}`] = action;
  });
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
    env,
  };
}

export async function windowsFilePrivacy(
  path: string,
  kind: 'file' | 'directory',
  restrict = false,
): Promise<void> {
  const invocation = privacyInvocation([{ path, kind, action: restrict ? 'restrict' : 'verify' }]);
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

/**
 * One PowerShell process for an ordered list of admissions. The caller decides
 * the order; the script stops at the first refusal, so nothing after a failure
 * is applied and the failure carries the same numeric exit code as a single
 * call. Only batch operations whose order is already safe: an admission that
 * must gate a write still has to happen before that write.
 */
export function windowsFilePrivacyBatchSync(operations: WindowsFilePrivacyOperation[]): WindowsFilePrivacyResult[] {
  const invocation = privacyInvocation(operations);
  const planned = (Array.isArray(operations) ? operations : []).map(({ path, kind, action }) => ({ path, kind, action }));
  if (!invocation) return planned.map(operation => ({ ...operation, applied: false }));
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
    }, attemptedIndex(failure.stdout, planned.length), planned.length);
  }
  return planned.map(operation => ({ ...operation, applied: true }));
}

/** The same policy for existing synchronous installer/profile call paths. */
export function windowsFilePrivacySync(path: string, kind: 'file' | 'directory', restrict = false): void {
  windowsFilePrivacyBatchSync([{ path, kind, action: restrict ? 'restrict' : 'verify' }]);
}
