export type WorkspaceSetupTarget = "bud" | "apps" | "phone" | "office";
export const WORKSPACE_SETUP_EVENT = "realbud:workspace-setup";
export function isWorkspaceSetupTarget(value: unknown): value is WorkspaceSetupTarget {
  return value === "bud" || value === "apps" || value === "phone" || value === "office";
}
/** Open setup without navigating away from unfinished work. */
export function openWorkspaceSetup(target: WorkspaceSetupTarget = "bud") {
  window.dispatchEvent(new CustomEvent(WORKSPACE_SETUP_EVENT, { detail: target }));
}
