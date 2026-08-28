// Renderer bridge. contextIsolation stays on; the renderer only ever sees
// this narrow surface (window.ogb), never Node or ipcRenderer itself.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("ogb", {
  /** Host platform ("darwin" | "win32" | "linux") — for platform-aware UI. */
  platform: process.platform,
  getCapabilities: () => ipcRenderer.invoke("desktop:capabilities"),
  /** Explicitly enables RealBud's bundled computer-use host and returns its
   * current sanitized capability state. macOS owns the permission prompts. */
  enableComputerUse: () => ipcRenderer.invoke("cua:enable"),
  /** Explicitly revoke RealBud's local computer-use host and future
   * auto-start. This does not modify macOS permission settings. */
  disableComputerUse: () => ipcRenderer.invoke("cua:disable"),
  /** One frame of this computer's screen as a data: URL when supported. */
  screenFrame: () => ipcRenderer.invoke("screen:frame"),
  speechStart: (options) => ipcRenderer.invoke("speech:start", options),
  speechStop: () => ipcRenderer.invoke("speech:stop"),
  speechFinish: () => ipcRenderer.invoke("speech:finish"),
  onSpeechTranscript: (cb) => {
    const handler = (_event, line) => cb(line);
    ipcRenderer.on("speech:transcript", handler);
    return () => ipcRenderer.removeListener("speech:transcript", handler);
  },
  onSpeechEnd: (cb) => {
    const handler = (_event, info) => cb(info);
    ipcRenderer.on("speech:end", handler);
    return () => ipcRenderer.removeListener("speech:end", handler);
  },
  /** Absolute path of a dropped File — Electron 32 removed File.path, and
   * only the preload can ask. "" when the drag carried no file on disk. */
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  /** Human-initiated OS file picker. Main validates the returned regular
   * files and bounds count/size before exposing paths to the renderer. */
  chooseFiles: () => ipcRenderer.invoke("files:choose"),
  /** Privacy-safe routine reminder. The shell owns all visible copy; the
   * renderer can pass only a run id and the closed failed/held reason. */
  notifyRoutine: (input) => ipcRenderer.invoke("routine-reminder:show", input),
  onRoutineReminderOpened: (cb) => {
    const handler = (_event, input) => cb(input);
    ipcRenderer.on("routine-reminder:opened", handler);
    return () => ipcRenderer.removeListener("routine-reminder:opened", handler);
  },
  /** {mic} TCC status strings: granted|denied|not-determined|unknown.
   * No screen field — macOS 15+ caches that status per-process, so any
   * value here would lie for the whole session after a grant. */
  permStatus: () => ipcRenderer.invoke("perm:status"),
  /** Triggers the macOS microphone prompt; resolves true when granted. */
  permRequestMic: () => ipcRenderer.invoke("perm:request-mic"),
  /** Opens System Settings on the given privacy pane. */
  permOpenSettings: (pane) => ipcRenderer.invoke("perm:open-settings", pane),
  /** Open an https URL in the OS browser. Never navigates this window. */
  openExternal: (url) => ipcRenderer.invoke("shell:open-https", url),

  /** Copies an engine install command and opens a blank terminal. Resolves
   * false if no terminal could be launched; the clipboard still has it. */
  openInstallTerminal: (command) => ipcRenderer.invoke("engine:open-terminal", command),

  /** In-app auto-update. State object:
   *  { status: "idle"|"checking"|"available"|"downloading"|"downloaded"|"error",
   *    version?, percent?, message? }. onState fires immediately with the
   *    current state, then on every transition. Dormant in dev (no bridge). */
  updater: {
    check: () => ipcRenderer.invoke("update:check"),
    download: () => ipcRenderer.invoke("update:download"),
    install: () => ipcRenderer.invoke("update:install"),
    onState: (cb) => {
      ipcRenderer
        .invoke("update:get-state")
        .then((s) => cb(s))
        .catch(() => {});
      const handler = (_event, s) => cb(s);
      ipcRenderer.on("update:state", handler);
      return () => ipcRenderer.removeListener("update:state", handler);
    },
  },
});
