// Pure desktop capability detection shared by Electron main tests and the
// renderer contract. Keep this file free of Electron imports so every branch
// is deterministic and unit-testable.

const DESKTOP_PLATFORMS = new Set(["darwin", "linux", "win32"]);
const MAC_PRIVACY_PANES = Object.freeze({
  accessibility: "Privacy_Accessibility",
  mic: "Privacy_Microphone",
  screen: "Privacy_ScreenCapture",
  speech: "Privacy_SpeechRecognition",
});

function normalizedPlatform(platform) {
  return DESKTOP_PLATFORMS.has(platform) ? platform : "other";
}

function linuxSession(platform, env) {
  if (platform !== "linux") return "unknown";
  const declared = String(env.XDG_SESSION_TYPE ?? "").toLowerCase();
  if (declared === "wayland") return "wayland";
  if (declared === "x11" || declared === "xorg") return "x11";
  // A Wayland user session may also expose DISPLAY for XWayland. Prefer the
  // Wayland signal so the UI never bypasses portal-mediated behavior.
  if (env.WAYLAND_DISPLAY) return "wayland";
  if (env.DISPLAY) return "x11";
  return "headless";
}

function boundedDescriptorCurrent(connection, now = Date.now()) {
  return Number.isSafeInteger(connection?.bounded?.expiresAt) && connection.bounded.expiresAt > now;
}

function localComputerReady(platform, connection, now = Date.now()) {
  return (
    platform === "darwin" &&
    connection?.mode === "embedded" &&
    connection?.authorizationMode === "bounded" &&
    (connection?.bounded?.kind === "setup" || connection?.bounded?.kind === "workflow") &&
    boundedDescriptorCurrent(connection, now)
  );
}

function localComputerReason(platform, connection, now = Date.now()) {
  if (platform !== "darwin") return "unsupported-platform";
  if (localComputerReady(platform, connection, now)) return undefined;
  if (
    connection?.mode === "embedded" &&
    connection?.authorizationMode === "bounded" &&
    (connection?.bounded?.kind === "setup" || connection?.bounded?.kind === "workflow") &&
    !boundedDescriptorCurrent(connection, now)
  ) return "cua-session-expired";
  const reason = String(connection?.reason ?? "").toLowerCase();
  if (reason.includes("package-smoke-disabled")) return "package-smoke-disabled";
  if (reason.includes("not-enabled")) return "cua-not-enabled";
  if (reason.includes("binary not found")) return "cua-bundle-missing";
  const accessibility = reason.includes("accessibility");
  const screen = reason.includes("screen recording");
  if (accessibility && screen) return "cua-accessibility-and-screen-required";
  if (accessibility) return "cua-accessibility-required";
  if (screen) return "cua-screen-recording-required";
  return "cua-start-failed";
}

function macPrivacySettingsUrl(pane) {
  if (typeof pane !== "string" || !Object.hasOwn(MAC_PRIVACY_PANES, pane)) return null;
  return `x-apple.systempreferences:com.apple.preference.security?${MAC_PRIVACY_PANES[pane]}`;
}

function desktopCapabilities({
  platform = process.platform,
  env = process.env,
  packaged = false,
  localConnection = null,
  now = Date.now(),
} = {}) {
  const hostPlatform = normalizedPlatform(platform);
  const isMac = hostPlatform === "darwin";
  const localAvailable = localComputerReady(hostPlatform, localConnection, now);
  const localReason = localComputerReason(hostPlatform, localConnection, now);
  const localRuntime =
    localConnection?.runtime === "bundled" || localConnection?.runtime === "development"
      ? localConnection.runtime
      : "none";

  return {
    host: {
      platform: hostPlatform,
      label:
        hostPlatform === "darwin"
          ? "macOS"
          : hostPlatform === "linux"
            ? "Linux"
            : hostPlatform === "win32"
              ? "Windows"
              : "Desktop",
      session: linuxSession(hostPlatform, env),
      packaged: Boolean(packaged),
    },
    windowChrome: isMac ? "mac-inset" : "native",
    screenPreview: {
      available: isMac,
      interaction: isMac ? "direct" : "none",
      ...(!isMac ? { reasonCode: "unsupported-platform" } : {}),
    },
    dictation: {
      available: isMac,
      engine: isMac ? "apple-speech" : "none",
      onDevice: isMac,
      ...(!isMac ? { reasonCode: "unsupported-platform" } : {}),
    },
    localComputer: {
      available: localAvailable,
      support: localAvailable ? "supported" : isMac ? "limited" : "unsupported",
      runtime: localRuntime,
      ...(localReason ? { reasonCode: localReason } : {}),
    },
  };
}

module.exports = { boundedDescriptorCurrent, desktopCapabilities, linuxSession, localComputerReady, localComputerReason, macPrivacySettingsUrl };
