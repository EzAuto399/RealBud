#!/usr/bin/env node
// One fail-fast source-candidate proof. This deliberately excludes signing,
// notarization, installed first-run, live credentials, named-office data and
// vendor portals; those belong to later release-evidence buckets.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeMajor = Number(process.versions.node.split(".")[0]);

if (!Number.isInteger(nodeMajor) || nodeMajor < 24) {
  console.error(`[verify-source] BLOCKED: Node 24 or newer is required; current runtime is ${process.version}`);
  process.exit(1);
}

const electronEntries = [
  "electron/main.mjs",
  "electron/terminal-launch.mjs",
  "electron/preload.cjs",
  "electron/capabilities.cjs",
  "electron/routine-reminders.cjs",
  "electron/secure-storage.cjs",
  "electron/packaged-environment.cjs",
  "electron/cua-connection.cjs",
  "electron/cua-policy.cjs",
  "electron/cua-runtime.cjs",
  "electron/cua.mjs",
  "electron/speech.mjs",
  "electron/updater.mjs",
];

const gates = [
  { name: "tests", args: ["node_modules/vitest/vitest.mjs", "run"], timeoutMs: 5 * 60_000 },
  { name: "client typecheck", args: ["node_modules/typescript/bin/tsc", "-b"], timeoutMs: 2 * 60_000 },
  {
    name: "server typecheck",
    args: ["node_modules/typescript/bin/tsc", "-p", "tsconfig.server.json"],
    timeoutMs: 2 * 60_000,
  },
  ...electronEntries.map((entry) => ({ name: `syntax ${entry}`, args: ["--check", entry] })),
  { name: "production UI build", args: ["node_modules/vite/bin/vite.js", "build"], timeoutMs: 3 * 60_000 },
  {
    name: "Desk/API walkthrough",
    args: ["--experimental-strip-types", "scripts/e2e-walkthrough.mjs"],
    timeoutMs: 2 * 60_000,
  },
  {
    name: "visible portal-browser walkthrough",
    args: ["--experimental-strip-types", "scripts/e2e-portal-browser.mjs"],
    timeoutMs: 3 * 60_000,
  },
  {
    name: "read-only bank-browser walkthrough",
    args: ["--experimental-strip-types", "scripts/e2e-bank-browser.mjs"],
    timeoutMs: 3 * 60_000,
  },
  {
    name: "native bounded-Cua policy walkthrough",
    args: ["scripts/e2e-cua-bounded-policy.mjs"],
    timeoutMs: 60_000,
  },
  {
    name: "isolated bank/Cua topology walkthrough",
    args: ["scripts/e2e-bank-cua.mjs"],
    timeoutMs: 60_000,
  },
];

const startedAt = Date.now();
for (const gate of gates) {
  console.log(`\n[verify-source] ${gate.name}`);
  const result = spawnSync(process.execPath, gate.args, {
    cwd: root,
    env: { ...process.env, CI: "1" },
    stdio: "inherit",
    timeout: gate.timeoutMs ?? 30_000,
    killSignal: "SIGKILL",
  });
  if (result.error) {
    console.error(`[verify-source] FAILED: ${gate.name}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[verify-source] FAILED: ${gate.name} exited ${result.status ?? result.signal ?? "unknown"}`);
    process.exit(result.status ?? 1);
  }
}

const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`\n[verify-source] ALL GREEN in ${durationSeconds}s`);
console.log("[verify-source] This proves source behavior only; consult docs/RELEASE-EVIDENCE-CHECKLIST.md for later buckets.");
