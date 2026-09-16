#!/usr/bin/env node
// Notarize the exact packaged app, embed its ticket in fresh archives, then
// notarize the DMG and regenerate its update metadata before local promotion.
// Uses only the named Keychain profile; it never publishes a GitHub release.
// NOTARY_WAIT=0 submits the first container only and retains the staging path.
// NOTARY_SUBMIT=zip|app|dmg selects the first container (app uses a ZIP).
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fileInfo, promoteArtifacts, refreshMetadata, releaseNames, requireAccepted } from "./lib/mac-release.mjs";

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.join(root, "release");
const profile = process.env.NOTARY_KEYCHAIN_PROFILE || "realbud-notary";
const submitKind = process.env.NOTARY_SUBMIT || "zip";
const wait = process.env.NOTARY_WAIT !== "0";
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder"));
const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib"));
const yaml = appBuilderRequire("js-yaml");
const { buildBlockMap } = builderRequire("app-builder-lib/out/targets/blockmap/blockmap.js");

async function run(command, args, timeout = 120_000) {
  try {
    const result = await execute(command, args, { cwd: root, encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
    return `${result.stdout || ""}${result.stderr || ""}`;
  } catch (error) {
    throw new Error(`${path.basename(command)} failed${error.killed ? " (timeout)" : ""}:\n${error.stdout || ""}${error.stderr || error.message}`);
  }
}
const step = message => console.log(`[notarize-mac] ${message}`);
const staple = async target => { await run("xcrun", ["stapler", "staple", target]); await run("xcrun", ["stapler", "validate", target]); };
const verifySignature = target => run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", target]);
async function identity(app) {
  await verifySignature(app);
  const details = await run("codesign", ["-d", "--verbose=4", app]);
  const cdhash = details.match(/^CDHash=(\w+)$/m)?.[1];
  if (!cdhash || !details.includes("TeamIdentifier=4F4SMS88P8") || !details.includes("Authority=Developer ID Application:")) throw new Error("App is not signed by the expected RealBud Developer ID");
  return cdhash;
}
async function verifyApp(app, expectedIdentity) {
  if (await identity(app) !== expectedIdentity) throw new Error("Archive contains a different app build");
  await run("xcrun", ["stapler", "validate", app]);
  const assessment = await run("/usr/sbin/spctl", ["--assess", "--type", "execute", "-vv", app]);
  if (!assessment.includes("source=Notarized Developer ID")) throw new Error("Gatekeeper did not confirm notarized Developer ID");
}

let stage, lock, succeeded = false;
const lockPath = path.join(releaseDir, ".notarize.lock");
try {
  if (process.platform !== "darwin") throw new Error("Mac notarization requires macOS");
  if (!/^[a-zA-Z0-9 _.-]{1,100}$/.test(profile) || !["zip", "app", "dmg"].includes(submitKind)) throw new Error("Invalid notary profile or submission kind");
  const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
  const names = releaseNames(version);
  const originalApp = path.join(releaseDir, "mac-arm64", "RealBud.app");
  if (!existsSync(originalApp)) throw new Error("Missing packaged app; run pnpm package:mac first");
  // Refuse concurrent notarization. A crash deliberately leaves this lock for
  // inspection so another run cannot overwrite a partially promoted release.
  lock = openSync(lockPath, "wx", 0o600);
  writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), version }));
  const bundleVersion = (await run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", path.join(originalApp, "Contents/Info.plist")])).trim();
  if (bundleVersion !== version) throw new Error("Packaged app version differs from package.json");
  const originalIdentity = await identity(originalApp);
  await run("xcrun", ["notarytool", "history", "--keychain-profile", profile, "--output-format", "json"], 30_000);
  stage = mkdtempSync(path.join(releaseDir, ".notary-stage-"));
  writeFileSync(path.join(stage, "source.json"), JSON.stringify({ version, cdhash: originalIdentity }));
  const app = path.join(stage, "RealBud.app");
  await run("/usr/bin/ditto", [originalApp, app]);
  const output = path.join(stage, "artifacts");
  mkdirSync(output);
  const submissions = [];
  async function submit(file, label) {
    // Persist the id immediately after upload. A timed-out wait can be resumed
    // with notarytool wait; a repeat upload is never automatic.
    step(`Submit ${label} to Apple`);
    const response = JSON.parse(await run("xcrun", ["notarytool", "submit", file, "--keychain-profile", profile, "--output-format", "json"], 600_000));
    if (!/^[a-f0-9-]{36}$/i.test(response.id ?? "")) throw new Error("Apple did not return a submission id");
    submissions.push({ label, id: response.id });
    writeFileSync(path.join(stage, "submissions.json"), JSON.stringify(submissions, null, 2));
    step(`${label} submission ${response.id}${wait ? "; waiting for acceptance" : "; submitted only"}`);
    if (!wait) return false;
    const result = JSON.parse(await run("xcrun", ["notarytool", "wait", response.id, "--keychain-profile", profile, "--timeout", "10m", "--output-format", "json"], 620_000));
    requireAccepted(result);
    step(`Apple accepted ${label}`);
    return true;
  }
  async function archive() {
    step("Build fresh DMG, ZIP and update metadata from the selected app");
    await run(path.join(root, "node_modules/.bin/electron-builder"), ["--prepackaged", app, "--mac", "dmg", "zip", "--arm64", "--publish", "never", `--config.directories.output=${output}`], 600_000);
  }

  let alreadyStapled = false;
  try { await run("xcrun", ["stapler", "validate", app]); alreadyStapled = true; } catch { /* An unstapled input is the normal first run. */ }
  if (!alreadyStapled || !wait) {
    let initial;
    if (submitKind === "dmg") { await archive(); initial = path.join(output, names.dmg); }
    else { initial = path.join(stage, "submission.zip"); await run("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, initial]); }
    if (!await submit(initial, "app")) {
      step(`Submission pending; release files unchanged. Keep ${stage} to resume the Apple request.`);
    } else {
      await staple(app);
      alreadyStapled = true;
    }
  }
  if (wait && alreadyStapled) {
    await verifyApp(app, originalIdentity);
    await archive();
    const dmg = path.join(output, names.dmg);
    await submit(dmg, "DMG");
    await staple(dmg);
    await verifySignature(dmg);
    await run("/usr/sbin/spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "-vv", dmg]);
    // Stapling mutates the DMG; regenerate its block map before its hash is
    // recorded. The ZIP already contains the stapled app from archive().
    const dmgInfo = await buildBlockMap(dmg, "gzip", `${dmg}.blockmap`);
    const zipInfo = await fileInfo(path.join(output, names.zip));
    const metadata = refreshMetadata(yaml.load(readFileSync(path.join(output, names.metadata), "utf8")), version, { [names.dmg]: dmgInfo, [names.zip]: zipInfo });
    writeFileSync(path.join(output, names.metadata), yaml.dump(metadata));
    const extracted = path.join(stage, "zip-check");
    await run("/usr/bin/ditto", ["-x", "-k", path.join(output, names.zip), extracted]);
    await verifyApp(path.join(extracted, "RealBud.app"), originalIdentity);
    const mount = path.join(stage, "dmg-check");
    mkdirSync(mount);
    await run("hdiutil", ["attach", dmg, "-readonly", "-nobrowse", "-mountpoint", mount]);
    try { await verifyApp(path.join(mount, "RealBud.app"), originalIdentity); }
    finally { await run("hdiutil", ["detach", mount]); }
    if (await identity(originalApp) !== originalIdentity) throw new Error("Packaged app changed while notarizing; release files unchanged");
    await staple(originalApp);
    await verifyApp(originalApp, originalIdentity);
    const receipt = { version, cdhash: originalIdentity, verifiedAt: new Date().toISOString(), submissions, files: { [names.zip]: zipInfo, [names.dmg]: dmgInfo }, gatekeeper: "Notarized Developer ID", published: false };
    writeFileSync(path.join(output, "mac-notarization.json"), JSON.stringify(receipt, null, 2));
    promoteArtifacts(output, releaseDir, [names.zip, `${names.zip}.blockmap`, names.dmg, `${names.dmg}.blockmap`, names.metadata, "mac-notarization.json"]);
    succeeded = true;
    step(`OK — ${version} app, DMG and ZIP verified; current block maps and update checksums saved. No public release was created.`);
  }
} catch (error) {
  console.error(`[notarize-mac] FAILED: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (lock !== undefined) { closeSync(lock); rmSync(lockPath, { force: true }); }
  if (stage && succeeded) rmSync(stage, { recursive: true, force: true });
  else if (stage) console.error(`[notarize-mac] Retained staging and submission diagnostics: ${stage}`);
}
