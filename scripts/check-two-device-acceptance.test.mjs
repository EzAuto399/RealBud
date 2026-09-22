import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { checkEvidence, createTemplate, loadContract } from './check-two-device-acceptance.mjs';

const contract = loadContract();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// These receipts deliberately simulate structure. Passing checker tests are
// never reported as installed-device observations or product acceptance.
function fixture(t, target = 'macos-rehearsal') {
  const dir = mkdtempSync(path.join(tmpdir(), 'realbud-receipt-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bytes = 'Synthetic checker fixture only. No desktop was operated.\n';
  writeFileSync(path.join(dir, 'observation.txt'), bytes);
  const files = () => [{ path: 'observation.txt', sha256: digest(bytes) }];
  const record = createTemplate(contract, target);
  Object.assign(record, { sourceManifestSha256: 'a'.repeat(64), protocolVersion: 'fixture-1', reviewerAlias: 'fixture-reviewer', reviewedAt: '2026-09-15T03:00:00Z' });
  for (const pair of record.pairings) {
    pair.companyAlias = 'fictional-company';
    for (const d of pair.devices) Object.assign(d, {
      memberAlias: `member-${d.slot}`, deviceAlias: `${pair.id}-${d.slot}`, providerUserAlias: `provider-${d.slot}`,
      osVersion: d.os === 'windows' ? 'Windows 11 24H2' : 'macOS fixture',
      environment: d.os === 'windows' ? 'interactive-vm' : 'physical', artifactSha256: 'b'.repeat(64),
      hermesVersion: 'fixture-version', hermesCommit: 'c'.repeat(40), cuaVersion: 'fixture-version',
    });
    for (const run of pair.workflowRuns) Object.assign(run, {
      status: 'pass', proofLayer: 'installed-device', jobId: `${pair.id}-${run.id}`, attemptId: 'attempt-1',
      companyAlias: pair.companyAlias, workerContextAlias: `context-${run.member}`, executionDeviceAlias: `${pair.id}-${run.member}`,
      providerUserAlias: `provider-${run.member}`, connectedAccountAlias: `mail-${run.member}`,
      resultReceiptId: `result-${pair.id}-${run.id}`, executionRoute: 'company-managed-hermes', evidence: files(),
    });
    for (const check of pair.checks) Object.assign(check, { status: 'pass', proofLayer: 'installed-device', evidence: files() });
  }
  return { dir, record, check: (value = record, scope = target) => checkEvidence(value, contract, { target: scope, evidenceRoot: dir }) };
}

test('blank templates fail closed and neither mutate nor accept the operational catalogue', t => {
  const f = fixture(t), template = createTemplate(contract, 'macos-rehearsal');
  const before = structuredClone(template);
  assert.equal(f.check(template).evidenceComplete, false);
  assert.deepEqual(template, before);
  assert.equal(template.pairings[0].workflowRuns.length, 6);
  assert.equal(template.pairings[0].checks.length, 70);
  assert.equal(createTemplate(contract, 'full-platform').pairings.length, 4);
});

test('a complete synthetic record proves only checker structure and integrity, not office readiness', t => {
  const f = fixture(t), result = f.check();
  assert.deepEqual(result.issues, []);
  assert.equal(result.evidenceComplete, true);
  assert.equal(Object.hasOwn(result, 'officeReady'), false);
  assert.match(result.verification, /does not grant release/);
});

test('the second independent bills workflow cannot be replaced by the handoff case', t => {
  const f = fixture(t);
  f.record.pairings[0].workflowRuns = f.record.pairings[0].workflowRuns.filter(r => r.id !== 'bills-b');
  const result = f.check();
  assert.equal(result.evidenceComplete, false);
  assert(result.issues.some(i => i.includes('bills-b')));
});

for (const proofLayer of ['simulation', 'local-integration', 'ci', null]) test(`${proofLayer} cannot substitute for native observations`, t => {
  const f = fixture(t);
  f.record.pairings[0].workflowRuns[0].proofLayer = proofLayer;
  assert.equal(f.check().evidenceComplete, false);
});

test('same identity, source account or private worker context fails isolation coverage', t => {
  const f = fixture(t);
  for (const change of [
    pair => { pair.devices[1].memberAlias = pair.devices[0].memberAlias; },
    pair => { pair.devices[1].providerUserAlias = pair.devices[0].providerUserAlias; },
    pair => { pair.workflowRuns[1].connectedAccountAlias = pair.workflowRuns[0].connectedAccountAlias; },
    pair => { pair.workflowRuns[1].workerContextAlias = pair.workflowRuns[0].workerContextAlias; },
    pair => { pair.workflowRuns[1].companyAlias = 'different-company'; },
  ]) {
    const record = structuredClone(f.record); change(record.pairings[0]);
    assert.equal(f.check(record).evidenceComplete, false);
  }
});

test('wrong executing device, reused job, missing result and unmanaged worker fail', t => {
  const f = fixture(t);
  for (const change of [
    pair => { pair.workflowRuns[1].executionDeviceAlias = pair.devices[0].deviceAlias; },
    pair => { pair.workflowRuns[1].jobId = pair.workflowRuns[0].jobId; },
    pair => { pair.workflowRuns[1].resultReceiptId = null; },
    pair => { pair.workflowRuns[1].resultReceiptId = pair.workflowRuns[0].resultReceiptId; },
    pair => { pair.workflowRuns[1].executionRoute = 'standalone-hermes'; },
  ]) {
    const record = structuredClone(f.record); change(record.pairings[0]);
    assert.equal(f.check(record).evidenceComplete, false);
  }
});

test('Stop requested, a missing recovery case or only one observed device cannot pass', t => {
  const f = fixture(t);
  for (const change of [
    pair => { pair.checks.find(c => c.caseId === 'OP-050').status = 'stop-requested'; },
    pair => { pair.checks.find(c => c.caseId === 'OP-050').participants = ['A']; },
    pair => { pair.checks = pair.checks.filter(c => c.caseId !== 'OP-061'); },
  ]) {
    const record = structuredClone(f.record); change(record.pairings[0]);
    assert.equal(f.check(record).evidenceComplete, false);
  }
});

test('Mac evidence cannot silently weaken the default full-platform target', t => {
  const f = fixture(t);
  const result = checkEvidence(f.record, contract, { evidenceRoot: f.dir });
  assert.equal(result.evidenceComplete, false);
  assert(result.issues.some(i => i.includes('windows-windows')));
});

test('full-platform structure requires all four interactive pairings and Windows 11 x64', t => {
  const f = fixture(t, 'full-platform');
  assert.equal(f.check().evidenceComplete, true);
  for (const change of [
    device => { device.environment = 'ci'; },
    device => { device.architecture = 'arm64'; },
    device => { device.osVersion = 'Windows Server 2025'; },
  ]) {
    const record = structuredClone(f.record); change(record.pairings[1].devices[1]);
    assert.equal(f.check(record).evidenceComplete, false);
  }
});

test('physical Mac rehearsal refuses two simulated or virtual desktops', t => {
  const f = fixture(t);
  f.record.pairings[0].devices[1].environment = 'interactive-vm';
  assert.equal(f.check().evidenceComplete, false);
});

test('changed or missing evidence files fail even when every observation says pass', t => {
  const f = fixture(t);
  writeFileSync(path.join(f.dir, 'observation.txt'), 'changed');
  assert.equal(f.check().evidenceComplete, false);
  rmSync(path.join(f.dir, 'observation.txt'));
  assert.equal(f.check().evidenceComplete, false);
});

test('evidence paths cannot escape through traversal or a symbolic link', t => {
  const f = fixture(t);
  const outside = mkdtempSync(path.join(tmpdir(), 'realbud-outside-evidence-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const file = path.join(outside, 'outside.txt'); writeFileSync(file, 'outside');
  const evidence = f.record.pairings[0].workflowRuns[0].evidence[0];
  evidence.path = path.relative(f.dir, file); evidence.sha256 = digest('outside');
  assert.equal(f.check().evidenceComplete, false);
  symlinkSync(outside, path.join(f.dir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  evidence.path = 'linked/outside.txt';
  assert.equal(f.check().evidenceComplete, false);
});

test('duplicate pairing/case records cannot hide missing observations', t => {
  const f = fixture(t);
  let record = structuredClone(f.record); record.pairings.push(record.pairings[0]);
  assert.equal(f.check(record).evidenceComplete, false);
  record = structuredClone(f.record); record.pairings[0].checks.push(record.pairings[0].checks[0]);
  assert.equal(f.check(record).evidenceComplete, false);
});

test('CLI returns failure for a missing receipt or an unrun template', t => {
  const f = fixture(t), file = path.join(f.dir, 'unrun.json');
  writeFileSync(file, JSON.stringify(createTemplate(contract, 'macos-rehearsal')));
  for (const args of [[file, 'macos-rehearsal'], [path.join(f.dir, 'missing.json')], []]) {
    const result = spawnSync(process.execPath, ['scripts/check-two-device-acceptance.mjs', ...args], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 1);
  }
});

test('contract retains all 71 exact historical cases, four pairings and independent bills runs', () => {
  assert.deepEqual(contract.caseIds, Array.from({ length: 71 }, (_, i) => `OP-${String(i + 1).padStart(3, '0')}`));
  assert.equal(digest(readFileSync(contract.catalogue.path)), 'c91dd8605e3a63049613c60baec7b0ff55f20aa02726ad200a357e45bde8ea15');
  assert.deepEqual(contract.targets, {
    'macos-rehearsal': ['macos-macos'],
    'full-platform': ['macos-macos', 'macos-windows', 'windows-macos', 'windows-windows'],
  });
  assert.deepEqual(contract.workflow_runs, [
    { id: 'morning-a', caseId: 'OP-019', member: 'A' }, { id: 'morning-b', caseId: 'OP-020', member: 'B' },
    { id: 'bills-a', caseId: 'OP-026', member: 'A' }, { id: 'bills-b', caseId: 'OP-026', member: 'B' },
    { id: 'bank-a', caseId: 'OP-032', member: 'A' }, { id: 'bank-b', caseId: 'OP-033', member: 'B' },
  ]);
  assert(createTemplate(contract, 'macos-rehearsal').pairings[0].checks.some(c => c.caseId === 'OP-027'));
});

test('missing, damaged and reduced contracts fail admission with an actionable error', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'realbud-contract-admission-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const gatePath = path.join(directory, 'docs/acceptance/two-device-v1.json');
  const cataloguePath = path.join(directory, contract.catalogue.path);
  mkdirSync(path.dirname(gatePath), { recursive: true });
  assert.throws(() => loadContract({ directory }), /Acceptance contract is missing or inconsistent/);
  cpSync(contract.catalogue.path, cataloguePath);
  const original = JSON.parse(readFileSync('docs/acceptance/two-device-v1.json', 'utf8'));
  for (const change of [
    gate => { gate.schemaVersion = 0; },
    gate => { gate.catalogue.caseCount = 70; },
    gate => { gate.catalogue.sha256 = 'a'.repeat(64); },
    gate => { gate.targets['full-platform'].pop(); },
    gate => { gate.targets['other'] = []; },
    gate => { gate.windows_only_cases.push('OP-050'); },
    gate => { gate.workflow_runs.pop(); },
    gate => { gate.workflow_runs[3].caseId = 'OP-027'; },
    gate => { delete gate.participants_by_case['OP-050']; },
    gate => { gate.participants_by_case['OP-069'] = 'peer'; },
    gate => { gate.participants_by_case['OP-072'] = 'both'; },
  ]) {
    const gate = structuredClone(original); change(gate);
    writeFileSync(gatePath, JSON.stringify(gate));
    assert.throws(() => loadContract({ directory }), /Acceptance contract is missing or inconsistent/);
  }
  writeFileSync(gatePath, JSON.stringify(original));
  assert.equal(loadContract({ directory }).caseIds.length, 71);
  const catalogue = JSON.parse(readFileSync(cataloguePath, 'utf8'));
  catalogue.cases.pop(); catalogue.caseCount--;
  writeFileSync(cataloguePath, JSON.stringify(catalogue));
  assert.throws(() => loadContract({ directory }), /Acceptance contract is missing or inconsistent/);
  writeFileSync(gatePath, '{');
  assert.throws(() => loadContract({ directory }), /Acceptance contract is missing or inconsistent/);
});

test('exported helpers cannot accept a caller-reduced contract or mutate an admitted policy', t => {
  const f = fixture(t);
  const reduced = { ...contract, caseIds: [] };
  assert.throws(() => checkEvidence(f.record, reduced, { evidenceRoot: f.dir }), /verified acceptance contract/);
  assert.throws(() => createTemplate(reduced, 'macos-rehearsal'), /verified acceptance contract/);
  assert.throws(() => contract.caseIds.pop(), TypeError);
  assert.throws(() => { contract.participants_by_case['OP-050'] = 'host'; }, TypeError);
});

test('every case has the explicit reviewed participant policy, including host and peer Windows roles', () => {
  const host = new Set(['OP-001', 'OP-004', 'OP-019', 'OP-032']);
  const peer = new Set(['OP-003', 'OP-020', 'OP-033']);
  for (const id of contract.caseIds) {
    assert.equal(contract.participants_by_case[id], host.has(id) ? 'host' : peer.has(id) ? 'peer' : id === 'OP-069' ? 'windows' : 'both', id);
  }
  const pairs = createTemplate(contract, 'full-platform').pairings;
  for (const pair of pairs) {
    const check = pair.checks.find(c => c.caseId === 'OP-069');
    assert.deepEqual(check?.participants, pair.id === 'macos-macos' ? undefined
      : pair.id === 'windows-windows' ? ['A', 'B'] : pair.id === 'windows-macos' ? ['A'] : ['B']);
  }
});

test('missing required participants, duplicate and unknown slots cannot pass any case', t => {
  const f = fixture(t, 'full-platform');
  for (const pair of f.record.pairings) {
    for (const check of pair.checks) {
      const required = createTemplate(contract, 'full-platform').pairings.find(p => p.id === pair.id).checks.find(c => c.caseId === check.caseId).participants;
      const saved = check.participants;
      for (const participants of [[], ['A', 'B', 'C'], ['A', 'B', 'A'], ...required.map(slot => ['A', 'B'].filter(s => s !== slot))]) {
        check.participants = participants;
        assert.equal(f.check().evidenceComplete, false, `${pair.id}/${check.caseId}/${participants}`);
      }
      check.participants = saved;
    }
  }
});

test('malformed receipt entries fail without crashing the exported checker', t => {
  const f = fixture(t);
  for (const malformed of [null, 123, '', {}, [], true]) {
    assert.equal(f.check(malformed).evidenceComplete, false);
    for (const key of ['devices', 'workflowRuns', 'checks']) {
      const record = structuredClone(f.record);
      record.pairings[0][key][0] = malformed;
      assert.equal(f.check(record).evidenceComplete, false, key);
    }
    const record = structuredClone(f.record);
    record.pairings[0].workflowRuns[0].id = malformed;
    assert.equal(f.check(record).evidenceComplete, false);
  }
});

test('receipts cannot reuse an old schema or another contract digest', t => {
  const f = fixture(t);
  for (const change of [
    record => { record.schemaVersion = 1; },
    record => { delete record.contractSha256; },
    record => { record.contractSha256 = 'a'.repeat(64); },
    record => { record.contractId = 'other'; },
  ]) {
    const record = structuredClone(f.record); change(record);
    assert.equal(f.check(record).evidenceComplete, false);
  }
  for (const target of ['toString', '__proto__', 'unknown']) {
    assert.throws(() => createTemplate(contract, target), /Unknown acceptance target/);
    assert.throws(() => f.check(f.record, target), /Unknown acceptance target/);
  }
});

test('malformed Windows versions and receipt identity fields are reported without coercion crashes', t => {
  const f = fixture(t, 'full-platform');
  for (const value of [null, 123, [], {}, { toString: null }, { toString: 123, valueOf: null }]) {
    for (const key of ['osVersion', 'hermesCommit', 'memberAlias', 'artifactSha256']) {
      const record = structuredClone(f.record);
      record.pairings[1].devices[1][key] = value;
      assert.equal(f.check(record).evidenceComplete, false, key);
    }
  }
});

test('evidence pathname replacement after open is held before reading outside content', { skip: process.platform === 'win32' ? 'POSIX file symlink race; Windows confinement is covered by junction test' : false }, t => {
  const f = fixture(t);
  const outside = mkdtempSync(path.join(tmpdir(), 'realbud-raced-evidence-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const external = path.join(outside, 'outside.txt'); writeFileSync(external, 'foreign');
  const selected = fs.realpathSync(path.join(f.dir, 'observation.txt'));
  const originalOpen = fs.openSync, originalRead = fs.readSync;
  let swapped = false, reads = 0;
  try {
    fs.openSync = (...args) => {
      const descriptor = originalOpen(...args);
      if (args[0] === selected && !swapped) {
        swapped = true; rmSync(selected); symlinkSync(external, selected);
      }
      return descriptor;
    };
    fs.readSync = (...args) => { reads++; return originalRead(...args); };
    syncBuiltinESMExports();
    const result = f.check();
    assert.equal(result.evidenceComplete, false);
    assert(result.issues.some(i => /path changed|escapes/.test(i)));
    assert.equal(swapped, true);
    assert.equal(reads, 0);
  } finally {
    fs.openSync = originalOpen; fs.readSync = originalRead; syncBuiltinESMExports();
  }
});

test('CLI emits bound unrun templates for both targets without changing the catalogue', () => {
  const before = readFileSync(contract.catalogue.path);
  for (const target of ['macos-rehearsal', 'full-platform']) {
    const result = spawnSync(process.execPath, ['scripts/check-two-device-acceptance.mjs', '--template', target], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    const template = JSON.parse(result.stdout);
    assert.equal(template.contractSha256, contract.digest);
    assert(template.pairings.every(p => p.checks.every(c => c.status === 'not-run')));
  }
  assert.deepEqual(readFileSync(contract.catalogue.path), before);
});
