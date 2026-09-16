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

  interface Window {
    ogb?: {
      platform: NodeJS.Platform;
      getCapabilities(): Promise<DesktopCapabilities>;
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
      serviceStop?(): Promise<{ ok: boolean; status: ServiceLifecycleStatus }>;
      /** In-app auto-update (packaged app only; dormant in dev). onState
       * fires immediately with the current state, then on transitions. */
      updater?: {
        check(): Promise<void>;
        download(): Promise<void>;
        /** quit-and-install the downloaded update */
        install(): Promise<void>;
        onState(cb: (s: UpdaterState) => void): () => void;
      };
    };
  }
}

export interface UpdaterState {
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "error";
  version?: string;
  percent?: number;
  message?: string;
}
