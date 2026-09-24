import { readFileSync } from "node:fs";
/** Source and packaged server layouts share the root application manifest. */
export function appVersion(): string {
  for (const relative of ["../package.json", "../../package.json"]) {
    try {
      const value = JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));
      if (value.name === "realbud" && typeof value.version === "string" && /^\d+\.\d+\.\d+[A-Za-z0-9.+-]*$/.test(value.version)) return value.version;
    } catch { /* The other layout may contain the manifest. */ }
  }
  return "unreported";
}
