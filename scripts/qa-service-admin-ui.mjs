#!/usr/bin/env node
// Disposable manual UI check. Never reads the operator's configuration or keys.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServiceAdminPasswordVerifier } from "../server/service-admin.ts";

const out = resolve("outputs/realbud-service-administration-2026-09-15");
await mkdir(out, { recursive: true });
const data = await mkdtemp(join(tmpdir(), "realbud-service-admin-ui-"));
let child, closing = false, timer;
async function close() {
  if (closing) return;
  closing = true; clearTimeout(timer);
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = once(child, "exit"); child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 5000);
    await stopped; clearTimeout(force);
  }
  await rm(data, { recursive: true, force: true });
  await writeFile(join(out, "ui-cleanup.json"), JSON.stringify({ stoppedAt: new Date().toISOString(), temporaryDataRemoved: true, liveAccountsUsed: false }));
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void close(); });
try {
  await writeFile(join(data, "config.json"), JSON.stringify({ profile: { name: "QA Staff" }, instances: { fixture: { driver: "not-a-real-driver" } } }));
  await writeFile(join(data, "service-admin.json"), JSON.stringify({ version: 1,
    passwordVerifier: await createServiceAdminPasswordVerifier("Synthetic-admin-window-2026!") }), { mode: 0o600 });
  const socket = createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--experimental-strip-types", "server/index.ts"], { cwd: process.cwd(), env: {
    PATH: process.env.PATH || "", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: data, USERPROFILE: data, REALBUD_DATA_DIR: data, REALBUD_HERMES_HOME: join(data, "hermes"), HERMES_HOME: join(data, "hermes"),
    OMB_PORT: String(port), OMB_STATIC_DIR: resolve("dist"), REALBUD_MANAGED_SERVICE: "1", REALBUD_SERVICE_ENTITLEMENT_REQUIRED: "1",
  }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.resume(); child.stderr.resume();
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error("UI service exited.");
    if (await fetch(base + "/api/health").then(r => r.ok, () => false)) break;
    if (attempt === 149) throw new Error("UI startup timed out.");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await writeFile(join(out, "ui-rig.json"), JSON.stringify({ base, data, startedAt: new Date().toISOString(), realCredentials: false, installedApplication: false }, null, 2));
  console.log(`Disposable administrator UI: ${base}/#you-service-admin`);
  timer = setTimeout(() => { void close(); }, 20 * 60_000);
  await once(child, "exit");
} finally { await close(); }
