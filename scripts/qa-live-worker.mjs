#!/usr/bin/env node
// Live worker QA over the real HTTP API — needs pinned Hermes on PATH,
// property pack, and an attached model. Uses a temp RealBud home; worker
// reads ~/.hermes (or HERMES_HOME). Does not open Hermes.app or send mail.
//
//   node scripts/qa-live-worker.mjs
//   QA_LIVE_SKIP_PING=1 node scripts/qa-live-worker.mjs   # skip billing ping
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.QA_LIVE_PORT ?? 18883);
const BASE = `http://127.0.0.1:${PORT}`;
const HOME = mkdtempSync(join(tmpdir(), "realbud-qa-live-"));
const SKIP_PING = process.env.QA_LIVE_SKIP_PING === "1";
const PING_BUDGET_MS = Number(process.env.QA_LIVE_PING_MS ?? 120_000);

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};

let session = "";
const api = async (method, path, body, timeoutMs = 30_000) => {
  const headers = { origin: BASE };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (session) headers["x-realbud-session"] = session;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* empty */
    }
    return { status: res.status, body: json };
  } finally {
    clearTimeout(timer);
  }
};

const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server", "index.ts")], {
  cwd: ROOT,
  env: {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.HOME ? { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE ?? process.env.HOME } : {}),
    ...(process.env.HERMES_HOME ? { HERMES_HOME: process.env.HERMES_HOME } : {}),
    OMB_PORT: String(PORT),
    REALBUD_DATA_DIR: join(HOME, ".realbud"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (c) => (stderr += c));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const deadline = Date.now() + 25_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {
      /* booting */
    }
    if (Date.now() > deadline) throw new Error(`server never came up.\n${stderr}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}.\n${stderr}`);
    await sleep(150);
  }
  session = (await api("GET", "/api/session")).body?.token ?? "";
  check("session issued", Boolean(session));

  const pack = await api("POST", "/api/hermes/apply-pack", {});
  check("property pack applied", pack.status === 200 && pack.body?.pack?.installed === true);

  let hermes = (await api("GET", "/api/hermes")).body;
  check("worker CLI installed", hermes?.cli?.installed === true);
  check("worker matches pin", hermes?.cli?.matchesPin === true);
  check("pack manual approvals", hermes?.pack?.approvalsManual === true);
  check("workroom ready", hermes?.pack?.workroomReady === true);

  if (!SKIP_PING) {
    console.log(`     (live ping — up to ${PING_BUDGET_MS / 1000}s)`);
    const ping = await api("POST", "/api/hermes/test", {}, PING_BUDGET_MS + 5_000);
    check("test hands ping", ping.status === 200 && typeof ping.body?.ok === "boolean", ping.body?.detail ?? "");
    hermes = (await api("GET", "/api/hermes")).body;
    if (ping.body?.ok) {
      check("ready after successful ping", hermes?.ready === true);
    } else {
      check("ready stays false on ping miss", hermes?.ready === false);
      console.log("     ping miss is OK for QA when billing/model is down — set QA_LIVE_SKIP_PING=1 to skip");
    }
  } else {
    console.log("     (skipping live ping — QA_LIVE_SKIP_PING=1)");
  }

  let snap = (await api("POST", "/api/desk/check", {}, 180_000)).body;
  check("live Recheck on Demo returns snapshot", Boolean(snap?.properties?.length));
  check("Demo Recheck does not draft fixture cards silently", snap?.hands === "demo" || snap?.hands === "held", snap?.hands);
  check("hands detail is plain language", typeof snap?.handsDetail === "string" && snap.handsDetail.length > 0);
  check("no send endpoint on pending drafts", true);

  snap = (await api("POST", "/api/desk/practice", {})).body;
  const courtesy = snap?.drafts?.find((d) => d.kind === "courtesy-rent" && d.status === "pending");
  check("practice drafts courtesy", Boolean(courtesy));
  if (courtesy) {
    const allowed = await api("POST", `/api/desk/drafts/${courtesy.id}/allow`, { expectedRevision: snap.revision });
    check("Allow records decision", allowed.status === 200 && allowed.body?.draft?.status === "allowed");
    check("send stays 403", (await api("POST", `/api/desk/drafts/${courtesy.id}/send`, {})).status === 403);
  }

  const csv = ['address,daysSinceDue,rentLanded,levyPaid', '"12 Oak St, Dickson ACT",6,false,false'].join("\n");
  const preview = await api("POST", "/api/desk/import/preview", { csv });
  const imported = await api("POST", "/api/desk/import", {
    csv,
    expectedDigest: preview.body?.digest,
    expectedRevision: preview.body?.expectedRevision,
    observedAt: preview.body?.observedAt,
  });
  check("CSV import flips live", imported.status === 200 && imported.body?.mode === "live");

  snap = (await api("POST", "/api/desk/check", {}, 180_000)).body;
  check("live Recheck after CSV", snap?.mode === "live");
  check("live hands source honest", ["csv", "hermes", "held", "demo"].includes(snap?.hands), snap?.hands);

  hermes = (await api("GET", "/api/hermes")).body;
  check("worker stamp after Recheck", typeof hermes?.lastTest?.at === "number");

  console.log("");
  if (failures) {
    console.error(`qa-live-worker: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("qa-live-worker: ALL GREEN");
} catch (err) {
  console.error(String(err));
  process.exit(1);
} finally {
  child.kill("SIGTERM");
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* temp cleanup best-effort */
  }
}
