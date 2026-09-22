// Actual source or packaged bootstrap, local HTTP, built React UI and admitted native memory
// modules. All proposals, memory, workspace keys and browser storage are fictional.
// Proposal mode uses a fictional ACP peer; no real Hermes CLI, model/provider,
// source account or external mutation is used.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serviceSmokeEnv } from './service-smoke-env.mjs';
import { createServiceAdminPasswordVerifier } from '../server/service-admin.ts';
import { prepareInterruptedMemoryFixture } from '../server/testing/memory-prepared-fixture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const memoryProposals = process.argv.includes('--memory-proposals');
const memoryRecovery = process.argv.includes('--memory-recovery');
assert.ok(process.argv.slice(2).every(arg => ['--memory-proposals', '--memory-recovery'].includes(arg)), 'Only --memory-proposals and --memory-recovery are supported.');
const packaged = process.env.REALBUD_QA_RESOURCES !== undefined || process.env.REALBUD_QA_EXECUTABLE !== undefined;
let resources = null, executable = process.execPath, bootstrap = join(root, 'server/bootstrap.ts'), staticDirectory = join(root, 'dist'), serviceCwd = root;
let admissionModule = join(root, 'server/hermes-memory-review.ts'), helperPath = join(root, 'server/helpers/hermes-memory-review.py');
let proposalHelperPath = join(root, 'server/helpers/hermes-memory-proposals.py');
let runtime = { node: process.versions.node, electron: process.versions.electron ?? null }, executableHash = null, resourceHashes = {};
const fixtureSourceHashes = {};

const output = resolve(process.env.QA_OUTPUT || join(root, memoryProposals ? 'outputs/hermes-memory-proposals-2026-09-22' : 'outputs/hermes-memory-review-2026-09-22', `${memoryProposals ? 'gui-' : ''}${packaged ? 'packaged-browser' : 'browser'}-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`));
assert.ok(!existsSync(join(output, 'receipt.json')), 'Use a fresh QA_OUTPUT so earlier evidence is preserved.');
mkdirSync(output, { recursive: true, mode: 0o700 });
const temp = mkdtempSync(join(realpathSync(tmpdir()), 'RealBud memory review QA ')); chmodSync(temp, 0o700);
const data = join(temp, 'workspace'), hermes = join(data, 'hermes'), profile = join(hermes, 'profiles', 'property');
const memoryFile = join(profile, 'memories', 'MEMORY.md'), pendingDir = join(profile, 'pending', 'memory');
const api = '/api/hermes/memory-reviews';
const recoveryApi = `${api}/interrupted`;
let first = '00000010', second = '00000020';
const proposalScript = join(temp, 'proposal-input.json'), peerOutput = join(temp, 'proposal-peer.json'), ownedPeers = new Set();
let nativeFixtureRuntime, peerCli, peerDrained = !memoryProposals, peerStateFinal = null;
const proposalInputs = {};
const wait = ms => new Promise(done => setTimeout(done, ms));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const checks = [], errors = [], decisions = [], closures = [], blockedNetwork = [];
const pass = label => { checks.push(label); console.log(`PASS ${label}`); };
let browser, page, child, port, base, token, logs = '', failure, admittedRuntime, pin, moduleHashes = {}, sourceHashes = {}, cleanup = false, adminHeadersSeen = 0;
const write = (path, contents) => { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, contents, { mode: 0o600 }); chmodSync(path, 0o600); };
const proposal = (id, payload) => write(join(pendingDir, `${id}.json`), JSON.stringify({ id, subsystem: 'memory', action: payload.action, summary: 'Fictional preference review', origin: 'background_review', created_at: 1_790_000_000, payload }));
const stop = async () => {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await Promise.race([exited, wait(6000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
};
async function request(path, method = 'GET', body, expected = 200) {
  const response = await fetch(base + path, { method, signal: AbortSignal.timeout(30000), headers: { 'content-type': 'application/json', 'x-realbud-session': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json(); assert.equal(response.status, expected, `${path}: ${JSON.stringify(result)}`); return result;
}
async function prepareRuntime() {
  assert.ok(process.env.REALBUD_TEST_HERMES_RUNTIME?.trim(), 'Set REALBUD_TEST_HERMES_RUNTIME to the admitted native source runtime; no private profile is discovered or copied.');
  admittedRuntime = realpathSync(resolve(process.env.REALBUD_TEST_HERMES_RUNTIME));
  assert.ok(statSync(admittedRuntime).isDirectory(), 'The admitted runtime must be a directory.');
  const serviceSource = readFileSync(admissionModule, 'utf8');
  pin = serviceSource.match(/export const MEMORY_REVIEW_RUNTIME = '([a-f0-9]{40})'/)?.[1];
  const moduleBlock = serviceSource.match(/export const MEMORY_REVIEW_NATIVE_FILES = \{([\s\S]*?)\}(?: as const)?;/)?.[1];
  assert.ok(pin && moduleBlock, 'The service must declare its reviewed native module hashes.');
  const modules = [...moduleBlock.matchAll(/'([a-zA-Z0-9_/]+\.py)': '([a-f0-9]{64})'/g)].map(match => [match[1], match[2]]);
  assert.ok(modules.length >= 6 && modules.length <= 8, 'Review any change to the admitted native module inventory before extending this QA fixture.');
  for (const dependency of ['tools/__init__.py', 'tools/registry.py']) assert.ok(modules.some(([name]) => name === dependency), `Native dependency must be declared in the selected service admission metadata: ${dependency}`);
  const runtime = join(hermes, 'runtimes', pin, 'hermes-agent'); nativeFixtureRuntime = runtime;
  for (const [name, expected] of modules) {
    const source = join(admittedRuntime, name), stat = lstatSync(source);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 2 * 1024 ** 2, `Native module is not a regular admitted source file: ${name}`);
    assert.equal(sha(readFileSync(source)), expected, `Native module hash mismatch: ${name}`);
    const destination = join(runtime, name); mkdirSync(dirname(destination), { recursive: true, mode: 0o700 }); copyFileSync(source, destination); chmodSync(destination, 0o600);
    assert.equal(sha(readFileSync(destination)), expected); moduleHashes[name] = expected;
  }
  // Copying no CLI entrypoint keeps ordinary setup/version probes from launching
  // Hermes. Python and dependency directories are read-only bridges to the
  // admitted environment; -I/-B and the service's scrubbed environment are used.
  const venv = join(runtime, 'venv'), sourceVenv = join(admittedRuntime, 'venv'), bin = process.platform === 'win32' ? 'Scripts' : 'bin';
  const python = process.platform === 'win32' ? 'python.exe' : 'python';
  assert.ok(statSync(join(sourceVenv, bin, python)).isFile(), 'Admitted Python interpreter is missing.');
  mkdirSync(join(venv, bin), { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    // A venv Windows executable is a redirector; copying it requires no symlink
    // privilege and pyvenv.cfg retains the admitted interpreter location.
    copyFileSync(join(sourceVenv, bin, python), join(venv, bin, python));
  } else symlinkSync(join(sourceVenv, bin, python), join(venv, bin, python));
  copyFileSync(join(sourceVenv, 'pyvenv.cfg'), join(venv, 'pyvenv.cfg')); chmodSync(join(venv, 'pyvenv.cfg'), 0o600);
  for (const name of ['lib', 'lib64', 'Lib', 'DLLs']) if (!existsSync(join(venv, name)) && existsSync(join(sourceVenv, name)) && statSync(join(sourceVenv, name)).isDirectory()) symlinkSync(join(sourceVenv, name), join(venv, name), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(existsSync(join(venv, bin, process.platform === 'win32' ? 'hermes.exe' : 'hermes')), false, 'The fixture must not have a Hermes CLI.');
  write(join(hermes, 'realbud-runtime.json'), JSON.stringify({ version: 1, selected: pin, previous: null, previousAvailable: false }));
}
async function start() {
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening'); port = listener.address().port; await new Promise(done => listener.close(done)); base = `http://127.0.0.1:${port}`;
  child = spawn(executable, [bootstrap], { cwd: serviceCwd, env: { ...serviceSmokeEnv({ executable, home: data, data, scratch: temp, port }), REALBUD_MANAGED_SERVICE: '1', REALBUD_TEST_LAB: '1', OMB_STATIC_DIR: staticDirectory }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let spawnError; child.once('error', error => { spawnError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-20000); });
  for (let attempt = 0; attempt < 150; attempt++) {
    if (spawnError) throw spawnError;
    assert.ok(child.exitCode === null && child.signalCode === null, `The owned bootstrap exited before readiness: ${logs}`);
    try { const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) }); const health = await response.json(); if (health.app === 'realbud' && health.pid === child.pid) { token = (await (await fetch(base + '/api/session')).json()).token; assert.ok(typeof token === 'string' && token.length > 0); return; } } catch {}
    await wait(100);
  }
  throw new Error('The owned bootstrap did not become ready.');
}
function peerState() {
  try { const result = JSON.parse(readFileSync(peerOutput, 'utf8')); assert.ok(Number.isSafeInteger(result.pid) && result.pid > 1); ownedPeers.add(result.pid); peerStateFinal = result; return result; } catch { return null; }
}
async function until(read, label) {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    assert.ok(!child || (child.exitCode === null && child.signalCode === null), `Owned bootstrap exited during ${label}.`);
    const result = await read(); if (result !== false) return result;
    await wait(50);
  }
  throw new Error(`Timed out during ${label}.`);
}
function prepareProposalFixture() {
  assert.notEqual(process.platform, 'win32', 'The native memory proposal workflow is held pending Windows acceptance.');
  const peerSource = join(root, 'server/testing/memory-proposal-acp-cli.mjs'), peerCopy = join(temp, 'fictional-acp-peer.mjs');
  write(peerCopy, readFileSync(peerSource));
  peerCli = join(nativeFixtureRuntime, 'venv', 'bin', 'hermes');
  // Only the version identity is synthesized for the readiness fixture. All
  // prompt handling is the separate, explicitly fictional ACP peer.
  write(peerCli, `#!${process.execPath}\nif (process.argv.includes('--version')) console.log('Hermes Agent v0.21.3 (2026.9.14)'); else await import(${JSON.stringify(pathToFileURL(peerCopy).href)});\n`); chmodSync(peerCli, 0o700);
  write(join(data, 'config.json'), JSON.stringify({ instances: { hermes: { driver: 'hermesAgent', config: { cli: peerCli, fullAuto: true }, environment: { FAKE_MEMORY_SCRIPT: proposalScript, FAKE_MEMORY_OUTPUT: peerOutput } } } }));
  write(join(data, 'bots.json'), JSON.stringify([{ id: 'bud', threadId: 'memory-proposal-browser-chat', name: 'Bud', title: '', description: '', notifications: false, color: 'green', unread: false, modelSelection: { instanceId: 'hermes', model: 'default' }, resumeCursors: {}, createdAt: 1 }]));
  // A throwaway issuer grants only reasoning for this fictional managed host;
  // its private key remains in this process and is never persisted.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const now = Date.now(), companyId = 'fictional-memory-qa', hostInstallationId = 'fictional-memory-qa-host';
  const payload = JSON.stringify({ schema: 1, licenseId: 'fictional-memory-qa-grant', companyId, hostInstallationId, issuedAt: now - 1000, notBefore: now - 1000, expiresAt: now + 3600000, capabilities: ['reasoning'] });
  write(join(data, 'service-installation.json'), JSON.stringify({ schema: 1, companyId, hostInstallationId }));
  write(join(data, 'service-trust-keys.json'), JSON.stringify({ schema: 1, keys: [{ keyId: 'fictional-memory-qa-key', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) }] }));
  write(join(data, 'service-entitlement.json'), JSON.stringify({ schema: 1, keyId: 'fictional-memory-qa-key', payload, signature: sign(null, Buffer.from(payload), privateKey).toString('base64url') }));
  const suffix = packaged ? 'js' : 'ts', selectedRoot = packaged ? resources : root;
  const provision = `const {applyPropertyPack} = await import(${JSON.stringify(pathToFileURL(join(selectedRoot, 'server', `hermes-pack.${suffix}`)).href)}); const {hermesReadinessFingerprint} = await import(${JSON.stringify(pathToFileURL(join(selectedRoot, 'server', `hermes-status.${suffix}`)).href)}); const {writeFileSync} = await import('node:fs'); applyPropertyPack(${JSON.stringify(hermes)}); writeFileSync(${JSON.stringify(join(data, 'hands-ping.json'))}, JSON.stringify({at:Date.now(),ok:true,kind:'ping',detail:'Fictional ACP readiness fixture; no model tested.',workerFingerprint:hermesReadinessFingerprint('Hermes Agent v0.21.3 (2026.9.14)',${JSON.stringify(hermes)})}),{mode:0o600});`;
  const provisioned = spawnSync(executable, ['--input-type=module', '-e', provision], { cwd: serviceCwd, env: serviceSmokeEnv({ executable, home: data, data, scratch: temp, port: 0 }), encoding: 'utf8', timeout: 15000, maxBuffer: 16384 });
  assert.equal(provisioned.error, undefined, 'Fictional readiness provisioning failed.'); assert.equal(provisioned.status, 0, `Fictional readiness provisioning failed: ${provisioned.stderr}`);
}
async function proposeThroughAsk(input) {
  const previous = peerState()?.calls.length ?? 0;
  write(proposalScript, JSON.stringify({ input }));
  await page.goto(base + '/#/ask');
  const composer = page.getByRole('textbox', { name: 'Tell Bud what outcome you need', exact: true });
  await composer.fill('Propose the fictional conversation preference for human review.');
  await page.getByRole('button', { name: 'Start this work', exact: true }).click({ timeout: 30000 });
  const peer = await until(() => { const state = peerState(); return state && state.calls.length > previous ? state : false; }, 'rendered Ask proposal result');
  await until(async () => !(await request('/api/bots')).bots.find(bot => bot.id === 'bud').busy, 'rendered Ask completion');
  const result = peer.calls.at(-1).result;
  assert.notEqual(result.isError, true, 'The actual private proposal broker must accept the fictional preference.');
  const value = JSON.parse(result.content[0].text);
  assert.deepEqual(value, { version: 1, id: value.id, reviewLocation: 'You → Bud → Bud’s memory' }); assert.match(value.id, /^[0-9a-f]{8}$/);
  assert.deepEqual(result.structuredContent, value);
  assert.ok(peer.discovery.every(names => names.length === 1 && names[0] === 'memory_propose'), 'The peer discovers proposal authority only.');
  await page.getByText('Review the fictional proposal in Bud memory.', { exact: true }).last().waitFor();
  return value.id;
}
async function drainPeers() {
  if (!memoryProposals) return;
  peerState();
  const exited = pid => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };
  for (let attempt = 0; attempt < 150 && ![...ownedPeers].every(exited); attempt++) await wait(40);
  peerDrained = [...ownedPeers].every(exited);
  assert.ok(peerDrained, 'Every owned fictional ACP peer must exit before its profile is deleted.');
}
async function panelAfterLoad() {
  const panel = page.getByRole('region', { name: 'Bud memory reviews', exact: true }); await panel.waitFor();
  await panel.getByText(/reviews shown/).waitFor({ timeout: 30000 }); return panel;
}
function prepareRecoveryFixture(requestId) {
  assert.notEqual(process.platform, 'win32', 'Actual Windows memory recovery remains held pending native acceptance.');
  const identity = JSON.parse(readFileSync(join(data, 'company-installation', 'workspace.json'), 'utf8'));
  assert.equal(identity.workerMemberKey, null, 'The recovery fixture must remain the fictional solo workspace.');
  const rootKey = readFileSync(join(data, 'desk.key')); assert.equal(rootKey.length, 32);
  const key = createHmac('sha256', rootKey).update(`realbud-memory-review-v1\0${identity.id}\0property`).digest();
  rootKey.fill(0);
  try {
    return prepareInterruptedMemoryFixture({ python: join(nativeFixtureRuntime, 'venv/bin/python'), helperPath, request: {
      version: 1, command: 'propose', workspaceId: identity.id, profileId: 'property', profileDirectory: profile,
      runtimeId: pin, runtimeDirectory: nativeFixtureRuntime, key: key.toString('base64'), scopeId: 'f'.repeat(64),
      input: { requestId, payload: { action: 'add', target: 'memory', content: 'Fictional interrupted proposal; do not publish automatically.' } },
    } });
  } finally { key.fill(0); }
}
async function checkRecoveryUi(expectedMemory) {
  const key = prepareRecoveryFixture('fictional-browser-interrupted-1');
  const initial = (await request(recoveryApi)).items.find(item => item.key === key);
  assert.equal(initial.state, 'interrupted'); assert.match(initial.recoveryDigest, /^[a-f0-9]{64}$/);
  assert.equal((await fetch(base + recoveryApi)).status, 401);
  assert.equal((await fetch(`${base}${recoveryApi}/${key}/close`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedDigest: initial.recoveryDigest }) })).status, 401);
  await page.setViewportSize({ width: 1440, height: 1050 }); await page.reload(); await panelAfterLoad();
  const recovery = page.getByRole('region', { name: 'Interrupted memory proposals', exact: true });
  const rows = recovery.locator('[aria-label="Saved interrupted proposals"]');
  const choose = async key => { await rows.getByRole('button').filter({ hasText: `Interrupted proposal · ${key.slice(0, 8)}` }).click(); };
  const confirmation = recovery.getByLabel('I understand that closing this interrupted proposal stops its retries and does not change saved preferences.', { exact: true });
  const close = recovery.getByRole('button', { name: 'Close interrupted proposal', exact: true });
  const confirmed = recovery.getByText('The saved record confirms this interrupted proposal is closed. Closing it stops retries and does not change saved preferences.', { exact: true });
  await choose(key); assert.equal(await close.isDisabled(), true);
  await recovery.screenshot({ path: join(output, 'memory-interrupted-desktop.png') });
  await confirmation.check(); await close.click(); await confirmed.waitFor({ timeout: 30000 });
  assert.deepEqual(closures, [{ path: `${recoveryApi}/${key}/close`, body: { expectedDigest: initial.recoveryDigest } }]);
  assert.equal(readFileSync(memoryFile, 'utf8'), expectedMemory); assert.equal(readdirSync(pendingDir).length, 0);
  assert.equal((await request(api)).items.length, 2, 'Metadata closure must not add a human decision receipt.');
  assert.equal(JSON.parse(readFileSync(join(profile, '.realbud-memory-reviews', 'proposals', key + '.json'), 'utf8')).state, 'closed');
  pass('Staff discovers an actual prepared crash, explicitly confirms closure and saves a signed closed record without changing memory or adding a decision');

  const lostKey = prepareRecoveryFixture('fictional-browser-interrupted-2');
  const lostRow = (await request(recoveryApi)).items.find(item => item.key === lostKey);
  await recovery.getByRole('button', { name: 'Refresh interrupted proposals', exact: true }).click(); await choose(lostKey);
  await page.setViewportSize({ width: 390, height: 844 }); await confirmation.scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: join(output, 'memory-interrupted-mobile.png') });
  let committed;
  const lostUrl = `${base}${recoveryApi}/${lostKey}/close`;
  await page.route(lostUrl, async route => {
    const response = await route.fetch(); assert.equal(response.status(), 200); committed = await response.json();
    await route.abort('failed'); // Actual native commit, deliberately lost browser response.
  });
  await confirmation.check(); await close.click(); await confirmed.waitFor({ timeout: 30000 }); await page.unroute(lostUrl);
  assert.equal(committed?.key, lostKey); assert.equal(committed?.recoveryDigest, lostRow.recoveryDigest);
  assert.deepEqual(closures[1], { path: `${recoveryApi}/${lostKey}/close`, body: { expectedDigest: lostRow.recoveryDigest } });
  assert.equal(closures.length, 2, 'A lost response must trigger reconciliation GETs, never another POST.');
  assert.equal(await close.count(), 0); assert.equal(readFileSync(memoryFile, 'utf8'), expectedMemory);
  await recovery.screenshot({ path: join(output, 'memory-interrupted-closed-mobile.png') });
  const replay = await request(`${recoveryApi}/${lostKey}/close`, 'POST', { expectedDigest: lostRow.recoveryDigest });
  assert.deepEqual(replay, committed);
  await page.reload(); await panelAfterLoad(); await choose(lostKey);
  await recovery.getByText(/This record was closed/).waitFor(); assert.equal(await close.count(), 0);
  pass('At 390px a committed closure with a deliberately lost reply reconciles the exact saved record, survives reload and emits no duplicate browser POST');

  const heldKey = prepareRecoveryFixture('fictional-browser-interrupted-3');
  const stage = join(profile, '.realbud-memory-reviews', 'proposals', heldKey + '.stage');
  write(stage, 'Fictional payload evidence must be preserved.');
  await recovery.getByRole('button', { name: 'Refresh interrupted proposals', exact: true }).click(); await choose(heldKey);
  await recovery.getByText('This record needs service review. Contact your RealBud administrator. Existing memory and recovery records are preserved.', { exact: true }).waitFor();
  assert.equal(await close.count(), 0); assert.equal(closures.length, 2);
  assert.equal(readFileSync(stage, 'utf8'), 'Fictional payload evidence must be preserved.');
  assert.equal(readFileSync(memoryFile, 'utf8'), expectedMemory); assert.equal((await request(api)).items.length, 2);
  await page.setViewportSize({ width: 1440, height: 1050 }); await recovery.screenshot({ path: join(output, 'memory-interrupted-held-desktop.png') });
  pass('A record with payload evidence is visibly held for service review, offers no closure and preserves every existing byte');
}
async function selectPending(panel) {
  const rows = panel.locator('[aria-label="Saved memory reviews"]');
  const pending = rows.getByRole('button').filter({ hasText: 'Ready for review' }); assert.equal(await pending.count(), 1, 'There should be exactly one pending fictional review.');
  await pending.click(); await panel.getByRole('region', { name: 'After — proposed complete text', exact: true }).waitFor({ timeout: 30000 });
}
try {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Use Node 24 or later.');
  assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE to the installed Playwright module.');
  if (packaged) {
    assert.ok(process.env.REALBUD_QA_RESOURCES?.trim() && process.env.REALBUD_QA_EXECUTABLE?.trim(), 'Packaged QA requires both REALBUD_QA_RESOURCES and REALBUD_QA_EXECUTABLE.');
    resources = realpathSync(resolve(process.env.REALBUD_QA_RESOURCES)); executable = realpathSync(resolve(process.env.REALBUD_QA_EXECUTABLE));
    assert.ok(statSync(resources).isDirectory(), 'Packaged resources must be a directory.');
    bootstrap = join(resources, 'server/bootstrap.js'); staticDirectory = join(resources, 'ui'); serviceCwd = resources;
    admissionModule = join(resources, 'server/hermes-memory-review.js'); helperPath = join(resources, 'server/helpers/hermes-memory-review.py');
    proposalHelperPath = join(resources, 'server/helpers/hermes-memory-proposals.py');
    for (const path of [executable, bootstrap, admissionModule, helperPath, ...(memoryProposals || memoryRecovery ? [proposalHelperPath, join(resources, 'server/hermes-memory-proposal-broker.js'), join(resources, 'shared/hermes-memory-proposal.js')] : []), ...(memoryRecovery ? [join(resources, 'shared/hermes-memory-recovery.js')] : []), join(staticDirectory, 'index.html')]) assert.ok(statSync(path).isFile(), `Required packaged input is missing or invalid: ${path}`);
    const collect = directory => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name), name = relative(resources, path).split(sep).join('/');
        if (entry.isDirectory()) collect(path);
        else if (entry.isSymbolicLink()) resourceHashes[name] = `symlink:${readlinkSync(path)}`;
        else { assert.ok(entry.isFile(), `Unsupported packaged input type: ${name}`); resourceHashes[name] = sha(readFileSync(path)); }
      }
    };
    for (const name of ['server', 'shared', 'src', 'ui', 'pack']) collect(join(resources, name));
    executableHash = sha(readFileSync(executable));
    const probe = spawnSync(executable, ['-e', 'console.log(JSON.stringify({node:process.versions.node,electron:process.versions.electron??null}))'], {
      cwd: resources, env: serviceSmokeEnv({ executable, home: data, data, scratch: temp, port: 0 }), encoding: 'utf8', timeout: 10000, maxBuffer: 16384, windowsHide: true,
    });
    assert.equal(probe.error, undefined, 'Requested packaged runtime could not be started.'); assert.equal(probe.status, 0, `Requested packaged runtime probe failed: ${probe.stderr}`);
    runtime = JSON.parse(probe.stdout.trim());
    assert.ok(typeof runtime.node === 'string' && typeof runtime.electron === 'string', 'Packaged mode must execute the specified Electron binary in Node mode.');
  } else {
    assert.ok(existsSync(join(staticDirectory, 'index.html')), 'Build the current UI before running this check.');
    assert.ok(existsSync(helperPath), 'The native memory helper must exist before this real bootstrap check can run.');
    for (const path of ['server/hermes-memory-review.ts', 'server/helpers/hermes-memory-review.py', 'shared/hermes-memory-review.ts', 'src/components/MemoryReviewPanel.tsx', 'src/components/YouPage.tsx', 'dist/index.html']) sourceHashes[path] = sha(readFileSync(join(root, path)));
  }
  if (memoryProposals && !packaged) for (const path of ['server/index.ts', 'server/contracts.ts', 'server/drivers/acp/core.ts', 'server/hermes-pack.ts', 'server/hermes-status.ts', 'server/hermes-memory-proposal-broker.ts', 'server/helpers/hermes-memory-proposals.py', 'shared/hermes-memory-proposal.ts']) sourceHashes[path] = sha(readFileSync(join(root, path)));
  if (memoryRecovery && !packaged) for (const path of ['server/index.ts', 'server/service-admin.ts', 'server/hermes-memory-proposal-broker.ts', 'server/helpers/hermes-memory-proposals.py', 'shared/hermes-memory-recovery.ts', 'src/components/MemoryRecoveryPanel.tsx', 'server/hermes-profile-storage.ts', 'server/hermes-pack.ts', 'server/hermes-bridge.ts', 'server/windows-file-privacy.ts']) sourceHashes[path] = sha(readFileSync(join(root, path)));
  if (memoryProposals) fixtureSourceHashes['server/testing/memory-proposal-acp-cli.mjs'] = sha(readFileSync(join(root, 'server/testing/memory-proposal-acp-cli.mjs')));
  // This source helper only derives a synthetic password verifier for fixture
  // provisioning. It is never an application runtime or packaged fallback.
  for (const path of ['scripts/qa-hermes-memory-review.mjs', 'scripts/service-smoke-env.mjs', 'server/service-admin.ts', 'shared/service-admin.ts']) fixtureSourceHashes[path] = sha(readFileSync(join(root, path)));
  if (memoryRecovery) fixtureSourceHashes['server/testing/memory-prepared-fixture.mjs'] = sha(readFileSync(join(root, 'server/testing/memory-prepared-fixture.mjs')));
  await prepareRuntime();
  const literal = 'Use Australian English.\n  Keep literal <em>markup</em> and **asterisks**.\nFictional long line: ' + '0123456789'.repeat(18);
  const before = `Prefers concise updates.\n§\n${literal}`;
  const replacement = 'Prefers detailed updates.\n  Preserve two leading spaces and a tab:\tfixture.';
  const expectedAfter = `${replacement}\n§\n${literal}`;
  write(join(data, 'config.json'), JSON.stringify({ instances: { fixture: { driver: 'not-a-real-driver' } } }));
  write(join(data, 'service-admin.json'), JSON.stringify({ version: 1, passwordVerifier: await createServiceAdminPasswordVerifier('Fictional-memory-QA-administration-only-2026') }));
  write(join(profile, 'SOUL.md'), 'Fictional test profile. No model connection or work execution.\n');
  write(join(profile, 'config.yaml'), 'approvals:\n  mode: manual\ncron_mode: deny\nmemory:\n  write_approval: true\n  memory_enabled: true\n  user_profile_enabled: true\n  memory_char_limit: 2200\n  user_char_limit: 1375\n');
  write(memoryFile, before);
  proposalInputs.first = { requestId: 'browser-preference-replacement-1', payload: { action: 'replace', target: 'memory', old_text: 'concise', content: replacement } };
  if (memoryProposals) prepareProposalFixture(); else proposal(first, proposalInputs.first.payload);
  await start();
  assert.equal((await fetch(base + api)).status, 401);
  const anonymousDecision = await fetch(`${base}${api}/${first}/decision`, { method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedDigest: 'a'.repeat(64), decision: 'approve' }) });
  assert.equal(anonymousDecision.status, 401); assert.equal(readFileSync(memoryFile, 'utf8'), before);
  pass('Both memory reads and decisions reject a missing renderer session before exposing or changing preference data');
  const administration = await request('/api/service-admin/status');
  assert.equal(administration.managed, true); assert.equal(administration.configured, true); assert.equal(administration.authenticated, false);
  const modelDenied = await request('/api/hermes/model', 'POST', { provider: 'fictional-provider', model: 'fictional-model' }, 401); assert.equal(modelDenied.code, 'service_admin_required');
  const setupDenied = await request('/api/hermes/oauth/status', 'GET', undefined, 403); assert.equal(setupDenied.code, 'service_admin_required');
  pass('Managed administrator protection is configured; ordinary staff cannot mutate provider settings or read provider login codes');
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' });
  await context.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === base) return route.continue(); blockedNetwork.push({ origin: url.origin, method: route.request().method() }); return route.abort(); });
  await context.addInitScript(() => localStorage.setItem('realbud.first-run-done', '1'));
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { const url = new URL(request.url()); if (url.origin === base && request.headers()['x-realbud-service-admin']) adminHeadersSeen++; if (url.origin === base && url.pathname.startsWith(`${api}/`) && url.pathname.endsWith('/decision') && request.method() === 'POST') decisions.push({ path: url.pathname, body: request.postDataJSON() }); if (url.origin === base && url.pathname.startsWith(`${recoveryApi}/`) && url.pathname.endsWith('/close') && request.method() === 'POST') closures.push({ path: url.pathname, body: request.postDataJSON() }); });
  if (memoryProposals) {
    assert.equal((await request('/api/hermes')).ready, true, 'The synthetic ACP readiness record must match the actual selected profile.');
    assert.deepEqual((await request(api)).items, []);
    first = await proposeThroughAsk(proposalInputs.first);
    const pending = JSON.parse(readFileSync(join(pendingDir, `${first}.json`), 'utf8'));
    assert.equal(pending.origin, 'foreground'); assert.equal(pending.subsystem, 'memory'); assert.deepEqual(pending.payload, proposalInputs.first.payload);
    assert.equal(readFileSync(memoryFile, 'utf8'), before);
    await page.screenshot({ path: join(output, 'memory-proposal-ask-desktop.png') });
    pass('Rendered Ask invokes actual ACP core, proposal-only MCP and native publication; one foreground review is pending and memory is unchanged');
    assert.equal(await proposeThroughAsk(proposalInputs.first), first);
    assert.deepEqual(readdirSync(pendingDir).filter(name => name.endsWith('.json')), [`${first}.json`]); assert.equal(readFileSync(memoryFile, 'utf8'), before);
    pass('A second rendered Ask with the same request identity returns the same durable review without duplicate pending work');
  }
  const list = await request(api); assert.ok(list.items.some(item => item.id === first && item.state === 'pending'));
  const reviewed = await request(`${api}/${first}`); assert.equal(reviewed.before, before); assert.equal(reviewed.after, expectedAfter);
  pass(`Actual ${packaged ? 'packaged' : 'source'} bootstrap and authenticated HTTP produce a complete native replacement preview in a disposable profile`);
  await page.goto(base + '/#/you'); let panel = await panelAfterLoad(); await selectPending(panel);
  const beforeRegion = panel.getByRole('region', { name: 'Before — currently saved', exact: true }), afterRegion = panel.getByRole('region', { name: 'After — proposed complete text', exact: true });
  assert.equal(await beforeRegion.textContent(), before); assert.equal(await afterRegion.textContent(), expectedAfter);
  assert.equal(await beforeRegion.locator('em, strong, a, script').count(), 0); assert.equal(await afterRegion.locator('em, strong, a, script').count(), 0);
  assert.equal(await panel.getByRole('button', { name: 'Apply reviewed change', exact: true }).isDisabled(), true);
  await panel.screenshot({ path: join(output, 'memory-review-before-after-desktop.png') });
  pass('Built settings UI shows all literal before/after text and keeps Apply disabled until the exact-version checkbox is checked');
  await page.setViewportSize({ width: 390, height: 844 }); await beforeRegion.focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await beforeRegion.evaluate(element => element === document.activeElement), true); assert.equal(await beforeRegion.getAttribute('tabindex'), '0');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'The mobile document must not overflow horizontally.');
  assert.ok(await beforeRegion.evaluate(element => element.scrollWidth > element.clientWidth), 'The long literal line should scroll inside its own region.');
  await afterRegion.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(output, 'memory-review-before-after-mobile.png') });
  pass('At 390px the complete text remains keyboard focusable and scrolls within its region without overflowing the document');
  await panel.getByLabel('I reviewed the complete before and after text and approve this exact version once.', { exact: true }).check();
  const applyButton = panel.getByRole('button', { name: 'Apply reviewed change', exact: true });
  const contrast = await applyButton.evaluate(element => {
    const style = getComputedStyle(element), canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    const luminance = color => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
      const rgb = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
      return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    };
    const foreground = luminance(style.color), background = luminance(style.backgroundColor);
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
  assert.ok(contrast >= 4.5, 'The enabled Apply action must have a readable label against its own background.');
  await applyButton.click();
  await panel.getByText('The saved result confirms this memory change was applied. Start a new conversation to use the updated preferences.', { exact: true }).waitFor({ timeout: 30000 });
  assert.deepEqual(decisions, [{ path: `${api}/${first}/decision`, body: { expectedDigest: reviewed.reviewDigest, decision: 'approve' } }]);
  assert.equal(readFileSync(memoryFile, 'utf8'), expectedAfter); assert.equal(existsSync(join(pendingDir, `${first}.json`)), false);
  assert.ok((await request(api)).items.some(item => item.id === first && item.state === 'applied'));
  pass('The UI dispatches one exact reviewed digest, the native file changes to the complete preview, and the persisted receipt confirms application');
  await page.setViewportSize({ width: 1440, height: 1050 }); await page.reload(); panel = await panelAfterLoad();
  await panel.locator('[aria-label="Saved memory reviews"]').getByRole('button').filter({ hasText: /Saved$/ }).click();
  await panel.getByText('This memory decision is saved. Start a new conversation to use the updated preferences.', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Apply reviewed change', exact: true }).count(), 0);
  await panel.screenshot({ path: join(output, 'memory-review-saved-desktop.png') });
  pass('Reload rediscovers the persisted decision and offers no second Apply action for a completed review');
  proposalInputs.second = { requestId: 'browser-preference-replacement-2', payload: { action: 'replace', target: 'memory', old_text: 'detailed', content: 'Prefers a weekly update.' } };
  if (memoryProposals) {
    assert.equal(await proposeThroughAsk(proposalInputs.first), first);
    assert.equal(existsSync(join(pendingDir, `${first}.json`)), false); assert.equal(readFileSync(memoryFile, 'utf8'), expectedAfter);
    assert.ok((await request(api)).items.some(item => item.id === first && item.state === 'applied'));
    pass('A rendered conversation retry after approval returns the saved identity and never recreates completed pending work');
    second = await proposeThroughAsk(proposalInputs.second);
    await page.goto(base + '/#/you'); panel = await panelAfterLoad();
  } else {
    proposal(second, proposalInputs.second.payload);
    await panel.getByRole('button', { name: 'Refresh memory reviews', exact: true }).click();
  }
  await panel.getByText('2 of 2 reviews shown', { exact: true }).waitFor(); await selectPending(panel);
  const stalePreview = await request(`${api}/${second}`);
  const newer = `${expectedAfter}\n§\nNewer fictional preference added after this preview.`; write(memoryFile, newer);
  await panel.getByLabel('I reviewed the complete before and after text and approve this exact version once.', { exact: true }).check();
  const staleResponse = page.waitForResponse(response => new URL(response.url()).pathname === `${api}/${second}/decision` && response.request().method() === 'POST');
  await panel.getByRole('button', { name: 'Apply reviewed change', exact: true }).click();
  const rejectedStale = await staleResponse; assert.equal(rejectedStale.status(), 409); assert.equal((await rejectedStale.json()).code, 'stale-review');
  await panel.getByText('Saved reviews checked. Review the current state before continuing.', { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(readFileSync(memoryFile, 'utf8'), newer); assert.equal(existsSync(join(pendingDir, `${second}.json`)), true);
  assert.equal(await panel.getByRole('region', { name: 'After — proposed complete text', exact: true }).count(), 0);
  assert.deepEqual(decisions[1], { path: `${api}/${second}/decision`, body: { expectedDigest: stalePreview.reviewDigest, decision: 'approve' } });
  assert.ok((await request(api)).items.some(item => item.id === second && item.state === 'pending'));
  pass('Changing saved memory after preview rejects the stale approval, preserves the newer bytes and proposal, and clears the old confirmation');
  await panel.getByRole('button', { name: 'Review complete change', exact: true }).click();
  await panel.getByRole('region', { name: 'After — proposed complete text', exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await panel.getByRole('region', { name: 'Before — currently saved', exact: true }).textContent(), newer);
  assert.equal(await panel.getByRole('button', { name: 'Apply reviewed change', exact: true }).isDisabled(), true);
  const latest = await request(`${api}/${second}`); assert.notEqual(latest.reviewDigest, stalePreview.reviewDigest);
  await panel.getByRole('button', { name: 'Reject this proposal', exact: true }).click();
  await panel.getByText('This proposal was rejected. Your saved preferences were not changed.', { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(readFileSync(memoryFile, 'utf8'), newer); assert.equal(existsSync(join(pendingDir, `${second}.json`)), false);
  assert.equal(decisions.length, 3); assert.deepEqual(decisions[2], { path: `${api}/${second}/decision`, body: { expectedDigest: latest.reviewDigest, decision: 'reject' } });
  assert.ok((await request(api)).items.some(item => item.id === second && item.state === 'rejected'));
  await page.setViewportSize({ width: 390, height: 844 }); await panel.scrollIntoViewIfNeeded(); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: join(output, 'memory-review-rejected-mobile.png') });
  pass('A newly reviewed rejection uses its new digest, preserves memory and records the rejected result');
  if (memoryRecovery) await checkRecoveryUi(newer);
  assert.deepEqual(errors, []); assert.deepEqual(blockedNetwork, []); assert.equal(adminHeadersSeen, 0, 'All browser decisions must use ordinary staff authority.');
  assert.equal((await request('/api/service-admin/status')).authenticated, false);
  for (const [name, expected] of Object.entries(moduleHashes)) assert.equal(sha(readFileSync(join(admittedRuntime, name))), expected, `Admitted source module changed: ${name}`);
  for (const [name, expected] of Object.entries(sourceHashes)) assert.equal(sha(readFileSync(join(root, name))), expected, `Application input changed during QA: ${name}`);
  for (const [name, expected] of Object.entries(fixtureSourceHashes)) assert.equal(sha(readFileSync(join(root, name))), expected, `QA fixture input changed during run: ${name}`);
  if (packaged) {
    assert.equal(sha(readFileSync(executable)), executableHash, 'Packaged executable changed during QA.');
    for (const [name, expected] of Object.entries(resourceHashes)) assert.equal(expected.startsWith('symlink:') ? `symlink:${readlinkSync(join(resources, name))}` : sha(readFileSync(join(resources, name))), expected, `Packaged input changed during QA: ${name}`);
  }
  pass('No page errors, off-origin browser requests or admitted source changes occurred');
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
  await page?.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await browser?.close().catch(() => {}); await stop();
  try { await drainPeers(); rmSync(temp, { recursive: true, force: true }); cleanup = !existsSync(temp); } catch (error) { failure ||= `Fixture cleanup failed: ${error instanceof Error ? error.message : String(error)}`; }
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ at: new Date().toISOString(), passed: !failure && cleanup, node: process.version, platform: process.platform, mode: packaged ? 'packaged' : 'source', memoryProposals, memoryRecovery, executable, executableHash, resources, bootstrap, staticDirectory, admissionModule, helperPath, ...(memoryProposals ? { proposalHelperPath, peerCli, peerDrained, ownedPeerCount: ownedPeers.size, peer: peerStateFinal, readiness: 'Fictional ACP version and fingerprint-bound success record; this run does not test real model readiness.', entitlement: 'Managed, required, independently signed throwaway host grant for reasoning only.' } : {}), runtime, runtimePin: pin, nativeModules: moduleHashes, sourceHashes, resourceHashes, fixtureSourceHashes, fixtureSetup: `Source createServiceAdminPasswordVerifier is used only to provision a fictional managed-admin verifier; no source service/UI/helper fallback is available in packaged mode.${memoryProposals ? ' The fixture ACP peer runs separately on the QA Node runtime. Selected source or compiled packaged modules provision the fictional profile policy and fingerprint-bound readiness fixture.' : ''}${memoryRecovery ? ' Recovery fixtures stop the actual helper after durable signed preparation; only disposable workspace keys are read to construct that test request.' : ''}`, checks, errors, blockedNetwork, decisions, closures, adminHeadersSeen, cleanup,
    layer: `${packaged ? 'Actual specified packaged Electron/Node executable, compiled bootstrap, bundled UI and packaged memory helper' : 'Actual source bootstrap and built React UI'}; authenticated HTTP and admitted native memory modules in a fictional disposable profile.${memoryProposals ? ' Rendered Ask dispatches actual application ACP and private proposal MCP to the native helper; only the ACP peer and readiness are fictional.' : ''} No real Hermes CLI, model/provider calls, customer accounts, installed-device restart IPC, OS keychain or Windows device acceptance.`,
    failure, ...(failure ? { diagnostic: logs } : {}) }, null, 2), { mode: 0o600 });
  if (failure) { console.error(failure); process.exitCode = 1; } else console.log(JSON.stringify({ output, checks: checks.length, cleanup }, null, 2));
}
