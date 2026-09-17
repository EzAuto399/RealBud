#!/usr/bin/env node
// ACP smoke: does a worker accept RealBud's initialize handshake?
//
// This is the gate the Hermes promotion procedure requires before a release can
// become HERMES_RECOMMENDED. RealBud opens a session with
//   {protocolVersion: 1, clientCapabilities: {fs: {readTextFile:false, writeTextFile:false}}}
// (server/drivers/acp/core.ts:637) and then reads `authMethods` off the reply, so a
// candidate that cannot answer that specific request is unusable however new it is.
//
// Frames are newline-delimited JSON-RPC on stdio (core.ts:312).
//
// Usage:
//   node scripts/qa-acp-smoke.mjs <label>=<command> [<label>=<command> ...]
// where <command> is the worker CLI, optionally with args, e.g.
//   "0.21.2=/path/to/venv/bin/hermes --profile property"
import { spawn } from "node:child_process";

const INIT_TIMEOUT_MS = Number(process.env.ACP_SMOKE_TIMEOUT_MS ?? 45_000);
const targets = process.argv.slice(2);
if (!targets.length) {
  console.error("Usage: node scripts/qa-acp-smoke.mjs <label>=<command ...> [...]");
  process.exit(2);
}

/** Run one ACP initialize against one worker. Resolves to a plain result object. */
function smoke(label, command) {
  return new Promise(resolve => {
    // No shell: the command is split on spaces so a path with arguments works
    // without inventing a parsing language.
    const [bin, ...args] = command.split(" ").filter(Boolean);
    const started = Date.now();
    const child = spawn(bin, [...args, "acp"], { stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    let stderr = "";
    let settled = false;
    const done = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGTERM"); } catch {}
      resolve({ label, elapsedMs: Date.now() - started, ...result });
    };
    const timer = setTimeout(() => done({ ok: false, error: `no initialize reply within ${INIT_TIMEOUT_MS}ms`, stderr: stderr.slice(-400) }), INIT_TIMEOUT_MS);

    child.on("error", error => done({ ok: false, error: `spawn failed: ${error.message}` }));
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.on("exit", code => { if (!settled) done({ ok: false, error: `exited early with code ${code}`, stderr: stderr.slice(-400) }); });

    child.stdout.on("data", chunk => {
      buffer += String(chunk);
      // Newline-delimited frames; keep the remainder for the next chunk.
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== 1) continue;
        if (message.error) { done({ ok: false, error: `initialize error: ${JSON.stringify(message.error).slice(0, 200)}` }); return; }
        // A reply that carries neither result nor error is not an answer. Treating it
        // as success would let a worker that ignores initialize pass the smoke.
        if (!message.result || typeof message.result !== "object") {
          done({ ok: false, error: `initialize reply had no result: ${line.slice(0, 160)}` });
          return;
        }
        const result = message.result;
        done({
          ok: true,
          protocolVersion: result.protocolVersion ?? null,
          authMethods: Array.isArray(result.authMethods) ? result.authMethods.map(m => m?.id ?? "?").slice(0, 6) : [],
          agentName: result.agentInfo?.name ?? result.agentCapabilities?.name ?? null,
        });
      }
    });

    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
    }) + "\n");
  });
}

console.log("RealBud ACP smoke — does the worker answer our initialize?\n");
let failures = 0;
for (const target of targets) {
  const at = target.indexOf("=");
  const label = target.slice(0, at);
  const command = target.slice(at + 1);
  const result = await smoke(label, command);
  if (!result.ok) {
    failures += 1;
    console.log(`FAIL  ${label} — ${result.error}`);
    if (result.stderr) console.log(`        stderr: ${result.stderr.replace(/\n/g, " ").slice(0, 200)}`);
    continue;
  }
  // The two things RealBud depends on: it must negotiate protocol 1, and it must
  // offer authMethods for pickAuthMethod to choose from (null is legal for the
  // hermes driver, whose pickAuthMethod returns null, so this is informational).
  const protocolOk = result.protocolVersion === 1;
  if (!protocolOk) failures += 1;
  console.log(
    `${protocolOk ? "ok   " : "FAIL "} ${label} — protocolVersion=${result.protocolVersion} ` +
    `authMethods=[${result.authMethods.join(", ")}] agent=${result.agentName} (${result.elapsedMs}ms)`,
  );
}

console.log(failures ? `\n${failures} check(s) failed` : "\nALL GREEN — worker accepts RealBud's ACP handshake");
process.exit(failures ? 1 : 0);
