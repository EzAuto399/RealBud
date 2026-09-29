import type { HermesStatus } from "@/state/store";

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
      : unavailable("Model needed", "Connect a model for Bud. Your request stays here while you finish setup.", "Connect a model", "attach-model");
  }
  if (stage === "verify") return { ...unavailable("Check needed", "Run the private readiness check to confirm Bud can answer with this connection.", "Run readiness check"), canVerify: true };
  if (stage === "checking") return unavailable("Checking Bud", "The model connection has not been checked yet. Open setup to refresh its status.", "Check Bud");
  return { ready: true, label: "Bud ready", detail: "Bud can prepare work using the book, files and permitted tools.", action: null, target: "you-worker", canVerify: false };
}


/** Presentation respects who can act; canVerify remains an authoritative fact,
 * never a permission grant. Callers performing checks must also gate access. */
export function budAvailability(status: HermesStatus | null, connected: boolean, recovering = false, context?: { canAdminister: boolean; statusError?: boolean }) {
  const availability = budAvailabilityFacts(status, connected, recovering);
  if (context?.statusError && connected && !recovering) return { ...availability, ready: false, label: "Status unavailable", detail: "Could not refresh Bud’s status. Your draft is kept; status will retry automatically.", action: "View Bud status", target: "you-worker", canVerify: false };
  if (!context || context.canAdminister || availability.ready || !connected || recovering || !status || status.modelAccess?.withdrawn) return availability;
  return {
    ...availability,
    label: availability.label === "Setup needed" ? "Service setup needed" : availability.label,
    action: "View Bud status",
    target: "you-worker",
  };
}

export function budReadinessFailure(status: HermesStatus | null): string | null {
  if (!status || status.ready) return null;
  const lastCheck = status.lastPing ?? (status.lastTest?.kind === "ping" ? status.lastTest : null);
  return lastCheck && !lastCheck.ok
    ? budFacingCopy(lastCheck.detail, "The private readiness check did not finish. A service administrator needs to check the connection.")
    : null;
}


/** Reject partial or malformed status responses before automatic refresh can
 * replace the last authoritative snapshot. Never echo response contents. */
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
    || (value.model !== undefined && (!record(value.model) || typeof value.model.attached !== "boolean" || !nullableString(value.model.provider) || !nullableString(value.model.model)))
    || (value.modelAccess !== undefined && (!record(value.modelAccess) || typeof value.modelAccess.managed !== "boolean" || typeof value.modelAccess.withdrawn !== "boolean" || typeof value.modelAccess.attached !== "boolean" || typeof value.modelAccess.detail !== "string"))
    || !receipt(value.lastPing) || !receipt(value.lastTest)) {
    throw new Error("Bud's status could not be confirmed. Try checking again.");
  }
  return value as unknown as HermesStatus;
}
