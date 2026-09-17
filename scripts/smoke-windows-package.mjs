// Executed by the installed application's own Electron/Node on a clean CI
// Windows Server host. This does not certify Windows 11 or customer workflows.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
assert.equal(process.platform, "win32"); assert.equal(process.arch, "x64");
const resources = resolve(process.argv[2]);
const receiptFile = resolve(process.argv[3]);
const checks = [];
for (const file of ["cua-driver.exe", "cua-driver-uia.exe", "cua-cursor-theme.exe", "cua_driver_sdk.dll", "cua-sdk/cua-sdk.mjs", "cua-sdk/native/cua_driver_sdk.dll", "cua-sdk/native/cua_driver_node_runtime.node", "server/index.js", "ui/index.html", "RealBud Speech.exe"]) assert.ok(existsSync(join(resources, file)), `missing packaged ${file}`);
checks.push("Installed resources include browser/native helpers, speech helper, SDK, server and UI");
assert.match(execFileSync(join(resources, "cua-driver.exe"), ["--version"], { encoding: "utf8", timeout: 10000 }), /0\.19\.3/);
checks.push("Installed Windows Cua executable runs and reports the pinned version");

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
  host = new sdk.EmbeddedCuaDriverHost(join(resources, "cua-driver.exe"), "com.realbud.app");
  const connection = await host.start();
  driver = sdk.CuaDriver.connect(connection.socketPath);
  const tools = JSON.parse(await driver.listToolsJson());
  const names = (Array.isArray(tools) ? tools : tools.tools).map(tool => tool.name);
  for (const name of ["get_browser_state", "get_window_state", "click", "end_session"]) assert.ok(names.includes(name), `missing ${name}`);
  checks.push("Installed Windows SDK starts a private host and exposes browser/native control tools");
  await host.stop(); driver.uniffiDestroy(); driver = null; host.uniffiDestroy(); host = null;
  checks.push("Private Windows desktop host stops cleanly");
  writeFileSync(receiptFile, JSON.stringify({ passed: true, generatedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, electron: process.versions.electron, node: process.versions.node, sourceRevision: process.env.REALBUD_BUILD_SHA, checks, notProven: ["Windows 11", "customer x64 PC", "login and MFA", "browser or native UI actions", "Hermes model login", "update and human takeover", "live microphone dictation quality"] }, null, 2));
  console.log(checks.join("\n"));
} finally { if (host) await host.stop().catch(() => {}); driver?.uniffiDestroy?.(); host?.uniffiDestroy?.(); rmSync(scratch, { recursive: true, force: true }); }
