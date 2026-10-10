// The narrow bridge the Electron preload exposes. Absent in the browser.
export {};

declare global {
  type DesktopCapabilities = {
    host: {
      platform: "darwin" | "linux" | "win32" | "other";
      label: string;
      session: "x11" | "wayland" | "headless" | "unknown";
      packaged: boolean;
    };
    windowChrome: "mac-inset" | "native";
    screenPreview: {
      available: boolean;
      interaction: "direct" | "portal-picker" | "none";
      reasonCode?: string;
    };
    dictation: {
      available: boolean;
      engine: "apple-speech" | "windows-speech" | "none";
      onDevice: boolean;
      reasonCode?: string;
    };
    localComputer: {
      available: boolean;
      support: "supported" | "limited" | "unsupported";
      reasonCode?: string;
    };
  };

  interface ServiceLifecycleStatus {
    state: string;
    restarts: number;
    lastExitCode: number | null;
    exhausted: boolean;
    /** The office service is answering on this computer. */
    running?: boolean;
    port?: number | null;
    /** It was already running when RealBud launched. */
    adopted?: boolean;
    /** RealBud started it, so RealBud can stop it. */
    manageable?: boolean;
    /** Running, but not started by this installation. */
    external?: boolean;
  }

  /** Whether this computer is there to do scheduled work when nobody is looking.
   * Both settings are off until the customer turns them on. */
  interface ServicePersistenceState {
    settings: { startOfficeServiceAtLogin: boolean; keepAwakeForSchedules: boolean };
    /** Whether this build can register itself to start after sign-in, and why
     * not when it cannot (a development build cannot). */
    startup: { supported: boolean; reason: "supported" | "platform" | "development"; explanation: string };
    /** What is actually held right now, not what was decided. */
    keepAwake: {
      holding: boolean;
      state: "off" | "nothing-scheduled" | "on-battery" | "holding";
      explanation: string;
    };
    /** The last thing a window reported about the office's own schedule. */
    scheduleEnabled: boolean;
    /** False when a change could not be written to disk, so it will not survive
     * a restart. Only present on a set. */
    saved?: boolean;
  }

  /** The native Hermios view. The person signs in to Hermios themselves; no
   * credential, cookie or page content crosses this bridge. Each call resolves
   * true when the view did what was asked. */
  interface HermiosViewBridge {
    /** Place and show the view over this rectangle, in CSS pixels. The first
     * show opens the Hermios sign-in page; later ones keep the current page. */
    show(bounds: { x: number; y: number; width: number; height: number }): Promise<boolean>;
    hide(): Promise<boolean>;
    back(): Promise<boolean>;
    reload(): Promise<boolean>;
    /** Clear Hermios' saved sign-in on this computer only, then show sign-in. */
    signOut(): Promise<boolean>;
    /** Open the current Hermios page, or its sign-in page, in the default browser. */
    openExternal(): Promise<boolean>;
  }

  interface Window {
    ogb?: {
      platform: NodeJS.Platform;
      getCapabilities(): Promise<DesktopCapabilities>;
      /** This boot's local API session token. Main answers only the office
       * window's own main frame, and only for its verified office service. */
      getLocalSession?(): Promise<string>;
      screenFrame(): Promise<string | null>;
      /** Start native dictation. Call mode supplies endpointMs so silence
       * finalizes a turn; composer dictation omits it and remains manual. */
      speechStart(options?: { endpointMs?: number }): Promise<void>;
      speechStop(): Promise<void>;
      /** Finish capture and emit the recognizer's final transcript. */
      speechFinish?(): Promise<void>;
      onSpeechTranscript(
        cb: (line: { partial?: boolean; text?: string; error?: string }) => void,
      ): () => void;
      onSpeechEnd(cb: (info: { code: number | null; reason?: string }) => void): () => void;
      /** Absolute path of a dropped File ("" when the drag carried no
       * file on disk). Absent in older builds of the shell. */
      getPathForFile?(file: File): string;
      /** {mic} TCC status: granted|denied|not-determined|unknown. Screen
       * status is deliberately absent — macOS 15+ caches it per-process,
       * so it lies for the whole session after a grant. */
      permStatus(): Promise<{ mic: string }>;
      /** Triggers the macOS microphone prompt; resolves true when granted. */
      permRequestMic(): Promise<boolean>;
      /** Opens System Settings on a privacy pane: mic|screen|speech. */
      permOpenSettings(pane: "mic" | "screen" | "speech"): Promise<boolean>;
      /** Copies an engine install command and opens a blank terminal. False
       * when no terminal could be launched; the clipboard still has it. */
      openInstallTerminal?(command: string): Promise<boolean>;
      /** Open an HTTPS connection/auth link in the default browser. */
      openExternal?(url: string): Promise<boolean>;
      /** Lifecycle of the desk service child process. Asked of the main process
       * because a stopped service cannot answer the HTTP API that would
       * otherwise report its own state. */
      serviceStatus?(): Promise<ServiceLifecycleStatus>;
      /** Ask supervision to try the service again after it gave up. */
      serviceRetry?(): Promise<{ ok: boolean; status: ServiceLifecycleStatus }>;
      /** Start the office service if it is not already running. */
      serviceStart?(): Promise<{ ok: boolean; status: ServiceLifecycleStatus }>;
      /** Explicitly stop the office service. Closing the window never does this. */
      serviceStop?(options?: { ifIdle?: boolean }): Promise<{ ok: boolean; busy?: boolean; status: ServiceLifecycleStatus }>;
      /** Start after sign-in, and keep this computer awake for scheduled work.
       * `set` also reports whether the office has anything scheduled; the
       * office owns that fact, the main process only caches the last report. */
      servicePersistence?: {
        get(): Promise<ServicePersistenceState>;
        set(settings: {
          startOfficeServiceAtLogin?: boolean;
          keepAwakeForSchedules?: boolean;
          scheduleEnabled?: boolean;
        }): Promise<ServicePersistenceState>;
      };
      /** Help and support: shows a save dialog and writes one redacted plain-text
       * report. Resolves with the outcome only, never a path or the contents. */
      saveSupportFile?: () => Promise<unknown>;
      /** Hermios, the office CRM, in its own signed-in view inside this window.
       * Absent in older builds and in a plain browser. */
      hermiosView?: HermiosViewBridge;
      /** In-app auto-update (packaged app only; dormant in dev). onState
       * fires immediately with the current state, then on transitions. */
      updater?: {
        check(): Promise<void>;
        download(): Promise<void>;
        /** quit-and-install the downloaded update; main asks onQueryUnsaved first */
        install(): Promise<void>;
        onState(cb: (s: UpdaterState) => void): () => void;
        /** Holds the automatic restart for 4 hours. Resolves false when main refuses (required, or nothing downloaded). Absent in older builds. */
        later?(): Promise<boolean>;
        /** The countdown's "Not now". Absent in older builds. */
        cancelCountdown?(): Promise<void>;
        /** Clears the "Updated to" or "didn't install" note. Absent in older builds. */
        dismissNote?(): Promise<void>;
        /** Main asks before restarting whether this window holds unsaved work: true =
         * unsaved; throwing or anything but false counts as unsaved. One handler at a
         * time (a newer one replaces it). Returns an unsubscribe. */
        onQueryUnsaved?(handler: () => boolean | Promise<boolean>): () => void;
      };
    };
  }
}

export interface UpdaterState {
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "error";
  version?: string;
  percent?: number;
  message?: string;
  /** Set while a downloaded update waits: Bud busy, the service still stopping or not stoppable, or "Restart now" met an unsaved draft. `message` is main's sentence for it. */
  deferred?: "busy" | "cannot-stop" | "still-running" | "unsaved" | "cannot-record";
  /** How a downloaded update restarts RealBud (docs/UPDATES-2026-10-10.md). Absent from older builds. */
  restart?: UpdaterRestart;
  /** The last install attempt reopened the earlier version. */
  installFailed?: { version: string };
  /** First launch on a new version, shown once. */
  updatedFrom?: { from: string; to: string };
}

export interface UpdaterRestart {
  /** waiting = blocked by unsaved work, a busy service or an approval */
  mode: "when-away" | "countdown" | "waiting";
  /** countdown end, epoch ms */
  at?: number;
  blockedBy?: Array<"unsaved" | "busy" | "approval">;
  /** epoch ms; absent when "Later" isn't holding the restart */
  laterUntil?: number;
  required: boolean;
  requiredReason?: "unsupported" | "waited";
}
