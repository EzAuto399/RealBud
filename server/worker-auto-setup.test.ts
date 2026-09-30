import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallJob } from "./hermes-bridge.ts";
import type { HermesStatus } from "./hermes-status.ts";
import type { WorkerInstallOutcome } from "./hermes-update.ts";
import { AUTO_SETUP_BACKOFF_MS, AUTO_SETUP_COPY, AUTO_SETUP_FILE, AUTO_SETUP_MAX_ATTEMPTS, createWorkerAutoSetup, type WorkerAutoSetupDeps } from "./worker-auto-setup.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "realbud-auto-setup-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

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
    expect(setup.status()).toMatchObject({ state: "held", code: "held_exhausted", detail: AUTO_SETUP_COPY.held_exhausted });
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
    expect(setup.status()).toMatchObject({ state: "held", code: "held_failed", detail: AUTO_SETUP_COPY.held_failed });
    expect(JSON.stringify(h.record())).not.toContain("synthetic");
    await setup.ensure("periodic");
    expect(h.deps.installOrRepair).toHaveBeenCalledTimes(1);
    const fresh = setup.ensure("provisioned");
    await installCalled(h.deps, 2); h.finishInstall(); await fresh;
    expect(h.deps.installOrRepair).toHaveBeenCalledTimes(2);
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
    writeFileSync(join(dir, AUTO_SETUP_FILE), "{not json", { mode: 0o600 });
    const h = harness();
    const setup = createWorkerAutoSetup(h.deps);
    await setup.ensure("boot");
    expect(setup.status()).toMatchObject({ state: "held", code: "held_recovery" });
    expect(h.deps.installOrRepair).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, AUTO_SETUP_FILE), "utf8")).toBe("{not json");
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
    (h.deps.status as ReturnType<typeof vi.fn>).mockImplementation(async () => status({ compatible: true, ready: false }));
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
