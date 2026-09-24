// Compile after prepare-cua: that step replaces dist-native. Nothing is fetched.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findCsc } from "./build-speech-helper-win.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
export const windowsCuaLauncher = join(root, "dist-native", "RealBud CUA.exe");

export function buildWindowsCuaLauncher() {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Build the CUA launcher on native Windows x64.");
  const csc = findCsc();
  if (!csc) throw new Error("Framework csc.exe is missing; run the Windows build prerequisite check.");
  const source = join(root, "electron", "resources", "cua-launcher-win.cs");
  const temporary = windowsCuaLauncher + ".building.exe";
  mkdirSync(dirname(windowsCuaLauncher), { recursive: true });
  try {
    execFileSync(csc, ["/nologo", "/optimize+", "/target:exe", "/platform:x64", `/out:${temporary}`, source], { stdio: "inherit", timeout: 120_000 });
    if (!existsSync(temporary)) throw new Error("The CUA launcher compiler produced no executable.");
    renameSync(temporary, windowsCuaLauncher);
  } finally { rmSync(temporary, { force: true }); }
  console.log("Built the Windows CUA grant launcher.");
  return windowsCuaLauncher;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) buildWindowsCuaLauncher();
