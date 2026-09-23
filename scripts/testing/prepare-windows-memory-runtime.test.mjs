// Control-flow tests only. No managed install, uv download or runtime is run.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { redactUvDiagnosticLine, sanitizeUvDiagnostic, uvDiagnosticScript, withUvFailureDiagnostic } from './prepare-windows-memory-runtime.mjs';

function fixture(t) {
  const scratch = mkdtempSync(join(tmpdir(), 'fictional-uv-controls-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const file = join(scratch, "fictional install's.ps1");
  const bytes = Buffer.from('# fictional control fixture; never executed\n');
  writeFileSync(file, bytes);
  const invocation = { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file,
    '-Stage', 'uv', '-NonInteractive', '-SkipSetup', '-SkipComputerUse', '-Commit', 'a'.repeat(40), '-ForceCommit',
    '-HermesHome', scratch, '-InstallDir', join(scratch, 'hermes-agent')] };
  return { scratch, invocation, installerSha256: createHash('sha256').update(bytes).digest('hex') };
}

test('a successful attempt delegates the exact original invocation without replay', async t => {
  const input = fixture(t), calls = [], reports = [], signal = new AbortController().signal;
  const execute = withUvFailureDiagnostic({ ...input, childRunning: () => false, report: value => reports.push(value),
    runStage: async (...args) => { calls.push(args); return 'fixture result'; } });
  assert.equal(await execute(input.invocation, input.scratch, signal, 'fictional-record-home'), 'fixture result');
  assert.deepEqual(calls, [[input.invocation, input.scratch, signal, 'fictional-record-home']]);
  assert.deepEqual(reports, []);
});

test('one successful diagnostic replay never converts the original failure into a pass', async t => {
  const input = fixture(t), calls = [], reports = [], signal = new AbortController().signal;
  const original = new Error('fictional original failure');
  const execute = withUvFailureDiagnostic({ ...input, childRunning: () => false, report: value => reports.push(value),
    runStage: async (...args) => {
      calls.push(args);
      if (calls.length === 1) throw original;
      const script = args[0].args[args[0].args.indexOf('-File') + 1];
      assert.ok(existsSync(script));
      const resultPath = join(script, '..', 'fixed-signals.json');
      writeFileSync(resultPath, JSON.stringify({ schema: 1, stage: 'uv', exitCode: 0, signals: ['uv-managed-ready'],
        protocolSeen: true, protocolOk: true, protocolSkipped: false, observedLines: 3 }));
    } });
  await assert.rejects(execute(input.invocation, input.scratch, signal), error => error === original);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1], input.scratch);
  assert.ok(calls[1][2] instanceof AbortSignal);
  assert.equal(reports[0].originalSetupStillFailed, true);
  assert.equal(reports[0].attempted, true);
  assert.equal(reports[0].exitCode, 0);
  assert.deepEqual(reports[0].signals, ['uv-managed-ready']);
  assert.equal(reports[0].childStillRunning, false);
});

test('a diagnostic replay failure still preserves the original error', async t => {
  const input = fixture(t), reports = [];
  const original = new Error('fictional original failure');
  let calls = 0;
  const execute = withUvFailureDiagnostic({ ...input, childRunning: () => false, report: value => reports.push(value),
    runStage: async () => { throw ++calls === 1 ? original : new Error('fictional replay failure'); } });
  await assert.rejects(execute(input.invocation, input.scratch, new AbortController().signal), error => error === original);
  assert.equal(calls, 2);
  assert.equal(reports[0].runnerFailed, true);
  assert.equal(reports[0].protocolMissing, true);
});

test('non-uv failures are never replayed', async t => {
  const input = fixture(t), reports = [];
  input.invocation.args[input.invocation.args.indexOf('-Stage') + 1] = 'repository';
  const original = new Error('fictional failure');
  let calls = 0;
  const execute = withUvFailureDiagnostic({ ...input, childRunning: () => false, report: value => reports.push(value),
    runStage: async () => { calls++; throw original; } });
  await assert.rejects(execute(input.invocation, input.scratch, new AbortController().signal), error => error === original);
  assert.equal(calls, 1);
  assert.deepEqual(reports, []);
});

test('cancellation and a living recorded child prevent replay', async t => {
  const input = fixture(t);
  for (const blocked of ['setup-cancelled', 'previous-child-still-running']) {
    const abort = new AbortController(), reports = [];
    if (blocked === 'setup-cancelled') abort.abort();
    let calls = 0;
    const execute = withUvFailureDiagnostic({ ...input, childRunning: () => true, report: value => reports.push(value),
      runStage: async () => { calls++; throw new Error('fictional failure'); } });
    await assert.rejects(execute(input.invocation, input.scratch, abort.signal));
    assert.equal(calls, 1);
    assert.equal(reports[0].attempted, false);
    assert.equal(reports[0].blocked, blocked);
  }
});

test('changed installer bytes prevent the diagnostic invocation', async t => {
  const input = fixture(t), reports = [];
  let calls = 0;
  const execute = withUvFailureDiagnostic({ ...input, installerSha256: 'b'.repeat(64), childRunning: () => false,
    report: value => reports.push(value), runStage: async () => { calls++; throw new Error('fictional failure'); } });
  await assert.rejects(execute(input.invocation, input.scratch, new AbortController().signal));
  assert.equal(calls, 1);
  assert.equal(reports[0].attempted, false);
  assert.equal(reports[0].collectionFailed, true);
});

test('only fixed signals and typed protocol fields survive receipt sanitization', () => {
  const value = sanitizeUvDiagnostic({ schema: 1, stage: 'uv', exitCode: 1, reason: 'fictional-secret-value',
    signals: ['network-tls', 'fictional-secret-value', 'network-tls', { token: 'fictional-secret-value' }],
    installerLines: [123, 'fictional-secret-value', 123, -1, 234],
    protocolSeen: true, protocolOk: 'fictional-secret-value', observedLines: 'fictional-secret-value',
    environment: { API_KEY: 'fictional-secret-value' } });
  assert.deepEqual(value.signals, ['network-tls']);
  assert.deepEqual(value.installerLines, [123, 234]);
  assert.equal(value.protocolSeen, true);
  assert.equal(value.protocolOk, false);
  assert.equal(value.observedLines, null);
  assert.ok(!JSON.stringify(value).includes('fictional-secret-value'));
  assert.throws(() => sanitizeUvDiagnostic({ schema: 1, stage: 'repository', exitCode: 0 }));
});

const failureLines = [
  '->   --- uv installer source: fictional example ---',
  '->   ERROR: OPENAI_API_KEY=fictional-provider-value',
  '->   ERROR: https://fixture-user:fixture-pass@example.invalid/install?token=fixture-query',
  '->   ERROR: "C:\\Users\\Fictional Person\\bin\\uv.exe" is unavailable',
  '->   ERROR: \\\\fictional-server\\private-share\\uv.exe is unavailable',
  '->   ERROR: Bearer fictional-bearer-value',
  '->   ERROR: /Users/Fictional-Person/private/uv is unavailable',
  '->   ERROR: sk-fictionalProviderKeyValue123456',
  '->   ERROR: fixture-person@example.invalid',
  '->   ERROR: abcdef0123456789abcdef0123456789abcdef0123456789',
  '->   ERROR: unsupported archive format',
  '->   --- uv installer source: fictional mirror ---',
  '->   ERROR: checksum mismatch',
  '->   ERROR: native installer exit 23',
  '->   ERROR: fictional final detail must be retained',
];
const forbiddenExcerptBytes = ['fictional-provider-value', 'fixture-user', 'fixture-pass', 'fixture-query',
  'C:\\Users', 'Fictional Person', 'fictional-server', 'private-share', 'fictional-bearer-value',
  '/Users/Fictional-Person', 'sk-fictionalProviderKeyValue123456', 'fixture-person@example.invalid',
  'abcdef0123456789abcdef0123456789abcdef0123456789', 'https://'];

test('failure text is redacted before truncation and bounded at the Node receipt boundary', () => {
  const safe = failureLines.map(redactUvDiagnosticLine);
  const serialized = JSON.stringify(safe);
  for (const forbidden of forbiddenExcerptBytes) assert.ok(!serialized.includes(forbidden), forbidden);
  assert.ok(serialized.includes('unsupported archive format'));
  assert.ok(!redactUvDiagnosticLine("ERROR: C:\\Users\\O'Connor\\bin\\uv.exe").includes('Connor'));
  assert.ok(!redactUvDiagnosticLine('ERROR: \u001b[31msk-fictionalProviderKeyValue123456\u001b[0m').includes('fictionalProvider'));
  assert.equal(redactUvDiagnosticLine('ERROR: SOME_PROVIDER_KEY=short-value'), 'ERROR: [credential field redacted]');
  assert.equal(redactUvDiagnosticLine('ERROR: --api-key short-value'), 'ERROR: [credential argument redacted]');
  assert.equal(redactUvDiagnosticLine({ text: 'untrusted object' }), null);
  assert.equal(redactUvDiagnosticLine('x'.repeat(8193)), '[oversized installer line omitted]');
  const value = sanitizeUvDiagnostic({ schema: 1, stage: 'uv', exitCode: 1,
    failureExcerpt: [null, {}, 'discarded first line', ...failureLines] });
  assert.equal(value.failureExcerpt.length, 15);
  assert.ok(value.failureExcerpt.every(line => line.length <= 240));
  for (const forbidden of forbiddenExcerptBytes) assert.ok(!JSON.stringify(value).includes(forbidden), forbidden);
  assert.ok(value.failureExcerpt.at(-1).includes('fictional final detail'));
  assert.deepEqual(sanitizeUvDiagnostic({ schema: 1, stage: 'uv', exitCode: 1, failureExcerpt: [null, {}, 123] }).failureExcerpt, []);
});

test('the observer uses literal argv and does not persist raw child text', t => {
  const { invocation, scratch } = fixture(t);
  const script = uvDiagnosticScript(invocation, join(scratch, "fictional receipt's.json"));
  assert.ok(script.includes("fictional install''s.ps1"));
  assert.ok(script.includes("fictional receipt''s.json"));
  assert.ok(script.includes("& 'powershell.exe' @argv 2>&1"));
  assert.ok(script.includes("[System.IO.File]::WriteAllText"));
  assert.ok(!script.includes('Invoke-Expression'));
  assert.ok(!script.includes('WriteAllText($text'));
});

test('Windows PowerShell parses the generated observer without running it', { skip: process.platform !== 'win32' }, t => {
  const { invocation, scratch } = fixture(t);
  const path = join(scratch, 'observer.ps1');
  writeFileSync(path, '\ufeff' + uvDiagnosticScript(invocation, join(scratch, 'fixed-signals.json')));
  const command = "$tokens=$null; $errors=$null; $null=[System.Management.Automation.Language.Parser]::ParseFile($env:REALBUD_UV_OBSERVER_FIXTURE,[ref]$tokens,[ref]$errors); if($errors.Count -ne 0){exit 1}";
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    env: { ...process.env, REALBUD_UV_OBSERVER_FIXTURE: path }, timeout: 30_000, windowsHide: true, stdio: 'ignore',
  });
  assert.ok(!existsSync(join(scratch, 'fixed-signals.json')), 'Parser control must not execute the observer.');
});

test('native observer writes only a redacted failure tail and preserves nonzero exit', { skip: process.platform !== 'win32' }, t => {
  const { scratch } = fixture(t);
  const installer = join(scratch, 'install.ps1'), observer = join(scratch, 'observer.ps1');
  const resultPath = join(scratch, 'fixed-signals.json');
  const lines = ['unrelated pre-stage output must not be retained', '[X] uv installed but not found at C:\\Users\\Fictional Person\\uv.exe',
    '-> uv installer output (last 15 lines):', ...failureLines, '-> Install manually: https://example.invalid/private?token=fixture-query',
    'unrelated final output must not be retained', '{"stage":"uv","ok":false,"skipped":false}'];
  const fixtureScript = "param([string]$Stage)\n" + lines.map(line => "Write-Output '" + line.replaceAll("'", "''") + "'").join('\n') + '\nexit 1\n';
  writeFileSync(installer, '\ufeff' + fixtureScript);
  const invocation = { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', installer, '-Stage', 'uv'] };
  writeFileSync(observer, '\ufeff' + uvDiagnosticScript(invocation, resultPath));
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', observer],
    { timeout: 30_000, windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 1, 'Observer must preserve the fictional installer failure.');
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  // Inspect bytes BEFORE Node sanitization to prove masking preceded file I/O.
  const saved = readFileSync(resultPath, 'utf8');
  for (const forbidden of forbiddenExcerptBytes) assert.ok(!saved.includes(forbidden), forbidden);
  assert.ok(!saved.includes('unrelated'));
  const value = JSON.parse(saved);
  assert.equal(value.exitCode, 1);
  assert.equal(value.protocolSeen, true);
  assert.equal(value.protocolOk, false);
  assert.equal(value.failureExcerpt.length, 15);
  assert.ok(value.failureExcerpt.at(-1).includes('fictional final detail'));
  assert.deepEqual(value.failureExcerpt, sanitizeUvDiagnostic(value).failureExcerpt);
});
