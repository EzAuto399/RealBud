/** Explicitly distinguish plan approval from permission for an actual action. */
export function ApprovalScope({ kind }: { kind: "plan" | "action" }) {
  return <p className="mt-2 text-[12px] leading-relaxed text-ink-muted">
    {kind === "plan" ? "Approving saves these steps and any selected schedule. Sending, payments and record changes still require their own review." : "Review the action and its details. Allow once approves this request only; it does not mean the action has finished."}
  </p>;
}
