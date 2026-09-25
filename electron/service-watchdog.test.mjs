// Automatic restart of a crashed office service. The rules that matter: a
// deliberate stop is never undone, a service of ours that is answering (or
// might still be starting) is never duplicated, and restarts are bounded.
import { describe, expect, it, vi } from "vitest";

import { createServiceWatchdog, decideServiceRestart, EMPTY_WATCHDOG_HISTORY, WATCHDOG_DEFAULTS } from "./service-watchdog.mjs";

/** The detached service has crashed: record present, process gone, nothing answering. */
const down = (over = {}) => ({
  quitting: false,
  stopRequested: false,
  startInFlight: false,
  answeringPort: null,
  currentPort: 8799,
  recorded: true,
  recordedAlive: false,
  recordedPortAnswers: false,
  ...over,
});
const up = (over = {}) => down({ answeringPort: 8799, ...over });

/** Run decisions over time, carrying history like the watchdog does. */
function run(steps) {
  let history = EMPTY_WATCHDOG_HISTORY;
  return steps.map(([observation, at]) => {
    const decision = decideServiceRestart(observation, history, at);
    history = decision.history;
    return decision;
  });
}

describe("service restart decision", () => {
  it("never restarts a service the person stopped deliberately", () => {
    const decision = decideServiceRestart(down({ stopRequested: true }), { attempts: [], downSince: 0 }, 600_000);
    expect(decision).toMatchObject({ action: "none", reason: "stopped-deliberately" });
    expect(decision.history.downSince).toBeNull();
  });

  it("leaves an adopted, healthy service alone", () => {
    expect(decideServiceRestart(up(), EMPTY_WATCHDOG_HISTORY, 0)).toMatchObject({ action: "none", reason: "healthy" });
  });

  it("restarts a dead service only after consecutive failed checks spanning the confirmation window", () => {
    const [first, second, third, early, due] = run([[down(), 0], [down(), 10_000], [down(), 20_000], [down(), 44_999], [down(), 45_000]]);
    expect(first).toMatchObject({ action: "wait", reason: "confirming", retryAt: 45_000 });
    expect(second.history.downChecks).toBe(2);
    // Three failed checks are not enough on their own: they must also span 45 s.
    expect(third).toMatchObject({ action: "wait", reason: "confirming" });
    expect(early.action).toBe("wait");
    expect(due).toMatchObject({ action: "restart", reason: "service-down" });
    expect(due.history.attempts).toEqual([45_000]);
  });

  it("does not believe an outage that the service answers in the middle of (a slow Recheck)", () => {
    const decisions = run([[down(), 0], [down(), 10_000], [up(), 20_000], [down(), 30_000], [down(), 40_000], [down(), 60_000], [up(), 70_000], [down(), 80_000]]);
    expect(decisions.some(decision => decision.action === "restart")).toBe(false);
    expect(decisions[3].history).toMatchObject({ downSince: 30_000, downChecks: 1 });
    expect(decisions.at(-1).history).toMatchObject({ downSince: 80_000, downChecks: 1 });
  });

  it("needs the time span as well as the count, even with fast checks", () => {
    const decisions = run(Array.from({ length: 10 }, (_, i) => [down(), i * 1_000]));
    expect(decisions.every(decision => decision.action === "wait" && decision.reason === "confirming")).toBe(true);
  });

  it("confirms for 45 s, then backs off 30 s, 2 min, then 2 min between later attempts", () => {
    let history = EMPTY_WATCHDOG_HISTORY;
    let now = 0;
    const gaps = [];
    for (let i = 0; i < 5; i++) {
      const start = now;
      // Tick every second until the next restart is allowed.
      for (;;) {
        const decision = decideServiceRestart(down(), history, now);
        history = decision.history;
        if (decision.action === "restart") break;
        expect(decision.action).toBe("wait");
        now += 1_000;
      }
      gaps.push(now - start);
    }
    expect(gaps).toEqual([45_000, 30_000, 120_000, 120_000, 120_000]);
  });

  it("measures the next backoff from a new outage, not from an old attempt", () => {
    // Restarted at 45 s, healthy for 40 minutes, then down again.
    const [, , restarted, healthy, again, , due] = run([[down(), 0], [down(), 20_000], [down(), 45_000], [up(), 60_000], [down(), 2_400_000], [down(), 2_420_000], [down(), 2_445_000]]);
    expect(restarted.action).toBe("restart");
    expect(healthy.history).toMatchObject({ downSince: null, downChecks: 0 });
    expect(again).toMatchObject({ action: "wait", reason: "confirming", retryAt: 2_445_000 });
    expect(due.action).toBe("restart");
  });

  it("pauses after 5 attempts in an hour and resumes once they age out", () => {
    const attempts = [0, 10_000, 20_000, 30_000, 40_000];
    const capped = decideServiceRestart(down(), { attempts, downSince: 0, downChecks: 3 }, 1_000_000);
    expect(capped).toMatchObject({ action: "none", reason: "exhausted" });
    const later = decideServiceRestart(down(), capped.history, WATCHDOG_DEFAULTS.windowMs + 40_001);
    expect(later.action).toBe("restart");
  });

  it("does nothing while the app is quitting", () => {
    expect(decideServiceRestart(down({ quitting: true }), { attempts: [], downSince: 0 }, 600_000)).toMatchObject({ action: "none", reason: "quitting" });
  });

  it("adopts another session's service answering on another port instead of starting one", () => {
    const decision = decideServiceRestart(down({ answeringPort: 18799 }), { attempts: [], downSince: 0 }, 600_000);
    expect(decision).toMatchObject({ action: "adopt", reason: "answering-elsewhere" });
    expect(decision.history.attempts).toEqual([]);
  });

  it("never starts while something of ours answers on the recorded port", () => {
    expect(decideServiceRestart(down({ recordedPortAnswers: true }), { attempts: [], downSince: 0 }, 600_000)).toMatchObject({ action: "none", reason: "recorded-port-answers" });
  });

  it("never starts beside a live process that has not answered yet", () => {
    expect(decideServiceRestart(down({ recordedAlive: true }), { attempts: [], downSince: 0 }, 600_000)).toMatchObject({ action: "none", reason: "process-alive" });
  });

  it("needs a recorded service before restarting anything", () => {
    expect(decideServiceRestart(down({ recorded: false }), { attempts: [], downSince: 0 }, 600_000)).toMatchObject({ action: "none", reason: "no-record" });
  });

  it("waits for a start already in flight and keeps the outage clock", () => {
    const decision = decideServiceRestart(down({ startInFlight: true }), { attempts: [], downSince: 1_000 }, 600_000);
    expect(decision).toMatchObject({ action: "none", reason: "start-in-flight" });
    expect(decision.history.downSince).toBe(1_000);
  });
});

describe("service watchdog", () => {
  function harness(observations, { startOrAdopt = vi.fn(async () => true) } = {}) {
    let clock = Date.parse("2026-09-23T10:00:00");
    const queue = [...observations];
    const log = vi.fn();
    const adopt = vi.fn();
    const watchdog = createServiceWatchdog({
      observe: async () => queue.shift() ?? up(),
      startOrAdopt, adopt, log,
      now: () => clock,
    });
    return { watchdog, startOrAdopt, adopt, log, advance: (ms) => { clock += ms; } };
  }

  it("restarts through startOrAdopt and reports it for today", async () => {
    const h = harness(Array.from({ length: 6 }, () => down()));
    for (let i = 0; i < 5; i++) {
      expect((await h.watchdog.tick())?.action).toBe("wait");
      h.advance(10_000);
    }
    expect(h.watchdog.status()).toMatchObject({ pending: true, today: 0, exhausted: false });
    expect(h.startOrAdopt).not.toHaveBeenCalled();
    expect((await h.watchdog.tick())?.action).toBe("restart");
    expect(h.startOrAdopt).toHaveBeenCalledTimes(1);
    expect(h.watchdog.status()).toMatchObject({ today: 1, lastResult: "started", lastReason: "service-down", pending: false });
    h.advance(10_000);
    expect((await h.watchdog.tick())?.reason).toBe("healthy");
    expect(h.log).toHaveBeenCalledWith("the office service is answering again");
  });

  it("counts a failed restart against the budget but not as a restart today", async () => {
    const h = harness(Array.from({ length: 6 }, () => down()), { startOrAdopt: vi.fn(async () => false) });
    for (let i = 0; i < 6; i++) { await h.watchdog.tick(); h.advance(10_000); }
    expect(h.startOrAdopt).toHaveBeenCalledTimes(1);
    expect(h.watchdog.status()).toMatchObject({ today: 0, lastResult: "failed" });
  });

  it("adopts without starting or counting a restart", async () => {
    const h = harness([down({ answeringPort: 18799 })]);
    expect((await h.watchdog.tick())?.action).toBe("adopt");
    expect(h.adopt).toHaveBeenCalledWith(18799);
    expect(h.startOrAdopt).not.toHaveBeenCalled();
    expect(h.watchdog.status().today).toBe(0);
  });

  it("reports the pause once the hourly limit is reached", async () => {
    const observations = Array.from({ length: 80 }, () => down());
    const h = harness(observations, { startOrAdopt: vi.fn(async () => false) });
    for (let i = 0; i < 80; i++) { await h.watchdog.tick(); h.advance(WATCHDOG_DEFAULTS.tickMs); }
    expect(h.startOrAdopt).toHaveBeenCalledTimes(5);
    expect(h.watchdog.status()).toMatchObject({ exhausted: true, lastReason: "exhausted", pending: false });
    expect(h.log.mock.calls.filter(([line]) => line.includes("paused"))).toHaveLength(1);
  });

  it("runs one check at a time and stops acting once stopped", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const startOrAdopt = vi.fn(async () => true);
    const watchdog = createServiceWatchdog({
      observe: async () => { await gate; return down(); },
      startOrAdopt,
      now: () => 100_000,
    });
    const first = watchdog.tick();
    expect(await watchdog.tick()).toBeNull();
    watchdog.stop();
    release();
    expect(await first).toBeNull();
    expect(await watchdog.tick()).toBeNull();
    expect(startOrAdopt).not.toHaveBeenCalled();
  });

  it("survives a failed check without acting", async () => {
    const log = vi.fn();
    const startOrAdopt = vi.fn(async () => true);
    const watchdog = createServiceWatchdog({ observe: async () => { throw new Error("probe broke"); }, startOrAdopt, log });
    expect(await watchdog.tick()).toBeNull();
    expect(startOrAdopt).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("the office service check failed: probe broke");
  });
});
