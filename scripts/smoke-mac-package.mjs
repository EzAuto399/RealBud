#!/usr/bin/env node
// Packaged macOS smoke — same hook as Linux CI (OMB_SMOKE_TEST=1).
// Validates renderer preload, embedded harness, capabilities, clean exit.
//
//   node scripts/smoke-mac-package.mjs
//   OMB_SMOKE_EXECUTABLE=/path/to/RealBud.app/Contents/MacOS/RealBud node scripts/smoke-mac-package.mjs
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serviceIdentity, findRunningService } from "../electron/service-instance.mjs";
import { readServiceHandle, requestServiceStop } from "../electron/service-lifecycle.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultApp = path.join(root, "release", "mac-arm64", "RealBud.app", "Contents", "MacOS", "RealBud");
const altApp = path.join(root, "release", "mac", "RealBud.app", "Contents", "MacOS", "RealBud");
const executable =
  process.env.OMB_SMOKE_EXECUTABLE ??
  [defaultApp, altApp].find((p) => existsSync(p)) ??
  defaultApp;

if (!existsSync(executable)) {
  throw new Error(`[smoke-mac-package] missing executable: ${executable}\nRun pnpm package:mac first.`);
}

const sandbox = mkdtempSync(path.join(realpathSync(tmpdir()), "realbud-mac-smoke-"));
const home = path.join(sandbox, "home");
const dataDir = path.join(home, ".realbud");
const hermesHome = path.join(home, ".hermes");
const userDataDir = path.join(sandbox, "electron-user-data");
const resultFile = path.join(sandbox, "smoke-result.json");
mkdirSync(dataDir, { recursive: true });
mkdirSync(hermesHome, { recursive: true });
mkdirSync(userDataDir, { recursive: true });
writeFileSync(
  path.join(dataDir, "config.json"),
  JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } } }),
);

let output = "";
let smokeResult = null;
let spawnError = null;
let succeeded = false;
function readSmokeFile() {
  if (!existsSync(resultFile)) return null;
  try {
    return JSON.parse(readFileSync(resultFile, "utf8").trim());
  } catch {
    return null;
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForPortCandidate(ports, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const busy = await Promise.all(
      ports.map(async (port) => {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/health`);
          return res.ok;
        } catch {
          return false;
        }
      }),
    );
    if (busy.some((value) => !value)) return;
    await delay(200);
  }
  throw new Error(`no RealBud port candidate became free after ${timeoutMs}ms: ${ports.join(", ")}`);
}

try {
  await waitForPortCandidate([8799, 18799, 28799]);
} catch (error) {
  rmSync(sandbox, { recursive: true, force: true });
  throw error;
}

const childEnv = {
  ...process.env,
  HOME: home,
  HERMES_HOME: hermesHome,
  REALBUD_DATA_DIR: dataDir,
  REALBUD_LOG_DIR: path.join(sandbox, "electron-logs"),
  OMB_USER_DATA: userDataDir,
  OMB_SMOKE_TEST: "1",
  OMB_SMOKE_RESULT_FILE: resultFile,
};
for (const key of [
  "XAI_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "DEEPSEEK_API_KEY",
  "GROQ_API_KEY",
  "KIMI_API_KEY",
  "MOONSHOT_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_BEARER_TOKEN_BEDROCK",
]) {
  delete childEnv[key];
}

const child = spawn(executable, [`--user-data-dir=${userDataDir}`], {
  cwd: root,
  detached: true,
  env: childEnv,
  stdio: ["ignore", "pipe", "pipe"],
});
child.on("error", (error) => {
  spawnError = error;
});

for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    output += chunk;
    const match = output.match(/\[smoke\] renderer-ready (\{.*\})\r?\n/);
    if (match && !smokeResult) {
      try {
        smokeResult = JSON.parse(match[1]);
      } catch {}
    }
  });
}

function hasExited() {
  return child.exitCode !== null || child.signalCode !== null;
}

async function until(probe, description) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const value = await probe().catch(() => null);
    if (value) return value;
    if (spawnError) throw spawnError;
    if (hasExited()) {
      const filePayload = readSmokeFile();
      if (filePayload?.ok === false) throw new Error(filePayload.error);
      throw new Error(
        `Electron exited ${child.exitCode ?? child.signalCode} while waiting for ${description}.\n${output}`,
      );
    }
    await delay(100);
  }
  const filePayload = readSmokeFile();
  if (filePayload?.ok === false) throw new Error(filePayload.error);
  throw new Error(`timed out waiting for ${description}.\n${output}`);
}

async function waitForExit() {
  const deadline = Date.now() + 15_000;
  while (!hasExited() && Date.now() < deadline) await delay(50);
  if (!hasExited()) throw new Error(`Electron did not exit after its window closed.\n${output}`);
}

async function stopProcess() {
  if (hasExited()) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  const stopDeadline = Date.now() + 5_000;
  while (!hasExited() && Date.now() < stopDeadline) await delay(50);
  if (!hasExited()) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
}

try {
  const payload = await until(async () => {
    const filePayload = readSmokeFile();
    if (filePayload?.ok) return filePayload;
    if (smokeResult) return { ok: true, result: smokeResult };
    return null;
  }, "the packaged renderer smoke result");
  if (!payload.ok) throw new Error(payload.error ?? "smoke failed");

  const { capabilities, health, location, title } = payload.result;
  if (health?.app !== "realbud" || health.static !== true) {
    throw new Error(`unexpected embedded health response: ${JSON.stringify(health)}`);
  }
  if (!String(title).includes("RealBud")) throw new Error(`unexpected renderer title: ${title}`);
  if (capabilities.host.platform !== "darwin") throw new Error(`renderer did not report darwin: ${capabilities.host.platform}`);

  await waitForExit();
  const staleHealth = await fetch(new URL("/api/health", location)).catch(() => null);
  if (staleHealth?.ok) throw new Error("embedded harness remained reachable after Electron quit");

  succeeded = true;
  console.log("[smoke-mac-package] OK: renderer, capabilities, embedded harness, and shutdown");
} finally {
  await stopProcess();
  // A packaged service deliberately survives its window. The smoke owns this
  // disposable installation and must finish shutdown before deleting its data.
  const identity = serviceIdentity(dataDir);
  const service = readServiceHandle(dataDir, identity.instanceId);
  if (service) await requestServiceStop(service, identity);
  for (let attempt = 0; attempt < 50 && await findRunningService(identity); attempt++) await delay(100);
  if (await findRunningService(identity)) {
    succeeded = false;
    throw new Error(`Disposable service did not stop; retained its data at ${sandbox}`);
  }
  if (succeeded && process.env.OMB_KEEP_SMOKE_DIR !== "1") {
    rmSync(sandbox, { recursive: true, force: true });
  } else {
    console.error(`[smoke-mac-package] kept diagnostics: ${sandbox}`);
  }
}
