import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallJob } from "./hermes-bridge.ts";
import type { HermesStatus } from "./hermes-status.ts";
import type { WorkerInstallOutcome } from "./hermes-update.ts";
import { AUTO_SETUP_BACKOFF_MS, AUTO_SETUP_COPY, AUTO_SETUP_FILE, AUTO_SETUP_MAX_ATTEMPTS, autoSetupDetail, createWorkerAutoSetup, type WorkerAutoSetupDeps } from "./worker-auto-setup.ts";
import * as privateJson from "./private-json.ts";
import { plantPrivateFile, privateTempRoot, removeFixture } from "./testing/private-fixture.ts";

let dir: string;
beforeEach(() => { dir = privateTempRoot(join(tmpdir(), "realbud-auto-setup-")); });
afterEach(() => removeFixture(dir));

const status = (patch: { installed?: boolean; compatible?: boolean; ready?: boolean } = {}): HermesStatus => ({
  cli: { installed: patch.installed ?? true, versionText: "fixture", matchesPin: false, compatible: patch.compatible ?? true, probeState: "ok" },
  pack: { installed: true, approvalsManual: true, workroomReady: true },
  ready: patch.ready ?? false, detail: "fixture detail",
} as HermesStatus);

/** A fake worker: an unsupported personal CLI until the install finishes. */
function harness(options: { active?: boolean; job?: Partial<InstallJob>; ping?: boolean } = {}) {
  let time = 1_000_000;
  let installed = false;
  let inFlight = false;
  let finish: () => void = () => {};
  let ready = false;
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  const job: InstallJob = { state: "done", lines: [], startedAt: 1, finishedAt: 2, error: null, ...options.job };
  const calls: string[] = [];
  let active = options.active ?? true;
  const deps: WorkerAutoSetupDeps = {
    directory: dir,
    active: vi.fn(async () => active),
    cancelInstall: vi.fn(() => { calls.push("cancel"); job.state = "failed"; job.failureKind = "retry"; finish(); }),
    status: vi.fn(async () => status({ compatible: installed, ready })),
    installOrRepair: vi.fn(async (): Promise<WorkerInstallOutcome> => {
      calls.push("install");
      inFlight = true;
      const done = new Promise<void>(resolve => { finish = () => { inFlight = false; if (job.state === "done") installed = true; resolve(); }; });
      pending = done;
      return { kind: "started", install: { ...job, state: "running" } };
    }),
    installInFlight: () => inFlight,
    installStatus: () => job,
    waitForInstall: () => pending,
    ensurePack: vi.fn(() => { calls.push("pack"); }),
    reconcileProfile: vi.fn(async () => { calls.push("profile"); return true; }),
    syncBud: vi.fn(() => { calls.push("rebind"); }),
    readinessPing: vi.fn(async () => { calls.push("ping"); ready = options.ping ?? true; return { ok: ready, detail: ready ? "ok" : "The gateway did not answer." }; }),
    now: () => time,
    setTimer: (fn, ms) => { const timer = { at: time + ms, fn, cancelled: false }; timers.push(timer); return { cancel: () => { timer.cancelled = true; } }; },
  };
  let pending: Promise<void> = Promise.resolve();
  return {
    deps, calls, timers,
    finishInstall: () => finish(),
    setActive: (value: boolean) => { active = value; },
    setJob: (patch: Partial<InstallJob>) => { Object.assign(job, patch); },
    advance: (ms: number) => { time += ms; },
    record: () => JSON.parse(readFileSync(join(dir, AUTO_SETUP_FILE), "utf8")),
  };
}
const installCalled = (deps: WorkerAutoSetupDeps, times = 1) => vi.waitFor(() => expect(deps.installOrRepair).toHaveBeenCalledTimes(times));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe("automatic Bud setup after an approved office link", () => {
  it("does nothing on a computer that is not provisioned", async () => {
    const h = harness({ active: false });
    const setup = createWorkerAutoSetup(h.deps);
    await setup.ensure("boot");
    expect(h.deps.installOrRepair).not.toHaveBeenCalled();
    expect(h.deps.status).not.toHaveBeenCalled();
    expect(setup.status()).toMatchObject({ state: "idle" });
  });

  it("installs once for concurrent triggers, then runs pack, profile, rebind and one readiness check in order", async () => {
    const h = harness();
    const setup = createWorkerAutoSetup(h.deps);
    const first = setup.ensure("provisioned");
    const second = setup.ensure("boot");
    expect(second).toBe(first);
    await installCalled(h.deps);
    expect(setup.status()).toMatchObject({ state: "installing", step: 1, total: 4, code: "installing", detail: AUTO_SETUP_COPY.installing });
    h.finishInstall();
    await first;
    expect(h.calls).toEqual(["install", "pack", "profile", "rebind", "ping"]);
    expect(setup.status()).toMatchObject({ state: "ready", step: 4, detail: "Bud is ready." });
    await setup.ensure("periodic");
    expect(h.calls.filter(call => call === "install")).toHaveLength(1);
    expect(h.calls.filter(call => call === "ping")).toHaveLength(1);
  });

  it("stops, without profile or readiness work, when the grant goes away during the install", async () => {
    const h = harness();
    const setup = createWorkerAutoSetup(h.deps);
    const run = setup.ensure("provisioned");
    await installCalled(h.deps);
    h.setActive(false);
    h.finishInstall();
    await run;
    expect(h.calls).toEqual(["install"]);
    expect(setup.status()).toMatchObject({ state: "idle" });
  });

  it("halts on withdrawal: cancels the install it started and clears the retry", async () => {
    const h = harness();
    const setup = createWorkerAutoSetup(h.deps);
    const run = setup.ensure("provisioned");
    await installCalled(h.deps);
    h.setActive(false);
    setup.halt();
    await run;
    expect(h.deps.cancelInstall).toHaveBeenCalledTimes(1);
    expect(h.calls).not.toContain("profile");
    expect(h.calls).not.toContain("ping");
    expect(h.timers.every(timer => timer.cancelled)).toBe(true);
    expect(setup.status().state).toBe("idle");
  });

  it("waits with backoff after a network failure, and a restart resumes the saved schedule", async () => {
    const h = harness({ job: { state: "failed", error: "raw 429 text", failureKind: "retry" } });
    const setup = createWorkerAutoSetup(h.deps);
    const run = setup.ensure("boot");
    await installCalled(h.deps); h.finishInstall(); await run;
    expect(setup.status()).toMatchObject({ state: "waiting_retry", code: "retry", detail: AUTO_SETUP_COPY.retry, nextRetryAt: 1_000_000 + AUTO_SETUP_BACKOFF_MS[0] });
    expect(JSON.stringify(setup.status())).not.toContain("raw 429");
    expect(h.record()).toMatchObject({ attempts: 1, nextRetryAt: 1_000_000 + AUTO_SETUP_BACKOFF_MS[0], held: null });

    const restarted = harness({ job: { state: "failed", error: "busy", failureKind: "retry" } });
    const again = createWorkerAutoSetup(restarted.deps);
    await again.ensure("boot");
    expect(restarted.deps.installOrRepair).not.toHaveBeenCalled();
    expect(again.status()).toMatchObject({ state: "waiting_retry", nextRetryAt: 1_000_000 + AUTO_SETUP_BACKOFF_MS[0] });
    expect(restarted.timers.at(-1)?.at).toBe(1_000_000 + AUTO_SETUP_BACKOFF_MS[0]);

    restarted.advance(AUTO_SETUP_BACKOFF_MS[0]);
    const due = again.ensure("retry");
    await installCalled(restarted.deps); restarted.finishInstall(); await due;
    expect(restarted.record()).toMatchObject({ attempts: 2, nextRetryAt: 1_000_000 + AUTO_SETUP_BACKOFF_MS[0] + AUTO_SETUP_BACKOFF_MS[1] });
  });

  it("stops retrying after the cap, holds with fixed copy, and Try again starts over", async () => {
    const h = harness({ job: { state: "failed", error: "busy", failureKind: "retry" } });
    const setup = createWorkerAutoSetup(h.deps);
    for (let attempt = 1; attempt <= AUTO_SETUP_MAX_ATTEMPTS; attempt++) {
      const run = setup.ensure(attempt === 1 ? "boot" : "retry");
      await installCalled(h.deps, attempt); h.finishInstall(); await run;
      h.advance(60 * 60_000);
    }
    expect(setup.status()).toMatchObject({ state: "held", code: "held_exhausted", step: 1,
      detail: "Bud couldn’t finish setting up on this computer. It stopped while installing Bud. RealBud support has the details; try again later." });
    await setup.ensure("retry");
    expect(h.deps.installOrRepair).toHaveBeenCalledTimes(AUTO_SETUP_MAX_ATTEMPTS);
    h.setJob({ state: "done", failureKind: undefined, error: null });
    const retry = setup.retry();
    await installCalled(h.deps, AUTO_SETUP_MAX_ATTEMPTS + 1); h.finishInstall(); await retry;
    expect(setup.status().state).toBe("ready");
  });

  it("retries a stopped installer stage once, then holds", async () => {
    const h = harness({ job: { state: "failed", error: "stage", failureKind: "once" } });
    const setup = createWorkerAutoSetup(h.deps);
    const first = setup.ensure("boot");
    await installCalled(h.deps); h.finishInstall(); await first;
    expect(setup.status().state).toBe("waiting_retry");
    h.advance(AUTO_SETUP_BACKOFF_MS[0]);
    const second = setup.ensure("retry");
    await installCalled(h.deps, 2); h.finishInstall(); await second;
    expect(setup.status()).toMatchObject({ state: "held", code: "held_failed" });
  });

  it("holds on a final failure with fixed copy until the office approves again", async () => {
    const h = harness({ job: { state: "failed", error: "/synthetic/path hash mismatch", failureKind: "final" } });
    const setup = createWorkerAutoSetup(h.deps);
    const run = setup.ensure("boot");
    await installCalled(h.deps); h.finishInstall(); await run;
    const stopped = { state: "held", code: "held_failed", step: 1, detail: "Bud’s setup stopped while installing Bud. Your files are kept. Try again, or contact RealBud support." };
    expect(setup.status()).toMatchObject(stopped);
    expect(JSON.stringify(h.record())).not.toContain("synthetic");
    // The step is saved with the hold, so a restart still names it.
    expect(h.record()).toMatchObject({ held: "held_failed", step: 1 });
    const restarted = createWorkerAutoSetup(h.deps);
    await restarted.ensure("boot");
    expect(restarted.status()).toMatchObject(stopped);
    await setup.ensure("periodic");
    expect(h.deps.installOrRepair).toHaveBeenCalledTimes(1);
    const fresh = setup.ensure("provisioned");
    await installCalled(h.deps, 2); h.finishInstall(); await fresh;
    expect(h.deps.installOrRepair).toHaveBeenCalledTimes(2);
  });

  it("names only a known setup step and keeps the plain copy otherwise", () => {
    expect(autoSetupDetail("held_failed", 3)).toBe("Bud’s setup stopped while connecting Bud’s model. Your files are kept. Try again, or contact RealBud support.");
    expect(autoSetupDetail("held_exhausted", 4)).toMatch(/It stopped while running the private readiness check\./);
    expect(autoSetupDetail("held_failed", 0)).toBe(AUTO_SETUP_COPY.held_failed);
    expect(autoSetupDetail("held_restart", 1)).toBe(AUTO_SETUP_COPY.held_restart);
    expect(autoSetupDetail("installing", 1)).toBe(AUTO_SETUP_COPY.installing);
  });

  it("parks a restart hold instead of re-probing it every tick", async () => {
    const h = harness();
    (h.deps.installOrRepair as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ kind: "awaiting_restart" }));
    const setup = createWorkerAutoSetup(h.deps);
    await setup.ensure("boot");
    expect(setup.status()).toMatchObject({ state: "held", code: "held_restart" });
    await setup.ensure("periodic");
    expect(h.deps.installOrRepair).toHaveBeenCalledTimes(1);
  });

  it("retries a missed readiness check instead of reporting ready", async () => {
    const h = harness({ ping: false });
    const setup = createWorkerAutoSetup(h.deps);
    const run = setup.ensure("boot");
    await installCalled(h.deps); h.finishInstall(); await run;
    expect(setup.status()).toMatchObject({ state: "waiting_retry", detail: AUTO_SETUP_COPY.retry });
    expect(h.calls.filter(call => call === "ping")).toHaveLength(1);
  });

  it("holds a damaged attempt record rather than overwriting it", async () => {
    plantPrivateFile(join(dir, AUTO_SETUP_FILE), "{not json");
    const h = harness();
    const setup = createWorkerAutoSetup(h.deps);
    await setup.ensure("boot");
    expect(setup.status()).toMatchObject({ state: "held", code: "held_recovery" });
    expect(h.deps.installOrRepair).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, AUTO_SETUP_FILE), "utf8")).toBe("{not json");
  });
});

describe("automatic setup authority across asynchronous boundaries", () => {
  it.each([false, true])("does not install or report ready after authority is withdrawn during a status probe (ready=%s)", async ready => {
    const h = harness();
    vi.mocked(h.deps.status).mockImplementation(async () => {
      h.setActive(false);
      return status({ compatible: ready, ready });
    });
    const setup = createWorkerAutoSetup(h.deps);
    await setup.ensure("boot");
    expect(h.deps.installOrRepair).not.toHaveBeenCalled();
    expect(h.deps.ensurePack).not.toHaveBeenCalled();
    expect(setup.status().state).toBe("idle");
    expect(h.timers).toHaveLength(0);
  });

  it.each(["started", "running"] as const)("halts during installer admission without cancelling someone else's install (%s)", async kind => {
    const h = harness();
    const admission = deferred<WorkerInstallOutcome>();
    let inFlight = false;
    h.deps.installInFlight = () => inFlight;
    vi.mocked(h.deps.installOrRepair).mockImplementation(() => admission.promise);
    const setup = createWorkerAutoSetup(h.deps);
    const run = setup.ensure("provisioned");
    await installCalled(h.deps);
    h.setActive(false);
    setup.halt();
    inFlight = true;
    admission.resolve({ kind, install: { state: "running" } as InstallJob });
    await run;
    expect(h.deps.cancelInstall).toHaveBeenCalledTimes(kind === "started" ? 1 : 0);
    expect(h.deps.ensurePack).not.toHaveBeenCalled();
    expect(setup.status().state).toBe("idle");
  });

  it("does not revive an old run when the office relinks before its status reply", async () => {
    const h = harness();
    const probe = deferred<HermesStatus>();
    vi.mocked(h.deps.status).mockImplementationOnce(() => probe.promise)
      .mockImplementation(async () => status({ ready: true }));
    const setup = createWorkerAutoSetup(h.deps);
    const run = setup.ensure("boot");
    await vi.waitFor(() => expect(h.deps.status).toHaveBeenCalledTimes(1));
    h.setActive(false);
    setup.halt();
    h.setActive(true);
    const fresh = setup.ensure("provisioned");
    expect(fresh).toBe(run);
    probe.resolve(status({ compatible: false }));
    await run;
    await vi.waitFor(() => expect(setup.status().state).toBe("ready"));
    expect(h.deps.status).toHaveBeenCalledTimes(2);
    expect(h.deps.installOrRepair).not.toHaveBeenCalled();
  });

  it.each(["ping", "final-status"])("does not publish readiness or a retry after withdrawal during %s", async boundary => {
    const h = harness();
    let probes = 0;
    vi.mocked(h.deps.status).mockImplementation(async () => {
      probes++;
      if (probes === 3) h.setActive(false);
      return status({ ready: probes === 3 });
    });
    vi.mocked(h.deps.readinessPing).mockImplementation(async () => {
      if (boundary === "ping") h.setActive(false);
      return { ok: boundary !== "ping", detail: "fictional late result" };
    });
    const setup = createWorkerAutoSetup(h.deps);
    await setup.ensure("boot");
    expect(h.deps.readinessPing).toHaveBeenCalledTimes(1);
    expect(setup.status().state).toBe("idle");
    expect(h.timers).toHaveLength(0);
  });

  it("does not publish a late failure or retry after halt", async () => {
    const h = harness();
    const probe = deferred<HermesStatus>();
    vi.mocked(h.deps.status).mockImplementationOnce(() => probe.promise);
    const setup = createWorkerAutoSetup(h.deps);
    const run = setup.ensure("boot");
    await vi.waitFor(() => expect(h.deps.status).toHaveBeenCalledTimes(1));
    setup.halt();
    probe.reject(new Error("fictional late probe failure"));
    await run;
    expect(setup.status().state).toBe("idle");
    expect(h.timers).toHaveLength(0);
  });

  it.each(["ready", "held", "retry"])("does not publish stale %s state after its private save finishes", async outcome => {
    const h = harness();
    plantPrivateFile(join(dir, AUTO_SETUP_FILE), JSON.stringify({ version: 1, attempts: 1, nextRetryAt: null, held: null, stageRetried: false }));
    vi.mocked(h.deps.status).mockImplementation(async () => status({ ready: outcome === "ready" }));
    vi.mocked(h.deps.readinessPing).mockImplementation(async () => {
      if (outcome === "held") throw new Error("fictional readiness failure");
      return { ok: false, detail: "fictional transient failure" };
    });
    const saving = deferred<void>(), finish = deferred<void>();
    const write = privateJson.writePrivateJson;
    const save = vi.spyOn(privateJson, "writePrivateJson").mockImplementation(async (...args) => {
      saving.resolve();
      await finish.promise;
      return write(...args);
    });
    try {
      const setup = createWorkerAutoSetup(h.deps);
      const run = setup.ensure("boot");
      await saving.promise;
      setup.halt();
      finish.resolve();
      await run;
      expect(setup.status().state).toBe("idle");
      expect(h.timers).toHaveLength(0);
    } finally { save.mockRestore(); }
  });
});

describe("a readiness proof that went stale on a linked office", () => {
  it("re-runs the service's own check once per changed setup, throttled, with no administrator", async () => {
    const h = harness();
    const setup = createWorkerAutoSetup(h.deps);
    // Already installed and ready once.
    (h.deps.status as ReturnType<typeof vi.fn>).mockImplementation(async () => status({ compatible: true, ready: true }));
    await setup.ensure("boot");
    expect(setup.status().state).toBe("ready");
    // Like the real service, a passing readiness ping writes the receipt that makes status ready.
    let proven = false;
    (h.deps.status as ReturnType<typeof vi.fn>).mockImplementation(async () => status({ compatible: true, ready: proven }));
    (h.deps.readinessPing as ReturnType<typeof vi.fn>).mockImplementation(async () => { proven = true; return { ok: true, detail: "ok" }; });
    const noteStatus = setup.noteStatus;
    setup.noteStatus = (observed: Parameters<typeof noteStatus>[0]) => { proven = false; noteStatus(observed); };
    const stale = { ready: false, workerFingerprint: "fingerprint-b" };
    setup.noteStatus(stale);
    // Reported at once, so the very next status answer shows progress.
    expect(setup.status()).toMatchObject({ state: "verifying", code: "checking", detail: AUTO_SETUP_COPY.checking });
    await vi.waitFor(() => expect(h.deps.readinessPing).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(setup.status().state).toBe("ready"));
    // The same stale setup is not re-checked again, and a new one waits a minute.
    setup.noteStatus(stale);
    setup.noteStatus({ ready: false, workerFingerprint: "fingerprint-c" });
    expect(h.deps.readinessPing).toHaveBeenCalledTimes(1);
    h.advance(61_000);
    setup.noteStatus({ ready: false, workerFingerprint: "fingerprint-c" });
    await vi.waitFor(() => expect(h.deps.readinessPing).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(setup.status().state).toBe("ready"));
    // Flipping between two setups does not re-run the paid check each minute.
    h.advance(61_000);
    setup.noteStatus(stale);
    expect(h.deps.readinessPing).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 10; i++) {
      h.advance(61_000);
      setup.noteStatus({ ready: false, workerFingerprint: `fingerprint-new-${i}` });
      await vi.waitFor(() => expect(setup.status().state).toBe("ready"));
    }
    expect(h.deps.readinessPing).toHaveBeenCalledTimes(6);
    expect(h.deps.installOrRepair).not.toHaveBeenCalled();
  });

  it("does nothing for a computer whose office link is not active", async () => {
    const h = harness({ active: false });
    const setup = createWorkerAutoSetup(h.deps);
    setup.noteStatus({ ready: false, workerFingerprint: "fingerprint-b" });
    expect(setup.status().state).toBe("idle");
    await setup.ensure("boot");
    expect(h.deps.readinessPing).not.toHaveBeenCalled();
  });
});

describe("automatic Bud setup after an upgrade changes the pack", () => {
  /** An installed, compatible worker whose profile predates the new pack. */
  function upgraded(options: { repairFixes?: boolean; pingOk?: boolean; readyAfterPing?: boolean; documentTools?: HermesStatus["documentTools"] } = {}) {
    let workroomReady = false, ready = false, pinged = false;
    const calls: string[] = [];
    const current = (): HermesStatus => ({
      ...status({ ready }),
      pack: { installed: true, approvalsManual: true, workroomReady },
      documentTools: options.documentTools,
    } as HermesStatus);
    const deps: WorkerAutoSetupDeps = {
      directory: dir,
      active: vi.fn(async () => true),
      cancelInstall: vi.fn(),
      status: vi.fn(async () => current()),
      installOrRepair: vi.fn(async (): Promise<WorkerInstallOutcome> => {
        calls.push("repair");
        if (options.repairFixes ?? true) workroomReady = true;
        return { kind: "repaired", hermes: current() };
      }),
      installInFlight: () => false,
      installStatus: () => ({ state: "done", lines: [], startedAt: 1, finishedAt: 2, error: null }) as InstallJob,
      waitForInstall: async () => {},
      ensurePack: vi.fn(() => { calls.push("pack"); }),
      reconcileProfile: vi.fn(async () => { calls.push("profile"); return true; }),
      syncBud: vi.fn(() => { calls.push("rebind"); }),
      readinessPing: vi.fn(async () => {
        calls.push("ping"); pinged = true;
        const ok = options.pingOk ?? true;
        if (ok && (options.readyAfterPing ?? true) && workroomReady) ready = true;
        return { ok, detail: ok ? "ok" : "no answer" };
      }),
      now: () => 1_000_000,
      setTimer: () => ({ cancel: () => {} }),
    };
    return { deps, calls, pinged: () => pinged };
  }

  it("re-applies a stale pack policy through the reviewed repair on boot, then proves readiness", async () => {
    const h = upgraded();
    const setup = createWorkerAutoSetup(h.deps);
    await setup.ensure("boot");
    expect(h.calls).toEqual(["repair", "pack", "profile", "rebind", "ping"]);
    expect(setup.status()).toMatchObject({ state: "ready" });
  });

  it("Try again re-applies a stale policy instead of doing nothing", async () => {
    const h = upgraded();
    const setup = createWorkerAutoSetup(h.deps);
    await setup.retry();
    expect(h.calls[0]).toBe("repair");
    expect(setup.status()).toMatchObject({ state: "ready" });
  });

  it("never reports ready when the policy could not be updated", async () => {
    const h = upgraded({ repairFixes: false });
    const setup = createWorkerAutoSetup(h.deps);
    await setup.ensure("boot");
    expect(h.pinged()).toBe(false);
    expect(setup.status().state).not.toBe("ready");
  });

  it("a passing ping alone is not readiness", async () => {
    const h = upgraded({ readyAfterPing: false });
    const setup = createWorkerAutoSetup(h.deps);
    await setup.ensure("boot");
    expect(h.pinged()).toBe(true);
    expect(setup.status().state).not.toBe("ready");
  });

  it("missing document tools trigger the repair on boot but not on the periodic tick", async () => {
    const boot = upgraded({ documentTools: "needs_repair" });
    await createWorkerAutoSetup(boot.deps).ensure("boot");
    expect(boot.calls).toContain("repair");

    const tick = upgraded({ documentTools: "needs_repair" });
    const setup = createWorkerAutoSetup(tick.deps);
    await setup.ensure("boot");
    const repairsAfterBoot = tick.calls.filter(call => call === "repair").length;
    await setup.ensure("periodic");
    expect(tick.calls.filter(call => call === "repair").length).toBe(repairsAfterBoot);
  });
});

describe("a newly locked document library after an upgrade", () => {
  it("boot reads documents as unknown and is ready; the later needs_repair status runs the reviewed repair once an hour", async () => {
    let time = 1_000_000, documentTools: HermesStatus["documentTools"] = "unknown";
    const calls: string[] = [];
    const current = (): HermesStatus => ({ ...status({ ready: true }), documentTools } as HermesStatus);
    const deps: WorkerAutoSetupDeps = {
      directory: dir,
      active: vi.fn(async () => true),
      cancelInstall: vi.fn(),
      status: vi.fn(async () => current()),
      installOrRepair: vi.fn(async (): Promise<WorkerInstallOutcome> => { calls.push("repair"); documentTools = "ready"; return { kind: "repaired", hermes: current() }; }),
      installInFlight: () => false,
      installStatus: () => ({ state: "done", lines: [], startedAt: 1, finishedAt: 2, error: null }) as InstallJob,
      waitForInstall: async () => {},
      ensurePack: vi.fn(() => { calls.push("pack"); }),
      reconcileProfile: vi.fn(async () => true),
      syncBud: vi.fn(),
      readinessPing: vi.fn(async () => ({ ok: true, detail: "ok" })),
      now: () => time,
      setTimer: () => ({ cancel: () => {} }),
    };
    const setup = createWorkerAutoSetup(deps);
    // Boot: the background document check has not finished yet.
    await setup.ensure("boot");
    expect(setup.status().state).toBe("ready");
    expect(calls).not.toContain("repair");
    // The check finishes: a library the new release locks is missing.
    documentTools = "needs_repair";
    setup.noteStatus({ ready: true, workerFingerprint: "fp", documentTools: "needs_repair" });
    await vi.waitFor(() => expect(calls.filter(c => c === "repair")).toHaveLength(1));
    await vi.waitFor(() => expect(setup.status().state).toBe("ready"));
    // A failing install never loops: no second repair inside the hour.
    documentTools = "needs_repair";
    setup.noteStatus({ ready: true, workerFingerprint: "fp", documentTools: "needs_repair" });
    expect(calls.filter(c => c === "repair")).toHaveLength(1);
    time += 61 * 60_000;
    setup.noteStatus({ ready: true, workerFingerprint: "fp", documentTools: "needs_repair" });
    await vi.waitFor(() => expect(calls.filter(c => c === "repair")).toHaveLength(2));
  });
});
