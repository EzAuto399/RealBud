import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = vi.hoisted(() => ({ directory: "", hosts: [], failStart: false, failStop: false, login: true, clients: [], startGate: null, stopGate: null }));
vi.mock("electron", () => ({ app: { isPackaged: false, getPath: () => fixture.directory }, ipcMain: { handle() {} } }));
vi.mock("@trycua/cua-driver/electron", () => ({ requestMacOSPermissions: () => ({ accessibility: true, screenRecording: true }), hasRequiredMacOSPermissions: () => true }));
vi.mock("@trycua/cua-driver", () => ({
  EmbeddedCuaDriverHost: class {
    constructor(binary, identity) { this.binary = binary; this.identity = identity; this.stops = 0; this.destroyed = 0; fixture.hosts.push(this); }
    async start() { if (fixture.failStart) throw new Error("fictional start failure"); if (fixture.startGate) await fixture.startGate; return { socketPath: `fictional-socket-${fixture.hosts.length}` }; }
    async stop() { this.stops++; if (fixture.failStop) throw new Error("fictional stop failure"); if (fixture.stopGate) await fixture.stopGate; }
    uniffiDestroy() { this.destroyed++; }
  },
  CuaDriver: { connect: () => { const client = { destroyed: 0, uniffiDestroy() { this.destroyed++; } }; fixture.clients.push(client); return client; } },
}));
vi.mock("./cua-login-check.mjs", () => ({ checkCuaLogin: async () => fixture.login }));

let cua, binary;
beforeEach(async () => {
  vi.resetModules();
  fixture.directory = mkdtempSync(join(tmpdir(), "realbud-fictional-cua-lifecycle-"));
  fixture.hosts = []; fixture.clients = []; fixture.failStart = false; fixture.failStop = false; fixture.login = true;
  fixture.startGate = null; fixture.stopGate = null;
  binary = join(fixture.directory, process.platform === "win32" ? "cua-driver.exe" : "cua-driver");
  writeFileSync(binary, "fictional executable; never launched");
  writeFileSync(join(fixture.directory, "RealBud CUA.exe"), "fictional launcher; SDK is mocked");
  vi.stubEnv("CUA_DRIVER_PATH", binary); vi.stubEnv("OPENMAUSBOT_CUA_EMBEDDED", "1");
  cua = await import("./cua.mjs");
});
afterEach(async () => {
  fixture.failStop = false; await cua?.stopCua(); vi.unstubAllEnvs();
  rmSync(fixture.directory, { recursive: true, force: true });
});

describe.skipIf(!["darwin", "win32"].includes(process.platform))("GUI CUA lifecycle with fictional SDK and profile", () => {
  it("uses the shared grant launcher while the MCP proxy keeps the real binary", async () => {
    const connection = await cua.startCua();
    expect(connection).toMatchObject({ mode: "embedded", mcpCommand: binary, mcpArgs: ["mcp", "--embedded", "--socket", "fictional-socket-1"] });
    expect(fixture.hosts[0].binary).not.toBe(binary);
    expect(fixture.hosts[0].binary).toMatch(process.platform === "win32" ? /RealBud CUA\.exe$/ : /cua-driver-grant$/);
    await cua.stopCua();
    expect(fixture.hosts[0]).toMatchObject({ stops: 1, destroyed: 1 });
    expect(cua.currentCuaConnection()).toMatchObject({ mode: "unavailable", reason: "desktop-host-stopped" });
  });
  it("releases for sign-in, keeps isolated verification unavailable, and restores a new host", async () => {
    await cua.startCua(); await cua.releaseCuaForHuman();
    expect(existsSync(join(fixture.directory, "cua-human-pause.json"))).toBe(true);
    expect(await cua.startCua()).toMatchObject({ mode: "unavailable", reason: "human-signin-paused" });
    expect(fixture.hosts).toHaveLength(1);
    expect(await cua.verifyCuaAfterHuman({ fictional: true }, "fictional-check")).toBe(true);
    expect(fixture.hosts[1]).toMatchObject({ stops: 1, destroyed: 1 });
    expect(fixture.clients[0].destroyed).toBe(1);
    expect(cua.currentCuaConnection().mode).toBe("unavailable");
    await cua.restoreCuaAfterHuman();
    expect(fixture.hosts).toHaveLength(3);
    expect(cua.currentCuaConnection()).toMatchObject({ mode: "embedded", socketPath: "fictional-socket-3" });
    expect(existsSync(join(fixture.directory, "cua-human-pause.json"))).toBe(false);
  });
  it("cleans up a failed start and permits a later explicit restore", async () => {
    fixture.failStart = true;
    expect((await cua.startCua()).mode).toBe("unavailable");
    expect(fixture.hosts[0]).toMatchObject({ stops: 1, destroyed: 1 });
    await cua.releaseCuaForHuman(); fixture.failStart = false;
    await cua.restoreCuaAfterHuman(); expect(cua.currentCuaConnection().mode).toBe("embedded");
  });
  it("holds control and refuses restore until a failed release is confirmed", async () => {
    await cua.startCua(); fixture.failStop = true;
    await expect(cua.releaseCuaForHuman()).rejects.toThrow("fictional stop failure");
    expect(cua.currentCuaConnection().mode).toBe("unavailable");
    await expect(cua.restoreCuaAfterHuman()).rejects.toThrow(/not been released/);
    expect(fixture.hosts).toHaveLength(1);
    fixture.failStop = false; await cua.releaseCuaForHuman(); await cua.restoreCuaAfterHuman();
    expect(cua.currentCuaConnection().mode).toBe("embedded");
  });
  it("does not republish a pending start during human release and stops the host only once", async () => {
    let finishStart, finishStop;
    fixture.startGate = new Promise(resolve => { finishStart = resolve; });
    fixture.stopGate = new Promise(resolve => { finishStop = resolve; });
    const starting = cua.startCua();
    await vi.waitFor(() => expect(fixture.hosts).toHaveLength(1));
    const releasing = cua.releaseCuaForHuman();
    finishStart();
    expect(cua.currentCuaConnection()).toMatchObject({ mode: "unavailable", reason: "human-signin-paused" });
    finishStop();
    await releasing;
    expect(await starting).toMatchObject({ mode: "unavailable", reason: "human-signin-paused" });
    expect(fixture.hosts[0]).toMatchObject({ stops: 1, destroyed: 1 });
    fixture.startGate = null; fixture.stopGate = null;
    await cua.restoreCuaAfterHuman();
    expect(cua.currentCuaConnection().mode).toBe("embedded");
  });
});
