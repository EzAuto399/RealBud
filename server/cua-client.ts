// A stdio MCP client for the cua-driver proxy (`cua-driver mcp --embedded
// --socket <path>`, the descriptor readCuaConnection() returns). Line-delimited
// JSON-RPC 2.0. It sends only the desktop broker's tools and refuses any other
// name locally. Fails closed: once the proxy exits, errors or overflows, every
// pending and later call rejects; nothing is retried or restarted here.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { LocalComputerConnection } from "./local-computer.ts";
import { serviceSafeChildEnv } from "./service-child-env.ts";

/** The only driver tools RealBud's desktop broker sends. */
export const CUA_CLIENT_TOOLS = ["start_session", "end_session", "list_windows", "get_window_state", "click", "type_text", "scroll", "press_key"] as const;
export type CuaToolName = (typeof CUA_CLIENT_TOOLS)[number];
/** A tools/call result as the driver sends it (content may carry an image). */
export interface CuaToolResult { content?: Array<Record<string, unknown>>; structuredContent?: Record<string, unknown>; isError?: boolean }
export interface CuaClient {
  call(name: CuaToolName, args: Record<string, unknown>, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<CuaToolResult>;
  close(): void;
  readonly closed: boolean;
}

const ALLOWED = new Set<string>(CUA_CLIENT_TOOLS);
const DEFAULT_TIMEOUT_MS = 15_000;
/** A screenshot answer is a few MB of base64; anything far beyond is not a driver answer.
 * ponytail: readline buffers a whole line before this check; a byte-counting reader if the helper is ever untrusted. */
const MAX_LINE = 32 * 1024 * 1024;
const GONE = "The desktop helper stopped. Bud did nothing more in the window.";

export async function startCuaClient(connection: LocalComputerConnection, options: { timeoutMs?: number } = {}): Promise<CuaClient> {
  const child = spawn(connection.command, connection.args, { env: serviceSafeChildEnv(connection.env), stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let next = 1, dead = false;
  const fail = () => {
    if (dead) return;
    dead = true;
    for (const waiter of pending.values()) waiter.reject(new Error(GONE));
    pending.clear();
    child.kill();
  };
  child.once("exit", fail);
  child.once("error", fail);
  child.stdin.on("error", fail);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", line => {
    if (line.length > MAX_LINE) { fail(); return; }
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    const waiter = typeof msg?.id === "number" ? pending.get(msg.id) : undefined;
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error("The desktop helper refused this step.")); else waiter.resolve(msg.result);
  });

  const request = (method: string, params: unknown, signal?: AbortSignal, timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS) => new Promise<unknown>((resolve, reject) => {
    if (dead) { reject(new Error(GONE)); return; }
    if (signal?.aborted) { reject(new Error("Stopped.")); return; }
    const id = next++;
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); pending.delete(id); };
    const abort = () => { done(); reject(new Error("Stopped.")); };
    // A late answer to a timed-out or aborted call is dropped (its id is gone).
    const timer = setTimeout(() => { done(); reject(new Error("The desktop helper took too long. Read the window again before the next step.")); }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    pending.set(id, { resolve: value => { done(); resolve(value); }, reject: error => { done(); reject(error); } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

  try {
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "RealBud", version: "1" } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  } catch (error) { fail(); throw error; }

  return {
    get closed() { return dead; },
    close: fail,
    async call(name, args, callOptions = {}) {
      if (!ALLOWED.has(name)) throw new Error("Bud does not use this desktop tool.");
      const result = await request("tools/call", { name, arguments: args }, callOptions.signal, callOptions.timeoutMs);
      return (result && typeof result === "object" ? result : {}) as CuaToolResult;
    },
  };
}
