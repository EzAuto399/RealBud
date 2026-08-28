#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createBrowserPolicy, persistPolicy } = require("../electron/cua-policy.cjs");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const driver = path.join(root, "dist-native", process.platform === "win32" ? "cua-driver.exe" : "cua-driver");

if (process.platform !== "darwin") {
  console.log("[cua-bounded-policy] SKIPPED: macOS source proof only");
  process.exit(0);
}
if (!existsSync(driver)) throw new Error("bundled Cua Driver is missing; run pnpm build:cua first");

const temporary = mkdtempSync(path.join(os.tmpdir(), "realbud-cua-policy-e2e-"));
const socketPath = path.join(temporary, "bounded.sock");
const origin = "http://127.0.0.1:43991";
let daemon;
let client;

function run(args, { allowFailure = false, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(driver, args, {
      env: {
        PATH: process.env.PATH,
        HOME: temporary,
        CUA_DRIVER_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`cua-driver ${args[0]} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      const result = { code: code ?? -1, stdout, stderr, text: `${stdout}\n${stderr}` };
      if (!allowFailure && code !== 0) {
        reject(new Error(`cua-driver ${args[0]} failed (${code}): ${result.text.slice(0, 800)}`));
      } else {
        resolve(result);
      }
    });
  });
}

async function waitForDaemon() {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const status = await run(["status", "--socket", socketPath], { allowFailure: true, timeoutMs: 2_000 });
    if (status.code === 0 && /running|healthy|ready/i.test(status.text)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("bounded Cua daemon did not become ready");
}

function assertMatch(label, text, pattern) {
  if (!pattern.test(text)) throw new Error(`${label} did not return the expected refusal: ${text.slice(0, 800)}`);
}

async function callTool(name, args, { expectRefusal = false } = {}) {
  try {
    const result = await client.callTool(name, JSON.stringify(args));
    if (expectRefusal) {
      throw new Error(`${name} unexpectedly succeeded`);
    }
    return {
      result,
      text: [result.text, result.structuredJson, result.rawJson, result.errorCode].filter(Boolean).join("\n"),
    };
  } catch (error) {
    if (!expectRefusal) throw error;
    return {
      result: undefined,
      text: [error?.message, error?.inner?.message, error?.inner?.errorCode].filter(Boolean).join("\n"),
    };
  }
}

try {
  const version = await run(["--version"]);
  assertMatch("driver pin", version.text, /cua-driver 0\.19\.3\b/);
  await run(["telemetry", "disable"]);

  const policy = persistPolicy({
    userData: temporary,
    label: "native-e2e",
    policy: createBrowserPolicy({
      origins: [origin],
      profileKind: "isolated",
      ttlSeconds: 120,
      idleSeconds: 60,
      workItemId: "native-policy-e2e",
      recipeId: "fake-bank-credit-list",
      recipeVersion: 1,
      allowLoopbackHttp: true,
    }),
  });

  daemon = spawn(
    driver,
    [
      "serve",
      "--socket",
      socketPath,
      "--permission-mode",
      "bounded",
      "--session-policy",
      policy.path,
      "--approve-session-policy",
      "--no-permissions-gate",
      "--no-overlay",
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: temporary,
        CUA_DRIVER_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let daemonError = "";
  daemon.stderr.on("data", (chunk) => {
    daemonError += String(chunk);
  });
  await waitForDaemon().catch((error) => {
    throw new Error(`${error.message}: ${daemonError.slice(0, 800)}`);
  });
  const { CuaDriver } = await import("@trycua/cua-driver");
  client = CuaDriver.connect(socketPath);

  const start = await callTool("start_session", { session: "realbud-policy-e2e" });
  if (start.result.isError || /permission denied|permission_denied/i.test(start.text)) {
    throw new Error(`allowed session lifecycle was denied: ${start.text.slice(0, 800)}`);
  }

  const desktop = await callTool(
    "get_desktop_state",
    { target: { kind: "desktop", display_id: "primary" } },
    { expectRefusal: true },
  );
  assertMatch("desktop denial", desktop.text, /permission.?denied|permission_denied/i);

  const ambientWindows = await callTool("list_windows", {}, { expectRefusal: true });
  assertMatch(
    "ambient window-list denial",
    ambientWindows.text,
    /permission.?denied|permission_denied|outside.*manifest|resource.*denied/i,
  );

  const offOrigin = await callTool(
    "browser_navigate",
    {
      target_id: "invalid",
      tab_id: "invalid",
      url: "https://evil.example",
    },
    { expectRefusal: true },
  );
  assertMatch(
    "origin denial",
    offOrigin.text,
    /bounded_resource_outside_manifest|outside.*manifest|origin.*outside.*bounded.*policy|origin.*not.*allow/i,
  );

  await callTool("end_session", { session: "realbud-policy-e2e" });
  await run(["stop", "--socket", socketPath]);
  if (daemon.exitCode == null) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      daemon.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  const stopped = await callTool("start_session", { session: "after-stop" }, { expectRefusal: true });
  assertMatch("generation teardown", stopped.text, /closed|connect|daemon|endpoint|transport|unavailable|shutdown/i);

  console.log("[cua-bounded-policy] ALL GREEN");
  console.log("  ✓ pinned Cua Driver 0.19.3");
  console.log("  ✓ allowed session lifecycle admitted");
  console.log("  ✓ generic desktop capture denied natively");
  console.log("  ✓ ambient window enumeration denied natively");
  console.log("  ✓ off-origin browser navigation denied natively");
  console.log("  ✓ bounded runtime teardown invalidated the live SDK connection");
} finally {
  if (client) {
    await client.shutdown().catch(() => {});
    client.uniffiDestroy?.();
  }
  if (daemon && daemon.exitCode == null) {
    daemon.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1_500);
      daemon.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (daemon.exitCode == null) daemon.kill("SIGKILL");
  }
  rmSync(temporary, { recursive: true, force: true });
}
