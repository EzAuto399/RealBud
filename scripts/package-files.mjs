// Packaging runs from PowerShell as well as a POSIX shell. Do not depend on
// Git-for-Windows providing Unix unzip/cp commands on the build host's PATH.
import { execFile } from "node:child_process";
import { cp } from "node:fs/promises";
import { win32 } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export function windowsTar(env = process.env) {
  return win32.join(env.SystemRoot || env.WINDIR || "C:\\Windows", "System32", "tar.exe");
}

export async function listPackageZip(archive, { platform = process.platform, env = process.env, execute = run } = {}) {
  const command = platform === "win32" ? windowsTar(env) : "/usr/bin/unzip";
  const args = platform === "win32" ? ["-tf", archive] : ["-Z1", archive];
  const { stdout } = await execute(command, args, { timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
  return stdout.split(/\r?\n/).filter(Boolean);
}

export async function copyPackageRuntime(source, destination) {
  // Preserve relative dylib links on macOS; fs.cp's default otherwise rewrites
  // them to the temporary staging tree, which is removed after packaging.
  await cp(source, destination, { recursive: true, dereference: false, verbatimSymlinks: true });
}

export function assertDesktopPackagingTarget(platform = process.platform, arch = process.arch) {
  if ((platform === "darwin" && arch === "arm64") || (platform === "win32" && arch === "x64")) return;
  throw new Error(`No complete desktop runtime is admitted for ${platform}-${arch}; build on macOS arm64 or Windows x64.`);
}
