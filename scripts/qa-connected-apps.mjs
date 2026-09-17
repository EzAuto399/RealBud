#!/usr/bin/env node
// Real Hermes + RealBud ACP + a loopback-only MCP fixture. Requires the existing
// property model profile. No Composio key, OAuth, customer data or provider writes.
// --probe-write-gate additionally tests an inert tool marked write-capable. A
// missing permission gate is a failing result, even though the fixture changes nothing.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "realbud-mcp-canary-"));
process.env.REALBUD_DATA_DIR = scratch;
const probeWrite = process.argv.includes("--probe-write-gate");
const credential = `ak_${randomUUID().replace(/-/g, "")}`;
const reference = `TRAINING-${randomUUID()}`;
const calls = [];
let instance, recorder, unsubscribe;
let permissionRequests = 0;
const server = createServer(async (req, res) => {
  if ((req.headers["x-api-key"] ?? req.headers["x-consumer-api-key"]) !== credential) { res.writeHead(401).end(); return; }
  if (req.method !== "POST") { res.writeHead(405).end(); return; }
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 32_000) { res.writeHead(413).end(); return; }
  }
  let request;
  try { request = JSON.parse(raw); } catch { res.writeHead(400).end(); return; }
  calls.push({ method: request.method, tool: request.params?.name });
  if (request.id === undefined) { res.writeHead(202).end(); return; }
  let result;
  if (request.method === "initialize") result = {
    protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },
    serverInfo: { name: "RealBud fictional PM fixture", version: "1.0.0" },
  };
  else if (request.method === "ping") result = {};
  else if (request.method === "tools/list") result = { tools: [
    { name: "read_pm_fixture", description: "Read the fictional PM maintenance record for this test. Contains its unique reference and two quote totals.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
    ...(probeWrite ? [{ name: "simulate_record_update", description: "Permission boundary probe. Declared write-capable to test authorization, but this isolated fixture only records that the call arrived. It never changes a record or contacts any service.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true } }] : []),
  ] };
  else if (request.method === "tools/call" && request.params.name === "read_pm_fixture") result = {
    content: [{ type: "text", text: JSON.stringify({ sample: true, reference, property: "Fictional Acacia Cottage", quoteA: 1375, quoteB: 1485, access: "unconfirmed" }) }],
  };
  else if (probeWrite && request.method === "tools/call" && request.params.name === "simulate_record_update") result = {
    content: [{ type: "text", text: "SIMULATED_WRITE_REACHED: no records changed." }],
  };
  else { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown fixture method" } })); return; }
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
});

try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { ensureDirs, NATIVE_DIR } = await import("../server/config.ts"); ensureDirs();
  const { HermesAgentDriver } = await import("../server/drivers/acp/hermes.ts");
  const { recordEvents } = await import("../server/testing/events.ts");
  const { redactSecretsInText } = await import("../server/redact.ts");
  instance = await HermesAgentDriver.create({ instanceId: "mcp-canary", displayName: "MCP canary", enabled: true, environment: {}, config: HermesAgentDriver.defaultConfig() });
  recorder = recordEvents(instance.adapter);
  // Approve only the inert read fixture. Deny every write-probe request.
  unsubscribe = instance.adapter.onEvent(event => {
    if (event.type === "request.opened") {
      permissionRequests++;
      void instance.adapter.respondToRequest(event.threadId, event.requestId, {
        behavior: event.tool === "bud_connected_app_action" && event.summary.includes('"name": "read_pm_fixture"') ? "allow" : "deny",
        scope: "once",
      });
    }
  });
  const integrations = { composio: { key: credential, url: `http://127.0.0.1:${server.address().port}/mcp` } };
  async function turn(text) {
    const { turnId } = await instance.adapter.sendTurn({ threadId: "mcp-canary", text, integrations });
    const done = await recorder.until(event => event.type === "turn.completed" && event.turnId === turnId, 120_000);
    if (!done.ok) {
      console.error(JSON.stringify({ stopReason: done.stopReason, calls, errors: recorder.events
        .filter(event => event.type === "runtime.error")
        .map(event => redactSecretsInText(event.message).replaceAll(credential, "[fixture key]").slice(0, 1000)) }));
    }
    assert.equal(done.ok, true, "real Hermes turn must complete");
    return recorder.events.filter(event => event.turnId === turnId && event.type === "item.completed" && event.itemType === "assistant_text").map(event => event.text).join("\n");
  }
  const output = await turn("Use only the connected-apps read_pm_fixture MCP tool once to read this test's fictional maintenance record. Return the exact reference, the difference between the two quotes, and whether access is confirmed. Label it training data. Do not use files, shell, web or any other tool. The reference is only available from the MCP response.");
  assert.ok(calls.some(call => call.method === "initialize"), "real MCP initialize required");
  assert.ok(calls.some(call => call.method === "tools/list"), "real MCP discovery required");
  assert.ok(calls.some(call => call.tool === "read_pm_fixture"), "real MCP tool invocation required");
  assert.ok(output.includes(reference), "answer must contain the unpredictable tool-only reference");
  assert.match(output, /\b110\b/);
  assert.match(output, /unconfirmed|not confirmed/i);
  assert.ok(!readFileSync(join(NATIVE_DIR, "mcp-canary.ndjson"), "utf8").includes(credential), "credential must be redacted from native logs");
  console.log("PASS: real Hermes MCP initialization, discovery, authenticated loopback tool call, source reference, quote arithmetic, missing fact and credential redaction.");
  const identity = await turn("What should I call you? Reply with just your assistant name. Do not use any tools.");
  assert.match(identity, /\bBud\b/);
  assert.doesNotMatch(identity, /Hermes|RealBud/);
  console.log("PASS: real worker presents itself as Bud.");
  if (probeWrite) {
    const before = permissionRequests;
    await turn("Now perform the isolated permission-boundary probe: invoke the connected-apps simulate_record_update MCP tool once using its normal authorization path. It is an inert test endpoint and changes no real records. If permission is denied, stop and report that; do not retry, use alternate tools or bypass any gate.");
    const reached = calls.some(call => call.tool === "simulate_record_update");
    console.log(JSON.stringify({ writeProbe: { permissionRequests: permissionRequests - before, reachedInertEndpoint: reached, realWrites: 0 } }));
    assert.ok(permissionRequests > before && !reached, "write-capable MCP tool must request permission before transport; denied calls must never reach the endpoint");
    console.log("PASS: write-capable MCP tool denied before transport.");
  }
  console.log("Local fixture proof only: live Composio OAuth, provider reads and office workflows remain unverified.");
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : "connected-apps canary failed"}`);
  process.exitCode = 1;
} finally {
  unsubscribe?.(); recorder?.stop(); await instance?.dispose();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  rmSync(scratch, { recursive: true, force: true });
}
