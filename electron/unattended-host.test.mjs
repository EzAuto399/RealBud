// Supervision after the last window closes. The rules that matter: opted-in
// unattended work keeps the watchdog and keep-awake alive on Windows, nothing
// changes for someone who did not opt in, a deliberate Stop is never undone,
// and a second launch never produces a second supervisor.
import { describe, expect, it, vi } from "vitest";

import { createServiceWatchdog, decideServiceRestart, EMPTY_WATCHDOG_HISTORY, WATCHDOG_DEFAULTS } from "./service-watchdog.mjs";
import { headlessHostShouldExit, focusedWindowAction, secondInstanceAction, unattendedWorkWanted, windowsClosedAction } from "./unattended-host.mjs";

const optedOut = { startOfficeServiceAtLogin: false, keepAwakeForSchedules: false, scheduleEnabled: false, stopRequested: false };
const installedWindows = { platform: "win32", serviceMode: false, packaged: true, smoke: false, quitting: false };

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

describe("unattended work", () => {
  it("counts any one of sign-in start, keep-awake or an enabled schedule", () => {
    expect(unattendedWorkWanted(optedOut)).toBe(false);
    expect(unattendedWorkWanted({ ...optedOut, startOfficeServiceAtLogin: true })).toBe(true);
    expect(unattendedWorkWanted({ ...optedOut, keepAwakeForSchedules: true })).toBe(true);
    expect(unattendedWorkWanted({ ...optedOut, scheduleEnabled: true })).toBe(true);
  });

  it("is off after a deliberate Stop, whatever else is set", () => {
    expect(unattendedWorkWanted({ startOfficeServiceAtLogin: true, keepAwakeForSchedules: true, scheduleEnabled: true, stopRequested: true })).toBe(false);
  });

  it("treats a missing or non-boolean value as not opted in", () => {
    expect(unattendedWorkWanted({})).toBe(false);
    expect(unattendedWorkWanted({ ...optedOut, scheduleEnabled: "true" })).toBe(false);
  });
});

describe("closing the last window", () => {
  it("keeps supervising in the background on Windows when unattended work is wanted", () => {
    expect(windowsClosedAction({ ...installedWindows, unattended: true })).toEqual({ action: "background", reason: "unattended-work" });
  });

  it("quits as before on Windows when nothing unattended was asked for", () => {
    expect(windowsClosedAction({ ...installedWindows, unattended: false })).toEqual({ action: "quit", reason: "not-opted-in" });
  });

  it("quits after a deliberate Stop even with a schedule on", () => {
    const unattended = unattendedWorkWanted({ ...optedOut, scheduleEnabled: true, keepAwakeForSchedules: true, stopRequested: true });
    expect(windowsClosedAction({ ...installedWindows, unattended })).toMatchObject({ action: "quit" });
  });

  it("keeps the macOS dock behaviour, which already keeps the watchdog and keep-awake", () => {
    expect(windowsClosedAction({ ...installedWindows, platform: "darwin", unattended: false })).toEqual({ action: "stay", reason: "mac" });
    expect(windowsClosedAction({ ...installedWindows, platform: "darwin", unattended: true })).toEqual({ action: "stay", reason: "mac" });
  });

  it("never ends the sign-in host", () => {
    expect(windowsClosedAction({ ...installedWindows, serviceMode: true, unattended: false })).toEqual({ action: "stay", reason: "service-host" });
  });

  it("quits for a quit already under way, a smoke run, a development build and Linux", () => {
    expect(windowsClosedAction({ ...installedWindows, quitting: true, unattended: true })).toMatchObject({ action: "quit", reason: "quitting" });
    expect(windowsClosedAction({ ...installedWindows, smoke: true, unattended: true })).toMatchObject({ action: "quit", reason: "smoke" });
    expect(windowsClosedAction({ ...installedWindows, packaged: false, unattended: true })).toMatchObject({ action: "quit", reason: "development" });
    expect(windowsClosedAction({ ...installedWindows, platform: "linux", unattended: true })).toMatchObject({ action: "quit", reason: "platform" });
  });
});

describe("a windowless RealBud and the watchdog", () => {
  it("restarts a crashed service and keeps supervising instead of exiting", () => {
    const decision = decideServiceRestart(down(), { attempts: [], downSince: 0, downChecks: WATCHDOG_DEFAULTS.confirmChecks }, WATCHDOG_DEFAULTS.confirmMs);
    expect(decision).toMatchObject({ action: "restart", reason: "service-down" });
    expect(headlessHostShouldExit(decision)).toBe(false);
  });

  it("keeps supervising through backoff, a silent live process and the hourly limit", () => {
    expect(headlessHostShouldExit(decideServiceRestart(down(), EMPTY_WATCHDOG_HISTORY, 0))).toBe(false); // backoff
    expect(headlessHostShouldExit(decideServiceRestart(down({ recordedAlive: true }), EMPTY_WATCHDOG_HISTORY, 0))).toBe(false);
    const attempts = Array.from({ length: WATCHDOG_DEFAULTS.maxRestarts }, (_, i) => 1_000 + i);
    const exhausted = decideServiceRestart(down(), { attempts, downSince: 0 }, 10_000);
    expect(exhausted.reason).toBe("exhausted");
    expect(headlessHostShouldExit(exhausted)).toBe(false);
  });

  it("never restarts after a deliberate Stop, and ends the windowless process instead", () => {
    const stopped = decideServiceRestart(down({ stopRequested: true }), { attempts: [], downSince: 0 }, 600_000);
    expect(stopped.action).toBe("none");
    expect(headlessHostShouldExit(stopped)).toBe(true);
    // A Stop from a window clears the record, which is what the host sees next.
    const cleared = decideServiceRestart(down({ recorded: false }), EMPTY_WATCHDOG_HISTORY, 600_000);
    expect(cleared).toMatchObject({ action: "none", reason: "no-record" });
    expect(headlessHostShouldExit(cleared)).toBe(true);
  });

  it("does not act on a failed check", () => {
    expect(headlessHostShouldExit(null)).toBe(false);
    expect(headlessHostShouldExit(undefined)).toBe(false);
  });

  it("adopts a service of ours answering elsewhere rather than starting one", async () => {
    const startOrAdopt = vi.fn(async () => true);
    const adopt = vi.fn();
    const watchdog = createServiceWatchdog({ observe: async () => down({ answeringPort: 18799 }), startOrAdopt, adopt, now: () => 0 });
    const decision = await watchdog.tick();
    expect(decision).toMatchObject({ action: "adopt", reason: "answering-elsewhere" });
    expect(adopt).toHaveBeenCalledWith(18799);
    expect(startOrAdopt).not.toHaveBeenCalled();
    expect(headlessHostShouldExit(decision)).toBe(false);
  });

  it("brings a crash back once through the same start-or-adopt, then reports healthy", async () => {
    let now = 0;
    let observation = down();
    const startOrAdopt = vi.fn(async () => { observation = down({ answeringPort: 8799 }); return true; });
    const watchdog = createServiceWatchdog({ observe: async () => observation, startOrAdopt, now: () => now });
    // The outage is believed only after consecutive failed checks over the confirmation window.
    for (; now < WATCHDOG_DEFAULTS.confirmMs; now += WATCHDOG_DEFAULTS.tickMs) expect((await watchdog.tick())?.action).toBe("wait");
    now = WATCHDOG_DEFAULTS.confirmMs;
    expect((await watchdog.tick())?.action).toBe("restart");
    now += WATCHDOG_DEFAULTS.tickMs;
    expect(await watchdog.tick()).toMatchObject({ action: "none", reason: "healthy" });
    expect(startOrAdopt).toHaveBeenCalledTimes(1);
  });
});

describe("a second launch", () => {
  it("ignores a sign-in launch while RealBud is already running", () => {
    for (const serviceMode of [true, false]) {
      for (const hasWindow of [true, false]) {
        expect(secondInstanceAction({ serviceMode, incomingServiceMode: true, hasWindow })).toBe("ignore");
      }
    }
  });

  it("focuses an open window", () => {
    expect(secondInstanceAction({ serviceMode: false, incomingServiceMode: false, hasWindow: true })).toBe("focus");
  });

  it("opens a window in the background process instead of starting a second supervisor", () => {
    expect(secondInstanceAction({ serviceMode: false, incomingServiceMode: false, hasWindow: false })).toBe("open-window");
  });

  it("hands the sign-in host over to a window process, as before", () => {
    expect(secondInstanceAction({ serviceMode: true, incomingServiceMode: false, hasWindow: false })).toBe("hand-over");
  });
});

describe("the window a second launch focuses", () => {
  const officeOrigin = "http://127.0.0.1:8799";
  it("reloads the office window when it is blank or not answering", () => {
    expect(focusedWindowAction({ url: `${officeOrigin}/#desk`, officeOrigin, probe: { answered: true, textLength: 0 } })).toBe("reload");
    expect(focusedWindowAction({ url: `${officeOrigin}/`, officeOrigin, probe: { answered: false, textLength: 0 } })).toBe("reload");
  });
  it("keeps a window that shows the office", () => {
    expect(focusedWindowAction({ url: `${officeOrigin}/`, officeOrigin, probe: { answered: true, textLength: 120 } })).toBe("keep");
  });
  it("never reloads a fallback page, another port or another origin", () => {
    for (const url of ["data:text/html,The office service did not start", "http://127.0.0.1:18799/", "https://example.invalid/", "not a url"]) {
      expect(focusedWindowAction({ url, officeOrigin, probe: { answered: false, textLength: 0 } })).toBe("keep");
    }
  });
});
