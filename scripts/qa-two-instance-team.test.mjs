import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const directory = dirname(fileURLToPath(import.meta.url));
const harness = await readFile(join(directory, 'qa-two-instance-team.mjs'), 'utf8');
const launcher = await readFile(join(directory, 'start-test-lab.mjs'), 'utf8');
const app = '/fictional/RealBud.app';
const resources = app + '/Contents/Resources';
const electron = app + '/Contents/MacOS/RealBud';
const args = ['--resources', resources, '--postgres-bin', resources + '/postgres/bin', '--resource-proof', '/fictional/proof.json', '--output', '/fictional/new-output'];
const check = (value, message) => assert.ok(value, message);
const plain = value => JSON.parse(JSON.stringify(value));
function slice(source, from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, 'The test must execute the actual QA boundary.');
  return source.slice(start, end);
}
function fakeProcess(packaged, overrides = {}) {
  return {
    argv: ['fictional-runtime', 'fictional-script', ...args],
    versions: { node: '24.18.1', ...(packaged ? { electron: '43.4.0' } : {}) },
    version: 'v24.18.1', platform: 'darwin', arch: 'arm64',
    execPath: packaged ? electron : '/fictional/node',
    env: packaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}, ...overrides,
  };
}
// Execute the real validation and launch boundaries with fictional processes.
// No service, PostgreSQL, Electron GUI, or network is started by these tests.
async function harnessAdmission(process, realpath = async value => resolve(value)) {
  return vm.runInNewContext('(async () => {' + slice(harness, 'const options = {};', 'const output =') +
    '\nreturn { runtimeMode, packagedElectron, executable, resources }; })()', { process, resolve, join, realpath });
}
async function launcherAdmission(process) {
  return vm.runInNewContext('(async () => {' + slice(launcher, 'const role =', 'const base =') +
    '\nreturn { runtimeMode, packagedElectron, resources }; })()',
  { process, kit: '/fictional/kit', resolve, join, realpath: async value => resolve(value) });
}

test('standalone Node stays the default; packaged mode requires explicit actual Electron admission', async () => {
  assert.equal((await harnessAdmission(fakeProcess(false))).runtimeMode, 'standalone-node');
  assert.equal((await harnessAdmission(fakeProcess(false, { argv: ['node', 'script', ...args, '--runtime', 'standalone-node'] }))).packagedElectron, false);
  const process = fakeProcess(true, { argv: ['electron', 'script', ...args, '--runtime', 'packaged-electron'] });
  assert.deepEqual(plain(await harnessAdmission(process)), { runtimeMode: 'packaged-electron', packagedElectron: true, executable: electron, resources });
  const aliases = new Map([['/fictional/app-alias', resources], ['/fictional/executable-alias', electron]]);
  const aliased = await harnessAdmission({ ...process, execPath: '/fictional/executable-alias',
    argv: ['electron', 'script', '--resources', '/fictional/app-alias', ...args.slice(2), '--runtime', 'packaged-electron'] },
  async value => aliases.get(value) ?? resolve(value));
  assert.equal(aliased.executable, electron);
});

test('runtime, platform, flag and app mismatches fail before any fixture path is created', async () => {
  const argv = ['electron', 'script', ...args, '--runtime', 'packaged-electron'];
  for (const process of [
    fakeProcess(true), fakeProcess(false, { argv }),
    fakeProcess(false, { env: { ELECTRON_RUN_AS_NODE: '1' } }),
    fakeProcess(false, { env: { ELECTRON_RUN_AS_NODE: '0' } }),
    fakeProcess(true, { argv, env: {} }), fakeProcess(true, { argv, env: { ELECTRON_RUN_AS_NODE: '0' } }),
    fakeProcess(true, { argv, platform: 'win32' }), fakeProcess(true, { argv, platform: 'linux' }),
    fakeProcess(true, { argv, arch: 'x64' }),
    fakeProcess(true, { argv, versions: { node: '22.0.0', electron: '43.4.0' } }),
    fakeProcess(true, { argv, execPath: '/fictional/Other.app/Contents/MacOS/RealBud' }),
  ]) await assert.rejects(harnessAdmission(process));
});

test('actual CLI rejects missing, duplicate and unknown runtime options without writing fixtures', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'rb-team-arguments-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const paths = ['--resources', join(scratch, 'resources'), '--postgres-bin', join(scratch, 'postgres'),
    '--resource-proof', join(scratch, 'proof.json'), '--output', join(scratch, 'output')];
  for (const extra of [
    ['--runtime'], ['--runtime', 'unknown'], ['--runtime', ''], ['--runtime', 'standalone-node', '--runtime', 'standalone-node'],
    ['--runtime', 'packaged-electron'], ['--runtime', '--output'], ['--unknown', 'value'], ['--output', join(scratch, 'other')],
  ]) {
    const result = spawnSync(process.execPath, [join(directory, 'qa-two-instance-team.mjs'), ...paths, ...extra],
      { env: { PATH: dirname(process.execPath) }, encoding: 'utf8', timeout: 3000, maxBuffer: 4096 });
    assert.equal(result.error, undefined); assert.equal(result.status, 1); assert.equal(result.signal, null);
    assert.doesNotMatch(result.stderr, /ENOENT|realpath/); // Refusal happened before resource inspection.
    assert.deepEqual(await readdir(scratch), []);
  }
});

test('launcher repeats mode/flag/app validation before opening the private profile', async () => {
  const node = fakeProcess(false, { argv: ['node', 'launcher', 'host'], env: { REALBUD_TEST_RESOURCES: resources } });
  assert.equal((await launcherAdmission(node)).packagedElectron, false);
  const packaged = fakeProcess(true, { argv: ['electron', 'launcher', 'client'], env: {
    ELECTRON_RUN_AS_NODE: '1', REALBUD_TEST_RUNTIME: 'packaged-electron', REALBUD_TEST_RESOURCES: resources,
  } });
  assert.equal((await launcherAdmission(packaged)).packagedElectron, true);
  for (const process of [
    { ...packaged, env: { ...packaged.env, REALBUD_TEST_RUNTIME: 'unknown' } },
    { ...packaged, env: { ...packaged.env, REALBUD_TEST_RUNTIME: 'standalone-node' } },
    { ...packaged, env: { ...packaged.env, REALBUD_TEST_RUNTIME: undefined } },
    { ...packaged, env: { ...packaged.env, ELECTRON_RUN_AS_NODE: undefined } },
    { ...packaged, env: { ...packaged.env, ELECTRON_RUN_AS_NODE: '0' } },
    { ...node, env: { ...node.env, ELECTRON_RUN_AS_NODE: '1' } },
    { ...node, env: { ...node.env, REALBUD_TEST_RUNTIME: 'packaged-electron' } },
    { ...packaged, platform: 'win32' }, { ...packaged, arch: 'x64' },
    { ...packaged, execPath: '/fictional/Other.app/Contents/MacOS/RealBud' },
    { ...packaged, argv: ['electron', 'launcher', 'invalid-role'] },
  ]) await assert.rejects(launcherAdmission(process));
});

test('harness launches both roles using only the admitted runtime flags and owned IPC group', async () => {
  for (const packagedElectron of [false, true]) for (const role of ['host', 'client']) {
    const process = fakeProcess(packagedElectron, { env: { PRIVATE_TOKEN: 'fictional-secret', NODE_OPTIONS: 'fictional-option' } });
    const calls = [], children = new Set();
    const start = vm.runInNewContext(slice(harness, 'async function start(role)', 'async function stop(context)') + '\nstart', {
      process, packagedElectron, dirname, resources, pgBin: resources + '/postgres/bin', scratch: '/fictional/scratch',
      root: '/fictional/repo', launcher: '/fictional/repo/scripts/start-test-lab.mjs', stage: '', tlsPort: undefined,
      children, abort: new AbortController(), URL, check, capturePostgres: async () => {},
      bounded: promise => promise,
      request: async (_, path) => path === '/api/health' ? { app: 'realbud', pid: 456 } : { token: 'f'.repeat(32) },
      spawn: (file, args, options) => {
        calls.push({ file, args: plain(args), options: plain(options) });
        const child = Object.assign(new EventEmitter(), { pid: 123, stderr: { resume() {} } });
        queueMicrotask(() => child.emit('message', { type: 'realbud-test-ready', role, url: 'http://127.0.0.1:32123' }));
        return child;
      },
    });
    const context = await start(role);
    assert.equal(context.serverPid, 456); assert.equal(children.size, 1); assert.equal(calls.length, 1);
    const { file, args, options } = calls[0];
    assert.equal(file, process.execPath); assert.deepEqual(args, ['/fictional/repo/scripts/start-test-lab.mjs', role]);
    assert.equal(options.detached, true); assert.deepEqual(options.stdio, ['ignore', 'ignore', 'pipe', 'ipc']);
    assert.equal(options.env.HOME, '/fictional/scratch');
    assert.equal(options.env.ELECTRON_RUN_AS_NODE, packagedElectron ? '1' : undefined);
    assert.equal(options.env.REALBUD_TEST_RUNTIME, packagedElectron ? 'packaged-electron' : undefined);
    assert.equal(options.env.PRIVATE_TOKEN, undefined); assert.equal(options.env.NODE_OPTIONS, undefined);
  }
});

test('launcher propagates Electron-as-Node to the actual bootstrap without ambient credentials', () => {
  for (const packagedElectron of [false, true]) for (const role of ['host', 'client']) {
    const calls = [];
    const process = fakeProcess(packagedElectron, { env: {
      PRIVATE_TOKEN: 'fictional-secret', NODE_OPTIONS: 'fictional-option', REALBUD_TEST_POSTGRES_BIN: resources + '/postgres/bin',
    } });
    vm.runInNewContext(slice(launcher, '  const env = { PATH:', '  exited = new Promise'), {
      process, packagedElectron, role, dirname, join, resolve, tmpdir: () => '/fictional/tmp',
      home: '/fictional/home', data: '/fictional/home/.realbud', port: 32123, resources, kit: '/fictional/kit',
      spawn: (file, args, options) => { calls.push({ file, args: plain(args), options: plain(options) }); return {}; },
    });
    assert.equal(calls.length, 1);
    const { file, args, options } = calls[0];
    assert.equal(file, process.execPath); assert.deepEqual(args, [resources + '/server/bootstrap.js']);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe', 'ipc']); assert.equal(options.detached, undefined);
    assert.equal(options.env.ELECTRON_RUN_AS_NODE, packagedElectron ? '1' : undefined);
    assert.equal(options.env.REALBUD_COMPANY_POSTGRES_BIN, role === 'host' ? resources + '/postgres/bin' : undefined);
    assert.equal(options.env.REALBUD_TEST_RUNTIME, undefined);
    assert.equal(options.env.PRIVATE_TOKEN, undefined); assert.equal(options.env.NODE_OPTIONS, undefined);
  }
});

test('launcher IPC shutdown stays idempotent and preserves the profile on failed child shutdown', async () => {
  for (const fault of [null, 'disconnected', 'nonzero', 'signal', 'unexpected']) {
    const events = [];
    const close = vm.runInNewContext(slice(launcher, 'async function close()', 'for (const signal') + '\nclose', {
      cancelled: false, closing: undefined, timer: undefined, unexpectedExit: fault === 'unexpected',
      child: { exitCode: null, signalCode: null, connected: fault !== 'disconnected', send: message => events.push(plain(message)) },
      exited: Promise.resolve({ code: fault === 'nonzero' ? 23 : 0, signal: fault === 'signal' ? 'SIGTERM' : null }),
      clearTimeout, setTimeout, join, profile: '/fictional/profile',
      lock: { close: async () => events.push('lock-closed') }, rm: async () => events.push('lock-removed'),
      writeFile: async (file, contents) => { assert.equal(file, '/fictional/profile/stopped.json'); assert.equal(JSON.parse(contents).dataPreserved, true); events.push('stopped'); },
    });
    if (fault) {
      await assert.rejects(close()); assert.ok(!events.includes('lock-closed')); assert.ok(!events.includes('stopped'));
    } else {
      await Promise.all([close(), close()]);
      assert.deepEqual(events, [{ type: 'realbud-test-stop' }, 'lock-closed', 'lock-removed', 'stopped']);
    }
  }
});

test('outer cleanup still refuses forced termination or live listeners as successful shutdown', async () => {
  for (const fault of [null, 'forced', 'listener', 'nonzero']) {
    const sent = [], processes = [], context = { role: 'client', startedAt: Date.now() - 1000, ports: new Set([32123]), serverPid: 456,
      child: { pid: 123, exitCode: null, signalCode: null, connected: true, send: message => sent.push(plain(message)) },
      exit: Promise.resolve({ code: fault === 'nonzero' ? 23 : 0, signal: null }) };
    const children = new Set([context]); let groupAlive = fault === 'forced';
    const stop = vm.runInNewContext(slice(harness, 'async function stop(context)', 'const ownerCredential') + '\nstop', {
      children, capturePostgres: async () => {}, bounded: promise => promise,
      readFile: async () => JSON.stringify({ dataPreserved: true, stoppedAt: new Date().toISOString() }),
      join, scratch: '/fictional/scratch', alive: pid => pid === -123 && groupAlive,
      process: { kill: (pid, signal) => { assert.equal(pid, -123); assert.equal(signal, 'SIGTERM'); groupAlive = false; } },
      wait: async () => {}, portClosed: async () => fault !== 'listener', processes, check,
    });
    if (fault) await assert.rejects(stop(context)); else await stop(context);
    assert.deepEqual(sent, [{ type: 'realbud-test-stop' }]); assert.equal(processes.length, 1);
    assert.equal(processes[0].forced, fault === 'forced');
    if (fault === 'listener') assert.equal(children.size, 1);
  }
});

test('receipt records packaged helper execution without claiming GUI, installation or physical devices', async () => {
  for (const packagedElectron of [false, true]) {
    const process = fakeProcess(packagedElectron), runtime = { mode: packagedElectron ? 'packaged-electron' : 'standalone-node',
      node: process.versions.node, electron: process.versions.electron ?? null, executable: process.execPath, executableSha256: 'a'.repeat(64) };
    const receipt = await vm.runInNewContext('(async () => {' + slice(harness, '  const receipt =', '  await writeFile(join(output') + '\nreturn receipt; })()', {
      packagedElectron, process, runtime, passedRun: true, startedAt: new Date().toISOString(), release: () => 'fictional-os', postgres: 'fictional-16',
      sourceHead: 'a'.repeat(40), script: 'fictional-harness', launcher: 'fictional-launcher', hash: async () => 'b'.repeat(64), resources,
      proof: { sourceRevision: 'c'.repeat(40), files: [], sourceAttribution: 'fictional' }, createHash, proofBytes: Buffer.from('{}'),
      checks: [], requests: [], processes: [], failure: null, cleanupErrors: [], cleanupComplete: true, scratch: '/fictional/scratch',
    });
    assert.equal(receipt.packagedElectronAsNode, packagedElectron); assert.deepEqual(plain(receipt.runtime), runtime);
    assert.equal(receipt.installedElectronRuntime, false); assert.equal(receipt.installedApplicationLifecycle, false);
    assert.equal(receipt.renderedUI, false); assert.equal(receipt.twoPhysicalDevices, false); assert.equal(receipt.liveAccounts, false);
    assert.match(receipt.proofLayer, packagedElectron ? /packaged Electron-as-Node/ : /standalone Node 24/);
    assert.match(receipt.limits[1], packagedElectron ? /does not verify app installation, GUI windows/ : /does not verify the packaged Electron executable/);
  }
});
