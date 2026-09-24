#!/usr/bin/env node
// Core RealBud contract for a second office / second Mac — not a second product.
// Isolated DATA_DIR. No Hermes.app, mail, live PMS, or named agency.
//
// Use cases (training book only):
//   U1  Fresh home boots as RealBud, not PropertyMe/Hermes
//   U2  Session required; anonymous desk is 401
//   U3  Six-property training book; Recheck does not invent live drafts
//   U4  Practice drafts courtesy/levy; statutory stays an escalation
//   U5  Send is always 403, including after Allow
//   U6  Malformed morning-review request is refused without creating a run
//   U7  Worker is not ready without a hands ping
//   U8  This home does not write the operator's ~/.realbud
//
// Edge cases:
//   E1  Hostile never-rule on add is ignored
//   E2  Stale Allow on an old revision is 409
//   E3  Two sequential homes do not leak the extra property
//
//   pnpm qa:second-office
//   node --experimental-strip-types scripts/qa-second-office-contract.mjs
//
// Recovered from the codex/company-qa-slice merge: this file and a Postgres
// company harness had collided at scripts/qa-company-core.mjs. Both are kept —
// this one is the second-office contract, the other is `pnpm qa:company`.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.OMB_E2E_PORT ?? 18891);
const BASE = `http://127.0.0.1:${PORT}`;
const operatorHome = homedir();
const sourceEntry = join(ROOT, "server", "index.ts");
const distEntry = join(ROOT, "dist-server", "server", "index.js");
const useSource = existsSync(join(ROOT, "server", "ask-control-intent.ts"));
const entry = useSource ? sourceEntry : distEntry;
const entryArgs = useSource
  ? ["--experimental-strip-types", sourceEntry]
  : [distEntry];

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withHome(label, fn) {
  const home = mkdtempSync(join(tmpdir(), `realbud-core-${label}-`));
  mkdirSync(join(home, ".realbud"), { recursive: true });
  const dataDir = join(home, ".realbud");
  const child = spawn(process.execPath, entryArgs, {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
      REALBUD_DATA_DIR: dataDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
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
      /* non-JSON */
    }
    return { status: res.status, body: json };
  };
  try {
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const res = await fetch(`${BASE}/api/health`);
        if (res.ok) break;
      } catch {
        /* wait */
      }
      if (Date.now() > deadline) throw new Error(`server never came up (${label}). stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode} (${label}). stderr:\n${stderr}`);
      await sleep(150);
    }
    const sessionRes = await fetch(`${BASE}/api/session`);
    const sessionBody = await sessionRes.json();
    session = sessionBody.token;
    const result = await fn({ api, dataDir, home, session });
    return result;
  } finally {
    child.kill("SIGTERM");
    await sleep(200);
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* leftover temp */
    }
  }
}

console.log("RealBud core contract (isolated home, training book)");
console.log(useSource ? "entry  server/index.ts" : "entry  dist-server (source tree missing modules)");
console.log("");

await withHome("a", async ({ api, dataDir }) => {
  const health = (await api("GET", "/api/health")).body;
  check("U1  health.app is realbud", health?.app === "realbud", health?.app);

  const noSession = await fetch(`${BASE}/api/desk`);
  check("U2  desk without session is 401", noSession.status === 401);

  const empty = (await api("GET", "/api/desk")).body;
  check("U3  training book is 6 properties", empty?.properties?.length === 6, `n=${empty?.properties?.length}`);
  check("U3  GET does not invent drafts", Array.isArray(empty?.drafts) && empty.drafts.length === 0);

  const practice = (await api("POST", "/api/desk/practice", {})).body;
  check(
    "U4  practice drafts courtesy or levy, not a send",
    Array.isArray(practice?.drafts) && practice.drafts.some((d) => d.kind === "courtesy-rent" || d.kind === "levy-from-rent"),
  );
  check(
    "U4  statutory stays an escalation",
    Array.isArray(practice?.escalations) && practice.escalations.some((e) => e.reason === "statutory-clock"),
  );

  const pending = practice?.drafts?.find((d) => d.status === "pending");
  const send = await api("POST", `/api/desk/drafts/${pending?.id}/send`, {});
  check("U5  send is 403", send.status === 403, String(send.body?.error ?? send.status));

  const stale = await api("POST", `/api/desk/drafts/${pending?.id}/allow`, { expectedRevision: 0 });
  check("E2  stale Allow is 409", stale.status === 409, String(stale.status));

  const allowed = await api("POST", `/api/desk/drafts/${pending?.id}/allow`, {});
  check("U5  allow has no sentAt", allowed.body?.draft?.status === "allowed" && !("sentAt" in (allowed.body?.draft ?? {})));
  const sendAfter = await api("POST", `/api/desk/drafts/${pending?.id}/send`, {});
  check("U5  send stays 403 after Allow", sendAfter.status === 403);

  const beforeInbound = await api("GET", "/api/loops");
  const inbound = await api("POST", "/api/loops/inbound-triage/run", {});
  const afterInbound = await api("GET", "/api/loops");
  check(
    "U6  malformed morning-review request is refused without a new run",
    beforeInbound.status === 200 && afterInbound.status === 200 &&
      inbound.status === 400 && inbound.body?.error === "Morning review requires its request identifier and current schedule revision." &&
      Array.isArray(beforeInbound.body?.runs) && Array.isArray(afterInbound.body?.runs) &&
      JSON.stringify(afterInbound.body.runs) === JSON.stringify(beforeInbound.body.runs),
  );

  const hermes = await api("GET", "/api/hermes");
  check("U7  worker is not ready without a ping on this home", hermes.status === 200 && hermes.body?.ready === false);

  check("U8  this home is not the operator ~/.realbud", dataDir !== join(operatorHome, ".realbud"));
  check("U8  this home wrote desk.json under REALBUD_DATA_DIR", existsSync(join(dataDir, "desk.json")));

  const hostile = await api("POST", "/api/desk/properties", {
    address: "1 Core St, Fyshwick ACT",
    tenantName: "Core Tester",
    tenantPhone: "0400 000 001",
    weeklyRentCents: 50_000,
    options: { never: [] },
  });
  const added = hostile.body?.properties?.find((p) => String(p.address).startsWith("1 Core"));
  check(
    "E1  empty never-rules do not stick",
    hostile.status === 201 && Array.isArray(added?.options?.never) && added.options.never.length === 2,
    `never=${added?.options?.never?.length}`,
  );

  return { extraCount: hostile.body?.properties?.length };
});

await withHome("b", async ({ api }) => {
  const desk = (await api("GET", "/api/desk")).body;
  check("E3  second home still has the 6-property training book", desk?.properties?.length === 6, `n=${desk?.properties?.length}`);
});

console.log("");
if (failures) {
  console.error(`FAIL  core contract — ${failures} check(s)`);
  process.exit(1);
}
console.log("ALL GREEN — core contract");
