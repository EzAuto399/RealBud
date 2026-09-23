// The packaged server has no node_modules. Bundle only its new external
// dependencies, preserving every compiled module's existing relative paths.
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = join(root, 'dist-server/server');
const vendor = join(server, 'vendor');
await mkdir(vendor, { recursive: true });

// tsc emits only what it compiles. Hand-written .mjs, .d.mts and fixture data are
// runtime inputs it leaves behind, so the packaged server crashed on boot with
// "Cannot find module dist-server/shared/service-identity.mjs" — the compiled
// server/index.js imports that path and nothing ever put it there. Copy the
// non-TypeScript inputs the server actually loads, preserving relative paths.
const NON_TS = /\.(mjs|d\.mts|json|ya?ml|md|txt|csv|html|py)$/;
async function copyRuntimeInputs(sourceDir, targetDir) {
  let copied = 0;
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    const from = join(sourceDir, entry.name);
    const to = join(targetDir, entry.name);
    if (entry.isDirectory()) {
      // Mirrors tsconfig.server.build.json: the test tree is not shipped.
      if (from === join(root, 'server/testing') || entry.name === '__pycache__') continue;
      await mkdir(to, { recursive: true });
      copied += await copyRuntimeInputs(from, to);
    } else if (NON_TS.test(entry.name)) {
      await mkdir(dirname(to), { recursive: true });
      await writeFile(to, await readFile(from));
      copied += 1;
    }
  }
  return copied;
}
const runtimeInputs = await Promise.all(
  [['server', server], ['shared', join(root, 'dist-server/shared')]].map(([name, target]) =>
    copyRuntimeInputs(join(root, name), target),
  ),
);
const copiedRuntimeInputs = runtimeInputs.reduce((total, count) => total + count, 0);

// Every relative specifier the compiled server still resolves at runtime must exist
// in dist-server. Catch a missing runtime input at build time rather than as a crash
// on a customer's Mac, which is how the service-identity omission reached a release.
const REQUIRED = [/\.mjs$/, /\.json$/];
async function verifyRuntimeInputs(directory) {
  let missing = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) { if (file !== vendor) missing = missing.concat(await verifyRuntimeInputs(file)); continue; }
    if (!entry.name.endsWith('.js')) continue;
    const body = await readFile(file, 'utf8');
    for (const match of body.matchAll(/(?:from\s*|import\s*\(\s*)(['"])(\.[^'"]+)\1/g)) {
      const specifier = match[2];
      if (!REQUIRED.some(pattern => pattern.test(specifier))) continue;
      if (!existsSync(resolve(dirname(file), specifier))) missing.push(`${relative(root, file)} -> ${specifier}`);
    }
  }
  return missing;
}
const missingRuntimeInputs = await verifyRuntimeInputs(server);
if (missingRuntimeInputs.length) {
  console.error('Packaged server would fail at runtime; missing inputs:');
  for (const item of missingRuntimeInputs.slice(0, 20)) console.error(`  ${item}`);
  process.exit(1);
}


const bundles = { pg: 'Pool', selfsigned: 'generate', yaml: 'parseDocument, isMap, isSeq, YAMLMap' };
// These helpers are resolved dynamically rather than by JS imports. Verify the
// exact shipped bytes as part of every server build; no checkout fallback.
const helpers = {};
for (const name of ['hermes-memory-review.py', 'hermes-memory-proposals.py', 'hermes-memory-windows.py', 'hermes-memory-windows-native.py', 'hermes-memory-windows-journal.py', 'department-worker.py']) {
  const source = await readFile(join(root, 'server/helpers', name));
  const packaged = await readFile(join(server, 'helpers', name));
  if (!source.equals(packaged)) throw new Error(`Packaged memory helper differs from source: ${name}`);
  helpers[name] = { sha256: createHash('sha256').update(packaged).digest('hex') };
}
const receipt = { node: process.version, bundles: {}, helpers, rewritten: [] };
for (const [name, exports] of Object.entries(bundles)) {
  const file = join(vendor, `${name}.mjs`);
  const result = await build({
    stdin: { contents: `export { ${exports} } from ${JSON.stringify(name)};`, resolveDir: root, sourcefile: `${name}-entry.mjs` },
    outfile: file, bundle: true, platform: 'node', target: 'node24', format: 'esm',
    // pg-native is an optional accelerator. The product uses the JS driver.
    external: ['pg-native'], metafile: true, legalComments: 'inline',
    banner: { js: 'import { createRequire as realbudCreateRequire } from "node:module"; const require = realbudCreateRequire(import.meta.url);' },
  });
  receipt.bundles[name] = { sha256: createHash('sha256').update(await readFile(file)).digest('hex'), inputs: Object.keys(result.metafile.inputs).sort() };
}
async function rewrite(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (file === vendor) continue;
    if (entry.isDirectory()) await rewrite(file);
    else if (entry.name.endsWith('.js')) {
      const before = await readFile(file, 'utf8');
      // Every named import of a bundled package must be exported by its bundle;
      // otherwise the packaged service fails to start (seen with yaml `isSeq`).
      for (const found of before.matchAll(/import\s*\{([^}]*)\}\s*from\s*(['"])(pg|selfsigned|yaml)\2/g)) {
        const exported = new Set(bundles[found[3]].split(',').map(name => name.trim()));
        for (const imported of found[1].split(',').map(part => part.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
          if (!exported.has(imported)) throw new Error(`${relative(server, file)} imports ${imported} from ${found[3]}, which the packaged bundle does not export; add it to bundles.${found[3]}.`);
        }
      }
      const after = before.replace(/(\bfrom\s*|\bimport\s*\(\s*)(['"])(pg|selfsigned|yaml)\2/g, (_match, prefix, quote, name) => {
        let path = relative(dirname(file), join(vendor, `${name}.mjs`)).replaceAll('\\', '/');
        if (!path.startsWith('.')) path = './' + path;
        return `${prefix}${quote}${path}${quote}`;
      });
      if (after !== before) { await writeFile(file, after); receipt.rewritten.push(relative(server, file)); }
    }
  }
}
await rewrite(server);
await writeFile(join(vendor, 'company-dependencies.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(`Bundled company dependencies into packaged server; rewrote ${receipt.rewritten.length} modules.`);
