#!/usr/bin/env node
// Fake of an ACP (Agent Client Protocol) CLI's stdio surface, for driver
// tests of acp/core.ts + its harness shims (grok, gemini). Speaks JSON-RPC
// 2.0 over stdin/stdout: answers initialize / authenticate / session/new /
// session/prompt, and streams session/update notifications for a scripted
// turn. Failure modes mirror how real ACP agents misbehave:
//
//   FAKE_ACP_MODE   happy (default) | slow | exit-early | hang | no-auth | permission
//                   | permission-once-only | mode-error
//                   | ask-peer (spawn the injected "agents" MCP server from
//                     session/new's mcpServers, call list_bots + ask_bot on a
//                     peer, and reply with what the peer said — the comms e2e)
//   FAKE_ACP_DUMP   path to write {argv, env, mcpServers} as JSON, so a test
//                   can assert argv shape (agent/stdio flags), env hygiene,
//                   and the session/new mcpServers list
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const mode = process.env.FAKE_ACP_MODE ?? "happy";
const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  console.log("fake-acp 1.0.0");
  process.exit(0);
}
if (process.env.FAKE_ACP_DUMP) {
  writeFileSync(process.env.FAKE_ACP_DUMP, JSON.stringify({ argv, env: process.env, pid: process.pid, promptCount: 0 }, null, 2));
}

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
const result = (id: unknown, res: unknown) => out({ jsonrpc: "2.0", id, result: res });

// pending server→client permission request id → resolver
let pendingPermissionId: number | null = null;
let onPermissionAnswered: (() => void) | null = null;
let selectedPermissionOption: string | null = null;
let sessionMode: string | null = null;

// ask-peer mode: the "agents" MCP server entry from session/new's mcpServers
type McpEntry = { command: string; args?: string[]; env?: Array<{ name: string; value: string }> };
let agentsMcp: McpEntry | null = null;
let seenMcpServers: McpEntry[] = [];
let promptCount = 0;
let pendingPromptId: number | null = null;

function dumpState() {
  if (!process.env.FAKE_ACP_DUMP) return;
  writeFileSync(
    process.env.FAKE_ACP_DUMP,
    JSON.stringify(
      { argv, env: process.env, pid: process.pid, promptCount, mcpServers: seenMcpServers, selectedPermissionOption, sessionMode },
      null,
      2,
    ),
  );
}

/** Minimal one-shot MCP stdio client: initialize, call each tool in
 * sequence, return the text of the last result. Dependency-free. */
function driveMcp(entry: McpEntry, calls: Array<{ name: string; args: (prev: string) => unknown }>): Promise<string> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const { name, value } of entry.env ?? []) env[name] = value;
    const child = spawn(entry.command, entry.args ?? [], { env, stdio: ["pipe", "pipe", "inherit"] });
    child.on("error", reject);
    const timer = setTimeout(() => (child.kill(), reject(new Error("mcp timeout"))), 60_000);
    let step = -1; // -1 = initialize in flight
    let last = "";
    const write = (obj: unknown) => child.stdin.write(JSON.stringify(obj) + "\n");
    const next = () => {
      step += 1;
      if (step >= calls.length) {
        clearTimeout(timer);
        child.kill();
        return resolve(last);
      }
      const call = calls[step];
      write({ jsonrpc: "2.0", id: step + 2, method: "tools/call", params: { name: call.name, arguments: call.args(last) } });
    };
    let buf = "";
    child.stdout.on("data", (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === undefined) continue;
        if (step === -1) {
          write({ jsonrpc: "2.0", method: "notifications/initialized" });
          next();
          continue;
        }
        last = String(msg.result?.content?.[0]?.text ?? "");
        next();
      }
    });
    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
  });
}

function scriptedTurn() {
  let tool: unknown = process.env.FAKE_ACP_TOOL ?? "";
  let rawInput = {};
  let reply = process.env.FAKE_ACP_REPLY ?? "";
  let title = "";
  let permission = mode === "permission" || mode === "permission-once-only" || mode === "permission-session-only";
  if (process.env.FAKE_ACP_SCRIPT) {
    try {
      const script = JSON.parse(readFileSync(process.env.FAKE_ACP_SCRIPT, "utf8"));
      if (Object.hasOwn(script, "tool")) tool = script.tool;
      if (script.rawInput && typeof script.rawInput === "object") rawInput = script.rawInput;
      if (typeof script.reply === "string") reply = script.reply;
      if (typeof script.title === "string") title = script.title;
      if (script.permission === false) permission = false;
      if (script.permission === true) permission = true;
    } catch {
      /* keep env fallbacks */
    }
  }
  if (process.env.FAKE_ACP_TOOL_INPUT) {
    try {
      rawInput = JSON.parse(process.env.FAKE_ACP_TOOL_INPUT);
    } catch {
      /* keep script/empty */
    }
  }
  return { tool, rawInput, reply, title, permission };
}

function playTurn(reply = "hello from fake acp") {
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: reply } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "run" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed" } } });
}

let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});

function handle(msg: any) {
  // client's response to our permission request
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && msg.id === pendingPermissionId) {
    selectedPermissionOption = msg.result?.outcome?.optionId ?? null;
    dumpState();
    pendingPermissionId = null;
    onPermissionAnswered?.();
    return;
  }
  if (!msg.method) return;

  switch (msg.method) {
    case "initialize": {
      if (mode === "exit-early") {
        process.stderr.write("fake-acp: simulated crash before result\n");
        process.exit(3);
      }
      const authMethods = mode === "no-auth" ? [] : [{ id: "cached_token" }];
      result(msg.id, { protocolVersion: 1, authMethods, _meta: { modelState: { currentModelId: "fake-acp-model" } } });
      break;
    }
    case "authenticate":
      result(msg.id, {});
      break;
    case "session/new": {
      const servers: McpEntry[] = Array.isArray(msg.params?.mcpServers) ? msg.params.mcpServers : [];
      seenMcpServers = servers;
      agentsMcp = servers.find((s: any) => s?.name === "agents") ?? null;
      dumpState();
      result(msg.id, { sessionId: "fake-acp-session" });
      break;
    }
    case "session/load":
      result(msg.id, {});
      break;
    case "session/set_mode":
      if (mode === "mode-error") {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "mode unsupported" } });
        break;
      }
      sessionMode = typeof msg.params?.modeId === "string" ? msg.params.modeId : null;
      dumpState();
      result(msg.id, {});
      break;
    case "session/prompt": {
      promptCount += 1;
      dumpState();
      if (mode === "hang") {
        // never resolve the prompt — lets tests exercise interrupt
        pendingPromptId = msg.id;
        setInterval(() => {}, 1_000);
        return;
      }
      const complete = () =>
        result(msg.id, { stopReason: "end_turn", _meta: { inputTokens: 10, outputTokens: 5 } });
      if (mode === "ask-peer" && agentsMcp) {
        // the comms e2e: reach a peer bot through the injected agents proxy
        // and reply with whatever it said (the peer's fake runs plain happy
        // — its depth-1 turn gets no agents server, so no recursion)
        void driveMcp(agentsMcp, [
          { name: "list_bots", args: () => ({}) },
          {
            name: "ask_bot",
            args: (list) => ({ bot_id: /id: ([\w-]+)/.exec(list)?.[1] ?? "", message: "ping from fake" }),
          },
        ])
          .then((reply) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `peer says: ${reply}` } } } });
            complete();
          })
          .catch((e) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `peer error: ${(e as Error).message}` } } } });
            complete();
          });
        return;
      }
      const script = scriptedTurn();
      playTurn(script.reply || "hello from fake acp");
      if (script.permission) {
        // ask the client to approve a tool, then complete once answered
        pendingPermissionId = 9001;
        onPermissionAnswered = complete;
        const computer = Boolean(script.tool);
        out({
          jsonrpc: "2.0",
          id: pendingPermissionId,
          method: "session/request_permission",
          params: {
            toolCall: computer
              ? {
                  kind: script.tool,
                  rawInput: script.rawInput,
                  title: script.title || script.tool,
                }
              : { kind: "execute", rawInput: { command: "echo hi" }, title: "echo hi" },
            options:
              mode === "permission-session-only"
                ? [
                    { optionId: "allow_session", kind: "allow_always", name: "Allow for session" },
                    { optionId: "reject", kind: "reject_once" },
                  ]
                : mode === "permission-once-only"
                ? [
                    { optionId: "allow-once", kind: "allow_once" },
                    { optionId: "reject", kind: "reject_once" },
                  ]
                : [
                    { optionId: "allow-once", kind: "allow_once" },
                    { optionId: "allow_session", kind: "allow_always", name: "Allow for session" },
                    { optionId: "reject", kind: "reject_once" },
                  ],
          },
        });
        return;
      }
      if (mode === "slow") {
        setTimeout(complete, 350);
        return;
      }
      complete();
      break;
    }
    case "session/cancel":
      // the interrupted prompt resolves as cancelled
      if (pendingPromptId !== null) {
        result(pendingPromptId, { stopReason: "cancelled" });
        pendingPromptId = null;
      }
      break;
    default:
      if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
}
