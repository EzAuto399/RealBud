#!/usr/bin/env node
// Installed-CLI regression: configured MCP must not shadow RealBud's explicit
// ACP registration. Synthetic homes and local fixtures only; never send a prompt.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { hardenHermesChildEnv } from "../server/drivers/acp/hermes.ts";

const argument = name => {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a path.`);
  return value;
};
const cli = argument("--cli") || process.env.REALBUD_HERMES_CLI || "hermes";
const memoryProposals = process.argv.includes("--memory-proposals");
const serverName = memoryProposals ? "memory-proposals" : "connected-apps";
const installRoot = resolve(argument("--install-root") || join(homedir(), ".hermes/hermes-agent"));
assert.ok(existsSync(join(installRoot, "hermes_cli/main.py")), "Specify the installed CLI source with --install-root.");
// Upstream loads a source-tree .env as well as HERMES_HOME/.env. Refuse that
// private fallback instead of reading, copying or modifying its contents.
assert.equal(existsSync(join(installRoot, ".env")), false, "Installed source has a .env fallback; isolation test will not load it.");
assert.ok(Number(process.versions.node.split(".")[0]) >= 24, "Run this regression with Node 24 or newer.");
assert.notEqual(process.platform, "win32", "This regression uses POSIX child-process groups for isolated cleanup.");

const scratch = mkdtempSync(join(tmpdir(), "realbud-mcp-isolation-"));
const fixtures = [];
let child;
let childDone;
let stderr = "";
let stdout = "";
const pending = new Map();
let nextId = 1;
let failure;
let protocolFailure;
let proposalBroker;

async function fixture(name, model = false, upstream) {
  const calls = [];
  const server = createServer((req, res) => {
    void (async () => {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 64_000) { res.writeHead(413).end(); return; }
      }
      let message;
      try { message = body ? JSON.parse(body) : {}; } catch { res.writeHead(400).end(); return; }
      const call = { method: req.method, path: req.url, rpc: message.method ?? null }; calls.push(call);
      if (model) { res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "No model is available in this fixture." })); return; }
      if (upstream) {
        // Observe the actual broker without production-only logging hooks.
        // This fixture has no active turn or ability to publish a proposal.
        assert.ok(["initialize", "tools/list", "ping", "notifications/initialized"].includes(message.method));
        const response = await fetch(upstream.url, { method: "POST", signal: AbortSignal.timeout(10000),
          headers: { "content-type": "application/json", ...Object.fromEntries(upstream.headers.map(row => [row.name, row.value])) }, body });
        const text = await response.text();
        if (message.method === "tools/list") call.toolNames = JSON.parse(text).result?.tools?.map(tool => tool.name);
        res.writeHead(response.status, { "content-type": "application/json" }).end(text); return;
      }
      if (req.method === "DELETE") { res.writeHead(200).end(); return; }
      if (req.method !== "POST") { res.writeHead(405).end(); return; }
      if (message.id === undefined) { res.writeHead(202).end(); return; }
      let result;
      if (message.method === "initialize") result = {
        protocolVersion: message.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} }, serverInfo: { name: `inert-${name}`, version: "1.0.0" },
      };
      else if (message.method === "tools/list") result = { tools: [{
        name: `${name}_fixture_tool`, description: "Inert discovery fixture. Never execute this tool.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }] };
      else if (message.method === "ping") result = {};
      else { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Fixture permits discovery only." } })); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    })().catch(() => { if (!res.headersSent) res.writeHead(400); res.end(); });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const entry = { server, calls, url: `http://127.0.0.1:${server.address().port}/mcp` };
  fixtures.push(entry);
  return entry;
}

function request(method, params) {
  assert.ok(["initialize", "session/new"].includes(method), "This test never sends prompts or model requests.");
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out after 45 seconds.`)); }, 45_000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, error => {
      if (error) { pending.get(id)?.reject(error); pending.delete(id); }
    });
  });
}

function rejectPending(reason) {
  for (const entry of pending.values()) entry.reject(reason);
  pending.clear();
}

async function stopChild() {
  if (!child?.pid) return;
  // Only this test's detached process group, never the user's Hermes runtime.
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  const stopped = await Promise.race([childDone.then(() => true), delay(2000).then(() => false)]);
  if (!stopped) {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    await Promise.race([childDone, delay(2000)]);
  }
}

try {
  const configured = await fixture("configured");
  if (memoryProposals) {
    const { startMemoryProposalBroker } = await import("../server/hermes-memory-proposal-broker.ts");
    proposalBroker = await startMemoryProposalBroker({ isActive: () => false, assertCapability: () => {},
      propose: async () => { throw new Error("Discovery must not publish a proposal."); } });
  }
  const explicit = await fixture("explicit", false, proposalBroker?.descriptor);
  const model = await fixture("model", true);
  const hermesHome = join(scratch, "profiles", "mcp-isolation");
  const operatingHome = join(scratch, "home");
  const cwd = join(scratch, "workroom");
  for (const path of [hermesHome, operatingHome, cwd, join(scratch, "tmp"), join(scratch, "managed")]) mkdirSync(path, { recursive: true });
  // JSON is valid YAML; no YAML serializer or MCP SDK is needed by this test.
  writeFileSync(join(hermesHome, "config.yaml"), JSON.stringify({
    model: { provider: "custom", default: "realbud-inert-fixture", base_url: model.url.replace("/mcp", "/v1"), api_key: "fixture-not-a-real-key", api_mode: "chat_completions", context_length: 128_000 },
    mcp_servers: { [serverName]: { url: configured.url, enabled: true } },
  }, null, 2), { mode: 0o600 });
  writeFileSync(join(hermesHome, ".env"), "# Empty isolated fixture; no inherited provider credentials.\n", { mode: 0o600 });
  const selector = `realbud_explicit_${randomUUID().replaceAll("-", "")}`;
  const environment = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin", LANG: "en_US.UTF-8", TERM: "dumb",
    HOME: operatingHome, HERMES_HOME: hermesHome, HERMES_MANAGED_DIR: join(scratch, "managed"),
    TMPDIR: join(scratch, "tmp"), XDG_CONFIG_HOME: join(scratch, "config"), XDG_CACHE_HOME: join(scratch, "cache"), XDG_DATA_HOME: join(scratch, "data"),
    HERMES_ACP_SKIP_CONFIGURED_MCP: "1", PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1",
    LITELLM_LOCAL_MODEL_COST_MAP: "True", HF_HUB_OFFLINE: "1", NO_PROXY: "127.0.0.1,localhost,::1",
  };
  hardenHermesChildEnv(environment);
  child = spawn(cli, ["--toolsets", selector, "acp"], { cwd, env: environment, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  childDone = new Promise(resolve => child.once("close", (code, signal) => { rejectPending(new Error(`Hermes exited before the ACP response (${code ?? signal}).`)); resolve(); }));
  child.on("error", error => rejectPending(error));
  child.stdin.on("error", error => rejectPending(error));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-12_000); });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    stdout += chunk;
    if (stdout.length > 1_000_000) { protocolFailure = new Error("Hermes ACP output exceeded the test limit."); rejectPending(protocolFailure); child.kill("SIGTERM"); return; }
    let index;
    while ((index = stdout.indexOf("\n")) >= 0) {
      const line = stdout.slice(0, index).trim(); stdout = stdout.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { protocolFailure = new Error("Hermes emitted non-JSON ACP output."); rejectPending(protocolFailure); continue; }
      if (message.method) {
        // Session notifications need no response. No host tools or approvals
        // are available in this discovery-only test.
        if (message.id !== undefined) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "No host actions in the isolation fixture." } })}\n`);
        continue;
      }
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(`ACP returned an error: ${JSON.stringify(message.error).slice(0, 1000)}`));
      else entry.resolve(message.result);
    }
  });
  const initialized = await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }, clientInfo: { name: "realbud-mcp-isolation", version: "1.0.0" } });
  assert.equal(initialized.protocolVersion, 1, "Installed Hermes must initialize ACP v1.");
  const session = await request("session/new", { cwd, mcpServers: [{ type: "http", name: serverName, url: explicit.url, headers: [] }] });
  assert.ok(typeof session.sessionId === "string" && session.sessionId, "Installed Hermes must create a real ACP session.");
  // The complete session/new response follows registration. A short grace
  // catches any still-running configured-discovery attempt before shutdown.
  await delay(300);
  assert.equal(protocolFailure, undefined, "ACP must remain valid JSON-RPC.");
  assert.equal(configured.calls.length, 0, "Configured connected-apps fixture must never be contacted.");
  assert.ok(explicit.calls.some(call => call.rpc === "initialize"), "Explicit same-name MCP must initialize.");
  assert.ok(explicit.calls.some(call => call.rpc === "tools/list"), "Explicit same-name MCP must list tools.");
  assert.equal(explicit.calls.filter(call => call.rpc === "tools/call").length, 0, "No fixture tool may execute.");
  if (memoryProposals) assert.deepEqual(explicit.calls.find(call => call.rpc === "tools/list").toolNames, ["memory_propose"], "The native runtime discovers only the proposal tool, with no approval capability.");
  // Hermes detects local model-server metadata during agent construction.
  // Only these inert GETs are allowed; the fixture supplies no model and all
  // inference/other requests fail this regression. No external provider exists.
  const metadataPaths = new Set(["/api/v1/models", "/api/tags", "/v1/props", "/props", "/version"]);
  assert.ok(model.calls.length <= 20 && model.calls.every(call => call.method === "GET" && metadataPaths.has(call.path)),
    `Only inert local metadata GETs are allowed (${model.calls.map(call => `${call.method} ${call.path}`).join(", ")}).`);
  console.log("PASS installed Hermes ACP initialize + session/new with isolated synthetic home");
  console.log(`PASS configured ${serverName} calls: ${configured.calls.length}; explicit same-name initialize/tools-list: ${explicit.calls.filter(call => call.rpc === "initialize" || call.rpc === "tools/list").map(call => call.rpc).join(", ")}`);
  if (memoryProposals) console.log("PASS unmodified Hermes discovers the actual proposal-only broker; no storage operation or approval tool exposed");
  console.log(`PASS ${model.calls.length} inert local metadata GETs; zero inference requests, prompts, or tool executions`);
  console.log("PASS isolated dummy provider and allowlisted environment; no external provider or inherited credentials configured");
} catch (error) {
  failure = error;
  console.error(`qa-hermes-mcp-isolation: FAILED: ${error instanceof Error ? error.message : String(error)}`);
  // All configuration and endpoints are synthetic; keep bounded diagnostics.
  if (stderr) console.error(stderr.replaceAll(scratch, "[temporary-home]"));
  process.exitCode = 1;
} finally {
  await stopChild();
  proposalBroker?.close();
  for (const { server } of fixtures) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  rmSync(scratch, { recursive: true, force: true });
}
if (!failure) console.log("qa-hermes-mcp-isolation: PASSED; temporary files and child process removed");
