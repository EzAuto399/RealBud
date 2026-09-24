// The runtime image must contain everything the gateway loads at start and at
// request time. Walks the static imports (and files spawned through
// `new URL(..., import.meta.url)`) from each runtime entrypoint, then checks the
// Dockerfile copies every file outside managed-gateway/ to the same relative
// place, the build-context allowlist admits it, and every bare package import
// is pinned in this package's manifest and lockfile at the root version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATEWAY = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(GATEWAY, '..');
const ENTRYPOINTS = ['server.ts', 'entitlement-cli.ts', 'caps-cli.ts', 'commercial-cli.ts'];
const CODE = /\.(?:m?[jt]s|cjs)$/;
const BUILTINS = new Set(builtinModules);

interface Closure { files: Set<string>; packages: Set<string> }

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

function specifiers(source: string): { imports: string[]; spawned: string[] } {
  const imports: string[] = [], spawned: string[] = [];
  // Statement-level import/export ... from '...'; `import type` / `export type` are erased at runtime.
  for (const match of source.matchAll(/^[ \t]*(?:import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/gm)) {
    if (!match[1]) imports.push(match[2]!);
  }
  for (const match of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) imports.push(match[1]!);
  for (const match of source.matchAll(/\bimport\.meta\.resolve\(\s*['"]([^'"]+)['"]\s*\)/g)) imports.push(match[1]!);
  for (const match of source.matchAll(/new URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)) {
    if (CODE.test(match[1]!)) spawned.push(match[1]!);
  }
  return { imports, spawned };
}

function closure(entrypoints: string[]): Closure {
  const files = new Set<string>(), packages = new Set<string>();
  const pending = entrypoints.map(entry => join(GATEWAY, entry));
  while (pending.length) {
    const file = pending.pop()!;
    const key = relative(ROOT, file).split('\\').join('/');
    if (files.has(key)) continue;
    assert.ok(existsSync(file), `${key} is imported but does not exist`);
    files.add(key);
    const { imports, spawned } = specifiers(readFileSync(file, 'utf8'));
    for (const specifier of [...imports, ...spawned]) {
      if (specifier.startsWith('.')) pending.push(resolve(dirname(file), specifier));
      else if (!specifier.startsWith('node:') && !BUILTINS.has(specifier)) packages.add(packageName(specifier));
    }
  }
  return { files, packages };
}

// Docker's COPY sources relative to the build context, mapped to absolute destinations.
function copies(dockerfile: string): { source: string; destination: string }[] {
  const result: { source: string; destination: string }[] = [];
  let workdir = '/';
  for (const line of dockerfile.split('\n').map(item => item.trim())) {
    const [instruction, ...rest] = line.split(/\s+/);
    if (/^WORKDIR$/i.test(instruction ?? '')) workdir = posix.resolve(workdir, rest[0]!);
    if (!/^COPY$/i.test(instruction ?? '')) continue;
    const args = rest.filter(arg => !arg.startsWith('--'));
    if (rest.some(arg => arg.startsWith('--from'))) continue;
    const target = args.pop()!;
    const destination = posix.resolve(workdir, target);
    for (const source of args) {
      result.push({ source, destination: target.endsWith('/') || args.length > 1 ? posix.join(destination, posix.basename(source)) : destination });
    }
  }
  return result;
}

function glob(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '*' && pattern[i + 1] === '*') { out += '.*'; i++; if (pattern[i + 1] === '/') i++; }
    else if (char === '*') out += '[^/]*';
    else if (char === '?') out += '[^/]';
    else out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

// Docker semantics: the last matching line wins, and a pattern that matches a
// parent directory matches everything below it.
function admitted(dockerignore: string, path: string): boolean {
  const parts = path.split('/'), candidates = parts.map((_, index) => parts.slice(0, index + 1).join('/'));
  let excluded = false;
  for (const raw of dockerignore.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    const pattern = glob(posix.normalize(negated ? line.slice(1) : line).replace(/\/$/, ''));
    if (candidates.some(candidate => pattern.test(candidate))) excluded = !negated;
  }
  return !excluded;
}

const dockerfile = readFileSync(join(GATEWAY, 'Dockerfile'), 'utf8');
const dockerignore = readFileSync(join(GATEWAY, 'Dockerfile.dockerignore'), 'utf8');
const runtime = closure(ENTRYPOINTS.filter(entry => existsSync(join(GATEWAY, entry))));

test('the runtime closure reaches the shared PDF reader and never loads test fixtures', () => {
  for (const file of ['server/composio-gmail.ts', 'server/pdf-text.ts', 'server/helpers/pdf-text-worker.mjs']) {
    assert.ok(runtime.files.has(file), `${file} expected in the runtime closure`);
  }
  for (const file of runtime.files) {
    assert.doesNotMatch(file, /(?:\.test\.ts|\/testing\.ts|\/sandbox-smoke\.ts|\/demo\.ts|\/benchmark\.ts)$/, `${file} must never be loaded at runtime`);
  }
});

test('every runtime file is admitted by Dockerfile.dockerignore', () => {
  for (const file of runtime.files) assert.ok(admitted(dockerignore, file), `${file} is excluded from the build context`);
  for (const file of ['managed-gateway/package.json', 'managed-gateway/package-lock.json', 'managed-gateway/tsconfig.json']) {
    assert.ok(admitted(dockerignore, file), `${file} is excluded from the build context`);
  }
  for (const secret of ['managed-gateway/.env', 'managed-gateway/.env.local', 'managed-gateway/data/ledger.sqlite', 'server/key.pem', 'managed-gateway/testing.ts', 'managed-gateway/ledger.test.ts', 'server/store.ts']) {
    assert.ok(!admitted(dockerignore, secret), `${secret} must stay out of the build context`);
  }
});

test('every runtime file outside managed-gateway is copied to the same relative path', () => {
  const copied = copies(dockerfile);
  const destinations = new Set(copied.map(item => item.destination));
  assert.ok(copied.some(item => item.source === 'managed-gateway/*.ts' && item.destination === '/app/managed-gateway/*.ts'), 'gateway modules copied to /app/managed-gateway');
  for (const file of runtime.files) {
    if (file.startsWith('managed-gateway/')) {
      assert.match(file, /^managed-gateway\/[^/]+\.ts$/, `${file} is not matched by COPY managed-gateway/*.ts`);
      continue;
    }
    assert.ok(destinations.has(`/app/${file}`), `Dockerfile does not copy ${file} to /app/${file}`);
  }
});

test('every bare package import is pinned in package.json and package-lock.json at the root version', () => {
  const manifest = JSON.parse(readFileSync(join(GATEWAY, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  const lock = JSON.parse(readFileSync(join(GATEWAY, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string; dependencies?: Record<string, string> }> };
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), [...runtime.packages].sort(), 'package.json dependencies match the runtime imports exactly');
  assert.deepEqual(lock.packages['']?.dependencies ?? {}, manifest.dependencies ?? {}, 'package-lock.json is current with package.json');
  for (const name of runtime.packages) {
    const version = manifest.dependencies?.[name];
    assert.match(version ?? '', /^\d+\.\d+\.\d+$/, `${name} is pinned to an exact version`);
    assert.equal(version, root.dependencies?.[name] ?? root.devDependencies?.[name], `${name} matches the desktop's reviewed version`);
    assert.equal(lock.packages[`node_modules/${name}`]?.version, version, `${name} is locked at ${version}`);
  }
  assert.match(dockerfile, /^RUN npm ci\b/m, 'the image installs from the lockfile');
});
