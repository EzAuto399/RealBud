// A process-start diagnostic, not office or ordinary-user acceptance. No server
// bootstrap, PostgreSQL, GUI, account change or ACL mutation is performed here.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serviceSmokeEnv } from './service-smoke-env.mjs';
import { smokeInstalledWorker } from './smoke-one-shot-worker.mjs';

const script = fileURLToPath(import.meta.url);
const identityPrefix = 'REALBUD_QA_RESTRICTED_V1 ';
const securityPrefix = 'REALBUD_QA_STARTUP_SECURITY_V1 ';
const rowPrefix = 'REALBUD_QA_STARTUP_ROW_V1 ';
const parentPrefix = 'REALBUD_QA_STARTUP_PARENT_V1 ';
const version = 'realbud-qa-restricted-process 1\r\n';
const uint = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const pid = value => Number.isInteger(value) && value > 0 && value <= 0x7fffffff;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(done => setTimeout(done, ms));

export function parseIdentity(value) {
  const keys = ['schema', 'launcherPid', 'childPid', 'sameUser', 'jobInherited', 'parentAdministratorEnabled', 'parentPowerUsersEnabled',
    'parentDefaultOwnerIsUser', 'restrictedDefaultOwnerWasUser', 'restrictedDefaultOwnerIsUser', 'administratorEnabled', 'powerUsersEnabled', 'elevated', 'elevationType', 'tokenDefaultOwnerIsUser'];
  assert.ok(exact(value, keys) && value.schema === 1 && pid(value.launcherPid) && pid(value.childPid) && value.launcherPid !== value.childPid &&
    value.sameUser === true && value.jobInherited === true && value.administratorEnabled === false && value.powerUsersEnabled === false &&
    value.restrictedDefaultOwnerIsUser === true && value.tokenDefaultOwnerIsUser === true && [1, 2, 3].includes(value.elevationType) &&
    ['parentAdministratorEnabled', 'parentPowerUsersEnabled', 'parentDefaultOwnerIsUser', 'restrictedDefaultOwnerWasUser', 'elevated'].every(key => typeof value[key] === 'boolean'), 'Restricted identity refused');
  return value;
}

export function parseSecurity(value, identity) {
  const acl = item => exact(item, ['present', 'aceCount', 'userAllowMask', 'userDenyMask', 'administratorsAllowMask', 'systemAllowMask', 'otherAceCount']) &&
    typeof item.present === 'boolean' && uint(item.aceCount) && item.aceCount <= 1024 && uint(item.otherAceCount) && item.otherAceCount <= item.aceCount &&
    ['userAllowMask', 'userDenyMask', 'administratorsAllowMask', 'systemAllowMask'].every(key => uint(item[key])) &&
    (item.present || Object.entries(item).filter(([key]) => key !== 'present').every(([, number]) => number === 0));
  const rights = ['queryLimited', 'queryInformation', 'vmRead', 'duplicateHandle', 'synchronize', 'tokenQueryDuplicate'];
  const access = item => exact(item, ['opened', 'win32Error']) && typeof item.opened === 'boolean' && uint(item.win32Error) && (item.opened ? item.win32Error === 0 : item.win32Error > 0);
  assert.ok(exact(value, ['schema', 'launcherPid', 'childPid', 'parentDefaultDacl', 'restrictedDefaultDacl', 'childDefaultDacl', 'objectAccessAsChild', 'reverted']) &&
    value.schema === 1 && value.launcherPid === identity.launcherPid && value.childPid === identity.childPid && value.reverted === true &&
    ['parentDefaultDacl', 'restrictedDefaultDacl', 'childDefaultDacl'].every(key => acl(value[key])) &&
    exact(value.objectAccessAsChild, rights) && rights.every(key => access(value.objectAccessAsChild[key])), 'Startup security observation refused');
  return value;
}

function inspectReply(output, targetPid) {
  const value = JSON.parse(output);
  const keys = ['schema', 'pid', 'outcome', 'sameUser', 'administratorEnabled', 'powerUsersEnabled', 'elevated', 'elevationType', 'tokenDefaultOwnerIsUser', 'objectOwnerIsUser'];
  if (exact(value, keys) && value.schema === 1 && value.pid === targetPid && value.outcome === 'queried' &&
    ['sameUser', 'administratorEnabled', 'powerUsersEnabled', 'elevated', 'tokenDefaultOwnerIsUser', 'objectOwnerIsUser'].every(key => typeof value[key] === 'boolean') && [1, 2, 3].includes(value.elevationType)) return value;
  const stages = ['open-process', 'open-token', 'current-token', 'duplicate-token', 'administrator-membership', 'power-users-membership', 'elevation', 'elevation-type', 'user-size', 'user-query', 'owner-size', 'owner-query', 'object-owner-query', 'managed'];
  assert.ok(exact(value, ['schema', 'pid', 'outcome', 'stage', 'win32Error']) && value.schema === 1 && value.pid === targetPid &&
    value.outcome === 'query-failed' && stages.includes(value.stage) && uint(value.win32Error), 'Inspection reply refused');
  return value;
}

// The native exit and a valid-looking reply are separate facts. In particular,
// a nonzero exit carrying queried JSON is never counted as successful startup.
export function summarizeExecution(kind, result, targetPid, elapsedMs) {
  const signals = new Set(['SIGABRT', 'SIGBREAK', 'SIGBUS', 'SIGFPE', 'SIGILL', 'SIGINT', 'SIGKILL', 'SIGSEGV', 'SIGTERM']);
  const codes = new Set(['ETIMEDOUT', 'ENOBUFS', 'ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'ENOMEM', 'EMFILE', 'ENFILE', 'EIO', 'UNKNOWN']);
  const output = typeof result.stdout === 'string' || Buffer.isBuffer(result.stdout) ? result.stdout : null;
  const execution = { pid: pid(result.pid) ? result.pid : null,
    status: Number.isInteger(result.status) && result.status >= -2147483648 && result.status <= 0xffffffff ? result.status : null,
    signal: !result.signal ? null : signals.has(result.signal) ? result.signal : 'other',
    code: !result.error ? null : codes.has(result.error.code) ? result.error.code : 'other',
    stdoutBytes: output === null ? null : Math.min(Buffer.byteLength(output), 2049), elapsedMs: Math.max(0, Math.min(60000, Math.round(elapsedMs))) };
  let reply = null, refusal = null;
  if (!execution.stdoutBytes) refusal = 'reply-unavailable';
  else if (execution.stdoutBytes > 2048) refusal = 'reply-too-large';
  else try {
    if (kind === 'managed-version') {
      assert.ok(String(output) === version || String(output) === version.replace('\r\n', '\n')); reply = { versionMatched: true };
    } else if (kind === 'native-node') {
      const value = JSON.parse(output);
      assert.ok(exact(value, ['schema', 'pid', 'nativeStarted']) && value.schema === 1 && value.pid === execution.pid && value.nativeStarted === true); reply = value;
    } else { assert.equal(kind, 'managed-inspect'); reply = inspectReply(output, targetPid); }
  } catch { refusal = 'reply-schema'; }
  return { kind, execution, reply, refusal, succeeded: execution.pid !== null && execution.status === 0 && execution.signal === null && execution.code === null &&
    refusal === null && (kind !== 'managed-inspect' || reply.outcome === 'queried') };
}

export function parseMatrix(output, restricted) {
  assert.ok(typeof output === 'string' && Buffer.byteLength(output) <= 32768, 'Matrix output refused');
  const lines = output.trim().split(/\r?\n/); let identity = null, security = null;
  if (restricted) {
    assert.ok(lines[0]?.startsWith(identityPrefix) && lines[1]?.startsWith(securityPrefix), 'Restricted headers missing');
    identity = parseIdentity(JSON.parse(lines.shift().slice(identityPrefix.length)));
    security = parseSecurity(JSON.parse(lines.shift().slice(securityPrefix.length)), identity);
  }
  assert.ok(lines[0]?.startsWith(parentPrefix), 'Matrix parent missing');
  const parent = JSON.parse(lines.shift().slice(parentPrefix.length));
  assert.ok(exact(parent, ['schema', 'pid']) && parent.schema === 1 && pid(parent.pid) && (!identity || parent.pid === identity.childPid), 'Matrix PID mismatch');
  assert.equal(lines.length, 3, 'Exactly three startup observations required');
  const kinds = ['native-node', 'managed-version', 'managed-inspect'];
  const rows = lines.map((line, index) => {
    assert.ok(line.startsWith(rowPrefix), 'Unexpected diagnostic output');
    const row = JSON.parse(line.slice(rowPrefix.length));
    assert.ok(exact(row, ['kind', 'execution', 'reply', 'refusal', 'succeeded']) && row.kind === kinds[index], 'Observation schema mismatch');
    assert.ok(exact(row.execution, ['pid', 'status', 'signal', 'code', 'stdoutBytes', 'elapsedMs']), 'Execution schema mismatch');
    // Recreate the validated projection rather than trusting the nested process
    // to declare success or smuggle arbitrary JSON into the receipt.
    let encoded = '';
    if (row.reply !== null) encoded = row.kind === 'managed-version' ? (exact(row.reply, ['versionMatched']) && row.reply.versionMatched === true ? version : '{}') : JSON.stringify(row.reply);
    const e = row.execution;
    assert.ok((e.pid === null || pid(e.pid)) && (e.status === null || Number.isInteger(e.status) && e.status >= -2147483648 && e.status <= 0xffffffff) &&
      (e.stdoutBytes === null || uint(e.stdoutBytes) && e.stdoutBytes <= 2049) && uint(e.elapsedMs) && e.elapsedMs <= 60000 &&
      [null, 'reply-unavailable', 'reply-too-large', 'reply-schema'].includes(row.refusal), 'Execution values refused');
    assert.ok(row.refusal === 'reply-unavailable' ? e.stdoutBytes === null || e.stdoutBytes === 0 :
      row.refusal === 'reply-too-large' ? e.stdoutBytes === 2049 : e.stdoutBytes > 0 && e.stdoutBytes <= 2048, 'Reply byte bound mismatch');
    const projected = summarizeExecution(row.kind, { pid: e.pid, status: e.status, signal: e.signal, error: e.code ? { code: e.code } : undefined,
      stdout: row.refusal ? row.refusal === 'reply-too-large' ? 'x'.repeat(2049) : row.refusal === 'reply-schema' ? '{}' : '' : encoded }, parent.pid, e.elapsedMs);
    assert.equal(projected.execution.signal, e.signal); assert.equal(projected.execution.code, e.code);
    assert.equal(projected.refusal, row.refusal); assert.equal(projected.succeeded, row.succeeded);
    assert.deepEqual(projected.reply, row.reply);
    return row;
  });
  return { parent, identity, security, rows };
}

async function writeJson(file, value) {
  await writeFile(file + '.next', JSON.stringify(value, null, 2) + '\n'); await rename(file + '.next', file);
}
function alive(value) { try { process.kill(value, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
async function gone(value) { for (let i = 0; i < 100; i++) { if (!alive(value)) return true; await pause(50); } return !alive(value); }
async function bounded(promise, ms) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('deadline')), ms); })]); } finally { clearTimeout(timer); } }

async function childMatrix(helper, scratch) {
  console.log(parentPrefix + JSON.stringify({ schema: 1, pid: process.pid }));
  const object = join(scratch, `fictional-startup-object-${process.pid}`); await mkdir(object);
  const variants = [
    ['native-node', process.execPath, ['-e', 'console.log(JSON.stringify({schema:1,pid:process.pid,nativeStarted:true}))']],
    ['managed-version', helper, ['--version']],
    ['managed-inspect', helper, ['--inspect', String(process.pid), object]],
  ];
  for (const [kind, command, args] of variants) {
    const started = performance.now();
    const result = spawnSync(command, args, { cwd: scratch, env: process.env, windowsHide: true, timeout: 3000, maxBuffer: 2048, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    console.log(rowPrefix + JSON.stringify(summarizeExecution(kind, result, process.pid, performance.now() - started)));
  }
}

async function main() {
  assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64');
  assert.ok(process.versions.electron && process.versions.node.startsWith('24.'));
  if (process.argv[2] === '--child') { await childMatrix(process.argv[3], process.argv[4]); return; }
  const [resourcesArg, outputArg] = process.argv.slice(2);
  assert.ok(resourcesArg && outputArg);
  const resources = await realpath(resolve(resourcesArg)), output = resolve(outputArg), executable = await realpath(process.execPath);
  assert.equal(resources.toLowerCase(), (await realpath(join(dirname(executable), 'resources'))).toLowerCase());
  const helper = await realpath(process.env.REALBUD_QA_RESTRICTED_LAUNCHER || '');
  const source = { compiled: process.env.REALBUD_QA_COMPILED_SHA, harness: process.env.REALBUD_QA_HARNESS_SHA,
    helperSourceSha256: process.env.REALBUD_QA_RESTRICTED_SOURCE_SHA256, helperExecutableSha256: process.env.REALBUD_QA_RESTRICTED_LAUNCHER_SHA256 };
  assert.match(source.compiled || '', /^[a-f0-9]{40}$/); assert.match(source.harness || '', /^[a-f0-9]{40}$/);
  assert.match(source.helperSourceSha256 || '', /^[a-f0-9]{64}$/); assert.match(source.helperExecutableSha256 || '', /^[a-f0-9]{64}$/);
  assert.equal(hash(await readFile(helper)), source.helperExecutableSha256);
  process.env.REALBUD_RESOURCES_DIR = resources;
  const { runOneShot, windowsWorkerSupervisor } = await import(pathToFileURL(join(resources, 'server/one-shot-process.js')).href);
  const supervisor = windowsWorkerSupervisor(); assert.equal(supervisor, join(resources, 'RealBud Worker.exe'));
  await mkdir(output); // A diagnostic never overwrites earlier failed evidence.
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'RealBud startup probe ')));
  const env = { ...serviceSmokeEnv({ executable, home: scratch, data: join(scratch, 'unused-data'), scratch, port: 0 }), REALBUD_RESOURCES_DIR: resources };
  await mkdir(env.APPDATA, { recursive: true }); await mkdir(env.LOCALAPPDATA, { recursive: true });
  const ownedPids = new Set(), pending = new Set(), closures = new Map(), lanes = [], attempts = [], cleanup = { supervisorsClosed: false, observedPidsGone: false, scratchRemoved: false };
  let stage = 'worker-controls', failure = null, workerChecks = [], complete = false;
  const state = () => writeJson(join(output, 'state.json'), { schema: 1, stage, ownedPids: [...ownedPids] });
  async function capture(name, command, args) {
    stage = name; await state();
    const started = performance.now();
    let calls = 0, settle, close;
    const result = new Promise(done => { settle = done; }), closed = new Promise(done => { close = done; });
    const child = runOneShot(command, args, { cwd: scratch, env, timeout: 20000, encoding: 'utf8', maxBuffer: 32768 },
      (error, stdout, stderr) => { calls++; settle({ error, stdout, stderr }); });
    assert.ok(child?.pid); ownedPids.add(child.pid); pending.add(child); closures.set(child, closed);
    child.once('close', () => { pending.delete(child); close(); }); await state();
    const value = await bounded(result, 25000); await bounded(closed, 5000); assert.equal(calls, 1);
    const helperStages = new Set(['duplicate-token', 'administrator-membership', 'power-users-membership', 'elevation', 'elevation-type', 'user-size', 'user-query', 'owner-size', 'owner-query', 'set-default-owner',
      'parent-job', 'job-limits', 'job-containment', 'launch-token', 'restrict-token', 'restricted-authority', 'standard-handle', 'copy-handle', 'attribute-size', 'attributes', 'handle-list',
      'create-restricted', 'child-job', 'child-token', 'child-authority', 'resume', 'wait', 'exit-code', 'managed', 'default-dacl-size', 'default-dacl-query', 'default-dacl-information',
      'default-dacl-bounds', 'default-dacl-ace', 'diagnostic-duplicate-token', 'diagnostic-impersonate', 'diagnostic-revert']);
    const helperFailures = [];
    for (const line of String(value.stderr).slice(0, 2048).split(/\r?\n/)) {
      const match = /^Restricted QA process refused: stage=([a-z-]{1,40}) code=(\d{1,10})$/.exec(line);
      if (match && helperStages.has(match[1]) && uint(Number(match[2]))) helperFailures.push({ stage: match[1], win32Error: Number(match[2]) });
    }
    const elapsedMs = Math.round(performance.now() - started);
    attempts.push({ name, supervisorPid: child.pid, elapsedMs, callbacks: calls, closed: true,
      status: !value.error ? 0 : Number.isInteger(value.error.code) && value.error.code >= -2147483648 && value.error.code <= 0xffffffff ? value.error.code : null,
      code: ['ETIMEDOUT', 'ERR_WORKER_CLEANUP', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'ENOENT'].includes(value.error?.code) ? value.error.code : value.error && typeof value.error.code !== 'number' ? 'other' : null,
      cleanupUnconfirmed: value.error?.cleanupUnconfirmed === true, helperFailures });
    // The installed Worker's exit 125 also means Job containment/drain failed. Its
    // meaning cannot be disambiguated from a target exit, so retain and refuse.
    assert.ok(!value.error?.cleanupUnconfirmed && value.error?.code !== 'ETIMEDOUT' && value.error?.code !== 125, 'Supervisor cleanup or deadline failed');
    return { ...value, elapsedMs, supervisorPid: child.pid };
  }
  try {
    workerChecks = await smokeInstalledWorker(resources, executable);
    const elevated = await capture('elevated', executable, [script, '--child', helper, scratch]); assert.equal(elevated.error, null);
    const elevatedMatrix = parseMatrix(elevated.stdout, false);
    lanes.push({ name: 'elevated', supervisorPid: elevated.supervisorPid, ...elevatedMatrix });
    assert.ok(elevatedMatrix.rows.every(row => row.succeeded));
    const authority = elevatedMatrix.rows[2].reply;
    assert.ok(authority.sameUser && (authority.administratorEnabled || authority.powerUsersEnabled), 'Elevated control authority missing');

    const restricted = await capture('restricted-node-parent', helper, ['--diagnostic-launch', '--', executable, script, '--child', helper, scratch]);
    assert.equal(restricted.error, null); const restrictedMatrix = parseMatrix(restricted.stdout, true);
    lanes.push({ name: 'restricted-node-parent', supervisorPid: restricted.supervisorPid, ...restrictedMatrix });
    assert.equal(restrictedMatrix.rows[0].succeeded, true, 'Native restricted control did not start');

    const direct = await capture('restricted-managed-direct', helper, ['--diagnostic-launch', '--', helper, '--version']);
    const lines = direct.stdout.split(/\r?\n/); assert.ok(lines[0].startsWith(identityPrefix) && lines[1]?.startsWith(securityPrefix));
    const identity = parseIdentity(JSON.parse(lines.shift().slice(identityPrefix.length))), security = parseSecurity(JSON.parse(lines.shift().slice(securityPrefix.length)), identity);
    const observation = summarizeExecution('managed-version', { pid: identity.childPid, status: direct.error ? direct.error.code : 0,
      signal: direct.error?.signal, error: typeof direct.error?.code === 'string' ? direct.error : undefined, stdout: lines.join('\n') }, identity.childPid, direct.elapsedMs);
    lanes.push({ name: 'restricted-managed-direct', supervisorPid: direct.supervisorPid, identity, security, observation });
    complete = true;
  } catch { failure = { stage, code: 'diagnostic-incomplete' }; }
  finally {
    for (const lane of lanes) {
      for (const value of [lane.parent?.pid, lane.identity?.launcherPid, lane.identity?.childPid, ...(lane.rows || []).map(row => row.execution.pid)]) if (pid(value)) ownedPids.add(value);
    }
    await state();
    // Normal completion requires the installed supervisor's drain and all
    // recorded PIDs gone. A forced/uncertain shutdown never becomes success.
    for (const child of pending) { try { child.kill('SIGKILL'); child.stdin?.destroy(); } catch { /* retained as incomplete below */ } }
    await Promise.all([...pending].map(async child => {
      try { await bounded(closures.get(child), 5000); }
      catch { child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); }
    }));
    cleanup.supervisorsClosed = pending.size === 0;
    cleanup.observedPidsGone = (await Promise.all([...ownedPids].map(value => gone(value).catch(() => false)))).every(Boolean);
    if (cleanup.supervisorsClosed && cleanup.observedPidsGone) {
      try { await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); cleanup.scratchRemoved = true; }
      catch { failure ??= { stage: 'cleanup', code: 'scratch-removal-unconfirmed' }; }
    }
    await writeJson(join(output, 'receipt.json'), { schema: 1, kind: 'restricted-startup-diagnostic', diagnosticComplete: complete && Object.values(cleanup).every(Boolean), officeAcceptance: false,
      source, runtime: { node: process.versions.node, electron: process.versions.electron },
      files: { harnessSha256: hash(await readFile(script)), supervisorSha256: hash(await readFile(supervisor)), oneShotSha256: hash(await readFile(join(resources, 'server/one-shot-process.js'))) },
      workerChecks, attempts, lanes, failure, cleanup, ownedPids: [...ownedPids],
      limits: ['Startup diagnostics only; no office setup or standard-user Windows acceptance.', 'DACL ACE masks are descriptive; handle-open observations use the exact suspended child token and PID.', 'No product ACL, default DACL or admission policy changes; no accounts, GUI, PostgreSQL or provider calls.'] });
    process.exitCode = complete && Object.values(cleanup).every(Boolean) ? 0 : 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === script) await main();
