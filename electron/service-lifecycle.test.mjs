// Detached service lifecycle: the handle file, liveness, and the spawn.
//
// The behaviour that matters: a service started this way must NOT be a child of
// the app's lifetime, and a later launch must be able to tell "our service is
// already running" from "that pid is stale" without ever signalling a pid that
// is not ours.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  abandonSpawnedService,
  availableServicePort,
  clearServiceHandle,
  ownsRunningService,
  parseServiceHandle,
  processAlive,
  readServiceHandle,
  requestServiceStop,
  servicePidPath,
  serviceWaitTicks,
  shouldRestartServiceWait,
  shouldStartService,
  spawnedServiceState,
  startDetachedService,
  systemBootedAt,
} from "./service-lifecycle.mjs";

const INSTANCE = "a".repeat(32);
const CONTROL = "c".repeat(64);
const CONTROL_ID = createHash("sha256").update(CONTROL).digest("hex");
const IDENTITY = { instanceId: INSTANCE, ports: [8799] };
const healthy = (over = {}) => ({ app: "realbud", static: true, instanceId: INSTANCE, pid: 4242, controlId: CONTROL_ID, ...over });
const dirs = [];

it("skips a foreign occupied port and releases the selected probe port", async () => {
  const foreign = createServer(); foreign.listen(0, "127.0.0.1"); await once(foreign, "listening");
  const free = createServer(); free.listen(0, "127.0.0.1"); await once(free, "listening");
  const occupied = foreign.address().port, vacant = free.address().port;
  await new Promise(resolve => free.close(resolve));
  try {
    expect(await availableServicePort([occupied])).toBeNull();
    expect(await availableServicePort([occupied, vacant])).toBe(vacant);
    const child = createServer(); child.listen(vacant, "127.0.0.1"); await once(child, "listening");
    await new Promise(resolve => child.close(resolve));
    expect(foreign.listening).toBe(true);
  } finally { await new Promise(resolve => foreign.close(resolve)); }
});
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "realbud-service-"));
  dirs.push(dir);
  return dir;
}
const handle = (over = {}) => ({ version: 1, pid: 4242, port: 8799, instanceId: INSTANCE, startedAt: 1, ...over });

describe("service handle file", () => {
  it("round-trips a valid handle", () => {
    expect(parseServiceHandle(handle(), INSTANCE)).toEqual(handle());
  });

  it("refuses a handle belonging to a different installation", () => {
    // Prevents this app stopping another office's service.
    expect(parseServiceHandle(handle({ instanceId: "b".repeat(32) }), INSTANCE)).toBeNull();
  });

  it("refuses malformed or partial handles instead of throwing", () => {
    for (const value of [null, undefined, "x", 42, [], {}, { version: 2, pid: 1, port: 1, instanceId: INSTANCE }]) {
      expect(parseServiceHandle(value, INSTANCE), JSON.stringify(value)).toBeNull();
    }
  });

  it("refuses a non-positive or non-integer pid or port", () => {
    for (const bad of [{ pid: 0 }, { pid: -1 }, { pid: 1.5 }, { port: 0 }, { port: -3 }]) {
      expect(parseServiceHandle(handle(bad), INSTANCE), JSON.stringify(bad)).toBeNull();
    }
  });

  it("tolerates a missing startedAt rather than rejecting the handle", () => {
    expect(parseServiceHandle(handle({ startedAt: undefined }), INSTANCE)?.startedAt).toBe(0);
  });

  it("preserves the private process capability and rejects a malformed one", () => {
    expect(parseServiceHandle(handle({ controlToken: CONTROL }), INSTANCE)?.controlToken).toBe(CONTROL);
    for (const controlToken of ["", "c".repeat(63), "g".repeat(64), null, 123]) {
      expect(parseServiceHandle(handle({ controlToken }), INSTANCE)).toBeNull();
    }
  });

  it("reads back what was written, and reports absence without throwing", () => {
    const dir = tempDir();
    expect(readServiceHandle(dir, INSTANCE)).toBeNull();
    writeFileSync(servicePidPath(dir), JSON.stringify(handle()));
    expect(readServiceHandle(dir, INSTANCE)?.pid).toBe(4242);
    clearServiceHandle(dir);
    expect(readServiceHandle(dir, INSTANCE)).toBeNull();
    expect(() => clearServiceHandle(dir)).not.toThrow();
  });

  it("treats a corrupt file as no handle", () => {
    const dir = tempDir();
    writeFileSync(servicePidPath(dir), "{ not json");
    expect(readServiceHandle(dir, INSTANCE)).toBeNull();
  });
});

describe("process liveness", () => {
  it("reports a live pid", () => {
    expect(processAlive(process.pid)).toBe(true);
  });

  it("reports an unused pid as not alive", () => {
    expect(processAlive(999_999)).toBe(false);
  });

  it("treats a permission error as not ours rather than alive", () => {
    // Another user's process must never be signalled by this app.
    expect(processAlive(1, () => { throw Object.assign(new Error("nope"), { code: "EPERM" }); })).toBe(false);
  });

  it("refuses nonsense pids without calling kill", () => {
    const kill = vi.fn();
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(processAlive(bad, kill)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("deciding whether to start a service", () => {
  it("does not start one when ours is already serving", () => {
    // Two services on one company database is the worst outcome available.
    expect(shouldStartService({ adopted: true })).toEqual({ start: false, reason: "adopted" });
  });

  it("starts one when nothing of ours is serving", () => {
    expect(shouldStartService({ adopted: false })).toEqual({ start: true, reason: "nothing-of-ours" });
  });

  it("holds for a recorded service that is alive but still silent on its port", () => {
    // The case that used to fork a second service: a slow start holds the port
    // without answering /api/health yet.
    expect(
      shouldStartService({ adopted: false, recorded: handle({ pid: 4242 }), recordedPortFree: false, alive: () => true }),
    ).toEqual({ start: false, reason: "recorded-service-alive" });
  });

  it("starts anyway when a recorded pid is stale after a reboot", () => {
    // The pid file outlives a reboot; a dead pid must never brick a launch.
    expect(
      shouldStartService({ adopted: false, recorded: handle(), recordedPortFree: false, alive: () => false }),
    ).toEqual({ start: true, reason: "nothing-of-ours" });
  });

  it("escapes the hold for a record written before the current boot", () => {
    // After a reboot a recycled pid and an unrelated listener can satisfy both
    // hold conditions by coincidence, and every port is then blocked with no way
    // out. Reboot survival is not implemented, so a pre-boot record cannot be a
    // live service of ours — including the legacy record with no timestamp.
    for (const startedAt of [1, 9_000, 0]) {
      expect(
        shouldStartService({
          adopted: false, recorded: handle({ startedAt }), recordedPortFree: false,
          bootedAt: 10_000, alive: () => true,
        }),
      ).toEqual({ start: true, reason: "recorded-before-boot" });
    }
  });

  it("still holds for a record written after the current boot", () => {
    expect(
      shouldStartService({
        adopted: false, recorded: handle({ startedAt: 11_000 }), recordedPortFree: false,
        bootedAt: 10_000, alive: () => true,
      }),
    ).toEqual({ start: false, reason: "recorded-service-alive" });
    // No boot time supplied: the rule cannot be applied, so the hold stands.
    expect(
      shouldStartService({ adopted: false, recorded: handle({ startedAt: 0 }), recordedPortFree: false, alive: () => true }),
    ).toEqual({ start: false, reason: "recorded-service-alive" });
  });

  it("derives boot time from system uptime", () => {
    expect(systemBootedAt(60, 1_000_000)).toBe(940_000);
    expect(systemBootedAt()).toBeLessThan(Date.now() + 1);
  });

  it("starts when a recorded pid is alive but its port is free", () => {
    // A reused pid belonging to something unrelated is not our service.
    const alive = vi.fn(() => true);
    expect(
      shouldStartService({ adopted: false, recorded: handle(), recordedPortFree: true, alive }),
    ).toEqual({ start: true, reason: "nothing-of-ours" });
    expect(alive).not.toHaveBeenCalled();
  });
});

describe("waiting for a slow service", () => {
  it("bounds the wait to whole checks inside the limit", () => {
    expect(serviceWaitTicks()).toBe(90);
    expect(serviceWaitTicks(10_000, 2_000)).toBe(5);
    expect(serviceWaitTicks(500, 2_000)).toBe(1);
    expect(serviceWaitTicks(10_000, 0)).toBe(1);
  });

  const failure = (over = {}) => ({
    mainFrame: true, errorCode: -102, url: "http://127.0.0.1:8799/", appOrigin: "http://127.0.0.1:8799",
    waiting: false, lastRestartAt: null, now: 100_000, ...over,
  });

  it("restarts the wait for a failed app-origin main-frame load", () => {
    expect(shouldRestartServiceWait(failure())).toBe(true);
  });

  it("refuses the cases that would spin the main process", () => {
    // Sub-frames, our own superseding navigation, the recovery page's own
    // data: URL, a wait already running, and a restart inside the cooldown.
    expect(shouldRestartServiceWait(failure({ mainFrame: false }))).toBe(false);
    expect(shouldRestartServiceWait(failure({ errorCode: -3 }))).toBe(false);
    expect(shouldRestartServiceWait(failure({ url: "data:text/html;charset=utf-8,x" }))).toBe(false);
    expect(shouldRestartServiceWait(failure({ waiting: true }))).toBe(false);
    expect(shouldRestartServiceWait(failure({ lastRestartAt: 96_000 }))).toBe(false);
    expect(shouldRestartServiceWait(failure({ lastRestartAt: 94_000 }))).toBe(true);
  });
});

describe("detached start", () => {
  it("spawns detached, unrefs, and records the handle", () => {
    const dir = tempDir();
    const unref = vi.fn();
    const spawnImpl = vi.fn(() => ({ pid: 777, unref }));
    const written = [];
    const result = startDetachedService({
      entry: "/app/server/index.js",
      port: 18799,
      env: { PATH: "/usr/bin" },
      dataDirectory: dir,
      instanceId: INSTANCE,
      spawnImpl,
      executable: "/app/RealBud",
      now: () => 1234,
      writeFile: (path, data) => { written.push({ path, data }); },
    });

    // Detached + unref is the whole mechanism: without both, quitting the app
    // takes the office database with it.
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl.mock.calls[0][2]).toMatchObject({ detached: true, windowsHide: true, stdio: "ignore" });
    expect(unref).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ pid: 777, port: 18799, instanceId: INSTANCE, startedAt: 1234 });
    expect(JSON.parse(written[0].data)).toMatchObject({ pid: 777, port: 18799 });
    expect(written[0].path).toBe(servicePidPath(dir));
    expect(result.controlToken).toMatch(/^[a-f0-9]{64}$/);
    expect(spawnImpl.mock.calls[0][2].env.REALBUD_SERVICE_CONTROL_TOKEN).toBe(result.controlToken);
    expect(JSON.parse(written[0].data).controlToken).toBe(result.controlToken);
  });

  it("runs the bundled Node as a plain Node process with the office data directory", () => {
    const dir = tempDir();
    const spawnImpl = vi.fn(() => ({ pid: 1, unref: () => {} }));
    startDetachedService({
      entry: "/app/server/index.js", port: 8799, env: { PATH: "/usr/bin", REALBUD_DESK_KEY: "ab" },
      dataDirectory: dir, instanceId: INSTANCE, spawnImpl, executable: "/app/RealBud",
      writeFile: () => {},
    });
    const env = spawnImpl.mock.calls[0][2].env;
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(env.OMB_PORT).toBe("8799");
    expect(env.REALBUD_DATA_DIR).toBe(dir);
    // The book key is inherited, never written to disk by this module.
    expect(env.REALBUD_DESK_KEY).toBe("ab");
  });

  it("still returns a usable handle when the file cannot be written", () => {
    const dir = tempDir();
    const spawnImpl = vi.fn(() => ({ pid: 5, unref: () => {} }));
    // An unwritable record must not turn a started service into a failed launch.
    const result = startDetachedService({
      entry: "/app/server/index.js", port: 8799, env: {}, dataDirectory: dir, instanceId: INSTANCE,
      spawnImpl, executable: "/app/RealBud", writeFile: () => { throw new Error("read-only"); },
    });
    expect(result.pid).toBe(5);
  });

  it("records a handle that reads back as the same service", () => {
    const dir = tempDir();
    const real = JSON.stringify;
    startDetachedService({
      entry: "/app/server/index.js", port: 8799, env: {}, dataDirectory: dir, instanceId: INSTANCE,
      spawnImpl: vi.fn(() => ({ pid: 99, unref: () => {} })),
      executable: "/app/RealBud", now: () => 7,
      writeFile: (path, data, opts) => writeFileSync(path, data, opts),
    });
    expect(readServiceHandle(dir, INSTANCE)).toMatchObject({ pid: 99, port: 8799, startedAt: 7 });
    expect(real(readServiceHandle(dir, INSTANCE))).toContain(INSTANCE);
  });

  it("tracks the spawned child's state, and knows nothing about a handle from disk", () => {
    const dir = tempDir();
    const child = { pid: 321, unref() {}, kill: vi.fn(), exitCode: null, signalCode: null };
    const spawned = startDetachedService({
      entry: "/app/server/index.js", port: 8799, env: {}, dataDirectory: dir, instanceId: INSTANCE,
      spawnImpl: () => child, executable: "/app/RealBud", writeFile: () => {},
    });
    expect(spawnedServiceState(spawned)).toBe("running");
    child.exitCode = 1;
    expect(spawnedServiceState(spawned)).toBe("exited");
    child.exitCode = null;
    child.signalCode = "SIGTERM";
    expect(spawnedServiceState(spawned)).toBe("exited");
    // A handle another session recorded is never "ours" to manage.
    expect(spawnedServiceState(parseServiceHandle({ ...spawned }, INSTANCE))).toBe("unknown");
    expect(spawnedServiceState(null)).toBe("unknown");
  });

  it("abandons only a child it spawned, through the child object rather than a pid", () => {
    const dir = tempDir();
    const child = { pid: 321, unref() {}, kill: vi.fn(), exitCode: null, signalCode: null };
    const spawned = startDetachedService({
      entry: "/app/server/index.js", port: 8799, env: {}, dataDirectory: dir, instanceId: INSTANCE,
      spawnImpl: () => child, executable: "/app/RealBud",
      writeFile: (path, data, opts) => writeFileSync(path, data, opts),
    });

    expect(abandonSpawnedService(spawned, dir)).toBe(true);
    expect(child.kill).toHaveBeenCalledTimes(1);
    // The record described exactly this handle, so it is gone.
    expect(readServiceHandle(dir, INSTANCE)).toBeNull();
    // Abandoning twice must not send a second signal to a pid we released.
    expect(abandonSpawnedService(spawned, dir)).toBe(false);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("never signals a handle it did not spawn, and leaves that record intact", () => {
    const dir = tempDir();
    const foreign = handle({ controlToken: CONTROL });
    // Not spawned here: no child object, so nothing may be signalled — and the
    // record is another session's only way to stop that service, so it stays.
    writeFileSync(servicePidPath(dir), JSON.stringify(foreign));
    expect(abandonSpawnedService(foreign, dir)).toBe(false);
    expect(readServiceHandle(dir, INSTANCE)).toMatchObject({ pid: 4242, controlToken: CONTROL });
    expect(abandonSpawnedService(null, dir)).toBe(false);
  });

  it("leaves a record a later start overwrote, which is that service's only management handle", () => {
    const dir = tempDir();
    const child = { pid: 555, unref() {}, kill: vi.fn(), exitCode: null, signalCode: null };
    const earlier = startDetachedService({
      entry: "/app/server/index.js", port: 8799, env: {}, dataDirectory: dir, instanceId: INSTANCE,
      spawnImpl: () => child, executable: "/app/RealBud", writeFile: () => {},
    });
    // A different service now owns the file.
    writeFileSync(servicePidPath(dir), JSON.stringify(handle({ controlToken: CONTROL })));
    expect(abandonSpawnedService(earlier, dir)).toBe(true);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(readServiceHandle(dir, INSTANCE)).toMatchObject({ pid: 4242, controlToken: CONTROL });
  });

  it("gives a replacement service a new capability even for the same installation", () => {
    const options = {
      entry: "/app/server/index.js", port: 8799, env: { REALBUD_SERVICE_CONTROL_TOKEN: CONTROL },
      dataDirectory: tempDir(), instanceId: INSTANCE,
      spawnImpl: vi.fn(() => ({ pid: 99, unref: () => {} })), writeFile: () => {},
    };
    const first = startDetachedService(options);
    const second = startDetachedService(options);
    expect(first.controlToken).not.toBe(CONTROL);
    expect(second.controlToken).not.toBe(first.controlToken);
    expect(options.spawnImpl.mock.calls[1][2].env.REALBUD_SERVICE_CONTROL_TOKEN).toBe(second.controlToken);
  });
});

describe("process-bound service control", () => {
  it("requires the same instance, port, PID and private capability digest", () => {
    const owned = handle({ controlToken: CONTROL });
    expect(ownsRunningService(owned, { port: 8799, body: healthy() }, IDENTITY)).toBe(true);
    for (const body of [healthy({ instanceId: "b".repeat(32) }), healthy({ pid: 4243 }), healthy({ controlId: "d".repeat(64) }), healthy({ controlId: CONTROL }), healthy({ static: false }), healthy({ app: "other" }), null]) {
      expect(ownsRunningService(owned, { port: 8799, body }, IDENTITY)).toBe(false);
    }
    expect(ownsRunningService(owned, { port: 18799, body: healthy() }, IDENTITY)).toBe(false);
    expect(ownsRunningService(owned, null, IDENTITY)).toBe(false);
    expect(ownsRunningService(null, { port: 8799, body: healthy() }, IDENTITY)).toBe(false);
  });

  it("keeps legacy PID-only handles readable but never manageable", async () => {
    const legacy = parseServiceHandle(handle(), INSTANCE);
    const request = vi.fn();
    expect(legacy).not.toBeNull();
    expect(ownsRunningService(legacy, { port: 8799, body: healthy() }, IDENTITY)).toBe(false);
    expect(await requestServiceStop(legacy, IDENTITY, { fetchImpl: request })).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("never requests an app session or sends Stop when recorded ownership is stale", async () => {
    for (const body of [healthy({ pid: 999 }), healthy({ controlId: "d".repeat(64) }), healthy({ instanceId: "b".repeat(32) })]) {
      const request = vi.fn(async () => Response.json(body));
      expect(await requestServiceStop(handle({ controlToken: CONTROL }), IDENTITY, { fetchImpl: request })).toBe(false);
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0][0]).toBe("http://127.0.0.1:8799/api/health");
      expect(request.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
    }
  });

  it("sends the private capability only to the freshly verified service with app-session proof", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json(healthy()))
      .mockResolvedValueOnce(Response.json({ token: "fictional-app-session" }))
      .mockResolvedValueOnce(Response.json({ stopping: true }));
    expect(await requestServiceStop(handle({ controlToken: CONTROL }), IDENTITY, { fetchImpl: request })).toBe(true);
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:8799/api/health", "http://127.0.0.1:8799/api/session", "http://127.0.0.1:8799/api/service/stop",
    ]);
    const options = request.mock.calls[2][1];
    expect(options.method).toBe("POST");
    expect(options.headers).toEqual({ "content-type": "application/json", "x-realbud-session": "fictional-app-session", "x-realbud-service-control": CONTROL });
    expect(JSON.parse(options.body)).toEqual({ pid: 4242, instanceId: INSTANCE, controlId: CONTROL_ID });
    expect(options.headers).not.toHaveProperty("origin");
    expect(request.mock.calls[0][1]).not.toHaveProperty("headers");
    expect(request.mock.calls[1][1]).not.toHaveProperty("headers");
  });

  it("reports failed or uncertain shutdown without retrying", async () => {
    for (const failure of ["unreachable", "session-denied", "session-malformed", "stop-denied", "stop-response-lost"]) {
      const request = vi.fn(async url => {
        if (url.endsWith("/health")) {
          if (failure === "unreachable") throw new Error("Synthetic connection unavailable");
          return Response.json(healthy());
        }
        if (url.endsWith("/session")) return Response.json(failure === "session-malformed" ? {} : { token: "fictional-session" }, { status: failure === "session-denied" ? 403 : 200 });
        if (failure === "stop-response-lost") throw new Error("Synthetic stop receipt lost");
        return Response.json({ error: "Synthetic refusal" }, { status: 403 });
      });
      expect(await requestServiceStop(handle({ controlToken: CONTROL }), IDENTITY, { fetchImpl: request }), failure).toBe(false);
      expect(request.mock.calls.filter(([url]) => url.endsWith("/stop")).length).toBe(failure.startsWith("stop-") ? 1 : 0);
    }
  });
});
