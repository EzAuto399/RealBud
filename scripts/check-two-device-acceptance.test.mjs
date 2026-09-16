import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
    for (const check of pair.checks) Object.assign(check, { status: 'pass', proofLayer: 'installed-device', participants: ['A', 'B'], evidence: files() });
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
