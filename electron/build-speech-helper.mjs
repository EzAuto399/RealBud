// Build the native recognizer as a real app bundle. macOS privacy enforcement
// does not accept a purpose string embedded in a loose command-line binary on
// current releases; TCC reads the Info.plist belonging to the executable's
// bundle and terminates the process before Swift can recover when it is absent.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const electronDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(electronDir);
const resourcesDir = path.join(electronDir, "resources");

export const speechHelperBundle = path.join(resourcesDir, "RealBud Speech.app");
export const speechHelperBinary = path.join(speechHelperBundle, "Contents", "MacOS", "speech-helper");

export function buildSpeechHelper() {
  const targetArch = process.env.REALBUD_PACKAGE_ARCH ?? process.arch;
  if (targetArch !== "arm64" && targetArch !== "x64") {
    throw new Error(`speech helper packaging does not support macOS ${targetArch}`);
  }
  const swiftArch = targetArch === "x64" ? "x86_64" : "arm64";
  const contents = path.join(speechHelperBundle, "Contents");
  mkdirSync(path.join(contents, "MacOS"), { recursive: true });
  copyFileSync(path.join(resourcesDir, "speech-helper-Info.plist"), path.join(contents, "Info.plist"));
  execFileSync(
    "swiftc",
    [
      "-O",
      "-target",
      `${swiftArch}-apple-macos11.0`,
      path.join(resourcesDir, "speech-helper.swift"),
      "-o",
      speechHelperBinary,
    ],
    { stdio: "inherit", timeout: 120_000 },
  );
  // Give development builds a stable identity and the same audio entitlement
  // as the release. electron-builder replaces this ad-hoc signature when it
  // signs the containing distribution.
  execFileSync(
    "codesign",
    [
      "--force",
      "--deep",
      "--sign",
      "-",
      "--options",
      "runtime",
      "--entitlements",
      path.join(projectDir, "build", "entitlements.mac.plist"),
      speechHelperBundle,
    ],
    { stdio: "inherit", timeout: 30_000 },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildSpeechHelper();
}
