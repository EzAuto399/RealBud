// Detached service lifecycle: the handle file, liveness, and the spawn.
//
// The behaviour that matters: a service started this way must NOT be a child of
// the app's lifetime, and a later launch must be able to tell "our service is
// already running" from "that pid is stale" without ever signalling a pid that
// is not ours.
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, statSync, fstatSync } from "node:fs";
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
  systemBootId,
  writeServiceHandleFile,
} from "./service-lifecycle.mjs";

const INSTANCE = "a".repeat(32);
const CONTROL = "c".repeat(64);
const CONTROL_ID = createHash("sha256").update(CONTROL).digest("hex");
const IDENTITY = { instanceId: INSTANCE, ports: [8799] };
const SESSION = "5".repeat(48);
// Fixture directories are fresh and owner-created; on Windows a real ACL check
// belongs to the private-file tests, not these shutdown-ordering tests.
const FIXTURE_ACL = () => {};
/** A data directory whose private file names the healthy() service on 8799. */
function sessionDirectory(over = {}, mode = 0o600) {
  const directory = mkdtempSync(join(tmpdir(), "realbud-session-"));
  mkdirSync(join(directory, "local-auth"), { mode: 0o700 });
  writeFileSync(join(directory, "local-auth", "session.json"), JSON.stringify({ version: 1, pid: 4242, port: 8799, token: SESSION, ...over }), { mode });
  chmodSync(join(directory, "local-auth", "session.json"), mode);
  return directory;
}
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

  it("never lets a clock jump admit a second service beside a live owner from this boot", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const recorded = handle({ startedAt: 50_000_000, bootId: "darwin:fictional-boot-a", bootUptime: 600 });
    for (const jump of [-DAY, -1, 0, 1, DAY]) {
      expect(
        shouldStartService({ adopted: false, recorded, recordedPortFree: false, alive: () => true,
          bootedAt: 50_000_000 - 600_000 + jump, bootId: "darwin:fictional-boot-a", uptimeSeconds: 700 }),
      ).toEqual({ start: false, reason: "recorded-service-alive" });
    }
    // A different boot session is stale whatever the clock says.
    expect(
      shouldStartService({ adopted: false, recorded, recordedPortFree: false, alive: () => true,
        bootedAt: 0, bootId: "darwin:fictional-boot-b", uptimeSeconds: 700 }),
    ).toEqual({ start: true, reason: "recorded-before-boot" });
  });

  it("falls back to uptime, not wall time, when the machine has no boot id", () => {
    const recorded = handle({ startedAt: 1, bootUptime: 600 });
    const decide = (uptimeSeconds) => shouldStartService({ adopted: false, recorded, recordedPortFree: false, alive: () => true,
      bootedAt: 10_000_000, bootId: null, uptimeSeconds });
    expect(decide(700)).toEqual({ start: false, reason: "recorded-service-alive" });
    expect(decide(30)).toEqual({ start: true, reason: "recorded-before-boot" });
  });

  it("reads the OS boot session, never a clock", () => {
    expect(systemBootId("darwin", () => "8B0A4C6E-1F2D-4E3A-9B8C-7D6E5F4A3B2C\n")).toBe("darwin:8b0a4c6e-1f2d-4e3a-9b8c-7d6e5f4a3b2c");
    expect(systemBootId("win32", () => "\r\n    BootId    REG_DWORD    0x1a\r\n")).toBe("win32:26");
    expect(systemBootId("darwin", () => { throw new Error("sysctl unavailable"); })).toBeNull();
    expect(systemBootId("win32", () => "no value")).toBeNull();
    expect(systemBootId("freebsd", () => "x")).toBeNull();
  });

  it("records the boot session with the handle and reads it back", () => {
    const dir = tempDir();
    startDetachedService({ entry: "/app/server/index.js", port: 8799, env: {}, dataDirectory: dir, instanceId: INSTANCE,
      spawnImpl: () => ({ pid: 62, unref() {}, kill() {} }), executable: "/app/RealBud", bootId: "darwin:fictional-boot-a", uptime: () => 321 });
    expect(readServiceHandle(dir, INSTANCE)).toMatchObject({ pid: 62, bootId: "darwin:fictional-boot-a", bootUptime: 321 });
    expect(parseServiceHandle({ ...handle(), bootId: "../../etc", bootUptime: -1 }, INSTANCE)).not.toHaveProperty("bootId");
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
  it("persists real child stdout and fatal startup stderr without parent pipes", async () => {
    const dir = tempDir();
    const entry = join(dir, "failing.cjs");
    writeFileSync(entry, 'console.log("fictional startup"); throw new Error("fictional boot failure");');
    const messages = [];
    startDetachedService({ entry, port: 8799, env: {}, dataDirectory: dir, instanceId: INSTANCE,
      executable: process.execPath, logDirectory: join(dir, "logs"), onDiagnostic: message => messages.push(message) });
    await vi.waitFor(() => expect(messages.some(message => message.includes("exited code=1"))).toBe(true));
    const log = join(dir, "logs", "office-service", "stdout-stderr.log");
    expect(readFileSync(log, "utf8")).toContain("fictional startup");
    expect(readFileSync(log, "utf8")).toContain("fictional boot failure");
    if (process.platform !== "win32") expect(statSync(log).mode & 0o777).toBe(0o600);
  });

  it("rotates oversized prior output, retains evidence, and closes the parent's descriptor", () => {
    const dir = tempDir();
    const logDirectory = join(dir, "logs");
    mkdirSync(join(logDirectory, "office-service"), { recursive: true });
    const log = join(logDirectory, "office-service", "stdout-stderr.log");
    writeFileSync(log, "x".repeat(1024 * 1024));
    writeFileSync(`${log}.previous`, "older evidence");
    let fd;
    startDetachedService({ entry: "/fictional.js", port: 8799, env: {}, dataDirectory: dir, instanceId: INSTANCE,
      logDirectory, spawnImpl: (_exe, _args, options) => {
        expect(options.detached).toBe(true);
        expect(options.stdio[0]).toBe("ignore");
        expect(options.stdio[1]).toBe(options.stdio[2]);
        fd = options.stdio[1];
        writeFileSync(fd, "fictional child output");
        return { pid: 777, unref() {} };
      } });
    expect(readFileSync(`${log}.previous`, "utf8")).toBe("x".repeat(1024 * 1024));
    expect(readFileSync(log, "utf8")).toContain("fictional child output");
    expect(() => fstatSync(fd)).toThrow();
  });

  it("keeps Windows logging independent of POSIX permission changes", () => {
    const dir = tempDir();
    const logDirectory = join(dir, "logs");
    mkdirSync(join(logDirectory, "office-service"), { recursive: true });
    const log = join(logDirectory, "office-service", "stdout-stderr.log");
    writeFileSync(log, "prior startup\n", { mode: 0o644 });
    const beforeMode = statSync(log).mode;
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      startDetachedService({ entry: "/fictional.js", port: 8799, env: {}, dataDirectory: dir, instanceId: INSTANCE,
        logDirectory, spawnImpl: (_exe, _args, options) => {
          expect(Array.isArray(options.stdio)).toBe(true);
          writeFileSync(options.stdio[2], "fictional Windows startup failure");
          return { pid: 777, unref() {} };
        } });
    } finally {
      Object.defineProperty(process, "platform", platformDescriptor);
    }
    expect(statSync(log).mode).toBe(beforeMode);
    expect(readFileSync(log, "utf8")).toContain("fictional Windows startup failure");
  });

  it("reports unavailable diagnostics and asynchronous spawn failure without crashing", () => {
    const dir = tempDir();
    const logDirectory = join(dir, "not-a-directory");
    writeFileSync(logDirectory, "fictional obstruction");
    const messages = [];
    const listeners = {};
    const handle = startDetachedService({ entry: "/fictional.js", port: 8799, env: {}, dataDirectory: dir, instanceId: INSTANCE,
      logDirectory, onDiagnostic: message => messages.push(message), spawnImpl: (_exe, _args, options) => {
        expect(options.stdio).toBe("ignore");
        return { unref() {}, on: (event, callback) => { listeners[event] = callback; } };
      } });
    listeners.error(Object.assign(new Error("not found"), { code: "ENOENT" }));
    expect(spawnedServiceState(handle)).toBe("exited");
    expect(messages.join("\n")).toContain("diagnostic log unavailable");
    expect(messages.join("\n")).toContain("process error (ENOENT)");
  });

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

  it("retires a service it cannot record, through its own child, and reports why", () => {
    // Without the record nothing can ever stop, check or upgrade that service.
    const dir = tempDir();
    const previous = `${JSON.stringify(handle({ controlToken: CONTROL }))}\n`;
    writeFileSync(servicePidPath(dir), previous);
    const child = { pid: 5, unref: () => {}, kill: vi.fn(), exitCode: null, signalCode: null };
    const full = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    expect(() => startDetachedService({
      entry: "/app/server/index.js", port: 8799, env: {}, dataDirectory: dir, instanceId: INSTANCE,
      spawnImpl: () => child, executable: "/app/RealBud", writeFile: () => { throw full; },
    })).toThrow(expect.objectContaining({ code: "ENOSPC" }));
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(readFileSync(servicePidPath(dir), "utf8")).toBe(previous);
  });

  it("publishes the record atomically at 0600 and keeps the old one when publication fails", () => {
    const dir = tempDir();
    startDetachedService({ entry: "/app/server/index.js", port: 8799, env: {}, dataDirectory: dir, instanceId: INSTANCE,
      spawnImpl: () => ({ pid: 61, unref() {}, kill() {} }), executable: "/app/RealBud" });
    const first = readFileSync(servicePidPath(dir), "utf8");
    expect(readServiceHandle(dir, INSTANCE)).toMatchObject({ pid: 61 });
    if (process.platform !== "win32") expect(statSync(servicePidPath(dir)).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["service.json"]);
    if (process.platform === "win32") return;
    chmodSync(dir, 0o500);
    try {
      expect(() => writeServiceHandleFile(servicePidPath(dir), "{\"torn\":", { mode: 0o600 })).toThrow();
    } finally { chmodSync(dir, 0o700); }
    expect(readFileSync(servicePidPath(dir), "utf8")).toBe(first);
    expect(readdirSync(dir)).toEqual(["service.json"]);
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
    expect(await requestServiceStop(legacy, IDENTITY, { fetchImpl: request, dataDirectory: sessionDirectory(), verifyWindowsPrivacy: FIXTURE_ACL })).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("never requests an app session or sends Stop when recorded ownership is stale", async () => {
    const dataDirectory = sessionDirectory();
    for (const body of [healthy({ pid: 999 }), healthy({ controlId: "d".repeat(64) }), healthy({ instanceId: "b".repeat(32) })]) {
      const request = vi.fn(async () => Response.json(body));
      expect(await requestServiceStop(handle({ controlToken: CONTROL }), IDENTITY, { fetchImpl: request, dataDirectory, verifyWindowsPrivacy: FIXTURE_ACL })).toBe(false);
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0][0]).toBe("http://127.0.0.1:8799/api/health");
      expect(request.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
    }
  });

  it("sends the private capability only to the freshly verified service with its private-file session", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json(healthy()))
      .mockResolvedValueOnce(Response.json({ stopping: true }));
    expect(await requestServiceStop(handle({ controlToken: CONTROL }), IDENTITY, { fetchImpl: request, dataDirectory: sessionDirectory(), verifyWindowsPrivacy: FIXTURE_ACL })).toBe(true);
    // The token is read from the owner's file, never fetched over HTTP.
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:8799/api/health", "http://127.0.0.1:8799/api/service/stop",
    ]);
    const options = request.mock.calls[1][1];
    expect(options.method).toBe("POST");
    expect(options.headers).toEqual({ "content-type": "application/json", "x-realbud-session": SESSION, "x-realbud-service-control": CONTROL });
    expect(JSON.parse(options.body)).toEqual({ pid: 4242, instanceId: INSTANCE, controlId: CONTROL_ID });
    expect(options.headers).not.toHaveProperty("origin");
    expect(request.mock.calls[0][1]).not.toHaveProperty("headers");
  });

  it("reports failed or uncertain shutdown without retrying", async () => {
    // POSIX mode bits are the privacy proof only off Windows (ACLs there).
    const failures = ["unreachable", "session-missing", "session-other-process", "stop-denied", "stop-response-lost"];
    if (process.platform !== "win32") failures.push("session-loose-mode");
    for (const failure of failures) {
      const dataDirectory = failure === "session-missing" ? mkdtempSync(join(tmpdir(), "realbud-no-session-"))
        : sessionDirectory(failure === "session-other-process" ? { pid: 999 } : {}, failure === "session-loose-mode" ? 0o644 : 0o600);
      const request = vi.fn(async url => {
        if (url.endsWith("/health")) {
          if (failure === "unreachable") throw new Error("Synthetic connection unavailable");
          return Response.json(healthy());
        }
        if (failure === "stop-response-lost") throw new Error("Synthetic stop receipt lost");
        return Response.json({ error: "Synthetic refusal" }, { status: 403 });
      });
      expect(await requestServiceStop(handle({ controlToken: CONTROL }), IDENTITY, { fetchImpl: request, dataDirectory, verifyWindowsPrivacy: FIXTURE_ACL }), failure).toBe(false);
      expect(request.mock.calls.filter(([url]) => url.endsWith("/stop")).length).toBe(failure.startsWith("stop-") ? 1 : 0);
    }
  });
});
