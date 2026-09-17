#!/usr/bin/env node
// Full PM HTTP regression battery — no engines, mail, live PMS, or Hermes.app.
// Runs every e2e script in desk-walk order. CI and local QA entry point.
//
//   node scripts/qa-e2e.mjs
//   node scripts/qa-e2e.mjs --quick   # desk + exceptions only
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const quick = process.argv.includes("--quick");

const SUITES = [
  { name: "desk", script: "scripts/e2e-desk.mjs", quick: true, port: 18880 },
  { name: "pm-day", script: "scripts/e2e-pm-day.mjs", quick: false, port: 18881 },
  { name: "pm-exceptions", script: "scripts/e2e-pm-exceptions.mjs", quick: true, port: 18882 },
  { name: "portal-jobs", script: "scripts/e2e-portal-jobs.mjs", quick: false, port: 18883 },
  { name: "walkthrough", script: "scripts/e2e-walkthrough.mjs", quick: false, port: 18884 },
].filter((s) => !quick || s.quick);

let failed = 0;
console.log(`RealBud PM e2e battery (${SUITES.length} suite${SUITES.length === 1 ? "" : "s"})`);
console.log("");

for (const suite of SUITES) {
  console.log(`── ${suite.name} ──`);
  const result = spawnSync(process.execPath, [join(ROOT, suite.script)], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, OMB_E2E_PORT: String(suite.port) },
  });
  if (result.status !== 0) {
    console.error(`\nFAIL  ${suite.name} exited ${result.status ?? "signal"}`);
    failed++;
  } else {
    console.log(`\nok    ${suite.name}`);
  }
  console.log("");
}

if (failed) {
  console.error(`${failed} suite(s) failed`);
  process.exit(1);
}
console.log("ALL GREEN — PM e2e battery");
