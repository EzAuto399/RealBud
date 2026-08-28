import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("verify-mac-package must run on macOS");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.resolve(process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? path.join(root, "release"));
const releaseProof = process.argv.includes("--release");

function walkForApps(dir, depth = 0) {
  if (depth > 3 || !existsSync(dir)) return [];
  const apps = [];
  for (const name of readdirSync(dir)) {
    const item = path.join(dir, name);
    if (!statSync(item).isDirectory()) continue;
    if (name === "RealBud.app") apps.push(item);
    else apps.push(...walkForApps(item, depth + 1));
  }
  return apps;
}

function output(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function requireFile(file) {
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`missing packaged file: ${file}`);
}

function architectures(file) {
  return output("/usr/bin/lipo", ["-archs", file]).trim().split(/\s+/);
}

const apps = walkForApps(releaseDir);
if (!apps.length) throw new Error(`no unpacked RealBud.app found under ${releaseDir}`);

for (const app of apps) {
  const resources = path.join(app, "Contents", "Resources");
  const main = path.join(app, "Contents", "MacOS", "RealBud");
  const expectedArch = app.includes("x64") ? "x86_64" : app.includes("arm64") ? "arm64" : process.arch === "x64" ? "x86_64" : "arm64";
  const speech = path.join(resources, "RealBud Speech.app", "Contents", "MacOS", "speech-helper");
  const cuaDriver = path.join(resources, "cua-driver");
  const nativeDylib = path.join(resources, "cua-sdk", "native", "libcua_driver_sdk.dylib");
  const nativeNode = path.join(resources, "cua-sdk", "native", "cua_driver_node_runtime.node");
  for (const file of [
    main,
    path.join(resources, "app.asar"),
    path.join(resources, "ui", "index.html"),
    path.join(resources, "server", "index.js"),
    path.join(resources, "pack", "property", "SOUL.md"),
    path.join(resources, "pack", "property", "config.yaml"),
    path.join(resources, "pack", "property", "distribution.yaml"),
    path.join(resources, "pack", "property", "profile.yaml"),
    path.join(resources, "pack", "property", "skills", "intake-properties", "SKILL.md"),
    path.join(resources, "pack", "property", "skills", "morning-arrears", "SKILL.md"),
    cuaDriver,
    path.join(resources, "cua-sdk", "cua-sdk.mjs"),
    nativeDylib,
    nativeNode,
    speech,
  ]) requireFile(file);

  for (const file of [main, cuaDriver, nativeDylib, nativeNode, speech]) {
    if (!architectures(file).includes(expectedArch)) {
      throw new Error(`${file} does not contain the app architecture ${expectedArch}`);
    }
  }
  const cuaVersion = output(cuaDriver, ["--version"]).trim();
  if (cuaVersion !== "cua-driver 0.19.3") {
    throw new Error(`unexpected bundled CUA version: ${cuaVersion || "no output"}`);
  }
  output("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  const entitlements = output("/usr/bin/codesign", ["-d", "--entitlements", ":-", app]);
  if (entitlements.includes("allow-dyld-environment-variables")) {
    throw new Error("production-unsafe DYLD environment entitlement is present");
  }

  if (releaseProof) {
    const signature = output("/usr/bin/codesign", ["-dvv", app]);
    if (!signature.includes("Authority=Developer ID Application:")) {
      throw new Error("RealBud.app is not signed with a Developer ID Application certificate");
    }
    output("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
    output("/usr/bin/xcrun", ["stapler", "validate", app]);
  }
}

if (releaseProof) {
  const dmgs = readdirSync(releaseDir).filter((name) => name.endsWith(".dmg")).map((name) => path.join(releaseDir, name));
  if (!dmgs.length) throw new Error("release verification found no DMG");
  for (const dmg of dmgs) output("/usr/bin/xcrun", ["stapler", "validate", dmg]);
}

console.log(`[verify-mac-package] OK: ${apps.length} app bundle${apps.length === 1 ? "" : "s"}${releaseProof ? ", Developer ID, Gatekeeper, and stapling" : ""}`);
