#!/usr/bin/env node
// PM walkthrough over the real HTTP API — no engines, no Hermes CLI needed.
// Boots the harness server on a temp home, then walks exactly what the GUI
// drives: Desk snapshot → draft gates → allow → recheck → book add/edit/
// remove → named loops → hands status. Exits non-zero on the first failure.
//
//   node scripts/e2e-desk.mjs           (port 18879)
//   OMB_E2E_PORT=8899 node scripts/e2e-desk.mjs
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.OMB_E2E_PORT ?? 18879);
const BASE = `http://127.0.0.1:${PORT}`;

const home = mkdtempSync(join(tmpdir(), "realbud-e2e-desk-"));
mkdirSync(join(home, ".realbud"), { recursive: true });

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};

let session = "";

const api = async (method, path, body) => {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (session) headers["x-realbud-session"] = session;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, body: json };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server", "index.ts")], {
  cwd: ROOT,
  env: {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: home,
    USERPROFILE: home,
    OMB_PORT: String(PORT),
    REALBUD_DATA_DIR: join(home, ".realbud"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (c) => (stderr += c));

try {
  // ── boot ──
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
    await sleep(150);
  }
  const health = (await api("GET", "/api/health")).body;
  check("server identifies as realbud", health?.app === "realbud", health?.app);

  const sessionRes = await fetch(`${BASE}/api/session`);
  const sessionBody = await sessionRes.json();
  session = sessionBody.token;
  check("per-boot session token issued", sessionRes.ok && typeof session === "string" && session.length > 8);

  const noSession = await fetch(`${BASE}/api/desk`);
  check("desk without a session is 401", noSession.status === 401);

  // ── Desk: GET is side-effect free; Recheck is explicit ──
  const empty = (await api("GET", "/api/desk")).body;
  check("pure GET has the 6-property book and no implicit drafts", empty?.properties?.length === 6 && empty?.lastRunAt == null && empty?.drafts?.length === 0, `drafts=${empty?.drafts?.length}`);

  const missed = (await api("POST", "/api/desk/check", {})).body;
  check("desk has the 6-property Demo book", missed?.properties?.length === 6, `got ${missed?.properties?.length}`);
  check("ledger facts are exposed", Array.isArray(missed?.ledger) && missed.ledger.length === 6);
  check("live Recheck on Demo does not draft fixture cards", missed?.hands === "demo" && Array.isArray(missed?.drafts) && missed.drafts.length === 0, `${missed?.hands} drafts=${missed?.drafts?.length}`);
  const desk = (await api("POST", "/api/desk/practice", {})).body;
  check("practice drafted courtesy + levy flags", ["courtesy-rent", "levy-from-rent"].every((kind) => desk?.drafts?.some((d) => d.kind === kind)));
  check("escalation raised with no draft", desk?.escalations?.length >= 1 && desk.escalations[0].reason === "statutory-clock");
  check("Demo practice is labelled Demo, not a live success", desk?.demo === true && desk?.hands === "demo", `${desk?.hands} ${desk?.handsDetail}`);

  const pending = desk.drafts.find((d) => d.status === "pending");
  const send = await api("POST", `/api/desk/drafts/${pending.id}/send`, {});
  check("draft send is always 403", send.status === 403, String(send.body?.error));

  const allowed = await api("POST", `/api/desk/drafts/${pending.id}/allow`, {});
  check("allow marks wording approved without a sentAt", allowed.body?.draft?.status === "allowed" && !("sentAt" in (allowed.body?.draft ?? {})), allowed.body?.draft?.status);

  const afterAllow = (await api("GET", "/api/desk")).body;
  const work = afterAllow.workItems?.find((w) => w.draftId === pending.id);
  check("work item is approved, not confirmed or sent", work?.state === "approved", work?.state);

  const recheck = await api("POST", "/api/desk/check", {});
  check("recheck completes and reports hands", recheck.status === 200 && ["demo", "hermes", "held", "csv"].includes(recheck.body?.hands), recheck.body?.hands);
  check("live readiness is not claimed from Demo facts", recheck.body?.demo === true || recheck.body?.hands === "hermes" || recheck.body?.hands === "csv");

  // ── Book: add → edit → remove ──
  const added = await api("POST", "/api/desk/properties", {
    address: "9 Wattle Ct, O'Connor ACT",
    tenantName: "Morgan Lee",
    tenantPhone: "0411 222 333",
    weeklyRentCents: 61_000,
  });
  const property = added.body?.properties?.find((p) => p.address?.startsWith("9 Wattle"));
  check("add property lands in the book with quiet day-0 facts", added.status === 201 && Boolean(property) && added.body.ledger.some((r) => r.propertyId === property.id && r.daysSinceDue === 0));
  check("new property is inside grace (no draft)", Boolean(property) && !added.body?.drafts?.some((d) => d.propertyId === property.id));

  const patched = await api("PATCH", `/api/desk/properties/${property.id}`, { notifyChannel: "portal", graceDays: 5 });
  check("options patch sticks and never-rules stay locked", patched.body?.property?.options?.notifyChannel === "portal" && patched.body?.property?.options?.graceDays === 5 && patched.body?.property?.options?.never?.length === 2);

  const removed = await api("DELETE", `/api/desk/properties/${property.id}`);
  check("remove property drops it with its facts", removed.status === 200 && removed.body.properties.length === 6 && !removed.body.ledger.some((r) => r.propertyId === property.id));

  // ── Schedule: named loops ──
  const loops = (await api("GET", "/api/loops")).body;
  check("three named loops, inbound stays Planned", loops?.loops?.map((l) => l.id).join(",") === "morning-arrears,owner-letter,inbound-triage" && loops.loops[0].available === true && loops.loops[1].available === true && loops.loops[2].available === false);
  const plannedRun = await api("POST", "/api/loops/inbound-triage/run", {});
  check("planned loops refuse to run", plannedRun.status === 409);

  const ran = await api("POST", "/api/loops/morning-arrears/run", {});
  check("morning-arrears run accepted", ran.status === 201 && ran.body?.run?.loopId === "morning-arrears");
  const runDeadline = Date.now() + 30_000;
  let settled = null;
  for (;;) {
    const state = (await api("GET", "/api/loops")).body;
    settled = state.runs.find((r) => r.id === ran.body.run.id);
    if (settled && !["queued", "running"].includes(settled.status)) break;
    if (Date.now() > runDeadline) break;
    await sleep(250);
  }
  check("loop run settles with a hands detail", settled?.status === "completed" && typeof settled.detail === "string", `${settled?.status} · ${settled?.detail}`);

  // ── Hands status ──
  const hermes = (await api("GET", "/api/hermes")).body;
  check("hands status reports the pin and readiness flags", hermes?.pin?.product === "0.20.3" && typeof hermes?.ready === "boolean", `ready=${hermes?.ready}`);
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.on("close", resolve);
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000).unref?.();
  });
  rmSync(home, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} walkthrough step(s) failed`);
  process.exit(1);
}
console.log("\nDesk walkthrough complete.");
