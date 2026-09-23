// Disposable CI proof of the production-managed installer, without account or
// model setup. The native journal harness consumes this exact runtime next.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// These are observations, not automatic root-cause diagnoses. The optional
// failure excerpt below is redacted before either diagnostic file is written.
export const UV_DIAGNOSTIC_SIGNALS = Object.freeze({
  'powershell-parser': 'ParserError|Unexpected token|Missing closing|The string is missing the terminator',
  'powershell-policy': 'PSSecurityException|running scripts is disabled|AuthorizationManager check failed',
  'powershell-command-missing': 'CommandNotFoundException|is not recognized as the name of a cmdlet',
  'powershell-argument-binding': 'ParameterBindingException|Cannot bind argument|Cannot bind parameter',
  'powershell-method-invocation': 'MethodInvocationException|Method invocation failed|Exception calling',
  'access-denied': 'UnauthorizedAccessException|Access is denied|PermissionDenied|Permission denied',
  'network-name-resolution': 'remote name could not be resolved|No such host is known|NameResolutionFailure',
  'network-tls': 'Could not create SSL/TLS secure channel|certificate|trust relationship',
  'network-connection': 'Unable to connect|connection.*timed out|ConnectFailure|ProxyAuthenticationRequired',
  'http-rate-limited': '\\(429\\)|Too Many Requests|status[^0-9]*429',
  'http-forbidden': '\\(403\\)|status[^0-9]*403',
  'http-not-found': '\\(404\\)|status[^0-9]*404',
  'disk-space': 'not enough space on the disk|disk full|insufficient disk space',
  'uv-not-found': 'uv installed but not found',
  'uv-stage-failed': 'uv installation failed|Failed to install uv',
  'uv-install-started': 'Installing managed uv into',
  'uv-managed-ready': 'Managed uv found|Managed uv installed',
});
export const UV_DIAGNOSTIC_TIMEOUT_MS = 120_000;
export const UV_EXCERPT_LINES = 15;
export const UV_EXCERPT_CHARS = 240;
export const REPOSITORY_DIAGNOSTIC_SIGNALS = Object.freeze({
  'repository-update': 'Existing installation found, updating',
  'repository-invalid-existing': 'is not a valid git repo',
  'repository-ssh': 'Trying SSH clone',
  'repository-https': 'SSH failed, trying HTTPS',
  'repository-zip': 'Git clone failed -- downloading ZIP archive',
  'repository-zip-extracted': 'Downloaded and extracted',
  'repository-pin': 'Pinning to commit',
  'repository-ready': 'Repository ready',
});
// Shared by the PowerShell observer and Node receipt boundary. Deliberately
// more conservative than service-smoke diagnostics: complete URLs and paths,
// credential-labelled tails, and long opaque values lose their contents.
const UV_EXCERPT_REDACTIONS = [
  [String.raw`\x1b\[[0-?]*[ -/]*[@-~]`, ''],
  [String.raw`[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]`, ''],
  [String.raw`(?:https?|ftp|file)://[^\s"'<>]+`, '[url]'],
  [String.raw`\b[A-Za-z0-9_.-]*(?:key|token|secret|password|passwd|credential|authorization|cookie|session)[A-Za-z0-9_.-]*["']?\s*[=:].*`, '[credential field redacted]'],
  [String.raw`--?(?:api[-_]?key|token|secret|password|passwd|credential|authorization)\b.*`, '[credential argument redacted]'],
  [String.raw`\b(?:Bearer|Basic)\s+[^\s,;]+`, '[authorization redacted]'],
  [String.raw`\b(?:rbk|rbc|mgt|ak|ck|ntn|npm|ghp|gho|ghu|ghs|ghr|secret|github_pat)_[A-Za-z0-9_-]{8,}|\b(?:sk-|xai-|xox[abposr]-)[A-Za-z0-9_-]{8,}|\bAKIA[0-9A-Z]{16}|\bAIza[0-9A-Za-z_-]{20,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`, '[credential redacted]'],
  [String.raw`(?:\b[A-Za-z]:[\\/]|\\\\)[^\r\n"<>|]*`, '[absolute path]'],
  [String.raw`(?:^|[\s("'])/(?!/)[^\r\n"<>|]*`, ' [absolute path]'],
  [String.raw`\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b`, '[email]'],
  [String.raw`[A-Za-z0-9_+/=-]{32,}`, '[opaque value]'],
];

export function redactUvDiagnosticLine(value) {
  if (typeof value !== 'string') return null;
  if (value.length > 8192) return '[oversized installer line omitted]';
  let line = value;
  for (const [pattern, replacement] of UV_EXCERPT_REDACTIONS) line = line.replace(new RegExp(pattern, 'gi'), replacement);
  return line.trim().slice(0, UV_EXCERPT_CHARS) || null;
}

const psLiteral = value => `'${String(value).replaceAll("'", "''")}'`;
function stageDiagnosticScript(invocation, receiptPath, stage) {
  assert.equal(invocation.command, 'powershell.exe');
  assert.equal(invocation.args[invocation.args.indexOf('-Stage') + 1], stage);
  const patterns = Object.entries(stage === 'uv' ? UV_DIAGNOSTIC_SIGNALS : REPOSITORY_DIAGNOSTIC_SIGNALS)
    .map(([key, value]) => `  ${psLiteral(key)} = ${psLiteral(value)}`).join('\n');
  const redact = UV_EXCERPT_REDACTIONS.map(([pattern, replacement]) =>
    `  $line = [regex]::Replace($line, ${psLiteral(pattern)}, ${psLiteral(replacement)}, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)`).join('\n');
  return `# Disposable ${stage} diagnostic only. Raw child output is consumed, never written.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$script:signals = [System.Collections.Generic.HashSet[string]]::new()
$script:installerLines = [System.Collections.Generic.HashSet[int]]::new()
$script:protocolSeen = $false
$script:protocolOk = $false
$script:protocolSkipped = $false
$script:protocolReason = $null
$script:observedLines = 0
$script:longLineSeen = $false
$script:uvTailRemaining = 0
$script:failureExcerpt = [System.Collections.Generic.List[string]]::new()
$patterns = @{
${patterns}
}
function Protect-UvLine([string]$line) {
  if ($line.Length -gt 8192) { return '[oversized installer line omitted]' }
${redact}
  $line = $line.Trim()
  if ($line.Length -gt ${UV_EXCERPT_CHARS}) { $line = $line.Substring(0, ${UV_EXCERPT_CHARS}) }
  return $line
}
function Observe-UvOutput($item) {
  $script:observedLines++
  $text = [string]$item
  # The pinned installer emits its captured download failures here. Retain
  # this bounded tail and direct uv errors, not unrelated installer output.
  $capture = $false
  ${stage === 'repository' ? "$capture = $text -match '^\\s*(?:fatal:|error:|warning:|remote:\\s*(?:fatal:|error:)|ssh:|\\[X\\])'" : `if ($text -match '^->\\s+uv installer output \\(last 15 lines\\):') { $script:uvTailRemaining = 15 }
  elseif ($text -match '^(?:->\\s+Install manually:|\\s*\\{)') { $script:uvTailRemaining = 0 }
  elseif ($script:uvTailRemaining -gt 0) { $script:uvTailRemaining--; $capture = $true }
  elseif ($text -match '^\\[X\\]\\s+(?:uv installed but not found|Failed to install uv:)') { $capture = $true }`}
  if ($capture) {
    $safe = Protect-UvLine $text
    if ($safe) { $script:failureExcerpt.Add($safe) }
    while ($script:failureExcerpt.Count -gt ${UV_EXCERPT_LINES}) { $script:failureExcerpt.RemoveAt(0) }
  }
  if ($text.Length -gt 32768) { $script:longLineSeen = $true; $text = $text.Substring(0, 32768) }
  foreach ($key in $patterns.Keys) {
    if ($text -match $patterns[$key]) { $null = $script:signals.Add($key) }
  }
  if ($text -match '(?:^|[\\\\/])install\\.ps1:([0-9]{1,5})\\s+char:') {
    $null = $script:installerLines.Add([int]$Matches[1])
  }
  try {
    $frame = ConvertFrom-Json -InputObject $text -ErrorAction Stop
    if ($frame.stage -is [string] -and $frame.stage -ceq '${stage}' -and $frame.ok -is [bool]) {
      $script:protocolSeen = $true
      $script:protocolOk = $frame.ok
      $script:protocolSkipped = ($frame.skipped -is [bool] -and $frame.skipped -eq $true)
      if ($frame.reason -is [string]) { $script:protocolReason = Protect-UvLine $frame.reason }
    }
  } catch { }
}
$argv = @(${invocation.args.map(psLiteral).join(', ')})
$code = 1
try {
  & ${psLiteral(invocation.command)} @argv 2>&1 | ForEach-Object { Observe-UvOutput $_ }
  if ($null -ne $LASTEXITCODE) { $code = [int]$LASTEXITCODE }
} catch { Observe-UvOutput $_ }
finally {
  $result = @{
    schema = 1; stage = '${stage}'; exitCode = $code
    signals = @($script:signals | Sort-Object)
    installerLines = @($script:installerLines | Sort-Object | Select-Object -First 20)
    protocolSeen = $script:protocolSeen; protocolOk = $script:protocolOk
    protocolSkipped = $script:protocolSkipped
    observedLines = $script:observedLines; longLineSeen = $script:longLineSeen
    failureExcerpt = @($script:failureExcerpt)
    ${stage === 'repository' ? 'protocolReason = $script:protocolReason' : ''}
  }
  [System.IO.File]::WriteAllText(${psLiteral(receiptPath)}, ($result | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
}
exit $code
`;
}

export const uvDiagnosticScript = (invocation, receiptPath) => stageDiagnosticScript(invocation, receiptPath, 'uv');
export const repositoryDiagnosticScript = (invocation, receiptPath) => stageDiagnosticScript(invocation, receiptPath, 'repository');

function sanitizeStageDiagnostic(value, stage, allowedSignals) {
  assert.ok(value && value.schema === 1 && value.stage === stage, 'Invalid installer diagnostic protocol.');
  assert.ok(Number.isInteger(value.exitCode), 'Missing installer diagnostic exit status.');
  return {
    exitCode: value.exitCode,
    signals: [...new Set((Array.isArray(value.signals) ? value.signals : [])
      .filter(signal => typeof signal === 'string' && Object.hasOwn(allowedSignals, signal)))].sort(),
    installerLines: [...new Set((Array.isArray(value.installerLines) ? value.installerLines : [])
      .filter(line => Number.isInteger(line) && line > 0 && line < 100_000))].sort((a, b) => a - b).slice(0, 20),
    protocolSeen: value.protocolSeen === true, protocolOk: value.protocolOk === true,
    protocolSkipped: value.protocolSkipped === true,
    observedLines: Number.isSafeInteger(value.observedLines) && value.observedLines >= 0 ? value.observedLines : null,
    longLineSeen: value.longLineSeen === true,
    failureExcerpt: (Array.isArray(value.failureExcerpt) ? value.failureExcerpt : [])
      .slice(-UV_EXCERPT_LINES).map(redactUvDiagnosticLine).filter(line => line !== null),
  };
}

export const sanitizeUvDiagnostic = value => sanitizeStageDiagnostic(value, 'uv', UV_DIAGNOSTIC_SIGNALS);
export function sanitizeRepositoryDiagnostic(value) {
  const safe = sanitizeStageDiagnostic(value, 'repository', REPOSITORY_DIAGNOSTIC_SIGNALS);
  for (const field of ['protocolSeen', 'protocolOk', 'protocolSkipped']) assert.equal(typeof value[field], 'boolean', 'Invalid repository protocol flag.');
  return { ...safe, protocolReason: redactUvDiagnosticLine(value.protocolReason) };
}

/** The first attempt is the untouched production runner. Only a failed uv
 * stage gets one replay, while runWorkerBootstrap still holds its SQLite lock.
 * The replay also uses runBootstrapStage for environment, PID and cancellation
 * handling. It can never turn the original failed setup into a passing proof. */
export function withUvFailureDiagnostic({ runStage, childRunning, installerSha256, scratch, report }) {
  return async (invocation, home, signal, recordHome) => {
    try {
      return await runStage(invocation, home, signal, recordHome);
    } catch (originalError) {
      const stage = invocation.args[invocation.args.indexOf('-Stage') + 1];
      if (invocation.command !== 'powershell.exe' || stage !== 'uv') throw originalError;
      const diagnostic = { attempted: false, stage: 'uv', timeoutMs: UV_DIAGNOSTIC_TIMEOUT_MS,
        originalSetupStillFailed: true, installerSha256 };
      try {
        if (signal.aborted) diagnostic.blocked = 'setup-cancelled';
        else if (childRunning(recordHome ?? home)) diagnostic.blocked = 'previous-child-still-running';
        else {
          const source = invocation.args[invocation.args.indexOf('-File') + 1];
          assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'), installerSha256);
          const folder = mkdtempSync(join(scratch, 'uv-diagnostic-'));
          const script = join(folder, 'observe-uv.ps1');
          const resultPath = join(folder, 'fixed-signals.json');
          // BOM preserves literal Unicode paths under Windows PowerShell 5.1.
          writeFileSync(script, '\ufeff' + uvDiagnosticScript(invocation, resultPath), { flag: 'wx' });
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), UV_DIAGNOSTIC_TIMEOUT_MS);
          diagnostic.attempted = true;
          try {
            await runStage({ command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script] },
              home, AbortSignal.any([signal, controller.signal]), recordHome);
          } catch {
            diagnostic.runnerFailed = true;
          } finally {
            clearTimeout(timer);
            diagnostic.timedOut = controller.signal.aborted;
          }
          if (existsSync(resultPath)) {
            assert.ok(statSync(resultPath).size <= 16_384, 'Diagnostic protocol exceeded its bound.');
            Object.assign(diagnostic, sanitizeUvDiagnostic(JSON.parse(readFileSync(resultPath, 'utf8'))));
          } else diagnostic.protocolMissing = true;
          diagnostic.childStillRunning = childRunning(recordHome ?? home);
        }
      } catch {
        diagnostic.collectionFailed = true;
      }
      report(diagnostic);
      throw originalError;
    }
  };
}

/** Observe the original repository attempt once. Replaying this stage could
 * update or replace its partial checkout and hide the cause of the failure. */
export function withRepositoryDiagnostic({ runStage, childRunning, installerSha256, scratch, report }) {
  return async (invocation, home, signal, recordHome) => {
    const stage = invocation.args[invocation.args.indexOf('-Stage') + 1];
    if (invocation.command !== 'powershell.exe' || stage !== 'repository') return runStage(invocation, home, signal, recordHome);
    signal.throwIfAborted();
    assert.equal(childRunning(recordHome ?? home), false, 'An earlier managed setup process is still running.');
    const source = invocation.args[invocation.args.indexOf('-File') + 1];
    assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'), installerSha256);
    const folder = mkdtempSync(join(scratch, 'repository-diagnostic-'));
    const script = join(folder, 'observe-repository.ps1');
    const resultPath = join(folder, 'fixed-signals.json');
    writeFileSync(script, '\ufeff' + repositoryDiagnosticScript(invocation, resultPath), { flag: 'wx' });
    const diagnostic = { stage: 'repository', observedOriginalAttempt: true, attemptCount: 1,
      replayed: false, installerSha256 };
    let result, failure, failed = false;
    try {
      result = await runStage({ command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script] },
        home, signal, recordHome);
    } catch (error) {
      failed = true; failure = error;
    }
    diagnostic.originalStageFailed = failed;
    try {
      assert.ok(statSync(resultPath).size <= 16_384, 'Diagnostic protocol exceeded its bound.');
      Object.assign(diagnostic, sanitizeRepositoryDiagnostic(JSON.parse(readFileSync(resultPath, 'utf8'))));
    } catch {
      diagnostic.collectionFailed = true;
    }
    try { diagnostic.childStillRunning = childRunning(recordHome ?? home); }
    catch { diagnostic.collectionFailed = true; }
    try { report(diagnostic); }
    catch { diagnostic.collectionFailed = true; }
    // Collection/reporting failures must never replace the original failure.
    if (failed) throw failure;
    assert.ok(!diagnostic.collectionFailed && diagnostic.exitCode === 0 && diagnostic.protocolSeen === true
      && diagnostic.protocolOk === true && diagnostic.protocolSkipped === false && diagnostic.childStillRunning === false,
    'The repository observation could not confirm successful completion.');
    return result;
  };
}

export async function main() {

  assert.equal(process.platform, 'win32', 'Use a disposable native Windows runner.');
  assert.equal(process.arch, 'x64');
  assert.equal(process.env.CI, 'true');
  assert.ok(!process.env.VITEST, 'This CI proof requires the real production installer.');
  assert.ok(process.env.RUNNER_TEMP && isAbsolute(process.env.RUNNER_TEMP));
  assert.match(process.env.REALBUD_BUILD_SHA ?? '', /^[a-f0-9]{40}$/);
  assert.ok(process.argv[2], 'Supply a fresh output receipt filename.');
  const receiptPath = resolve(process.argv[2]);
  assert.ok(!existsSync(receiptPath), 'Refusing to replace a prior runtime receipt.');
  mkdirSync(dirname(receiptPath), { recursive: true });

  const { runWorkerBootstrap, runBootstrapStage, finishWorkerBootstrap, bootstrapChildRunning } = await import('../../server/worker-bootstrap.ts');
  const { HERMES_RELEASES } = await import('../../server/hermes-releases.ts');
  const { MEMORY_REVIEW_RUNTIME, MEMORY_REVIEW_NATIVE_FILES } = await import('../../server/hermes-memory-review.ts');
  const release = HERMES_RELEASES.find(item => item.commit === MEMORY_REVIEW_RUNTIME);
  assert.ok(release, 'The memory runtime must be in the reviewed install catalog.');
  const scratch = mkdtempSync(join(process.env.RUNNER_TEMP, 'RealBud native memory '));
  const runtimeHome = join(scratch, release.commit);
  const runtimeDirectory = join(runtimeHome, 'hermes-agent');
  const python = join(runtimeDirectory, 'venv', 'Scripts', 'python.exe');
  const controller = new AbortController();
  const started = Date.now();
  const stages = [];
  const receipt = {
    schema: 1, kind: 'realbud-managed-windows-runtime-proof',
    sourceRevision: process.env.REALBUD_BUILD_SHA, generatedAt: new Date().toISOString(),
    platform: process.platform, arch: process.arch, passed: false,
    runtimeCommit: release.commit, installerSha256: release.installers.windows,
    runtimeDirectory, stages,
    limits: ['Disposable CI runtime setup only; no GUI, account, model request or customer device proof.',
      'A failed uv stage may be replayed once for fixed signals and at most 15 redacted failure lines of 240 characters; its original failure remains authoritative. No raw installer output is retained.',
      'The original repository attempt is observed once, without replay, through the production stage runner. Only fixed milestones, a redacted protocol reason and at most 15 redacted failure lines of 240 characters are retained.'],
  };
  const persist = () => {
    receipt.elapsedMs = Date.now() - started;
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  };
  persist();
  const timer = setTimeout(() => {
    receipt.error = 'Managed setup exceeded twenty minutes; cleanup requested.';
    persist();
    controller.abort();
  }, 20 * 60_000);
  try {
    await runWorkerBootstrap({
      home: runtimeHome, privateRuntime: true, release, signal: controller.signal,
      execute: withUvFailureDiagnostic({ runStage: withRepositoryDiagnostic({
        runStage: runBootstrapStage, childRunning: bootstrapChildRunning, installerSha256: release.installers.windows, scratch,
        report(diagnostic) { receipt.repositoryDiagnostic = diagnostic; persist(); },
      }), childRunning: bootstrapChildRunning,
        installerSha256: release.installers.windows, scratch,
        report(diagnostic) { receipt.uvDiagnostic = diagnostic; persist(); },
      }),
      progress(detail, step, total) {
        stages.push({ detail, step, total, elapsedMs: Date.now() - started });
        persist();
        console.log(`${step}/${total}: ${detail}`);
      },
      async finalize() {
        const commit = execFileSync('git', ['-C', runtimeDirectory, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 15_000, windowsHide: true }).trim();
        assert.equal(commit, release.commit, 'Installed runtime revision does not match admission.');
        for (const [file, expected] of Object.entries(MEMORY_REVIEW_NATIVE_FILES)) {
          assert.equal(createHash('sha256').update(readFileSync(join(runtimeDirectory, file))).digest('hex'), expected, `Runtime integrity mismatch: ${file}`);
        }
        assert.ok(existsSync(python), 'Managed Windows Python is missing.');
        receipt.pythonVersion = execFileSync(python, ['--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true }).trim();
        assert.match(receipt.pythonVersion, /^Python 3\.\d+\.\d+$/);
        finishWorkerBootstrap(runtimeHome);
      },
    });
    assert.equal(bootstrapChildRunning(runtimeHome), false, 'A managed setup process remains alive.');
    receipt.passed = true;
  } catch (error) {
    // No raw installer output is retained. These messages come from the owned
    // bootstrap boundary or assertions; diagnostic observers contribute only
    // fixed signals, protocol fields and bounded redacted failure details.
    receipt.error = error instanceof Error ? error.message : 'Managed setup failed.';
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    persist();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
