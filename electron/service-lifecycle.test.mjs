// Detached service lifecycle: the handle file, liveness, and the spawn.
//
// The behaviour that matters: a service started this way must NOT be a child of
// the app's lifetime, and a later launch must be able to tell "our service is
// already running" from "that pid is stale" without ever signalling a pid that
// is not ours.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearServiceHandle,
  parseServiceHandle,
  processAlive,
  readServiceHandle,
  servicePidPath,
  shouldStartService,
  startDetachedService,
} from "./service-lifecycle.mjs";

const INSTANCE = "a".repeat(32);
const dirs = [];
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
    expect(shouldStartService(true)).toBe(false);
  });

  it("starts one when nothing of ours is serving", () => {
    expect(shouldStartService(false)).toBe(true);
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
});
