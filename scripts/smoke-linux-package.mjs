import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedPlatform = process.platform;
const defaultExecutable =
  expectedPlatform === "win32"
    ? path.join(root, "release", "win-unpacked", "RealBud.exe")
    : expectedPlatform === "darwin"
      ? path.join(root, "release", process.arch === "arm64" ? "mac-arm64" : "mac", "RealBud.app", "Contents", "MacOS", "RealBud")
      : path.join(root, "release", "linux-unpacked", "realbud");
const executable = path.resolve(
  process.env.OMB_SMOKE_EXECUTABLE ?? defaultExecutable,
);
if (!existsSync(executable)) throw new Error(`[smoke-installed-package] missing executable: ${executable}`);

const sandbox = mkdtempSync(path.join(tmpdir(), "realbud-installed-smoke-"));
const home = path.join(sandbox, "home");
const xdgConfig = path.join(sandbox, "config");
const appData = path.join(sandbox, "appdata");
const localAppData = path.join(sandbox, "local-appdata");
const dataDir = path.join(sandbox, "realbud-data");
const userDataDir = path.join(sandbox, "realbud-user-data");
const personalHermesDir = path.join(home, ".hermes");
const personalBinDir = path.join(home, ".local", "bin");
const personalHermes = path.join(personalBinDir, expectedPlatform === "win32" ? "hermes.cmd" : "hermes");
const personalMarker = path.join(sandbox, "personal-hermes-was-executed");
const cuaMarker = path.join(sandbox, "cua-was-executed");
const cuaSentinel = path.join(sandbox, expectedPlatform === "win32" ? "cua-driver.cmd" : "cua-driver");
const personalProfile = path.join(personalHermesDir, "personal.json");
const personalProfileBody = '{"owner":"personal-hermes-sentinel"}\n';
const fakeModelKey = "sk-package-smoke-not-a-real-key";
const workerProfile = path.join(dataDir, "worker", "profiles", "property");

mkdirSync(personalHermesDir, { recursive: true });
mkdirSync(personalBinDir, { recursive: true });
mkdirSync(workerProfile, { recursive: true });
mkdirSync(xdgConfig, { recursive: true });
mkdirSync(appData, { recursive: true });
mkdirSync(localAppData, { recursive: true });
writeFileSync(personalProfile, personalProfileBody);
if (expectedPlatform === "win32") {
  writeFileSync(personalHermes, `@echo off\r\ntype nul > "${personalMarker}"\r\nexit /b 97\r\n`);
  writeFileSync(cuaSentinel, `@echo off\r\ntype nul > "${cuaMarker}"\r\nexit /b 99\r\n`);
} else {
  writeFileSync(personalHermes, `#!/bin/sh\ntouch ${JSON.stringify(personalMarker)}\nexit 97\n`);
  chmodSync(personalHermes, 0o755);
  writeFileSync(cuaSentinel, `#!/bin/sh\ntouch ${JSON.stringify(cuaMarker)}\nexit 99\n`);
  chmodSync(cuaSentinel, 0o755);
}
writeFileSync(path.join(workerProfile, "config.yaml"), "model:\n  default: grok-4\n  provider: xai\n");
writeFileSync(path.join(workerProfile, ".env"), `XAI_API_KEY=${fakeModelKey}\nOTHER_SETTING=preserved\n`);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function launchOnce(label) {
  let output = "";
  let smokeResult = null;
  const child = spawn(executable, [], {
    cwd: root,
    detached: true,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: xdgConfig,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      REALBUD_DATA_DIR: dataDir,
      REALBUD_USER_DATA_DIR: userDataDir,
      REALBUD_ALLOW_INSECURE_TEST_KEYS: "1",
      REALBUD_DISABLE_CUA_FOR_TEST: "1",
      REALBUD_USE_MOCK_KEYCHAIN_FOR_TEST: "1",
      CUA_DRIVER_PATH: cuaSentinel,
      OMB_SMOKE_TEST: "1",
      PATH: `${personalBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/\[smoke\] renderer-ready (\{.*\})\r?\n/);
      if (match && !smokeResult) smokeResult = JSON.parse(match[1]);
    });
  }

  async function until(probe, description) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const value = await probe().catch(() => null);
      if (value) return value;
      if (child.exitCode !== null) {
        throw new Error(`${label}: Electron exited ${child.exitCode} while waiting for ${description}.\n${output}`);
      }
      await delay(100);
    }
    throw new Error(`${label}: timed out waiting for ${description}.\n${output}`);
  }

  async function waitForExit() {
    const deadline = Date.now() + 10_000;
    while (child.exitCode === null && Date.now() < deadline) await delay(50);
    if (child.exitCode === null) throw new Error(`${label}: Electron did not exit after its window closed.\n${output}`);
  }

  async function stopProcess() {
    if (child.exitCode !== null) return;
    try {
      if (expectedPlatform === "win32") child.kill();
      else process.kill(-child.pid, "SIGTERM");
    } catch {}
    const stopDeadline = Date.now() + 5_000;
    while (child.exitCode === null && Date.now() < stopDeadline) await delay(50);
    if (child.exitCode === null) {
      try {
        if (expectedPlatform === "win32") {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        } else {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {}
    }
  }

  try {
    const result = await until(async () => smokeResult, "the packaged renderer smoke result");
    const { capabilities, desk, health, location, title, worker } = result;
    if (health?.app !== "realbud" || health.static !== true) {
      throw new Error(`${label}: unexpected embedded health response: ${JSON.stringify(health)}`);
    }
    if (!String(title).includes("RealBud")) throw new Error(`${label}: unexpected renderer title: ${title}`);
    if (capabilities.host.platform !== expectedPlatform) throw new Error(`${label}: renderer reported the wrong host platform`);
    if (expectedPlatform !== "darwin" && capabilities.dictation.available) {
      throw new Error(`${label}: dictation must be unavailable off macOS`);
    }
    if (capabilities.localComputer.available) throw new Error(`${label}: local control must stay unavailable in package smoke`);
    if (expectedPlatform === "darwin" && capabilities.localComputer.runtime !== "bundled") {
      throw new Error(`${label}: packaged macOS app did not resolve its bundled CUA runtime`);
    }
    if (desk?.recovery || desk?.properties < 1 || !Number.isInteger(desk?.revision)) {
      throw new Error(`${label}: packaged Desk was not writable and populated: ${JSON.stringify(desk)}`);
    }
    if (worker?.provider !== "xai" || worker?.model !== "grok-4" || worker?.keyPresent !== true) {
      throw new Error(`${label}: persisted worker model did not reopen: ${JSON.stringify(worker)}`);
    }
    if (!worker?.packInstalled || !worker?.approvalsManual) {
      throw new Error(`${label}: packaged property safety pack did not install with manual approvals: ${JSON.stringify(worker)}`);
    }
    if (existsSync(personalMarker)) throw new Error(`${label}: RealBud executed the personal Hermes launcher`);
    if (existsSync(cuaMarker)) throw new Error(`${label}: RealBud executed the CUA sentinel`);

    await waitForExit();
    const staleHealth = await fetch(new URL("/api/health", location)).catch(() => null);
    if (staleHealth?.ok) throw new Error(`${label}: embedded harness remained reachable after Electron quit`);
    return result;
  } finally {
    await stopProcess();
  }
}

function requirePrivate(file) {
  if (expectedPlatform === "win32") return;
  const mode = statSync(file).mode & 0o777;
  if (mode !== 0o600) throw new Error(`private state has mode ${mode.toString(8)} instead of 600: ${file}`);
}

function assertSecretAbsent(dir, secret) {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    const stat = statSync(file);
    if (stat.isDirectory()) assertSecretAbsent(file, secret);
    else if (stat.isFile() && readFileSync(file).includes(Buffer.from(secret))) {
      throw new Error(`plaintext model credential remained in ${file}`);
    }
  }
}

try {
  const first = await launchOnce("first launch");
  const secureKeys = path.join(dataDir, "secure-keys.json");
  const workerSecrets = path.join(dataDir, "worker", "secrets.json");
  const deskFile = path.join(dataDir, "desk.json");
  for (const file of [secureKeys, workerSecrets, deskFile]) {
    if (!existsSync(file)) throw new Error(`first launch did not create ${file}`);
    requirePrivate(file);
  }
  for (const forbidden of [
    path.join(dataDir, "desk.key"),
    path.join(dataDir, ".secrets.key"),
    path.join(dataDir, "worker", ".secrets.key"),
  ]) {
    if (existsSync(forbidden)) throw new Error(`packaged launch left a plaintext wrapping key: ${forbidden}`);
  }
  const migratedEnv = readFileSync(path.join(workerProfile, ".env"), "utf8");
  if (migratedEnv.includes("XAI_API_KEY") || !migratedEnv.includes("OTHER_SETTING=preserved")) {
    throw new Error("worker dotenv migration did not remove only the credential");
  }
  assertSecretAbsent(dataDir, fakeModelKey);
  if (readFileSync(personalProfile, "utf8") !== personalProfileBody) throw new Error("personal Hermes profile changed");
  const personalLauncherBody = readFileSync(personalHermes, "utf8");
  const secureBefore = readFileSync(secureKeys);
  const secretsBefore = readFileSync(workerSecrets);
  const deskBefore = readFileSync(deskFile);

  const second = await launchOnce("restart");
  if (JSON.stringify(second.desk) !== JSON.stringify(first.desk)) throw new Error("Desk state changed across a no-op restart");
  if (JSON.stringify(second.worker) !== JSON.stringify(first.worker)) throw new Error("worker model state changed across restart");
  if (!readFileSync(secureKeys).equals(secureBefore)) throw new Error("OS-wrapped keys changed across restart");
  if (!readFileSync(workerSecrets).equals(secretsBefore)) throw new Error("encrypted worker credential changed across restart");
  if (!readFileSync(deskFile).equals(deskBefore)) throw new Error("encrypted Desk changed across a no-op restart");
  if (readFileSync(personalProfile, "utf8") !== personalProfileBody) throw new Error("personal Hermes profile changed after restart");
  if (readFileSync(personalHermes, "utf8") !== personalLauncherBody) throw new Error("personal Hermes launcher changed after restart");
  if (existsSync(personalMarker) || existsSync(cuaMarker)) throw new Error("an isolated sentinel was executed");
  if (existsSync(path.join(dataDir, "realbud.lock"))) throw new Error("data-directory lock remained after shutdown");

  console.log(`[smoke-installed-package] OK (${expectedPlatform}/${process.arch}): first launch, restart, encrypted keys/model, renderer, Desk, isolation, and shutdown`);
} finally {
  if (process.env.OMB_KEEP_SMOKE_DIR !== "1") rmSync(sandbox, { recursive: true, force: true });
  else console.log(`[smoke-installed-package] kept ${sandbox}`);
}
