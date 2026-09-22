// Desktop settings the main process owns, kept pure so unit tests can assert
// them without booting Electron.
//
// Two of them decide whether this computer is there to do scheduled work:
// whether RealBud starts its office service after the customer signs in, and
// whether it holds the computer awake while something is scheduled. Both default
// to OFF — registering a login item or overriding someone's power settings is
// theirs to ask for, never a default they discover afterwards.
//
// Reading and writing the file is the main process's job (it owns the app paths
// and must survive a corrupt one); the parsing and merging rules live here so
// they are testable and so an unknown or hand-edited key can never become a
// setting the interface then reports as true.
//
// Privacy Settings deep-link candidates follow, per platform.
const DESKTOP_SETTING_DEFAULTS = Object.freeze({
  startOfficeServiceAtLogin: false,
  keepAwakeForSchedules: false,
});

/** Normalise stored desktop settings. Anything unreadable, missing or not a
 * boolean reads as the default: a damaged file must never look like consent.
 * @param {unknown} raw Parsed JSON, a JSON string, or nothing.
 * @returns {{ startOfficeServiceAtLogin: boolean, keepAwakeForSchedules: boolean }} */
function readDesktopSettings(raw) {
  let source = raw;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      source = null;
    }
  }
  const stored = source && typeof source === "object" && !Array.isArray(source) ? source : {};
  const settings = { ...DESKTOP_SETTING_DEFAULTS };
  for (const key of Object.keys(DESKTOP_SETTING_DEFAULTS)) {
    if (stored[key] === true) settings[key] = true;
  }
  return settings;
}

/** Apply a renderer-supplied patch. Only known keys move, and only an explicit
 * boolean moves one: an absent key leaves the current value alone rather than
 * resetting it, so one toggle can never clear the other.
 * @param {unknown} current @param {unknown} patch */
function mergeDesktopSettings(current, patch) {
  const settings = readDesktopSettings(current);
  const requested = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
  for (const key of Object.keys(DESKTOP_SETTING_DEFAULTS)) {
    if (typeof requested[key] === "boolean") settings[key] = requested[key];
  }
  return settings;
}

/** The exact bytes to persist: only known keys, so a hand-added key is dropped
 * on the next write rather than kept around looking meaningful. */
function serializeDesktopSettings(settings) {
  return `${JSON.stringify(readDesktopSettings(settings), null, 2)}\n`;
}

// The last thing a RealBud window reported about the office's own schedule.
//
// It is kept in a SEPARATE file from the settings above on purpose: the settings
// are the customer's consent, this is cached evidence, and the two must never be
// mistaken for each other. The office's schedule lives in the office (the window
// reads it from the same place the Schedule screen does); main keeps the last
// report so a sign-in launch with no window open can still tell whether there is
// anything to stay awake for. It is deliberately a weak fact — being wrong costs
// an unnecessary hour of wakefulness or a sleep that the schedule surface then
// shows as a missed occurrence, never a scan reported as done.

/** @param {unknown} raw @returns {{ scheduleEnabled: boolean, reportedAt: number | null }} */
function readScheduleFact(raw) {
  let source = raw;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      source = null;
    }
  }
  const stored = source && typeof source === "object" && !Array.isArray(source) ? source : {};
  const reportedAt = Number(stored.reportedAt);
  return {
    scheduleEnabled: stored.scheduleEnabled === true,
    reportedAt: Number.isFinite(reportedAt) && reportedAt > 0 ? reportedAt : null,
  };
}

function serializeScheduleFact(fact) {
  return `${JSON.stringify(readScheduleFact(fact), null, 2)}\n`;
}

// Privacy Settings deep-link candidates per platform. Pure so unit tests can
// assert Windows ms-settings URIs without booting Electron.
function privacySettingsUrls(platform, pane) {
  if (platform === "win32") {
    const map = {
      mic: ["ms-settings:privacy-microphone"],
      speech: ["ms-settings:privacy-speech", "ms-settings:speech"],
      screen: ["ms-settings:privacy-graphicscaptureprogrammatic", "ms-settings:privacy"],
    };
    return Object.hasOwn(map, pane) ? map[pane] : ["ms-settings:privacy"];
  }
  if (platform === "darwin") {
    const panes = {
      mic: ["Privacy_Microphone", "Microphone"],
      screen: ["Privacy_ScreenCapture", "ScreenCapture"],
      speech: ["Privacy_SpeechRecognition", "SpeechRecognition"],
    };
    const keys = Object.hasOwn(panes, pane) ? panes[pane] : ["Privacy"];
    return [
      `x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?${keys[0]}`,
      `x-apple.systempreferences:com.apple.preference.security?${keys[0]}`,
      ...(keys[1]
        ? [`x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?path=${keys[1]}`]
        : []),
    ];
  }
  return [];
}

module.exports = {
  DESKTOP_SETTING_DEFAULTS,
  mergeDesktopSettings,
  privacySettingsUrls,
  readDesktopSettings,
  readScheduleFact,
  serializeDesktopSettings,
  serializeScheduleFact,
};
