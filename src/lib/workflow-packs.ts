/** Client-facing office workflow pack status (mirrors server/workflow-packs). */
export type WorkflowPackStatus = {
  id: string;
  title: string;
  summary: string;
  phase: string;
  requiresHermesPropertyPack: boolean;
  installed: boolean;
  installedAt: number | null;
  recipeIds: string[];
  recipesPresent: number;
  recipesMissing: string[];
  packRevision: number;
};

export function workflowPackPhaseLabel(phase: string): string {
  if (phase === "phase-1") return "Phase 1";
  if (phase === "phase-1.5") return "After Phase 1";
  if (phase === "phase-2") return "Phase 2";
  return phase;
}

export function workflowPackInstallLabel(pack: Pick<WorkflowPackStatus, "installed" | "recipesMissing" | "recipesPresent">): string {
  if (pack.installed) return "Installed";
  if (pack.recipesPresent > 0) return "Needs refresh";
  return "Not installed";
}
