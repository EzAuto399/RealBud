import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileDigest, inspectAuthenticode, qualifyInstalledCandidate, STABLE_WINDOWS_HOLD, validateInstalledReceipt, validateManagedJournal, windowsBuildAdmission } from './windows-candidate.mjs';

const revision = 'a'.repeat(40), root = join(import.meta.dirname, '..');
const admission = (patch = {}) => ({ intent: 'signed-ci-candidate', proof: 'all', workflowRef: 'refs/heads/main', workflowSha: revision, sourceRevision: revision, requestedRef: '', signProfile: 'fictional-reviewed-profile', publisher: 'Fictional Publisher', ...patch });
test('explicit rehearsal is unsigned when signing is unavailable and never creates stable authority', () => {
  assert.deepEqual(windowsBuildAdmission(admission({ intent: 'rehearsal', signProfile: '' })).signing, false);
  assert.equal(windowsBuildAdmission(admission({ intent: 'rehearsal', requestedRef: 'fictional-tag' })).artifactKind, 'windows-rehearsal');
  assert.equal(windowsBuildAdmission(admission()).stablePromotionReady, false);
});
for (const [title, patch] of [
  ['missing signing profile', { signProfile: '' }], ['missing publisher', { publisher: '' }],
  ['diagnostic-only installer', { proof: 'installer' }], ['diagnostic-only runtime', { proof: 'managed-runtime' }],
  ['tag workflow identity', { workflowRef: 'refs/tags/v0.1.46' }], ['different checkout SHA', { sourceRevision: 'b'.repeat(40) }], ['moved requested ref', { requestedRef: 'fictional-tag' }],
]) test(`signed CI candidate refuses ${title} without downgrading`, () => assert.throws(() => windowsBuildAdmission(admission(patch))));
test('stable/public promotion refuses even plausible caller receipt and approval flags', () => {
  assert.throws(() => windowsBuildAdmission(admission({ intent: 'stable-public', signed: true, nativeWorkerPassed: true, physicalDevicePassed: true, upgradePassed: true, restorePassed: true })), error => error.message === STABLE_WINDOWS_HOLD);
});

function installedFixture(work) {
  const dir = mkdtempSync(join(tmpdir(), 'rb-win-qualification-'));
  try {
    const installer = join(dir, 'RealBud-fixture-setup.exe'), application = join(dir, 'RealBud.exe');
    writeFileSync(installer, 'fictional installer bytes'); writeFileSync(application, 'fictional application bytes');
    const children = ['installed-windows.json', 'installed-memory-primitives.json', 'installed-service.json', 'installed-private-backup.json', 'installed-gui.json'];
    for (const file of children) writeFileSync(join(dir, file), JSON.stringify({ passed: true, platform: 'win32', sourceRevision: revision, electron: 'fictional', mode: 'packaged', runtime: { electron: 'fictional' }, checks: ['fictional probe'] }));
    writeFileSync(join(dir, 'installed-gui.json'), JSON.stringify({ ok: true, result: { title: 'RealBud', capabilities: { host: { platform: 'win32' } }, health: { app: 'realbud', static: true }, company: { remoteJoinAvailable: true } } }));
    const lifecycle = { schema: 1, kind: 'realbud-installed-windows-lifecycle', proofLayer: 'installed-runtime-on-disposable-windows-ci', sourceRevision: revision,
      installer: { file: 'RealBud-fixture-setup.exe', bytes: 25, sha256: fileDigest(installer) }, passed: true, failureStage: null,
      installation: { started: true, exitCode: 0, appCreated: true }, probes: { passed: true, gui: { started: true, rendererReady: true, windowObserved: true, exitCode: 0, passed: true }, receipts: children.map(file => ({ file, sha256: fileDigest(join(dir, file)) })) },
      uninstall: { passed: true, exitCode: 0, appRemoved: true, resourcesRemoved: true } };
    lifecycle.installer.bytes = readFileSync(installer).length;
    const persist = () => writeFileSync(join(dir, 'installed-lifecycle.json'), JSON.stringify(lifecycle)); persist();
    const input = { intent: 'signed-ci-candidate', sourceRevision: revision, installer, application, receiptDirectory: dir, publisher: 'Fictional Publisher' };
    return work({ dir, lifecycle, input, persist });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const simulatedSignature = () => ({ status: 'Valid', publisher: 'Fictional Publisher', timestamp: 'fictional-timestamp' });
test('complete simulated signed installed CI evidence stays explicitly short of stable and device proof', () => installedFixture(({ input }) => {
  const receipt = qualifyInstalledCandidate(input, simulatedSignature);
  assert.equal(receipt.sourceRevision, revision); assert.equal(receipt.stablePromotionReady, false);
  assert.equal(receipt.proofLayer, 'signed-fresh-install-on-disposable-windows-ci');
  assert.ok(receipt.limits.some(limit => limit.includes('no upgrade')));
}));
for (const [title, mutate] of [
  ['another source candidate', f => { f.lifecycle.sourceRevision = 'b'.repeat(40); f.persist(); }],
  ['changed installer', f => writeFileSync(f.input.installer, 'different fictional bytes')],
  ['changed child receipt', f => writeFileSync(join(f.dir, 'installed-service.json'), '{"passed":true,"platform":"win32"}')],
  ['missing child identity', f => { f.lifecycle.probes.receipts.pop(); f.persist(); }],
  ['duplicated child identity', f => { f.lifecycle.probes.receipts.push(f.lifecycle.probes.receipts[0]); f.persist(); }],
  ['child path traversal', f => { f.lifecycle.probes.receipts[0].file = '../secret.json'; f.persist(); }],
  ['failed GUI', f => { f.lifecycle.probes.gui.rendererReady = false; f.persist(); }],
  ['failed uninstall', f => { f.lifecycle.uninstall.passed = false; f.persist(); }],
]) test(`candidate refuses ${title} despite a top-level passed flag`, () => installedFixture(f => {
  mutate(f); assert.throws(() => validateInstalledReceipt(f.lifecycle, f.input));
}));
for (const [title, signature] of [
  ['unsigned', { status: 'NotSigned', publisher: 'Fictional Publisher', timestamp: 'fictional' }],
  ['wrong publisher', { status: 'Valid', publisher: 'Other Publisher', timestamp: 'fictional' }],
  ['no timestamp', { status: 'Valid', publisher: 'Fictional Publisher', timestamp: null }],
]) test(`candidate refuses ${title} native signature result`, () => installedFixture(({ input }) => assert.throws(() => qualifyInstalledCandidate(input, () => signature))));
test('candidate refuses bytes replaced during native signature inspection', () => installedFixture(({ input }) => {
  assert.throws(() => qualifyInstalledCandidate(input, path => { if (path === input.application) writeFileSync(path, 'replaced bytes'); return simulatedSignature(); }), /changed during/);
}));
test('CLI native signature inspector cannot accept JSON flags on another operating system', () => {
  if (process.platform !== 'win32') assert.throws(() => inspectAuthenticode('/fictional/installer'), /native Windows/);
});

function journalFixture() {
  const harness = readFileSync(join(root, 'scripts/testing/hermes-memory-windows-journal-native.py'), 'utf8');
  const checks = ['CORE_CASES', 'EXTRA_CASES'].flatMap(name => [...harness.match(new RegExp(`^${name} = \\(([\\s\\S]*?)\\)`, 'm'))[1].matchAll(/"(test_[a-z_]+)"/g)].map(match => ({ name: match[1], status: 'passed' })));
  const helpers = [...harness.match(/^HELPERS = \(([\s\S]*?)\)/m)[1].matchAll(/"([^"]+\.py)"/g)].map(match => match[1]);
  const source = readFileSync(join(root, 'server/hermes-memory-review.ts'), 'utf8');
  const runtimeCommit = source.match(/MEMORY_REVIEW_RUNTIME\s*=\s*['"]([a-f0-9]{40})['"]/)[1];
  const table = source.match(/MEMORY_REVIEW_NATIVE_FILES\s*=\s*\{([\s\S]*?)\}/)[1];
  const runtimeFiles = Object.fromEntries([...table.matchAll(/['"]([^'"]+)['"]\s*:\s*['"]([a-f0-9]{64})['"]/g)].map(match => [match[1], match[2]]));
  return { runtime: { schema: 1, kind: 'realbud-managed-windows-runtime-proof', passed: true, platform: 'win32', sourceRevision: revision, runtimeCommit, runtimeDirectory: 'fictional/runtime' },
    journal: { schema: 1, kind: 'realbud-native-windows-memory-journal-proof', passed: true, status: 'passed', platform: 'win32', reported_source_revision: revision, runtime_commit: runtimeCommit, selected_runtime: 'fictional/runtime', native_windows_validation: true, cleanup: true, sources_unchanged: true, expected_checks: checks.length, checks,
      input_hashes: { harness: fileDigest(join(root, 'scripts/testing/hermes-memory-windows-journal-native.py')), scenario_assertions: fileDigest(join(root, 'scripts/testing/hermes-memory-windows-journal.py')), admission: fileDigest(join(root, 'server/hermes-memory-review.ts')), helpers: Object.fromEntries(helpers.map(name => [name, fileDigest(join(root, 'server/helpers', name))])), runtime_files: runtimeFiles, runtime_python: 'c'.repeat(64) } } };
}
test('complete simulated native journal binds every reviewed case and exact helper/admission bytes', () => {
  const { runtime, journal } = journalFixture();
  assert.equal(validateManagedJournal(runtime, journal, revision, root).journalChecks, 28);
  assert.equal(validateManagedJournal(runtime, journal, revision, root).stablePromotionReady, false);
});
for (const [title, mutate] of [
  ['another source', f => { f.journal.reported_source_revision = 'b'.repeat(40); }],
  ['partial case set', f => { f.journal.checks.pop(); f.journal.expected_checks--; }],
  ['a skipped case', f => { f.journal.checks[0].status = 'skipped'; }],
  ['duplicate case', f => { f.journal.checks[0].name = f.journal.checks[1].name; }],
  ['changed helper', f => { f.journal.input_hashes.helpers['hermes-memory-review.py'] = 'd'.repeat(64); }],
  ['different runtime files', f => { f.journal.input_hashes.runtime_files['utils.py'] = 'd'.repeat(64); }],
  ['no native execution', f => { f.journal.native_windows_validation = false; }],
  ['failed cleanup', f => { f.journal.cleanup = false; }],
]) test(`native journal bundle refuses ${title}`, () => { const fixture = journalFixture(); mutate(fixture); assert.throws(() => validateManagedJournal(fixture.runtime, fixture.journal, revision, root)); });

test('workflow gates both native jobs, carries the update feed for a hand publish, never publishes, and joins candidate-specific receipts', () => {
  const workflow = readFileSync(join(root, '.github/workflows/package-win.yml'), 'utf8');
  assert.match(workflow, /qualification-admission:[\s\S]*windows-candidate\.mjs preflight/);
  assert.equal((workflow.match(/needs: qualification-admission/g) ?? []).length, 2);
  assert.match(workflow, /qualification:[\s\S]*default: rehearsal[\s\S]*signed-ci-candidate/);
  assert.match(workflow, /network|Package Windows/);
  assert.match(workflow, /windows-candidate\.mjs installed/);
  assert.match(workflow, /needs: \[package, memory-journal\]/);
  assert.match(workflow, /windows-candidate\.mjs joined/);
  const installerArtifact = workflow.slice(workflow.indexOf('name: ${{ steps.admission.outputs.artifactKind }}'), workflow.indexOf('  memory-journal:'));
  assert.ok(installerArtifact.includes('steps.admission.outputs.sourceRevision'));
  assert.ok(installerArtifact.includes('release/WINDOWS-QUALIFICATION.txt'));
  // Owner decision, 9 Oct 2026: Windows releases ship, so the artifact carries
  // the update feed; publishing stays a reviewed manual step (asserted below).
  assert.ok(installerArtifact.includes('release/latest.yml'));
  assert.ok(!workflow.includes('gh release') && !workflow.includes('--publish always'));
});
test('QA installer consumers preserve exact source/hash/run admission and reject ambiguous artifact matches', () => {
  const probe = readFileSync(join(root, '.github/workflows/windows-probe.yml'), 'utf8');
  assert.equal((probe.match(/\$selected\.Count -ne 1/g) ?? []).length, 2);
  assert.equal((probe.match(/--name \$selected\[0\]\.name/g) ?? []).length, 2);
  assert.equal((probe.match(/windows-rehearsal-' \+ \$source/g) ?? []).length, 2);
  assert.equal((probe.match(/\$actual -ne \$expected/g) ?? []).length, 2);
  for (const file of ['test-windows-team.ps1', 'test-windows-restricted-startup.ps1']) {
    const source = readFileSync(join(root, 'scripts/testing', file), 'utf8');
    assert.ok(source.includes("$artifact.artifactName -ne 'windows-installer'"));
    assert.ok(source.includes("$artifact.artifactName -cne ('windows-rehearsal-' + $CompiledSourceSha)"));
    assert.ok(source.includes("$artifact.artifactName -cne ('windows-signed-ci-candidate-' + $CompiledSourceSha)"));
    assert.ok(source.includes('$actualHash -ne $ExpectedInstallerSha256'));
    assert.ok(source.includes('$artifact.compiledSourceRevision -ne $CompiledSourceSha'));
  }
});
