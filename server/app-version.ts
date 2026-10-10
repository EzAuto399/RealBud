import { readFileSync } from "node:fs";
/** Packaged server: ./app-version.json written by the server build. Source layout: the root manifest. */
function readAppVersion(): string {
  for (const relative of ["./app-version.json", "../package.json", "../../package.json"]) {
    try {
      const value = JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));
      if (value.name === "realbud" && typeof value.version === "string" && /^\d+\.\d+\.\d+[A-Za-z0-9.+-]*$/.test(value.version)) return value.version;
    } catch { /* The other layout may contain the manifest. */ }
  }
  return "unreported";
}

/** Read once, when this process starts. A manual install replaces the files
 * under a service that keeps running; reading them again reported the new
 * version for the old code, and the new window adopted that old service
 * (an office PC ran 0.1.46 through two installs, 10 Oct). */
const RUNNING_VERSION = readAppVersion();

/** The version of the code this process is running. */
export function appVersion(): string {
  return RUNNING_VERSION;
}
