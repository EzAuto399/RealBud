import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  desktopCapabilities,
  linuxSession,
  localComputerReady,
  localComputerReason,
  macPrivacySettingsUrl,
} = require("./capabilities.cjs");

describe("desktop capabilities", () => {
  it("keeps macOS native features behind a ready CUA connection", () => {
    const capabilities = desktopCapabilities({
      platform: "darwin",
      packaged: true,
      localConnection: {
        mode: "embedded",
        runtime: "bundled",
        authorizationMode: "bounded",
        bounded: { kind: "setup", expiresAt: 20_000 },
      },
      now: 10_000,
    });

    expect(capabilities).toMatchObject({
      host: { platform: "darwin", label: "macOS", session: "unknown", packaged: true },
      windowChrome: "mac-inset",
      screenPreview: { available: true, interaction: "direct" },
      dictation: { available: true, engine: "apple-speech", onDevice: true },
      localComputer: { available: true, support: "supported", runtime: "bundled" },
    });
  });

  it.each(["linux", "win32", "freebsd"])("fails closed on %s", (platform) => {
    const capabilities = desktopCapabilities({
      platform,
      env: { DISPLAY: ":0" },
      localConnection: { mode: "embedded" },
    });

    expect(capabilities.windowChrome).toBe("native");
    expect(capabilities.screenPreview.available).toBe(false);
    expect(capabilities.dictation.available).toBe(false);
    expect(capabilities.localComputer).toMatchObject({
      available: false,
      support: "unsupported",
      runtime: "none",
      reasonCode: "unsupported-platform",
    });
  });

  it("detects Wayland before XWayland and distinguishes X11 and headless Linux", () => {
    expect(linuxSession("linux", { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" })).toBe("wayland");
    expect(linuxSession("linux", { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" })).toBe("x11");
    expect(linuxSession("linux", {})).toBe("headless");
  });

  it("never treats an embedded-looking Linux connection as local control", () => {
    expect(localComputerReady("linux", { mode: "embedded" })).toBe(false);
    expect(localComputerReady("darwin", { mode: "unavailable" })).toBe(false);
    expect(localComputerReady("darwin", { mode: "standalone" })).toBe(false);
    expect(localComputerReady("darwin", { mode: "embedded", authorizationMode: "standard" })).toBe(false);
    expect(
      localComputerReady("darwin", {
        mode: "embedded",
        authorizationMode: "bounded",
        bounded: { kind: "setup", expiresAt: 20_000 },
      }, 10_000),
    ).toBe(true);
  });

  it("does not report an expired or incomplete bounded descriptor ready", () => {
    const expired = {
      mode: "embedded",
      runtime: "bundled",
      authorizationMode: "bounded",
      bounded: { kind: "setup", expiresAt: 9_000 },
    };
    expect(localComputerReady("darwin", expired, 10_000)).toBe(false);
    expect(localComputerReason("darwin", expired, 10_000)).toBe("cua-session-expired");
    expect(localComputerReady("darwin", {
      mode: "embedded",
      authorizationMode: "bounded",
      bounded: { kind: "setup" },
    }, 10_000)).toBe(false);
  });

  it("reports closed setup reasons without exposing raw driver errors", () => {
    expect(
      localComputerReason("darwin", {
        mode: "unavailable",
        reason: "embedded host failed: Accessibility and Screen Recording required; /private/path",
      }),
    ).toBe("cua-accessibility-and-screen-required");
    expect(localComputerReason("darwin", { mode: "unavailable", reason: "cua-driver binary not found" })).toBe(
      "cua-bundle-missing",
    );
    expect(
      desktopCapabilities({
        platform: "darwin",
        packaged: true,
        localConnection: { mode: "unavailable", runtime: "bundled", reason: "private failure /Users/someone" },
      }).localComputer,
    ).toEqual({ available: false, support: "limited", runtime: "bundled", reasonCode: "cua-start-failed" });
  });

  it("opens only the four fixed macOS privacy panes", () => {
    expect(macPrivacySettingsUrl("accessibility")).toBe(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    );
    expect(macPrivacySettingsUrl("screen")).toBe(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    );
    expect(macPrivacySettingsUrl("__proto__")).toBeNull();
    expect(macPrivacySettingsUrl("https://example.com")).toBeNull();
    expect(macPrivacySettingsUrl(null)).toBeNull();
  });
});
