// Control-flow tests only. No managed install, uv download or runtime is run.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { redactUvDiagnosticLine, repositoryDiagnosticScript, sanitizeRepositoryDiagnostic, sanitizeUvDiagnostic,
  uvDiagnosticScript, withDownloadDiagnostic, withRepositoryDiagnostic, withUvFailureDiagnostic } from './prepare-windows-memory-runtime.mjs';

test('download observation preserves exact request options and returns the same unread response without private data', async () => {
  const privateValue = 'fictional-secret-8123';
  const input = new URL(`https://fictional.invalid/setup?token=${privateValue}`);
  const options = Object.freeze({ signal: new AbortController().signal, redirect: 'error',
    headers: Object.freeze({ authorization: `Bearer ${privateValue}` }) });
  const response = new Response(`fictional installer ${privateValue}`, { headers: { 'set-cookie': privateValue } });
  const calls = [], reports = [];
  const request = withDownloadDiagnostic({ request: async (...args) => { calls.push(args); return response; }, report: value => reports.push(value) });
  const result = await request(input, options);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], input);
  assert.equal(calls[0][1], options);
  assert.equal(result, response);
  assert.equal(response.bodyUsed, false);
  assert.equal(response.body.locked, false);
  assert.deepEqual(reports, [{ status: 200, ok: true, bodyPresent: true }]);
  assert.ok(!JSON.stringify(reports).includes(privateValue));
  assert.equal(await result.text(), `fictional installer ${privateValue}`);
});

test('non-success and bodyless download responses pass through once without consuming or replacing them', async () => {
  for (const response of [new Response('fictional rejection', { status: 429 }), new Response(null, { status: 204 }), new Response(null)]) {
    let calls = 0;
    const reports = [];
    const request = withDownloadDiagnostic({ request: async () => { calls++; return response; }, report: value => reports.push(value) });
    assert.equal(await request('https://fictional.invalid/setup'), response);
    assert.equal(calls, 1);
    assert.equal(response.bodyUsed, false);
    assert.deepEqual(reports, [{ status: response.status, ok: response.ok, bodyPresent: response.body !== null }]);
  }
});

test('download throws retain their identity and record only a fixed classification without retry', async () => {
  const privateValue = 'fictional-private C:\\Users\\fictional-person token=fictional-token-8123 https://fictional.invalid/?secret=fictional-query';
  for (const [original, classification] of [
    [new TypeError(privateValue, { cause: new Error(privateValue) }), 'fetch-failed'],
    [new DOMException(privateValue, 'TimeoutError'), 'timeout'],
    [new DOMException(privateValue, 'AbortError'), 'aborted'],
    [Object.assign(new Error(privateValue), { name: privateValue }), 'request-failed'],
    [privateValue, 'request-failed'],
  ]) {
    let calls = 0;
    const reports = [];
    const request = withDownloadDiagnostic({ request: () => { calls++; throw original; }, report: value => reports.push(value) });
    await assert.rejects(request('https://fictional.invalid/setup'), error => error === original);
    assert.equal(calls, 1);
    assert.deepEqual(reports, [{ transportFailure: classification }]);
    for (const value of ['fictional-private', 'fictional-person', 'fictional-token-8123', 'fictional.invalid', 'fictional-query']) {
      assert.ok(!JSON.stringify(reports).includes(value));
    }
  }
});

test('an already aborted native fetch retains the original signal and rejection without contacting a service', async () => {
  const abort = new AbortController(), original = new Error('fictional abort reason');
  abort.abort(original);
  const options = Object.freeze({ signal: abort.signal, redirect: 'error' }), reports = [];
  let calls = 0;
  const request = withDownloadDiagnostic({ request: (input, actualOptions) => {
    calls++;
    assert.equal(actualOptions, options);
    return fetch(input, actualOptions);
  }, report: value => reports.push(value) });
  await assert.rejects(request('data:text/plain,fictional-local-only', options), error => error === original);
  assert.equal(calls, 1);
  assert.deepEqual(reports, [{ transportFailure: 'aborted' }]);
});

test('failed download diagnostic reporting cannot alter a response or replace the original rejection', async () => {
  const response = new Response('fictional installer'), original = new Error('fictional request failure');
  for (const fail of [false, true]) {
    let calls = 0;
    const request = withDownloadDiagnostic({ request: async () => { calls++; if (fail) throw original; return response; },
      report() { throw new Error('fictional receipt failure'); } });
    if (fail) await assert.rejects(request('fictional-input'), error => error === original);
    else {
      assert.equal(await request('fictional-input'), response);
      assert.equal(response.bodyUsed, false);
    }
    assert.equal(calls, 1);
  }
});

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

function repositoryFixture(t) {
  const input = fixture(t);
  input.invocation.args[input.invocation.args.indexOf('-Stage') + 1] = 'repository';
  return input;
}

function saveRepositoryObservation(invocation, fields = {}) {
  const observer = invocation.args[invocation.args.indexOf('-File') + 1];
  writeFileSync(join(observer, '..', 'fixed-signals.json'), JSON.stringify({
    schema: 1, stage: 'repository', exitCode: 0, protocolSeen: true, protocolOk: true, protocolSkipped: false, ...fields,
  }));
}

test('the original repository attempt runs once with its exact argv, environment owner and signal', async t => {
  const input = repositoryFixture(t), calls = [], reports = [], signal = new AbortController().signal;
  const execute = withRepositoryDiagnostic({ ...input, childRunning: () => false, report: value => reports.push(value),
    runStage: async (...args) => {
      calls.push(args);
      const observer = args[0].args[args[0].args.indexOf('-File') + 1];
      const script = readFileSync(observer, 'utf8');
      for (const arg of input.invocation.args) assert.ok(script.includes("'" + arg.replaceAll("'", "''") + "'"));
      saveRepositoryObservation(args[0]);
      return 'fictional original success';
    } });
  assert.equal(await execute(input.invocation, input.scratch, signal, 'fictional-record-home'), 'fictional original success');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(1), [input.scratch, signal, 'fictional-record-home']);
  assert.equal(reports[0].observedOriginalAttempt, true);
  assert.equal(reports[0].attemptCount, 1);
  assert.equal(reports[0].replayed, false);
  assert.equal(reports[0].originalStageFailed, false);
});

test('a repository failure remains the same failure and is never replayed by the uv decorator', async t => {
  const input = repositoryFixture(t), reports = [], uvReports = [];
  const original = new Error('fictional repository failure');
  let calls = 0;
  const repository = withRepositoryDiagnostic({ ...input, childRunning: () => false, report: value => reports.push(value),
    runStage: async invocation => {
      calls++;
      saveRepositoryObservation(invocation, { exitCode: 23, protocolOk: false, protocolReason: 'fatal: fictional checkout failed' });
      throw original;
    } });
  const execute = withUvFailureDiagnostic({ ...input, runStage: repository, childRunning: () => false, report: value => uvReports.push(value) });
  await assert.rejects(execute(input.invocation, input.scratch, new AbortController().signal), error => error === original);
  assert.equal(calls, 1);
  assert.equal(reports[0].exitCode, 23);
  assert.equal(reports[0].originalStageFailed, true);
  assert.equal(reports[0].protocolReason, 'fatal: fictional checkout failed');
  assert.deepEqual(uvReports, []);
});

test('missing diagnostics and a failed report cannot replace the original repository failure', async t => {
  const input = repositoryFixture(t), original = new Error('fictional repository failure');
  let calls = 0;
  const execute = withRepositoryDiagnostic({ ...input, childRunning: () => false,
    report() { throw new Error('fictional report failure'); }, runStage: async () => { calls++; throw original; } });
  await assert.rejects(execute(input.invocation, input.scratch, new AbortController().signal), error => error === original);
  assert.equal(calls, 1);
});

test('repository observation fails closed on missing, wrong-stage, unsuccessful or skipped protocol', async t => {
  const input = repositoryFixture(t);
  for (const fields of [null, { stage: 'uv' }, { protocolSeen: false }, { protocolOk: false }, { protocolOk: 'true' }, { protocolSkipped: true }, { protocolSkipped: 'true' }, { exitCode: 23 }]) {
    const execute = withRepositoryDiagnostic({ ...input, childRunning: () => false, report() {}, runStage: async invocation => {
      if (fields !== null) saveRepositoryObservation(invocation, fields);
    } });
    await assert.rejects(execute(input.invocation, input.scratch, new AbortController().signal), /could not confirm successful completion/);
  }
});

test('cancellation, live children and changed installer bytes prevent repository execution', async t => {
  const input = repositoryFixture(t);
  for (const blocked of ['cancelled', 'live-child', 'changed-bytes']) {
    const abort = new AbortController();
    if (blocked === 'cancelled') abort.abort();
    let calls = 0;
    const execute = withRepositoryDiagnostic({ ...input,
      installerSha256: blocked === 'changed-bytes' ? 'b'.repeat(64) : input.installerSha256,
      childRunning: () => blocked === 'live-child', report() {}, runStage: async () => { calls++; } });
    await assert.rejects(execute(input.invocation, input.scratch, abort.signal));
    assert.equal(calls, 0);
  }
});

test('non-repository stages delegate unchanged without observation', async t => {
  const input = fixture(t), calls = [], reports = [], signal = new AbortController().signal;
  const execute = withRepositoryDiagnostic({ ...input, childRunning: () => false, report: value => reports.push(value),
    runStage: async (...args) => { calls.push(args); return 'fictional uv result'; } });
  assert.equal(await execute(input.invocation, input.scratch, signal), 'fictional uv result');
  assert.deepEqual(calls, [[input.invocation, input.scratch, signal, undefined]]);
  assert.deepEqual(reports, []);
});

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

test('repository protocol reasons and failure excerpts are redacted again at the Node boundary', () => {
  for (const line of failureLines) {
    const value = sanitizeRepositoryDiagnostic({ schema: 1, stage: 'repository', exitCode: 23,
      protocolSeen: true, protocolOk: false, protocolSkipped: false, protocolReason: line,
      failureExcerpt: [line], signals: ['repository-pin', 'fictional-private-signal'] });
    for (const forbidden of forbiddenExcerptBytes) assert.ok(!JSON.stringify(value).includes(forbidden), forbidden);
    assert.ok(value.protocolReason.length <= 240);
    assert.deepEqual(value.signals, ['repository-pin']);
  }
  const value = { schema: 1, stage: 'repository', exitCode: 1, protocolSeen: true, protocolOk: false, protocolSkipped: false };
  for (const reason of [null, {}, 123, ['fictional-private-reason']]) assert.equal(sanitizeRepositoryDiagnostic({ ...value, protocolReason: reason }).protocolReason, null);
  assert.throws(() => sanitizeRepositoryDiagnostic({ ...value, stage: ['repository'] }));
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

test('native repository observer runs the exact original argv once and masks the saved failure', { skip: process.platform !== 'win32' }, t => {
  const { scratch, invocation } = repositoryFixture(t);
  const installer = invocation.args[invocation.args.indexOf('-File') + 1];
  const counter = join(scratch, 'fictional-attempt-count.txt'), observer = join(scratch, 'observer.ps1');
  const resultPath = join(scratch, 'fixed-signals.json');
  const psLiteral = value => "'" + value.replaceAll("'", "''") + "'";
  const lines = [
    'unrelated clone progress must not be retained', '-> Trying SSH clone...',
    '-> SSH failed, trying HTTPS...', '-> Pinning to commit ' + 'a'.repeat(40),
    ...failureLines.map(line => 'fatal: ' + line),
    JSON.stringify({ stage: 'repository', ok: false, skipped: false, reason: 'git checkout failed: OPENAI_API_KEY=fictional-provider-value' }),
    JSON.stringify({ stage: 'uv', ok: true, skipped: false, reason: 'foreign stage must not be retained' }),
    JSON.stringify({ stage: ['repository'], ok: true, skipped: false, reason: 'array stage must not be retained' }),
  ];
  writeFileSync(installer, '\ufeff' + `param([string]$Stage,[switch]$NonInteractive,[switch]$SkipSetup,[switch]$SkipComputerUse,[string]$Commit,[switch]$ForceCommit,[string]$HermesHome,[string]$InstallDir)
if($Stage -cne 'repository' -or $Commit -cne '${'a'.repeat(40)}' -or -not $NonInteractive -or -not $SkipSetup -or -not $SkipComputerUse -or -not $ForceCommit){exit 99}
if($HermesHome -cne ${psLiteral(scratch)} -or $InstallDir -cne ${psLiteral(join(scratch, 'hermes-agent'))}){exit 99}
[System.IO.File]::AppendAllText(${psLiteral(counter)}, '1')
` + lines.map(line => 'Write-Output ' + psLiteral(line)).join('\n') + '\nexit 23\n');
  writeFileSync(observer, '\ufeff' + repositoryDiagnosticScript(invocation, resultPath));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  env.PSModulePath = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', observer],
    { env, timeout: 30_000, windowsHide: true, encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 23);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(readFileSync(counter, 'utf8'), '1');
  // Check on-disk bytes before the independent Node sanitizer runs.
  const saved = readFileSync(resultPath, 'utf8');
  for (const forbidden of [...forbiddenExcerptBytes, 'unrelated', 'foreign stage', 'array stage']) assert.ok(!saved.includes(forbidden), forbidden);
  const value = JSON.parse(saved);
  assert.equal(value.exitCode, 23);
  assert.equal(value.protocolSeen, true);
  assert.equal(value.protocolOk, false);
  assert.equal(value.protocolReason, 'git checkout failed: [credential field redacted]');
  assert.equal(value.failureExcerpt.length, 15);
  assert.ok(value.failureExcerpt.at(-1).includes('fictional final detail'));
  assert.deepEqual(value.signals, ['repository-https', 'repository-pin', 'repository-ssh']);
  assert.deepEqual(value.failureExcerpt, sanitizeRepositoryDiagnostic(value).failureExcerpt);
});
