// Startup sweep of temp files our own atomic writers left behind.
//
// `writeFileAtomic` and `writePrivateJson` write `<name>[.<pid>].<uuid>.tmp`
// beside the target, then rename. A kill between the two leaves the temp file;
// the target is still the complete old or new file, so the temp file is never
// data. Only that exact pattern is removed, only files last written before this
// process started (one service per data directory, so nothing older can still
// be in flight), never through a link, and never inside the Hermes home.
import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const OUR_TEMP = /^[^.].*\.(?:\d+\.)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
const SKIP = new Set(["hermes", "node_modules"]);

/** @returns names (relative to `root`) that were removed. */
export function sweepStaleTempFiles(root: string, startedAtMs = Date.now() - process.uptime() * 1000, depth = 2): string[] {
  const removed: string[] = [];
  const walk = (dir: string, prefix: string, left: number) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      let stat;
      try { stat = lstatSync(path); } catch { continue; }
      if (stat.isDirectory()) {
        if (left > 0 && !SKIP.has(name)) walk(path, `${prefix}${name}/`, left - 1);
        continue;
      }
      if (!stat.isFile() || !OUR_TEMP.test(name) || stat.mtimeMs >= startedAtMs) continue;
      try { unlinkSync(path); removed.push(`${prefix}${name}`); } catch { /* leave it; the next boot tries again */ }
    }
  };
  walk(root, "", depth);
  return removed;
}
