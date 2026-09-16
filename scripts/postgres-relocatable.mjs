// Is a PostgreSQL runtime actually relocatable?
//
// This lives in its own module because it was previously assumed rather than
// checked, and the assumption was wrong in a way that only shows up on a
// customer's computer.
//
// The failure it catches: staging Homebrew's PostgreSQL produced three
// executables that linked against absolute `/opt/homebrew/opt/...` dylibs. Every
// test passed on the build machine because Homebrew was installed there. On a
// customer Mac the runtime dies at `dyld` before `initdb` writes a byte. A
// package-manager build is not a distributable runtime.
//
// PostgreSQL also needs its `lib/` and `share/` trees beside the executables at
// run time (`share/postgres.bki` for initdb, timezone and locale data for the
// server), so a bare `bin/` directory is never a complete runtime.
import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Directories a complete PostgreSQL installation carries beside `bin/`. */
/** @type {readonly string[]} */
export const REQUIRED_RUNTIME_DIRECTORIES = ['lib', 'share'];

/** Dependencies that ship with the operating system on every target machine. */
const SYSTEM_PREFIXES = ['/usr/lib/', '/System/', '/usr/libexec/'];

/** @typedef {object} RelocatabilityReport
 * @property {boolean} relocatable
 * @property {string[]} external Dependencies outside the runtime and outside the OS.
 * @property {string[]} missing Expected sibling directories that are absent or not directories.
 */

/**
 * Parse `otool -L` output into the dependency paths it lists.
 *
 * Exported for testing: the parsing rules matter more than the subprocess.
 */
/** @param {string} stdout @returns {string[]} */
export function parseOtoolDependencies(stdout) {
  /** @type {string[]} */
  const dependencies = [];
  for (const line of stdout.split('\n').slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // `otool -L` prints "  <path> (compatibility version ...)".
    const dependency = trimmed.split(' (')[0]?.trim() ?? '';
    // Keep relative install names too. `@rpath`/`@loader_path` dependencies
    // relocate with the bundle and must be classified, not silently dropped —
    // dropping them would make a relocatable runtime look as though it had no
    // dependencies at all, hiding a genuinely broken one.
    if (dependency.startsWith('/') || dependency.startsWith('@')) dependencies.push(dependency);
  }
  return dependencies;
}

/**
 * Classify a dependency as internal, system, or external to the runtime.
 *
 * `@rpath`, `@loader_path` and `@executable_path` are relative and therefore
 * relocate with the bundle, so they are treated as internal.
 */
/** @param {string} dependency @param {string} runtimeRoot @returns {'internal'|'system'|'external'} */
export function classifyDependency(dependency, runtimeRoot) {
  if (!dependency.startsWith('/')) return 'internal';
  if (SYSTEM_PREFIXES.some(prefix => dependency.startsWith(prefix))) return 'system';
  const root = runtimeRoot.endsWith('/') ? runtimeRoot.slice(0, -1) : runtimeRoot;
  if (dependency === root || dependency.startsWith(`${root}/`)) return 'internal';
  return 'external';
}

/**
 * @param {string} runtimeRoot
 * @param {readonly string[]} executablePaths
 * @param {{ platform?: NodeJS.Platform, inspect?: (binary: string) => Promise<string> }} [options]
 * @returns {Promise<RelocatabilityReport>}
 */
export async function assessRelocatability(runtimeRoot, executablePaths, options = {}) {
  const platform = options.platform ?? process.platform;
  /** @type {string[]} */
  const missing = [];
  for (const directory of REQUIRED_RUNTIME_DIRECTORIES) {
    try {
      const info = await lstat(join(runtimeRoot, directory));
      if (!info.isDirectory() || info.isSymbolicLink()) missing.push(directory);
    } catch {
      missing.push(directory);
    }
  }

  /** @type {string[]} */
  const external = [];
  // Only macOS binaries carry install-name metadata we can read portably.
  if (platform === 'darwin') {
    const inspect = options.inspect ?? (async (/** @type {string} */ binary) => (await run('otool', ['-L', binary], { timeout: 20_000 })).stdout);
    for (const binary of executablePaths) {
      let stdout = '';
      try {
        stdout = await inspect(binary);
      } catch {
        // No inspection tool available: structural checks still apply.
        continue;
      }
      for (const dependency of parseOtoolDependencies(stdout)) {
        if (classifyDependency(dependency, runtimeRoot) === 'external') external.push(dependency);
      }
    }
  }

  const unique = [...new Set(external)];
  return { relocatable: unique.length === 0 && missing.length === 0, external: unique, missing };
}

/** Staff- and build-facing explanation, or null when the runtime is fine.
 * @param {RelocatabilityReport} report @returns {string | null} */
export function relocatabilityProblem(report) {
  if (report.relocatable) return null;
  /** @type {string[]} */
  const reasons = [];
  if (report.missing.length) {
    reasons.push(`no ${report.missing.join(' or ')} directory beside the executables (PostgreSQL needs those at run time)`);
  }
  if (report.external.length) {
    reasons.push(`executables link to libraries outside the runtime: ${report.external.join(', ')}`);
  }
  return (
    'The selected PostgreSQL runtime is not relocatable, so it would fail on a customer computer ' +
    `even though it runs here. Cause: ${reasons.join('; ')}. ` +
    "Stage a self-contained PostgreSQL 16 build (for example the official installer's binaries, " +
    'which carry their own lib and share) and set REALBUD_POSTGRES_SOURCE_DIR to it.'
  );
}
