import type { BudAutoSetup, HermesStatus } from "@/state/store";
import { isManagedModelChoice, type ManagedModelChoiceId } from "@shared/managed-model-choices";

export type BudSetupStage = "checking" | "install" | "safeguards" | "model" | "verify" | "ready";
export type BudSetupStep = Exclude<BudSetupStage, "checking" | "ready">;
export type BudSetupStepState = "complete" | "current" | "upcoming";

export interface BudSetupInput {
  statusLoaded: boolean;
  workerInstalled: boolean;
  workerPinned: boolean;
  safeguardsInstalled: boolean;
  approvalsManual: boolean;
  workroomReady: boolean;
  modelChecked: boolean;
  modelAttached: boolean;
  verified: boolean;
}

export interface BudSetupJourney {
  stage: BudSetupStage;
  completed: number;
  total: number;
  stepState: Record<BudSetupStep, BudSetupStepState>;
}

export const BUD_SETUP_STEPS: BudSetupStep[] = ["install", "safeguards", "model", "verify"];

/** Keeps upstream implementation vocabulary out of the office-facing setup
 * surface while preserving the useful part of a bounded error. */
export function budFacingCopy(value: unknown, fallback: string): string {
  const raw = value instanceof Error ? value.message : typeof value === "string" ? value : "";
  if (!raw.trim()) return fallback;
  return raw
    .replace(/(?:~[\\/]|[A-Za-z]:[\\/]|[\\/])(?:[^\n\\/"'<>()[\]{};,:!?]+[\\/])*\.hermes(?:[\\/][^\s"'<>()[\]{};,:!?]*)?/gi, "Bud's private setup")
    .replace(/\.hermes\b/gi, "Bud's private setup")
    .replace(/Hermes Agent/gi, "Bud")
    .replace(/Hermes CLI/gi, "Bud")
    .replace(/\bHermes\b/gi, "Bud")
    .replace(/\bCLI\b/g, "worker")
    .replace(/property pack/gi, "Bud's hands safeguards")
    .replace(/"property" pack/gi, "Bud's hands safeguards")
    .replace(/property profile/gi, "Bud's hands")
    .replace(/\bpack\b/gi, "safeguards")
    .replace(/\bprofile\b/gi, "private setup")
    .replace(/\bpin\b/gi, "supported build");
}

/**
 * Maps authoritative worker facts to the one setup decision the PM should see.
 * The order is deliberate: later controls stay unavailable until the boundary
 * they depend on has been proved. A successful hands check is authoritative
 * evidence that all earlier steps worked, even while model metadata reloads.
 */
export function budSetupJourney(input: BudSetupInput): BudSetupJourney {
  const workerReady = input.workerInstalled && input.workerPinned;
  const safeguardsReady = input.safeguardsInstalled && input.approvalsManual && input.workroomReady;

  let stage: BudSetupStage;
  if (!input.statusLoaded) stage = "checking";
  else if (!workerReady) stage = "install";
  else if (!safeguardsReady) stage = "safeguards";
  else if (input.verified) stage = "ready";
  else if (!input.modelChecked) stage = "checking";
  else if (!input.modelAttached) stage = "model";
  else stage = "verify";

  const checks = input.statusLoaded
    ? [workerReady, safeguardsReady, input.modelChecked && input.modelAttached, input.verified]
    : [false, false, false, false];
  let completed = 0;
  for (const ready of checks) {
    if (!ready) break;
    completed += 1;
  }
  if (stage === "ready") completed = BUD_SETUP_STEPS.length;

  const currentIndex = stage === "ready" ? BUD_SETUP_STEPS.length : BUD_SETUP_STEPS.indexOf(stage as BudSetupStep);
  const stepState = Object.fromEntries(
    BUD_SETUP_STEPS.map((step, index) => [
      step,
      stage === "ready" || index < completed ? "complete" : index === currentIndex ? "current" : "upcoming",
    ]),
  ) as Record<BudSetupStep, BudSetupStepState>;

  return { stage, completed, total: BUD_SETUP_STEPS.length, stepState };
}

const AUTO_SETUP_STATES: BudAutoSetup["state"][] = ["idle", "installing", "verifying", "ready", "waiting_retry", "held"];
const AUTO_SETUP_CODES: NonNullable<BudAutoSetup["code"]>[] = ["checking", "installing", "safeguards", "model", "readiness", "ready", "retry",
  "held_exhausted", "held_failed", "held_recovery", "held_restart", "held_unavailable"];

/** A hold that pressing Try again can clear (the server re-checks the link). */
export function budAutoSetupRetryable(status: HermesStatus | null): boolean {
  const code = status?.autoSetup?.state === "held" ? status.autoSetup.code : undefined;
  return !status?.ready && (code === "held_exhausted" || code === "held_failed" || (!!status && managedIdle(status)));
}
/** Managed and not ready, with automatic setup neither running nor holding. */
function managedIdle(status: HermesStatus): boolean {
  const state = status.autoSetup?.state;
  return !status.ready && !status.modelAccess?.withdrawn && Boolean(status.modelAccess?.managed) && (state === "idle" || state === "ready");
}

// Installer detail is not a log surface. Only these fixed server product
// phrases may become visible progress, shown through this display map; paths
// and upstream output fall back to the known setup code. Keys stay aligned
// with worker-bootstrap's stage labels.
const INSTALL_PHASES: Record<string, string> = {
  "Downloading verified setup": "downloading", "Preparing this computer": "preparing this computer", "Downloading Bud": "downloading",
  "Installing Bud’s components": "installing", "Finishing setup": "finishing", "Installing Bud": "installing",
  "Checking already downloaded Bud": "checking the download",
};
const SETUP_PHASES: Partial<Record<NonNullable<BudAutoSetup["code"]>, string>> = {
  checking: "checking this computer", installing: "installing",
  safeguards: "turning on approvals", model: "connecting your office’s AI",
  readiness: "testing Bud",
};
const SETUP_HOLDS: Partial<Record<NonNullable<BudAutoSetup["code"]>, string>> = {
  held_exhausted: "Bud couldn’t finish setting up on this computer. RealBud support has the details; try again later.",
  held_failed: "Bud’s setup didn’t finish. Nothing was lost. Press Try setup again; if it stops twice, tell your office owner.",
  held_recovery: "Bud’s setup record needs recovery. Your files are kept; contact RealBud support.",
  held_restart: "Bud’s update is installed. Restart RealBud to use it.",
  held_unavailable: "Automatic Bud setup is not available on this computer yet.",
};
// A fixed phrase, not a measurement: keep the word "usually".
const SETUP_ESTIMATE = "Usually about 10 minutes.";
const NOTHING_TO_DO = "Nothing to do; keep RealBud open.";

/** Office-facing names for the four setup checks, shared by every Bud setup surface. */
export const BUD_SETUP_STEP_LABELS: Record<BudSetupStep, string> = {
  install: "Download Bud", safeguards: "Turn on approvals", model: "Connect your office’s AI", verify: "Test Bud",
};

function setupPhase(auto: BudAutoSetup): string {
  if (auto.state === "installing" && Object.prototype.hasOwnProperty.call(INSTALL_PHASES, auto.detail)) return INSTALL_PHASES[auto.detail]!;
  if (auto.code && SETUP_PHASES[auto.code]) return SETUP_PHASES[auto.code]!;
  // Earlier services did not send codes. Their fixed four-step position is a
  // useful fallback, but arbitrary detail is never treated as product copy.
  return auto.step === 2 ? SETUP_PHASES.safeguards! : auto.step === 3 ? SETUP_PHASES.model!
    : auto.step === 4 ? SETUP_PHASES.readiness! : auto.state === "installing" ? SETUP_PHASES.installing! : SETUP_PHASES.checking!;
}

/**
 * What automatic setup (after this computer was linked and approved) is doing,
 * for everyone — no administrator is needed for it. Null when it is not
 * running or Bud is already ready. `working` means nothing is needed from the
 * person; a hold carries the existing product copy of what stopped it.
 */
export function budAutoSetupView(status: HermesStatus | null, now = Date.now()): { label: string; detail: string; working: boolean } | null {
  const auto = status?.autoSetup;
  if (!status || !auto || status.ready || status.modelAccess?.withdrawn) return null;
  if (auto.state === "installing" || auto.state === "verifying") {
    const phase = setupPhase(auto);
    const where = auto.step > 0 && auto.total >= auto.step ? `Step ${auto.step} of ${auto.total}: ${phase}` : phase[0]!.toUpperCase() + phase.slice(1);
    return { label: "Setting up Bud", detail: `${where}. ${SETUP_ESTIMATE} ${NOTHING_TO_DO}`, working: true };
  }
  if (auto.state === "waiting_retry") {
    const minutes = auto.nextRetryAt ? Math.max(1, Math.round((auto.nextRetryAt - now) / 60_000)) : null;
    return {
      label: "Setting up Bud",
      detail: `Bud’s setup paused and will try again ${minutes ? `in about ${minutes} minute${minutes === 1 ? "" : "s"}` : "shortly"}. ${NOTHING_TO_DO}`,
      working: true,
    };
  }
  if (auto.state === "held") return { label: "Bud setup stopped", detail: (auto.code && SETUP_HOLDS[auto.code]) || "Bud’s setup could not finish. Contact RealBud support.", working: false };
  // A linked office whose grant is in force, with no setup run in progress:
  // never an administrator dead end. The person can ask the service to run
  // its own check again (the server re-checks the link).
  if (managedIdle(status)) {
    return { label: "Bud needs a check", detail: "Bud’s last check no longer matches this computer’s setup. Try setup again; if it keeps stopping, contact RealBud support.", working: false };
  }
  return null;
}

/** One dependency-ordered description for Ask and Schedule. A workroom alone
 * never proves an installed worker, model connection or permission to run. */
function budAvailabilityFacts(status: HermesStatus | null, connected: boolean, recovering = false) {
  const unavailable = (label: string, detail: string, action: string | null = null, target = "you-worker") =>
    ({ ready: false, label, detail, action, target, canVerify: false });
  if (!connected) return unavailable("Reconnecting", "The local service is reconnecting. Keep drafting; new work can start when the connection returns.");
  if (recovering) return unavailable("Recovery needed", "Restoring the property book when its saved key is available. Your draft stays here.", "Unlock book", "you-recovery");
  if (!status) return unavailable("Checking Bud", "Checking Bud's setup. You can prepare your request while this finishes.");
  // A withdrawn service grant is its own hold: nothing on this computer is
  // broken, no key can fix it, and every saved record stays readable.
  if (status.modelAccess?.withdrawn) {
    return unavailable("Model access withdrawn", status.modelAccess.detail, null);
  }
  // Automatic setup after an approved link comes first: an unsupported
  // personal worker's probe miss is not a dead end while it runs.
  const automatic = budAutoSetupView(status);
  if (automatic) return { ...unavailable(automatic.label, automatic.detail), automatic: true };
  if (status.cli.probeState === "timeout" || status.cli.probeState === "error") {
    return unavailable("Check Bud", "Bud's last setup check did not finish. Check the connection before trying new work.", "Check Bud");
  }
  const { stage } = budSetupJourney({
    statusLoaded: true,
    workerInstalled: status.cli.installed && !status.bootstrapPending,
    workerPinned: status.cli.compatible ?? status.cli.matchesPin,
    safeguardsInstalled: status.pack.installed,
    approvalsManual: status.pack.approvalsManual,
    workroomReady: status.pack.workroomReady,
    modelChecked: Boolean(status.model),
    modelAttached: Boolean(status.model?.attached),
    verified: status.ready,
  });
  if (stage === "install") {
    if (status.restartRequired) {
      return unavailable("Restart to finish update", "Bud’s update is installed. Quit and reopen RealBud to start using it. Your draft is kept.");
    }
    if (status.cli.installed && !(status.cli.compatible ?? status.cli.matchesPin)) {
      return unavailable(
        "Bud update blocked",
        budFacingCopy(status.detail, "Bud’s worker moved past the build RealBud supports. Restore the supported build before starting work."),
        "Restore Bud",
      );
    }
    return unavailable("Setup needed", "Finish Bud's installation before starting work. You can prepare your request now.", status.cli.installed ? "Check Bud setup" : "Set up Bud");
  }
  if (stage === "safeguards") {
    const missing = !status.pack.installed ? "Property safeguards are not installed."
      : !status.pack.approvalsManual ? "Manual approval safeguards are not active."
      : "Bud's private workroom is not ready.";
    return unavailable("Setup needed", `${missing} Your draft stays here while setup is completed.`, "Finish Bud setup");
  }
  if (stage === "model") {
    return status.modelAccess?.managed
      ? unavailable("Model choice needed", status.modelAccess.detail, "Choose a model", "attach-model")
      : unavailable("Not connected yet", "Connect this computer to your office on realbud.app to give Bud its AI access. Your request stays here while you finish setup.", "Connect to your office", "attach-model");
  }
  if (stage === "verify") return { ...unavailable("Check needed", "Run the private readiness check to confirm Bud can answer with this connection.", "Run readiness check"), canVerify: true };
  if (stage === "checking") return unavailable("Checking Bud", "The model connection has not been checked yet. Open setup to refresh its status.", "Check Bud");
  return { ready: true, label: "Bud ready", detail: "Bud can prepare work using the book, files and permitted tools.", action: null, target: "you-worker", canVerify: false };
}


/** Presentation respects who can act; canVerify remains an authoritative fact,
 * never a permission grant. Callers performing checks must also gate access. */
export function budAvailability(status: HermesStatus | null, connected: boolean, recovering = false, context?: { canAdminister: boolean; statusError?: boolean; officeLink?: "linked" | "not-linked" | "unavailable" }) {
  const availability = budAvailabilityFacts(status, connected, recovering);
  if (context?.statusError && connected && !recovering) return { ...availability, ready: false, label: "Status unavailable", detail: "Could not refresh Bud’s status. Your draft is kept; status will retry automatically.", action: "View Bud status", target: "you-worker", canVerify: false };
  if (!context || context.canAdminister || availability.ready || !connected || recovering || !status || status.modelAccess?.withdrawn) return availability;
  // Same hold Bud status shows: before an office link nothing can install, so
  // the next step is connecting, not finishing setup. A failed check stays itself.
  if (context.officeLink === "not-linked" && !status.modelAccess?.managed && !("automatic" in availability) && status.cli.probeState !== "timeout" && status.cli.probeState !== "error") {
    return { ...availability, label: "Connect this computer to your office first", detail: "Paste the link code your office owner sent you. RealBud then sets up Bud automatically. Your draft stays here.", action: "Connect this computer", target: "you-worker" };
  }
  // Automatic setup needs nobody; only a hold points at Bud's status.
  if ("automatic" in availability) return budAutoSetupView(status)?.working ? availability : { ...availability, action: "View Bud status", target: "you-worker" };
  return {
    ...availability,
    label: availability.label === "Setup needed" ? "Service setup needed" : availability.label,
    action: "View Bud status",
    target: "you-worker",
  };
}

// Display map for fixed server receipts (server/index.ts writes this one when
// a setup run starts): plain words on the office-facing surfaces.
const READINESS_DETAILS: Record<string, string> = Object.assign(Object.create(null), {
  "Bud setup changed. Its private readiness check is still needed.": "Bud’s setup didn’t finish. Nothing was lost. Press Try setup again in Bud status.",
});

export function budReadinessFailure(status: HermesStatus | null): string | null {
  if (!status || status.ready) return null;
  const lastCheck = status.lastPing ?? (status.lastTest?.kind === "ping" ? status.lastTest : null);
  if (lastCheck && !lastCheck.ok && READINESS_DETAILS[lastCheck.detail]) return READINESS_DETAILS[lastCheck.detail]!;
  return lastCheck && !lastCheck.ok
    ? budFacingCopy(lastCheck.detail, "The private readiness check did not finish. A service administrator needs to check the connection.")
    : null;
}


/** Reject partial or malformed status responses before automatic refresh can
 * replace the last authoritative snapshot. Never echo response contents. */
export const BUD_DOCUMENT_TOOLS_STATES = ["ready", "needs_repair", "unavailable_here", "unknown"] as const;
export type BudDocumentToolsState = typeof BUD_DOCUMENT_TOOLS_STATES[number];
/** Word/Excel/PDF libraries in Bud's runtime; only `needs_repair` is something Repair fixes. */
export function budDocumentToolsNeedRepair(status: unknown): boolean {
  return !!status && typeof status === "object" && (status as { documentTools?: unknown }).documentTools === "needs_repair";
}

export function parseBudStatus(value: unknown): HermesStatus {
  const record = (input: unknown): input is Record<string, unknown> => !!input && typeof input === "object" && !Array.isArray(input);
  const nullableString = (input: unknown) => input === null || typeof input === "string";
  const receipt = (input: unknown) => input == null || (record(input) && typeof input.ok === "boolean" && typeof input.detail === "string"
    && typeof input.at === "number" && Number.isFinite(input.at) && ["ping", "recheck"].includes(String(input.kind)));
  if (!record(value) || !record(value.cli) || !record(value.pack) || !record(value.pin)
    || ![value.pin.product, value.pin.tag, value.pin.commit, value.pin.profile, value.homeDir, value.profileDir, value.signInCommand].every(item => typeof item === "string")
    || !nullableString(value.installCommand) || !nullableString(value.cli.versionText)
    || (value.installerAvailable !== undefined && typeof value.installerAvailable !== "boolean")
    || (value.handsLabel !== undefined && typeof value.handsLabel !== "string")
    || typeof value.ready !== "boolean" || typeof value.detail !== "string"
    || typeof value.cli.installed !== "boolean" || typeof value.cli.matchesPin !== "boolean"
    || (value.cli.compatible !== undefined && typeof value.cli.compatible !== "boolean")
    || (value.cli.probeState !== undefined && !["ok", "missing", "timeout", "error"].includes(String(value.cli.probeState)))
    || ![value.pack.installed, value.pack.approvalsManual, value.pack.workroomReady].every(flag => typeof flag === "boolean")
    || (value.bootstrapPending !== undefined && typeof value.bootstrapPending !== "boolean")
    || (value.restartRequired !== undefined && typeof value.restartRequired !== "boolean")
    || (value.model !== undefined && (!record(value.model) || typeof value.model.attached !== "boolean" || !nullableString(value.model.provider) || !nullableString(value.model.model)
      || (value.model.choice !== undefined && value.model.choice !== null && !isManagedModelChoice(value.model.choice))))
    || (value.modelAccess !== undefined && (!record(value.modelAccess) || typeof value.modelAccess.managed !== "boolean" || typeof value.modelAccess.withdrawn !== "boolean" || typeof value.modelAccess.attached !== "boolean" || typeof value.modelAccess.detail !== "string"))
    || (value.autoSetup !== undefined && (!record(value.autoSetup) || !AUTO_SETUP_STATES.includes(value.autoSetup.state as BudAutoSetup["state"])
      || ![value.autoSetup.step, value.autoSetup.total].every(item => Number.isInteger(item) && (item as number) >= 0 && (item as number) <= 20)
      || typeof value.autoSetup.detail !== "string"
      || (value.autoSetup.code !== undefined && !AUTO_SETUP_CODES.includes(value.autoSetup.code as NonNullable<BudAutoSetup["code"]>))
      || (value.autoSetup.nextRetryAt !== undefined && (typeof value.autoSetup.nextRetryAt !== "number" || !Number.isFinite(value.autoSetup.nextRetryAt)))))
    || (value.documentTools !== undefined && !BUD_DOCUMENT_TOOLS_STATES.includes(value.documentTools as BudDocumentToolsState))
    || !receipt(value.lastPing) || !receipt(value.lastTest)) {
    throw new Error("Bud's status could not be confirmed. Try checking again.");
  }
  return value as unknown as HermesStatus;
}

/** `GET/POST /api/hermes/model` reply. Managed-only: a choice is one of the
 * three ids or null, and the server never returns a key. */
export interface ManagedModelStatus {
  provider: string | null;
  model: string | null;
  choice: ManagedModelChoiceId | null;
  keyPresent: boolean;
  keyHint: string | null;
  managed: boolean;
  managedWithdrawn?: boolean;
}

export function parseManagedModelStatus(value: unknown): ManagedModelStatus {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const nullableString = (input: unknown) => input === null || typeof input === "string";
  if (!row || !nullableString(row.provider) || !nullableString(row.model) || !nullableString(row.keyHint)
    || !(row.choice === null || isManagedModelChoice(row.choice))
    || typeof row.keyPresent !== "boolean" || typeof row.managed !== "boolean"
    || (row.managedWithdrawn !== undefined && typeof row.managedWithdrawn !== "boolean")) {
    throw new Error("Bud's model choice could not be confirmed. Try checking again.");
  }
  return {
    provider: row.provider as string | null, model: row.model as string | null, choice: row.choice as ManagedModelChoiceId | null,
    keyPresent: row.keyPresent, keyHint: row.keyHint as string | null, managed: row.managed,
    ...(row.managedWithdrawn !== undefined ? { managedWithdrawn: row.managedWithdrawn as boolean } : {}),
  };
}
