// Renderer bridge. contextIsolation stays on; the renderer only ever sees
// this narrow surface (window.ogb), never Node or ipcRenderer itself.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

// Before an update restarts RealBud, main asks whether the window holds unsaved
// work. Without a handler nothing answers, and main's 2 s timeout decides: the
// automatic restart waits, "Restart now" goes ahead. A handler that fails or
// answers anything but false keeps the work.
let unsavedCheck = null;
ipcRenderer.on("update:query-unsaved", async (_event, id) => {
  const check = unsavedCheck;
  if (!check) return;
  let unsaved = true;
  try {
    unsaved = (await check()) !== false;
  } catch {
    /* can't tell: keep the work */
  }
  ipcRenderer.invoke("update:unsaved-reply", id, { unsaved }).catch(() => {});
});

contextBridge.exposeInMainWorld("ogb", {
  /** Host platform ("darwin" | "win32" | "linux") — for platform-aware UI. */
  platform: process.platform,
  getCapabilities: () => ipcRenderer.invoke("desktop:capabilities"),
  /** The local API session token; main checks the sender frame and service. */
  getLocalSession: () => ipcRenderer.invoke("local-session:get"),
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
  /** {mic} TCC status strings: granted|denied|not-determined|unknown.
   * No screen field — macOS 15+ caches that status per-process, so any
   * value here would lie for the whole session after a grant. */
  permStatus: () => ipcRenderer.invoke("perm:status"),
  /** Triggers the macOS microphone prompt; resolves true when granted. */
  permRequestMic: () => ipcRenderer.invoke("perm:request-mic"),
  /** Opens System Settings on the given privacy pane: mic|screen|speech. */
  permOpenSettings: (pane) => ipcRenderer.invoke("perm:open-settings", pane),

  /** Copies an engine install command and opens a blank terminal. Resolves
   * false if no terminal could be launched; the clipboard still has it. */
  openInstallTerminal: (command) => ipcRenderer.invoke("engine:open-terminal", command),
  /** Open a server-vetted HTTPS connection/auth link in the default browser. */
  openExternal: (url) => ipcRenderer.invoke("external:open", url),

  /** Lifecycle of the desk service child. { state, restarts, lastExitCode,
   * exhausted }. Read from the main process because a dead service cannot
   * answer the HTTP API that would otherwise report it. */
  serviceStatus: () => ipcRenderer.invoke("service:status"),
  /** Ask supervision to try the service again after it gave up. */
  serviceRetry: () => ipcRenderer.invoke("service:retry"),
  /** Start the office service if it is not already running. */
  serviceStart: () => ipcRenderer.invoke("service:start"),
  /** Explicitly stop the office service. Closing the window never does this. */
  /** `{ ifIdle: true }` asks the service to refuse while Bud is working. */
  serviceStop: (options) => ipcRenderer.invoke("service:stop", options?.ifIdle === true ? { ifIdle: true } : undefined),
  /** Save a masked support file where the person chooses in the native save
   * dialog. Takes no argument and returns only the outcome, never a path. */
  saveSupportFile: () => ipcRenderer.invoke("support:save"),

  /** Whether this computer is there to do scheduled work when nobody is
   * looking: start the office service after sign-in, and hold the computer
   * awake while something is scheduled. `set` also carries the window's report
   * of whether anything is scheduled — the office owns that fact, the main
   * process only caches the last report so a sign-in launch can act on it. */
  servicePersistence: {
    get: () => ipcRenderer.invoke("service:persistence:get"),
    set: (settings) => ipcRenderer.invoke("service:persistence:set", settings),
  },

  /** Hermios, the office CRM, in its own view inside this window. The person
   * signs in to Hermios themselves; nothing here carries a credential, cookie
   * or page content back. `show` takes the placeholder's rectangle in CSS
   * pixels; every call resolves true when the view did what was asked. */
  hermiosView: {
    show: (bounds) =>
      ipcRenderer.invoke("hermios-view:show", {
        x: bounds?.x,
        y: bounds?.y,
        width: bounds?.width,
        height: bounds?.height,
      }),
    hide: () => ipcRenderer.invoke("hermios-view:hide"),
    back: () => ipcRenderer.invoke("hermios-view:back"),
    reload: () => ipcRenderer.invoke("hermios-view:reload"),
    signOut: () => ipcRenderer.invoke("hermios-view:sign-out"),
    openExternal: () => ipcRenderer.invoke("hermios-view:open-external"),
  },

  /** In-app auto-update. State object:
   *  { status: "idle"|"checking"|"available"|"downloading"|"downloaded"|"error",
   *    version?, percent?, message?, deferred?, restart?, installFailed?,
   *    updatedFrom? } (docs/UPDATES-2026-10-10.md). onState fires immediately
   *    with the current state, then on every transition. Dormant in dev. */
  updater: {
    check: () => ipcRenderer.invoke("update:check"),
    download: () => ipcRenderer.invoke("update:download"),
    /** Main asks onQueryUnsaved's handler first and holds the install for unsaved work. */
    install: () => ipcRenderer.invoke("update:install"),
    /** Holds the automatic restart for 4 hours; resolves false when main refuses (required, or nothing waiting). */
    later: () => ipcRenderer.invoke("update:later"),
    /** The countdown's "Not now". */
    cancelCountdown: () => ipcRenderer.invoke("update:cancel-countdown"),
    /** Clears the "Updated to" or "didn't install" note. */
    dismissNote: () => ipcRenderer.invoke("update:dismiss-note"),
    /** The one answer to main's "does this window hold unsaved work?" (true =
     * unsaved). A newer handler replaces the last; returns an unsubscribe. */
    onQueryUnsaved: (handler) => {
      unsavedCheck = handler;
      return () => {
        if (unsavedCheck === handler) unsavedCheck = null;
      };
    },
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
