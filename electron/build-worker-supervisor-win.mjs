import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findCsc } from "./build-speech-helper-win.mjs";

const directory = join(dirname(fileURLToPath(import.meta.url)), "resources");
export const windowsWorkerSupervisorExe = join(directory, "RealBud Worker.exe");
export function buildWindowsWorkerSupervisor() {
  if (process.platform !== "win32") return null;
  const compiler = findCsc();
  if (!compiler) throw new Error("The Windows worker supervisor needs the .NET Framework compiler.");
  mkdirSync(directory, { recursive: true });
  execFileSync(compiler, ["/nologo", "/optimize+", "/target:exe", "/platform:x64", `/out:${windowsWorkerSupervisorExe}`, join(directory, "worker-supervisor-win.cs")],
    { stdio: "inherit", timeout: 120_000 });
  if (!existsSync(windowsWorkerSupervisorExe)) throw new Error("The Windows worker supervisor was not produced.");
  return windowsWorkerSupervisorExe;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) buildWindowsWorkerSupervisor();
