import * as nodePath from 'node:path';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { MessageChannel, Worker, isMainThread, receiveMessageOnPort, workerData, type MessagePort } from 'node:worker_threads';

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
//
// Every value an iteration reads is assigned inside that iteration, so no
// identity, descriptor, cursor or stage can survive into the next operation.
// A swallowed exception is the one thing that used to leave no trace, so each
// catch writes exactly one stderr line of numbers and a .NET type name.
const WINDOWS_ACL = `
$ErrorActionPreference = 'Stop'
# No cmdlets: each one auto-loads a module, which costs ~23 s per launch in the
# installed service's stripped environment and fails outright under some hosts.
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
  $script:detail = "[windows-acl] stage=$reportStage index=$reportIndex type=$type hresult=$hresult win32=$win32 fqid=$fqid"
}
# One admission; returns its numeric result (0 admitted). Every value it reads
# is assigned inside this call, so nothing survives into the next operation.
function Admit($path, $kind, $action, $index) {
$script:detail = ''
if ([string]::IsNullOrEmpty($path)) { return 9 }
if ($kind -ne 'directory' -and $kind -ne 'file') { return 9 }
if ($action -ne 'restrict' -and $action -ne 'verify') { return 9 }
$directory = $kind -eq 'directory'
$acl = $null
$actual = $null
$cursor = $path
$target = $true
$usable = $false
$stage = 20
try {
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$allowed = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
while ($true) {
  if ($target) { $stage = 21 } else { $stage = 22 }
  $attrs = [System.IO.File]::GetAttributes($cursor)
  if (($attrs -band [System.IO.FileAttributes]::ReparsePoint) -eq [System.IO.FileAttributes]::ReparsePoint) {
    if ($target) { return 6 } else { return 8 }
  }
  if ($target) {
    $isDir = ($attrs -band [System.IO.FileAttributes]::Directory) -eq [System.IO.FileAttributes]::Directory
    if ($directory -ne $isDir) { return 7 }
    $target = $false
  }
  $stage = 22
  $parent = [System.IO.Path]::GetDirectoryName($cursor)
  if ([string]::IsNullOrEmpty($parent) -or $parent -eq $cursor) { break }
  $cursor = $parent
}
if ($action -eq 'restrict') {
  $stage = 23
  if ($directory) { $acl = [System.Security.AccessControl.DirectorySecurity]::new() }
  else { $acl = [System.Security.AccessControl.FileSecurity]::new() }
  # Writing an owner needs WRITE_OWNER even when it does not change, and the .NET
  # call enables no privilege for it; the owner's implicit WRITE_DAC is enough for
  # the descriptor itself, so an object already owned by the caller keeps its owner.
  if ($directory) { $owned = ([System.IO.DirectoryInfo]::new($path)).GetAccessControl([System.Security.AccessControl.AccessControlSections]::Owner) }
  else { $owned = ([System.IO.FileInfo]::new($path)).GetAccessControl([System.Security.AccessControl.AccessControlSections]::Owner) }
  if ($owned.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { $acl.SetOwner($sid) }
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($principal in @($sid, $system)) {
    if ($directory) { $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow') }
    else { $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', 'Allow') }
    [void]$acl.AddAccessRule($rule)
  }
  $stage = 24
  if ($directory) { ([System.IO.DirectoryInfo]::new($path)).SetAccessControl($acl) }
  else { ([System.IO.FileInfo]::new($path)).SetAccessControl($acl) }
}
$stage = 25
if ($directory) { $actual = ([System.IO.DirectoryInfo]::new($path)).GetAccessControl() }
else { $actual = ([System.IO.FileInfo]::new($path)).GetAccessControl() }
$stage = 26
if (-not $actual.AreAccessRulesProtected) { return 5 }
if ($allowed -notcontains $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { return 2 }
foreach ($rule in $actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  # This is a conservative private-storage admission policy, not an effective
  # access calculation over the current token's enabled and deny-only groups.
  if ($rule.AccessControlType -eq 'Deny') { return 10 }
  if ($rule.AccessControlType -eq 'Allow') {
    if ($allowed -notcontains $rule.IdentityReference.Value) { return 3 }
    $targetGrant = ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0
    if ($targetGrant -and $rule.IdentityReference.Value -eq $sid.Value -and (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl)) { $usable = $true }
  }
}
if (-not $usable) { return 4 }
} catch {
  # Never emit the exception object: native messages can contain a path or an
  # identity. Only the stage, the index, the type name and numeric codes.
  Report $stage $index $_
  return $stage
}
return 0
}
if ($env:REALBUD_WINDOWS_FILE_PRIVACY_HOST -eq '1') {
  # Long-lived host: one request per stdin line, "<id> TAB <kind> TAB <action>
  # TAB <base64 of the UTF-8 path>"; one reply per line, "<id> TAB <result> TAB
  # <the Report line or nothing>". The path is decoded as data, never evaluated.
  # A malformed request or a closed stdin ends the host, never with success: a
  # one-shot launch that somehow inherited this switch must not read as admitted.
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($line -eq $null) { exit 9 }
    $parts = $line.Split([char]9)
    if ($parts.Count -ne 4 -or $parts[0] -notmatch '^[0-9]{1,9}$') { exit 9 }
    try { $requested = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($parts[3])) } catch { exit 9 }
    $result = @(Admit $requested $parts[1] $parts[2] 0)[-1]
    [Console]::Out.WriteLine($parts[0] + [char]9 + [string]$result + [char]9 + $script:detail)
    [Console]::Out.Flush()
  }
}
$count = $env:REALBUD_WINDOWS_FILE_PRIVACY_COUNT
if ([string]::IsNullOrEmpty($count)) { $count = '1' }
if ($count -notmatch '^([1-9]|[1-5][0-9]|6[0-4])$') { exit 9 }
$total = [int]$count
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
  $result = @(Admit $path $kind $action $index)[-1]
  if ($result -ne 0) {
    if ($script:detail) { [Console]::Error.WriteLine($script:detail) }
    exit $result
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

const OTHER_FAILURES = [
  'invalid-path-or-kind', 'system-root-unavailable', 'powershell-not-found',
  'powershell-launch-denied', 'output-limit-exceeded', 'process-terminated',
  'native-command-failed',
] as const;
type PrivacyFailure = (typeof NATIVE_FAILURES)[keyof typeof NATIVE_FAILURES] | (typeof OTHER_FAILURES)[number];
const FAILURES: ReadonlySet<string> = new Set([...Object.values(NATIVE_FAILURES), ...OTHER_FAILURES]);

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
  /** The script's one stderr line, rebuilt from numbers and a .NET type name. */
  readonly detail: string | null;

  constructor(
    category: PrivacyFailure, nativeExitCode: number | null = null, unavailable = false,
    operationIndex: number | null = null, operationCount = 1, detail: string | null = null,
  ) {
    // A one-operation batch with no native detail keeps today's exact suffix.
    const where = operationCount > 1 && operationIndex !== null ? `; operation=${operationIndex}/${operationCount}` : '';
    const why = detail === null ? '' : `; ${detail}`;
    super(`${unavailable ? UNAVAILABLE : UNVERIFIED} [windows-acl:${category}; exit=${nativeExitCode ?? 'unavailable'}${where}${why}]`);
    this.name = 'WindowsFilePrivacyError';
    this.category = category;
    this.nativeExitCode = nativeExitCode;
    this.operationIndex = operationCount > 1 ? operationIndex : null;
    this.detail = detail;
  }
}

// The only stderr shape this module will ever repeat. It is rebuilt field by
// field from a fixed character set, so no native message, path or identity can
// ride along even if the child writes something else on the same stream.
const DETAIL_LINE =
  /^\[windows-acl\] stage=(\d{1,3}) index=(-?\d{1,3}) type=([A-Za-z0-9_.+]{1,120}) hresult=(-?\d{1,11}) win32=(-?\d{1,10}|-)(?: fqid=([A-Za-z0-9_.,:-]{1,120}))?$/;

function privacyDetail(stderr: unknown): { text: string; index: number | null } | null {
  const text = typeof stderr === 'string' ? stderr : Buffer.isBuffer(stderr) ? stderr.toString('utf8') : '';
  for (const line of text.split(/\r?\n/).slice(-8).reverse()) {
    const found = DETAIL_LINE.exec(line.trim());
    if (!found) continue;
    const index = Number(found[2]);
    return {
      text: `stage=${found[1]} index=${found[2]} type=${found[3]} hresult=${found[4]} win32=${found[5]}${found[6] ? ` fqid=${found[6]}` : ''}`,
      index: Number.isInteger(index) && index >= 0 ? index : null,
    };
  }
  return null;
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
  // Do not retain native stderr/stdout, command, signal, path, SID, or cause:
  // only the one line the script itself writes, and only in its exact shape.
  const detail = privacyDetail(failure.stderr);
  return new WindowsFilePrivacyError(
    category, exit, false, operationIndex ?? detail?.index ?? null, operationCount, detail?.text ?? null,
  );
}

// The .NET path APIs do not accept the Win32 namespaced form the way the
// ancestor walk does, and Node hands one back on some Windows hosts, so the
// access-control calls would refuse a path already accepted. Strip the
// prefix here and leave every other byte exactly as the caller wrote it.
function literalPath(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) return `\\\\${path.slice(8)}`;
  if (path.startsWith('\\\\?\\')) return path.slice(4);
  return path;
}

type Invocation = { executable: string; args: string[]; env: NodeJS.ProcessEnv; literals: string[] };

function privacyInvocation(operations: WindowsFilePrivacyOperation[]): Invocation | null {
  if (process.platform !== 'win32') {
    return null;
  }
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > MAX_OPERATIONS) {
    throw new WindowsFilePrivacyError('invalid-path-or-kind');
  }
  const env: NodeJS.ProcessEnv = { ...process.env, REALBUD_WINDOWS_FILE_PRIVACY_COUNT: String(operations.length) };
  const literals: string[] = [];
  // The script calls the .NET access-control API directly, so no module has to auto-load; a
  // pinned PSModulePath still keeps Windows PowerShell 5.1 away from PowerShell 7 module roots
  // (hosted runners spend half a minute searching them). Windows environment names are
  // case-insensitive while this copy is a plain object, so drop every spelling first.
  for (const name of Object.keys(env)) if (['psmodulepath', 'realbud_windows_file_privacy_host'].includes(name.toLowerCase())) delete env[name];
  env.PSModulePath = nodePath.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  operations.forEach((operation, index) => {
    const { path, kind, action } = operation ?? ({} as Partial<WindowsFilePrivacyOperation>);
    const literal = typeof path === 'string' ? literalPath(path) : path;
    if (
      typeof literal !== 'string' ||
      literal.includes('\0') ||
      !isAbsolute(literal) ||
      (kind !== 'file' && kind !== 'directory') ||
      (action !== 'restrict' && action !== 'verify')
    ) {
      throw new WindowsFilePrivacyError('invalid-path-or-kind', null, false, index, operations.length);
    }
    // Read by name inside the script; never interpolated into a command.
    const suffix = index === 0 ? '' : `_${index}`;
    env[`REALBUD_WINDOWS_FILE_PRIVACY_PATH${suffix}`] = literal; literals.push(literal);
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
    env, literals,
  };
}

export async function windowsFilePrivacy(
  path: string,
  kind: 'file' | 'directory',
  restrict = false,
): Promise<void> {
  await windowsFilePrivacyBatch([{ path, kind, action: restrict ? 'restrict' : 'verify' }]);
}

/** The most operations one process accepts; a longer list is split by the caller. */
export const WINDOWS_FILE_PRIVACY_MAX_BATCH = MAX_OPERATIONS;

/**
 * The asynchronous form of `windowsFilePrivacyBatchSync`: one PowerShell process
 * for an ordered list, stopping at the first refusal, without blocking the
 * service's event loop while a cold powershell.exe starts.
 */
export async function windowsFilePrivacyBatch(operations: WindowsFilePrivacyOperation[]): Promise<WindowsFilePrivacyResult[]> {
  const invocation = privacyInvocation(operations);
  const planned = (Array.isArray(operations) ? operations : []).map(({ path, kind, action }) => ({ path, kind, action }));
  if (!invocation) return planned.map(operation => ({ ...operation, applied: false }));
  if (process.env.REALBUD_WINDOWS_PRIVACY_HOST !== '0') {
    await hostBatch(invocation, planned);
    return planned.map(operation => ({ ...operation, applied: true }));
  }
  try {
    await execFileAsync(
      invocation.executable,
      invocation.args,
      {
        env: invocation.env,
        shell: false,
        windowsHide: true,
        timeout: 120_000,
        maxBuffer: 4096,
      },
    );
  } catch (error) {
    const failure = error && typeof error === 'object' ? error as Record<string, unknown> : {};
    throw nativeFailure(error, attemptedIndex(failure.stdout, planned.length), planned.length);
  }
  return planned.map(operation => ({ ...operation, applied: true }));
}

// The long-lived admission host. Requests are answered in order; a reply that
// is not exactly the next request's, a timeout, a crash or oversized output
// ends the host and refuses everything in flight (never admits). The next
// request starts a fresh host. It holds no reference on the event loop while
// idle, and closing its stdin (process exit) ends it.
type HostRequest = { id: number; settle: (reply: { result: number; detail: string } | WindowsFilePrivacyError) => void; timer: NodeJS.Timeout };
type Host = { child: ChildProcess; queue: HostRequest[]; buffer: string; nextId: number };
let host: Host | null = null;
const HOST_TIMEOUT_MS = 120_000;

function endHost(target: Host, failure: WindowsFilePrivacyError): void {
  if (host === target) host = null;
  for (const request of target.queue.splice(0)) { clearTimeout(request.timer); request.settle(failure); }
  if (target.child.exitCode === null && target.child.signalCode === null) try { target.child.kill(); } catch { /* already gone */ }
}

function idleRefs(target: Host): void {
  const busy = target.queue.length > 0;
  for (const handle of [target.child, target.child.stdin, target.child.stdout] as Array<{ ref?: () => void; unref?: () => void } | null>) {
    if (busy) handle?.ref?.(); else handle?.unref?.();
  }
}

function startHost(invocation: { executable: string; args: string[]; env: NodeJS.ProcessEnv }): Host {
  const env: NodeJS.ProcessEnv = {};
  // Only the stable environment: no operation's path stays in the host's block.
  for (const [name, value] of Object.entries(invocation.env)) if (!name.startsWith('REALBUD_WINDOWS_FILE_PRIVACY_')) env[name] = value;
  env.REALBUD_WINDOWS_FILE_PRIVACY_HOST = '1';
  const child = spawn(invocation.executable, invocation.args, { env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const started: Host = { child, queue: [], buffer: '', nextId: 1 };
  child.on('error', error => endHost(started, nativeFailure(error)));
  child.on('exit', () => endHost(started, nativeFailure({ killed: true })));
  child.stdin!.on('error', () => endHost(started, nativeFailure({ killed: true })));
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    started.buffer += chunk;
    if (started.buffer.length > 16_384) return endHost(started, nativeFailure({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }));
    for (let end = started.buffer.indexOf('\n'); end >= 0; end = started.buffer.indexOf('\n')) {
      const line = started.buffer.slice(0, end).replace(/\r$/, '');
      started.buffer = started.buffer.slice(end + 1);
      const reply = /^([0-9]{1,9})\t([0-9]{1,3})\t(.{0,512})$/.exec(line);
      const request = started.queue[0];
      if (!reply || !request || Number(reply[1]) !== request.id) return endHost(started, nativeFailure({ killed: true }));
      started.queue.shift(); clearTimeout(request.timer); idleRefs(started);
      request.settle({ result: Number(reply[2]), detail: reply[3]! });
    }
  });
  return started;
}

// Same script and policy, one long-lived process: an admission costs the .NET
// ACL calls, not a PowerShell launch (about 0.2 s, seconds on a busy PC).
async function hostBatch(invocation: Invocation, planned: WindowsFilePrivacyOperation[]): Promise<void> {
  for (const [index, operation] of planned.entries()) {
    const { result, detail } = await hostAdmission(invocation, invocation.literals[index]!, operation.kind, operation.action);
    if (result !== 0) {
      throw new WindowsFilePrivacyError(
        NATIVE_FAILURES[result as keyof typeof NATIVE_FAILURES] ?? 'native-command-failed', result, false,
        index, planned.length, privacyDetail(detail)?.text ?? null,
      );
    }
  }
}

function hostAdmission(
  invocation: { executable: string; args: string[]; env: NodeJS.ProcessEnv },
  literal: string, kind: 'file' | 'directory', action: 'restrict' | 'verify',
): Promise<{ result: number; detail: string }> {
  const target = host ??= startHost(invocation);
  return new Promise((resolve, reject) => {
    const id = target.nextId++;
    const timer = setTimeout(() => endHost(target, nativeFailure({ killed: true })), HOST_TIMEOUT_MS);
    target.queue.push({ id, timer, settle: reply => reply instanceof WindowsFilePrivacyError ? reject(reply) : resolve(reply) });
    idleRefs(target);
    // The path travels as base64 data on stdin, never in a command or argument.
    target.child.stdin!.write(`${id}\t${kind}\t${action}\t${Buffer.from(literal, 'utf8').toString('base64')}\n`);
  });
}

/**
 * One PowerShell process for an ordered list of admissions. The caller decides
 * the order; the script stops at the first refusal, so nothing after a failure
 * is applied and the failure carries the same numeric exit code as a single
 * call. Only batch operations whose order is already safe: an admission that
 * must gate a write still has to happen before that write. It is served by the
 * same long-lived host as the asynchronous form (see syncHostBatch), or by a
 * one-shot launch when REALBUD_WINDOWS_PRIVACY_HOST is '0'.
 */
export function windowsFilePrivacyBatchSync(operations: WindowsFilePrivacyOperation[]): WindowsFilePrivacyResult[] {
  const invocation = privacyInvocation(operations);
  const planned = (Array.isArray(operations) ? operations : []).map(({ path, kind, action }) => ({ path, kind, action }));
  if (!invocation) return planned.map(operation => ({ ...operation, applied: false }));
  if (process.env.REALBUD_WINDOWS_PRIVACY_HOST !== '0') {
    syncHostBatch(invocation, planned);
    return planned.map(operation => ({ ...operation, applied: true }));
  }
  try {
    execFileSync(invocation.executable, invocation.args, {
      env: invocation.env, shell: false, windowsHide: true, timeout: 120_000,
      maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // execFileSync reports a numeric process exit as status, not code.
    const failure = error && typeof error === 'object' ? error as Record<string, unknown> : {};
    throw nativeFailure({
      code: failure.code === 'ENOBUFS' ? 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' : failure.code ?? failure.status,
      killed: failure.killed === true || failure.code === 'ETIMEDOUT',
      stderr: failure.stderr,
    }, attemptedIndex(failure.stdout, planned.length), planned.length);
  }
  return planned.map(operation => ({ ...operation, applied: true }));
}

/** The same policy for existing synchronous installer/profile call paths. */
export function windowsFilePrivacySync(path: string, kind: 'file' | 'directory', restrict = false): void {
  windowsFilePrivacyBatchSync([{ path, kind, action: restrict ? 'restrict' : 'verify' }]);
}

// Synchronous callers (about forty storage paths) used to launch a cold
// powershell.exe each, 2-3 s apiece, freezing the service for half a minute
// when they stacked. They now wait on a worker thread that owns its own
// long-lived host and runs the same hostBatch. The main thread blocks on one
// shared word: 1 = replied, 2 = the worker is gone. A timeout, a dead worker,
// a mismatched or malformed reply refuses (never admits) and the next call
// starts a fresh worker. Idle, neither the worker nor its host keeps the
// process alive.
type SyncHost = { worker: Worker; port: MessagePort; signal: Int32Array; nextId: number };
type SyncFailure = { category: string; nativeExitCode: number | null; operationIndex: number | null; detail: string | null };
let syncHost: SyncHost | null = null;
const SYNC_HOST_MARKER = 'realbudWindowsPrivacySyncHost';

function startSyncHost(): SyncHost {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  // Source mode runs this .ts under strip-types (the worker inherits execArgv);
  // the packaged build runs the compiled .js beside it.
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { [SYNC_HOST_MARKER]: true, port: port2, signal }, transferList: [port2],
  });
  const started: SyncHost = { worker, port: port1, signal, nextId: 1 };
  const forget = () => { if (syncHost === started) syncHost = null; };
  worker.on('error', forget);
  worker.on('exit', forget);
  worker.unref(); port1.unref();
  return started;
}

function endSyncHost(target: SyncHost): WindowsFilePrivacyError {
  if (syncHost === target) syncHost = null;
  target.worker.terminate().catch(() => { /* already gone */ });
  return nativeFailure({ killed: true });
}

function syncHostBatch(invocation: Invocation, planned: WindowsFilePrivacyOperation[]): void {
  // 1 -> 0 readies a worker that answered before; a 2 means it has gone.
  if (syncHost && Atomics.compareExchange(syncHost.signal, 0, 1, 0) === 2) endSyncHost(syncHost);
  const target = syncHost ??= startSyncHost();
  const id = target.nextId++;
  target.port.postMessage({ id, invocation, planned });
  if (Atomics.wait(target.signal, 0, 0, HOST_TIMEOUT_MS) === 'timed-out' || Atomics.load(target.signal, 0) !== 1) throw endSyncHost(target);
  const reply = receiveMessageOnPort(target.port)?.message as { id?: unknown; failure?: SyncFailure | null } | undefined;
  if (!reply || reply.id !== id || reply.failure === undefined) throw endSyncHost(target);
  if (reply.failure === null) return;
  // Rebuild the refusal from its fields, accepting only what this module can produce.
  const { category, nativeExitCode, operationIndex, detail } = reply.failure;
  if (
    !FAILURES.has(category) ||
    !(nativeExitCode === null || (Number.isInteger(nativeExitCode) && nativeExitCode >= 0 && nativeExitCode <= 0xffff_ffff)) ||
    !(operationIndex === null || (Number.isInteger(operationIndex) && operationIndex >= 0 && operationIndex < planned.length)) ||
    !(detail === null || (typeof detail === 'string' && privacyDetail(`[windows-acl] ${detail}`)?.text === detail))
  ) throw endSyncHost(target);
  throw new WindowsFilePrivacyError(category as PrivacyFailure, nativeExitCode, false, operationIndex, planned.length, detail);
}

if (!isMainThread && (workerData as Record<string, unknown> | null)?.[SYNC_HOST_MARKER] === true) {
  const { port, signal } = workerData as { port: MessagePort; signal: Int32Array };
  const answer = (value: number) => { Atomics.store(signal, 0, value); Atomics.notify(signal, 0); };
  process.on('exit', () => answer(2));
  port.on('message', ({ id, invocation, planned }: { id: number; invocation: Invocation; planned: WindowsFilePrivacyOperation[] }) => {
    hostBatch(invocation, planned).then(
      () => null,
      (error: unknown): SyncFailure => error instanceof WindowsFilePrivacyError
        ? { category: error.category, nativeExitCode: error.nativeExitCode, operationIndex: error.operationIndex, detail: error.detail }
        : { category: 'native-command-failed', nativeExitCode: null, operationIndex: null, detail: null },
    ).then(failure => { port.postMessage({ id, failure }); answer(1); });
  });
}
