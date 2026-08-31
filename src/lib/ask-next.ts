export type AskNext =
  | { id: string; label: string; kind: "ask"; text: string }
  | { id: string; label: string; kind: "desk" }
  | { id: string; label: string; kind: "you" };

export function askNextActions(input: { miss: boolean; needsYou: number; workerReady: boolean; workerSetupComplete?: boolean }): AskNext[] {
  const next: AskNext[] = [];
  if (!input.workerReady || input.miss) {
    next.push({
      id: "attach",
      label: input.workerReady || input.workerSetupComplete ? "Check Bud" : "Set up Bud",
      kind: "you",
    });
  }
  next.push({ id: "needs", label: "What needs me?", kind: "ask", text: "What needs me?" });
  next.push({ id: "recheck", label: "What did Recheck find?", kind: "ask", text: "What did Recheck find?" });
  if (input.miss || input.needsYou > 0) next.push({ id: "desk", label: "Open Desk", kind: "desk" });
  next.push({ id: "hold", label: "Explain this hold", kind: "ask", text: "Explain this hold" });
  next.push({ id: "draft", label: "Draft an owner update", kind: "ask", text: "Draft an owner update" });
  return next;
}
