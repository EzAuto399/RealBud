// The cua-driver stdio client against the dependency-free fake proxy.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startCuaClient, type CuaClient } from "./cua-client.ts";

const FAKE = fileURLToPath(new URL("./testing/fake-cua-mcp.mjs", import.meta.url));
const recordFile = () => join(mkdtempSync(join(tmpdir(), "rb-cua-client-")), "calls.jsonl");
const calls = (file: string) => { try { return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
let client: CuaClient | undefined;
afterEach(() => { client?.close(); client = undefined; });
const start = (env: Record<string, string>) => startCuaClient({ command: process.execPath, args: [FAKE], env });

describe("cua client", () => {
  it("initializes and calls a broker tool, and refuses any other tool before sending it", async () => {
    const file = recordFile();
    client = await start({ FAKE_CUA_RECORD: file });
    const read = await client.call("get_window_state", { pid: 1001, window_id: 2001, include_screenshot: false });
    expect(read.structuredContent?.snapshot_id).toBe("s00000001");
    for (const name of ["set_value", "invoke_menu", "launch_app", "install_extension", "browser_click"]) {
      await expect(client.call(name as never, {})).rejects.toThrow("Bud does not use this desktop tool.");
    }
    expect(calls(file).map(row => row.name)).toEqual(["get_window_state"]);
  });

  it("fails closed when the proxy exits: the pending call and every later call reject, nothing restarts", async () => {
    client = await start({ FAKE_CUA_MODE: "exit-on-click" });
    await expect(client.call("click", { pid: 1001, window_id: 2001, element_token: "s00000001:2" })).rejects.toThrow("The desktop helper stopped.");
    expect(client.closed).toBe(true);
    await expect(client.call("get_window_state", { pid: 1001, window_id: 2001 })).rejects.toThrow("The desktop helper stopped.");
  });

  it("times out and aborts one call without retrying it", async () => {
    const file = recordFile();
    client = await start({ FAKE_CUA_MODE: "hang-click", FAKE_CUA_RECORD: file });
    await expect(client.call("click", { pid: 1001, window_id: 2001 }, { timeoutMs: 50 })).rejects.toThrow("took too long");
    const stop = new AbortController();
    const pending = client.call("click", { pid: 1001, window_id: 2001 }, { signal: stop.signal });
    stop.abort();
    await expect(pending).rejects.toThrow("Stopped.");
    // The proxy handles lines in order, so once a later read answers, both clicks
    // (and any retry, which would have been sent first) are recorded.
    await client.call("get_window_state", { pid: 1001, window_id: 2001 });
    expect(calls(file).filter(row => row.name === "click")).toHaveLength(2);
    expect(client.closed).toBe(false);
  });
});
