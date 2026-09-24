#!/usr/bin/env node
// Syntax-check every Electron entry module.
//
// This was a hand-maintained list in package.json, and a hand-maintained list of
// files drifts: it had silently stopped covering desk-key-custody, log-directory,
// updater, updater-action, cua-control and cua-login-check. Nothing in the main
// process is unit-testable, so `node --check` is the only automatic proof those
// modules parse at all — and a parse error in one of them surfaces as a packaged
// app that will not boot.
//
// Enumeration instead of a list, so a new module is covered the moment it exists.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const electronDir = fileURLToPath(new URL("../electron/", import.meta.url));

// Tests are excluded: they are run by vitest, which type-agnostically parses them
// anyway, and they import vitest globals that `node --check` has no opinion on.
const modules = readdirSync(electronDir)
  .filter((name) => /\.(mjs|cjs)$/.test(name) && !/\.test\./.test(name))
  .sort();

const failures = [];
for (const name of modules) {
  const result = spawnSync(process.execPath, ["--check", join(electronDir, name)], { stdio: "inherit" });
  if (result.error || result.status !== 0) failures.push(name);
}

for (const name of failures) console.error(`check failed: electron/${name}`);
console.log(`checked ${modules.length} electron module${modules.length === 1 ? "" : "s"}: ${modules.length - failures.length} ok, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
