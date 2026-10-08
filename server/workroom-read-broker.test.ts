import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorkroomReadBroker } from "./workroom-read-broker.ts";
import type { LoopbackToolServer } from "./web-research-broker.ts";

describe("workroom read loopback broker", () => {
  let broker: LoopbackToolServer, root: string, turn: string | null;
  const capability = vi.fn();
  const headers = () => ({ "content-type": "application/json", ...Object.fromEntries(broker.descriptor.headers.map(item => [item.name, item.value])) });
  const rpc = async (method: string, params: unknown = {}) => {
    const response = await fetch(broker.descriptor.url, { method: "POST", headers: headers(), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(5000) });
    return (await response.json() as any).result;
  };
  const call = (args: unknown = { operation: "text", path: "sample.txt" }) => rpc("tools/call", { name: "workroom_read", arguments: args });
  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "realbud-workroom-broker-")));
    writeFileSync(join(root, "sample.txt"), "Fictional workroom evidence.\n");
    turn = "turn-1"; capability.mockReset();
    broker = await startWorkroomReadBroker({ root, turnId: () => turn, assertCapability: capability });
  });
  afterEach(() => { broker?.close(); rmSync(root, { recursive: true, force: true }); });

  it("lists exactly one read-only tool while idle, without entitlement or a read", async () => {
    turn = null;
    expect(broker.descriptor.name).toBe("workroom");
    expect(new URL(broker.descriptor.url).hostname).toBe("127.0.0.1");
    const tools = (await rpc("tools/list")).tools;
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual(["workroom_read"]);
    expect(tools[0].annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    expect((await call()).isError).toBe(true);
    expect(capability).not.toHaveBeenCalled();
  });

  it("reads fixture bytes as marked data with no approval or mutation, checking entitlement before and after", async () => {
    const files = readdirSync(root), original = readFileSync(join(root, "sample.txt"), "utf8");
    const result = await call();
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toMatch(/\[untrusted workroom data begin [0-9a-f]+\]/);
    expect(result.content[0].text).toContain("Fictional workroom evidence.");
    expect(capability).toHaveBeenCalledTimes(2);
    expect(readdirSync(root)).toEqual(files);
    expect(readFileSync(join(root, "sample.txt"), "utf8")).toBe(original);
  });

  it("refuses a wrong bearer before reading", async () => {
    const response = await fetch(broker.descriptor.url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fictional-wrong" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "workroom_read", arguments: { operation: "text", path: "sample.txt" } } }) });
    expect(response.status).toBe(403);
    expect(capability).not.toHaveBeenCalled();
  });

  it("rejects other tools and mutation-shaped arguments", async () => {
    for (const name of ["write_file", "execute_code", "workroom_write"]) expect((await rpc("tools/call", { name, arguments: { path: "sample.txt" } })).isError).toBe(true);
    for (const args of [{ operation: "delete", path: "sample.txt" }, { operation: "text", path: "sample.txt", code: "print(1)" }]) expect((await call(args)).isError).toBe(true);
    expect(readFileSync(join(root, "sample.txt"), "utf8")).toContain("Fictional workroom evidence.");
  });

  it("withholds the result when Stop, a new turn or lost entitlement lands during the read", async () => {
    // Stop: cancelPending aborts the in-flight call between the read and its reply.
    capability.mockImplementationOnce(() => {}).mockImplementationOnce(() => broker.cancelPending());
    let denied = await call();
    expect(denied.isError).toBe(true); expect(JSON.stringify(denied)).not.toContain("Fictional");
    capability.mockReset().mockImplementationOnce(() => { turn = "turn-2"; });
    denied = await call();
    expect(denied.isError).toBe(true); expect(JSON.stringify(denied)).not.toContain("Fictional");
    turn = "turn-2";
    capability.mockReset().mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error("fictional entitlement detail"); });
    denied = await call();
    expect(denied.isError).toBe(true); expect(JSON.stringify(denied)).not.toMatch(/Fictional|fictional entitlement detail/);
    capability.mockReset();
    expect((await call()).content[0].text).toContain("Fictional workroom evidence.");
  });

  it("refuses once the turn has stopped", async () => {
    turn = null;
    const denied = await call();
    expect(denied.isError).toBe(true); expect(JSON.stringify(denied)).not.toContain("Fictional");
  });

  it("keeps entitlement and file errors free of raw paths or private details", async () => {
    capability.mockImplementation(() => { throw new Error("fictional-key /synthetic/customer"); });
    let result = await call();
    expect(result.isError).toBe(true); expect(JSON.stringify(result)).not.toMatch(/fictional-key|synthetic\/customer|Fictional/);
    capability.mockReset();
    result = await call({ operation: "text", path: "missing-private-fixture.txt" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(root); expect(JSON.stringify(result)).not.toContain("missing-private-fixture");
  });

  it("returns fixed guidance so a rejected read can be corrected without running code", async () => {
    const result = await call({ operation: "text", path: "sample.txt", limit: 101 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/limit from 1 to 100/);
  });

  it("revokes the endpoint on close", async () => {
    broker.close(); broker.close();
    await expect(call()).rejects.toThrow();
  });
});
