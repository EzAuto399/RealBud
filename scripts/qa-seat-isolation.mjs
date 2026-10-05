#!/usr/bin/env node
// Two-seat proof: the same built server, one process per seat, must resolve each
// seat's own Hermes worker profile. Run with:
//   node --experimental-strip-types scripts/qa-seat-isolation.mjs
//
// This is the isolation guarantee the office host rests on: one Hermes profile
// carries one memory, skills store and session database, so two seats sharing a
// profile is two writers on one state. The assertion here is on what the worker
// was actually spawned with, not on what a helper returned.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serviceSmokeEnv } from "./service-smoke-env.mjs";
import { readSessionToken } from "./local-session.mjs";
import { fictionalWorkerModelKey, provisionMockWorkerGrant } from "./testing/mock-worker-grant.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "dist-server/server/index.js");
const BASE_PROFILE = "property";
const SEATS = [
  { name: "seat-a", member: "3fa85f64-5717-4562-b3fc-2c963f66afa6" },
  { name: "seat-b", member: "7c9e6679-7425-40de-944b-e07fc1f90ae7" },
];
const PORT_BASE = process.env.OMB_SEAT_PORT ? Number(process.env.OMB_SEAT_PORT) : null;
const output = resolve(process.env.QA_OUTPUT ?? join(ROOT, "outputs/seat-isolation-2026-10-03"));
mkdirSync(output, { recursive: true });

if (!existsSync(SERVER)) {
  console.error(`Build the server first (pnpm build:server) — ${SERVER} is missing.`);
  process.exit(1);
}

const scratch = mkdtempSync(join(realpathSync(tmpdir()), "realbud-seat-isolation-"));
// build:server emits code; packaging supplies the shipped pack beside it.
// Stage that layout privately so this test neither writes into dist-server nor
// borrows application files from a live installation.
const resources = join(scratch, "resources");
cpSync(join(ROOT, "dist-server"), resources, { recursive: true });
cpSync(join(ROOT, "pack"), join(resources, "pack"), { recursive: true });
writeFileSync(join(resources, "package.json"), JSON.stringify({ type: "module" }));
const children = [];
const checks = [];
const profilesSeen = [];
let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  checks.push({ label, ok: Boolean(ok), detail });
  if (!ok) failures += 1;
}

/** A fake `hermes` that records the argv it was spawned with, per seat. */
function fakeWorker(home, dataDir) {
  // Evidence obeys the real sandbox: only Bud's own work folder is writable.
  const log = join(dataDir, "vault", "bud-work", "worker-args.json");
  const script = join(home, "hermes");
  writeFileSync(
    script,
    `#!${process.execPath}\n` +
      `import assert from 'node:assert/strict';\n` +
      `import {readFileSync,writeFileSync} from 'node:fs';\n` +
      `if(process.argv.includes('--version')){console.log('Hermes Agent v0.21.3 (2026.9.14)');process.exit(0);}\n` +
      `assert.notEqual(process.env.REALBUD_MODEL_API_KEY,${JSON.stringify(fictionalWorkerModelKey)});\n` +
      `assert.match(process.env.REALBUD_MODEL_API_KEY??'',/^[a-f0-9]{64}$/);\n` +
      `const overlay=JSON.parse(readFileSync(process.env.HERMES_MANAGED_DIR+'/config.yaml','utf8'));\n` +
      `const providers=Object.values(overlay.providers??{});assert.equal(providers.length,1);\n` +
      `for(const key of ['api','url','base_url']){const url=new URL(providers[0][key]);assert.equal(url.protocol,'http:');assert.equal(url.hostname,'127.0.0.1');assert.ok(url.port);}\n` +
      `writeFileSync(${JSON.stringify(log)},JSON.stringify({argv:process.argv.slice(2),hermesHome:process.env.HERMES_HOME,relayIsolated:true}));\n` +
      `console.log('OK');\n`,
  );
  chmodSync(script, 0o755);
  return { script, log };
}

async function startSeat(seat, index) {
  // A seat is its own machine identity: its own home (so its own Hermes home and
  // therefore its own profiles directory) and its own data dir. Sharing a HOME
  // would point both seats at one profiles/ tree and defeat the very isolation
  // under test — which is what the first version of this script did, and why the
  // pack check reported "Bud is not set up" for both.
  const home = join(scratch, seat.name);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const dataDir = join(home, ".realbud");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const worker = fakeWorker(home, dataDir);
  // A fictional grant is applied with the compiled server's own stores and
  // the exact member scope used by this seat. No provider is ever contacted.
  provisionMockWorkerGrant({ resources, home, data: dataDir, memberKey: seat.member,
    endpoint: "http://127.0.0.1:1", credential: `rbc_${"b".repeat(64)}`, companyId: "fictional-seat-office", hostInstallationId: `fictional-${seat.name}` });
  const guard = join(home, "loopback-only.mjs");
  writeFileSync(guard, `const realFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw new Error('Seat QA denied external network');return realFetch(input,init);};\n`);
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(PORT_BASE === null ? 0 : PORT_BASE + index, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ["--import", guard, join(resources, "server/index.js")], {
    cwd: resources,
    env: {
      ...serviceSmokeEnv({ executable: process.execPath, home, data: dataDir, scratch: home, port }),
      REALBUD_MANAGED_SERVICE: "0",
      REALBUD_HERMES_CLI: worker.script,
      REALBUD_MEMBER: seat.member,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", bytes => { logs = (logs + bytes).slice(-12000); });
  child.stderr.on("data", bytes => { logs = (logs + bytes).slice(-12000); });
  const closed = new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  children.push({ child, closed });
  for (let waited = 0; waited < 25_000; waited += 250) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok && (await res.json()).pid === child.pid) return { home, port, worker, dataDir };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${seat.name} never came up on :${port}: ${logs}`);
}

/** The profile the worker was actually spawned with, from the recorded argv. */
function spawnedProfile(log) {
  if (!existsSync(log)) return null;
  const args = JSON.parse(readFileSync(log, "utf8")).argv;
  const at = args.indexOf("--profile");
  return at >= 0 ? args[at + 1] : null;
}

console.log("RealBud seat isolation (built server, one process per seat)\n");

try {
  const running = [];
  for (const [index, seat] of SEATS.entries()) running.push({ seat, ...(await startSeat(seat, index)) });

  for (const { seat, port, worker, dataDir } of running) {
    const token = await readSessionToken(dataDir);
    // The hands test is the readiness check that spawns the worker with a profile.
    const test = await fetch(`http://127.0.0.1:${port}/api/hermes/test`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-realbud-session": token },
      body: "{}",
    });
    const ping = await test.json();
    check(`${seat.name} hands test answers OK`, ping?.ok === true, `ok=${String(ping?.ok)} detail=${String(ping?.detail).slice(0, 70)}`);
    const profile = spawnedProfile(worker.log);
    profilesSeen.push({ seat: seat.name, profile });
    check(
      `${seat.name} ran its own worker profile`,
      profile === `${BASE_PROFILE}-${seat.member}`,
      `spawned "${profile}"`,
    );
  }

  const profiles = running.map(({ worker }) => spawnedProfile(worker.log));
  check("two seats never share one worker profile", new Set(profiles).size === 2, profiles.join(" vs "));
  check("neither seat fell back to the shared base profile", profiles.every(profile => Boolean(profile) && profile !== BASE_PROFILE));
  const launchEvidence = running.map(({ worker }) => existsSync(worker.log) ? JSON.parse(readFileSync(worker.log, "utf8")) : null);
  check("both workers receive isolated relay tokens instead of the provider key", launchEvidence.every(value => value?.relayIsolated));
  check("two seats use distinct Hermes homes", launchEvidence.every(Boolean) && new Set(launchEvidence.map(value => value?.hermesHome)).size === 2);

  // The wall line is per seat, not only for the first one.
  for (const { seat, port, dataDir } of running) {
    const token = await readSessionToken(dataDir);
    const send = await fetch(`http://127.0.0.1:${port}/api/desk/drafts/anything/send`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-realbud-session": token },
      body: "{}",
    });
    check(`${seat.name} still refuses to send (403)`, send.status === 403, `HTTP ${send.status}`);
  }
} catch (error) {
  check("suite ran", false, error instanceof Error ? error.message : String(error));
} finally {
  for (const { child, closed } of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    child.kill("SIGTERM");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await closed; } finally { clearTimeout(timeout); }
  }
  rmSync(scratch, { recursive: true, force: true });
  writeFileSync(join(output, "receipt.json"), JSON.stringify({ at: new Date().toISOString(), passed: failures === 0, failures, checks, profiles: profilesSeen,
    layer: "Compiled local HTTP service, two private seat homes, fictional managed grants and deterministic sandboxed workers",
    limits: ["No live model, customer account, mailbox or external action", "No packaged desktop, native Windows or physical two-device proof"],
    cleanup: { childrenStopped: children.every(({ child }) => child.exitCode !== null || child.signalCode !== null), fixtureRemoved: !existsSync(scratch) } }, null, 2));
}

console.log(failures ? `\n${failures} check(s) failed` : "\nALL GREEN — seats are isolated");
process.exit(failures ? 1 : 0);
