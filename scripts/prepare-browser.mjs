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
const version = "0.3.1";
const artifacts = {
  "darwin-arm64": ["aarch64-apple-darwin.tar.gz", "78f1651215b1ce95e40fb886985d1476e2cd2fb089beb146e6ecc6fa4a4aab89"],
  "darwin-x64": ["x86_64-apple-darwin.tar.gz", "da52bdaad43261c4ed1687d370de1044c071c83cc841bfbf3a365bbfeea6f5d2"],
  "win32-x64": ["x86_64-pc-windows-msvc.zip", "964b7c9ce4757940091320e4fa3b9198d8b9e2abf6d8e63221af1825108dc4a6"],
  "linux-x64": ["x86_64-unknown-linux-musl.tar.gz", "a3011c97cc39ff859c595691f86f28f5d24d61c363d598cc06ff0bbb8315c8db"],
  "linux-arm64": ["aarch64-unknown-linux-musl.tar.gz", "67ffdeb8c90cea1e037c81df1e28bacc9582e6a91fe61b9eb3eb03d951fe6fa5"],
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
