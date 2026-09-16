#!/usr/bin/env node
// Bounded local acceptance only: installed Node/PostgreSQL, disposable databases,
// synthetic sources, exact test inventory. No installation or production DB use.
import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { appendFileSync, writeFileSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const TEST_FILES = [
  'server/company/postgres.integration.test.ts',
  'server/company/member-auth.integration.test.ts',
  'server/company/initial-credential.test.ts',
  'server/company/initial-enrollment.integration.test.ts',
  'server/company/member-credentials.test.ts',
  'server/company/workflow-template.test.ts',
  'server/company/workflow-template.integration.test.ts',
  'server/company/work-items.integration.test.ts',
  'server/company-work.integration.test.ts',
  'src/lib/company-work-response.test.ts',
  'src/lib/company-work-api.test.ts',
  'server/company/host-runtime.test.ts',
  'server/company/host-transport.test.ts',
  'server/company/host-certificate.test.ts',
  'server/company-installation.integration.test.ts',
  'server/company-departments.integration.test.ts',
  'server/company-host.test.ts',
  'server/service-admin.test.ts',
  'server/service-admin-provision.test.ts',
  'server/service-entitlement.test.ts',
  'server/service-child-env.test.ts',
  'server/care-unlock.test.ts',
  'server/managed-service.test.ts',
  'server/connected-apps-broker.test.ts',
  'server/session-auth.test.ts',
  'server/drivers/acp/hermes-env.test.ts',
  'server/drivers/acp/acp.test.ts',
  'server/procs.test.ts',
  'server/hermes-bridge.test.ts',
  'server/hermes-hands.test.ts',
  'server/import-inspect.test.ts',
  'server/recipe-draft.test.ts',
  'src/lib/company-api.test.ts',
  'src/lib/local-session.test.ts',
  'src/lib/service-admin-session.test.ts',
  'src/lib/tts/index.test.ts',
];
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const started = Date.now();
const BUDGET_MS = 180_000;
const WORK_MS = 155_000; // Reserve 25 seconds for shutdown and durable reporting.
const stamp = new Date(started).toISOString().replace(/[:.]/g, '-');
const outputRoot = join(root, 'outputs');
await mkdir(outputRoot, { recursive: true });
const output = await mkdtemp(join(outputRoot, `realbud-company-qa-${stamp}-`));
const logPath = join(output, 'tests.log');
const reportPath = join(output, 'result.json');
const vitestPath = join(output, 'vitest.json');
const abort = new AbortController();
let fixture, child, childClosed, fixtureStarting, temporary, pgBin, timer, hardTimer;
let childExit = null;
let failure = null;
let requestedExit = 0;
let cleanupComplete = false;
let cleanLateFixture = false;
let validated = null;

function log(message) {
  const line = `${message}\n`;
  appendFileSync(logPath, line);
  process.stdout.write(line);
}
function summary(exitCode) {
  return {
    startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started, budgetMs: BUDGET_MS, passed: exitCode === 0,
    exitCode, childExit, failure, cleanupComplete, node: process.version,
    postgres: fixture?.version ?? null, testFiles: TEST_FILES, validation: validated,
    proofLayer: 'Local source acceptance with disposable real PostgreSQL and synthetic services; no installed-platform or live-office proof',
    logs: { tests: 'tests.log', vitest: 'vitest.json' },
  };
}
function interrupt(reason, exitCode) {
  requestedExit ||= exitCode;
  if (!abort.signal.aborted) abort.abort(new Error(reason));
}
function signalChild(signal) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function bounded(promise, ms, label) {
  let timeout;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    })]);
  } finally { clearTimeout(timeout); }
}
async function interruptible(promise) {
  if (abort.signal.aborted) throw abort.signal.reason;
  let rejectOnAbort;
  const interruption = new Promise((_, reject) => {
    rejectOnAbort = () => reject(abort.signal.reason);
    abort.signal.addEventListener('abort', rejectOnAbort, { once: true });
  });
  try { return await Promise.race([promise, interruption]); }
  finally { abort.signal.removeEventListener('abort', rejectOnAbort); }
}
async function executable(path) { try { await access(path, constants.X_OK); return true; } catch { return false; } }
async function discoverPostgres() {
  const candidates = [];
  const explicit = process.env.REALBUD_TEST_POSTGRES_BIN;
  if (explicit) candidates.push(resolve(explicit));
  for (const entry of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    if (await executable(join(entry, 'pg_config'))) {
      try { candidates.push((await execute(join(entry, 'pg_config'), ['--bindir'], { timeout: 3000 })).stdout.trim()); } catch { /* inspect next installed candidate */ }
    }
  }
  if (!explicit) candidates.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/lib/postgresql/16/bin');
  for (const candidate of [...new Set(candidates)]) {
    if (explicit && candidate !== resolve(explicit)) continue;
    const required = await Promise.all(['postgres', 'initdb', 'pg_ctl', 'createdb'].map(name => executable(join(candidate, name))));
    if (!required.every(Boolean)) continue;
    const version = (await execute(join(candidate, 'postgres'), ['--version'], { timeout: 3000 })).stdout;
    if (/PostgreSQL\) 16\./.test(version)) return candidate;
  }
  throw new Error('Installed PostgreSQL 16 tools are required. Set REALBUD_TEST_POSTGRES_BIN to their directory; this runner does not install dependencies.');
}

// On interruption, HTTP tests may not reach afterAll. Identify only this run's
// clusters by their private socket directory under this run's temporary root.
async function cleanInterruptedHttpFixtures() {
  if (!temporary || !pgBin) return;
  const base = join(root, 'outputs', 'realbud-core-implementation-2026-09-14', 'http');
  let entries;
  try { entries = await readdir(base, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('postgres-fixture-')) continue;
    const directory = join(base, entry.name);
    const data = join(directory, 'data');
    let lines;
    try { lines = (await readFile(join(data, 'postmaster.pid'), 'utf8')).split('\n'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const socket = resolve(lines[4] ?? '');
    if (!socket.startsWith(temporary + sep)) continue;
    try {
      await execute(join(pgBin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', '-t', '3', 'stop'], { timeout: 4500 });
    } catch {
      await execute(join(pgBin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', '-t', '3', 'stop'], { timeout: 4500 });
    }
    await rm(data, { recursive: true, force: true });
    await rm(socket, { recursive: true, force: true });
    await writeFile(join(directory, 'fixture.json'), JSON.stringify({ stopped: true, interruptedRunnerCleanup: true, dataRemoved: true, ownerOutput: output }, null, 2) + '\n');
  }
}

async function cleanup() {
  const errors = [];
  if (child && !childExit) {
    try {
      signalChild('SIGTERM');
      try { await bounded(childClosed, 5000, 'Vitest shutdown'); }
      catch { signalChild('SIGKILL'); await bounded(childClosed, 2000, 'Vitest forced shutdown'); }
    } catch (error) { errors.push(error); }
  }
  // Also stop descendants whose parent exited before them, within the owned group.
  try { signalChild('SIGTERM'); } catch (error) { errors.push(error); }
  if (!fixture && fixtureStarting) {
    try { fixture = await bounded(fixtureStarting, 5000, 'PostgreSQL startup settlement'); }
    catch (error) { cleanLateFixture = true; errors.push(error); }
  }
  if (fixture) {
    try { await bounded(fixture.stop(), 7000, 'PostgreSQL fixture cleanup'); } catch (error) { errors.push(error); }
  }
  try { await cleanInterruptedHttpFixtures(); } catch (error) { errors.push(error); }
  // Native-host acceptance owns only these directories under this run's temp
  // root. Never remove their data while an interrupted postmaster still runs.
  if (temporary && pgBin) {
    try {
      for (const entry of await readdir(temporary, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('rb-host-join-')) continue;
        const data = join(temporary, entry.name, 'host', 'company-installation', 'postgres', 'data');
        let lines;
        try { lines = (await readFile(join(data, 'postmaster.pid'), 'utf8')).split('\n'); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (resolve(lines[1] ?? '') !== await realpath(data)) throw new Error('Interrupted native fixture ownership mismatch; data preserved');
        await execute(join(pgBin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', '-t', '3', 'stop'], { timeout: 4500 });
      }
    } catch (error) { errors.push(error); }
  }
  try { signalChild('SIGKILL'); } catch (error) { errors.push(error); }
  if (temporary && !errors.length) {
    try { await rm(temporary, { recursive: true, force: true }); } catch (error) { errors.push(error); }
  }
  cleanupComplete = errors.length === 0;
  if (errors.length) throw new Error(errors.map(error => error instanceof Error ? error.message : String(error)).join('; '));
}

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.once(signal, () => interrupt(`Interrupted by ${signal}`, code));
timer = setTimeout(() => interrupt('Acceptance work exceeded its time budget', 124), WORK_MS);
hardTimer = setTimeout(() => {
  failure ||= 'Three-minute hard deadline reached';
  try { signalChild('SIGKILL'); } catch { /* terminal failure is recorded below */ }
  writeFileSync(reportPath, JSON.stringify(summary(124), null, 2) + '\n');
  process.stderr.write(`Company QA hard deadline; evidence: ${output}\n`);
  process.exit(124);
}, BUDGET_MS - (Date.now() - started));

try {
  log(`Company core acceptance: ${output}`);
  if (process.argv.length > 2) throw new Error('Usage: node scripts/qa-company-core.mjs (the exact test list is fixed)');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node 24 or newer is required. Run with your existing Node 24 toolchain; no runtime will be installed.');
  if (process.platform === 'win32') throw new Error('This source acceptance fixture requires Unix sockets; Windows installed acceptance is a separate gate.');
  pgBin = await interruptible(discoverPostgres());
  const manifest = await Promise.all(TEST_FILES.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(join(root, path))).digest('hex') })));
  await writeFile(join(output, 'test-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const { startCompanyPostgresFixture } = await import('../server/company/testing-postgres.ts');
  fixtureStarting = startCompanyPostgresFixture({ outputDirectory: join(output, 'kernel'), postgresBinDirectory: pgBin });
  fixtureStarting.then(value => { if (cleanLateFixture) void value.stop().catch(() => {}); }, () => {});
  fixture = await interruptible(fixtureStarting);
  // A nested macOS /var/folders temp path exceeds PostgreSQL's Unix-socket
  // limit. Keep this owned root short, private, and canonical for cleanup checks.
  temporary = await realpath(await mkdtemp('/tmp/rbcq-'));
  const args = ['--experimental-strip-types', join(root, 'node_modules/vitest/vitest.mjs'), 'run', ...TEST_FILES,
    '--no-file-parallelism', '--maxWorkers=1', '--reporter=default', '--reporter=json', `--outputFile.json=${vitestPath}`];
  // Allowlist environment; do not inherit production DB/provider credentials or
  // personal runtime paths. Test setup supplies its own disposable home per file.
  const env = {
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
    TMPDIR: temporary, TMP: temporary, TEMP: temporary, LANG: process.env.LANG ?? 'C.UTF-8', CI: '1',
    REALBUD_COMPANY_TEST_URL: fixture.adminUrl, REALBUD_TEST_POSTGRES: '1', REALBUD_TEST_POSTGRES_BIN: pgBin,
  };
  log(`Running ${TEST_FILES.length} exact files with ${process.version} and ${fixture.version}; skips are failures.`);
  child = spawn(process.execPath, args, { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  childClosed = new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { childExit = { code, signal }; resolveExit(childExit); });
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
    appendFileSync(logPath, bytes);
    process.stdout.write(bytes);
  });
  await interruptible(childClosed);
  const report = JSON.parse(await readFile(vitestPath, 'utf8'));
  const actualFiles = (report.testResults ?? []).map(result => resolve(result.name)).sort();
  const wantedFiles = TEST_FILES.map(path => join(root, path)).sort();
  const assertions = (report.testResults ?? []).flatMap(result => result.assertionResults ?? []);
  validated = { files: actualFiles.length, tests: report.numTotalTests, passed: report.numPassedTests,
    failed: report.numFailedTests, skipped: report.numPendingTests, todo: report.numTodoTests,
    exactInventory: JSON.stringify(actualFiles) === JSON.stringify(wantedFiles) };
  if (childExit.code !== 0 || childExit.signal || report.success !== true || !validated.exactInventory ||
      !Number.isSafeInteger(report.numTotalTests) || report.numTotalTests < TEST_FILES.length ||
      report.numPassedTests !== report.numTotalTests || report.numFailedTests !== 0 ||
      report.numPendingTests !== 0 || report.numTodoTests !== 0 || report.numPendingTestSuites !== 0 ||
      assertions.length !== report.numTotalTests || assertions.some(test => test.status !== 'passed') ||
      report.testResults.some(result => !result.assertionResults?.length)) {
    throw new Error('Acceptance failed: failing, skipped, pending, missing or unexpected tests; inspect the preserved Vitest report.');
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  log(`FAILED: ${failure}`);
} finally {
  clearTimeout(timer);
  try { await cleanup(); }
  catch (error) { failure ||= `Cleanup failed: ${error instanceof Error ? error.message : String(error)}`; log(`Cleanup failed: ${error instanceof Error ? error.message : String(error)}`); }
  const exitCode = requestedExit || (failure ? 1 : 0);
  await writeFile(reportPath, JSON.stringify(summary(exitCode), null, 2) + '\n');
  if (cleanupComplete) clearTimeout(hardTimer);
  log(`${exitCode === 0 ? 'PASSED' : 'FAILED'}; result: ${reportPath}`);
  process.exitCode = exitCode;
}
