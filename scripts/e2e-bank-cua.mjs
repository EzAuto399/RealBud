#!/usr/bin/env node
// Hybrid local-bank proof for the production routing topology:
// 1) a deterministic DOM runner owns a fresh isolated Chromium profile;
// 2) pinned Cua validates that exact browser PID/DevTools endpoint under an
//    immutable exact-origin policy; 3) only a bounded credit list reaches the
//    typed bank adapter and Desk. No personal browser, real bank, Hermes
//    profile, payment control, credential store or ambient window is touched.
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bankTransactionDigest } from "../server/bank-observation.ts";
import { runBankObservationImport } from "../server/bank-work-reconciler.ts";
import { Desk } from "../server/desk.ts";
import { FAKE_BANK_LOGIN, startFakeBankPortal } from "../server/testing/fake-bank-portal.ts";
import { WorkBroker } from "../server/work-broker.ts";

const require = createRequire(import.meta.url);
const { createBrowserPolicy, persistPolicy } = require("../electron/cua-policy.cjs");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const driver = path.join(root, "dist-native", "cua-driver");
const agentBrowser = path.join(root, "node_modules", "agent-browser", "bin", "agent-browser.js");

if (process.platform !== "darwin") {
  console.log("[bank-cua] SKIPPED: macOS source proof only");
  process.exit(0);
}
if (!existsSync(driver)) throw new Error("bundled Cua Driver is missing; run pnpm build:cua first");
if (!existsSync(agentBrowser)) throw new Error("the pinned scripted-browser runner is missing; run pnpm install");

const temporary = mkdtempSync(path.join(os.tmpdir(), "realbud-bank-cua-"));
const socketPath = path.join(temporary, "bounded.sock");
const browserProfile = path.join(temporary, "browser-profile");
const session = `rb-${process.pid}`;
const runtimePath = [process.env.PATH, "/usr/sbin", "/sbin", "/usr/bin", "/bin"]
  .filter(Boolean)
  .join(path.delimiter);
let daemon;
let proxy;
let portal;
let mcpClient;

const digest = (value) => createHash("sha256").update(value).digest("hex");
const expect = (condition, message) => { if (!condition) throw new Error(message); };

function runProcess(command, args, { allowFailure = false, timeoutMs = 30_000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: {
        PATH: runtimePath,
        HOME: temporary,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG ?? "en_AU.UTF-8",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputOverflow = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${path.basename(command)} timed out`));
    }, timeoutMs);
    const append = (current, chunk) => {
      const next = current + String(chunk);
      if (Buffer.byteLength(next, "utf8") > 2 * 1024 * 1024) {
        outputOverflow = true;
        child.kill("SIGKILL");
        return current;
      }
      return next;
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      const result = { code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim(), text: `${stdout}\n${stderr}` };
      if (outputOverflow) reject(new Error(`${path.basename(command)} output exceeded 2 MB`));
      else if (!allowFailure && code !== 0) reject(new Error(result.text.slice(0, 1_200)));
      else resolve(result);
    });
  });
}

const runDriver = (args, options = {}) => runProcess(driver, args, { timeoutMs: 10_000, ...options });
const browser = (...args) => runProcess(
  process.execPath,
  [agentBrowser, "--session", session, "--profile", browserProfile, ...args],
  { env: { AGENT_BROWSER_ALLOWED_DOMAINS: "127.0.0.1" } },
).then((result) => result.stdout);

async function waitForDaemon() {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const status = await runDriver(["status", "--socket", socketPath], { allowFailure: true, timeoutMs: 2_000 });
    if (status.code === 0 && /running|healthy|ready/i.test(status.text)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("bounded Cua daemon did not become ready");
}

function createMcpClient() {
  proxy = spawn(driver, ["mcp", "--socket", socketPath], {
    env: { PATH: runtimePath, HOME: temporary, CUA_DRIVER_TELEMETRY_DISABLED: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let stdout = "";
  let stderr = "";
  let nextId = 1;
  proxy.stderr.on("data", (chunk) => { stderr += String(chunk); });
  proxy.stdout.on("data", (chunk) => {
    stdout += String(chunk);
    let newline;
    while ((newline = stdout.indexOf("\n")) !== -1) {
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const settle = pending.get(message.id);
      if (settle) {
        pending.delete(message.id);
        settle(message);
      }
    }
  });
  const rpc = (method, params = {}, timeoutMs = 30_000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out${stderr ? `: ${stderr.slice(0, 800)}` : ""}`));
    }, timeoutMs);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  return {
    async initialize() {
      await rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "realbud-bank-cua-e2e", version: "1" },
      });
      proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    callTool: (name, args) => rpc("tools/call", { name, arguments: args }),
  };
}

function resultObject(result) {
  for (const candidate of [
    result?.structuredContent,
    ...(Array.isArray(result?.content) ? result.content.filter((item) => item?.type === "text").map((item) => item.text) : []),
  ]) {
    if (candidate && typeof candidate === "object") return candidate;
    if (typeof candidate !== "string") continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  return null;
}

function assertMcpResult(name, result) {
  if (result?.isError) {
    const detail = result?.content?.find((item) => item?.type === "text")?.text;
    throw new Error(`${name} failed: ${String(detail ?? "unknown error").slice(0, 1_200)}`);
  }
  return result;
}

function browserOwner(cdpUrl) {
  const endpoint = new URL(cdpUrl);
  if (endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1" || !/^\/devtools\/browser\//.test(endpoint.pathname)) {
    throw new Error("scripted browser returned an invalid private DevTools endpoint");
  }
  const port = Number(endpoint.port);
  if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) throw new Error("scripted browser port is invalid");
  const owner = spawnSync("/usr/sbin/lsof", ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (owner.status !== 0) throw new Error("scripted browser endpoint owner was not found");
  const pids = owner.stdout.trim().split(/\s+/).filter(Boolean).map(Number);
  if (pids.length !== 1 || !Number.isSafeInteger(pids[0]) || pids[0] <= 1) {
    throw new Error("scripted browser endpoint ownership is ambiguous");
  }
  const command = spawnSync("/bin/ps", ["-p", String(pids[0]), "-o", "command="], { encoding: "utf8", timeout: 5_000 });
  if (command.status !== 0 || !/Google Chrome|Chromium/.test(command.stdout)) {
    throw new Error("scripted browser endpoint is not owned by Chromium");
  }
  const profileFlag = command.stdout.match(/--user-data-dir=(?:"([^"]+)"|(\S+))/);
  const profilePath = path.resolve(profileFlag?.[1] ?? profileFlag?.[2] ?? "");
  const relative = path.relative(path.resolve(temporary), profilePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("scripted browser did not use the private RealBud test profile");
  }
  return { pid: pids[0] };
}

async function stopProcess(child) {
  if (!child || child.exitCode != null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 1_500);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  if (child.exitCode == null) child.kill("SIGKILL");
}

try {
  const now = new Date(2026, 7, 27, 9, 30, 0).getTime();
  portal = await startFakeBankPortal({ now });
  await browser("open", `${portal.url}/login`);
  await browser("wait", "--text", "Sign in to view account activity");
  const owner = browserOwner(await browser("get", "cdp-url"));

  const policy = persistPolicy({
    userData: temporary,
    label: "bank-cua-e2e",
    policy: createBrowserPolicy({
      origins: [portal.url],
      profileKind: "isolated",
      ttlSeconds: 300,
      idleSeconds: 120,
      workItemId: "bank-cua-e2e",
      recipeId: "bank-credit-observation",
      recipeVersion: 1,
      allowLoopbackHttp: true,
    }),
  });
  daemon = spawn(driver, [
    "serve", "--socket", socketPath,
    "--permission-mode", "bounded",
    "--session-policy", policy.path,
    "--approve-session-policy",
    "--no-permissions-gate",
    "--no-overlay",
  ], {
    env: { PATH: runtimePath, HOME: temporary, CUA_DRIVER_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let daemonError = "";
  daemon.stderr.on("data", (chunk) => { daemonError += String(chunk); });
  await waitForDaemon().catch((error) => {
    throw new Error(`${error.message}: ${daemonError.slice(0, 1_200)}`);
  });
  mcpClient = createMcpClient();
  await mcpClient.initialize();
  assertMcpResult("start_session", await mcpClient.callTool("start_session", { session, capture_scope: "window" }));
  const prepared = assertMcpResult("browser_prepare", await mcpClient.callTool("browser_prepare", {
    pid: owner.pid,
    session,
  }));
  const preparedObject = resultObject(prepared);
  const preparedSummary = {
    status: preparedObject?.status,
    reason:
      preparedObject?.reason
      ?? preparedObject?.message
      ?? preparedObject?.error
      ?? preparedObject?.refusal?.reason
      ?? preparedObject?.refusal?.message,
    refusalCode: preparedObject?.refusal?.code,
    refusalFields:
      preparedObject?.refusal && typeof preparedObject.refusal === "object"
        ? Object.keys(preparedObject.refusal).sort()
        : [],
    fields: preparedObject && typeof preparedObject === "object" ? Object.keys(preparedObject).sort() : [],
    prepared: preparedObject?.prepared,
    preparedPid: preparedObject?.prepared_pid,
    ownerPid: preparedObject?.endpoint_ownership?.owner_pid,
    copiedProfileData: preparedObject?.side_effects?.copied_profile_data,
    foregroundedWindow: preparedObject?.side_effects?.foregrounded_window,
  };
  expect(
    preparedObject?.status === "ok" && preparedObject.prepared === true,
    `Cua did not validate the isolated browser: ${JSON.stringify(preparedSummary)}`,
  );
  expect(preparedObject.prepared_pid === owner.pid, "Cua prepared a browser other than RealBud's isolated process");
  expect(preparedObject.endpoint_ownership?.owner_pid === owner.pid, "Cua did not attest endpoint ownership");
  expect(preparedObject.side_effects?.copied_profile_data === false, "Cua copied browser profile data");
  expect(preparedObject.side_effects?.foregrounded_window === false, "Cua foregrounded the isolated browser");
  const ambientWindows = await mcpClient.callTool("list_windows", {});
  expect(ambientWindows?.isError === true, "bounded Cua exposed ambient window enumeration");

  await browser("find", "label", "Customer ID", "fill", FAKE_BANK_LOGIN.username);
  await browser("find", "label", "Password", "fill", FAKE_BANK_LOGIN.password);
  await browser("find", "role", "button", "click", "--name", "Sign in");
  await browser("wait", "--text", "Account activity");
  expect(await browser("is", "enabled", "#transfer-money") === "false", "transfer control became available");
  expect(await browser("is", "enabled", "#add-payee") === "false", "payee control became available");

  const text = await browser("get", "text", "#credit-list");
  const accountFingerprint = digest(portal.maskedAccount);
  const credits = text.split(/\r?\n/).filter(Boolean).map((line) => {
    const [bookedIso, amount, ...referenceParts] = line.split("|");
    const reference = referenceParts.join("|");
    const bookedAt = Date.parse(bookedIso);
    const amountCents = Number(amount);
    expect(Number.isFinite(bookedAt) && Number.isInteger(amountCents) && reference, "browser returned malformed credit data");
    const credit = { bookedAt, amountCents, reference };
    return { ...credit, transactionDigest: bankTransactionDigest(accountFingerprint, credit) };
  });
  expect(credits.length === portal.credits.length, "browser did not read the bounded credit list completely");

  const desk = new Desk({ file: path.join(temporary, "desk.json"), now: () => now });
  desk.importCsv("propertyCode,daysSinceDue,rentLanded,levyPaid\nprop-oak,4,false,false", now, desk.revision);
  const broker = new WorkBroker({ file: path.join(temporary, "work-broker.json"), now: () => now });
  const result = runBankObservationImport({
    broker,
    desk,
    requestId: `bank-cua-${digest(`${desk.revision}:${now}:${portal.url}`).slice(0, 32)}`,
    expectedRevision: desk.revision,
    allowedOrigins: [portal.url],
    batch: {
      kind: "realbud.bank-credit-observation.v1",
      schemaVersion: 1,
      accountFingerprint,
      observedAt: now,
      credits,
    },
    now: () => now,
  });
  expect(result.receipt.state === "reconciled", "bank receipt did not reconcile into Desk");
  expect(result.snapshot.results.find((row) => row.propertyId === "prop-oak")?.reason === "conflicted-source", "bank/PMS discrepancy did not hold warning wording");
  expect(JSON.stringify(result.snapshot).includes("UNMATCHED FIXTURE CREDIT") === false, "raw bank reference leaked into Desk");
  expect(portal.transferAttempts() === 0 && portal.payeeAttempts() === 0, "browser reached a forbidden money endpoint");

  console.log("bank Cua walkthrough: ALL GREEN");
  console.log("  ✓ scripted browser used a disposable RealBud-owned profile");
  console.log("  ✓ Cua validated the exact browser PID and endpoint under a bounded policy");
  console.log("  ✓ ambient windows, transfer and payee paths stayed unavailable");
  console.log("  ✓ bounded credits reconciled into Desk without raw bank references");
} finally {
  await mcpClient?.callTool("end_session", { session }).catch(() => {});
  proxy?.stdin?.end();
  await stopProcess(proxy);
  if (daemon && daemon.exitCode == null) {
    await runDriver(["stop", "--socket", socketPath], { allowFailure: true }).catch(() => {});
    await stopProcess(daemon);
  }
  await browser("close").catch(() => {});
  await portal?.close().catch(() => {});
  rmSync(temporary, { recursive: true, force: true });
}
