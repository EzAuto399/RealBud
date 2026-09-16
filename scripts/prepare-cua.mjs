// Stage the macOS CUA executable and native SDK outside ASAR. The npm SDK
// deliberately does not ship the `cua-driver` CLI, so packaging must fail
// loudly instead of producing an app whose "This computer" option can never
// work. CUA_DRIVER_PATH is the CI/release override; otherwise an exact-version
// installed binary or the checksummed official release asset is used.
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, chmod, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = promisify(execFile);
const stage = join(root, "dist-native");
const sdkEntry = fileURLToPath(import.meta.resolve("@trycua/cua-driver"));
const sdkRoot = realpathSync(join(dirname(sdkEntry), ".."));
const dependencyRoot = join(sdkRoot, "..", "..");
const sdkPackage = JSON.parse(await readFile(join(sdkRoot, "package.json"), "utf8"));
const expectedVersion = String(sdkPackage.version);
const isWindows = process.platform === "win32";
if (!isWindows && process.platform !== "darwin") throw new Error("CUA packaging supports macOS and Windows only.");
if (isWindows && process.arch !== "x64") throw new Error("This Windows installer currently requires an x64 build host.");
const executable = isWindows ? "cua-driver.exe" : "cua-driver";
const nativeLibrary = isWindows ? "cua_driver_sdk.dll" : "libcua_driver_sdk.dylib";
const release = isWindows ? {
  version: "0.19.3",
  file: "cua-driver-rs-0.19.3-windows-x86_64-binary.zip",
  sha256: "51a316b14ec9667c04106d8aff80d696ded427cb64cef48de09095e4709f583d",
} : {
  version: "0.19.3",
  file: "cua-driver-rs-0.19.3-darwin-universal-binary.tar.gz",
  sha256: "733e28a3782ac8d325f8fce8b5d97486c1054af755b40dfd086151b34c79377e",
};
if (expectedVersion !== release.version) {
  throw new Error(
    `CUA SDK ${expectedVersion} has no pinned executable asset in prepare-cua.mjs; update the release checksum first`,
  );
}

async function binaryVersion(candidate) {
  if (!candidate || !existsSync(candidate)) return null;
  try {
    const { stdout } = await run(candidate, ["--version"], { timeout: 5000 });
    return stdout.match(/cua-driver\s+([\d.]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function officialBinary() {
  const cache = join(root, "node_modules", ".cache", "realbud", `cua-driver-${release.version}${isWindows ? "-win32-x64" : ""}`);
  const cachedBinary = join(cache, executable);
  const companionsReady = !isWindows || ["cua-driver-uia.exe", "cua-cursor-theme.exe", "cua_driver_sdk.dll", "cua_driver_node_runtime.node"].every(file => existsSync(join(cache, file)));
  if (companionsReady && (await binaryVersion(cachedBinary)) === expectedVersion) return cachedBinary;

  await rm(cache, { recursive: true, force: true });
  await mkdir(cache, { recursive: true });
  const url = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${release.version}/${release.file}`;
  console.log(`Downloading CUA Driver ${release.version} from the official release…`);
  const response = await fetch(url, { headers: { "user-agent": "RealBud-packager" } });
  if (!response.ok) throw new Error(`CUA Driver download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== release.sha256) {
    throw new Error(`CUA Driver checksum mismatch: expected ${release.sha256}, got ${digest}`);
  }
  const archive = join(cache, release.file);
  await writeFile(archive, bytes);
  if (isWindows) await run("tar.exe", ["-xf", archive, "-C", cache, executable, "cua-driver-uia.exe", "cua-cursor-theme.exe", "cua_driver_sdk.dll", "cua_driver_node_runtime.node"]);
  else {
    await run("/usr/bin/tar", ["-xzf", archive, "-C", cache, executable]);
    await chmod(cachedBinary, 0o755);
  }
  if ((await binaryVersion(cachedBinary)) !== expectedVersion) {
    throw new Error(`downloaded CUA Driver does not report version ${expectedVersion}`);
  }
  return cachedBinary;
}

let binary;
if (process.env.CUA_DRIVER_PATH) {
  const suppliedVersion = await binaryVersion(process.env.CUA_DRIVER_PATH);
  if (suppliedVersion !== expectedVersion) {
    throw new Error(
      `CUA_DRIVER_PATH must point to cua-driver ${expectedVersion}; found ${suppliedVersion ?? "an unreadable binary"}`,
    );
  }
  binary = process.env.CUA_DRIVER_PATH;
} else {
  const installed = isWindows ? "" : "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";
  binary = (await binaryVersion(installed)) === expectedVersion ? installed : await officialBinary();
}
const details = await stat(binary);
if (!details.isFile() || (!isWindows && (details.mode & 0o111) === 0)) {
  throw new Error(`cua-driver is not an executable file: ${binary}`);
}

await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await copyFile(binary, join(stage, executable));
if (isWindows) {
  for (const companion of ["cua-driver-uia.exe", "cua-cursor-theme.exe", "cua_driver_sdk.dll", "cua_driver_node_runtime.node"]) {
    await copyFile(join(dirname(binary), companion), join(stage, companion));
  }
}
if (!isWindows) await chmod(join(stage, executable), 0o755);
// A binary copied out of CuaDriver.app retains a bundle-relative signature
// whose Info.plist no longer exists at the new path. Give the staged file a
// valid temporary signature; electron-builder replaces it with the enclosing
// app's identity during its nested-code signing pass.
if (!isWindows) await run("/usr/bin/codesign", [
  "--force",
  "--sign",
  "-",
  "--options",
  "runtime",
  join(stage, "cua-driver"),
]);

// Bundle the JS side into one ESM file so electron-builder's intentional
// node_modules exclusion cannot drop it. The SDK resolves its native library
// through @ubjs at runtime; redirect those generated lookups to the two native
// files staged beside the bundle.
const cuaSdkDir = join(stage, "cua-sdk");
const nativeDir = join(cuaSdkDir, "native");
const nativePackage = join(dependencyRoot, "@trycua", isWindows ? "cua-driver-win32-x64-msvc" : "cua-driver-darwin-arm64");
if (!existsSync(nativePackage)) throw new Error("required CUA native package is missing for this platform");
await mkdir(nativeDir, { recursive: true });
await Promise.all([
  copyFile(join(realpathSync(nativePackage), nativeLibrary), join(nativeDir, nativeLibrary)),
  copyFile(join(realpathSync(nativePackage), "cua_driver_node_runtime.node"), join(nativeDir, "cua_driver_node_runtime.node")),
  copyFile(join(realpathSync(nativePackage), "node-runtime-NOTICE.md"), join(nativeDir, "node-runtime-NOTICE.md")),
]);
const bundle = join(cuaSdkDir, "cua-sdk.mjs");
await build({
  stdin: {
    contents: [
      'export { EmbeddedCuaDriverHost, CuaDriver } from "@trycua/cua-driver";',
      ...(isWindows ? [] : ['export { requestMacOSPermissions, hasRequiredMacOSPermissions } from "@trycua/cua-driver/electron";']),
    ].join("\n"),
    resolveDir: root,
    sourcefile: "openmausbot-cua-entry.mjs",
    loader: "js",
  },
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  banner: {
    js: 'import { createRequire as __openmausbotCreateRequire } from "node:module"; const require = __openmausbotCreateRequire(import.meta.url);',
  },
  outfile: bundle,
  logLevel: "silent",
});
const bundledSource = await readFile(bundle, "utf8");
const resolverPattern = /function resolveLibPath\d*\(opts\) \{/g;
const resolvers = bundledSource.match(resolverPattern) ?? [];
if (resolvers.length !== 1) {
  throw new Error("could not patch the bundled CUA native-library resolver");
}
await writeFile(
  bundle,
  bundledSource.replace(
    resolverPattern,
    `${resolvers[0]}\n      if (process.env.OPENMAUSBOT_CUA_SDK_LIBRARY) return resolveOverride(opts.crateName, process.env.OPENMAUSBOT_CUA_SDK_LIBRARY);`,
  ),
);

console.log(`Staged CUA from ${binary}`);
