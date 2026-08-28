export const ONBOARDING_COMPLETE_KEY = "realbud.onboarding.complete.v1";
export const SETUP_JOURNEY_PENDING_KEY = "realbud.setup-journey.pending.v1";
export const SETUP_JOURNEY_EVENT = "realbud:setup-journey";
export const WORKER_VERIFICATION_KEY = "realbud.worker-verification.v1";
export const WORKER_VERIFICATION_EVENT = "realbud:worker-verification";
export const RECOVERY_KEY_SAVED_KEY = "realbud.recovery-key-saved";
export const RECOVERY_KEY_SAVED_EVENT = "realbud:recovery-key-saved";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface WorkerModelStatus {
  provider: string | null;
  model: string | null;
  keyPresent: boolean;
  keyHint?: string | null;
}

export interface WorkerSetupStatus {
  ready: boolean;
  pin: { product: string; tag: string };
  cli?: {
    installed?: boolean;
    matchesPin?: boolean;
    installId?: string | null;
  } | null;
  pack?: {
    installed: boolean;
    approvalsManual: boolean;
  } | null;
  model?: WorkerModelStatus | null;
  runtimeRecovery?: { action?: string | null } | null;
  modelRecovery?: { action?: string | null } | null;
}

export type WorkerSetupOperation = "checking" | "install" | "pack" | "model" | "test" | "done";

export type GoLiveStepState = "done" | "action" | "checking" | "held" | "optional";

export interface GoLiveStep {
  id: "book" | "worker" | "agency";
  title: string;
  detail: string;
  state: GoLiveStepState;
}

export interface GoLiveReadiness {
  complete: boolean;
  requiredDone: number;
  requiredTotal: 2;
  /** The PM journey is deliberately ordered: prepare Bud first, then bring
   * in the portfolio. Agency naming remains optional. */
  steps: [GoLiveStep, GoLiveStep, GoLiveStep];
}

export type SetupGuideItemId = "agency" | "computer-use" | "recovery" | "reminders" | "connections";

export interface SetupGuideItem {
  id: SetupGuideItemId;
  title: string;
  status: string;
  detail: string;
  state: GoLiveStepState;
}

export interface PocketGuideStatus {
  pilotReady: boolean;
  connectedCount: number;
  state: "off" | "pilot-gated" | "setup-required" | "connecting" | "ready" | "attention";
}

function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function onboardingComplete(storage: StorageLike | null = browserStorage()): boolean {
  try {
    return storage?.getItem(ONBOARDING_COMPLETE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markOnboardingComplete(storage: StorageLike | null = browserStorage()): void {
  try {
    storage?.setItem(ONBOARDING_COMPLETE_KEY, "1");
  } catch {
    // A blocked preference store must not strand the PM outside the app.
  }
}

/**
 * The setup journey is presentation state only. Its current screen is always
 * derived from server-owned worker, book and recovery truth. Persisting only a
 * pending bit lets a partially completed first run resume without ever
 * promoting a runtime, model or book to ready.
 */
export function setupJourneyPending(storage: StorageLike | null = browserStorage()): boolean {
  try {
    return storage?.getItem(SETUP_JOURNEY_PENDING_KEY) === "1";
  } catch {
    return false;
  }
}

export function setSetupJourneyPending(
  pending: boolean,
  storage: StorageLike | null = browserStorage(),
): void {
  try {
    if (pending) storage?.setItem(SETUP_JOURNEY_PENDING_KEY, "1");
    else storage?.removeItem(SETUP_JOURNEY_PENDING_KEY);
  } catch {
    // A blocked preference store must not trap the PM in setup or grant any
    // capability. The live readiness owners remain authoritative.
  }
  try {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(SETUP_JOURNEY_EVENT, { detail: { pending } }));
    }
  } catch {
    // Same-window presentation refresh is best effort.
  }
}

export function recoveryKeySaved(storage: StorageLike | null = browserStorage()): boolean {
  try {
    return storage?.getItem(RECOVERY_KEY_SAVED_KEY) === "1";
  } catch {
    return false;
  }
}

export function recordRecoveryKeySaved(
  saved: boolean,
  storage: StorageLike | null = browserStorage(),
): void {
  try {
    if (saved) storage?.setItem(RECOVERY_KEY_SAVED_KEY, "1");
    else storage?.removeItem(RECOVERY_KEY_SAVED_KEY);
  } catch {
    // This is a PM acknowledgement used only for guidance. A blocked
    // preference store must never expose the key or block the desk.
  }
  try {
    if (typeof window !== "undefined") window.dispatchEvent(new Event(RECOVERY_KEY_SAVED_EVENT));
  } catch {
    // The same-window refresh is best effort; storage remains authoritative.
  }
}

export function workerFingerprint(status: WorkerSetupStatus | null): string | null {
  const provider = status?.model?.provider?.trim();
  const model = status?.model?.model?.trim();
  if (!status?.ready || !status.model?.keyPresent || !provider || !model) return null;
  return [status.pin.product, status.pin.tag, status.cli?.installId ?? "legacy-install", provider, model].join("|");
}

export function workerVerified(
  status: WorkerSetupStatus | null,
  storage: StorageLike | null = browserStorage(),
): boolean {
  const fingerprint = workerFingerprint(status);
  if (!fingerprint) return false;
  try {
    const raw = storage?.getItem(WORKER_VERIFICATION_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw) as { fingerprint?: unknown };
    return saved.fingerprint === fingerprint;
  } catch {
    return false;
  }
}

export function recordWorkerVerification(
  status: WorkerSetupStatus | null,
  ok: boolean,
  storage: StorageLike | null = browserStorage(),
): void {
  try {
    const fingerprint = ok ? workerFingerprint(status) : null;
    if (!fingerprint) {
      storage?.removeItem(WORKER_VERIFICATION_KEY);
      return;
    }
    storage?.setItem(WORKER_VERIFICATION_KEY, JSON.stringify({ fingerprint, at: Date.now() }));
  } catch {
    // Verification only controls setup copy; it never grants authority.
  }
}

export function agencyIsNamed(name: string | null | undefined): boolean {
  const value = name?.trim() ?? "";
  return Boolean(value) && !/^realbud demo book$/i.test(value) && !/^demo agency$/i.test(value);
}

export function setupGuideItems(input: {
  agencyName?: string | null;
  recoveryActive: boolean;
  recoverySaved: boolean;
  desktopReady: boolean;
  desktop: DesktopCapabilities;
  remindersAvailable: boolean;
  remindersOn: boolean;
  pocket?: PocketGuideStatus | null;
}): SetupGuideItem[] {
  const agencyNamed = agencyIsNamed(input.agencyName);
  const computer = input.desktop.localComputer;
  const permissionNeeded = new Set([
    "cua-accessibility-and-screen-required",
    "cua-accessibility-required",
    "cua-screen-recording-required",
  ]).has(computer.reasonCode ?? "");

  let computerItem: SetupGuideItem;
  if (!input.desktopReady) {
    computerItem = {
      id: "computer-use",
      title: "Computer use",
      status: "Checking",
      detail: "Checking RealBud's private runtime on this computer.",
      state: "checking",
    };
  } else if (computer.available) {
    computerItem = {
      id: "computer-use",
      title: "Computer use",
      status: "Ready",
      detail: "The private runtime and required macOS permissions are ready for approved browser work.",
      state: "done",
    };
  } else if (input.desktop.host.platform !== "darwin") {
    computerItem = {
      id: "computer-use",
      title: "Computer use",
      status: input.desktop.host.label === "Browser" ? "Desktop app" : "macOS pilot",
      detail: "This does not block Desk, Ask, Schedule or selected-file intake.",
      state: "optional",
    };
  } else if (computer.reasonCode === "cua-bundle-missing") {
    computerItem = {
      id: "computer-use",
      title: "Computer use",
      status: "Repair needed",
      detail: "The RealBud-owned runtime is missing. A personal automation install will not be reused.",
      state: "held",
    };
  } else if (permissionNeeded) {
    computerItem = {
      id: "computer-use",
      title: "Computer use",
      status: "Permissions needed",
      detail: "Open the guided Accessibility and Screen & System Audio Recording steps in You.",
      state: "action",
    };
  } else if (computer.reasonCode === "cua-not-enabled" || computer.reasonCode === "package-smoke-disabled") {
    computerItem = {
      id: "computer-use",
      title: "Computer use",
      status: computer.runtime === "bundled" ? "Included" : "Optional",
      detail: "Set it up when you want approved portal work. No permission is requested until you choose Set up.",
      state: "optional",
    };
  } else {
    computerItem = {
      id: "computer-use",
      title: "Computer use",
      status: "Needs attention",
      detail: "Review the private runtime status in You. The rest of RealBud remains available.",
      state: "held",
    };
  }

  const recoveryItem: SetupGuideItem = input.recoveryActive
    ? {
        id: "recovery",
        title: "Recovery",
        status: "Book locked",
        detail: "Open Recovery to restore the quarantined book before another write.",
        state: "held",
      }
    : input.recoverySaved
      ? {
          id: "recovery",
          title: "Recovery",
          status: "Marked saved",
          detail: "This Mac records only your acknowledgement, never the recovery key itself.",
          state: "done",
        }
      : {
          id: "recovery",
          title: "Recovery",
          status: "Save a copy",
          detail: "Recommended before live work. Store the key somewhere separate from this Mac.",
          state: "optional",
        };

  const remindersItem: SetupGuideItem = input.remindersAvailable
    ? input.remindersOn
      ? {
          id: "reminders",
          title: "Reminders",
          status: "On",
          detail: "Private alerts may open Desk or Schedule after failed or held routine work.",
          state: "done",
        }
      : {
          id: "reminders",
          title: "Reminders",
          status: "Optional",
          detail: "Turn on privacy-safe alerts for failed, missed or held routine work.",
          state: "optional",
        }
    : {
        id: "reminders",
        title: "Reminders",
        status: "Desktop app",
        detail: "Reminder setup appears in the installed desktop app.",
        state: "optional",
      };

  let connectionsItem: SetupGuideItem;
  if (!input.pocket) {
    connectionsItem = {
      id: "connections",
      title: "Inbox/Pocket",
      status: "Checking",
      detail: "Reading the app-owned pilot connection state.",
      state: "checking",
    };
  } else if (input.pocket.connectedCount > 0) {
    connectionsItem = {
      id: "connections",
      title: "Inbox/Pocket",
      status: `${input.pocket.connectedCount} mobile ready`,
      detail: "Pocket uses the same Ask thread. Mail and calendar remain separately pilot-gated until their named adapter is approved.",
      state: "done",
    };
  } else if (input.pocket.state === "attention") {
    connectionsItem = {
      id: "connections",
      title: "Inbox/Pocket",
      status: "Needs attention",
      detail: "Review the exact PM channel state in Connections. No message is accepted while setup is uncertain.",
      state: "held",
    };
  } else if (input.pocket.pilotReady) {
    connectionsItem = {
      id: "connections",
      title: "Inbox/Pocket",
      status: "Pocket available",
      detail: "Connect one named PM channel in You. Mail and calendar still wait for the named read-only pilot adapter.",
      state: "optional",
    };
  } else {
    connectionsItem = {
      id: "connections",
      title: "Inbox/Pocket",
      status: "Pilot-gated",
      detail: "The requirements are visible now; credential controls stay hidden until a real agency and PM are named.",
      state: "optional",
    };
  }

  return [
    {
      id: "agency",
      title: "Agency",
      status: agencyNamed ? "Saved" : "Optional",
      detail: agencyNamed
        ? `${input.agencyName!.trim()} is attached to this local book.`
        : "Name the agency when you move beyond the labelled practice book.",
      state: agencyNamed ? "done" : "optional",
    },
    computerItem,
    recoveryItem,
    remindersItem,
    connectionsItem,
  ];
}

export function workerSetupStep(input: {
  worker: WorkerSetupStatus | null;
  workerIsVerified: boolean;
}): GoLiveStep {
  const fingerprint = workerFingerprint(input.worker);
  if (!input.worker) {
    return {
      id: "worker",
      title: "Checking Bud",
      detail: "Checking Bud's private setup on this computer…",
      state: "checking",
    };
  }
  if (!input.worker.ready) {
    return {
      id: "worker",
      title: "Prepare Bud",
      detail: "RealBud will prepare Bud's private runtime and safety setup in the background.",
      state: "action",
    };
  }
  if (!fingerprint) {
    return {
      id: "worker",
      title: "Connect Bud's model",
      detail: "Choose a provider and model in the secure form. Your key never goes into chat.",
      state: "action",
    };
  }
  if (!input.workerIsVerified) {
    return {
      id: "worker",
      title: "Check Bud can answer",
      detail: "Run one short private check before Ask Bud is marked ready.",
      state: "action",
    };
  }
  return {
    id: "worker",
    title: "Bud is ready",
    detail: "Bud's private setup and selected model passed the live check.",
    state: "done",
  };
}

/** Return the one setup operation RealBud should own next. This keeps the UI
 * resumable after a reload or partial install without making the PM diagnose
 * runtime versus pack state. Every operation still runs through its existing
 * server-side lease and transactional owner. */
export function nextWorkerSetupOperation(input: {
  worker: WorkerSetupStatus | null;
  workerIsVerified: boolean;
}): WorkerSetupOperation {
  const worker = input.worker;
  if (!worker) return "checking";

  if (worker.runtimeRecovery?.action === "attention") return "install";
  if (!worker.ready) {
    if (!worker.cli?.installed || worker.cli.matchesPin === false) return "install";
    return "pack";
  }
  if (worker.modelRecovery?.action === "attention") return "model";
  if (!workerFingerprint(worker)) return "model";
  if (!input.workerIsVerified) return "test";
  return "done";
}

export function goLiveReadiness(input: {
  mode: "demo" | "live";
  recoveryActive: boolean;
  worker: WorkerSetupStatus | null;
  workerIsVerified: boolean;
  agencyName?: string | null;
}): GoLiveReadiness {
  const bookDone = input.mode === "live" && !input.recoveryActive;
  const worker = workerSetupStep({ worker: input.worker, workerIsVerified: input.workerIsVerified });
  const workerDone = worker.state === "done";
  const agencyDone = agencyIsNamed(input.agencyName);

  const book: GoLiveStep = input.recoveryActive
    ? {
        id: "book",
        title: "Verify your live property book",
        detail: "Paused while Desk recovery protects the current book.",
        state: "held",
      }
    : bookDone
      ? {
          id: "book",
          title: "Live property book verified",
          detail: "A matched current PMS export is attached to Desk.",
          state: "done",
        }
      : {
          id: "book",
          title: "Verify the live book",
          detail: "A practice book can already be on Desk. Import a current PMS export to verify live balances. Files or a pasted list stay practice until that export matches.",
          state: "action",
        };

  const agency: GoLiveStep = agencyDone
    ? {
        id: "agency",
        title: input.agencyName!.trim(),
        detail: "Agency name saved to this local book.",
        state: "done",
      }
    : {
        id: "agency",
        title: "Name your agency",
        detail: "Optional. Your system timezone and AUD defaults already apply.",
        state: "optional",
      };

  const requiredDone = Number(bookDone) + Number(workerDone);
  return {
    complete: requiredDone === 2,
    requiredDone,
    requiredTotal: 2,
    steps: [worker, book, agency],
  };
}
