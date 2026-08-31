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
    .replace(/Hermes Agent/gi, "Bud")
    .replace(/Hermes CLI/gi, "Bud")
    .replace(/\bHermes\b/gi, "Bud")
    .replace(/\bCLI\b/g, "worker")
    .replace(/property pack/gi, "property safeguards")
    .replace(/\bpack\b/gi, "safeguards")
    .replace(/\bprofile\b/gi, "private setup")
    .replace(/\bpin\b/gi, "supported build")
    .replace(/~\/\.hermes\b/gi, "Bud's private setup");
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
