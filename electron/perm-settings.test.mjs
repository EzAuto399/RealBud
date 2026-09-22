import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  DESKTOP_SETTING_DEFAULTS,
  mergeDesktopSettings,
  privacySettingsUrls,
  readDesktopSettings,
  readScheduleFact,
  serializeDesktopSettings,
  serializeScheduleFact,
} = require("./perm-settings.cjs");

describe("last reported schedule fact", () => {
  it("defaults to nothing scheduled and no report", () => {
    expect(readScheduleFact(undefined)).toEqual({ scheduleEnabled: false, reportedAt: null });
    expect(readScheduleFact("{broken")).toEqual({ scheduleEnabled: false, reportedAt: null });
  });

  it("keeps the report and when it was made", () => {
    expect(readScheduleFact('{"scheduleEnabled":true,"reportedAt":1758500000000}')).toEqual({
      scheduleEnabled: true,
      reportedAt: 1758500000000,
    });
  });

  it("never reads a nonsense timestamp as a real report", () => {
    expect(readScheduleFact({ scheduleEnabled: true, reportedAt: "yesterday" }).reportedAt).toBeNull();
    expect(readScheduleFact({ scheduleEnabled: true, reportedAt: -1 }).reportedAt).toBeNull();
  });

  it("is a separate file from the customer's settings, not a setting", () => {
    // Cached evidence must never be able to arrive as consent.
    expect(readDesktopSettings({ scheduleEnabled: true })).toEqual({ startOfficeServiceAtLogin: false, keepAwakeForSchedules: false });
    expect(JSON.parse(serializeScheduleFact({ scheduleEnabled: true, reportedAt: 5, keepAwakeForSchedules: true }))).toEqual({
      scheduleEnabled: true,
      reportedAt: 5,
    });
  });
});

describe("desktop settings", () => {
  it("defaults both unattended-work settings to off", () => {
    // Starting at sign-in and holding the computer awake are asked for, never
    // discovered afterwards.
    expect(DESKTOP_SETTING_DEFAULTS).toEqual({ startOfficeServiceAtLogin: false, keepAwakeForSchedules: false });
    expect(readDesktopSettings(undefined)).toEqual({ startOfficeServiceAtLogin: false, keepAwakeForSchedules: false });
  });

  it("reads stored settings from JSON text or a parsed object", () => {
    expect(readDesktopSettings('{"startOfficeServiceAtLogin":true}')).toEqual({ startOfficeServiceAtLogin: true, keepAwakeForSchedules: false });
    expect(readDesktopSettings({ keepAwakeForSchedules: true })).toEqual({ startOfficeServiceAtLogin: false, keepAwakeForSchedules: true });
  });

  it("treats a damaged or hostile file as no consent rather than as true", () => {
    for (const raw of ["{not json", null, [], 7, '"true"', { startOfficeServiceAtLogin: "true" }, { keepAwakeForSchedules: 1 }]) {
      expect(readDesktopSettings(raw)).toEqual({ startOfficeServiceAtLogin: false, keepAwakeForSchedules: false });
    }
  });

  it("moves only the setting the patch names", () => {
    const current = { startOfficeServiceAtLogin: true, keepAwakeForSchedules: true };
    expect(mergeDesktopSettings(current, { keepAwakeForSchedules: false })).toEqual({ startOfficeServiceAtLogin: true, keepAwakeForSchedules: false });
    expect(mergeDesktopSettings(current, {})).toEqual(current);
    expect(mergeDesktopSettings(current, null)).toEqual(current);
  });

  it("ignores unknown keys from the renderer and drops them from the file", () => {
    expect(mergeDesktopSettings({}, { scheduleEnabled: true, openAtLogin: true })).toEqual(DESKTOP_SETTING_DEFAULTS);
    expect(JSON.parse(serializeDesktopSettings({ keepAwakeForSchedules: true, somethingElse: "x" }))).toEqual({
      startOfficeServiceAtLogin: false,
      keepAwakeForSchedules: true,
    });
  });

  it("serialises a file that reads back identically", () => {
    const settings = { startOfficeServiceAtLogin: true, keepAwakeForSchedules: false };
    const text = serializeDesktopSettings(settings);
    expect(text.endsWith("\n")).toBe(true);
    expect(readDesktopSettings(text)).toEqual(settings);
  });
});

describe("privacySettingsUrls", () => {
  it("returns Windows ms-settings URIs for mic and speech", () => {
    expect(privacySettingsUrls("win32", "mic")).toEqual(["ms-settings:privacy-microphone"]);
    expect(privacySettingsUrls("win32", "speech")[0]).toBe("ms-settings:privacy-speech");
  });

  it("returns macOS System Settings deep links", () => {
    expect(privacySettingsUrls("darwin", "mic")[0]).toContain("Privacy_Microphone");
    expect(privacySettingsUrls("darwin", "speech")[0]).toContain("Privacy_SpeechRecognition");
  });

  it("keeps Windows screen sharing settings separate from camera access", () => {
    expect(privacySettingsUrls("win32", "screen")).toEqual([
      "ms-settings:privacy-graphicscaptureprogrammatic", "ms-settings:privacy",
    ]);
  });

  it("returns nothing on unsupported platforms", () => {
    expect(privacySettingsUrls("linux", "mic")).toEqual([]);
  });
});
