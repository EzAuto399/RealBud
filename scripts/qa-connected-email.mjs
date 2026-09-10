#!/usr/bin/env node
// Real Hermes agent, real RealBud broker, synthetic mail service. Never a live-mail proof.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "realbud-email-canary-"));
process.env.REALBUD_DATA_DIR = scratch;
const key = `ck_${randomUUID()}`;
const account = `fixture_${randomUUID().replaceAll("-", "")}`;
const reference = `MAIL-${randomUUID()}`;
const calls = [];
let instance, recorder, unsubscribe;
let approved = 0;
const tools = [
  { name: "COMPOSIO_SEARCH_TOOLS", description: "Discover tools for this fictional PM email task.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "COMPOSIO_GET_TOOL_SCHEMAS", description: "Get authoritative input schemas before execution.", inputSchema: { type: "object", properties: { tool_slugs: { type: "array", items: { type: "string" } } }, required: ["tool_slugs"] } },
  { name: "COMPOSIO_MULTI_EXECUTE_TOOL", description: "Execute discovered tools. Only the explicitly selected fixture account can be read.", inputSchema: { type: "object", properties: { tools: { type: "array", items: { type: "object", properties: { tool_slug: { type: "string" }, arguments: { type: "object" } }, required: ["tool_slug", "arguments"] } } }, required: ["tools"] } },
];
const result = data => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const server = createServer(async (req, res) => {
  if (req.headers["x-consumer-api-key"] !== key) { res.writeHead(401).end(); return; }
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 32_000) { res.writeHead(413).end(); return; } }
  const msg = JSON.parse(raw);
  calls.push({ method: msg.method, tool: msg.params?.name });
  if (msg.id === undefined) { res.writeHead(202).end(); return; }
  let body;
  if (msg.method === "initialize") body = { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "Fictional PM email", version: "1" } };
  else if (msg.method === "tools/list") body = { tools };
  else if (msg.method === "ping") body = {};
  else if (msg.params?.name === "COMPOSIO_SEARCH_TOOLS") body = result({ tools: [{ tool_slug: "FIXTURE_EMAIL_READ", description: "Read up to 10 fictional email threads for the selected account." }] });
  else if (msg.params?.name === "COMPOSIO_GET_TOOL_SCHEMAS") body = result({ tools: [{ tool_slug: "FIXTURE_EMAIL_READ", input_schema: {
    type: "object", properties: { account_id: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 10 } }, required: ["account_id", "limit"],
  } }] });
  else if (msg.params?.name === "COMPOSIO_MULTI_EXECUTE_TOOL") {
    const selected = msg.params.arguments.tools;
    if (!Array.isArray(selected) || selected.length !== 1 || selected[0].tool_slug !== "FIXTURE_EMAIL_READ" || selected[0].arguments.account_id !== account || selected[0].arguments.limit > 10) {
      body = { ...result({ successful: false, error: "Only the chosen fixture account and at most 10 threads are allowed." }), isError: true };
    } else body = result({ successful: true, results: [{ tool_slug: "FIXTURE_EMAIL_READ", response: { successful: true, data: {
      sample: true, account_id: account, reference, threads: [
        { id: "training-thread-1", url: "https://mail.example.invalid/thread/1", property: "Fictional Acacia Cottage", from: "tenant@example.invalid", subject: "Kitchen tap repair", body: "The tap still drips. Can you confirm the plumber's visit?", accessConfirmed: false },
        { id: "training-thread-2", url: "https://mail.example.invalid/thread/2", property: "Fictional Acacia Cottage", from: "plumber@example.invalid", subject: "Kitchen tap quote", body: "Quote is AUD 185. Awaiting confirmation of an access time." },
      ],
    } } }] });
  } else body = { ...result({ error: "Unknown fixture operation" }), isError: true };
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: body }));
});

try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { ensureDirs, NATIVE_DIR } = await import("../server/config.ts"); ensureDirs();
  const { HermesAgentDriver } = await import("../server/drivers/acp/hermes.ts");
  const { recordEvents } = await import("../server/testing/events.ts");
  const { listConnectedAppOperations } = await import("../server/connected-app-operations.ts");
  instance = await HermesAgentDriver.create({ instanceId: "email-canary", displayName: "Email canary", enabled: true, environment: {}, config: HermesAgentDriver.defaultConfig() });
  recorder = recordEvents(instance.adapter);
  unsubscribe = instance.adapter.onEvent(event => {
    if (event.type !== "request.opened") return;
    const fixtureRead = event.tool === "bud_connected_app_action" && event.summary.includes("FIXTURE_EMAIL_READ") && event.summary.includes(account) && !/SEND|DELETE|UPDATE|CREATE/.test(event.summary);
    if (fixtureRead) approved++;
    void instance.adapter.respondToRequest(event.threadId, event.requestId, { behavior: fixtureRead ? "allow" : "deny", scope: "once" });
  });
  const { turnId } = await instance.adapter.sendTurn({ threadId: "email-canary", text:
    `This is a training-only PM email workflow. Use the connected-apps MCP tools: first COMPOSIO_SEARCH_TOOLS, then COMPOSIO_GET_TOOL_SCHEMAS, then COMPOSIO_MULTI_EXECUTE_TOOL exactly once for FIXTURE_EMAIL_READ, account_id ${account}, limit 10. Read the two fictional threads and group the follow-ups by property. Return the exact tool-only reference, source thread IDs/links, the quote amount and the missing access confirmation, plus short reply drafts here. Do not send, save mailbox drafts, mark read or change anything. Do not use other tools or files. State this is training data.`,
    integrations: { composio: { key, url: `http://127.0.0.1:${server.address().port}/mcp` } },
  });
  const done = await recorder.until(event => event.type === "turn.completed" && event.turnId === turnId, 150_000);
  assert.equal(done.ok, true, "Hermes must finish the task");
  const output = recorder.events.filter(event => event.turnId === turnId && event.type === "item.completed" && event.itemType === "assistant_text").map(event => event.text).join("\n");
  const toolCalls = calls.filter(call => call.tool).map(call => call.tool);
  assert.ok(toolCalls.indexOf("COMPOSIO_SEARCH_TOOLS") < toolCalls.indexOf("COMPOSIO_GET_TOOL_SCHEMAS"));
  assert.ok(toolCalls.indexOf("COMPOSIO_GET_TOOL_SCHEMAS") < toolCalls.indexOf("COMPOSIO_MULTI_EXECUTE_TOOL"));
  assert.equal(toolCalls.filter(name => name === "COMPOSIO_MULTI_EXECUTE_TOOL").length, 1);
  assert.equal(approved, 1);
  assert.ok(output.includes(reference), "exact unpredictable reference must come from the tool result");
  assert.match(output, /185/);
  assert.match(output, /training|fictional/i);
  assert.match(output, /access|confirmation/i);
  assert.match(output, /training-thread-1|\/thread\/1/);
  assert.match(output, /training-thread-2|\/thread\/2/);
  const receipts = listConnectedAppOperations("email-canary");
  const read = receipts.find(row => row.toolSlugs.includes("FIXTURE_EMAIL_READ"));
  assert.equal(read?.status, "succeeded");
  assert.ok(!JSON.stringify(receipts).includes(account) && !JSON.stringify(receipts).includes(reference), "receipt ledger must exclude mailbox arguments/results");
  assert.ok(!readFileSync(join(NATIVE_DIR, "email-canary.ndjson"), "utf8").includes(key));
  console.log(JSON.stringify({ proof: "real Hermes with fictional email MCP", tools: toolCalls, approvedReadCalls: approved,
    receiptStates: receipts.map(row => ({ toolName: row.toolName, status: row.status })), draft: output, liveMailboxReads: 0, externalWrites: 0 }, null, 2));
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : "email canary failed"}`);
  process.exitCode = 1;
} finally {
  unsubscribe?.(); recorder?.stop(); await instance?.dispose();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  rmSync(scratch, { recursive: true, force: true });
}
