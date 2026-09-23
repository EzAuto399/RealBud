/** Guards keep unsaved work in its mounted owner. No form values are stored here. */
const guards = new Set<() => boolean>();
export const NAVIGATION_CANCELLED = "realbud:navigation-cancelled";

export function registerNavigationGuard(guard: () => boolean): () => void {
  guards.add(guard);
  return () => { guards.delete(guard); };
}

export function changesWorkspacePage(action: string, current: string): boolean {
  const destination: Record<string, string> = {
    showDesk: "desk", showAsk: "ask", stageAskContext: "ask", showYou: "you",
    showRoutines: "schedule", showWorkspaceTab: "workspace", select: "chat",
    newBot: "chat", duplicateBot: "chat", createGroup: "chat",
  };
  return Boolean(destination[action] && destination[action] !== current);
}

export function allowWorkspaceNavigation(action: string, current: string): boolean {
  if (!changesWorkspacePage(action, current)) return true;
  for (const guard of guards) if (!guard()) return false;
  return true;
}
