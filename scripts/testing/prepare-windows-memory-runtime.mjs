// Disposable CI proof of the production-managed installer, without account or
// model setup. The native journal harness consumes this exact runtime next.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

assert.equal(process.platform, 'win32', 'Use a disposable native Windows runner.');
assert.equal(process.arch, 'x64');
assert.equal(process.env.CI, 'true');
assert.ok(process.env.RUNNER_TEMP && isAbsolute(process.env.RUNNER_TEMP));
assert.match(process.env.REALBUD_BUILD_SHA ?? '', /^[a-f0-9]{40}$/);
assert.ok(process.argv[2], 'Supply a fresh output receipt filename.');
const receiptPath = resolve(process.argv[2]);
assert.ok(!existsSync(receiptPath), 'Refusing to replace a prior runtime receipt.');
mkdirSync(dirname(receiptPath), { recursive: true });

const { runWorkerBootstrap, finishWorkerBootstrap, bootstrapChildRunning } = await import('../../server/worker-bootstrap.ts');
const { HERMES_RELEASES } = await import('../../server/hermes-releases.ts');
const { MEMORY_REVIEW_RUNTIME, MEMORY_REVIEW_NATIVE_FILES } = await import('../../server/hermes-memory-review.ts');
const release = HERMES_RELEASES.find(item => item.commit === MEMORY_REVIEW_RUNTIME);
assert.ok(release, 'The memory runtime must be in the reviewed install catalog.');
const scratch = mkdtempSync(join(process.env.RUNNER_TEMP, 'RealBud native memory '));
const runtimeHome = join(scratch, release.commit);
const runtimeDirectory = join(runtimeHome, 'hermes-agent');
const python = join(runtimeDirectory, 'venv', 'Scripts', 'python.exe');
const controller = new AbortController();
const started = Date.now();
const stages = [];
const receipt = {
  schema: 1, kind: 'realbud-managed-windows-runtime-proof',
  sourceRevision: process.env.REALBUD_BUILD_SHA, generatedAt: new Date().toISOString(),
  platform: process.platform, arch: process.arch, passed: false,
  runtimeCommit: release.commit, installerSha256: release.installers.windows,
  runtimeDirectory, stages,
  limits: ['Disposable CI runtime setup only; no GUI, account, model request or customer device proof.'],
};
const persist = () => {
  receipt.elapsedMs = Date.now() - started;
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
};
persist();
const timer = setTimeout(() => {
  receipt.error = 'Managed setup exceeded twenty minutes; cleanup requested.';
  persist();
  controller.abort();
}, 20 * 60_000);
try {
  await runWorkerBootstrap({
    home: runtimeHome, privateRuntime: true, release, signal: controller.signal,
    progress(detail, step, total) {
      stages.push({ detail, step, total, elapsedMs: Date.now() - started });
      persist();
      console.log(`${step}/${total}: ${detail}`);
    },
    async finalize() {
      const commit = execFileSync('git', ['-C', runtimeDirectory, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 15_000, windowsHide: true }).trim();
      assert.equal(commit, release.commit, 'Installed runtime revision does not match admission.');
      for (const [file, expected] of Object.entries(MEMORY_REVIEW_NATIVE_FILES)) {
        assert.equal(createHash('sha256').update(readFileSync(join(runtimeDirectory, file))).digest('hex'), expected, `Runtime integrity mismatch: ${file}`);
      }
      assert.ok(existsSync(python), 'Managed Windows Python is missing.');
      receipt.pythonVersion = execFileSync(python, ['--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true }).trim();
      assert.match(receipt.pythonVersion, /^Python 3\.\d+\.\d+$/);
      finishWorkerBootstrap(runtimeHome);
    },
  });
  assert.equal(bootstrapChildRunning(runtimeHome), false, 'A managed setup process remains alive.');
  receipt.passed = true;
} catch (error) {
  // Installer subprocess output is deliberately not collected. These messages
  // come from the owned bootstrap boundary or the assertions above.
  receipt.error = error instanceof Error ? error.message : 'Managed setup failed.';
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  persist();
}
