// Stage the admitted PostgreSQL runtime into the installer.
//
// This is what removes "install PostgreSQL and set REALBUD_COMPANY_POSTGRES_BIN"
// from the staff path: `pnpm package:*` stages the runtime here, electron-builder
// ships it as `Resources/postgres`, and `resolvePostgresRuntime()` admits it at
// `Set up this office` time.
//
// Behaviour:
//  - Fetches the official EnterpriseDB binary archive pinned in
//    `postgres-artifacts.mjs`, verified by SHA-256 before it is unpacked.
//  - Caches the archive so CI or an offline build can reuse one download
//    (`REALBUD_POSTGRES_CACHE_DIR`), and so a session-gated endpoint only has to
//    be fetched once by an operator.
//  - Extracts the complete runtime: bin, lib and share. A bare bin/ directory is
//    not runnable — initdb needs share/postgres.bki.
//  - Refuses anything that is not relocatable, not PostgreSQL 16.x, not the
//    required architecture, or not carrying the PostgreSQL licence.
//
// Every refusal is a build failure rather than a silent omission: an installer
// whose "Set up this office" cannot provision storage should fail here, on our
// machine, not on a customer's.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  RUNTIME_TOP_LEVEL,
  artifactFor,
  findLicenceEntry,
  isRuntimeEntry,
} from './postgres-artifacts.mjs';
import { assessRelocatability, relocatabilityProblem } from './postgres-relocatable.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const stage = join(root, 'dist-postgres');
const manifestPath = join(stage, 'runtime.json');
const cacheDirectory = process.env.REALBUD_POSTGRES_CACHE_DIR
  ? resolve(process.env.REALBUD_POSTGRES_CACHE_DIR)
  : join(root, '.postgres-cache');

const PLATFORM = process.platform;
const ARCH = process.arch;

/** Required by `openOwnedPostgres`. Keep in sync with server/company/postgres-runtime.ts. */
const REQUIRED = PLATFORM === 'win32'
  ? ['postgres.exe', 'initdb.exe', 'pg_ctl.exe']
  : ['postgres', 'initdb', 'pg_ctl'];

function fail(message) {
  console.error(`[postgres] ${message}`);
  process.exit(1);
}

function log(message) {
  console.error(`[postgres] ${message}`);
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256(file) {
  const hash = createHash('sha256');
  const handle = await readFile(file);
  hash.update(handle);
  return hash.digest('hex');
}

/**
 * Obtain the pinned archive, verifying its hash.
 *
 * An operator-supplied directory wins, so a session-gated download can be done
 * once by hand and reused by CI without this script ever fetching anything.
 */
async function obtainArchive(artifact) {
  await mkdir(cacheDirectory, { recursive: true });
  const cached = join(cacheDirectory, artifact.file);
  if (await exists(cached)) {
    const digest = await sha256(cached);
    if (digest === artifact.sha256) {
      log(`using cached ${artifact.file}`);
      return cached;
    }
    fail(
      `The cached archive ${cached} does not match its pinned SHA-256 ` +
      `(expected ${artifact.sha256}, found ${digest}). Delete it and retry; do not use it.`,
    );
  }

  log(`downloading ${artifact.file} (${Math.round(artifact.bytes / 1_048_576)} MB)`);
  const response = await fetch(artifact.url, { redirect: 'follow' });
  if (!response.ok) {
    fail(
      `Could not download ${artifact.url} (HTTP ${response.status}). ` +
      `Download the official archive manually into ${cacheDirectory} as ${artifact.file} and retry.`,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== artifact.sha256) {
    fail(
      `The downloaded archive failed verification and has been discarded. ` +
      `Expected SHA-256 ${artifact.sha256}, received ${digest}.`,
    );
  }
  await writeFile(cached, bytes);
  log('download verified against the pinned SHA-256');
  return cached;
}

/** Archive entries, as paths relative to the archive root. */
async function listArchive(archive) {
  // `unzip -Z1` lists entry names and is available on the Info-ZIP builds used
  // on both packaging hosts.
  const { stdout } = await run('unzip', ['-Z1', archive], { timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
  return stdout.split('\n').map(line => line.trim()).filter(Boolean);
}

/**
 * Unpack the archive and trim it to the server runtime.
 *
 * `ditto -x -k` is used on macOS because it is the native extractor and
 * preserves symlinks and permissions from the archive metadata. (Apple's
 * Info-ZIP build has no `-@` list option, so a selective stdin extraction is not
 * portable across the unzip builds a packaging host might have.)
 *
 * The archive is extracted whole and then trimmed. The exclusion list is applied
 * afterwards on purpose: an unexpected new file in a future archive is dropped
 * rather than silently shipped, and the reason for each exclusion stays in one
 * place.
 */
async function extract(archive, entries, destination) {
  const [command, args] = PLATFORM === 'win32'
    ? ['tar', ['-xf', archive, '-C', destination]]
    : ['ditto', ['-x', '-k', archive, destination]];
  await run(command, args, { timeout: 900_000, maxBuffer: 64 * 1024 * 1024 });

  const disposable = disposableTopLevel(entries);
  for (const top of disposable) {
    await rm(join(destination, 'pgsql', top), { recursive: true, force: true, maxRetries: 3 });
  }
  log(`trimmed ${disposable.length} non-server components: ${disposable.join(', ') || '(none)'}`);
}

/** Top-level entries that are not part of the server runtime. */
function disposableTopLevel(entries) {
  const tops = new Set();
  for (const entry of entries) {
    if (!entry.startsWith('pgsql/')) continue;
    const relative = entry.replace(/^pgsql\//, '');
    const [top] = relative.split('/');
    if (!top) continue;
    if (RUNTIME_TOP_LEVEL.includes(top)) continue;
    // Keep the small top-level notice files; drop anything else.
    if (!relative.includes('/') && /license|licence|copyright/i.test(top)) continue;
    tops.add(top);
  }
  return [...tops];
}

async function main() {
  const artifact = artifactFor(PLATFORM, ARCH);
  if (!artifact) {
    fail(
      `No pinned PostgreSQL ${16} runtime is published for ${PLATFORM}-${ARCH}. ` +
      'Supported targets are darwin-arm64 and win32-x64. Refusing to build an installer ' +
      'whose "Set up this office" cannot provision storage.',
    );
  }

  const archive = await obtainArchive(artifact);
  const entries = await listArchive(archive);

  const licenceEntry = findLicenceEntry(entries);
  if (!licenceEntry) {
    fail('The archive does not contain the PostgreSQL licence text; refusing to redistribute it without its notice.');
  }

  await rm(stage, { recursive: true, force: true });
  const work = await mkdtemp(join(tmpdir(), 'realbud-pg-stage-'));
  try {
    log(`extracting ${entries.length} archive entries`);
    await extract(archive, entries, work);

    const runtime = join(work, 'pgsql');
    const binaries = join(runtime, 'bin');
    const version = (await run(join(binaries, REQUIRED[0]), ['--version'], { timeout: 30_000 })).stdout.trim();
    if (!new RegExp(`PostgreSQL\\) ${16}\\.\\d+`).test(version)) {
      fail(`The staged runtime must be PostgreSQL ${16}.x; it reports "${version}".`);
    }

    // Architecture admission. The macOS archive is universal, so this asserts
    // arm64 is present instead of assuming it and silently using Rosetta.
    if (PLATFORM === 'darwin') {
      const { stdout } = await run('lipo', ['-archs', join(binaries, 'postgres')], { timeout: 30_000 });
      const present = stdout.trim().split(/\s+/);
      const missing = artifact.architectures.filter(wanted => !present.includes(wanted));
      if (missing.length) {
        fail(`The runtime is missing required architecture(s): ${missing.join(', ')} (found ${present.join(', ')}).`);
      }
    }

    const report = await assessRelocatability(runtime, REQUIRED.map(name => join(binaries, name)));
    const problem = relocatabilityProblem(report);
    if (problem) fail(problem);

    // Reject a symlinked lib/ or share/: admission refuses to depend on a link
    // an update could repoint.
    for (const directory of ['lib', 'share']) {
      const info = await lstat(join(runtime, directory));
      if (!info.isDirectory() || info.isSymbolicLink()) fail(`Staged ${directory} must be a real directory.`);
    }

    await mkdir(stage, { recursive: true, mode: 0o755 });
    await run('cp', ['-R', `${runtime}/.`, stage], { timeout: 900_000 });

    // Normalise executable permissions and record hashes of what we ship.
    const recorded = [];
    for (const name of REQUIRED) {
      const target = join(stage, 'bin', name);
      await chmod(target, 0o755);
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isFile()) fail(`${target} must be a real file.`);
      const bytes = await readFile(target);
      recorded.push({ name, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });
    }

    const licenceText = await readFile(join(work, licenceEntry), 'utf8');
    await writeFile(join(stage, 'COPYRIGHT'), licenceText);

    const fileCount = (await readdir(stage, { recursive: true })).length;
    await writeFile(manifestPath, `${JSON.stringify({
      schema: 2,
      kind: 'realbud-staged-postgres',
      product: `PostgreSQL ${16}`,
      version,
      platform: PLATFORM,
      architecture: ARCH,
      source: { file: artifact.file, url: artifact.url, sha256: artifact.sha256 },
      licence: licenceEntry.replace(/^pgsql\//, ''),
      binaries: recorded,
      files: fileCount,
      note:
        'Relocatable runtime (bin + lib + share) fetched from the official EnterpriseDB archive and verified by ' +
        'SHA-256. Admitted by resolvePostgresRuntime(); openOwnedPostgres re-verifies trust, symlinks, permissions, ' +
        'version and port at setup time. A packaged office never falls back to Homebrew or Program Files.',
    }, null, 2)}\n`);

    log(`staged ${version} (${fileCount} files) -> dist-postgres`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

await main();
