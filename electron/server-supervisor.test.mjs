// Supervision rules for the desk service child process. These are the
// behaviours that decide whether a crashed office recovers by itself or stays
// silently dead until somebody reopens RealBud.
import { describe, expect, it, vi } from "vitest";

import { createServerSupervisor } from "./server-supervisor.mjs";

/** Deterministic harness: manual clock, no real timers. */
function harness({ supervision = {}, start } = {}) {
  let clock = 0;
  const waits = [];
  const statuses = [];
  const killed = [];
  let forks = 0;
  const makeChild = () => {
    const id = ++forks;
    return { id, kill: () => killed.push(id) };
  };
  const supervisor = createServerSupervisor({
    start: start ?? (async () => makeChild()),
    kill: (child) => child?.kill(),
    onStatus: (status) => statuses.push(status.state),
    wait: (ms) => { waits.push(ms); return Promise.resolve(); },
    now: () => clock,
    supervision,
  });
  return {
    supervisor, waits, statuses, killed,
    get forks() { return forks; },
    advance: (ms) => { clock += ms; },
    /** Flush queued microtasks so scheduled retries run. */
    flush: async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); },
  };
}

describe("desk service supervision", () => {
  it("starts once and reuses the running child", async () => {
    const h = harness();
    expect(await h.supervisor.ensureStarted()).toBe(true);
    expect(await h.supervisor.ensureStarted()).toBe(true);
    expect(h.forks).toBe(1);
    expect(h.supervisor.getStatus().state).toBe("running");
  });

  it("restarts the service after an unexpected exit", async () => {
    const h = harness();
    await h.supervisor.ensureStarted();
    const first = h.supervisor.current();
    expect(h.supervisor.notifyExit(1)).toBe(true);
    await h.flush();
    expect(h.forks).toBe(2);
    expect(h.supervisor.current()).not.toBe(first);
    expect(h.supervisor.getStatus()).toMatchObject({ state: "running", lastExitCode: null });
  });

  it("gives up after the bounded budget instead of restarting forever", async () => {
    const h = harness({ supervision: { maxRestarts: 2, baseDelayMs: 1 } });
    await h.supervisor.ensureStarted();
    for (let i = 0; i < 5; i++) { h.supervisor.notifyExit(1); await h.flush(); }
    expect(h.forks).toBeLessThanOrEqual(2);
    expect(await h.supervisor.ensureStarted()).toBe(false);
    expect(h.forks).toBe(2);
  });

  it("allows a fresh budget after the rolling window passes", async () => {
    const h = harness({ supervision: { maxRestarts: 1, windowMs: 1_000, baseDelayMs: 1 } });
    await h.supervisor.ensureStarted();
    h.supervisor.notifyExit(1);
    await h.flush();
    h.advance(5_000);
    h.supervisor.notifyExit(1);
    await h.flush();
    expect(h.supervisor.getStatus().state).toBe("running");
  });

  it("backs off exponentially so a failing service cannot saturate the machine", async () => {
    const h = harness({ supervision: { maxRestarts: 5, baseDelayMs: 100, maxDelayMs: 400 } });
    await h.supervisor.ensureStarted();
    for (let i = 0; i < 3; i++) { h.supervisor.notifyExit(1); await h.flush(); }
    // First retry waits one base delay, then doubles, then clamps at the ceiling.
    expect(h.waits.slice(0, 3)).toEqual([100, 200, 400]);
  });

  it("does not restart while failing to start", async () => {
    let attempt = 0;
    const h = harness({
      supervision: { maxRestarts: 2, baseDelayMs: 1 },
      start: async () => { attempt += 1; return null; },
    });
    await h.supervisor.ensureStarted();
    await h.flush();
    await h.flush();
    // The budget bounds forks; a spent budget stops further attempts.
    expect(attempt).toBeLessThanOrEqual(2);
    expect(await h.supervisor.ensureStarted()).toBe(false);
    expect(attempt).toBe(2);
  });

  it("never restarts after stop, so quitting stays deterministic", async () => {
    const h = harness();
    await h.supervisor.ensureStarted();
    await h.supervisor.stop();
    expect(h.supervisor.isStopping()).toBe(true);
    expect(h.supervisor.notifyExit(0)).toBe(false);
    await h.flush();
    expect(h.forks).toBe(1);
    expect(h.killed).toEqual([1]);
  });

  it("does not adopt a child that finished forking after stop", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const h = harness({ start: async () => { await gate; return { id: 1, kill: () => h.killed.push(1) }; } });
    const pending = h.supervisor.ensureStarted();
    await h.supervisor.stop();
    release();
    expect(await pending).toBe(false);
    expect(h.supervisor.current()).toBeNull();
    expect(h.killed).toEqual([1]);
  });

  it("reports every transition so a dead office is visible, not silent", async () => {
    const h = harness();
    await h.supervisor.ensureStarted();
    h.supervisor.notifyExit(3);
    await h.flush();
    expect(h.statuses).toContain("starting");
    expect(h.statuses).toContain("running");
    expect(h.statuses).toContain("exited");
  });

  it("shares one fork between concurrent callers", async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.supervisor.ensureStarted(), h.supervisor.ensureStarted()]);
    expect([a, b]).toEqual([true, true]);
    expect(h.forks).toBe(1);
  });

  it("exposes the current child and status without leaking internals", async () => {
    const h = harness();
    await h.supervisor.ensureStarted();
    const status = h.supervisor.getStatus();
    expect(status).toMatchObject({ state: "running", exhausted: false });
    // Mutating the returned status must not affect the supervisor.
    status.state = "tampered";
    expect(h.supervisor.getStatus().state).toBe("running");
  });

  it("recovers from an exhausted budget when a person asks it to", async () => {
    const h = harness({ supervision: { maxRestarts: 1, baseDelayMs: 1 } });
    await h.supervisor.ensureStarted();
    h.supervisor.notifyExit(1);
    await h.flush();
    h.supervisor.notifyExit(1);
    await h.flush();
    expect(await h.supervisor.ensureStarted()).toBe(false);
    // Recovery is an explicit human action, so it clears the spent budget.
    expect(await h.supervisor.restart()).toBe(true);
    expect(h.supervisor.getStatus()).toMatchObject({ state: "running", exhausted: false });
  });

  it("survives a quit that races a person's retry", async () => {
    const h = harness();
    await h.supervisor.ensureStarted();
    h.supervisor.notifyExit(1);
    // Quit arrives while the retry is pending.
    await h.supervisor.stop();
    await h.flush();
    expect(h.supervisor.getStatus().state).toBe("stopped");
    expect(await h.supervisor.restart()).toBe(false);
    await h.flush();
    expect(h.forks).toBe(1);
  });

  it("never forks a second service when a retry is asked for while one runs", async () => {
    const h = harness();
    await h.supervisor.ensureStarted();
    expect(await h.supervisor.restart()).toBe(true);
    expect(h.forks).toBe(1);
    expect(h.killed).toEqual([]);
  });

  it("does not let a retry revive a supervisor that was shut down", async () => {
    const h = harness();
    await h.supervisor.ensureStarted();
    await h.supervisor.stop();
    // A retry is a recovery action for a live app, not a way to defeat quit.
    // Otherwise a renderer click during shutdown could fork an orphaned service
    // holding the office database.
    expect(await h.supervisor.restart()).toBe(false);
    await h.flush();
    expect(h.forks).toBe(1);
    expect(h.killed).toEqual([1]);
  });
});
