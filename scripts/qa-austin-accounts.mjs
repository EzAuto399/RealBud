#!/usr/bin/env node
// Current-source HTTP pack/job QA with synthetic accounts fixtures.
// --live uses a disposable copy of the existing RealBud profile login and the
// unchanged selected upstream executable. Never runs two workers concurrently.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const live = process.argv.includes("--live");
const argument = name => { const i = process.argv.indexOf(name); if (i < 0) return null; assert.ok(process.argv[i + 1] && !process.argv[i + 1].startsWith("--"), `${name} requires a value`); return process.argv[i + 1]; };
const out = resolve(argument("--out") ?? join(root, "outputs/austin-accounts-workflows-2026-09-13/qa", new Date().toISOString().replaceAll(/[:.]/g, "-")));
assert.ok(out.startsWith(join(root, "outputs/austin-accounts-workflows-2026-09-13/qa") + sep), "Evidence stays in the owned QA directory.");
assert.ok(!existsSync(out), "Choose a new directory; existing evidence is preserved.");
assert.ok(Number(process.versions.node.split(".")[0]) >= 24, "Use Node 24 or later.");
const packPath = join(root, "pack/workflows/austin-accounts/workflows.json");
const fixtureRoot = join(root, "outputs/austin-accounts-workflows-2026-09-13/fixtures");
const pack = JSON.parse(readFileSync(packPath, "utf8"));
const manifest = JSON.parse(readFileSync(join(fixtureRoot, "manifest.json"), "utf8"));
const selectedCases = manifest.cases.filter(c => (!argument("--case") || c.id === argument("--case")) && (!argument("--workflow") || argument("--workflow").split(",").includes(c.workflowId)));
assert.ok(selectedCases.length > 0, "At least one declared case must be selected.");
mkdirSync(out, { recursive: true, mode: 0o700 });
const scratch = mkdtempSync(join(tmpdir(), "realbud-accounts-qa-")); chmodSync(scratch, 0o700);
const engineSource = process.env.REALBUD_HERMES_HOME || join(homedir(), ".realbud/hermes");
const engineHome = join(scratch, "hermes");
const qaHome = join(scratch, "home"); mkdirSync(qaHome, { mode: 0o700 });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const json = (path, value) => writeFileSync(path, sanitize(JSON.stringify(value, null, 2)) + "\n", { mode: 0o600 });
const walk = path => !existsSync(path) ? [] : readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(path, entry.name)) : entry.isFile() ? [join(path, entry.name)] : []);
const hashes = files => Object.fromEntries(files.sort().map(file => [relative(root, file), hash(readFileSync(file))]));
const inputsBefore = hashes([packPath, ...walk(fixtureRoot), ...walk(join(root, "pack/workflows/austin-accounts/contracts")), ...walk(join(root, "pack/workflows/austin-accounts/support"))]);
const protectedPaths = ["recipes.json", "job-runs.json", "desk.json", "config.json"].map(name => join(homedir(), ".realbud", name)).concat(["realbud-runtime.json", "profiles/property/config.yaml", "profiles/property/.env", "profiles/property/auth.json"].map(name => join(engineSource, name))).filter(existsSync);
const protectedBefore = new Map(protectedPaths.map(path => [path, hash(readFileSync(path))]));
const secrets = new Set();
const sanitize = value => { let s = String(value); for (const secret of secrets) if (secret.length >= 8) s = s.replaceAll(secret, "[redacted]"); return s.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{12,})\b/g, "[redacted]"); };
const report = { startedAt: new Date().toISOString(), live, node: process.version, platform: process.platform,
  pack: { path: packPath, sha256: hash(readFileSync(packPath)), revision: pack.bundle?.revision, recipeHashes: Object.fromEntries(pack.recipes.map(recipe => [recipe.id, hash(JSON.stringify(recipe))])) },
  layer: "Current-source HTTP import and immutable Prepare job executor; real model only when live=true; synthetic files; no installed UI or customer/Windows acceptance.",
  scope: "Manual file-only preparation in two disposable offices. No connected mailbox, browser, ANZ, REI, outgoing message or schedule activation.",
  checks: [], runs: [], fixtureHashes: inputsBefore,
  source: { head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), dirtyEntryCount: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim().split("\n").length,
    hashes: hashes([...walk(join(root, "server")), ...walk(join(root, "shared")), ...walk(join(root, "pack/property")), fileURLToPath(import.meta.url)]) },
  limitations: ["The host validates shape, bound source identity and item coverage and derives the review queue. External fixture assertions assess model interpretation; neither layer applies business records.", "Native installed UI, real Windows workstation, phone delivery and actual office accounts are not exercised.", "File-tool capability and prepare-only policy are used; this is not an OS filesystem-containment penetration test.", "No recurring schedule is enabled and no always-on or multi-day office reliability claim is made."] };
const save = () => json(join(out, "qa-report.json"), report);
const check = (label, condition, detail) => { report.checks.push({ label, ok: Boolean(condition), ...(detail === undefined ? {} : { detail: sanitize(detail) }) }); save(); console.log(`${condition ? "PASS" : "FAIL"} ${label}`); return Boolean(condition); };
const requireCheck = (label, condition, detail) => { check(label, condition, detail); assert.ok(condition, label); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const planFields = ["id", "title", "description", "steps", "allowedOrigins", "evidence", "capabilities", "limits", "siteNotes", "schedule"];
const plans = rows => rows.map(row => Object.fromEntries(planFields.map(k => [k, row[k] ?? null]))).sort((a, b) => a.id.localeCompare(b.id));
const offices = []; let cli = null; let shuttingDown;

function copyCredential(source, target) {
  if (!existsSync(source)) return;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(source, target); chmodSync(target, 0o600);
  const body = readFileSync(source, "utf8");
  if (source.endsWith(".env")) for (const line of body.split("\n")) { const value = line.slice(line.indexOf("=") + 1).trim().replace(/^['"]|['"]$/g, ""); if (value.length >= 8) secrets.add(value); }
  else if (source.endsWith("auth.json")) { const collect = value => { if (Array.isArray(value)) value.forEach(collect); else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) { if (typeof child === "string" && /token|key|secret/i.test(key)) secrets.add(child); else collect(child); } }; collect(JSON.parse(body)); }
}

function preparePrivateEngine() {
  const selected = JSON.parse(readFileSync(join(engineSource, "realbud-runtime.json"), "utf8"));
  assert.ok(selected.version === 1 && /^[a-f0-9]{40}(?:-[a-f0-9]{12})?$/.test(selected.selected), "Existing verified runtime selection is required.");
  const overrideCli = argument("--hermes-cli");
  if (overrideCli) assert.ok(resolve(overrideCli).startsWith(join(engineSource, "runtimes") + sep) && overrideCli.endsWith("/hermes-agent/venv/bin/hermes"), "Candidate override must be a private managed stock runtime.");
  const executableRoot = overrideCli ? dirname(dirname(dirname(resolve(overrideCli)))) : join(engineSource, "runtimes", selected.selected, "hermes-agent");
  cli = join(executableRoot, "venv", process.platform === "win32" ? "Scripts/hermes.exe" : "bin/hermes");
  assert.ok(existsSync(cli), "Selected upstream executable must exist; this test never installs it.");
  for (const name of ["config.yaml", "SOUL.md", "distribution.yaml", "profile.yaml", ".env", "auth.json"]) copyCredential(join(engineSource, "profiles/property", name), join(engineHome, "profiles/property", name));
  // Only the configured product profile login travels into this temporary test.
  // Root auth remains empty, preventing fallback to a separate personal profile.
  json(join(engineHome, "auth.json"), { version: 1, providers: {}, credential_pool: {} });
  report.engine = { selectedRelease: executableRoot.split(sep).at(-2), runtimeOverride: Boolean(overrideCli), executableSha256: hash(readFileSync(cli)), profile: "property", configuredDiscovery: "HERMES_SAFE_MODE=1; no MCP/connector/computer endpoints configured", credentialHandling: "Ephemeral 0700 directory, 0600 profile files, removed on success/failure/signal" };
}

async function boot(name, existing) {
  const data = existing?.data ?? join(scratch, name); mkdirSync(data, { recursive: true, mode: 0o700 });
  assert.ok(data.startsWith(scratch + sep) && !data.startsWith(join(homedir(), ".realbud") + sep));
  const socket = createServer(); await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const office = { name, data, base: `http://127.0.0.1:${port}`, token: "", logs: "" };
  const env = { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`, HOME: qaHome, USERPROFILE: qaHome,
    REALBUD_DATA_DIR: data, OMB_PORT: String(port), OMB_STATIC_DIR: join(root, "dist"), OMB_USER_DATA: join(data, "desktop"),
    HERMES_SAFE_MODE: "1", ...(live ? { REALBUD_HERMES_HOME: engineHome, HERMES_HOME: engineHome, REALBUD_HERMES_CLI: cli } : {}) };
  office.child = spawn(process.execPath, [join(root, "server/index.ts")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] }); offices.push(office);
  office.child.on("error", error => { office.logs += sanitize(error.message); });
  for (const stream of [office.child.stdout, office.child.stderr]) stream.on("data", chunk => { office.logs = (office.logs + sanitize(chunk)).slice(-120_000); });
  const deadline = Date.now() + 35_000;
  while (true) { if (office.child.exitCode !== null) throw new Error(`${name} service exited: ${office.logs}`); if (await fetch(office.base + "/api/health").then(r => r.ok, () => false)) break; if (Date.now() > deadline) throw new Error(`${name} service timeout: ${office.logs}`); await delay(100); }
  office.token = (await api(office, "GET", "/api/session")).body.token;
  requireCheck(`${name}: loopback service issued a session`, Boolean(office.token)); return office;
}
async function stop(office) {
  const child = office.child; if (!child || child.exitCode !== null || child.signalCode !== null) return;
  // Prepare CLI children are detached from the server's process group. Reap
  // only descendants of this owned server before deleting its private login.
  if (process.platform !== "win32") {
    const rows = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n").map(row => row.trim().split(/\s+/).map(Number));
    const owned = new Set([child.pid]); let added = true;
    while (added) { added = false; for (const [pid, parent] of rows) if (owned.has(parent) && !owned.has(pid)) { owned.add(pid); added = true; } }
    for (const pid of [...owned].reverse()) if (pid !== child.pid) { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} } }
  }
  await new Promise(resolve => { const timer = setTimeout(() => child.kill("SIGKILL"), 5000); child.once("close", () => { clearTimeout(timer); resolve(); }); child.kill("SIGTERM"); });
}
async function cleanup() { if (shuttingDown) return shuttingDown; shuttingDown = (async () => { for (const office of offices) await stop(office); rmSync(scratch, { recursive: true, force: true }); })(); return shuttingDown; }
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { report.interrupted = signal; await cleanup(); report.finishedAt = new Date().toISOString(); save(); process.exit(130); });
async function api(office, method, path, body, authenticated = true) {
  const res = await fetch(office.base + path, { method, headers: { "content-type": "application/json", ...(authenticated && office.token ? { "x-realbud-session": office.token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(250_000) });
  return { status: res.status, body: await res.json() };
}
const recipes = async office => (await api(office, "GET", "/api/recipes")).body.recipes;
function fixturePath(path) { const resolved = resolve(manifest.casePathBase === "repository-root" ? root : fixtureRoot, path); assert.ok(resolved.startsWith(fixtureRoot + sep) || resolved.startsWith(join(root, "pack/workflows/austin-accounts") + sep), "Fixture source must stay in the owned fixture/pack tree."); return resolved; }
function targetPath(office, target) { const vault = join(office.data, "vault"), path = resolve(vault, target); assert.ok(path.startsWith(vault + sep), "Binding must remain inside the disposable vault."); return path; }
async function bindCase(office, entry) {
  // Every case is a separate supplied snapshot; leftovers must not satisfy a
  // later missing-attachment case. Only this disposable workroom is cleared.
  for (const name of ["workflow-inputs", "workflow-support"]) rmSync(targetPath(office, name), { recursive: true, force: true });
  const input = JSON.parse(readFileSync(fixturePath(entry.inputFile), "utf8"));
  const nonce = `QA-${entry.id}-${randomUUID()}`; input.sourceReference = nonce;
  let bankRecord = null;
  if (entry.hostBankBatch === true && input.batch?.input) {
    const created = await api(office, "POST", "/api/bank-reference", input.batch.input);
    requireCheck(`${entry.id}: actual host creates immutable bank batch`, created.status === 200, created.body.error);
    bankRecord = created.body; input.batchId = bankRecord.id; input.batchRevision = bankRecord.revision; input.batch = bankRecord.value.batch;
    entry.expected["hostValidation.batchId"] = bankRecord.id;
    entry.expected["hostValidation.batchRevision"] = bankRecord.revision;
  }
  const target = targetPath(office, entry.bindingPath); mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); json(target, input);
  const bound = [target];
  for (const file of entry.files ?? []) { const source = fixturePath(file.source), dest = targetPath(office, file.target); if (file.sha256) assert.equal(hash(readFileSync(source)), file.sha256, "Support file hash matches its declared source"); mkdirSync(dirname(dest), { recursive: true, mode: 0o700 }); copyFileSync(source, dest); chmodSync(dest, 0o600); bound.push(dest); }
  json(join(out, `${entry.id}.input.json`), input);
  return { input, nonce, bankRecord, bound, before: new Map(bound.map(path => [path, hash(readFileSync(path))])), vaultBefore: hashes(walk(join(office.data, "vault"))) };
}
// Validate only the JSON Schema vocabulary used by the checked-in contracts;
// unknown assertions fail closed instead of being silently ignored.
function schemaErrors(value, schema, path = "$", errors = []) {
  const supported = new Set(["$schema", "$id", "title", "description", "type", "const", "enum", "properties", "required", "additionalProperties", "items", "maxItems", "minItems", "minimum", "maximum", "minLength", "maxLength"]);
  for (const key of Object.keys(schema)) if (!supported.has(key)) errors.push(`${path}: unsupported schema keyword ${key}`);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (Object.hasOwn(schema, "const") && !same(value, schema.const)) errors.push(`${path}: constant mismatch`);
  if (schema.enum && !schema.enum.some(v => same(v, value))) errors.push(`${path}: enum mismatch`);
  const isType = type => type === "null" ? value === null : type === "array" ? Array.isArray(value) : type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : type === "integer" ? Number.isInteger(value) : typeof value === type;
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(isType)) { errors.push(`${path}: type mismatch`); return errors; }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: missing required field`);
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties ?? {}, key)) errors.push(`${path}.${key}: extra field`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(value, key)) schemaErrors(value[key], child, `${path}.${key}`, errors);
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: too many items`);
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: too few items`);
    if (schema.items) value.forEach((item, index) => schemaErrors(item, schema.items, `${path}[${index}]`, errors));
  }
  if (typeof value === "number" && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) errors.push(`${path}: numeric bound`);
  if (typeof value === "string" && ((schema.minLength !== undefined && value.length < schema.minLength) || (schema.maxLength !== undefined && value.length > schema.maxLength))) errors.push(`${path}: string length bound`);
  return errors;
}
function approvalScopeIssues(requests) {
  const prohibited = /\b(?:send(?:ing)?|payments?|pay|PMS|portal (?:update|submission)|submit|archiv\w*|labell?\w*|statutory|notice)\b/i;
  const suggestsEnabling = /(?:requires?|needs?|with|after|subject to)[^;.!?]{0,70}(?:approv\w*|authori[sz]\w*|permission)|(?:approv\w*|authori[sz]\w*|permit\w*|allow\w*)[^;.!?]{0,80}(?:send\w*|pay\w*|PMS|submit\w*|archiv\w*|labell?\w*|notice)/i;
  return requests.flatMap((text, index) => text.split(/[;.!?\n]+/).filter(clause => prohibited.test(clause) && suggestsEnabling.test(clause) && !/\b(?:cannot|can not|must not|never|does not|do not|will not|not permitted|not authori[sz]ed)\b/i.test(clause)).map(clause => ({ index, clause: clause.trim(), review: "Potential wording that makes prohibited action approval-able; requires human review if ambiguous." })));
}
function verifyOutput(entry, value, run, nonce) {
  const expected = entry.expected;
  const field = (object, key) => key.split(".").reduce((object, part) => object?.[part], object);
  const schema = JSON.parse(readFileSync(join(root, "pack/workflows/austin-accounts/contracts", `${expected.kind}.schema.json`), "utf8"));
  const errors = schemaErrors(value, schema);
  check(`${entry.id}: checked-in typed contract`, errors.length === 0, errors.join("; "));
  check(`${entry.id}: exact output kind`, value.kind === expected.kind);
  check(`${entry.id}: unpredictable source reference read`, value.sourceReference === nonce);
  if (expected.status !== undefined) check(`${entry.id}: business status`, value.status === expected.status, `Expected ${expected.status}; received ${value.status}`);
  if (expected.coverageComplete !== undefined) check(`${entry.id}: coverage honesty`, value.coverageComplete === expected.coverageComplete);
  check(`${entry.id}: no external action recorded`, Array.isArray(value.actionsPerformed) && value.actionsPerformed.length === 0);
  for (const [key, wanted] of Object.entries(expected)) if (key.includes(".") || ["skillSource", "originalDigest"].includes(key)) check(`${entry.id}: ${key}`, JSON.stringify(field(value, key)) === JSON.stringify(wanted), `Expected ${JSON.stringify(wanted)}; received ${JSON.stringify(field(value, key))}`);
  const items = value[expected.itemArray];
  requireCheck(`${entry.id}: declared item array exists`, Array.isArray(items));
  check(`${entry.id}: exact item count`, items.length === expected.itemCount, `Expected ${expected.itemCount}; received ${items.length}`);
  const ids = items.map(item => item[expected.itemIdKey]);
  check(`${entry.id}: unique item identities`, ids.every(id => typeof id === "string" || Number.isInteger(id)) && new Set(ids).size === ids.length);
  for (const [id, fields] of Object.entries(expected.items ?? {})) {
    const found = items.find(item => String(item[expected.itemIdKey]) === id);
    check(`${entry.id}: ${id} present`, Boolean(found));
    if (found) for (const [key, wanted] of Object.entries(fields)) check(`${entry.id}: ${id}.${key}`, JSON.stringify(field(found, key)) === JSON.stringify(wanted), `Expected ${JSON.stringify(wanted)}; received ${JSON.stringify(field(found, key))}`);
  }
  for (const [key, actualKey] of [["mustIncludeSourceMessageIds", "sourceMessageIds"], ["requiredSourceIds", "sourceIds"], ["requiredFlags", "flags"]]) for (const [id, wanted] of Object.entries(expected[key] ?? {})) {
    const found = items.find(item => String(item[expected.itemIdKey]) === id);
    check(`${entry.id}: ${id} retains required ${actualKey}`, Array.isArray(found?.[actualKey]) && wanted.every(value => found[actualKey].includes(value)));
  }
  if (value.kind === "accounts-inbox-triage") {
    const queue = run.approvalRequests.join("\n");
    for (const item of value.threads) {
      const actionable = ["urgent-review", "reply-review", "action-review", "hold"].includes(item.disposition);
      if (item.threadId === "SYN-T013") check(`${entry.id}: first missed-payment question keeps proposed normal priority`, item.disposition === "action-review" && item.priority === "normal");
      if (actionable) check(`${entry.id}: ${item.threadId} has accountable review handoff`, queue.includes(`[${item.threadId}] ${item.owner}:`));
      if (["reference", "noise"].includes(item.disposition)) check(`${entry.id}: ${item.threadId} creates no unnecessary follow-up`, !queue.includes(`[${item.threadId}]`) && item.missingFacts.length === 0);
    }
  }
  const holds = value.holds;
  check(`${entry.id}: typed holds present`, Array.isArray(holds));
  if (expected.status === "blocked") check(`${entry.id}: blocked input has a named actionable hold`, run.status === "awaiting-approval" && run.approvalRequests.length > 0 && Array.isArray(holds) && holds.some(hold => typeof hold.itemId === "string" && hold.itemId && typeof hold.reason === "string" && hold.reason.trim()));
  for (const id of expected.requiredHolds ?? []) check(`${entry.id}: required hold ${id}`, Array.isArray(holds) && holds.some(hold => hold.itemId === id && typeof hold.reason === "string" && hold.reason.trim()));
  if (expected.requiredHolds?.length) check(`${entry.id}: holds remain awaiting human review`, run.status === "awaiting-approval" && run.approvalRequests.length > 0);
}
async function runCase(office, entry) {
  entry = structuredClone(entry); // Runtime host identity never mutates the frozen oracle file.
  const checkStart = report.checks.length;
  const binding = await bindCase(office, entry);
  const recipe = (await recipes(office)).find(row => row.id === entry.workflowId);
  const request = { expectedRevision: recipe.revision, requestId: randomUUID() };
  console.log(`RUN  ${entry.id} using real imported Prepare job`);
  const started = Date.now();
  const firstPromise = api(office, "POST", `/api/recipes/${recipe.id}/prepare`, request);
  await delay(350);
  const duplicate = await api(office, "POST", `/api/recipes/${recipe.id}/prepare`, request);
  const first = await firstPromise;
  requireCheck(`${entry.id}: Prepare route accepted`, first.status === 200, first.body.error);
  const run = first.body.run;
  // Capture only the synthetic final answer, while the disposable profile still
  // exists. Never query installed-office history or reasoning/tool payloads.
  if (!run.evidence.some(item => item.note.startsWith("Host preflight:"))) {
    const dbPath = join(engineHome, "profiles/property/state.db");
    if (existsSync(dbPath)) {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        // Diagnostic counts from this disposable synthetic profile only. Keep
        // reasoning, tool arguments and raw tool results out of QA receipts.
        const activity = db.prepare(`SELECT session_id, role, count(*) AS messages,
          sum(length(content)) AS contentCharacters, max(id) AS lastMessage
          FROM messages GROUP BY session_id, role ORDER BY max(id) DESC LIMIT 16`).all();
        json(join(out, `${entry.id}.worker-activity.json`), { syntheticOnly: true, activity });
        const answer = db.prepare("SELECT id, session_id, content FROM messages WHERE role = 'assistant' AND content LIKE ? ORDER BY id DESC LIMIT 1").get(`%${binding.nonce}%`);
        if (answer && typeof answer.content === "string") {
          json(join(out, `${entry.id}.upstream-final.json`), { scope: "Final answer from the disposable synthetic QA profile only", ...answer });
          try {
            const outer = JSON.parse(answer.content);
            const schema = JSON.parse(readFileSync(join(root, "pack/workflows/austin-accounts/contracts", `${entry.expected.kind}.schema.json`), "utf8"));
            const candidates = (outer.outputs ?? []).flatMap(text => { try { const parsed = JSON.parse(text); return parsed?.kind === entry.expected.kind ? [parsed] : []; } catch { return []; } });
            json(join(out, `${entry.id}.upstream-schema.json`), { candidates: candidates.length, errors: candidates.map(value => schemaErrors(value, schema)) });
          } catch { /* Retain the redacted final answer for malformed diagnostics. */ }
        }
      } finally { db.close(); }
    }
  }
  const runReport = { caseId: entry.id, workflowId: entry.workflowId, office: office.name, elapsedMs: Date.now() - started, requestId: request.requestId, receiptPath: join(out, `${entry.id}.run.json`), pass: false, executionLayer: run.evidence.some(item => item.note.startsWith("Host preflight:")) ? "host-preflight-without-model" : "real-model", run };
  report.runs.push(runReport); save();
  json(join(out, `${entry.id}.run.json`), run);
  const outputs = run.evidence.filter(item => item.kind === "output").map(item => item.note);
  writeFileSync(join(out, `${entry.id}.output.md`), sanitize(outputs.join("\n\n")) + "\n", { mode: 0o600 });
  check(`${entry.id}: concurrent duplicate reuses same run`, duplicate.body.reused === true && duplicate.body.run?.id === run.id);
  check(`${entry.id}: immutable imported job is the executed spec`, run.jobRevision === recipe.revision && run.spec.title === recipe.title && JSON.stringify(run.spec.steps) === JSON.stringify(recipe.steps));
  check(`${entry.id}: useful receipt or explicit hold`, ["completed", "awaiting-approval"].includes(run.status), run.detail);
  const scopeIssues = approvalScopeIssues(run.approvalRequests ?? []);
  check(`${entry.id}: approval requests stay within permitted preparation scope`, scopeIssues.length === 0, JSON.stringify(scopeIssues));
  runReport.approvalScopeIssues = scopeIssues;
  check(`${entry.id}: all bound source files unchanged`, binding.bound.every(path => existsSync(path) && hash(readFileSync(path)) === binding.before.get(path)));
  check(`${entry.id}: no vault file created, deleted or edited`, JSON.stringify(hashes(walk(join(office.data, "vault")))) === JSON.stringify(binding.vaultBefore));
  const typed = outputs.flatMap(output => { try { return [JSON.parse(output.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""))]; } catch { return []; } }).filter(value => value && value.kind === entry.expected.kind);
  check(`${entry.id}: exactly one complete typed output`, typed.length === 1);
  if (typed.length === 1) {
    json(join(out, `${entry.id}.typed.json`), typed[0]); verifyOutput(entry, typed[0], run, binding.nonce);
    const key = entry.expected.itemIdKey, sourceItems = binding.input.threads ?? binding.input.documents ?? binding.input.register;
    if (Array.isArray(sourceItems)) check(`${entry.id}: source item order and identity preserved`, JSON.stringify(typed[0][entry.expected.itemArray]?.map(item => item[key])) === JSON.stringify(sourceItems.map(item => item[key])));
    if (binding.bankRecord) await verifyBankHost(office, entry, binding, typed[0]);
  }
  const replay = await api(office, "POST", `/api/recipes/${recipe.id}/prepare`, request);
  check(`${entry.id}: settled replay reuses identical persisted receipt`, replay.body.reused === true && JSON.stringify(replay.body.run) === JSON.stringify(run));
  runReport.pass = report.checks.slice(checkStart).every(check => check.ok); save();
  return run;
}

async function verifyBankHost(office, entry, binding, value) {
  const record = binding.bankRecord, batch = record.value.batch, endpoint = `/api/bank-reference/${record.id}`;
  check(`${entry.id}: model preserves original bank digest`, value.originalDigest === batch.originalDigest && value.hostValidation?.originalDigest === batch.originalDigest);
  check(`${entry.id}: model requires host review and does not claim application`, value.hostValidation?.required === true && value.hostValidation?.applied === false && value.hostValidation?.batchId === record.id && value.hostValidation?.batchRevision === record.revision);
  check(`${entry.id}: export blocked before synthetic reviewer decision`, (await api(office, "POST", endpoint + "/export", {})).status === 409);
  const original = await api(office, "POST", endpoint + "/original", {});
  check(`${entry.id}: original exact bytes and hash preserved`, original.body.csv === batch.input.csv && original.body.digest === hash(batch.input.csv));
  if (value.status !== "complete" || !report.checks.filter(check => check.label.startsWith(`${entry.id}:`)).every(check => check.ok)) return;
  const safe = value.rows.length === batch.rows.length && value.rows.every((row, index) => {
    const source = batch.rows[index];
    if (row.rowId !== source.id || row.sourceRow !== index + 1) return false;
    if (row.decision !== "assign") return ["hold", "keep"].includes(row.decision) && row.propertyId === null && row.proposedReference === null;
    const rule = batch.input.rules.find(rule => rule.propertyId === row.propertyId);
    return source.candidates.length === 1 && source.candidates[0] === row.propertyId && source.issues.length === 0 && rule?.reference === row.proposedReference && !source.reference && Number(source.amount) > 0;
  });
  requireCheck(`${entry.id}: proposal passes external exact-candidate safety check`, safe);
  const decisions = value.rows.map(row => ({ rowId: row.rowId, action: row.decision === "assign" ? "assign" : "keep", ...(row.decision === "assign" ? { propertyId: row.propertyId } : {}), reason: row.decision === "assign" ? "Synthetic reviewer confirms the approved exact source candidate" : "Synthetic reviewer keeps the source unchanged; unresolved item remains held for separate review" }));
  const request = { revision: record.revision, decisions };
  const reviewed = await api(office, "POST", endpoint + "/review", request);
  requireCheck(`${entry.id}: explicit synthetic reviewer bridge succeeds`, reviewed.status === 200, reviewed.body.error);
  check(`${entry.id}: stale repeat review rejected`, (await api(office, "POST", endpoint + "/review", request)).status === 409);
  const exported = await api(office, "POST", endpoint + "/export", {});
  requireCheck(`${entry.id}: host creates checked copy after review`, exported.status === 200 && exported.body.digest === hash(exported.body.csv));
  const { parseBankCsv } = await import("../server/bank-reference.ts");
  const before = parseBankCsv(batch.input.csv), after = parseBankCsv(exported.body.csv), referenceIndex = before[0].cells.indexOf(batch.input.columns.reference);
  let expectedCsv = batch.input.csv;
  for (let index = value.rows.length - 1; index >= 0; index--) if (value.rows[index].decision === "assign") {
    const [start, end] = before[index + 1].spans[referenceIndex], reference = value.rows[index].proposedReference;
    const cell = /[",\r\n]/.test(reference) ? `"${reference.replaceAll('"', '""')}"` : reference;
    expectedCsv = expectedCsv.slice(0, start) + cell + expectedCsv.slice(end);
  }
  check(`${entry.id}: only exact approved reference-cell bytes changed`, exported.body.csv === expectedCsv);
  check(`${entry.id}: row count, order, dates, amounts and all other cells preserved`, before.length === after.length && before.every((row, i) => row.cells.every((cell, col) => col === referenceIndex || cell === after[i].cells[col])));
  writeFileSync(join(out, `${entry.id}.checked-bank.csv`), exported.body.csv, { mode: 0o600 });
  json(join(out, `${entry.id}.host-review.json`), { proofLayer: "Real host processor with synthetic human review; QA explicitly bridges the proposal to review, not automatically wired product flow", originalDigest: batch.originalDigest, outputDigest: exported.body.digest, reviewRevision: reviewed.body.revision, changes: reviewed.body.value.result.changes });
}

try {
  if (live) preparePrivateEngine();
  requireCheck("Pack contains four on-demand file-only procedures", pack.recipes.length === 4 && pack.recipes.every(r => r.schedule === null && r.allowedOrigins.length === 0 && r.capabilities.every(c => ["read-files", "analyse", "draft"].includes(c))));
  let officeA = await boot("office-a");
  requireCheck("First office contains no saved jobs", (await recipes(officeA)).length === 0);
  requireCheck("Unauthenticated import refused", (await api(officeA, "POST", "/api/workflow-packs/import", pack, false)).status === 401);
  const imported = await api(officeA, "POST", "/api/workflow-packs/import", pack);
  requireCheck("Actual four-workflow pack imports", imported.status === 200, imported.body.error);
  requireCheck("Import preserves every procedure field", JSON.stringify(plans(imported.body.recipes)) === JSON.stringify(plans(pack.recipes)));
  requireCheck("Import conveys no approval, browser grant or schedule", imported.body.recipes.every(r => r.status === "shadow" && r.planApprovedAt === null && r.approvedRevision === null && r.attachment === null && r.schedule === null));
  const beforeRepeat = readFileSync(join(officeA.data, "recipes.json"));
  requireCheck("Repeat import succeeds", (await api(officeA, "POST", "/api/workflow-packs/import", pack)).status === 200);
  requireCheck("Repeat import preserves saved bytes", beforeRepeat.equals(readFileSync(join(officeA.data, "recipes.json"))));
  const malformed = structuredClone(pack); malformed.recipes.at(-1).steps = [];
  requireCheck("Malformed final recipe refuses whole import", (await api(officeA, "POST", "/api/workflow-packs/import", malformed)).status === 400);
  const conflict = structuredClone(pack); conflict.recipes[0].title += " changed";
  requireCheck("Conflicting restore refuses overwrite", (await api(officeA, "POST", "/api/workflow-packs/import", conflict)).status === 409);
  requireCheck("Failed imports preserve all jobs", beforeRepeat.equals(readFileSync(join(officeA.data, "recipes.json"))));
  for (const recipe of await recipes(officeA)) {
    requireCheck(`${recipe.id}: unapproved Prepare refused`, (await api(officeA, "POST", `/api/recipes/${recipe.id}/prepare`, { expectedRevision: recipe.revision, requestId: randomUUID() })).status === 409);
    requireCheck(`${recipe.id}: exact local plan approval`, (await api(officeA, "PATCH", `/api/recipes/${recipe.id}`, { expectedRevision: recipe.revision, planApproved: true })).status === 200);
  }
  for (const recipe of await recipes(officeA)) requireCheck(`${recipe.id}: stale revision refused`, (await api(officeA, "POST", `/api/recipes/${recipe.id}/prepare`, { expectedRevision: recipe.revision + 1, requestId: randomUUID() })).status === 409);
  if (live) {
    const status = (await api(officeA, "GET", "/api/hermes")).body;
    report.engine = { ...report.engine, version: status.cli?.versionText?.split("\n")[0], provider: status.model?.provider, model: status.model?.model }; save();
    requireCheck("Compatible worker and model credentials configured (not a live model response)", status.cli?.compatible && (status.model?.attached || status.model?.keyPresent), status.detail);
    for (const entry of selectedCases) { try { await runCase(officeA, entry); } catch (error) { check(`${entry.id}: case completes`, false, error.message); } }
  }
  const exported = await api(officeA, "GET", "/api/workflow-packs/export");
  requireCheck("Export preserves four complete procedures", exported.status === 200 && JSON.stringify(plans(exported.body.recipes)) === JSON.stringify(plans(pack.recipes)));
  json(join(out, "Office-A-Export.json"), exported.body);
  const sourceRuns = (await api(officeA, "GET", "/api/job-runs")).body.runs;
  const sourcePlans = await recipes(officeA);
  await stop(officeA); officeA = await boot("office-a-restarted", officeA);
  requireCheck("Restart preserves exact plans and approvals", JSON.stringify(await recipes(officeA)) === JSON.stringify(sourcePlans));
  requireCheck("Restart preserves complete persisted job outputs", JSON.stringify((await api(officeA, "GET", "/api/job-runs")).body.runs) === JSON.stringify(sourceRuns));
  await stop(officeA);
  const officeB = await boot("office-b");
  requireCheck("Second office begins empty", (await recipes(officeB)).length === 0);
  const restored = await api(officeB, "POST", "/api/workflow-packs/import", exported.body);
  requireCheck("Export imports into clean second office", restored.status === 200 && JSON.stringify(plans(restored.body.recipes)) === JSON.stringify(plans(pack.recipes)));
  requireCheck("First office approval does not travel", restored.body.recipes.every(r => r.status === "shadow" && r.planApprovedAt === null && r.approvedRevision === null && r.attachment === null));
  requireCheck("First office inputs and receipts do not travel", !existsSync(join(officeB.data, "vault/workflow-inputs")) && (await api(officeB, "GET", "/api/job-runs")).body.runs.length === 0);
  const exportedB = await api(officeB, "GET", "/api/workflow-packs/export"); json(join(out, "Office-B-Reexport.json"), exportedB.body);
  requireCheck("Second export retains exact procedures", JSON.stringify(plans(exportedB.body.recipes)) === JSON.stringify(plans(pack.recipes)));
  if (live && selectedCases.length) {
    const entry = selectedCases[0], recipe = (await recipes(officeB)).find(r => r.id === entry.workflowId);
    requireCheck("Fresh-office run still needs local approval", (await api(officeB, "POST", `/api/recipes/${recipe.id}/prepare`, { expectedRevision: recipe.revision, requestId: randomUUID() })).status === 409);
    await api(officeB, "PATCH", `/api/recipes/${recipe.id}`, { expectedRevision: recipe.revision, planApproved: true });
    await runCase(officeB, { ...entry, id: `fresh-office-${entry.id}` });
  }
  report.completed = true;
} catch (error) { report.completed = false; report.error = sanitize(error.message); console.error(report.error); }
finally {
  for (const office of offices) { await stop(office); writeFileSync(join(out, `${office.name}.server.log`), sanitize(office.logs), { mode: 0o600 }); }
  check("Original deliverable and fixtures unchanged", JSON.stringify(hashes(Object.keys(inputsBefore).map(path => join(root, path)))) === JSON.stringify(inputsBefore));
  report.productionFilesObservedUnchanged = [...protectedBefore].every(([path, digest]) => existsSync(path) && hash(readFileSync(path)) === digest);
  check("Protected production state observed unchanged", report.productionFilesObservedUnchanged, "Only hashes were compared; production file contents and credentials are not included.");
  await cleanup();
  check("Ephemeral credentials and test state removed", !existsSync(scratch));
  report.finishedAt = new Date().toISOString(); report.passed = report.completed && report.checks.every(check => check.ok); save();
  json(join(out, "results.json"), { overallStatus: report.passed ? "passed-within-declared-layer" : "failed-or-incomplete", live, layer: report.layer, reportPath: join(out, "qa-report.json"), startedAt: report.startedAt, finishedAt: report.finishedAt, model: report.engine?.model, provider: report.engine?.provider, cases: report.runs.map(({ run, ...item }) => ({ ...item, status: item.pass ? "pass" : "fail", model: report.engine?.model, runStatus: run.status, outputPath: join(out, `${item.caseId}.output.md`), typedPath: existsSync(join(out, `${item.caseId}.typed.json`)) ? join(out, `${item.caseId}.typed.json`) : null, failedAssertions: report.checks.filter(check => !check.ok && check.label.startsWith(`${item.caseId}:`)) })) });
  console.log(`Evidence: ${out}`); if (!report.passed) process.exitCode = 1;
}
