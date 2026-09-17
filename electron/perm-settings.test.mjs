import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { privacySettingsUrls } = require("./perm-settings.cjs");

describe("privacySettingsUrls", () => {
  it("returns Windows ms-settings URIs for mic and speech", () => {
    expect(privacySettingsUrls("win32", "mic")).toEqual(["ms-settings:privacy-microphone"]);
    expect(privacySettingsUrls("win32", "speech")[0]).toBe("ms-settings:privacy-speech");
  });

  it("returns macOS System Settings deep links", () => {
    expect(privacySettingsUrls("darwin", "mic")[0]).toContain("Privacy_Microphone");
    expect(privacySettingsUrls("darwin", "speech")[0]).toContain("Privacy_SpeechRecognition");
  });

  it("returns nothing on unsupported platforms", () => {
    expect(privacySettingsUrls("linux", "mic")).toEqual([]);
  });
});
