// Admitted PostgreSQL runtime discovery for "Set up this office".
//
// The office host must start storage without the staff member opening a
// terminal and without REALBUD_COMPANY_POSTGRES_BIN being set by hand. This
// module turns "where is a trusted PostgreSQL 16 runtime?" into one explicit,
// testable resolution step.
//
// It discovers; it never downloads, never searches PATH, and never adopts a
// server that is already running. `openOwnedPostgres` still performs its own
// independent trust, symlink, permission, version and port checks on whatever
// directory this returns, so a wrong answer here fails closed rather than
// binding an untrusted database.
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** The server binary whose reported version decides admission. */
const VERSION_BINARY = 'postgres';
/**
 * `pg_ctl` is used to stop the owned cluster on Windows, where Node emulates
 * SIGINT/SIGTERM as termination and cannot request an orderly shutdown.
 * Requiring it everywhere keeps the admitted runtime identical across platforms.
 */
const REQUIRED_BINARIES = ['postgres', 'initdb', 'pg_ctl'] as const;

const VERSION_TIMEOUT_MS = 10_000;

export type PostgresRuntimeSource = 'bundled' | 'configured' | 'system';

export interface PostgresRuntime {
  /** Absolute directory containing the admitted PostgreSQL executables. */
  binaryDirectory: string;
  /** Full version banner, e.g. "postgres (PostgreSQL) 16.15 (Homebrew)". */
  version: string;
  /** Which discovery step supplied this runtime. */
  source: PostgresRuntimeSource;
}

export interface ResolveOptions {
  /** Directory holding the installed application's resources. */
  resourcesDirectory?: string;
  /** Explicit operator/installer override; wins over every other source. */
  configuredDirectory?: string;
  platform?: NodeJS.Platform;
  /** Test seam: replaces the `postgres --version` probe. */
  readVersion?: (binary: string) => Promise<string>;
  /** Test seam: replaces executability checking. */
  isExecutable?: (binary: string, platform: NodeJS.Platform) => Promise<boolean>;
}

export class PostgresRuntimeError extends Error {
  readonly code = 'postgres_runtime_unavailable';
}

function executableName(name: string, platform: NodeJS.Platform) {
  return platform === 'win32' && !name.toLowerCase().endsWith('.exe') ? `${name}.exe` : name;
}

/** Mirrors `postgresBinary` in host-runtime.ts so both agree on layout. */
function binaryPath(directory: string, name: string, platform: NodeJS.Platform) {
  const separator = platform === 'win32' ? '\\' : '/';
  const root = directory.endsWith('\\') || directory.endsWith('/') ? directory.slice(0, -1) : directory;
  return `${root}${separator}${executableName(name, platform)}`;
}

async function defaultIsExecutable(binary: string, platform: NodeJS.Platform) {
  try {
    const stats = await lstat(binary);
    // A symlinked executable is rejected here as well as in host-runtime.ts:
    // admission must not depend on a link an update could repoint.
    if (!stats.isFile() || stats.isSymbolicLink()) return false;
    if (platform !== 'win32') await access(binary, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function defaultReadVersion(binary: string) {
  const { stdout } = await run(binary, ['--version'], { timeout: VERSION_TIMEOUT_MS });
  return stdout.trim();
}

/**
 * Inspector used by both the resolver and its tests. Exported so a test can
 * assert admission rules against a crafted directory without the resolver's
 * search order getting in the way.
 */
export async function inspectPostgresRuntime(
  binaryDirectory: string,
  source: PostgresRuntimeSource,
  options: Pick<ResolveOptions, 'platform' | 'readVersion' | 'isExecutable'> = {},
): Promise<PostgresRuntime | null> {
  const platform = options.platform ?? process.platform;
  const isExecutable = options.isExecutable ?? defaultIsExecutable;
  const readVersion = options.readVersion ?? defaultReadVersion;
  // Canonicalise before checking anything. Package managers point at the version
  // directory through a symlink, and `openOwnedPostgres` refuses a symlinked
  // binary or binary directory — so admission must hand back the real tree, not
  // the link that led to it.
  let directory: string;
  try {
    directory = resolve(await realpath(binaryDirectory));
  } catch {
    return null;
  }
  for (const name of REQUIRED_BINARIES) {
    if (!(await isExecutable(binaryPath(directory, name, platform), platform))) return null;
  }
  let version: string;
  try {
    version = (await readVersion(binaryPath(directory, VERSION_BINARY, platform))).trim();
  } catch {
    return null;
  }
  // host-runtime.ts re-checks this; the duplication is deliberate so a caller
  // cannot present a non-16 runtime as admitted.
  if (!/PostgreSQL\) 16\.\d+/.test(version)) return null;
  return { binaryDirectory: directory, version, source };
}

async function subdirectories(directory: string) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    // Package managers expose `opt/<name>` as a symlink into their real store.
    // Those entries must be followed to the real tree, because
    // `openOwnedPostgres` refuses a symlinked binary or binary directory; a
    // `isDirectory()` filter would silently hide the only installed runtime.
    return entries
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Directories to search, in priority order. An explicit operator override
 * wins; then the shipped bundle; then a developer-machine fallback.
 */
async function candidateDirectories(options: ResolveOptions): Promise<Array<{ directory: string; source: PostgresRuntimeSource }>> {
  const platform = options.platform ?? process.platform;
  const found: Array<{ directory: string; source: PostgresRuntimeSource }> = [];

  if (options.configuredDirectory) found.push({ directory: options.configuredDirectory, source: 'configured' });

  const bundledRoot = options.resourcesDirectory ? join(options.resourcesDirectory, 'postgres') : undefined;
  if (bundledRoot) {
    // Both layouts are accepted: an archive extracted straight into `postgres/`,
    // and a vendor tree that keeps its own `bin/`.
    found.push({ directory: bundledRoot, source: 'bundled' });
    found.push({ directory: join(bundledRoot, 'bin'), source: 'bundled' });
    for (const versioned of await subdirectories(join(bundledRoot, 'versions'))) {
      found.push({ directory: join(bundledRoot, 'versions', versioned, 'bin'), source: 'bundled' });
    }
  }

  // Developer and CI fallback only. This is never how an installed office finds
  // its database, and it is intentionally last.
  if (platform === 'darwin') {
    for (const prefix of ['/opt/homebrew', '/usr/local']) {
      found.push({ directory: join(prefix, 'bin'), source: 'system' });
      for (const versioned of await subdirectories(join(prefix, 'opt'))) {
        if (!versioned.startsWith('postgresql')) continue;
        found.push({ directory: join(prefix, 'opt', versioned, 'bin'), source: 'system' });
      }
    }
  } else if (platform === 'linux') {
    for (const versioned of await subdirectories('/usr/lib/postgresql')) {
      found.push({ directory: join('/usr/lib/postgresql', versioned, 'bin'), source: 'system' });
    }
  }

  return found;
}

/**
 * Resolve the installed application's resources directory.
 *
 * The server runs as an Electron `utilityProcess` and therefore has no
 * `process.resourcesPath`. Electron sets `OMB_STATIC_DIR` to
 * `<resources>/ui`, so the resources root is its parent. `REALBUD_RESOURCES_DIR`
 * lets an installer/packaging step point at a staged tree explicitly.
 */
export function appResourcesDirectory(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = environment.REALBUD_RESOURCES_DIR?.trim();
  if (explicit) return resolve(explicit);
  const staticDirectory = environment.OMB_STATIC_DIR?.trim();
  if (!staticDirectory) return undefined;
  return resolve(staticDirectory, '..');
}

/**
 * Resolve the first admitted PostgreSQL 16 runtime, or throw with staff-facing
 * copy. Returning a directory is not a guarantee it will start: a bundled
 * runtime can still be refused by `openOwnedPostgres` (shared library
 * resolution, permissions, an occupied port), and that failure is reported by
 * the caller with its own recovery text.
 */
export async function resolvePostgresRuntime(options: ResolveOptions = {}): Promise<PostgresRuntime> {
  const resolved: ResolveOptions = {
    ...options,
    resourcesDirectory: options.resourcesDirectory ?? appResourcesDirectory(),
    configuredDirectory: options.configuredDirectory ?? process.env.REALBUD_COMPANY_POSTGRES_BIN,
  };
  for (const candidate of await candidateDirectories(resolved)) {
    const runtime = await inspectPostgresRuntime(candidate.directory, candidate.source, resolved);
    if (runtime) return runtime;
  }
  throw new PostgresRuntimeError(
    'The office database runtime is not available on this computer. Reinstall RealBud, or contact RealBud service support if the problem continues.',
  );
}
