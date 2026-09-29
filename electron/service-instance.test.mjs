// Service identity and adoption.
//
// The failure these guard is the worst one available to this design: if the app
// cannot recognise its own already-running service, it forks a second one, and
// two services hold one company database. If it recognises the WRONG service, it
// points this office at another office's data.
import { describe, expect, it, vi } from "vitest";

import { serviceInstanceId } from "../shared/service-identity.mjs";
import { SERVICE_PORTS, findBusyService, findRunningService, isOurService, probeService, serviceIdentity } from "../electron/service-instance.mjs";

const DATA = "/Users/pm/.realbud";
const identity = serviceIdentity(DATA);

function healthResponse(body, ok = true) {
  return vi.fn(async () => ({ ok, json: async () => body }));
}

describe("installation identity", () => {
  it("is stable for one data directory across restarts", () => {
    expect(serviceInstanceId(DATA)).toBe(serviceInstanceId(DATA));
  });

  it("differs for a different data directory, so two offices never share a service", () => {
    expect(serviceInstanceId(DATA)).not.toBe(serviceInstanceId("/Users/other/.realbud"));
  });

  it("normalises the path, because the app and server obtain it differently", () => {
    // The app composes an absolute path; the server reads one from the
    // environment. A trailing separator must not create a second identity.
    expect(serviceInstanceId("/Users/pm/.realbud/")).toBe(serviceInstanceId("/Users/pm/.realbud"));
  });

  it("does not disclose the filesystem path", () => {
    expect(serviceInstanceId(DATA)).not.toContain(".realbud");
    expect(serviceInstanceId(DATA)).not.toContain("pm");
  });

  it("is carried on both the app and server side of the handshake", () => {
    // Same module, same function: this is what makes the handshake agree.
    expect(identity.instanceId).toBe(serviceInstanceId(DATA));
  });

  it("offers the documented ports in preference order", () => {
    expect(identity.ports).toEqual([...SERVICE_PORTS]);
  });
});

describe("recognising our own service", () => {
  it("accepts a static realbud service with our instance id", () => {
    expect(isOurService({ app: "realbud", static: true, instanceId: identity.instanceId }, identity)).toBe(true);
  });

  it("rejects another installation's service on the same port", () => {
    // The adoption bug this prevents: a different office answering correctly.
    expect(isOurService({ app: "realbud", static: true, instanceId: serviceInstanceId("/tmp/elsewhere") }, identity)).toBe(false);
  });

  it("rejects a development harness that serves the same API shape", () => {
    expect(isOurService({ app: "realbud", static: false, instanceId: identity.instanceId }, identity)).toBe(false);
    expect(isOurService({ app: "realbud", pid: 1234, static: true }, identity)).toBe(false);
  });

  it("rejects anything that is not a realbud service", () => {
    for (const body of [null, undefined, "realbud", 42, [], { app: "other", static: true, instanceId: identity.instanceId }]) {
      expect(isOurService(body, identity), JSON.stringify(body)).toBe(false);
    }
  });

  it("still accepts the service when only the pid changed", () => {
    // The point of the change: pid is no longer part of identity, so a service
    // that outlived the app is still recognised after relaunch.
    expect(isOurService({ app: "realbud", static: true, pid: 999999, instanceId: identity.instanceId }, identity)).toBe(true);
  });
});

describe("finding a running service", () => {
  it("adopts the first port serving our own service", async () => {
    const fetchImpl = vi.fn(async (url) => {
      const port = Number(new URL(url).port);
      if (port === 18799) return { ok: true, json: async () => ({ app: "realbud", static: true, instanceId: identity.instanceId }) };
      throw new Error("refused");
    });
    await expect(findRunningService(identity, { fetchImpl })).resolves.toMatchObject({ port: 18799 });
  });

  it("skips a port held by a different installation and keeps looking", async () => {
    const fetchImpl = vi.fn(async (url) => {
      const port = Number(new URL(url).port);
      const instanceId = port === 8799 ? serviceInstanceId("/tmp/other-office") : identity.instanceId;
      return { ok: true, json: async () => ({ app: "realbud", static: true, instanceId }) };
    });
    // Must not stop at the first answer: that would adopt a stranger's service.
    await expect(findRunningService(identity, { fetchImpl })).resolves.toMatchObject({ port: 18799 });
  });

  it("returns null when nothing of ours is running", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("refused"); });
    await expect(findRunningService(identity, { fetchImpl })).resolves.toBeNull();
  });

  it("returns null when a non-real service answers", async () => {
    const fetchImpl = healthResponse({ hello: "world" });
    await expect(findRunningService(identity, { fetchImpl })).resolves.toBeNull();
  });

  it("treats an error response as absent rather than as ours", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, json: async () => ({ app: "realbud", static: true, instanceId: identity.instanceId }) }));
    await expect(findRunningService(identity, { fetchImpl })).resolves.toBeNull();
  });

  it("survives a malformed body without throwing", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => { throw new Error("bad json"); } }));
    await expect(findRunningService(identity, { fetchImpl })).resolves.toBeNull();
  });

  it("does not wait forever on an unresponsive port", async () => {
    // An aborted probe must read as "not running", never as ours.
    const fetchImpl = vi.fn(async (_url, init) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      throw new Error("unreachable");
    });
    await expect(probeService(8799, { fetchImpl, timeoutMs: 10 })).resolves.toBeNull();
  });
});

describe("adopting a busy service before spawning", () => {
  // Our service answers only after the quick probe would have given up.
  const slowOurs = (delayMs) => vi.fn(async (_url, init) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
    });
    return { ok: true, json: async () => ({ app: "realbud", static: true, instanceId: identity.instanceId }) };
  });

  it("adopts our service on a bound port that misses the quick probe but answers a patient one", async () => {
    const fetchImpl = slowOurs(60);
    await expect(findRunningService(identity, { fetchImpl, timeoutMs: 20 })).resolves.toBeNull();
    const isPortFree = vi.fn(async (port) => port !== 8799);
    await expect(findBusyService(identity, { isPortFree, fetchImpl, timeoutMs: 500 })).resolves.toMatchObject({ port: 8799 });
  });

  it("never probes a free port and never adopts a stranger holding a bound one", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ app: "realbud", static: true, instanceId: serviceInstanceId("/tmp/other-office") }) }));
    await expect(findBusyService(identity, { isPortFree: async (port) => port !== 18799, fetchImpl })).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toContain(":18799/");
    fetchImpl.mockClear();
    await expect(findBusyService(identity, { isPortFree: async () => true, fetchImpl })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("gives up on a bound port that stays silent", async () => {
    await expect(findBusyService(identity, { isPortFree: async (port) => port !== 8799, fetchImpl: slowOurs(5_000), timeoutMs: 20 })).resolves.toBeNull();
  });
});
