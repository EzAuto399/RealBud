// Build-time admission of Hermes's native browser engine. Never npm install,
// lifecycle scripts, npx at runtime, or a floating version. Wiring this new
// bundle into the product still requires connection/lifecycle acceptance.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { windowsTar } from './package-files.mjs';
const run = promisify(execFile);
const version = '0.26.0';
// Official npm version metadata observed 24 September 2026. Every platform
// binary below is admitted by this complete archive integrity, then receives
// its own byte hash in the packaged runtime manifest.
const integrity = 'pdqSfjwbFSp+qnwlb2g23e9wXveIOfMi19xpPA9xZUbzEAUp6W4YBZj6Ybj8z4M7WkcbGDDYc+oDIHDt9R3EDQ==';
const binaries = { 'darwin-arm64': 'agent-browser-darwin-arm64', 'darwin-x64': 'agent-browser-darwin-x64', 'win32-x64': 'agent-browser-win32-x64.exe', 'linux-x64': 'agent-browser-linux-musl-x64', 'linux-arm64': 'agent-browser-linux-musl-arm64' };
const member = binaries[`${process.platform}-${process.arch}`];
if (!member) throw new Error('No reviewed native browser engine for this platform.');
const root = fileURLToPath(new URL('../', import.meta.url));
const cache = join(root, '.browser-cache'); await mkdir(cache, { recursive: true });
const archive = join(cache, `agent-browser-${version}.tgz`);
let bytes;
try { bytes = await readFile(archive); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!bytes) {
  const response = await fetch(`https://registry.npmjs.org/agent-browser/-/agent-browser-${version}.tgz`, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok || Number(response.headers.get('content-length') || 0) > 150_000_000) throw new Error('Native browser archive download failed.');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 150_000_000) throw new Error('Native browser archive is too large.'); chunks.push(chunk); }
  bytes = Buffer.concat(chunks);
}
if (bytes.length > 150_000_000 || createHash('sha512').update(bytes).digest('base64') !== integrity) throw new Error('Native browser archive differs from its reviewed integrity.');
await writeFile(archive, bytes);
const scratch = await mkdtemp(join(tmpdir(), 'rb-native-stage-'));
try {
  const tar = process.platform === 'win32' ? windowsTar() : 'tar';
  const wanted = [`package/bin/${member}`, 'package/LICENSE'];
  const listing = (await run(tar, ['-tf', archive])).stdout.trim().split(/\r?\n/);
  if (wanted.some(entry => listing.filter(name => name === entry).length !== 1)) throw new Error('Native browser archive layout needs review.');
  await run(tar, ['-xf', archive, '-C', scratch, ...wanted]);
  const source = join(scratch, 'package/bin', member); await chmod(source, 0o755);
  const checked = await run(source, ['--version'], { cwd: scratch, timeout: 5000 });
  if (checked.stdout.trim() !== `agent-browser ${version}`) throw new Error('Native browser version does not match the reviewed archive.');
  const stage = join(root, 'dist-browser', 'hermes-native'); await mkdir(stage, { recursive: true });
  const name = process.platform === 'win32' ? 'agent-browser.exe' : 'agent-browser';
  const binary = await readFile(source); const sha256 = createHash('sha256').update(binary).digest('hex');
  await writeFile(join(stage, `${name}.tmp`), binary, { mode: 0o755 }); await chmod(join(stage, `${name}.tmp`), 0o755);
  await rename(join(stage, `${name}.tmp`), join(stage, name));
  await writeFile(join(stage, 'LICENSE'), await readFile(join(scratch, 'package/LICENSE')));
  await writeFile(join(stage, 'runtime.json'), JSON.stringify({ engine: 'hermes-agent-browser', version, platform: process.platform, arch: process.arch, sha256, archiveIntegrity: `sha512-${integrity}`, source: `https://registry.npmjs.org/agent-browser/-/agent-browser-${version}.tgz`, license: 'Apache-2.0' }));
  console.log(JSON.stringify({ staged: true, version, platform: process.platform, arch: process.arch, sha256 }));
} finally { await rm(scratch, { recursive: true, force: true }); }
