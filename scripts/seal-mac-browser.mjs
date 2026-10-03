// Signing changes Mach-O bytes. Admit the reviewed engine before packaging,
// then bind its final signed bytes and re-seal only the outer application.
// Never use --deep after this step: that would invalidate the byte manifest.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const codeSign = args => run('/usr/bin/codesign', args, { timeout: 120_000, maxBuffer: 64_000 });

export async function sealMacBrowser(app, stage = join(root, 'dist-browser', 'hermes-native')) {
  if (process.platform !== 'darwin') throw new Error('macOS browser sealing requires macOS.');
  const folder = join(app, 'Contents', 'Resources', 'browser', 'hermes-native');
  const manifestPath = join(folder, 'runtime.json');
  const executable = join(folder, 'agent-browser');
  const original = join(stage, 'agent-browser');
  for (const path of [manifestPath, executable, original, join(stage, 'runtime.json')]) {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Browser signing inputs must be regular independent files.');
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const staged = JSON.parse(await readFile(join(stage, 'runtime.json'), 'utf8'));
  if (staged.engine !== 'hermes-agent-browser' || staged.version !== '0.26.0' || staged.platform !== 'darwin' || manifest.engine !== staged.engine || manifest.version !== staged.version || manifest.arch !== staged.arch || manifest.platform !== staged.platform || hash(await readFile(original)) !== staged.sha256) throw new Error('Browser signing input differs from the admitted build.');
  const finalHash = hash(await readFile(executable));
  if (finalHash === staged.sha256) {
    if (manifest.sha256 !== finalHash) throw new Error('Packaged browser manifest differs from the admitted build.');
    return { changed: false, sha256: finalHash };
  }
  const scratch = await mkdtemp(join(tmpdir(), 'rb-browser-signing-'));
  try {
    // Compare complete copies under the same deterministic signature, not a
    // version string. Removing signatures alone leaves different linker
    // padding; applying the same fresh signature normalizes that padding too.
    // A signer may change the signature, never the engine's executable code.
    const copies = [join(scratch, 'original'), join(scratch, 'packaged')];
    await copyFile(original, copies[0]); await copyFile(executable, copies[1]);
    for (const copy of copies) await codeSign(['--force', '--sign', '-', '--identifier', 'com.realbud.engine-comparison', '--timestamp=none', copy]);
    if (hash(await readFile(copies[0])) !== hash(await readFile(copies[1]))) throw new Error('Signing changed native browser code; the package cannot be admitted.');
    await codeSign(['--verify', '--strict', executable]);
    const details = await codeSign(['--display', '--verbose=4', app]);
    let identity = '-';
    if (!/^Signature=adhoc$/m.test(details.stderr)) {
      const prefix = join(scratch, 'certificate-');
      await codeSign(['--display', '--extract-certificates', prefix, app]);
      identity = createHash('sha1').update(await readFile(`${prefix}0`)).digest('hex');
    }
    await writeFile(manifestPath, JSON.stringify({ ...staged, sha256: finalHash, stagedSha256: staged.sha256 }));
    await codeSign(['--force', '--sign', identity, '--preserve-metadata=identifier,requirements,entitlements,flags,runtime', identity === '-' ? '--timestamp=none' : '--timestamp', app]);
    await codeSign(['--verify', '--deep', '--strict', app]);
    if (hash(await readFile(executable)) !== finalHash) throw new Error('Outer signing unexpectedly changed the browser engine.');
    return { changed: true, sha256: finalHash };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

// electron-builder calls this after all nested signing and before artifacts.
export default async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  await sealMacBrowser(join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Pass the built macOS application path.');
  console.log(JSON.stringify(await sealMacBrowser(resolve(process.argv[2]))));
}
