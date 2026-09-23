import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createWindowsCuaHost, WINDOWS_CUA_HOST_FLAG, WINDOWS_CUA_METADATA } from "./cua-windows-host.mjs";

const owned = [];
afterEach(async () => { for (const fixture of owned.splice(0)) { fixture.child?.exit(0); await fixture.host.stop().catch(() => {}); fixture.host.uniffiDestroy(); } });
const identity = child => ({ schema: "realbud-cua-host", version: 1, supervisorPid: child.pid, driverPid: child.pid + 1 });
const metadata = child => ({ ...WINDOWS_CUA_METADATA, pid: child.pid + 1, embedded: true, hostBundleId: "com.realbud.app" });
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture({ record = child => JSON.stringify(identity(child)) + "\n", getMetadata = child => metadata(child), autoStop = true, forceStops = true, ...options } = {}) {
  const value = { clients: [], transmitted: [] };
  let nextPid = 8000;
  value.spawnProcess = vi.fn(() => {
    const child = new EventEmitter(); child.pid = nextPid; nextPid += 2;
    child.exitCode = null; child.signalCode = null; child.stdin = new PassThrough(); child.stdout = new PassThrough();
    child.stdin.on("data", bytes => value.transmitted.push(bytes));
    child.exit = (code, signal = null) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.exitCode = code; child.signalCode = signal;
      child.emit("exit", code, signal); child.stdout.end();
    };
    child.kill = vi.fn(() => { if (forceStops) queueMicrotask(() => child.exit(null, "SIGTERM")); return forceStops; });
    child.stdin.on("finish", () => { if (autoStop) queueMicrotask(() => child.exit(0)); });
    value.child = child;
    queueMicrotask(() => { const line = record(child); if (line !== null) child.stdout.write(line); });
    return child;
  });
  value.sdk = { CuaDriver: { connect: vi.fn(() => {
    const child = value.child;
    const client = { metadata: vi.fn(async options => getMetadata(child, options)), uniffiDestroy: vi.fn() };
    value.clients.push(client); return client;
  }) } };
  value.host = createWindowsCuaHost(value.sdk, "C:\\Fictional\\RealBud CUA.exe", "C:\\Fictional\\cua-driver.exe", "com.realbud.app", {
    spawnProcess: value.spawnProcess, startupTimeoutMs: 1000, shutdownTimeoutMs: 100, forceTimeoutMs: 100,
    environment: { SystemRoot: "C:\\Windows", PATH: "fictional-path", CUA_DRIVER_POLICY_FILE: "fictional-policy", NODE_OPTIONS: "fictional-untrusted", FICTIONAL_SECRET: "not-a-real-secret" },
    processId: 4000, ...options,
  });
  owned.push(value); return value;
}

describe("Windows CUA supervised host", () => {
  it("coalesces startup, validates the real driver PID, and publishes the real MCP command", async () => {
    const f = fixture();
    const first = f.host.start(); expect(f.host.start()).toBe(first);
    const connection = await first;
    expect(connection.pid).toBe(f.child.pid + 1); expect(connection.pid).not.toBe(f.child.pid);
    expect(connection.socketPath).toMatch(/^\\\\\.\\pipe\\realbud-cua-4000-[\da-f-]+$/);
    expect(connection.mcp.command).toBe("C:\\Fictional\\cua-driver.exe");
    expect(f.host.connection()).toBe(connection); expect(f.host.state()).toBe(2);
    expect(f.clients[0].uniffiDestroy).toHaveBeenCalledTimes(1);
    const [program, argv, settings] = f.spawnProcess.mock.calls[0];
    expect(program).toBe("C:\\Fictional\\RealBud CUA.exe");
    expect(argv).toEqual([WINDOWS_CUA_HOST_FLAG, "serve", "--embedded", "--parent-liveness-stdio", "--no-permissions-gate", "--socket", connection.socketPath, "--host-bundle-id", "com.realbud.app", "--permission-mode", "standard"]);
    expect(settings).toMatchObject({ shell: false, windowsHide: true, stdio: ["pipe", "pipe", "inherit"] });
    expect(settings.env).toEqual({ SYSTEMROOT: "C:\\Windows", PATH: "fictional-path", CUA_DRIVER_POLICY_FILE: "fictional-policy", CUA_DRIVER_EMBEDDED_HOST_PID: "4000" });
    const stopped = f.host.stop(); expect(f.host.stop()).toBe(stopped);
    await stopped;
    expect(f.transmitted).toEqual([]); expect(f.host.connection()).toBeUndefined(); expect(f.host.state()).toBe(0);
    expect(f.child.kill).not.toHaveBeenCalled();
  });

  it.each([
    ["foreign supervisor", child => JSON.stringify({ ...identity(child), supervisorPid: child.pid + 20 }) + "\n"],
    ["wrapper substituted for driver", child => JSON.stringify({ ...identity(child), driverPid: child.pid }) + "\n"],
    ["invalid PID", child => JSON.stringify({ ...identity(child), driverPid: -2 }) + "\n"],
    ["future protocol", child => JSON.stringify({ ...identity(child), version: 2 }) + "\n"],
    ["additional authority", child => JSON.stringify({ ...identity(child), other: true }) + "\n"],
    ["duplicate record", child => (JSON.stringify(identity(child)) + "\n").repeat(2)],
    ["oversized record", () => "x".repeat(513)],
    ["invalid JSON", () => "not-json\n"],
  ])("rejects %s before any SDK connection", async (_label, record) => {
    const f = fixture({ record });
    await expect(f.host.start()).rejects.toThrow(/identity record|startup was stopped/);
    expect(f.sdk.CuaDriver.connect).not.toHaveBeenCalled(); expect(f.host.connection()).toBeUndefined(); expect(f.host.state()).toBe(0);
  });

  it("accepts a split bounded identity line but rejects any later supervisor stdout", async () => {
    const f = fixture({ record: child => {
      const line = JSON.stringify(identity(child)) + "\n";
      child.stdout.write(line.slice(0, 20)); return line.slice(20);
    } });
    await f.host.start();
    f.child.stdout.write("second record\n");
    expect(f.host.connection()).toBeUndefined();
    await f.host.stop(); expect(f.host.state()).toBe(0);
  });

  it.each(["pid", "embedded", "hostBundleId", ...Object.keys(WINDOWS_CUA_METADATA)])("rejects mismatched metadata %s and releases the whole owned generation", async field => {
    const f = fixture({ getMetadata: child => ({ ...metadata(child), [field]: field === "pid" ? child.pid : field === "embedded" ? false : "foreign" }) });
    await expect(f.host.start()).rejects.toThrow(/identity|pinned SDK contract/);
    expect(f.host.connection()).toBeUndefined(); expect(f.child.exitCode).toBe(0);
    expect(f.clients[0].uniffiDestroy).toHaveBeenCalledTimes(1);
  });

  it("retries a daemon that is not listening yet without publishing early", async () => {
    let attempts = 0;
    const f = fixture({ getMetadata: child => { if (++attempts < 3) throw new Error("fictional pipe not listening"); return metadata(child); } });
    const started = f.host.start();
    expect(f.host.connection()).toBeUndefined();
    await started; expect(attempts).toBe(3);
  });

  it("stop cancels a pending metadata call and a late answer cannot publish control", async () => {
    const answer = gate();
    const f = fixture({ getMetadata: async child => { await answer.promise; return metadata(child); } });
    const started = f.host.start(); started.catch(() => {});
    await vi.waitFor(() => expect(f.clients[0]?.metadata).toHaveBeenCalledTimes(1));
    const stop = f.host.stop(); expect(f.host.stop()).toBe(stop);
    expect(f.host.connection()).toBeUndefined();
    await stop; answer.resolve();
    await expect(started).rejects.toThrow(/stopped|exited/);
    expect(f.host.connection()).toBeUndefined(); expect(f.host.state()).toBe(0);
    expect(f.clients[0].uniffiDestroy).toHaveBeenCalledTimes(1);
  });
  it("stop before the first supervisor record releases startup without publishing a connection", async () => {
    const f = fixture({ record: () => null });
    const started = f.host.start(); started.catch(() => {});
    await f.host.stop();
    await expect(started).rejects.toThrow(/stopped|exited/);
    expect(f.sdk.CuaDriver.connect).not.toHaveBeenCalled();
    expect(f.child.exitCode).toBe(0); expect(f.host.connection()).toBeUndefined(); expect(f.host.state()).toBe(0);
  });

  it("bounds missing identity and retains a recovery hold after forced termination", async () => {
    const f = fixture({ record: () => null, autoStop: false, startupTimeoutMs: 25, shutdownTimeoutMs: 25 });
    await expect(f.host.start()).rejects.toThrow(/without confirming an empty Job/);
    expect(f.child.kill).toHaveBeenCalledTimes(1); expect(f.host.state()).toBe(3);
    await expect(f.host.start()).rejects.toThrow(/not been released/);
  });

  it("bounds a stuck SDK handshake and destroys the client after cancellation", async () => {
    const never = gate();
    const f = fixture({ getMetadata: () => never.promise, handshakeTimeoutMs: 25 });
    await expect(f.host.start()).rejects.toThrow(/metadata timed out/);
    expect(f.clients[0].uniffiDestroy).toHaveBeenCalledTimes(1); expect(f.host.connection()).toBeUndefined();
  });
  it("clears a confirmed spawn failure with no PID without inventing a cleanup receipt", async () => {
    const f = fixture({ record: () => null });
    const originalSpawn = f.spawnProcess.getMockImplementation();
    f.spawnProcess.mockImplementation(() => {
      const child = originalSpawn(); child.pid = undefined;
      queueMicrotask(() => child.emit("error", new Error("fictional ENOENT")));
      return child;
    });
    await expect(f.host.start()).rejects.toThrow(/could not start|exited before readiness/);
    expect(f.child.kill).not.toHaveBeenCalled(); expect(f.host.state()).toBe(0);
  });

  it("keeps a failed stop unavailable until actual exit is observed", async () => {
    const f = fixture({ autoStop: false, forceStops: false, shutdownTimeoutMs: 25, forceTimeoutMs: 25 });
    await f.host.start();
    await expect(f.host.stop()).rejects.toThrow(/has not stopped/);
    await expect(f.host.start()).rejects.toThrow(/not been released/);
    expect(f.spawnProcess).toHaveBeenCalledTimes(1); expect(f.host.connection()).toBeUndefined();
    f.child.exit(0); await f.host.stop(); expect(f.host.state()).toBe(0);
  });

  it("observes exit by generation and gives restart a new private endpoint", async () => {
    const f = fixture(); const first = await f.host.start();
    const exit = f.host.waitForExit(first.generation);
    f.child.exit(0);
    expect(await exit).toEqual({ generation: first.generation, code: 0, success: true });
    expect(f.host.connection()).toBeUndefined();
    const next = await f.host.restart();
    expect(next.generation).not.toBe(first.generation); expect(next.socketPath).not.toBe(first.socketPath);
    expect(next.pid).not.toBe(first.pid);
  });
  it("keeps an unexpected abnormal supervisor exit in a recovery hold", async () => {
    const f = fixture(); const connection = await f.host.start();
    f.child.exit(125);
    expect(await f.host.waitForExit(connection.generation)).toMatchObject({ success: false, code: 125 });
    expect(f.host.connection()).toBeUndefined(); expect(f.host.state()).toBe(3);
    await expect(f.host.stop()).rejects.toThrow(/without confirming an empty Job/);
    await expect(f.host.start()).rejects.toThrow(/not been released/);
    expect(f.spawnProcess).toHaveBeenCalledTimes(1);
  });
  it("cleans the supervisor before rejecting readiness-client destruction failure", async () => {
    const f = fixture();
    f.sdk.CuaDriver.connect.mockImplementation(() => ({
      metadata: async () => metadata(f.child),
      uniffiDestroy() { throw new Error("fictional release fault"); },
    }));
    await expect(f.host.start()).rejects.toThrow(/readiness client could not be released/);
    expect(f.host.connection()).toBeUndefined(); expect(f.host.state()).toBe(0);
    expect(f.child.stdin.writableEnded).toBe(true); expect(f.child.exitCode).toBe(0);
  });
});
