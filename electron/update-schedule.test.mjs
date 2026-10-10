import fs, { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AWAY_SECONDS, LATER_MS, MANUAL_RETRY_MS, REQUIRED_AFTER_MS,
  clampSchedule, compareVersions, countdownInterrupted, decideRestart, deferredEnded, handoffAbort, launchOutcome, loadSchedule,
  manualRetryAllowed, parseSchedule, requiredState, restartState, saveSchedule, scheduleForDownload,
} from "./update-schedule.mjs";

const NOW = 1_800_000_000_000;
/** Away, nothing open, office idle: every condition for a restart holds. */
const safe = { now: NOW, idleSeconds: AWAY_SECONDS, locked: false, unsaved: false, busy: false, approvals: 0, required: false };

describe("deciding when a downloaded update may restart RealBud", () => {
  it("counts down when nobody has touched the computer for 5 minutes and nothing is open or running", () => {
    expect(decideRestart(safe)).toEqual({ action: "countdown" });
  });

  it("installs at once when the screen is locked, however recently it was used", () => {
    expect(decideRestart({ ...safe, idleSeconds: 3, locked: true })).toEqual({ action: "install" });
  });

  it("waits for the person to be away", () => {
    expect(decideRestart({ ...safe, idleSeconds: AWAY_SECONDS - 1 })).toEqual({ action: "wait-away" });
  });

  it("names everything that holds a restart while the person is away", () => {
    expect(decideRestart({ ...safe, unsaved: true })).toEqual({ action: "wait", blockedBy: ["unsaved"] });
    expect(decideRestart({ ...safe, busy: true })).toEqual({ action: "wait", blockedBy: ["busy"] });
    expect(decideRestart({ ...safe, approvals: 2 })).toEqual({ action: "wait", blockedBy: ["approval"] });
    expect(decideRestart({ ...safe, locked: true, unsaved: true, busy: true, approvals: 1 })).toEqual({ action: "wait", blockedBy: ["unsaved", "busy", "approval"] });
  });

  it("stops waiting on approvals once the update is required, never on unsaved or running work", () => {
    expect(decideRestart({ ...safe, approvals: 2, required: true })).toEqual({ action: "countdown" });
    expect(decideRestart({ ...safe, approvals: 2, unsaved: true, busy: true, required: true })).toEqual({ action: "wait", blockedBy: ["unsaved", "busy"] });
  });

  it("treats a fact nobody could establish as a reason to wait", () => {
    const { unsaved: _u, busy: _b, approvals: _a, ...cheap } = safe;
    expect(decideRestart(cheap)).toEqual({ action: "wait", blockedBy: ["unsaved", "busy", "approval"] });
    expect(decideRestart({ ...safe, unsaved: null })).toEqual({ action: "wait", blockedBy: ["unsaved"] });
    expect(decideRestart({ ...safe, idleSeconds: Number.NaN })).toEqual({ action: "wait-away" });
  });

  it("holds while 'Later' runs, and only then", () => {
    expect(decideRestart({ ...safe, locked: true, laterUntil: NOW + 1 })).toEqual({ action: "hold" });
    expect(decideRestart({ ...safe, laterUntil: NOW })).toEqual({ action: "countdown" });
  });

  it("ignores 'Later' once the update is required, but still waits for a safe moment", () => {
    expect(decideRestart({ ...safe, laterUntil: NOW + LATER_MS, required: true })).toEqual({ action: "countdown" });
    expect(decideRestart({ ...safe, laterUntil: NOW + LATER_MS, required: true, idleSeconds: 10 })).toEqual({ action: "wait-away" });
    expect(decideRestart({ ...safe, required: true, unsaved: true })).toEqual({ action: "wait", blockedBy: ["unsaved"] });
  });

  it("cancels a countdown on any keyboard or mouse use since it started", () => {
    expect(countdownInterrupted({ idleSeconds: AWAY_SECONDS + 30, elapsedMs: 30_000 })).toBe(false);
    expect(countdownInterrupted({ idleSeconds: 4, elapsedMs: 30_000 })).toBe(true);
    expect(countdownInterrupted({ idleSeconds: Number.NaN, elapsedMs: 1_000 })).toBe(true);
  });
});

describe("when an update can no longer wait", () => {
  it("is required below the feed's minimum version, ahead of how long it waited", () => {
    expect(requiredState({ now: NOW, downloadedAt: NOW - REQUIRED_AFTER_MS, appVersion: "0.1.48", minimumVersion: "0.1.49" })).toEqual({ required: true, requiredReason: "unsupported" });
    expect(requiredState({ now: NOW, appVersion: "0.1.49", minimumVersion: "0.1.49" })).toEqual({ required: false });
  });

  it("is required after waiting 24 hours since it downloaded", () => {
    expect(requiredState({ now: NOW, downloadedAt: NOW - REQUIRED_AFTER_MS, appVersion: "0.1.48" })).toEqual({ required: true, requiredReason: "waited" });
    expect(requiredState({ now: NOW, downloadedAt: NOW - REQUIRED_AFTER_MS + 1, appVersion: "0.1.48" })).toEqual({ required: false });
  });

  it("ignores a minimum version that is not a version", () => {
    expect(requiredState({ now: NOW, appVersion: "0.1.48", minimumVersion: "soon" })).toEqual({ required: false });
    expect(requiredState({ now: NOW, appVersion: "0.1.48", minimumVersion: 49 })).toEqual({ required: false });
  });

  it("compares versions by number, a prerelease before its release", () => {
    expect(compareVersions("0.1.9", "0.1.10")).toBe(-1);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
    expect(compareVersions("v0.1.50", "0.1.50")).toBe(0);
    expect(compareVersions("0.1.50-beta.2", "0.1.50")).toBe(-1);
    expect(compareVersions("0.1.50-beta.10", "0.1.50-beta.2")).toBe(1);
    expect(compareVersions("0.1", "0.1.0")).toBe(null);
  });
});

describe("the restart state the window renders", () => {
  it("shows a countdown with its end and the hold only while it applies", () => {
    expect(restartState({ action: "countdown" }, { now: NOW, required: false, at: NOW + 60_000 })).toEqual({ mode: "countdown", at: NOW + 60_000, required: false });
    expect(restartState({ action: "hold" }, { now: NOW, laterUntil: NOW + LATER_MS, required: false })).toEqual({ mode: "when-away", laterUntil: NOW + LATER_MS, required: false });
    expect(restartState({ action: "wait-away" }, { now: NOW, laterUntil: NOW - 1, required: false })).toEqual({ mode: "when-away", required: false });
  });

  it("names what it waits for, and why 'Later' has gone", () => {
    expect(restartState({ action: "wait", blockedBy: ["busy"] }, { now: NOW, laterUntil: NOW + 1, required: true, requiredReason: "waited", at: NOW })).toEqual({ mode: "waiting", blockedBy: ["busy"], required: true, requiredReason: "waited" });
  });
});

describe("what the next launch learns", () => {
  it("says an install landed once, then forgets it", () => {
    expect(launchOutcome({ version: "0.1.51", downloadedAt: 1, attemptedAt: 2, fromVersion: "0.1.50" }, "0.1.51")).toEqual({ schedule: {}, updatedFrom: { from: "0.1.50", to: "0.1.51" } });
  });

  it("says an install did not land, keeps the update waiting, and remembers the failure on disk", () => {
    expect(launchOutcome({ version: "0.1.51", downloadedAt: 1, laterUntil: 3, attemptedAt: 2, fromVersion: "0.1.50" }, "0.1.50"))
      .toEqual({ schedule: { version: "0.1.51", downloadedAt: 1, laterUntil: 3, installFailed: { version: "0.1.51" } }, installFailed: { version: "0.1.51" } });
  });

  it("says nothing again on later launches, while still remembering the failure", () => {
    const remembered = { version: "0.1.51", downloadedAt: 1, installFailed: { version: "0.1.51" } };
    expect(launchOutcome(remembered, "0.1.50")).toEqual({ schedule: remembered });
    expect(launchOutcome(remembered, "0.1.51")).toEqual({ schedule: {} });
  });

  it("keeps an update still waiting, and drops one this version already has", () => {
    expect(launchOutcome({ version: "0.1.51", downloadedAt: 1 }, "0.1.50")).toEqual({ schedule: { version: "0.1.51", downloadedAt: 1 } });
    expect(launchOutcome({ version: "0.1.51", downloadedAt: 1 }, "0.1.52")).toEqual({ schedule: {} });
    expect(launchOutcome({}, "0.1.50")).toEqual({ schedule: {} });
  });
});

describe("the schedule file", () => {
  const dirs = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const folder = () => { const dir = mkdtempSync(join(tmpdir(), "realbud-update-schedule-")); dirs.push(dir); return dir; };

  it("reads a missing, corrupt or foreign file as empty", () => {
    const dir = folder();
    expect(loadSchedule(join(dir, "update-schedule.json"))).toEqual({});
    writeFileSync(join(dir, "bad.json"), "{not json");
    expect(loadSchedule(join(dir, "bad.json"))).toEqual({});
    expect(parseSchedule("[1]")).toEqual({});
    expect(parseSchedule(JSON.stringify({ version: "../../x", downloadedAt: "yesterday", laterUntil: -5, fromVersion: 7, extra: true }))).toEqual({});
    expect(parseSchedule(JSON.stringify({ installFailed: { version: "../x" } }))).toEqual({});
    expect(parseSchedule(JSON.stringify({ installFailed: "0.1.51" }))).toEqual({});
    expect(parseSchedule(JSON.stringify({ installFailed: { version: "0.1.51", extra: 1 } }))).toEqual({ installFailed: { version: "0.1.51" } });
  });

  it("round-trips through a temporary file and leaves nothing behind", () => {
    const dir = folder(), file = join(dir, "nested", "update-schedule.json");
    saveSchedule(file, { version: "0.1.51", downloadedAt: 5, laterUntil: 9 });
    expect(loadSchedule(file)).toEqual({ version: "0.1.51", downloadedAt: 5, laterUntil: 9 });
    expect(readdirSync(join(dir, "nested"))).toEqual(["update-schedule.json"]);
  });

  it("keeps the previous file whole when the replacement fails", () => {
    const dir = folder(), file = join(dir, "update-schedule.json");
    saveSchedule(file, { version: "0.1.51", downloadedAt: 5 });
    const failing = { ...fs, renameSync() { throw new Error("simulated rename failure"); } };
    expect(() => saveSchedule(file, { version: "0.1.52", downloadedAt: 6 }, failing, () => "t")).toThrow("simulated rename failure");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: "0.1.51", downloadedAt: 5 });
    expect(readdirSync(dir)).toEqual(["update-schedule.json"]);
  });
});

describe("times from the file", () => {
  it("holds 'Later' at most 4 hours from now and never counts a download from the future", () => {
    expect(clampSchedule({ version: "0.1.51", downloadedAt: NOW + 1, laterUntil: NOW + 30 * LATER_MS }, NOW))
      .toEqual({ version: "0.1.51", downloadedAt: NOW, laterUntil: NOW + LATER_MS });
    const sane = { version: "0.1.51", downloadedAt: NOW - 1, laterUntil: NOW + LATER_MS };
    expect(clampSchedule(sane, NOW)).toEqual(sane);
    expect(clampSchedule({}, NOW)).toEqual({});
  });
});

describe("a newer version downloading while one waits", () => {
  it("keeps the earliest download time and the hold, and forgets the older version's failed install", () => {
    const waiting = { version: "0.1.51", downloadedAt: NOW - 1_000, laterUntil: NOW + 5, installFailed: { version: "0.1.51" } };
    expect(scheduleForDownload(waiting, "0.1.52", NOW)).toEqual({ version: "0.1.52", downloadedAt: NOW - 1_000, laterUntil: NOW + 5 });
  });

  it("starts the clock for a first download, and changes nothing for the same version", () => {
    expect(scheduleForDownload({}, "0.1.51", NOW)).toEqual({ version: "0.1.51", downloadedAt: NOW });
    const waiting = { version: "0.1.51", downloadedAt: NOW - 1, installFailed: { version: "0.1.51" } };
    expect(scheduleForDownload(waiting, "0.1.51", NOW)).toBe(waiting);
    expect(scheduleForDownload(waiting, undefined, NOW)).toBe(waiting);
  });
});

describe("the last look before stopping the office service and before the installer starts", () => {
  const SINCE = NOW - 5_000;
  /** Chosen by the safe-moment loop 5 s ago, nothing has changed since. */
  const calm = { automatic: true, since: SINCE, now: NOW, downloaded: true, clicks: {}, unsaved: false, idleSeconds: AWAY_SECONDS + 5, locked: false };

  it("goes ahead when nothing changed", () => {
    expect(handoffAbort(calm)).toBe(null);
  });

  it("stops when a newer release is replacing the installer, whoever chose the install", () => {
    expect(handoffAbort({ ...calm, downloaded: false })).toBe("newer");
    expect(handoffAbort({ ...calm, automatic: false, downloaded: false })).toBe("newer");
  });

  it("honours Later and Not now clicked since the install was chosen, the latest click winning", () => {
    expect(handoffAbort({ ...calm, clicks: { later: SINCE + 1 } })).toBe("later");
    expect(handoffAbort({ ...calm, clicks: { notNow: SINCE } })).toBe("not-now");
    expect(handoffAbort({ ...calm, clicks: { later: SINCE + 1, notNow: SINCE + 2 } })).toBe("not-now");
    expect(handoffAbort({ ...calm, automatic: false, clicks: { restartNow: SINCE, later: SINCE + 1 } })).toBe("later");
    expect(handoffAbort({ ...calm, clicks: { later: SINCE + 1, restartNow: SINCE + 2 }, idleSeconds: 0 })).toBe(null);
    expect(handoffAbort({ ...calm, clicks: { later: SINCE - 1, notNow: SINCE - 1 } })).toBe(null);
  });

  it("stops an automatic install for an unsaved draft, or a window that did not answer", () => {
    expect(handoffAbort({ ...calm, unsaved: true })).toBe("unsaved");
    expect(handoffAbort({ ...calm, unsaved: null })).toBe("unsaved");
  });

  it("stops an automatic install for keyboard or mouse use since it was chosen, unless the screen is still locked", () => {
    expect(handoffAbort({ ...calm, idleSeconds: 3 })).toBe("returned");
    expect(handoffAbort({ ...calm, idleSeconds: 3, locked: true })).toBe(null);
  });

  it("lets the person's own restart through: they were asked at the click, and the click is input", () => {
    expect(handoffAbort({ ...calm, automatic: false, unsaved: null, idleSeconds: 0 })).toBe(null);
    expect(handoffAbort({ ...calm, clicks: { restartNow: SINCE + 1 }, unsaved: null, idleSeconds: 0 })).toBe(null);
  });
});

describe("when a put-off install's line goes", () => {
  it("ends each reason once what it described has ended", () => {
    expect(deferredEnded("unsaved", { unsaved: false })).toBe(true);
    expect(deferredEnded("unsaved", { unsaved: null })).toBe(false);
    expect(deferredEnded("busy", { activity: { running: true, busy: false } })).toBe(true);
    expect(deferredEnded("busy", { activity: { running: false } })).toBe(true);
    expect(deferredEnded("busy", { activity: { running: true, busy: true } })).toBe(false);
    expect(deferredEnded("cannot-stop", { activity: { running: false } })).toBe(true);
    expect(deferredEnded("cannot-stop", { activity: { running: true, busy: false } })).toBe(false);
    expect(deferredEnded("still-running", { activity: { running: true, busy: false } })).toBe(true);
    expect(deferredEnded("still-running", { activity: { running: false } })).toBe(false);
  });

  it("keeps a reason nobody looked at", () => {
    expect(deferredEnded("busy", {})).toBe(false);
    expect(deferredEnded("unsaved", { activity: { running: false } })).toBe(false);
    expect(deferredEnded("cannot-record", { unsaved: false, activity: { running: false } })).toBe(false);
  });
});

describe("Restart now while the office is busy", () => {
  it("keeps trying by itself for 10 minutes from the click", () => {
    expect(manualRetryAllowed({ now: NOW + MANUAL_RETRY_MS - 1, requestedAt: NOW })).toBe(true);
    expect(manualRetryAllowed({ now: NOW + MANUAL_RETRY_MS, requestedAt: NOW })).toBe(false);
    expect(manualRetryAllowed({ now: NOW, requestedAt: -Infinity })).toBe(false);
  });
});
