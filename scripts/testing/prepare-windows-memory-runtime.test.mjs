// Control-flow tests only. No managed install, uv download or runtime is run.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sanitizeUvDiagnostic, uvDiagnosticScript, withUvFailureDiagnostic } from './prepare-windows-memory-runtime.mjs';

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
