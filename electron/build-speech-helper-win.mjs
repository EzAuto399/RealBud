// Build RealBud Speech.exe for Windows dictation. Compiles only on win32
// (Framework csc). Mac/Linux package scripts call this and get a no-op so
// local mac packaging never fails for a Windows-only binary.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const electronDir = path.dirname(fileURLToPath(import.meta.url));
const resourcesDir = path.join(electronDir, "resources");
const source = path.join(resourcesDir, "speech-helper-win.cs");
export const windowsSpeechHelperExe = path.join(resourcesDir, "RealBud Speech.exe");

function findCsc() {
  const roots = [
    process.env["WINDIR"] || "C:\\Windows",
    "C:\\Windows",
  ];
  const frameworks = ["Framework64", "Framework"];
  const versions = ["v4.0.30319", "v3.5"];
  for (const root of roots) {
    for (const fw of frameworks) {
      for (const ver of versions) {
        const candidate = path.join(root, "Microsoft.NET", fw, ver, "csc.exe");
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

export function buildWindowsSpeechHelper() {
  if (process.platform !== "win32") {
    console.log("build:speech:win skipped (not win32)");
    return null;
  }
  if (!existsSync(source)) {
    throw new Error(`missing Windows speech helper source: ${source}`);
  }
  const csc = findCsc();
  if (!csc) {
    throw new Error("csc.exe not found — install .NET Framework 4.x developer pack / targeting pack");
  }
  mkdirSync(resourcesDir, { recursive: true });
  // /nologo keeps CI logs short. System.Speech lives in the GAC for Framework.
  execFileSync(
    csc,
    [
      "/nologo",
      "/optimize+",
      "/target:exe",
      `/out:${windowsSpeechHelperExe}`,
      "/r:System.Speech.dll",
      source,
    ],
    { stdio: "inherit", timeout: 120_000 },
  );
  if (!existsSync(windowsSpeechHelperExe)) {
    throw new Error(`csc produced no binary at ${windowsSpeechHelperExe}`);
  }
  console.log(`built ${windowsSpeechHelperExe}`);
  return windowsSpeechHelperExe;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildWindowsSpeechHelper();
}
