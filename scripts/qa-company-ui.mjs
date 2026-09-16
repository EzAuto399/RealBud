#!/usr/bin/env node
// Disposable source-UI rehearsal. No personal data or live services. Stop with
// Ctrl-C; a bounded lifetime also stops the owned server and private PG cluster.
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { createServiceAdminPasswordVerifier } from "../server/service-admin.ts";
import { startCompanyPostgresFixture } from "../server/company/testing-postgres.ts";

const ownedHost = process.argv.includes("--owned-host");
const pgBin = process.env.REALBUD_TEST_POSTGRES_BIN || "/opt/homebrew/opt/postgresql@16/bin";
const out = resolve(ownedHost ? "outputs/realbud-host-orchestration-2026-09-14/ui" : "outputs/realbud-core-implementation-2026-09-14/ui");
await mkdir(out, { recursive: true });
const data = await mkdtemp(join(tmpdir(), "realbud-company-ui-"));
let fixture, child, closing = false, timer;
async function close() {
  if (closing) return;
  closing = true; clearTimeout(timer);
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = once(child, "exit"); child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 5000);
    await stopped; clearTimeout(force);
  }
  if (fixture) await fixture.stop();
  if (ownedHost) {
    const ownedData = join(data, "company-installation", "postgres", "data");
    try {
      await readFile(join(ownedData, "postmaster.pid"), "utf8");
      await promisify(execFile)(join(pgBin, "pg_ctl"), ["-D", ownedData, "-m", "fast", "-w", "-t", "5", "stop"], { timeout: 7000 });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  await rm(data, { recursive: true, force: true });
  await writeFile(join(out, "rig-cleanup.json"), JSON.stringify({ stoppedAt: new Date().toISOString(), isolatedDataRemoved: true, liveServicesUsed: false }, null, 2) + "\n");
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void close(); });
try {
  await mkdir(join(data, "hermes"), { mode: 0o700 });
  await writeFile(join(data, "config.json"), JSON.stringify({ profile: { name: "QA Reviewer" }, instances: { fixture: { driver: "not-a-real-driver" } } }), { mode: 0o600 });
  await writeFile(join(data, "service-admin.json"), JSON.stringify({ version: 1,
    passwordVerifier: await createServiceAdminPasswordVerifier("Synthetic-UI-only-2026") }), { mode: 0o600 });
  if (!ownedHost) fixture = await startCompanyPostgresFixture({ outputDirectory: out, postgresBinDirectory: pgBin });
  const socket = createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { PATH: process.env.PATH || "", HOME: data, USERPROFILE: data, TMPDIR: tmpdir(),
    REALBUD_DATA_DIR: data, REALBUD_HERMES_HOME: join(data, "hermes"), HERMES_HOME: join(data, "hermes"),
    OMB_PORT: String(port), OMB_STATIC_DIR: resolve("dist"),
    REALBUD_MANAGED_SERVICE: "1", REALBUD_SERVICE_ENTITLEMENT_REQUIRED: "1",
    ...(ownedHost ? { REALBUD_COMPANY_HOST_PREVIEW: "1", REALBUD_COMPANY_POSTGRES_BIN: pgBin } : { REALBUD_COMPANY_DATABASE_URL: fixture.applicationUrl }) };
  child = spawn(process.execPath, ["--experimental-strip-types", "server/index.ts"], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.resume(); child.stderr.resume();
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error("UI fixture service exited.");
    if (await fetch(base + "/api/health").then(r => r.ok, () => false)) break;
    if (attempt === 149) throw new Error("UI fixture startup timed out.");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await writeFile(join(out, "rig.json"), JSON.stringify({ startedAt: new Date().toISOString(), base, sourceUi: true,
    companyStorage: ownedHost ? "fresh owned native host setup" : "isolated PostgreSQL fixture", managed: true, realCredentials: false, nativePackage: false }, null, 2) + "\n");
  console.log(`Synthetic RealBud UI ready at ${base}`);
  timer = setTimeout(() => { void close(); }, 30 * 60_000);
  await once(child, "exit");
} finally { await close(); }
