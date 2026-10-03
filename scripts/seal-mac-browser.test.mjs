import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { sealMacBrowser } from './seal-mac-browser.mjs';
const run = promisify(execFile);
const codeSign = args => run('/usr/bin/codesign', args, { timeout: 15_000 });
const root = new URL('../', import.meta.url).pathname;
const native = { skip: process.platform !== 'darwin' };
async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), 'rb-sign-test-'));
  const stage = join(temporary, 'stage'); await mkdir(stage);
  for (const name of ['agent-browser', 'runtime.json']) await copyFile(join(root, 'dist-browser/hermes-native', name), join(stage, name));
  const app = join(temporary, 'Fictional.app'); const contents = join(app, 'Contents');
  const bundled = join(contents, 'Resources/browser/hermes-native'); await mkdir(bundled, { recursive: true });
  for (const name of ['agent-browser', 'runtime.json']) await copyFile(join(stage, name), join(bundled, name));
  await mkdir(join(contents, 'MacOS')); await copyFile(join(stage, 'agent-browser'), join(contents, 'MacOS/Fictional'));
  await writeFile(join(contents, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Fictional</string><key>CFBundleIdentifier</key><string>com.realbud.fictional</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
  return { temporary, stage, app, bundled, executable: join(bundled, 'agent-browser') };
}
test('binds the final signed native engine and re-seals the outer app without changing engine bytes', native, async () => {
  const f = await fixture();
  try {
    await codeSign(['--force', '--sign', '-', '--identifier', 'com.realbud.fictional-engine', f.executable]);
    await codeSign(['--force', '--sign', '-', f.app]);
    const before = createHash('sha256').update(await readFile(f.executable)).digest('hex');
    const result = await sealMacBrowser(f.app, f.stage); assert.equal(result.changed, true); assert.equal(result.sha256, before);
    const manifest = JSON.parse(await readFile(join(f.bundled, 'runtime.json'), 'utf8')); assert.equal(manifest.sha256, before);
    await codeSign(['--verify', '--deep', '--strict', f.app]);
    assert.equal(createHash('sha256').update(await readFile(f.executable)).digest('hex'), before);
  } finally { await rm(f.temporary, { recursive: true, force: true }); }
});
test('rejects packaged code changes even if the modified executable has a valid signature', native, async () => {
  const f = await fixture();
  try {
    await codeSign(['--remove-signature', f.executable]);
    const bytes = await readFile(f.executable); bytes[bytes.length - 1] ^= 1; await writeFile(f.executable, bytes);
    await codeSign(['--force', '--sign', '-', f.executable]); await codeSign(['--force', '--sign', '-', f.app]);
    await assert.rejects(sealMacBrowser(f.app, f.stage), /changed native browser code/);
  } finally { await rm(f.temporary, { recursive: true, force: true }); }
});
test('rejects changed staged input instead of blessing an unreviewed binary', native, async () => {
  const f = await fixture();
  try { await writeFile(join(f.stage, 'agent-browser'), 'fictional replacement'); await assert.rejects(sealMacBrowser(f.app, f.stage), /differs from the admitted build/); }
  finally { await rm(f.temporary, { recursive: true, force: true }); }
});
