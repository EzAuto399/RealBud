// Assemble an isolated, transferable synthetic-test kit from verified build
// outputs and the explicitly staged PostgreSQL runtime. No live data is copied.
import { chmod, cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(process.argv[2]); const postgres = resolve(process.argv[3]);
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This kit builder requires the tested Apple-silicon Mac runtime.');
try { await stat(target); throw new Error('Use a new test-kit destination.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const receipt = JSON.parse(await readFile(join(postgres, 'test-runtime-manifest.json'), 'utf8'));
if (receipt.purpose !== 'synthetic-test-only' || receipt.architecture !== 'arm64') throw new Error('Test PostgreSQL manifest mismatch.');
for (const entry of receipt.files) {
  if (createHash('sha256').update(await readFile(join(postgres, entry.path))).digest('hex') !== entry.sha256) throw new Error('Staged PostgreSQL digest mismatch.');
}
await mkdir(join(target, 'runtime'), { recursive: true });
await cp(process.execPath, join(target, 'runtime/node'));
await cp(join(dirname(dirname(process.execPath)), 'LICENSE'), join(target, 'runtime/Node-LICENSE'));
await cp(postgres, join(target, 'postgres'), { recursive: true });
await cp(join(root, 'dist-server'), join(target, 'resources'), { recursive: true });
await cp(join(root, 'dist'), join(target, 'resources/ui'), { recursive: true });
await cp(join(root, 'pack/property'), join(target, 'resources/pack/property'), { recursive: true });
await writeFile(join(target, 'resources/package.json'), '{"type":"module"}\n');
await mkdir(join(target, 'scripts'));
for (const name of ['start-test-lab.mjs', 'qa-company-portable.mjs']) await cp(join(root, 'scripts', name), join(target, 'scripts', name));
await cp(join(root, 'docs/REALBUD-TWO-PROFILE-TEST-GUIDE-2026-09-14.md'), join(target, 'START-HERE.md'));
await cp(join(root, 'pack/testing/two-profile-practice.json'), join(target, 'practice-pack.json'));
for (const role of ['host', 'client']) {
  const name = role === 'host' ? 'Start Host.command' : 'Start Second Profile.command';
  await writeFile(join(target, name), `#!/bin/zsh\nset -eu\nkit_dir="$(cd -- "$(dirname -- "$0")" && pwd)"\nexec "$kit_dir/runtime/node" "$kit_dir/scripts/start-test-lab.mjs" ${role}\n`);
  await chmod(join(target, name), 0o755);
}
await writeFile(join(target, 'Run Native Checks.command'), `#!/bin/zsh\nset -eu\nkit_dir="$(cd -- "$(dirname -- "$0")" && pwd)"\nexport REALBUD_TEST_RESOURCES="$kit_dir/resources"\nexport REALBUD_TEST_POSTGRES_BIN="$kit_dir/postgres/bin"\nexport REALBUD_TEST_OUTPUT="$kit_dir/check-results"\nexec "$kit_dir/runtime/node" "$kit_dir/scripts/qa-company-portable.mjs"\n`);
await chmod(join(target, 'Run Native Checks.command'), 0o755);
const execute = promisify(execFile); const minVersions = [];
for (const file of [join(target, 'runtime/node'), ...receipt.files.map(file => join(target, 'postgres', file.path))]) {
  const { stdout } = await execute('otool', ['-l', file], { timeout: 10_000 });
  for (const match of stdout.matchAll(/\bminos\s+(\d+(?:\.\d+){1,2})/g)) minVersions.push(match[1]);
}
const minimumMacOS = minVersions.sort((a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); return (x[0] - y[0]) || (x[1] - y[1]) || ((x[2] || 0) - (y[2] || 0)); }).at(-1);
await writeFile(join(target, 'test-kit.json'), JSON.stringify({ kind: 'RealBud synthetic two-profile test kit', platform: process.platform, arch: process.arch,
  minimumMacOS, node: process.version, postgres: receipt.version, atomicCredentialEnrollment: true, customerInstaller: false, nativeCuaIncluded: false, hermesRuntimeIncluded: false,
  nodeSha256: createHash('sha256').update(await readFile(join(target, 'runtime/node'))).digest('hex'), builtAt: new Date().toISOString() }, null, 2) + '\n');
console.log(`Test kit assembled: ${target}; minimum recorded native build target macOS ${minimumMacOS}`);
