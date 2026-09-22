import { describe, expect, it } from "vitest";

import {
  KEEP_AWAKE_BLOCKER,
  SERVICE_MODE_FLAG,
  keepAwakeDecision,
  parseServiceModeArgs,
  planStartupRegistration,
  startupRegistrationSupport,
} from "./service-persistence.mjs";

// Nothing here touches Electron, the login item store or the power manager: the
// whole point of the module is that these decisions can be proved without
// registering anything on the machine running the tests.

describe("planStartupRegistration", () => {
  const packagedMac = { platform: "darwin", packaged: true };

  it("registers a hidden service-mode launch when the customer turns it on", () => {
    expect(planStartupRegistration({ desired: true, current: false, ...packagedMac })).toEqual({
      openAtLogin: true,
      openAsHidden: true,
      args: [SERVICE_MODE_FLAG],
    });
  });

  it("keeps the flag on the removal call so it clears the entry it wrote", () => {
    expect(planStartupRegistration({ desired: false, current: true, ...packagedMac })).toEqual({
      openAtLogin: false,
      openAsHidden: false,
      args: [SERVICE_MODE_FLAG],
    });
  });

  it("calls nothing when the registration already matches", () => {
    expect(planStartupRegistration({ desired: true, current: true, ...packagedMac })).toBeNull();
    expect(planStartupRegistration({ desired: false, current: false, ...packagedMac })).toBeNull();
  });

  it("plans the call when the current registration could not be read", () => {
    // Unknown is not agreement: a toggle that silently did nothing is worse
    // than one redundant write.
    expect(planStartupRegistration({ desired: true, current: undefined, ...packagedMac })?.openAtLogin).toBe(true);
    expect(planStartupRegistration({ desired: false, current: null, ...packagedMac })?.openAtLogin).toBe(false);
  });

  it("never registers from a development build", () => {
    // The login item would point at node_modules/electron, not the customer's app.
    expect(planStartupRegistration({ desired: true, current: false, platform: "darwin", packaged: false })).toBeNull();
    expect(planStartupRegistration({ desired: true, current: false, platform: "win32", packaged: false })).toBeNull();
  });

  it("never registers on a platform with no login item mechanism", () => {
    expect(planStartupRegistration({ desired: true, current: false, platform: "linux", packaged: true })).toBeNull();
  });

  it("treats a non-boolean request as off rather than as consent", () => {
    expect(planStartupRegistration({ desired: "yes", current: true, ...packagedMac })).toEqual({
      openAtLogin: false,
      openAsHidden: false,
      args: [SERVICE_MODE_FLAG],
    });
  });
});

describe("startupRegistrationSupport", () => {
  it("explains a development build without promising it", () => {
    const support = startupRegistrationSupport({ platform: "darwin", packaged: false });
    expect(support.supported).toBe(false);
    expect(support.reason).toBe("development");
    expect(support.explanation).toContain("development build");
  });

  it("explains an unsupported platform", () => {
    expect(startupRegistrationSupport({ platform: "linux", packaged: true })).toMatchObject({ supported: false, reason: "platform" });
  });

  it("says start happens after signing in, never after a restart alone", () => {
    for (const platform of ["win32", "darwin"]) {
      const support = startupRegistrationSupport({ platform, packaged: true });
      expect(support.supported).toBe(true);
      expect(support.explanation).toContain("sign in");
      expect(support.explanation).not.toMatch(/reboot|restart/i);
    }
  });

  it("only promises a background start where launch arguments actually arrive", () => {
    // Electron passes login-item args on Windows only, so only there does the
    // sign-in launch reach the headless host. A Mac opens the app.
    expect(startupRegistrationSupport({ platform: "win32", packaged: true }).explanation).toContain("in the background");
    const mac = startupRegistrationSupport({ platform: "darwin", packaged: true });
    expect(mac.explanation).not.toContain("in the background");
    expect(mac.explanation).toContain("RealBud opens");
  });
});

describe("parseServiceModeArgs", () => {
  it("recognises the login-item launch", () => {
    expect(parseServiceModeArgs(["/Applications/RealBud.app/Contents/MacOS/RealBud", "--service"])).toBe(true);
  });

  it("is false for an ordinary launch", () => {
    expect(parseServiceModeArgs(["/Applications/RealBud.app/Contents/MacOS/RealBud"])).toBe(false);
    expect(parseServiceModeArgs([])).toBe(false);
  });

  it("does not match a path that merely contains the word", () => {
    // A customer whose folder is named this way must still get a window.
    expect(parseServiceModeArgs(["realbud", "/Users/x/--service-notes/book.csv"])).toBe(false);
    expect(parseServiceModeArgs(["realbud", "--service-account"])).toBe(false);
  });

  it("survives a missing or malformed argv", () => {
    expect(parseServiceModeArgs(undefined)).toBe(false);
    expect(parseServiceModeArgs("--service")).toBe(false);
    expect(parseServiceModeArgs([null, 3])).toBe(false);
  });
});

describe("keepAwakeDecision", () => {
  it("holds app suspension off only when asked, scheduled and plugged in", () => {
    const decision = keepAwakeDecision({ optedIn: true, scheduleEnabled: true, onBattery: false });
    expect(decision.hold).toBe(true);
    expect(decision.type).toBe(KEEP_AWAKE_BLOCKER);
    expect(decision.state).toBe("holding");
  });

  it("never asks for display sleep to be prevented", () => {
    // Staff leave these machines in an office overnight; a lit screen is not
    // what they agreed to.
    const types = [
      keepAwakeDecision({ optedIn: true, scheduleEnabled: true, onBattery: false }).type,
      keepAwakeDecision({ optedIn: false, scheduleEnabled: true, onBattery: false }).type,
    ];
    expect(types).not.toContain("prevent-display-sleep");
  });

  it("lets the computer sleep when the customer has not asked", () => {
    expect(keepAwakeDecision({ optedIn: false, scheduleEnabled: true, onBattery: false })).toMatchObject({ hold: false, type: null, state: "off" });
  });

  it("lets the computer sleep when nothing is scheduled", () => {
    expect(keepAwakeDecision({ optedIn: true, scheduleEnabled: false, onBattery: false })).toMatchObject({ hold: false, state: "nothing-scheduled" });
  });

  it("lets the computer sleep on battery and says to plug it in", () => {
    const decision = keepAwakeDecision({ optedIn: true, scheduleEnabled: true, onBattery: true });
    expect(decision.hold).toBe(false);
    expect(decision.state).toBe("on-battery");
    expect(decision.explanation).toContain("plug it in");
  });

  it("gives every state one plain sentence and claims nothing it cannot do", () => {
    const decisions = [
      keepAwakeDecision({ optedIn: false, scheduleEnabled: false, onBattery: false }),
      keepAwakeDecision({ optedIn: true, scheduleEnabled: false, onBattery: false }),
      keepAwakeDecision({ optedIn: true, scheduleEnabled: true, onBattery: true }),
      keepAwakeDecision({ optedIn: true, scheduleEnabled: true, onBattery: false }),
    ];
    const states = decisions.map((decision) => decision.state);
    expect(new Set(states).size).toBe(4);
    for (const decision of decisions) {
      expect(decision.explanation.trim().length).toBeGreaterThan(20);
      expect(decision.explanation.split(". ").length).toBeLessThanOrEqual(2);
      // Never claim the computer keeps working through a shutdown or a shut lid.
      expect(decision.explanation).not.toMatch(/reboot|restart|closed lid|powered off|switched off/i);
      expect(decision.explanation).not.toMatch(/\bHermes\b|\bMCP\b|\bbroker\b|RealBud clock/i);
    }
  });

  it("treats missing facts as no reason to hold the computer awake", () => {
    expect(keepAwakeDecision({}).hold).toBe(false);
    expect(keepAwakeDecision({ optedIn: true }).hold).toBe(false);
  });
});
