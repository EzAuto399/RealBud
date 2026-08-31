#!/usr/bin/env node
// Keep release/ lean. electron-builder leaves an unpacked .app (~400MB) plus
// DMG + zip. For local work we keep at most one version's ship artifacts.
//
//   node scripts/clean-release.mjs           # drop unpacked dirs; keep latest dmg/zip
//   node scripts/clean-release.mjs --all     # wipe release/ entirely
//   node scripts/clean-release.mjs --keep-app  # keep mac-arm64 for smoke:mac
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.join(root, "release");
const wipeAll = process.argv.includes("--all");
const keepApp = process.argv.includes("--keep-app");

function sizeOf(p) {
  try {
    const s = statSync(p);
    if (s.isFile()) return s.size;
  } catch {
    return 0;
  }
  return 0;
}

function human(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  return `${(n / 1024 ** 3).toFixed(2)}GB`;
}

if (!existsSync(releaseDir)) {
  console.log("[clean-release] nothing to clean");
  process.exit(0);
}

if (wipeAll) {
  rmSync(releaseDir, { recursive: true, force: true });
  console.log("[clean-release] wiped release/");
  process.exit(0);
}

let freed = 0;
const entries = readdirSync(releaseDir);

// Unpacked trees are rebuildable from the zip; drop them unless smoking the .app.
for (const name of ["mac-arm64", "mac", "mac-x64", "win-unpacked", "linux-unpacked"]) {
  if (keepApp && (name === "mac-arm64" || name === "mac")) continue;
  const p = path.join(releaseDir, name);
  if (!existsSync(p)) continue;
  // rough size via recursive walk is slow; du-style: just delete
  rmSync(p, { recursive: true, force: true });
  console.log(`[clean-release] removed ${name}/`);
  freed += 1;
}

// Keep only the newest RealBud version's dmg/zip/blockmap; drop older versions.
const versioned = entries
  .filter((f) => /^RealBud-/.test(f))
  .map((f) => {
    const m = f.match(/^RealBud-(\d+\.\d+\.\d+)/);
    return { f, ver: m?.[1] ?? "0.0.0", t: sizeOf(path.join(releaseDir, f)) };
  });

const versions = [...new Set(versioned.map((v) => v.ver))].sort((a, b) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
  return 0;
});

const keepVer = versions[0];
for (const { f, ver, t } of versioned) {
  if (ver === keepVer) continue;
  const p = path.join(releaseDir, f);
  rmSync(p, { force: true });
  freed += t;
  console.log(`[clean-release] removed old ${f} (${human(t)})`);
}

// builder noise
for (const noise of ["builder-debug.yml", "builder-effective-config.yaml"]) {
  const p = path.join(releaseDir, noise);
  if (existsSync(p)) {
    freed += sizeOf(p);
    rmSync(p, { force: true });
    console.log(`[clean-release] removed ${noise}`);
  }
}

console.log(
  keepVer
    ? `[clean-release] kept version ${keepVer}${keepApp ? " + unpacked .app" : ""}`
    : "[clean-release] no versioned artifacts left",
);
console.log(`[clean-release] done (removed ~${human(freed)} of versioned files; unpacked dirs deleted)`);
