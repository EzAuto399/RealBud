#!/usr/bin/env node
// Scale simulation over the real HTTP API: boots the harness on a temp home,
// seeds N properties through the real intake path (propose-book → allow-all,
// one revision bump), then times the operations a PM feels: desk snapshot,
// practice morning check, CSV preview + import of N rows, loops list.
//
//   node --experimental-strip-types scripts/simulate-scale.mjs [sizes...]
//   default sizes: 150 300 600
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.OMB_SIM_PORT ?? 18890);
const BASE = `http://127.0.0.1:${PORT}`;
const SIZES = process.argv.slice(2).map(Number).filter(Boolean).length
  ? process.argv.slice(2).map(Number)
  : [150, 300, 600];

let session = "";
const api = async (method, path, body) => {
  const headers = { origin: BASE };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (session) headers["x-realbud-session"] = session;
  const started = performance.now();
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const ms = performance.now() - started;
  let json = null;
  let bytes = 0;
  try {
    const text = await res.text();
    bytes = text.length;
    json = JSON.parse(text);
  } catch { /* empty */ }
  return { status: res.status, body: json, ms, bytes };
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

async function boot() {
  const home = mkdtempSync(join(tmpdir(), "realbud-scale-"));
  mkdirSync(join(home, ".realbud"), { recursive: true });
  const child = spawn(process.execPath, ["--experimental-strip-types", "server/index.ts"], {
    cwd: ROOT,
    env: { ...process.env, REALBUD_DATA_DIR: join(home, ".realbud"), OMB_PORT: String(PORT), NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", () => {});
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) {
        const sess = await fetch(`${BASE}/api/session`).then((r) => r.json()).catch(() => null);
        session = String(sess?.token ?? "");
        return { child, home };
      }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not boot");
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
  out.loopsMs = Math.round(loops.ms);
  return out;
}

async function baseCount() {
  const desk = await api("GET", "/api/desk");
  return desk.body?.properties?.length ?? 0;
}

console.log("size  seedMs  deskMs  snapKB  practiceMs  previewMs  importMs  loopsMs");
// one boot per size keeps each measurement honest
for (const n of SIZES) {
  const { child, home } = await boot();
  try {
    const base = await baseCount();
    const res = await measure(n, base);
    console.log(
      `${String(res.n).padEnd(5)} ${String(res.seedMs).padEnd(7)} ${String(res.deskMs).padEnd(7)} ${String(res.snapshotKB).padEnd(7)} ${String(res.practiceMs).padEnd(11)} ${String(res.previewMs).padEnd(10)} ${String(res.importMs).padEnd(9)} ${res.loopsMs}`,
    );
  } finally {
    child.kill("SIGTERM");
    rmSync(home, { recursive: true, force: true });
  }
}
console.log("scale: done");
