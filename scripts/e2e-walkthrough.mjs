#!/usr/bin/env node
// Full PM walkthrough over the real HTTP API, including the bounded portal
// handoff and recovery. Boots the harness on a temp home plus the fake
// portal, then walks the 90-second partner demo exactly as the GUI would:
// demo Desk → Recheck → allow/copy → CSV import (matched + unmatched) →
// Schedule retune/run → portal prepare (Bud prefills, human submits) →
// send stays 403 → recovery after corruption.
//
//   node --experimental-strip-types scripts/e2e-walkthrough.mjs
//   OMB_E2E_PORT=8899 node --experimental-strip-types scripts/e2e-walkthrough.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.OMB_E2E_PORT ?? 18880);
const BASE = `http://127.0.0.1:${PORT}`;
const HOME = mkdtempSync(join(tmpdir(), "realbud-walkthrough-"));

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};
const api = async (method, path, body) => {
  const headers = { "origin": BASE };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (session) headers["x-realbud-session"] = session;
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { startFakePortal } = await import(join(ROOT, "server", "testing", "fake-portal.ts"));
const portal = await startFakePortal(0);

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
    FAKE_PORTAL_URL: portal.url,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (c) => (stderr += c));

try {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* booting */ }
    if (Date.now() > deadline) throw new Error(`server never came up.\n${stderr}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}.\n${stderr}`);
    await sleep(150);
  }
  session = (await api("GET", "/api/session")).body?.token ?? "";
  check("session issued", Boolean(session));

  // ── 1. demo desk ──
  let snap = (await api("GET", "/api/desk")).body;
  check("demo book on first paint", snap?.mode === "demo" && snap.properties.length >= 6, `${snap?.properties?.length} properties`);
  check("default queue excludes portfolio Notes and contact history", snap.properties.every((property) => property.notes === undefined) && snap.book?.contacts.length === 0 && snap.book?.tenancies.length === 0);

  const support = (await api("GET", "/api/support-report")).body;
  const supportJson = JSON.stringify(support);
  check("support report separates runtime and proof", support?.kind === "realbud.support-report.v1" && support.evidence?.installed === "requires-installed-proof" && support.evidence?.namedOffice === "pilot-gated");
  check("support report contains no portfolio or credential material", !/tenant|phone|address|notes|message|prompt|cookie|credential|api.?key|token|secret|\.hermes|\/Users\//i.test(supportJson));

  // ── 1.25 source-safe interrupt path: fixed sample only, no provider ──
  snap = (await api("POST", "/api/desk/inbound/demo", { expectedRevision: snap.revision })).body;
  const demoMaintenance = snap.workItems.find((item) => item.inbound?.category === "urgent-maintenance-review");
  const demoBdm = snap.workItems.find((item) => item.inbound?.category === "bdm-lead");
  check("sample inbox creates one urgent maintenance case", demoMaintenance?.kind === "maintenance-intake" && demoMaintenance?.state === "proposed");
  check("sample inbox creates one supervised BDM reply", demoBdm?.kind === "inbound-triage" && Boolean(demoBdm?.draftId));
  const sampleRevision = snap.revision;
  snap = (await api("POST", "/api/desk/inbound/demo", { expectedRevision: sampleRevision })).body;
  check("sample inbox replay is idempotent", snap.revision === sampleRevision && snap.workItems.filter((item) => item.inbound).length === 2);
  const bdmDraft = snap.drafts.find((draft) => draft.id === demoBdm?.draftId);
  if (!demoBdm || !bdmDraft) throw new Error("Demo BDM case did not produce its supervised draft");
  const allowedBdm = await api("POST", `/api/desk/drafts/${bdmDraft.id}/allow`, { expectedRevision: snap.revision });
  check("inbound reply requires exact manual Allow", allowedBdm.status === 200 && allowedBdm.body?.draft?.status === "allowed");
  snap = (await api("GET", "/api/desk")).body;
  const waitingBdm = await api("POST", `/api/desk/cases/${demoBdm.id}/waiting`, { expectedRevision: snap.revision });
  const waitingWork = waitingBdm.body?.workItems?.find((item) => item.id === demoBdm.id);
  check("allowed reply can wait with a next-check receipt", waitingBdm.status === 200 && waitingWork?.state === "waiting" && Number.isFinite(waitingWork.lifecycle?.nextCheckAt));
  const closedBdm = await api("POST", `/api/desk/cases/${demoBdm.id}/close`, { expectedRevision: waitingBdm.body.revision, closureKind: "resolved-externally" });
  const closedWork = closedBdm.body?.workItems?.find((item) => item.id === demoBdm.id);
  check("waiting work closes with a durable external-resolution receipt", closedBdm.status === 200 && closedWork?.lifecycle?.closureKind === "resolved-externally" && Number.isFinite(closedWork.lifecycle?.closedAt));
  snap = closedBdm.body;

  // ── 1.5 route Oak through the portal before any draft exists ──
  // (the seeded fake-portal binding is prop-oak)
  const oak0 = snap.properties.find((p) => p.address.includes("Oak"));
  await api("PATCH", `/api/desk/properties/${oak0.id}`, { notifyChannel: "portal" });

  // ── 2. recheck drafts the portal courtesy for the bound property ──
  snap = (await api("POST", "/api/desk/check", {})).body;
  const portalEarly = snap.drafts.find((d) => d.kind === "courtesy-rent" && d.status === "pending" && d.channel === "portal");
  check("recheck drafts portal courtesy for Oak", Boolean(portalEarly));

  // ── 4. CSV import: matched go live, unmatched becomes an issue with an address ──
  const csv = [
    "address,daysSinceDue,rentLanded,levyPaid",
    '"12 Oak St, Dickson ACT",6,false,false',
    '"4/22 Harbour Rd, Kingston ACT",5,false,false',
    '"99 Ghost St, Acton ACT",3,false,false',
  ].join("\n");
  snap = (await api("POST", "/api/desk/import", { csv, expectedRevision: snap.revision })).body;
  check("import flips the book live", snap?.mode === "live" && snap.hands === "csv");
  const issue = snap.book?.importIssues?.find((row) => row.rawIdentity.includes("Ghost"));
  check("unmatched row keeps its address", Boolean(issue), issue?.rawIdentity);
  snap = (await api("POST", "/api/desk/import", { csv, expectedRevision: snap.revision })).body;
  check("re-import does not duplicate the issue", snap.book.importIssues.filter((row) => row.rawIdentity.includes("Ghost")).length === 1);
  const rejectedIssue = await api("POST", `/api/desk/import-issues/${issue.id}/reject`, {
    expectedRevision: snap.revision,
    requestId: "walkthrough-reject-ghost",
  });
  check("PM can durably reject an unmatched import identity", rejectedIssue.status === 200 && rejectedIssue.body.book.importIssues.find((row) => row.id === issue.id)?.status === "rejected");
  snap = rejectedIssue.body;

  // ── 3. allow → decision recorded, wording still copyable, send 403 ──
  const courtesy = snap.drafts.find((d) => d.kind === "courtesy-rent" && d.status === "pending" && d.channel !== "portal");
  check("import recheck drafts an sms courtesy", Boolean(courtesy));
  const allowed = (await api("POST", `/api/desk/drafts/${courtesy.id}/allow`, { expectedRevision: snap.revision })).body;
  check("allow records decision", allowed?.draft?.status === "allowed");
  check("approved wording keeps the copy body", typeof allowed?.draft?.body === "string" && allowed.draft.body.includes("not a formal notice"));
  check("send is still 403", (await api("POST", `/api/desk/drafts/${courtesy.id}/send`, {})).status === 403);

  // ── 5. schedule: retune + run now on both built loops ──
  const loopSnapshot = (await api("GET", "/api/loops")).body;
  const morningLoop = loopSnapshot.loops.find((loop) => loop.id === "morning-arrears");
  const retuned = await api("PATCH", "/api/loops/morning-arrears", { time: "08:15", expectedRevision: morningLoop.revision });
  check("clock retune sticks with revision", retuned.status === 200 && retuned.body.loop.revision >= 2);
  const run = await api("POST", "/api/loops/morning-arrears/run", {});
  check("morning loop runs now", run.status === 201);
  await sleep(500);
  const letter = await api("POST", "/api/loops/owner-letter/run", {});
  check("owner letter runs now", letter.status === 201);
  for (let i = 0; i < 20; i++) {
    snap = (await api("GET", "/api/desk")).body;
    if (snap.drafts.some((d) => d.kind === "owner-letter")) break;
    await sleep(250);
  }
  check("owner letter drafted a proposal", snap.drafts.some((d) => d.kind === "owner-letter"));
  await api("PATCH", "/api/loops/morning-arrears", { time: "07:30", expectedRevision: retuned.body.loop.revision });

  // ── 6. bounded portal handoff: reacquire current PMS evidence, then
  // allow → prepare → Bud prefills, human submits. The scheduled Recheck
  // above intentionally invalidates wording when no verified source answers.
  snap = (await api("GET", "/api/desk")).body;
  snap = (await api("POST", "/api/desk/import", { csv, expectedRevision: snap.revision })).body;
  const portalDraft = snap.drafts.find((d) => d.kind === "courtesy-rent" && d.status === "pending" && d.channel === "portal");
  check("portal draft belongs to the bound property", portalDraft?.propertyId === oak0.id);
  check("portal-channel courtesy draft exists", Boolean(portalDraft));
  const portalAllow = await api("POST", `/api/desk/drafts/${portalDraft.id}/allow`, { expectedRevision: snap.revision });
  check("portal wording allowed", portalAllow.status === 200);
  const minted = (await api("GET", "/api/desk")).body;
  const handoff = minted.book?.handoff;
  check("minted handoff is case-scoped with expiry", Boolean(handoff?.expiresAt) && Boolean(handoff?.caseId), JSON.stringify(handoff)?.slice(0, 100));
  const prepared = await api("POST", `/api/desk/drafts/${portalDraft.id}/prepare`, {});
  check("prepare runs the bounded session", prepared.status === 200, prepared.body?.error ?? "");
  check("bud prefilled exactly once and never submitted", portal.prefillCount() === 1 && portal.submitCount() === 0);
  const budSubmit = await fetch(`${portal.url}/submit`, { method: "POST", headers: { "x-realbud-actor": "bud" } });
  check("portal refuses bud submit", budSubmit.status === 403);
  const humanSubmit = await fetch(`${portal.url}/submit`, { method: "POST", headers: { "x-realbud-actor": "human" } });
  check("portal accepts human submit", humanSubmit.ok);
  await sleep(300);
  const settled = (await api("GET", "/api/desk")).body;
  check("handoff resolves after human submit", ["confirmed", "handoff-ready"].includes(settled.book?.handoff?.state ?? "") || !settled.book?.handoff);

  // ── 7. recovery: corrupt the book, server must refuse writes, not fake data ──
  child.kill("SIGKILL");
  await sleep(300);
  writeFileSync(join(HOME, ".realbud", "desk.json"), "{corrupt");
  session = "";
  const revived = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server", "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      HOME,
      USERPROFILE: HOME,
      OMB_PORT: String(PORT),
      REALBUD_DATA_DIR: join(HOME, ".realbud"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let revivedErr = "";
  revived.stderr.on("data", (c) => (revivedErr += c));
  const deadline2 = Date.now() + 20_000;
  for (;;) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* booting */ }
    if (Date.now() > deadline2) throw new Error(`recovered server never came up.\n${revivedErr}`);
    await sleep(150);
  }
  session = (await api("GET", "/api/session")).body?.token ?? "";
  const recRes = await api("GET", "/api/desk");
  const recovered = recRes.body;
  console.log(`     [debug] recovery GET ${recRes.status}: active=${Boolean(recovered?.recovery?.active)} mode=${recovered?.mode ?? "unknown"}`);
  check("corrupt book enters recovery, not demo", recRes.status === 200 && recovered?.recovery?.active === true);
  check("recovery keeps the desk readable", Array.isArray(recovered.properties));
  const writeAttempt = await api("POST", "/api/desk/check", {});
  check("writes are refused in recovery", writeAttempt.status === 409);
  revived.kill("SIGKILL");
} finally {
  await portal.close().catch(() => {});
  child.kill("SIGKILL");
  setTimeout(() => rmSync(HOME, { recursive: true, force: true }), 200);
}

console.log(failures === 0 ? "\nwalkthrough: ALL GREEN" : `\nwalkthrough: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
