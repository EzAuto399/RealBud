import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { APP_VERSION, prepareServiceForUpdate, serviceCompatible } from "./update-service-handoff.mjs";
import { servicePidPath } from "./service-lifecycle.mjs";

const INSTANCE = "a".repeat(32);
const CONTROL = "c".repeat(64);
const SESSION = "5".repeat(48);
const IDENTITY = { instanceId: INSTANCE, ports: [8799] };
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** One fictional office service on 8799, driven only through its HTTP surface. */
function office({ busy = false, refuseStop = false, exits = true, recorded = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "realbud-handoff-")); dirs.push(dir);
  if (recorded) writeFileSync(servicePidPath(dir), JSON.stringify({ version: 1, pid: 4242, port: 8799, instanceId: INSTANCE, startedAt: 1, controlToken: CONTROL }));
  // The session token reaches its owner only through the service's private file.
  mkdirSync(join(dir, "local-auth"), { mode: 0o700 });
  writeFileSync(join(dir, "local-auth", "session.json"), JSON.stringify({ version: 1, pid: 4242, port: 8799, token: SESSION }), { mode: 0o600 });
  const state = { up: true, busy, stops: [] };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(String(url));
    if (!state.up) throw new Error("connection refused");
    if (pathname === "/api/health") return json({ app: "realbud", static: true, instanceId: INSTANCE, pid: 4242, version: "0.0.1-old",
      controlId: createHash("sha256").update(CONTROL).digest("hex"), busy: state.busy });
    if (pathname === "/api/service/stop") {
      if (new Headers(init.headers).get("x-realbud-session") !== SESSION) return json({ error: "unauthorized" }, 401);
      state.stops.push(JSON.parse(String(init.body)));
      if (refuseStop) { state.busy = true; return json({ code: "service_busy" }, 409); }
      if (exits) state.up = false;
      return json({ stopping: true });
    }
    return json({}, 404);
  };
  const isPortFree = async () => !state.up;
  return { dir, state, options: { dataDirectory: dir, identity: IDENTITY, fetchImpl, verifyWindowsPrivacy: () => {}, isPortFree, sleep: async () => {}, waitMs: 1_000 } };
}

describe("handing the office service over to an update", () => {
  it("defers while Bud is working and never asks the service to stop", async () => {
    const { state, options } = office({ busy: true });
    expect(await prepareServiceForUpdate(options)).toEqual({ ready: false, reason: "busy" });
    expect(state.stops).toEqual([]);
    expect(state.up).toBe(true);
  });

  it("stops an idle service through its control route, proves it gone, then allows the install", async () => {
    const { dir, state, options } = office();
    expect(await prepareServiceForUpdate(options)).toEqual({ ready: true });
    expect(state.stops).toEqual([expect.objectContaining({ pid: 4242, instanceId: INSTANCE, ifIdle: true })]);
    expect(existsSync(servicePidPath(dir))).toBe(false);
  });

  it("defers when work starts between the check and the stop", async () => {
    const { state, options } = office({ refuseStop: true });
    expect(await prepareServiceForUpdate(options)).toEqual({ ready: false, reason: "busy" });
    expect(state.up).toBe(true);
  });

  it("holds the install for a service it has no record to stop", async () => {
    const { state, options } = office({ recorded: false });
    expect(await prepareServiceForUpdate(options)).toEqual({ ready: false, reason: "cannot-stop" });
    expect(state.stops).toEqual([]);
  });

  it("holds the install while a stopped service has not gone away", async () => {
    const { dir, options } = office({ exits: false });
    expect(await prepareServiceForUpdate(options)).toEqual({ ready: false, reason: "still-running" });
    expect(existsSync(servicePidPath(dir))).toBe(true);
  });

  it("allows the install when nothing of ours is running or holding its port", async () => {
    const { state, options } = office({ recorded: false });
    state.up = false;
    expect(await prepareServiceForUpdate(options)).toEqual({ ready: true });
  });
});

describe("adopting only a compatible service", () => {
  const health = (over = {}) => ({ app: "realbud", static: true, instanceId: INSTANCE, version: APP_VERSION, ...over });
  it("accepts this office's service running this app's version", () => {
    expect(serviceCompatible(health(), IDENTITY)).toBe(true);
  });
  it.each([[{ version: "0.0.1-old" }], [{ version: undefined }], [{ instanceId: "b".repeat(32) }]])("refuses %j", (over) => {
    expect(serviceCompatible(health(over), IDENTITY)).toBe(false);
  });
});
