// Pinned PostgreSQL 16 runtimes for the installer.
//
// Packaging fetches these archives, verifies the pinned SHA-256, and stages the
// full runtime (bin + lib + share) into the app bundle. Nothing here runs on a
// customer machine: a packaged office uses the staged copy, and never falls back
// to Homebrew, MacPorts or Program Files.
//
// Why the official EnterpriseDB binaries: they are built relocatable, resolving
// their libraries through `@loader_path/../lib` (macOS) and alongside the
// executables (Windows), and they carry their own lib/ and share/ trees. A
// package-manager build does NOT: Homebrew's links against absolute
// `/opt/homebrew/opt/...` paths and would fail at dyld on a customer Mac.
//
// macOS note: the published archive is a universal binary containing arm64, so
// it runs natively on Apple silicon. `darwinArchitectures` below asserts that
// rather than assuming it, because shipping a silent Rosetta fallback to a
// customer would be a performance and support problem, not a convenience.

/** Pinned PostgreSQL major version. Admission and the schema both require 16. */
export const POSTGRES_MAJOR = 16;

/** @typedef {object} PostgresArtifact
 * @property {string} file        Filename used in the local packaging cache.
 * @property {string} url         Official download endpoint (redirects to the vendor file host).
 * @property {string} sha256      SHA-256 of the complete archive, established by downloading it once.
 * @property {number} bytes       Archive size in bytes, as published.
 * @property {readonly string[]} architectures Architectures the archive must contain for the target.
 */

/** Official EDB binary archives published for bundling into another installer. */
/** @type {Record<string, PostgresArtifact>} */
export const POSTGRES_ARTIFACTS = {
  'darwin-arm64': {
    file: 'postgresql-16.15-3-osx-binaries.zip',
    url: 'https://sbp.enterprisedb.com/getfile.jsp?fileid=1260512',
    sha256: 'b2cd6a98df1fe0bd84fc9c76109c168a9c018c36a2dca93e542b417237e6eece',
    bytes: 443850485,
    // Universal binary; arm64 must be present so we never ship Rosetta silently.
    architectures: ['arm64'],
  },
  'win32-x64': {
    file: 'postgresql-16.15-3-windows-x64-binaries.zip',
    url: 'https://sbp.enterprisedb.com/getfile.jsp?fileid=1260494',
    sha256: '5e8afffe67daf949aeeb03b74951f1ec2324e1888f73fbd036ab0e567ab004d9',
    bytes: 333048048,
    architectures: ['x64'],
  },
};

/** Key for the platform/architecture we are packaging for. */
/** @param {string} platform @param {string} arch @returns {string} */
export function artifactKey(platform, arch) {
  return `${platform}-${arch}`;
}

/** @param {string} platform @param {string} arch @returns {PostgresArtifact | null} */
export function artifactFor(platform, arch) {
  return POSTGRES_ARTIFACTS[artifactKey(platform, arch)] ?? null;
}

/**
 * Parts of the vendor archive that are not the database server.
 *
 * pgAdmin, Stack Builder and the development headers are hundreds of megabytes
 * of desktop tooling that a staff member will never open and that would enlarge
 * every customer download. They are excluded by name rather than by allowlist so
 * that an unexpected new server component is kept rather than silently dropped.
 */
export const RUNTIME_TOP_LEVEL = ['bin', 'lib', 'share'];

/** Top-level licence/notice files kept alongside the runtime. */
const NOTICE_FILES = new Set([
  'server_license.txt',
  'commandlinetools_3rd_party_licenses.txt',
  'COPYRIGHT',
]);

/**
 * Is this archive entry part of the database server we ship?
 *
 * An allowlist, not a delete-list: the vendor archive also carries pgAdmin,
 * Stack Builder (as `stackbuilder.app`), development headers, docs and several
 * licence files, and the naming and casing vary between releases. An unexpected
 * new entry is therefore not shipped, rather than quietly enlarging every
 * customer download.
 *
 * @param {string} entryPath @returns {boolean}
 */
export function isRuntimeEntry(entryPath) {
  const relative = entryPath.replace(/^pgsql\//, '');
  if (!relative) return false;
  const [top] = relative.split('/');
  return RUNTIME_TOP_LEVEL.includes(top) || (NOTICE_FILES.has(top) && !relative.includes('/'));
}

/** @param {string} entryPath @returns {boolean} */
export function isExcludedFromRuntime(entryPath) {
  return entryPath.startsWith('pgsql/') && !isRuntimeEntry(entryPath);
}

/** The PostgreSQL Licence text ships in the archive under one of these names. */
export const LICENCE_NAMES = ['server_license.txt', 'COPYRIGHT'];

/** @param {readonly string[]} entries @returns {string | null} */
export function findLicenceEntry(entries) {
  for (const name of LICENCE_NAMES) {
    const match = entries.find(entry => entry === `pgsql/${name}`);
    if (match) return match;
  }
  return null;
}

/** Would this archive entry be extracted into the runtime? */
/** @param {string} entryPath @returns {boolean} */
export function shouldExtract(entryPath) {
  if (entryPath.endsWith('/')) return false;
  return isRuntimeEntry(entryPath);
}

/**
 * Pick the `postgres` executable out of an archive listing, given the target
 * platform's executable suffix.
 */
/** @param {string} platform @returns {string[]} */
export function requiredExecutables(platform) {
  const suffix = platform === 'win32' ? '.exe' : '';
  return ['postgres', 'initdb', 'pg_ctl'].map(name => `pgsql/bin/${name}${suffix}`);
}
