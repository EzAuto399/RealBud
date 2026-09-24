import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parseIdentity, parseSecurity, summarizeExecution, parseMatrix } from '../qa-windows-restricted-startup.mjs';

const identity = () => ({ schema: 1, launcherPid: 101, childPid: 102, sameUser: true, jobInherited: true,
  parentAdministratorEnabled: true, parentPowerUsersEnabled: false, parentDefaultOwnerIsUser: false,
  restrictedDefaultOwnerWasUser: true, restrictedDefaultOwnerIsUser: true, administratorEnabled: false, powerUsersEnabled: false,
  elevated: true, elevationType: 1, tokenDefaultOwnerIsUser: true });
const acl = () => ({ present: true, aceCount: 3, userAllowMask: 0, userDenyMask: 0, administratorsAllowMask: 0x10000000, systemAllowMask: 0x10000000, otherAceCount: 1 });
const security = () => ({ schema: 1, launcherPid: 101, childPid: 102, parentDefaultDacl: acl(), restrictedDefaultDacl: acl(), childDefaultDacl: acl(), reverted: true,
  objectAccessAsChild: Object.fromEntries(['queryLimited', 'queryInformation', 'vmRead', 'duplicateHandle', 'synchronize', 'tokenQueryDuplicate'].map(name => [name, { opened: false, win32Error: 5 }])) });
const query = () => ({ schema: 1, pid: 102, outcome: 'queried', sameUser: true, administratorEnabled: false, powerUsersEnabled: false,
  elevated: true, elevationType: 1, tokenDefaultOwnerIsUser: true, objectOwnerIsUser: true });
const result = (stdout, extra = {}) => ({ pid: 103, status: 0, signal: null, stdout, ...extra });
const version = 'realbud-qa-restricted-process 1\r\n';
const project = (kind, value) => summarizeExecution(kind, value, 102, 5);
const rows = () => [project('native-node', result(JSON.stringify({ schema: 1, pid: 103, nativeStarted: true }))),
  project('managed-version', result(version, { pid: 104 })), project('managed-inspect', result(JSON.stringify(query()), { pid: 105 }))];
function matrix(values = rows(), secure = security()) {
  return 'REALBUD_QA_RESTRICTED_V1 ' + JSON.stringify(identity()) + '\nREALBUD_QA_STARTUP_SECURITY_V1 ' + JSON.stringify(secure) +
    '\nREALBUD_QA_STARTUP_PARENT_V1 ' + JSON.stringify({ schema: 1, pid: 102 }) + '\n' + values.map(row => 'REALBUD_QA_STARTUP_ROW_V1 ' + JSON.stringify(row)).join('\n') + '\n';
}

test('already-correct restricted owner and descriptive ACEs remain observations', () => {
  assert.deepEqual(parseIdentity(identity()), identity());
  const parsed = parseSecurity(security(), identity());
  assert.equal(parsed.childDefaultDacl.userAllowMask, 0);
  assert.equal(parsed.objectAccessAsChild.queryLimited.opened, false);
  assert.equal(parseMatrix(matrix(), true).rows.length, 3);
});

test('wrong PID, authority, owner, Job and extra identity content are refused', () => {
  for (const delta of [{ childPid: 101 }, { childPid: 0 }, { sameUser: false }, { jobInherited: false }, { administratorEnabled: true },
    { powerUsersEnabled: true }, { restrictedDefaultOwnerIsUser: false }, { tokenDefaultOwnerIsUser: false }, { elevationType: 4 }, { privateSid: 'secret' }]) {
    assert.throws(() => parseIdentity({ ...identity(), ...delta }));
  }
});

test('security provenance and successful impersonation reversion are mandatory', () => {
  for (const delta of [{ childPid: 200 }, { launcherPid: 200 }, { reverted: false }, { sid: 'secret' }]) assert.throws(() => parseSecurity({ ...security(), ...delta }, identity()));
  const value = security(); value.objectAccessAsChild.queryLimited = { opened: true, win32Error: 5 };
  assert.throws(() => parseSecurity(value, identity()));
});

test('DACL observations reject invalid counts, masks and raw identities', () => {
  for (const delta of [{ aceCount: 1025 }, { otherAceCount: 4 }, { userAllowMask: -1 }, { userDenyMask: 0x100000000 }, { present: false }, { rawAcl: 'private' }]) {
    const value = security(); Object.assign(value.childDefaultDacl, delta); assert.throws(() => parseSecurity(value, identity()));
  }
});

test('the observed NTSTATUS is preserved without converting it to a timeout', () => {
  const row = project('managed-version', result('', { status: 3221225794 }));
  assert.equal(row.execution.status, 3221225794); assert.equal(row.execution.code, null);
  assert.equal(row.execution.stdoutBytes, 0); assert.equal(row.refusal, 'reply-unavailable'); assert.equal(row.succeeded, false);
  assert.equal(parseMatrix(matrix([rows()[0], row, rows()[2]]), true).rows[1].execution.status, 3221225794);
});

test('valid-looking success cannot override nonzero exit, timeout or signal', () => {
  for (const extra of [{ status: 23 }, { status: null, signal: 'SIGTERM' }, { status: 0, error: { code: 'ETIMEDOUT', message: 'private' } }]) {
    const row = project('managed-inspect', result(JSON.stringify(query()), extra)); assert.equal(row.succeeded, false);
    assert.equal(JSON.stringify(row).includes('private'), false);
    const forged = { ...row, succeeded: true }; assert.throws(() => parseMatrix(matrix([rows()[0], rows()[1], forged]), true));
  }
});

test('query-failed is a diagnostic result even when the helper exits zero', () => {
  const row = project('managed-inspect', result(JSON.stringify({ schema: 1, pid: 102, outcome: 'query-failed', stage: 'open-token', win32Error: 5 })));
  assert.equal(row.succeeded, false); assert.equal(row.reply.win32Error, 5); assert.equal(row.execution.status, 0);
  assert.equal(parseMatrix(matrix([rows()[0], rows()[1], row]), true).rows[2].reply.stage, 'open-token');
});

test('malformed, excess and private replies stay out of receipts', () => {
  for (const output of ['private-path', '{"private":"value"}', JSON.stringify({ ...query(), private: 'value' }), JSON.stringify({ ...query(), pid: 999 }), 'private'.repeat(400)]) {
    const row = project('managed-inspect', result(output)); assert.equal(row.succeeded, false); assert.equal(row.reply, null);
    assert.equal(JSON.stringify(row).includes('private'), false);
  }
});

test('cross-process projection rejects forged bytes, success and unknown output lines', () => {
  for (const delta of [{ stdoutBytes: null }, { stdoutBytes: 0 }, { stdoutBytes: 2049 }, { code: 'secret' }, { signal: 'secret' }, { elapsedMs: -1 }]) {
    const values = rows(); Object.assign(values[1].execution, delta); assert.throws(() => parseMatrix(matrix(values), true));
  }
  assert.throws(() => parseMatrix(matrix() + 'private\n', true));
  assert.throws(() => parseMatrix(matrix().replace('"pid":102}\n', '"pid":999}\n'), true));
});

test('local real child verifies native PID/exit projection', () => {
  const child = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify({schema:1,pid:process.pid,nativeStarted:true}))'], { encoding: 'utf8', timeout: 3000 });
  const row = project('native-node', child); assert.equal(row.succeeded, true); assert.equal(row.reply.pid, child.pid);
  const nonzero = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify({schema:1,pid:process.pid,nativeStarted:true}));process.exitCode=23'], { encoding: 'utf8', timeout: 3000 });
  assert.equal(project('native-node', nonzero).succeeded, false);
});

test('local real timeout remains a failed execution with bounded output', () => {
  const child = spawnSync(process.execPath, ['-e', 'setInterval(()=>{},100)'], { encoding: 'utf8', timeout: 250, maxBuffer: 2048 });
  const row = project('native-node', child); assert.equal(row.execution.code, 'ETIMEDOUT'); assert.equal(row.succeeded, false);
});

test('actual capture retains reserved Worker125 then refuses completion; DLL startup status stays observable', async () => {
  const source = readFileSync(new URL('../qa-windows-restricted-startup.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('  async function capture('), end = source.indexOf('\n  try {\n    workerChecks', start);
  assert.ok(start >= 0 && end > start);
  const stdout = 'REALBUD_QA_RESTRICTED_V1 ' + JSON.stringify(identity()) + '\nREALBUD_QA_STARTUP_SECURITY_V1 ' + JSON.stringify(security()) + '\n';
  async function run(status) {
    const attempts = [], child = new EventEmitter(); child.pid = 500;
    const capture = vm.runInNewContext('(' + source.slice(start, end).trim() + ')', {
      stage: '', state: async () => {}, performance, scratch: 'fictional-scratch', env: {}, assert,
      ownedPids: new Set(), pending: new Set(), closures: new Map(), attempts,
      uint: value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff,
      bounded: promise => promise,
      runOneShot: (_command, _args, _options, callback) => {
        setImmediate(() => { callback({ code: status }, stdout, ''); child.emit('close'); }); return child;
      },
    });
    let value, error, completed = false;
    try { value = await capture('restricted-managed-direct', 'fictional-helper', []); completed = true; } catch (caught) { error = caught; }
    assert.equal(attempts.length, 1); assert.equal(attempts[0].status, status); assert.equal(attempts[0].closed, true); assert.equal(attempts[0].callbacks, 1);
    return { value, error, completed };
  }
  const reserved = await run(125); assert.equal(reserved.completed, false); assert.ok(reserved.error);
  const startup = await run(3221225794); assert.equal(startup.completed, true); assert.equal(startup.value.error.code, 3221225794);
});
