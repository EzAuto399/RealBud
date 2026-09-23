// Disposable CI proof of the production-managed installer, without account or
// model setup. The native journal harness consumes this exact runtime next.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// These are observations, not automatic root-cause diagnoses. Never retain an
// upstream message, URL, path, environment value, or exception in the receipt.
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

const psLiteral = value => `'${String(value).replaceAll("'", "''")}'`;
export function uvDiagnosticScript(invocation, receiptPath) {
  assert.equal(invocation.command, 'powershell.exe');
  assert.equal(invocation.args[invocation.args.indexOf('-Stage') + 1], 'uv');
  const patterns = Object.entries(UV_DIAGNOSTIC_SIGNALS)
    .map(([key, value]) => `  ${psLiteral(key)} = ${psLiteral(value)}`).join('\n');
  return `# Disposable uv diagnostic only. Raw child output is consumed, never written.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$script:signals = [System.Collections.Generic.HashSet[string]]::new()
$script:installerLines = [System.Collections.Generic.HashSet[int]]::new()
$script:protocolSeen = $false
$script:protocolOk = $false
$script:protocolSkipped = $false
$script:observedLines = 0
$script:longLineSeen = $false
$patterns = @{
${patterns}
}
function Observe-UvOutput($item) {
  $script:observedLines++
  $text = [string]$item
  if ($text.Length -gt 32768) { $script:longLineSeen = $true; $text = $text.Substring(0, 32768) }
  foreach ($key in $patterns.Keys) {
    if ($text -match $patterns[$key]) { $null = $script:signals.Add($key) }
  }
  if ($text -match '(?:^|[\\\\/])install\\.ps1:([0-9]{1,5})\\s+char:') {
    $null = $script:installerLines.Add([int]$Matches[1])
  }
  try {
    $frame = ConvertFrom-Json -InputObject $text -ErrorAction Stop
    if ($frame.stage -eq 'uv' -and $frame.ok -is [bool]) {
      $script:protocolSeen = $true
      $script:protocolOk = $frame.ok
      $script:protocolSkipped = ($frame.skipped -eq $true)
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
    schema = 1; stage = 'uv'; exitCode = $code
    signals = @($script:signals | Sort-Object)
    installerLines = @($script:installerLines | Sort-Object | Select-Object -First 20)
    protocolSeen = $script:protocolSeen; protocolOk = $script:protocolOk
    protocolSkipped = $script:protocolSkipped
    observedLines = $script:observedLines; longLineSeen = $script:longLineSeen
  }
  [System.IO.File]::WriteAllText(${psLiteral(receiptPath)}, ($result | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
}
exit $code
`;
}

export function sanitizeUvDiagnostic(value) {
  assert.ok(value && value.schema === 1 && value.stage === 'uv', 'Invalid uv diagnostic protocol.');
  assert.ok(Number.isInteger(value.exitCode), 'Missing uv diagnostic exit status.');
  return {
    exitCode: value.exitCode,
    signals: [...new Set((Array.isArray(value.signals) ? value.signals : [])
      .filter(signal => typeof signal === 'string' && Object.hasOwn(UV_DIAGNOSTIC_SIGNALS, signal)))].sort(),
    installerLines: [...new Set((Array.isArray(value.installerLines) ? value.installerLines : [])
      .filter(line => Number.isInteger(line) && line > 0 && line < 100_000))].sort((a, b) => a - b).slice(0, 20),
    protocolSeen: value.protocolSeen === true, protocolOk: value.protocolOk === true,
    protocolSkipped: value.protocolSkipped === true,
    observedLines: Number.isSafeInteger(value.observedLines) && value.observedLines >= 0 ? value.observedLines : null,
    longLineSeen: value.longLineSeen === true,
  };
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
      'A failed uv stage may be replayed once for fixed diagnostic signals; its original failure remains authoritative. No raw installer output is retained.'],
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
      execute: withUvFailureDiagnostic({ runStage: runBootstrapStage, childRunning: bootstrapChildRunning,
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
    // bootstrap boundary or assertions; the optional replay contributes only
    // the fixed signals and protocol fields above.
    receipt.error = error instanceof Error ? error.message : 'Managed setup failed.';
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    persist();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
