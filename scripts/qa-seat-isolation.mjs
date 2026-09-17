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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "dist-server/server/index.js");
const BASE_PROFILE = "property";
const SEATS = [
  { name: "seat-a", member: "3fa85f64-5717-4562-b3fc-2c963f66afa6" },
  { name: "seat-b", member: "7c9e6679-7425-40de-944b-e07fc1f90ae7" },
];
const PORT_BASE = Number(process.env.OMB_SEAT_PORT ?? 18840);

if (!existsSync(SERVER)) {
  console.error(`Build the server first (pnpm build:server) — ${SERVER} is missing.`);
  process.exit(1);
}

const scratch = mkdtempSync(join(tmpdir(), "realbud-seat-isolation-"));
const children = [];
let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

/** A fake `hermes` that records the argv it was spawned with, per seat. */
function fakeWorker(home) {
  const log = join(home, "worker-args.txt");
  const script = join(home, "hermes");
  writeFileSync(
    script,
    `#!/bin/sh\n` +
      `if [ "$1" = "--version" ]; then echo "Hermes Agent v0.20.3 (2026.8.16.2)"; exit 0; fi\n` +
      `printf '%s\\n' "$@" >> ${JSON.stringify(log)}\n` +
      `printf 'OK'\n`,
  );
  chmodSync(script, 0o755);
  return { script, log };
}

/** The pack files `tryHermesPing` requires before it will spawn anything. */
function seedPack(home) {
  const profile = join(home, "profiles", BASE_PROFILE);
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
  writeFileSync(join(profile, "config.yaml"), "approvals:\n  mode: manual\ncron_mode: deny\n");
}

async function startSeat(seat, index) {
  // A seat is its own machine identity: its own home (so its own Hermes home and
  // therefore its own profiles directory) and its own data dir. Sharing a HOME
  // would point both seats at one profiles/ tree and defeat the very isolation
  // under test — which is what the first version of this script did, and why the
  // pack check reported "Bud is not set up" for both.
  const home = join(scratch, seat.name);
  mkdirSync(home, { recursive: true });
  seedPack(join(home, ".realbud", "hermes"));
  const worker = fakeWorker(home);
  const dataDir = join(home, ".realbud");
  const port = PORT_BASE + index;
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(port),
      REALBUD_DATA_DIR: dataDir,
      REALBUD_HERMES_CLI: worker.script,
      REALBUD_MEMBER: seat.member,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  children.push(child);
  for (let waited = 0; waited < 25_000; waited += 250) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return { home, port, worker, dataDir };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${seat.name} never came up on :${port}`);
}

/** The profile the worker was actually spawned with, from the recorded argv. */
function spawnedProfile(log) {
  if (!existsSync(log)) return null;
  const args = readFileSync(log, "utf8").split("\n");
  const at = args.indexOf("--profile");
  return at >= 0 ? args[at + 1] : null;
}

console.log("RealBud seat isolation (built server, one process per seat)\n");

try {
  const running = [];
  for (const [index, seat] of SEATS.entries()) running.push({ seat, ...(await startSeat(seat, index)) });

  for (const { seat, port, worker } of running) {
    const token = (await (await fetch(`http://127.0.0.1:${port}/api/session`)).json()).token;
    // The hands test is the readiness check that spawns the worker with a profile.
    const test = await fetch(`http://127.0.0.1:${port}/api/hermes/test`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-realbud-session": token },
      body: "{}",
    });
    const ping = await test.json();
    check(`${seat.name} hands test answers OK`, ping?.ok === true, `ok=${String(ping?.ok)} detail=${String(ping?.detail).slice(0, 70)}`);
    const profile = spawnedProfile(worker.log);
    check(
      `${seat.name} ran its own worker profile`,
      profile === `${BASE_PROFILE}-${seat.member}`,
      `spawned "${profile}"`,
    );
  }

  const profiles = running.map(({ worker }) => spawnedProfile(worker.log));
  check("two seats never share one worker profile", new Set(profiles).size === 2, profiles.join(" vs "));
  check("neither seat fell back to the shared base profile", !profiles.includes(BASE_PROFILE));

  // The wall line is per seat, not only for the first one.
  for (const { seat, port } of running) {
    const token = (await (await fetch(`http://127.0.0.1:${port}/api/session`)).json()).token;
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
  for (const child of children) child.kill("SIGTERM");
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : "\nALL GREEN — seats are isolated");
process.exit(failures ? 1 : 0);
