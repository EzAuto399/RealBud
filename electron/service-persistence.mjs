// Whether the office is there to do scheduled work when nobody is looking.
//
// Why: the office service is a detached process (`service-lifecycle.mjs`), so it
// outlives the RealBud window — but not a restart and not a sign-out. Nothing
// started it except someone opening RealBud, and nothing kept the computer awake
// to reach 08:00. A scheduled scan therefore depended on two facts the customer
// was never shown: that somebody had opened RealBud since the last restart, and
// that the lid was open.
//
// This module decides two things and touches no Electron API, so both are
// testable without booting the app and without registering anything on the
// developer's machine:
//
//   1. the login item — start the office service after the customer signs in,
//      only when they asked for it and only from an installed build;
//   2. the power blocker — hold the computer awake for scheduled work, only
//      while there is scheduled work and only while it is plugged in.
//
// What this DOES NOT provide, deliberately, and what the interface must keep
// saying: a login item runs after a SIGN-IN, not after a power-on, so a computer
// that is switched off, or switched on but sitting at the login screen, is not
// running the office. `prevent-app-suspension` keeps a woken computer from
// sleeping; it does not defeat a closed lid on a Mac, a power cut or a shutdown.
// The honest promise is "runs when this computer is signed in and awake", and a
// missed occurrence must stay visible rather than be papered over here.
//
// Also not provided: a fully invisible start on macOS. Electron only passes
// launch arguments to a login item on Windows, so only there does the sign-in
// launch arrive as `--service` with no window; on macOS the app opens and starts
// the service the way it always does. A silent macOS start would need a bundled
// launch-agent service registration, which has to solve key custody without an
// unlocked keychain first — so the explanations below differ by platform rather
// than claiming the same thing on both.

/** The flag a login-item launch carries so main starts headless (no window). */
export const SERVICE_MODE_FLAG = "--service";

/** Never `prevent-display-sleep`: staff do not want a screen burning all night,
 * and app suspension — not the display — is what stops scheduled work. */
export const KEEP_AWAKE_BLOCKER = "prevent-app-suspension";

// Only these two have an `app.setLoginItemSettings` implementation in Electron.
// Linux would need a freedesktop autostart entry written by hand, which is a
// different mechanism with a different failure mode; claim nothing there.
const LOGIN_ITEM_PLATFORMS = new Set(["darwin", "win32"]);

/**
 * Whether this build can register itself to start at sign-in, and the sentence
 * to show the customer either way.
 *
 * A development build must never register: the login item would point at the
 * Electron binary inside `node_modules`, which survives no dependency install
 * and is not the customer's app. That is a support burden, not a feature.
 *
 * @param {object} host
 * @param {string} host.platform `process.platform`.
 * @param {boolean} host.packaged `app.isPackaged`.
 * @returns {{ supported: boolean, reason: "supported" | "platform" | "development", explanation: string }}
 */
export function startupRegistrationSupport({ platform, packaged }) {
  if (!LOGIN_ITEM_PLATFORMS.has(platform)) {
    return {
      supported: false,
      reason: "platform",
      explanation: "This computer cannot be set to start RealBud's office service when you sign in.",
    };
  }
  if (packaged !== true) {
    return {
      supported: false,
      reason: "development",
      explanation: "A development build cannot start itself at sign-in; the installed RealBud app can.",
    };
  }
  return {
    supported: true,
    reason: "supported",
    // Platform-honest, because the two are not the same thing. Electron passes
    // launch arguments to a login item on Windows only, so only there does the
    // sign-in launch reach the headless `--service` host. On macOS the login
    // item opens the app itself: the office service still starts, but RealBud
    // opens with it. Saying "in the background" on a Mac would be a promise the
    // customer can see is false the first morning they sign in.
    explanation: platform === "win32"
      ? "RealBud starts its office service in the background after you sign in to this computer."
      : "RealBud opens after you sign in to this computer and starts its office service; on a Mac it cannot start completely out of sight.",
  };
}

/**
 * What to hand `app.setLoginItemSettings`, or `null` for "call nothing".
 *
 * Returning `null` rather than a no-op object matters: writing the same value
 * back re-touches a macOS login item and a Windows Run key on every launch, and
 * a support report of "RealBud keeps re-adding itself" is worse than the setting
 * it was meant to keep. An unknown `current` (undefined, a failed read) is not
 * treated as agreement — it plans the call, because the cheap correction is
 * better than a toggle that silently did nothing.
 *
 * @param {object} decision
 * @param {boolean} decision.desired What the customer has asked for.
 * @param {boolean | undefined} decision.current `getLoginItemSettings().openAtLogin`.
 * @param {string} decision.platform `process.platform`.
 * @param {boolean} decision.packaged `app.isPackaged`.
 * @returns {{ openAtLogin: boolean, openAsHidden: boolean, args: string[] } | null}
 */
export function planStartupRegistration({ desired, current, platform, packaged }) {
  if (!startupRegistrationSupport({ platform, packaged }).supported) return null;
  const openAtLogin = desired === true;
  if (current === openAtLogin) return null;
  return {
    openAtLogin,
    // Hidden because this launch has no window at all. The args are part of the
    // registration's identity on Windows, so they stay on the removal call too —
    // otherwise the Run entry this app wrote is not the one it later clears.
    openAsHidden: openAtLogin,
    args: [SERVICE_MODE_FLAG],
  };
}

/**
 * Is this launch the headless service host rather than a window?
 *
 * Strict token equality: a data directory or file path that merely contains the
 * word must never silently suppress the customer's window.
 *
 * @param {unknown} argv Usually `process.argv`.
 * @returns {boolean}
 */
export function parseServiceModeArgs(argv) {
  if (!Array.isArray(argv)) return false;
  return argv.some((entry) => typeof entry === "string" && entry.trim() === SERVICE_MODE_FLAG);
}

/**
 * Whether to hold the computer awake, and the one sentence that explains it.
 *
 * Three reasons to let go, all of which the customer can see:
 *  - they did not ask for it (the default; their power settings are theirs);
 *  - nothing is scheduled, so there is nothing to stay awake for;
 *  - the computer is on battery, where an unattended keep-awake is a flat
 *    battery rather than a completed scan. Plugged in is the honest condition.
 *
 * @param {object} state
 * @param {boolean} state.optedIn The customer turned the setting on.
 * @param {boolean} state.scheduleEnabled At least one scheduled job is on.
 * @param {boolean} state.onBattery `powerMonitor.isOnBatteryPower()`.
 * @returns {{ hold: boolean, type: string | null, state: "off" | "nothing-scheduled" | "on-battery" | "holding", explanation: string }}
 */
export function keepAwakeDecision({ optedIn, scheduleEnabled, onBattery }) {
  if (optedIn !== true) {
    return {
      hold: false,
      type: null,
      state: "off",
      explanation: "This computer sleeps on its usual settings, so scheduled work does not run while it is asleep.",
    };
  }
  if (scheduleEnabled !== true) {
    return {
      hold: false,
      type: null,
      state: "nothing-scheduled",
      explanation: "Nothing is scheduled at the moment, so this computer is left to sleep on its usual settings.",
    };
  }
  if (onBattery === true) {
    return {
      hold: false,
      type: null,
      state: "on-battery",
      explanation: "On battery this computer is left to sleep on its usual settings, so plug it in for scheduled work to run unattended.",
    };
  }
  return {
    hold: true,
    type: KEEP_AWAKE_BLOCKER,
    state: "holding",
    explanation: "While this computer is plugged in and switched on, RealBud keeps it from sleeping so scheduled work can run; the screen still turns off.",
  };
}
