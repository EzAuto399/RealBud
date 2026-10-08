#!/usr/bin/env node
// A dependency-free stand-in for `cua-driver mcp`: line-delimited JSON-RPC on
// stdio, answering in the real 0.22.1 shape. Env-driven:
//   FAKE_CUA_FIXTURE  path to a get_window_state structured result
//                     (default: fixtures/cua-0.22.1-calculator-window-state.json)
//   FAKE_CUA_WINDOWS  JSON list_windows `windows` array (default: the fixture's Calculator window)
//   FAKE_CUA_RECORD   file to append one JSON line {name, arguments} per tools/call
//   FAKE_CUA_PNG_SIZE "WxH": get_window_state with include_screenshot returns a
//                     synthetic PNG header of that size as an image content block
//   FAKE_CUA_PNG_BYTES pad that PNG to this many bytes, unless the call asks for max_dimension
//                     (then the header is scaled to fit it; FAKE_CUA_MODE=reject-max-dimension refuses that field, as 0.22.1 would)
//   FAKE_CUA_MODE     happy (default) | exit-on-click | reject-capture-scope | hang-click | hang-start | exit-on-start | reject-max-dimension
//   (FAKE_CUA_RECORD also gets a sibling "<record>.pid" holding this process id, so a test can see it exit)
// Every read bumps snapshot_id and rewrites element tokens, so older tokens go stale, as in the driver.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const fixture = JSON.parse(readFileSync(process.env.FAKE_CUA_FIXTURE || new URL("./fixtures/cua-0.22.1-calculator-window-state.json", import.meta.url), "utf8"));
const windows = process.env.FAKE_CUA_WINDOWS ? JSON.parse(process.env.FAKE_CUA_WINDOWS)
  : [{ window_id: 2001, pid: 1001, app_name: "Calculator", title: "Calculator", bounds: { x: 1270, y: 719, width: 230, height: 408 }, is_on_screen: true }];
const mode = process.env.FAKE_CUA_MODE || "happy";
let snapshot = 0;
if (process.env.FAKE_CUA_RECORD) writeFileSync(`${process.env.FAKE_CUA_RECORD}.pid`, String(process.pid));

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
const ok = (structuredContent, text = "ok", extra = []) => ({ content: [{ type: "text", text }, ...extra], structuredContent });
const fail = (text) => ({ content: [{ type: "text", text }], isError: true });

function png(maxDimension) {
  let [w, h] = (process.env.FAKE_CUA_PNG_SIZE || "").split("x").map(Number);
  const fit = maxDimension ? Math.min(1, maxDimension / Math.max(w, h)) : 1;
  w = Math.round(w * fit); h = Math.round(h * fit);
  const head = Buffer.alloc(maxDimension ? 33 : Math.max(33, Number(process.env.FAKE_CUA_PNG_BYTES) || 0));
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(head, 0);
  head.writeUInt32BE(w, 16); head.writeUInt32BE(h, 20);
  return head.toString("base64");
}

function windowState(args) {
  snapshot += 1;
  const id = `s${snapshot.toString(16).padStart(8, "0")}`;
  const elements = fixture.elements.map((row) => ({ ...row, element_token: `${id}:${row.element_index}` }));
  const image = args.include_screenshot !== false && process.env.FAKE_CUA_PNG_SIZE ? [{ type: "image", data: png(args.max_dimension), mimeType: "image/png" }] : [];
  return ok({ ...fixture, snapshot_id: id, elements, pid: args.pid, window_id: args.window_id }, fixture.tree_markdown ?? "", image);
}

function call(name, args) {
  if (process.env.FAKE_CUA_RECORD) appendFileSync(process.env.FAKE_CUA_RECORD, `${JSON.stringify({ name, arguments: args })}\n`);
  if (name === "start_session" && mode === "hang-start") return null;
  if (name === "start_session" && mode === "exit-on-start") process.exit(3);
  if (name === "start_session") return mode === "reject-capture-scope" && "capture_scope" in args ? fail("unknown field capture_scope") : ok({ session: args.session });
  if (name === "end_session") return ok({ ended: true });
  if (name === "list_windows") return ok({ windows: windows.filter((row) => args.pid === undefined || row.pid === args.pid) });
  if (name === "get_window_state" && mode === "reject-max-dimension" && "max_dimension" in args) return fail("unknown field max_dimension");
  if (name === "get_window_state") return windowState(args);
  if (name === "click" && mode === "exit-on-click") process.exit(3);
  if (name === "click" && mode === "hang-click") return null;
  if (["click", "type_text", "scroll", "press_key"].includes(name)) {
    const prefix = `s${snapshot.toString(16).padStart(8, "0")}:`;
    if (typeof args.element_token === "string" && !args.element_token.startsWith(prefix)) return fail("stale element_token");
    return ok({ effect: "attempted" });
  }
  return fail(`unknown tool ${name}`);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  if (msg.method === "initialize") { send({ id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-cua", version: "0.22.1" } } }); return; }
  if (msg.method !== "tools/call") { send({ id: msg.id, error: { code: -32601, message: "Method not found" } }); return; }
  const result = call(msg.params?.name, msg.params?.arguments ?? {});
  if (result) send({ id: msg.id, result });
});
