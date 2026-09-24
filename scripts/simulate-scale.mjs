#!/usr/bin/env node
// Scale simulation over the real HTTP API: boots the harness on a temp home,
// seeds N properties through the real intake path (propose-book → allow-all,
// one revision bump), then times the operations a PM feels: desk snapshot,
// practice morning check, CSV preview + import of N rows, loops list.
//
//   node --experimental-strip-types scripts/simulate-scale.mjs [sizes...]
//   default sizes: 150 300 600
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serviceSmokeEnv } from "./service-smoke-env.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let baseUrl;
const SIZES = process.argv.length > 2 ? process.argv.slice(2).map(Number) : [150, 300, 600];
assert.ok(SIZES.length <= 10 && SIZES.every(n => Number.isSafeInteger(n) && n > 0 && n <= 990), 'Supply one to ten sizes between 1 and 990 (the sample book also uses capacity).');
const output = resolve(process.env.QA_OUTPUT || join(ROOT, 'outputs/core-scale-2026-09-21'));
mkdirSync(output, { recursive: true });
const measurements = [];
let failure;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

let session = "";
const api = async (method, path, body) => {
  const headers = { origin: baseUrl };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (session) headers["x-realbud-session"] = session;
  const started = performance.now();
  const res = await fetch(baseUrl + path, { method, headers, signal: AbortSignal.timeout(60_000), body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  let bytes = 0;
  try {
    const text = await res.text();
    bytes = Buffer.byteLength(text);
    json = JSON.parse(text);
  } catch { /* empty */ }
  return { status: res.status, body: json, ms: performance.now() - started, bytes };
};

const SUBURBS = ["Kingston ACT", "Dickson ACT", "Braddon ACT", "Watson ACT", "Ainslie ACT", "Narrabundah ACT"];
const STREETS = ["Harbour Rd", "Oak St", "Pine Ave", "King St", "Birch Cl", "Flora St", "Wattle Ct", "Elm Ave", "Banksia Pl", "Fig Tree Ln"];

function propertyRow(i) {
  const unit = i % 3 === 0 ? `${(i % 12) + 1}/` : "";
  return {
    address: `${unit}${10 + i} ${STREETS[i % STREETS.length]}, ${SUBURBS[i % SUBURBS.length]}`,
    tenantName: `Tenant ${i}`,
    tenantPhone: `0400 ${String(100 + (i % 900))} ${String(100 + (i % 900))}`,
    weeklyRentCents: 45_000 + (i % 40) * 1000,
  };
}

function csvFor(n, props) {
  const rows = props.map((p, i) => `"${p.address}",${(i % 14) + (i % 3 === 0 ? 3 : 0)},${i % 4 !== 0},${i % 5 !== 0}`);
  return `address,daysLate,rentLanded,levyPaid\n${rows.join("\n")}\n`;
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode) return;
  child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), delay(5000)]);
  if (child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await once(child, 'exit'); }
}
async function boot(home) {
  const data = join(home, '.realbud');
  mkdirSync(data, { recursive: true, mode: 0o700 });
  writeFileSync(join(data, 'config.json'), JSON.stringify({ instances: { fixture: { driver: 'not-a-real-driver' } } }), { mode: 0o600 });
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); baseUrl = `http://127.0.0.1:${port}`;
  const started = performance.now();
  const child = spawn(process.execPath, [join(ROOT, 'server/bootstrap.ts')], {
    cwd: ROOT,
    env: { ...serviceSmokeEnv({ executable: process.execPath, home, data, scratch: home, port }), REALBUD_MANAGED_SERVICE: '0', REALBUD_TEST_LAB: '1' },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = '', spawnError;
  child.once('error', error => { spawnError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-20000); });
  try {
    for (let i = 0; i < 100; i++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode) break;
      try {
        const health = await (await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(500) })).json();
        if (health.app === 'realbud' && health.pid === child.pid) {
          const sess = await (await fetch(`${baseUrl}/api/session`, { signal: AbortSignal.timeout(1000) })).json(); session = String(sess?.token ?? '');
          assert.ok(session, 'No fixture session');
          return { child, startupMs: Math.round(performance.now() - started) };
        }
      } catch { /* not up yet */ }
      await delay(100);
    }
    throw new Error(`Isolated fixture did not boot. ${logs}`);
  } catch (error) {
    if (child.pid) await stop(child);
    throw error;
  }
}

async function seedBook(n) {
  const items = Array.from({ length: n }, (_, i) => propertyRow(i));
  const t0 = performance.now();
  const proposed = await api("POST", "/api/desk/propose-book", { items });
  if (proposed.status !== 200 && proposed.status !== 201) throw new Error(`propose-book ${proposed.status}`);
  const allowed = await api("POST", "/api/desk/book-proposals/allow-all", {});
  if (allowed.status !== 200) throw new Error(`allow-all ${allowed.status}`);
  return performance.now() - t0;
}

async function measure(n, baseCount) {
  const out = { n };
  out.seedMs = Math.round(await seedBook(n));

  const desk = await api("GET", "/api/desk");
  out.deskMs = Math.round(desk.ms);
  out.snapshotKB = Math.round(desk.bytes / 1024);
  const total = desk.body?.properties?.length;
  if (total !== baseCount + n) throw new Error(`expected ${baseCount + n} properties, got ${total}`);

  const practice = await api("POST", "/api/desk/practice", {});
  assert.equal(practice.status, 200, 'Fictional practice must succeed');
  out.practiceMs = Math.round(practice.ms);

  const csv = csvFor(n, desk.body.properties);
  const preview = await api("POST", "/api/desk/import/preview", { csv });
  out.previewMs = Math.round(preview.ms);
  if (preview.status !== 200) throw new Error(`preview ${preview.status}: ${JSON.stringify(preview.body).slice(0, 120)}`);
  const imp = await api("POST", "/api/desk/import", {
    csv,
    expectedDigest: preview.body.digest,
    expectedRevision: preview.body.expectedRevision,
    observedAt: preview.body.observedAt,
  });
  out.importMs = Math.round(imp.ms);
  if (imp.status !== 200) throw new Error(`import ${imp.status}`);

  const loops = await api("GET", "/api/loops");
  assert.equal(loops.status, 200);
  out.loopsMs = Math.round(loops.ms);
  const reads = [];
  for (let i = 0; i < 20; i++) { const snapshot = await api('GET', '/api/desk'); assert.equal(snapshot.status, 200); assert.equal(snapshot.body.properties.length, total); reads.push(snapshot.ms); }
  reads.sort((a, b) => a - b);
  out.deskReadMedianMs = Math.round(reads[10] * 100) / 100;
  out.deskReadP95Ms = Math.round(reads[18] * 100) / 100;
  out.propertyCount = total;
  return out;
}

async function baseCount() {
  const desk = await api("GET", "/api/desk");
  return desk.body?.properties?.length ?? 0;
}

console.log("size  seedMs  deskMs  snapKB  practiceMs  previewMs  importMs  loopsMs");
// one boot per size keeps each measurement honest
try {
 for (const n of SIZES) {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'RealBud scale QA '));
  let running;
  try {
    running = await boot(home);
    const base = await baseCount();
    const res = await measure(n, base);
    res.startupMs = running.startupMs;
    await stop(running.child); running = await boot(home);
    assert.equal(await baseCount(), res.propertyCount, 'Saved book must survive an actual service restart');
    res.restartMs = running.startupMs; res.restartPreserved = true;
    measurements.push(res);
    console.log(
      `${String(res.n).padEnd(5)} ${String(res.seedMs).padEnd(7)} ${String(res.deskMs).padEnd(7)} ${String(res.snapshotKB).padEnd(7)} ${String(res.practiceMs).padEnd(11)} ${String(res.previewMs).padEnd(10)} ${String(res.importMs).padEnd(9)} ${res.loopsMs}`,
    );
  } finally {
    if (running) await stop(running.child);
    rmSync(home, { recursive: true, force: true });
  }
 }
} catch (error) { failure = error.stack || String(error); process.exitCode = 1; }
finally {
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ at: new Date().toISOString(), passed: !failure, runtime: { node: process.versions.node, platform: process.platform, arch: process.arch }, layer: 'Isolated actual source HTTP/bootstrap with fictional properties and no provider credentials. Includes response body and parse time; single-machine observations, not customer UI latency, concurrency SLA or Windows proof.', measurements, failure }, null, 2));
}
if (failure) console.error(failure); else console.log('scale: done');
