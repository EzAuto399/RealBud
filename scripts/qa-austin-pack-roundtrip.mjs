#!/usr/bin/env node
// Real HTTP import -> prepare -> export -> second office import -> prepare.
// --live uses the existing RealBud-owned model login, never a fake answer.
// Source inputs and office state are synthetic; bank review is a simulated
// human decision through the real processor. No bank, mailbox or REI access.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "pack/workflows/austin-phase-1");
const live = process.argv.includes("--live");
const arg = process.argv.indexOf("--out");
if (arg >= 0 && !process.argv[arg + 1]) throw new Error("--out needs a new output directory.");
const out = resolve(arg >= 0 ? process.argv[arg + 1] : join(root, "outputs", `austin-pack-roundtrip-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`));
if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Use Node 24 or later.");
if (existsSync(out)) throw new Error("Choose a new output directory; previous QA evidence is preserved.");
const engineHome = process.env.REALBUD_HERMES_HOME || join(homedir(), ".realbud/hermes");
if (live && !existsSync(join(engineHome, "profiles/property/config.yaml"))) throw new Error("Connect a model in RealBud first, or set REALBUD_HERMES_HOME to its owned profile root.");
mkdirSync(out, { recursive: true });
const fixtureRoot = mkdtempSync(join(tmpdir(), "realbud-austin-roundtrip-"));
const pack = JSON.parse(readFileSync(join(source, "workflows.json"), "utf8"));
const billFixture = JSON.parse(readFileSync(join(source, "fixtures/expected-bills.json"), "utf8"));
const bankSettings = JSON.parse(readFileSync(join(source, "fixtures/bank-settings.json"), "utf8"));
const csv = readFileSync(join(source, "fixtures/bank-source.csv"), "utf8");
const hash = value => createHash("sha256").update(value).digest("hex");
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
const report = { startedAt: new Date().toISOString(), live, node: process.version,
  scope: "Two isolated local offices; supplied synthetic files; real HTTP routes. Live mode uses the real Hermes model. Bank review decisions are simulated human review.",
  fixtureRoot, checks: [], runs: [], artifacts: [], limitations: [
    "No customer mailbox acquisition, bank login, payment or REI import tested.",
    "Bank proposals and bank review/export are separate existing app paths; this harness supplies the batch and simulates the reviewer bridge.",
    "This is current source API/executor QA, not Windows or packaged-app acceptance.",
    "No recurring schedule is activated; all test runs are manual."
  ] };
const save = () => writeJson(join(out, "qa-report.json"), report);
const check = (label, condition, detail) => {
  report.checks.push({ label, ok: Boolean(condition), ...(detail ? { detail } : {}) }); save();
  console.log(`${condition ? "PASS" : "FAIL"} ${label}`);
  assert.ok(condition, label);
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const planFields = ["id", "title", "description", "steps", "allowedOrigins", "evidence", "capabilities", "limits", "siteNotes", "schedule"];
const plans = rows => rows.map(row => Object.fromEntries(planFields.map(key => [key, row[key] ?? null]))).sort((a, b) => a.id.localeCompare(b.id));
const offices = [];

async function boot(name, existing) {
  const data = existing?.data ?? join(fixtureRoot, name);
  mkdirSync(data, { recursive: true });
  const socket = createServer();
  await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const office = { name, data, base: `http://127.0.0.1:${port}`, token: "", logs: "", child: null };
  const env = { PATH: `${dirname(process.execPath)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
    HOME: process.env.HOME || homedir(), USERPROFILE: process.env.USERPROFILE || homedir(),
    REALBUD_DATA_DIR: data, OMB_PORT: String(port), OMB_STATIC_DIR: join(root, "dist"),
    ...(live ? { REALBUD_HERMES_HOME: engineHome, HERMES_HOME: engineHome, HERMES_SAFE_MODE: "1" } : {}) };
  office.child = spawn(process.execPath, [join(root, "server/index.ts")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  offices.push(office);
  office.child.on("error", error => { office.logs += error.message; });
  for (const stream of [office.child.stdout, office.child.stderr]) stream.on("data", chunk => { office.logs = (office.logs + chunk).slice(-160_000); });
  const deadline = Date.now() + 35_000;
  while (true) {
    if (office.child.exitCode !== null) throw new Error(`${name} server exited ${office.child.exitCode}: ${office.logs}`);
    if (await fetch(office.base + "/api/health").then(r => r.ok, () => false)) break;
    if (Date.now() > deadline) throw new Error(`${name} server startup timed out: ${office.logs}`);
    await delay(120);
  }
  office.token = (await api(office, "GET", "/api/session")).body.token;
  check(`${name}: issued local session`, Boolean(office.token));
  return office;
}

async function stop(office) {
  const child = office.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

async function api(office, method, path, body, authenticated = true) {
  const response = await fetch(office.base + path, { method,
    headers: { "content-type": "application/json", ...(authenticated && office.token ? { "x-realbud-session": office.token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(195_000) });
  return { status: response.status, body: await response.json() };
}
const recipes = async office => (await api(office, "GET", "/api/recipes")).body.recipes;
async function approve(office, recipe) {
  const result = await api(office, "PATCH", `/api/recipes/${recipe.id}`, { planApproved: true, expectedRevision: recipe.revision });
  check(`${office.name}: approve ${recipe.id} locally`, result.status === 200, result.body.error);
}
async function run(office, id, label) {
  const recipe = (await recipes(office)).find(r => r.id === id);
  const request = { expectedRevision: recipe.revision, requestId: randomUUID() };
  console.log(`RUN  ${label} — real model`);
  const first = api(office, "POST", `/api/recipes/${id}/prepare`, request);
  await delay(300);
  const duplicate = await api(office, "POST", `/api/recipes/${id}/prepare`, request);
  const response = await first;
  check(`${label}: HTTP preparation accepted`, response.status === 200, response.body.error);
  const value = response.body.run;
  report.runs.push({ label, ...value }); save();
  check(`${label}: duplicate request reuses the same run`, duplicate.body.reused === true && duplicate.body.run?.id === value.id);
  check(`${label}: usable model receipt`, ["completed", "awaiting-approval"].includes(value.status), value.detail);
  writeJson(join(out, `${label}.run.json`), value);
  writeFileSync(join(out, `${label}.review.md`), value.evidence.filter(e => e.kind === "output").map(e => e.note).join("\n\n") + "\n");
  return value;
}
function structured(run, kind) {
  const found = run.evidence.filter(e => e.kind === "output").flatMap(e => {
    try { return [JSON.parse(e.note.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""))]; }
    catch { return []; }
  }).filter(value => value.kind === kind);
  check(`${run.jobTitle}: one complete ${kind} object`, found.length === 1);
  return found[0];
}
function verifyBills(value, reference, complete = true) {
  check(`${reference}: read the actual input reference`, value.sourceReference === reference);
  check(`${reference}: honest coverage`, value.coverageComplete === complete);
  const expected = { "BILL-101": "received", "BILL-102": complete ? "missing" : "unknown", "BILL-103": complete ? "not-due" : "unknown", "BILL-104": "received" };
  check(`${reference}: each expected occurrence exactly once`, value.findings?.length === 4 && new Set(value.findings.map(r => r.occurrenceId)).size === 4);
  check(`${reference}: evidence-based arrival decisions`, value.findings.every(row => row.arrival === expected[row.occurrenceId]));
  check(`${reference}: explicit property mapping`, value.findings.every(row => row.propertyId === `SYN-P0${row.occurrenceId.slice(-1)}`));
  check(`${reference}: arranged is not paid`, value.findings.find(r => r.occurrenceId === "BILL-101").payment === "arranged-unconfirmed");
  check(`${reference}: unknown due date stays unknown`, value.findings.find(r => r.occurrenceId === "BILL-104").dueDate === null);
  check(`${reference}: unmapped source held`, JSON.stringify(value.holds).includes("MAIL-UNKNOWN"));
  check(`${reference}: duplicate evidence does not create another occurrence`, value.findings.filter(r => r.occurrenceId === "BILL-101").length === 1);
}
function verifyBank(value, reference, batch) {
  check(`${reference}: correct input reference and original digest`, value.sourceReference === reference && value.originalDigest === batch.originalDigest);
  check(`${reference}: all source rows kept in order`, value.rows?.length === batch.rows.length && value.rows.every((row, i) => row.sourceRow === i + 1 && row.rowId === batch.rows[i].id));
  check(`${reference}: no guessed or destructive decisions`, JSON.stringify(value.rows.map(row => row.decision)) === JSON.stringify(["assign", "hold", "hold", "keep", "keep", "hold", "hold"]));
  check(`${reference}: approved reference retains leading zeroes`, value.rows[0].propertyId === "SYN-P01" && value.rows[0].proposedReference === "00127");
  check(`${reference}: held and unchanged rows have no invented assignment`, value.rows.slice(1).every(row => row.propertyId === null && row.proposedReference === null));
}
async function bindFixtures(office, suffix, complete = true) {
  const inputDir = join(office.data, "vault/workflow-inputs");
  mkdirSync(inputDir, { recursive: true });
  const bills = structuredClone(billFixture);
  bills.sourceReference = `SYNTHETIC-BILLS-${suffix}-${randomUUID().slice(0, 8)}`;
  bills.coverage.complete = complete;
  if (!complete) bills.coverage.failedSources = ["fixture-admin@example.invalid: page 2 unavailable"];
  writeJson(join(inputDir, "expected-bills.json"), bills);
  const bank = await api(office, "POST", "/api/bank-reference", { csv, columns: bankSettings.columns, dateFormat: bankSettings.dateFormat, rules: bankSettings.rules });
  check(`${office.name}: actual bank processor creates source batch`, bank.status === 200, bank.body.error);
  const bankInput = { sourceReference: `SYNTHETIC-BANK-${suffix}-${randomUUID().slice(0, 8)}`, synthetic: true,
    formatConfirmed: true, coverage: { complete: true, from: "2026-09-11", toExclusive: "2026-09-13", account: "synthetic-account" }, batch: bank.body.value.batch };
  writeJson(join(inputDir, "bank-reference.json"), bankInput);
  return { bills, bank: bankInput, record: bank.body, inputDir };
}
async function reviewBank(office, fixture, suffix) {
  const path = `/api/bank-reference/${fixture.record.id}`;
  check(`${suffix}: checked export is blocked before review`, (await api(office, "POST", path + "/export", {})).status === 409);
  const decisions = fixture.record.value.batch.rows.map((row, i) => ({ rowId: row.id,
    ...(i === 0 ? { action: "assign", propertyId: "SYN-P01" } : { action: "keep" }),
    reason: i === 0 ? "Synthetic reviewer confirms approved payer mapping" : "Synthetic reviewer retains unresolved or existing source row for separate review" }));
  const request = { revision: fixture.record.revision, decisions };
  const reviewed = await api(office, "POST", path + "/review", request);
  check(`${suffix}: simulated human review saved`, reviewed.status === 200, reviewed.body.error);
  check(`${suffix}: stale duplicate review rejected`, (await api(office, "POST", path + "/review", request)).status === 409);
  const original = await api(office, "POST", path + "/original", {});
  const exported = await api(office, "POST", path + "/export", {});
  check(`${suffix}: original byte identity preserved`, original.status === 200 && original.body.csv === csv && original.body.digest === hash(csv));
  const expected = csv.replace("Alex Tenant,,preserve", "Alex Tenant,00127,preserve");
  check(`${suffix}: only the reviewed reference bytes change`, exported.status === 200 && exported.body.csv === expected && exported.body.digest === hash(expected));
  writeFileSync(join(out, `${suffix}.checked-bank.csv`), exported.body.csv);
  report.artifacts.push({ file: `${suffix}.checked-bank.csv`, sha256: exported.body.digest, originalSha256: hash(csv), review: "Simulated human decision via real bank review/export API" }); save();
}

try {
  writeJson(join(out, "Austin-Phase1-Workflows.json"), pack);
  for (const [index, name] of ["Expected-Bills.json", "Payment-References.json"].entries()) writeJson(join(out, name), { version: 1, bundle: pack.bundle, recipes: [pack.recipes[index]] });
  check("Deliverable includes only procedure fields and no machine bindings", !JSON.stringify(pack).includes("/Users/") && pack.recipes.every(r => r.schedule === null && r.siteNotes === null && r.allowedOrigins.length === 0));
  let officeA = await boot("office-a");
  check("Unauthenticated import rejected", (await api(officeA, "POST", "/api/workflow-packs/import", pack, false)).status === 401);
  check("First office starts empty", (await recipes(officeA)).length === 0);
  const installed = await api(officeA, "POST", "/api/workflow-packs/import", JSON.parse(readFileSync(join(out, "Austin-Phase1-Workflows.json"), "utf8")));
  check("Actual deliverable imports successfully", installed.status === 200, installed.body.error);
  check("Imported procedures survive without field loss", JSON.stringify(plans(installed.body.recipes)) === JSON.stringify(plans(pack.recipes)));
  check("Import grants no approval or recurrence", installed.body.recipes.every(r => r.status === "shadow" && r.planApprovedAt === null && r.attachment === null && r.submitAcknowledgedAt === null && r.schedule === null));
  const beforeRepeat = readFileSync(join(officeA.data, "recipes.json"));
  check("Repeated import succeeds", (await api(officeA, "POST", "/api/workflow-packs/import", pack)).status === 200);
  check("Repeated import preserves exact saved bytes", beforeRepeat.equals(readFileSync(join(officeA.data, "recipes.json"))));
  const malformed = structuredClone(pack); malformed.recipes[1].steps = [];
  check("Malformed later job rejects whole import", (await api(officeA, "POST", "/api/workflow-packs/import", malformed)).status === 400);
  const conflicting = structuredClone(pack); conflicting.recipes[0].description += " conflicting edit";
  check("Conflicting procedure rejected", (await api(officeA, "POST", "/api/workflow-packs/import", conflicting)).status === 409);
  check("Failed imports preserve existing office", beforeRepeat.equals(readFileSync(join(officeA.data, "recipes.json"))));
  for (const recipe of await recipes(officeA)) {
    check(`${recipe.id}: unapproved run blocked`, (await api(officeA, "POST", `/api/recipes/${recipe.id}/prepare`, { requestId: randomUUID(), expectedRevision: recipe.revision })).status === 409);
    await approve(officeA, recipe);
  }
  const fixtureA = await bindFixtures(officeA, "A");
  if (live) {
    const status = (await api(officeA, "GET", "/api/hermes")).body;
    report.engine = { version: status.cli?.versionText?.split("\n")[0], provider: status.model?.provider, model: status.model?.model }; save();
    check("Real Hermes and connected model are available", status.cli?.compatible && status.model?.attached);
    verifyBills(structured(await run(officeA, pack.recipes[0].id, "A-bills"), "bill-review"), fixtureA.bills.sourceReference);
    verifyBank(structured(await run(officeA, pack.recipes[1].id, "A-bank"), "bank-reference-review"), fixtureA.bank.sourceReference, fixtureA.bank.batch);
  }
  await reviewBank(officeA, fixtureA, "A");
  const exportedA = await api(officeA, "GET", "/api/workflow-packs/export");
  check("Export contains both tested procedures", exportedA.status === 200 && JSON.stringify(plans(exportedA.body.recipes)) === JSON.stringify(plans(pack.recipes)));
  writeJson(join(out, "Office-A-Export.json"), exportedA.body);
  await stop(officeA);

  let officeB = await boot("office-b");
  check("Second office has no copied jobs or bank state", (await recipes(officeB)).length === 0 && (await api(officeB, "GET", "/api/bank-reference")).body.batches.length === 0);
  const restored = await api(officeB, "POST", "/api/workflow-packs/import", JSON.parse(readFileSync(join(out, "Office-A-Export.json"), "utf8")));
  check("Export file imports into clean second office", restored.status === 200 && JSON.stringify(plans(restored.body.recipes)) === JSON.stringify(plans(pack.recipes)), restored.body.error);
  check("Source approval does not travel", restored.body.recipes.every(r => r.status === "shadow" && r.planApprovedAt === null && r.approvedRevision === null && r.attachment === null));
  check("Source office files do not travel in export", !existsSync(join(officeB.data, "vault/workflow-inputs/expected-bills.json")));
  for (const recipe of await recipes(officeB)) await approve(officeB, recipe);
  if (live) {
    for (const [index, name] of ["bills", "bank"].entries()) {
      const result = await run(officeB, pack.recipes[index].id, `B-missing-${name}`);
      check(`Missing ${name} source produces a hold`, result.status === "awaiting-approval" && result.approvalRequests.length > 0);
    }
  }
  const fixtureB = await bindFixtures(officeB, "B");
  if (live) {
    verifyBills(structured(await run(officeB, pack.recipes[0].id, "B-bills"), "bill-review"), fixtureB.bills.sourceReference);
    verifyBank(structured(await run(officeB, pack.recipes[1].id, "B-bank"), "bank-reference-review"), fixtureB.bank.sourceReference, fixtureB.bank.batch);
  }
  await reviewBank(officeB, fixtureB, "B");
  if (live) {
    const partial = structuredClone(fixtureB.bills);
    partial.sourceReference = `SYNTHETIC-PARTIAL-${randomUUID().slice(0, 8)}`;
    partial.coverage.complete = false; partial.coverage.failedSources = ["fixture-admin@example.invalid: page 2 failed"];
    writeJson(join(fixtureB.inputDir, "expected-bills.json"), partial);
    verifyBills(structured(await run(officeB, pack.recipes[0].id, "B-partial-bills"), "bill-review"), partial.sourceReference, false);
    writeJson(join(fixtureB.inputDir, "expected-bills.json"), fixtureB.bills);
  }
  const snapshot = await recipes(officeB);
  const exportedB = await api(officeB, "GET", "/api/workflow-packs/export");
  writeJson(join(out, "Office-B-Reexport.json"), exportedB.body);
  check("Re-export preserves the original procedures", JSON.stringify(plans(exportedB.body.recipes)) === JSON.stringify(plans(pack.recipes)));
  check("Re-import preserves the second office's own approval", (await api(officeB, "POST", "/api/workflow-packs/import", exportedB.body)).status === 200 && JSON.stringify(await recipes(officeB)) === JSON.stringify(snapshot));
  const runCount = (await api(officeB, "GET", "/api/job-runs")).body.runs.length;
  await stop(officeB); officeB = await boot("office-b-restarted", officeB);
  check("Restart preserves imported jobs and local approvals", JSON.stringify(await recipes(officeB)) === JSON.stringify(snapshot));
  check("Restart preserves completed run receipts", (await api(officeB, "GET", "/api/job-runs")).body.runs.length === runCount);
  check("Restart preserves verified bank artifact", (await api(officeB, "POST", `/api/bank-reference/${fixtureB.record.id}/export`, {})).body.digest === hash(csv.replace("Alex Tenant,,preserve", "Alex Tenant,00127,preserve")));
  check("All jobs remain without recurring schedules", (await recipes(officeB)).every(r => r.schedule === null));
  check("Original fixture is byte-for-byte unchanged", readFileSync(join(source, "fixtures/bank-source.csv"), "utf8") === csv);
  report.completed = true;
} catch (error) {
  report.completed = false; report.error = error instanceof Error ? error.message : String(error);
  console.error(report.error); process.exitCode = 1;
} finally {
  for (const office of offices) await stop(office);
  if (!report.completed) for (const office of offices) writeFileSync(join(out, `${office.name}.server.log`), office.logs);
  report.finishedAt = new Date().toISOString(); save();
  console.log(`Evidence: ${out}`);
}
