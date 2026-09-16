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
    .replace(/~\/\.hermes\b/gi, "Bud's private setup")
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
export function budAvailability(status: HermesStatus | null, connected: boolean, recovering = false) {
  const unavailable = (label: string, detail: string, action: string | null = null, target = "you-worker") =>
    ({ ready: false, label, detail, action, target, canVerify: false });
  if (!connected) return unavailable("Reconnecting", "The local service is reconnecting. Keep drafting; new work can start when the connection returns.");
  if (recovering) return unavailable("Recovery needed", "Restoring the property book when this Mac still has the key. Your draft stays here.", "Unlock book", "you-recovery");
  if (!status) return unavailable("Checking Bud", "Checking Bud's setup. You can prepare your request while this finishes.");
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
    if (status.cli.installed && !(status.cli.compatible ?? status.cli.matchesPin)) {
      return unavailable(
        "Bud update blocked",
        budFacingCopy(status.detail, "Bud’s worker moved past the build RealBud supports. Restore the supported build before starting work."),
        "Restore Bud",
      );
    }
    return unavailable("Setup needed", "Finish Bud's installation before starting work. You can prepare your request now.", status.cli.installed ? "Check Bud setup" : "Set up Bud");
  }
  if (stage === "safeguards") return unavailable("Setup needed", "Finish Bud's private workroom and property safeguards before starting work.", "Finish Bud setup");
  if (stage === "model") return unavailable("Model needed", "Connect a model for Bud. Your request stays here while you finish setup.", "Connect a model", "attach-model");
  if (stage === "verify") return { ...unavailable("Check needed", "Run the private readiness check to confirm Bud can answer with this connection.", "Run readiness check"), canVerify: true };
  if (stage === "checking") return unavailable("Checking Bud", "The model connection has not been checked yet. Open setup to refresh its status.", "Check Bud");
  return { ready: true, label: "Bud ready", detail: "Bud can prepare work using the book, files and permitted tools.", action: null, target: "you-worker", canVerify: false };
}
