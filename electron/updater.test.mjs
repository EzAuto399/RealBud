import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  results: [], prepares: 0, installs: 0, checks: 0, starts: 0, packaged: true, appVersion: "0.1.48", userData: "",
  lastInput: 0, locked: false, unsaved: false, activity: { running: true, busy: false, waitingApprovals: 0 },
  updaterEvents: {}, powerEvents: {}, scheduleAtInstall: null, duringHandoff: null, handoffMs: 0, installerFails: false,
}));
vi.mock("electron", () => ({
  app: {
    get isPackaged() { return fixture.packaged; },
    getPath: (name) => (name === "userData" ? fixture.userData : "/synthetic/home"),
    getVersion: () => fixture.appVersion,
  },
  powerMonitor: {
    getSystemIdleTime: () => Math.floor((Date.now() - fixture.lastInput) / 1000),
    getSystemIdleState: () => (fixture.locked ? "locked" : "active"),
    on: (event, fn) => { fixture.powerEvents[event] = fn; },
  },
}));
vi.mock("./update-service-handoff.mjs", () => ({
  // By default a running office service is stopped; `duringHandoff` runs while it stops, which takes `handoffMs`.
  prepareServiceForUpdate: async () => {
    fixture.prepares++;
    await null; // a click reaches main on a later task, never inside this call
    fixture.duringHandoff?.();
    if (fixture.handoffMs) await new Promise((resolve) => setTimeout(resolve, fixture.handoffMs));
    return fixture.results.shift() ?? { ready: true, stopped: true };
  },
  readServiceActivity: async () => fixture.activity,
}));

// The packaged updater is a vendored CommonJS bundle loaded through require;
// seed the require cache with a fictional one so nothing real is downloaded.
const require = createRequire(import.meta.url);
const vendored = require.resolve("./vendor/electron-updater.cjs");
const autoUpdater = {
  on(event, fn) { fixture.updaterEvents[event] = fn; },
  checkForUpdates: async () => { fixture.checks++; return null; },
  // Like the library: an installer that cannot start is reported on "error" and nothing quits.
  quitAndInstall: () => {
    if (fixture.installerFails) return void fixture.updaterEvents.error(new Error("installer missing"));
    fixture.installs++;
    try {
      fixture.scheduleAtInstall = JSON.parse(readFileSync(join(fixture.userData, "update-schedule.json"), "utf8"));
    } catch {
      fixture.scheduleAtInstall = null;
    }
  },
};

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const emit = (event, payload) => fixture.updaterEvents[event](payload);
const schedulePath = () => join(fixture.userData, "update-schedule.json");
const readSchedule = () => JSON.parse(readFileSync(schedulePath(), "utf8"));

let updater, ipc, sent;
/** The office window: answers main's unsaved-work question unless told to stay silent. */
const officeWindow = {
  isDestroyed: () => false,
  webContents: {
    getURL: () => fixture.windowUrl ?? "http://127.0.0.1:47123/",
    send(channel, payload) {
      sent.push([channel, payload]);
      if (channel === "update:query-unsaved" && fixture.unsaved !== "silent") {
        void Promise.resolve().then(() => ipc["update:unsaved-reply"]({}, payload, { unsaved: fixture.unsaved }));
      }
    },
  },
};

async function launch() {
  updater = await import("./updater.mjs");
  const handlers = {};
  updater.registerUpdaterIpc({ handle: (name, fn) => { handlers[name] = fn; } });
  ipc = handlers;
  updater.startUpdater(() => officeWindow, { startService: async () => { fixture.starts++; return true; } });
}
const state = () => ipc["update:get-state"]();
async function downloaded(info = { version: "0.1.49" }) {
  emit("update-downloaded", info);
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.resetModules();
  require.cache[vendored] = { id: vendored, filename: vendored, loaded: true, exports: { autoUpdater } };
  Object.assign(fixture, {
    results: [], prepares: 0, installs: 0, checks: 0, starts: 0, packaged: true, appVersion: "0.1.48",
    userData: mkdtempSync(join(tmpdir(), "realbud-updater-")), lastInput: NOW, locked: false, unsaved: false,
    activity: { running: true, busy: false, waitingApprovals: 0 }, updaterEvents: {}, powerEvents: {}, scheduleAtInstall: null,
    duringHandoff: null, handoffMs: 0, installerFails: false, windowUrl: undefined,
  });
  sent = [];
});
afterEach(() => {
  delete require.cache[vendored];
  rmSync(fixture.userData, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("restart to update when the office service could not be stopped", () => {
  beforeEach(async () => { await launch(); await downloaded(); });

  it("tries once more by itself and installs when the service then stops", async () => {
    fixture.results.push({ ready: false, reason: "cannot-stop" }, { ready: true });
    await ipc["update:install"]();
    expect(await state()).toMatchObject({ status: "downloaded", deferred: "cannot-stop", message: expect.stringMatching(/try the update again shortly/) });
    expect(fixture.installs).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fixture.prepares).toBe(2);
    expect(fixture.installs).toBe(1);
  });

  it("gives up after the second refusal and leaves the person to stop it", async () => {
    fixture.results.push({ ready: false, reason: "cannot-stop" }, { ready: false, reason: "cannot-stop" });
    await ipc["update:install"]();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fixture.prepares).toBe(2);
    await vi.advanceTimersByTimeAsync(10 * 30_000);
    expect(fixture.prepares).toBe(2);
    expect(fixture.installs).toBe(0);
    expect(await state()).toMatchObject({ deferred: "cannot-stop", message: expect.stringMatching(/Stop it in Settings & help/) });
  });
});

describe("a newer release while an update waits", () => {
  it("keeps checking, keeps the waiting update ready, and replaces it with the newest", async () => {
    await launch();
    await downloaded({ version: "0.1.49" });
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(fixture.checks).toBe(2); // the first check after launch, then the hourly one
    emit("checking-for-update");
    emit("update-available", { version: "0.1.49" });
    expect(await state()).toMatchObject({ status: "downloaded", version: "0.1.49" });

    emit("update-available", { version: "0.1.50" });
    emit("download-progress", { percent: 10 });
    expect(await state()).toMatchObject({ status: "downloading", version: "0.1.50", restart: undefined });
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(fixture.checks).toBe(2); // a download in progress finishes first
    await downloaded({ version: "0.1.50" });
    expect(await state()).toMatchObject({ status: "downloaded", version: "0.1.50" });
    // The 24-hour clock runs from the first download still waiting, not from the newest release.
    expect(readSchedule()).toEqual({ version: "0.1.50", downloadedAt: NOW });
  });

  it("does not undo a waiting update when a background check fails", async () => {
    await launch();
    await downloaded();
    emit("error", new Error("offline"));
    expect(await state()).toMatchObject({ status: "downloaded", version: "0.1.49" });
  });
});

describe("Restart now", () => {
  beforeEach(async () => { await launch(); await downloaded(); });

  it("asks the window first and never starts the installer over unsaved work", async () => {
    fixture.unsaved = true;
    await ipc["update:install"]();
    expect(sent.some(([channel]) => channel === "update:query-unsaved")).toBe(true);
    expect(await state()).toMatchObject({ status: "downloaded", deferred: "unsaved", message: "Save or discard your open draft first, then restart to update." });
    expect(fixture.prepares).toBe(0);
    expect(fixture.installs).toBe(0);
  });

  it("goes ahead when the window does not answer within 2 s, recording the attempt first", async () => {
    fixture.unsaved = "silent";
    const pending = ipc["update:install"]();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fixture.installs).toBe(0);
    // Asked at the click and again once the service stopped: each wait is 2 s.
    await vi.advanceTimersByTimeAsync(2_001);
    await pending;
    expect(fixture.installs).toBe(1);
    expect(fixture.scheduleAtInstall).toEqual({ version: "0.1.49", downloadedAt: NOW, attemptedAt: NOW + 4_000, fromVersion: "0.1.48" });
  });

  it("stops for a draft opened while the service stops, and starts the service again", async () => {
    fixture.unsaved = false;
    fixture.duringHandoff = () => { fixture.unsaved = true; };
    await ipc["update:install"]();
    fixture.duringHandoff = null;
    expect(fixture.installs).toBe(0);
    expect(fixture.starts).toBe(1);
    expect(await state()).toMatchObject({ status: "downloaded", deferred: "unsaved", message: "Save or discard your open draft first, then restart to update." });
  });

  it("waits for a download in progress and installs it when it lands", async () => {
    emit("update-available", { version: "0.1.50" });
    emit("download-progress", { percent: 40 });
    await ipc["update:install"]();
    expect(fixture.prepares).toBe(0);
    await downloaded({ version: "0.1.50" });
    expect(fixture.installs).toBe(1);
  });
});

describe("restarting by itself at a safe moment", () => {
  beforeEach(async () => { await launch(); });

  it("installs at once when the screen is locked and nothing is open or running", async () => {
    fixture.locked = true;
    await downloaded();
    expect(fixture.installs).toBe(1);
    // Once to decide, once more after the office service stopped.
    expect(sent.filter(([channel]) => channel === "update:query-unsaved")).toHaveLength(2);
  });

  it("waits for 5 minutes away, counts down 60 s, then installs", async () => {
    await downloaded();
    expect((await state()).restart).toEqual({ mode: "when-away", required: false });
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(fixture.prepares).toBe(0);
    await vi.advanceTimersByTimeAsync(MINUTE); // 5 minutes without input
    const countdown = (await state()).restart;
    expect(countdown).toEqual({ mode: "countdown", at: Date.now() + MINUTE, required: false });
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(fixture.installs).toBe(1);
  });

  it("cancels the countdown on any input, and on Not now", async () => {
    fixture.lastInput = NOW - 10 * MINUTE;
    await downloaded();
    expect((await state()).restart.mode).toBe("countdown");
    fixture.lastInput = Date.now() + 500; // someone touches the mouse
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await state()).restart).toEqual({ mode: "when-away", required: false });
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(fixture.installs).toBe(0);

    await vi.advanceTimersByTimeAsync(4 * MINUTE); // 5 minutes away again, at the next minute: a new countdown
    expect((await state()).restart.mode).toBe("countdown");
    fixture.lastInput = Date.now(); // the click on "Not now"
    await ipc["update:cancel-countdown"]();
    expect((await state()).restart.mode).toBe("when-away");
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect((await state()).restart.mode).toBe("when-away");
    expect(fixture.installs).toBe(0);
  });

  it("names what it waits for: an approval, a busy office, unsaved work, a silent window", async () => {
    fixture.lastInput = NOW - 10 * MINUTE;
    fixture.activity = { running: true, busy: true, waitingApprovals: 1 };
    await downloaded();
    expect((await state()).restart).toEqual({ mode: "waiting", blockedBy: ["busy", "approval"], required: false });
    fixture.activity = { running: true, busy: false, waitingApprovals: 0 };
    fixture.unsaved = "silent";
    await vi.advanceTimersByTimeAsync(MINUTE + 2_000);
    expect((await state()).restart).toEqual({ mode: "waiting", blockedBy: ["unsaved"], required: false });
    expect(fixture.prepares).toBe(0);
  });

  it("re-checks on wake and on lock", async () => {
    await downloaded();
    fixture.locked = true;
    fixture.powerEvents["lock-screen"]();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.installs).toBe(1);
    const checks = fixture.checks;
    fixture.powerEvents.resume();
    expect(fixture.checks).toBe(checks + 1);
  });
});

describe("Later and required updates", () => {
  it("holds the automatic restart for 4 hours and keeps the hold on disk", async () => {
    await launch();
    await downloaded();
    expect(await ipc["update:later"]()).toBe(true);
    expect((await state()).restart).toEqual({ mode: "when-away", laterUntil: NOW + 4 * 60 * MINUTE, required: false });
    expect(readSchedule()).toMatchObject({ version: "0.1.49", laterUntil: NOW + 4 * 60 * MINUTE });
    fixture.locked = true;
    await vi.advanceTimersByTimeAsync(4 * 60 * MINUTE - MINUTE);
    expect(fixture.installs).toBe(0);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(fixture.installs).toBe(1);
  });

  it("refuses Later below the feed's minimum version", async () => {
    await launch();
    await downloaded({ version: "0.1.49", minimumVersion: "0.1.49" });
    expect(await ipc["update:later"]()).toBe(false);
    expect((await state()).restart).toEqual({ mode: "when-away", required: true, requiredReason: "unsupported" });
  });

  it("requires an update that has waited 24 hours since its first download, across a relaunch", async () => {
    writeFileSync(schedulePath(), JSON.stringify({ version: "0.1.49", downloadedAt: NOW - 24 * 60 * MINUTE, laterUntil: NOW + MINUTE }));
    await launch();
    fixture.locked = true;
    fixture.activity = { running: true, busy: true, waitingApprovals: 0 };
    await downloaded();
    expect(await ipc["update:later"]()).toBe(false);
    expect((await state()).restart).toEqual({ mode: "waiting", blockedBy: ["busy"], required: true, requiredReason: "waited" });
  });
});

describe("what the next launch shows", () => {
  it("says the update landed, once", async () => {
    fixture.appVersion = "0.1.49";
    writeFileSync(schedulePath(), JSON.stringify({ version: "0.1.49", downloadedAt: NOW - MINUTE, attemptedAt: NOW - 1, fromVersion: "0.1.48" }));
    await launch();
    expect(await state()).toMatchObject({ updatedFrom: { from: "0.1.48", to: "0.1.49" } });
    expect(readSchedule()).toEqual({});
    await ipc["update:dismiss-note"]();
    expect((await state()).updatedFrom).toBeUndefined();
  });

  it("says the install did not land, and leaves the retry to the person", async () => {
    writeFileSync(schedulePath(), JSON.stringify({ version: "0.1.49", downloadedAt: NOW - MINUTE, attemptedAt: NOW - 1, fromVersion: "0.1.48" }));
    await launch();
    expect(await state()).toMatchObject({ installFailed: { version: "0.1.49" } });
    expect(readSchedule()).toEqual({ version: "0.1.49", downloadedAt: NOW - MINUTE, installFailed: { version: "0.1.49" } });
    fixture.locked = true;
    await downloaded();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(fixture.installs).toBe(0);
    await ipc["update:install"]();
    expect(fixture.installs).toBe(1);
  });

  describe("Try again before the update is back on disk", () => {
    beforeEach(async () => {
      writeFileSync(schedulePath(), JSON.stringify({ version: "0.1.49", downloadedAt: NOW - MINUTE, attemptedAt: NOW - 1, fromVersion: "0.1.48" }));
      await launch();
      await ipc["update:install"]();
    });

    it("checks at once and installs when the download lands, asking the window first", async () => {
      expect(fixture.checks).toBe(1);
      expect(fixture.prepares).toBe(0);
      await downloaded();
      // Asked when it landed and again once the service stopped.
      expect(sent.filter(([channel]) => channel === "update:query-unsaved")).toHaveLength(2);
      expect(fixture.installs).toBe(1);
    });

    it("still holds the installer for unsaved work", async () => {
      fixture.unsaved = true;
      await downloaded();
      expect(await state()).toMatchObject({ status: "downloaded", deferred: "unsaved" });
      expect(fixture.installs).toBe(0);
    });

    it("drops the request when the check fails, and shows the error", async () => {
      emit("error", new Error("offline"));
      expect(await state()).toMatchObject({ status: "error", message: "offline" });
      await downloaded();
      expect(fixture.prepares).toBe(0);
      expect(fixture.installs).toBe(0);
    });

    it("drops the request when the person dismisses the note", async () => {
      await ipc["update:dismiss-note"]();
      await downloaded();
      expect(fixture.prepares).toBe(0);
      expect(fixture.installs).toBe(0);
    });
  });

  it("tolerates a corrupt schedule file", async () => {
    writeFileSync(schedulePath(), "{oops");
    await launch();
    expect(await state()).toEqual({ status: "idle" });
    await downloaded();
    expect(readSchedule()).toEqual({ version: "0.1.49", downloadedAt: NOW });
  });
});

it("stays dormant and starts no timers in an unpackaged build", async () => {
  fixture.packaged = false;
  await launch();
  expect(vi.getTimerCount()).toBe(0);
  expect(fixture.updaterEvents).toEqual({});
  expect(existsSync(schedulePath())).toBe(false);
});

/** A directory where the schedule file goes: every save of it fails, even as root. */
function breakScheduleFile() {
  rmSync(schedulePath(), { force: true });
  mkdirSync(join(schedulePath(), "blocked"), { recursive: true });
}
function repairScheduleFile() {
  rmSync(schedulePath(), { recursive: true, force: true });
}

describe("the last look before the installer starts", () => {
  // Away 10 minutes, so the countdown starts at once; the office service takes 5 s to stop.
  beforeEach(async () => {
    await launch();
    fixture.lastInput = NOW - 10 * MINUTE;
    fixture.handoffMs = 5_000;
    await downloaded();
    expect((await state()).restart.mode).toBe("countdown");
  });
  async function countdownRunsOutAndServiceStops() {
    await vi.advanceTimersByTimeAsync(MINUTE);
    await vi.advanceTimersByTimeAsync(5_000);
  }

  it("stops for keyboard or mouse use while the service stopped, and starts the office service again", async () => {
    fixture.duringHandoff = () => { fixture.lastInput = Date.now() + 1_000; };
    await countdownRunsOutAndServiceStops();
    expect(fixture.prepares).toBe(1);
    expect(fixture.installs).toBe(0);
    expect(fixture.starts).toBe(1);
    expect((await state()).restart).toEqual({ mode: "when-away", required: false });
    expect(readSchedule().attemptedAt).toBeUndefined();
  });

  it("stops for a draft opened meanwhile", async () => {
    fixture.duringHandoff = () => { fixture.unsaved = true; };
    await countdownRunsOutAndServiceStops();
    expect(fixture.installs).toBe(0);
    expect(fixture.starts).toBe(1);
    expect((await state()).restart).toEqual({ mode: "waiting", blockedBy: ["unsaved"], required: false });
  });

  it("honours Later clicked while the service stopped", async () => {
    fixture.duringHandoff = () => { void ipc["update:later"](); };
    await countdownRunsOutAndServiceStops();
    expect(fixture.installs).toBe(0);
    expect(fixture.starts).toBe(1);
    // Clicked as the countdown ran out, a minute after the download.
    expect((await state()).restart).toEqual({ mode: "when-away", laterUntil: NOW + MINUTE + 4 * 60 * MINUTE, required: false });
  });

  it("honours Not now clicked while the service stopped", async () => {
    fixture.duringHandoff = () => { void ipc["update:cancel-countdown"](); };
    await countdownRunsOutAndServiceStops();
    expect(fixture.installs).toBe(0);
    expect(fixture.starts).toBe(1);
    expect((await state()).restart).toEqual({ mode: "when-away", required: false });
  });

  it("goes ahead when the person clicks Restart now meanwhile: the click is no reason to stop", async () => {
    fixture.duringHandoff = () => { fixture.lastInput = Date.now(); void ipc["update:install"](); };
    await countdownRunsOutAndServiceStops();
    expect(fixture.installs).toBe(1);
    expect(fixture.starts).toBe(0);
  });

  it("starts nothing when the handoff found no service running", async () => {
    fixture.results.push({ ready: true, stopped: false });
    fixture.duringHandoff = () => { fixture.lastInput = Date.now() + 1_000; };
    await countdownRunsOutAndServiceStops();
    expect(fixture.installs).toBe(0);
    expect(fixture.starts).toBe(0);
  });

  it("stops for a newer release announced meanwhile, starts the service again, and installs the newer one at the next safe moment", async () => {
    fixture.duringHandoff = () => {
      emit("update-available", { version: "0.1.50" });
      emit("download-progress", { percent: 5 });
    };
    await countdownRunsOutAndServiceStops();
    expect(fixture.installs).toBe(0);
    expect(fixture.starts).toBe(1);
    fixture.duringHandoff = null;
    await downloaded({ version: "0.1.50" });
    expect((await state()).restart.mode).toBe("countdown");
    await countdownRunsOutAndServiceStops();
    expect(fixture.prepares).toBe(2);
    expect(fixture.installs).toBe(1);
    expect(fixture.scheduleAtInstall).toMatchObject({ version: "0.1.50", fromVersion: "0.1.48" });
  });
});

describe("Restart now when a newer release is announced while the service stops", () => {
  it("starts the service again and installs the newer one when it lands, asking the window first", async () => {
    await launch();
    await downloaded();
    fixture.duringHandoff = () => {
      emit("update-available", { version: "0.1.50" });
      emit("download-progress", { percent: 5 });
    };
    await ipc["update:install"]();
    expect(fixture.installs).toBe(0);
    expect(fixture.starts).toBe(1);
    fixture.duringHandoff = null;
    const asked = sent.filter(([channel]) => channel === "update:query-unsaved").length;
    await downloaded({ version: "0.1.50" });
    expect(sent.filter(([channel]) => channel === "update:query-unsaved")).toHaveLength(asked + 2);
    expect(fixture.installs).toBe(1);
    expect(fixture.scheduleAtInstall).toMatchObject({ version: "0.1.50" });
  });
});

describe("a window that is not the office app", () => {
  it("holds no drafts on RealBud's own error or waiting page, so the automatic restart still goes", async () => {
    fixture.windowUrl = "data:text/html,The office service did not start";
    fixture.unsaved = "silent";
    await launch();
    fixture.locked = true;
    await downloaded();
    expect(sent.some(([channel]) => channel === "update:query-unsaved")).toBe(false);
    expect(fixture.installs).toBe(1);
  });
});

describe("a Restart now that found nothing", () => {
  it("does not install a download that lands later without a safe moment", async () => {
    await launch();
    await ipc["update:install"]();
    expect(fixture.checks).toBe(1);
    emit("update-not-available", {});
    await downloaded();
    expect(fixture.prepares).toBe(0);
    expect(fixture.installs).toBe(0);
  });
});

describe("an install that does not start or does not land", () => {
  it("keeps the office running when the installer cannot start, and the loop does not stop it for that version again", async () => {
    await launch();
    fixture.locked = true;
    fixture.installerFails = true;
    await downloaded();
    expect(fixture.prepares).toBe(1);
    expect(fixture.installs).toBe(0);
    expect(fixture.starts).toBe(1);
    expect(await state()).toMatchObject({ status: "error", message: "installer missing" });
    expect(readSchedule()).toEqual({ version: "0.1.49", downloadedAt: NOW, installFailed: { version: "0.1.49" } });

    // The hourly check finds the same update on disk again: still left to the person.
    fixture.installerFails = false;
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    emit("update-available", { version: "0.1.49" });
    await downloaded();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(fixture.prepares).toBe(1);
    await ipc["update:install"]();
    expect(fixture.installs).toBe(1);
  });

  it("does not retry a version that reopened the old one, even after the note is dismissed; a newer download clears it", async () => {
    writeFileSync(schedulePath(), JSON.stringify({ version: "0.1.49", downloadedAt: NOW - MINUTE, attemptedAt: NOW - 1, fromVersion: "0.1.48" }));
    await launch();
    await ipc["update:dismiss-note"]();
    fixture.locked = true;
    await downloaded();
    // Nothing promises a restart by itself for that version.
    expect((await state()).restart).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(fixture.prepares).toBe(0);
    await downloaded({ version: "0.1.50" });
    expect(fixture.installs).toBe(1);
    expect(fixture.scheduleAtInstall).toEqual({ version: "0.1.50", downloadedAt: NOW - MINUTE, attemptedAt: NOW + 5 * MINUTE, fromVersion: "0.1.48" });
  });
});

describe("the marker that catches a failed install", () => {
  it("keeps an automatic install from stopping the office service while the schedule cannot be saved; Restart now still goes ahead", async () => {
    await launch();
    await downloaded();
    breakScheduleFile();
    fixture.locked = true;
    fixture.powerEvents["lock-screen"]();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.prepares).toBe(0);
    expect(await state()).toMatchObject({ status: "downloaded", deferred: "cannot-record", message: expect.stringMatching(/Restart now/) });
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    expect(fixture.prepares).toBe(0);
    await ipc["update:install"]();
    expect(fixture.installs).toBe(1);
  });

  it("starts the service again when the marker cannot be saved after it stopped, and goes ahead once saving works", async () => {
    await launch();
    fixture.locked = true;
    fixture.duringHandoff = breakScheduleFile;
    await downloaded();
    expect(fixture.prepares).toBe(1);
    expect(fixture.installs).toBe(0);
    expect(fixture.starts).toBe(1);
    expect(await state()).toMatchObject({ status: "downloaded", deferred: "cannot-record" });
    fixture.duringHandoff = null;
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(fixture.prepares).toBe(1); // the next minutes do not stop the service again
    repairScheduleFile();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(fixture.installs).toBe(1);
    expect(fixture.scheduleAtInstall).toMatchObject({ version: "0.1.49", fromVersion: "0.1.48" });
  });
});

describe("a line about why an update waits", () => {
  it("goes when the office is no longer busy, even with the person back at the keyboard", async () => {
    await launch();
    fixture.locked = true;
    fixture.results.push({ ready: false, reason: "busy" });
    await downloaded();
    expect(await state()).toMatchObject({ deferred: "busy", message: expect.stringMatching(/Bud is still working/) });
    fixture.locked = false;
    fixture.lastInput = Date.now() + MINUTE - 1_000;
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(await state()).toMatchObject({ deferred: undefined, message: undefined, restart: { mode: "when-away", required: false } });
  });

  it("goes when the draft that held Restart now is saved", async () => {
    await launch();
    await downloaded();
    fixture.unsaved = true;
    await ipc["update:install"]();
    expect((await state()).deferred).toBe("unsaved");
    fixture.unsaved = false;
    fixture.lastInput = Date.now() + MINUTE - 1_000;
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(await state()).toMatchObject({ deferred: undefined, message: undefined });
    expect(fixture.prepares).toBe(0);
  });
});

describe("Restart now while Bud is working", () => {
  it("tries every 30 s for 10 minutes from the click, then waits for a safe moment like any update", async () => {
    await launch();
    await downloaded();
    fixture.activity = { running: true, busy: true, waitingApprovals: 0 };
    fixture.results = Array.from({ length: 30 }, () => ({ ready: false, reason: "busy" }));
    await ipc["update:install"]();
    expect(await state()).toMatchObject({ deferred: "busy" });
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(fixture.prepares).toBe(21); // the click, then every 30 s until 10 minutes from it
    expect((await state()).deferred).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(fixture.prepares).toBe(21);

    // Work done, the person at the keyboard: nothing until they have been away 5 minutes.
    fixture.results = [];
    fixture.activity = { running: true, busy: false, waitingApprovals: 0 };
    fixture.lastInput = Date.now();
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(fixture.prepares).toBe(21);
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    expect(fixture.installs).toBe(1);
  });
});

describe("times kept on disk", () => {
  it("pulls back a hold or a download time a clock change pushed out of reach, and saves them", async () => {
    writeFileSync(schedulePath(), JSON.stringify({ version: "0.1.49", downloadedAt: NOW + 48 * 60 * MINUTE, laterUntil: NOW + 30 * 24 * 60 * MINUTE }));
    await launch();
    expect(readSchedule()).toEqual({ version: "0.1.49", downloadedAt: NOW, laterUntil: NOW + 4 * 60 * MINUTE });
  });
});
