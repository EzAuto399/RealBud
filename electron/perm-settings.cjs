// Privacy Settings deep-link candidates per platform. Pure so unit tests can
// assert Windows ms-settings URIs without booting Electron.
function privacySettingsUrls(platform, pane) {
  if (platform === "win32") {
    const map = {
      mic: ["ms-settings:privacy-microphone"],
      speech: ["ms-settings:privacy-speech", "ms-settings:speech"],
      screen: ["ms-settings:privacy-graphicscaptureprogrammatic", "ms-settings:privacy-webcam"],
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

module.exports = { privacySettingsUrls };
