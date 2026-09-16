// The packaged server has no node_modules. Bundle only its new external
// dependencies, preserving every compiled module's existing relative paths.
import { build } from 'esbuild';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = join(root, 'dist-server/server');
const vendor = join(server, 'vendor');
await mkdir(vendor, { recursive: true });
const bundles = { pg: 'Pool', selfsigned: 'generate' };
const receipt = { node: process.version, bundles: {}, rewritten: [] };
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
      const after = before.replace(/(\bfrom\s*|\bimport\s*\(\s*)(['"])(pg|selfsigned)\2/g, (_match, prefix, quote, name) => {
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
