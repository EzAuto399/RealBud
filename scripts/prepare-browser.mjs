// Build-time only: ship the reviewed BrowserSkill CLI with RealBud. No staff shell setup.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { windowsTar } from "./package-files.mjs";
const run = promisify(execFile);
const version = "0.3.0";
const artifacts = {
  "darwin-arm64": ["aarch64-apple-darwin.tar.gz", "f85b2d463d1928f79850ec95c7f812c1dfb844bb1d5d6bbf961e813f28d00df2"],
  "darwin-x64": ["x86_64-apple-darwin.tar.gz", "887ac94f43f3896e25843ca055d4fb163f60dccdd3eed1db27fbe0d6c518e483"],
  "win32-x64": ["x86_64-pc-windows-msvc.zip", "cd31665559d0faae2cfb79ab1c3cb6854bce10b4fde510be015456e8370f629e"],
  "linux-x64": ["x86_64-unknown-linux-musl.tar.gz", "0eb2b40aff955898d21c1adfc70a3d6c84da9730b39b6fd4d5c12457274d0260"],
  "linux-arm64": ["aarch64-unknown-linux-musl.tar.gz", "60c61f740ae820a085425e65e914ea0d68c21ce87f7038a29a372fd8d63896db"],
};
const artifact = artifacts[`${process.platform}-${process.arch}`];
if (!artifact) throw new Error("No reviewed browser helper for this platform.");
const root = fileURLToPath(new URL("../", import.meta.url));
const stage = join(root, "dist-browser");
const binary = process.platform === "win32" ? "bsk.exe" : "bsk";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const filename = `bsk-v${version}-${artifact[0]}`;
const cache = join(root, ".browser-cache");
await mkdir(cache, { recursive: true });
const archive = join(cache, filename);
let bytes;
try { bytes = await readFile(archive); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (!bytes) {
  const response = await fetch(`https://github.com/Tencent/BrowserSkill/releases/download/cli-v${version}/${filename}`, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Browser helper download failed (${response.status}).`);
  bytes = Buffer.from(await response.arrayBuffer());
}
if (bytes.length > 100_000_000 || digest(bytes) !== artifact[1]) throw new Error("Browser helper archive does not match the reviewed checksum.");
await writeFile(archive, bytes);
const scratch = await mkdtemp(join(tmpdir(), "realbud-browser-build-"));
try {
  // Official archives contain one executable. Extract only that named member;
  // do not unpack arbitrary archive paths or run an upstream installer.
  const tar = process.platform === "win32" ? windowsTar() : "tar";
  const listing = await run(tar, ["-tf", archive]);
  const entries = listing.stdout.trim().split(/\r?\n/);
  const entry = entries.find(name => name === binary || name === `./${binary}`);
  if (!entry) throw new Error("Browser archive layout changed; review the release before packaging.");
  await run(tar, ["-xf", archive, "-C", scratch, entry]);
  const executable = join(scratch, binary);
  await chmod(executable, 0o755);
  const checked = await run(executable, ["--version"], { timeout: 5_000 });
  if (checked.stdout.trim() !== `bsk ${version}`) throw new Error("Wrong browser helper version.");
  const sha256 = digest(await readFile(executable));
  await mkdir(stage, { recursive: true });
  // Stage atomically; a failed build cannot leave a partial executable.
  await writeFile(join(stage, `${binary}.tmp`), await readFile(executable), { mode: 0o755 });
  await chmod(join(stage, `${binary}.tmp`), 0o755);
  await rename(join(stage, `${binary}.tmp`), join(stage, binary));
  await writeFile(join(stage, "runtime.json"), JSON.stringify({ version, platform: process.platform, arch: process.arch, sha256, archiveSha256: artifact[1] }));
  await writeFile(join(stage, "LICENSE"), await readFile(join(root, "licenses", "BrowserSkill.txt")));
  console.log(`Browser helper ${version} verified and staged for ${process.platform}-${process.arch}.`);
} finally { await rm(scratch, { recursive: true, force: true }); }
