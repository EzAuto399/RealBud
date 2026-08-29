#!/usr/bin/env node
// Simulated Australian PM weekday over the real HTTP API. Proves the
// named routines, Desk cases, Ask→Desk, Copy-only send gate, and the
// worker clock. Does not open mail, a live PMS, or Hermes.app.
//
//   node --experimental-strip-types scripts/e2e-pm-day.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.OMB_E2E_PORT ?? 18881);
const BASE = `http://127.0.0.1:${PORT}`;
const HOME = mkdtempSync(join(tmpdir(), "realbud-pm-day-"));

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};
const api = async (method, path, body) => {
  const headers = { origin: BASE };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (session) headers["x-realbud-session"] = session;
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, body: json };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let session = "";
const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server", "index.ts")], {
  cwd: ROOT,
  env: {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME,
    USERPROFILE: HOME,
    OMB_PORT: String(PORT),
    REALBUD_DATA_DIR: join(HOME, ".realbud"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (c) => (stderr += c));

const waitForRun = async (runId) => {
  for (let i = 0; i < 40; i++) {
    const state = (await api("GET", "/api/loops")).body;
    const settled = state?.runs?.find((r) => r.id === runId);
    if (settled && !["queued", "running"].includes(settled.status)) return settled;
    await sleep(150);
  }
  return null;
};

try {
  const deadline = Date.now() + 20_000;
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

  const catalog = (await api("GET", "/api/loops")).body;
  const ids = (catalog?.loops ?? []).map((l) => l.id);
  check("three named routines", ids.join(",") === "morning-arrears,owner-letter,inbound-triage");
  const morning = catalog.loops.find((l) => l.id === "morning-arrears");
  const letter = catalog.loops.find((l) => l.id === "owner-letter");
  const inbound = catalog.loops.find((l) => l.id === "inbound-triage");
  check("morning and Friday are built", morning?.available === true && letter?.available === true);
  check("inbound stays Planned", inbound?.available === false);
  check("inbound names the agency inbox", /Microsoft 365|Gmail/.test(inbound?.description ?? ""));
  check("catalog copy hides Hermes", !JSON.stringify(catalog.loops.map((l) => l.description)).match(/Hermes/i));

  const inboundRun = await api("POST", "/api/loops/inbound-triage/run", {});
  check("inbound Run now is 409", inboundRun.status === 409);

  // ── 7:30 money: clock presses the same Recheck door ──
  const morningPost = await api("POST", "/api/loops/morning-arrears/run", {});
  check("morning Run now accepted", morningPost.status === 201, String(morningPost.status));
  const morningSettled = await waitForRun(morningPost.body?.run?.id);
  check("morning routine settled", Boolean(morningSettled), morningSettled?.status);
  let snap = (await api("GET", "/api/desk")).body;
  check("morning left courtesy or levy cards", snap.drafts?.some((d) => d.kind === "courtesy-rent" || d.kind === "levy-from-rent"));
  check("demo cases include maintenance, lease, inspection", ["maintenance-intake", "lease-review", "inspection-prep"].every((kind) =>
    (snap.book?.cases ?? []).some((c) => c.kind === kind),
  ));
  const hermes = await api("GET", "/api/hermes");
  check("clock wrote the shared worker stamp", typeof hermes.body?.lastTest?.at === "number");
  check("clock stamped the worker source", snap.sources?.some((s) => s.kind === "hermes" && typeof s.lastCheckedAt === "number"));
  check("Recheck landed every address", Array.isArray(snap.results) && snap.results.length === snap.properties.length, `${snap.results?.length}/${snap.properties?.length}`);
  check("every known address has a result", (snap.properties ?? []).every((p) => (snap.results ?? []).some((r) => r.propertyId === p.id)));
  check("no mail source was invented", !(snap.sources ?? []).some((s) => /gmail|inbox|microsoft|imap/i.test(`${s.kind} ${s.label}`)));
  check("status payload is for Advanced, not a Hermes window", hermes.body?.pin?.profile === "property" && typeof hermes.body?.ready === "boolean");

  const courtesy = snap.drafts.find((d) => d.kind === "courtesy-rent" && d.status === "pending");
  check("courtesy is waiting", Boolean(courtesy));
  const allowed = await api("POST", `/api/desk/drafts/${courtesy.id}/allow`, { expectedRevision: snap.revision });
  check("Allow records the decision", allowed.status === 200 && allowed.body?.draft?.status === "allowed");
  check("send stays 403", (await api("POST", `/api/desk/drafts/${courtesy.id}/send`, {})).status === 403);

  // ── Ask puts work on Desk ──
  snap = (await api("GET", "/api/desk")).body;
  const asked = await api("POST", "/api/desk/propose", { propertyId: "prop-harbour", kind: "courtesy-rent" });
  check("Ask courtesy lands on Desk", asked.status === 201 && asked.body?.drafts?.some((d) => d.propertyId === "prop-harbour" && d.kind === "courtesy-rent"));
  const intake = await api("POST", "/api/desk/propose-book", {
    text: "3 Day St, Braddon ACT, Mina Cole, 0400 333 444, 620",
  });
  check("pasted book stages a proposal", intake.status === 200 && intake.body?.created >= 1);
  const staged = intake.body?.snapshot?.book?.bookProposals?.[0];
  const allowedBook = staged ? await api("POST", `/api/desk/book-proposals/${staged.id}/allow`, {}) : { status: 0 };
  check("Allow adds the pasted property", allowedBook.status === 200 && allowedBook.body?.properties?.some((p) => p.address.includes("Day St")));

  // ── Friday owner letter ──
  const letterPost = await api("POST", "/api/loops/owner-letter/run", {});
  check("Friday letter Run now accepted", letterPost.status === 201);
  const letterSettled = await waitForRun(letterPost.body?.run?.id);
  check("Friday letter settled", letterSettled?.status === "completed", letterSettled?.status);
  snap = (await api("GET", "/api/desk")).body;
  const owner = snap.drafts.find((d) => d.kind === "owner-letter" && d.status === "pending");
  check("owner letter is Copy-only", Boolean(owner) && typeof owner?.body === "string");
  if (owner) {
    check("owner letter will not send", (await api("POST", `/api/desk/drafts/${owner.id}/send`, {})).status === 403);
  }

  // ── Their export, then retune the clock ──
  const csv = ["address,daysSinceDue,rentLanded,levyPaid", '"12 Oak St, Dickson ACT",6,false,false'].join("\n");
  snap = (await api("POST", "/api/desk/import", { csv })).body;
  check("CSV flips the book live", snap?.mode === "live" && snap.hands === "csv");
  const retune = await api("PATCH", "/api/loops/morning-arrears", { time: "08:00" });
  check("PM retunes morning to 8:00", retune.status === 200 && retune.body?.loop?.schedule?.time === "08:00");
  await api("PATCH", "/api/loops/morning-arrears", { time: "07:30" });

  const named = await api("PATCH", "/api/desk/agency", { name: "Harbour PM" });
  check("agency name is Harbour PM", named.body?.book?.agency?.name === "Harbour PM");
} finally {
  child.kill("SIGKILL");
  setTimeout(() => rmSync(HOME, { recursive: true, force: true }), 200);
}

console.log(failures === 0 ? "\npm-day: ALL GREEN" : `\npm-day: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
