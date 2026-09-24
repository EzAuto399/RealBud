// The GUI and installed smoke use this exact grant launcher. The grant permits
// the existing-profile attachment boundary only; task/account/action authority
// remains with RealBud's browser broker and human approval controls.
import fs from "node:fs";
import path from "node:path";
import { createWindowsCuaHost } from "./cua-windows-host.mjs";

export const CUA_HOST_BUNDLE_ID = "com.realbud.app";
export const WINDOWS_CUA_LAUNCHER = "RealBud CUA.exe";
const shellLiteral = value => `'${value.replace(/'/g, "'\\''")}'`;

export function existingProfileGrantLauncher(binary, {
  userData, platform = process.platform, fileSystem = fs,
} = {}) {
  if (typeof binary !== "string" || !binary || /[\0\r\n]/.test(binary)) throw new Error("The bundled desktop helper path is invalid.");
  if (platform === "win32") {
    // Our Windows host starts this fixed Job Object supervisor as a real
    // executable, never a .cmd file or a command string. The launcher resolves
    // only its adjacent cua-driver.exe; it cannot select a target from env/argv.
    if (!/^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+\\)/i.test(binary) || path.win32.basename(binary).toLowerCase() !== "cua-driver.exe") {
      throw new Error("Windows desktop control requires the bundled cua-driver.exe and RealBud CUA.exe together.");
    }
    const launcher = path.win32.join(path.win32.dirname(binary), WINDOWS_CUA_LAUNCHER);
    for (const file of [binary, launcher]) {
      let stat;
      try { stat = fileSystem.lstatSync(file); } catch { /* fixed actionable error below */ }
      if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error("The Windows desktop launcher is missing or unsafe. Rebuild the Windows CUA helpers.");
    }
    return launcher;
  }
  if (platform !== "darwin") throw new Error("Desktop control is supported on macOS and Windows x64 only.");
  if (!path.isAbsolute(binary) || typeof userData !== "string" || !path.isAbsolute(userData)) throw new Error("The desktop helper requires absolute application paths.");
  const directory = path.join(userData, "cua");
  fileSystem.mkdirSync(directory, { recursive: true });
  const launcher = path.join(directory, "cua-driver-grant");
  const body = [
    "#!/bin/bash", "set -euo pipefail", `REAL=${shellLiteral(binary)}`,
    'if [[ "${1:-}" == "serve" ]]; then', "  shift",
    '  exec "$REAL" serve --grant existing-profile "$@"', "fi",
    'exec "$REAL" "$@"', "",
  ].join("\n");
  if (!fileSystem.existsSync(launcher) || fileSystem.readFileSync(launcher, "utf8") !== body) {
    fileSystem.writeFileSync(launcher, body, { mode: 0o755 });
  } else fileSystem.chmodSync(launcher, 0o755);
  return launcher;
}

export function createGrantedCuaHost(sdk, binary, options) {
  const launcher = existingProfileGrantLauncher(binary, options);
  if ((options?.platform ?? process.platform) === "win32") return createWindowsCuaHost(sdk, launcher, binary, CUA_HOST_BUNDLE_ID);
  return new sdk.EmbeddedCuaDriverHost(launcher, CUA_HOST_BUNDLE_ID);
}
