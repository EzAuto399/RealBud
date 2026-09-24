// Executed by the installed application's own Electron/Node on a clean CI
// Windows Server host. This does not certify Windows 11 or customer workflows.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { smokeInstalledWorker } from "./smoke-one-shot-worker.mjs";
assert.equal(process.platform, "win32"); assert.equal(process.arch, "x64");
const resources = resolve(process.argv[2]);
const receiptFile = resolve(process.argv[3]);
const checks = [];
for (const file of ["cua-driver.exe", "RealBud CUA.exe", "RealBud Worker.exe", "cua-driver-uia.exe", "cua-cursor-theme.exe", "cua_driver_sdk.dll", "cua-sdk/cua-sdk.mjs", "cua-sdk/native/cua_driver_sdk.dll", "cua-sdk/native/cua_driver_node_runtime.node", "server/index.js", "server/bootstrap.js", "server/hermes-pack.js", "server/hermes-profile-storage.js", "server/windows-file-privacy.js", "pack/property/SOUL.md", "pack/property/config.yaml", "pack/property/distribution.yaml", "pack/property/profile.yaml", "pack/property/skills/intake-properties/SKILL.md", "pack/property/skills/morning-arrears/SKILL.md", "ui/index.html", "RealBud Speech.exe"]) assert.ok(existsSync(join(resources, file)), `missing packaged ${file}`);
checks.push("Installed resources include native helpers, speech helper, SDK, server and UI");
// The installer runs smoke-company-bundle separately against these exact
// resources. That proof requires real fresh-profile startup and privacy, not
// this resource inventory or service health alone.
checks.push("Installed resources include private-profile provisioning code and shipped property safeguards");
const browser = join(resources, "browser");
const browserManifest = JSON.parse(readFileSync(join(browser, "runtime.json"), "utf8"));
assert.equal(browserManifest.version, "0.3.0");
assert.equal(browserManifest.platform, "win32"); assert.equal(browserManifest.arch, "x64");
assert.equal(createHash("sha256").update(readFileSync(join(browser, "bsk.exe"))).digest("hex"), browserManifest.sha256);
assert.equal(execFileSync(join(browser, "bsk.exe"), ["--version"], { encoding: "utf8", timeout: 10000, windowsHide: true }).trim(), "bsk 0.3.0");
checks.push("Installed BrowserSkill executable matches its manifest and runs at the pinned version");
const postgres = join(resources, "postgres");
const pgManifest = JSON.parse(readFileSync(join(postgres, "runtime.json"), "utf8"));
assert.equal(pgManifest.schema, 2); assert.equal(pgManifest.platform, "win32"); assert.equal(pgManifest.architecture, "x64");
for (const name of ["postgres.exe", "initdb.exe", "pg_ctl.exe"]) {
  const binary = join(postgres, "bin", name);
  const recorded = pgManifest.binaries.find(item => item.name === name);
  assert.ok(recorded, `missing PostgreSQL manifest entry: ${name}`);
  assert.equal(createHash("sha256").update(readFileSync(binary)).digest("hex"), recorded.sha256);
  assert.match(execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 10000, windowsHide: true }), /PostgreSQL\) 16\./);
}
assert.ok(existsSync(join(postgres, "share", "postgres.bki")));
checks.push("Installed PostgreSQL tools retain their hashes and load their Windows dependencies");
assert.match(execFileSync(join(resources, "cua-driver.exe"), ["--version"], { encoding: "utf8", timeout: 10000 }), /0\.19\.3/);
checks.push("Installed Windows Cua executable runs and reports the pinned version");
checks.push(...await smokeInstalledWorker(resources, process.execPath));

// Prove the speech helper launches and speaks NDJSON (or a structured error).
// Windows Server may lack speech packs / a mic — that still proves the binary.
{
  const speechExe = join(resources, "RealBud Speech.exe");
  const speechScratch = mkdtempSync(join(tmpdir(), "bud-speech-"));
  const stopFile = join(speechScratch, "stop");
  const finishFile = join(speechScratch, "finish");
  writeFileSync(stopFile, "stop");
  try {
    const probed = spawnSync(
      speechExe,
      ["--stop-file", stopFile, "--finish-file", finishFile],
      { encoding: "utf8", timeout: 8000, windowsHide: true },
    );
    assert.equal(probed.error, undefined, `speech helper spawn failed: ${probed.error}`);
    const out = `${probed.stdout || ""}${probed.stderr || ""}`.trim();
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let protocolOk = probed.status === 0 && lines.length === 0;
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.error === "string" || typeof parsed.text === "string") {
          protocolOk = true;
          break;
        }
      } catch {
        /* ignore non-JSON */
      }
    }
    assert.ok(protocolOk, `speech helper protocol miss: status=${probed.status} out=${out}`);
    checks.push("Installed RealBud Speech.exe launches and speaks the NDJSON protocol (or exits cleanly)");
  } finally {
    rmSync(speechScratch, { recursive: true, force: true });
  }
}
const scratch = mkdtempSync(join(tmpdir(), "bud-win-smoke-"));
let host, driver;
try {
  const db = new DatabaseSync(join(scratch, "proof.sqlite")); db.exec("CREATE TABLE proof (value TEXT); INSERT INTO proof VALUES ('persisted')"); db.close();
  const reopened = new DatabaseSync(join(scratch, "proof.sqlite")); assert.equal(reopened.prepare("SELECT value FROM proof").get().value, "persisted"); reopened.close();
  checks.push("Installed Electron runtime supports durable SQLite");
  process.env.OPENMAUSBOT_CUA_SDK_LIBRARY = join(resources, "cua-sdk/native/cua_driver_sdk.dll");
  const sdk = await import(pathToFileURL(join(resources, "cua-sdk/cua-sdk.mjs")).href);
  assert.equal(typeof sdk.CuaDriver.connect, "function");
  // Import the installed GUI's exact launcher factory, never a checkout copy or
  // a direct executable shortcut that bypasses the existing-profile grant.
  const launcherModule = join(resources, "app.asar", "electron", "cua-launcher.mjs");
  assert.ok(existsSync(launcherModule), "missing installed CUA launcher module");
  const { createGrantedCuaHost } = await import(pathToFileURL(launcherModule).href);
  const generations = new Set();
  for (let round = 0; round < 2; round++) {
    host = createGrantedCuaHost(sdk, join(resources, "cua-driver.exe"), { userData: scratch });
    const connection = await host.start();
    assert.ok(!generations.has(connection.generation), "a restarted host reused its connection generation");
    generations.add(connection.generation);
    driver = sdk.CuaDriver.connect(connection.socketPath);
    const tools = JSON.parse(await driver.listToolsJson());
    const names = (Array.isArray(tools) ? tools : tools.tools).map(tool => tool.name);
    for (const name of ["get_browser_state", "get_window_state", "click", "end_session"]) assert.ok(names.includes(name), `missing ${name}`);
    await host.stop();
    assert.equal(host.connection(), undefined, "stopped host still publishes a connection");
    driver.uniffiDestroy(); driver = null; host.uniffiDestroy(); host = null;
  }
  checks.push("Installed GUI grant launcher starts the native SDK host twice and exposes browser/native control tools");
  checks.push("Each granted host stops and clears its connection before the next generation starts");
  mkdirSync(dirname(receiptFile), { recursive: true });
  writeFileSync(receiptFile, JSON.stringify({ passed: true, generatedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, electron: process.versions.electron, node: process.versions.node, sourceRevision: process.env.REALBUD_BUILD_SHA, checks, notProven: ["Windows 11", "customer x64 PC", "login and MFA", "browser or native UI actions", "Hermes install or model login", "PostgreSQL office provisioning or backup/restore", "GUI or update and human takeover", "live microphone dictation quality"] }, null, 2));
  console.log(checks.join("\n"));
} finally { if (host) await host.stop().catch(() => {}); driver?.uniffiDestroy?.(); host?.uniffiDestroy?.(); rmSync(scratch, { recursive: true, force: true }); }
