// Pending approval, ported from the upstream pattern: an approval does
// not sit in the transcript waiting to be noticed — it takes over the
// composer. The prompt is disabled, a strip above it says exactly what
// is being asked, and the send row is replaced by the decisions.
//
// Faithful details worth keeping: one at a time with an "n of N" counter,
// the detail printed raw in a monospace block that is NEVER truncated
// (it scrolls instead), and the buttons ordered least-destructive-last so
// the primary action sits under your thumb.
import { memo } from "react";
import { useStore, type Bot, type Message, type RequestFence } from "@/state/store";
import { alwaysAllowOfferLabel } from "@/lib/portal-job";
import { approvalHeadline } from "@/lib/tool-label";
import { cn } from "@/lib/cn";

export interface Pending {
  message: Message;
  requestId: string;
  tool: string;
  /** the narrow grant "always allow" writes, computed server-side */
  allowKey?: string;
  detail: string;
  held?: string;
  fence?: RequestFence;
}

/** Open approvals on a thread, oldest first — answered/dismissed drop out. */
export function pendingApprovals(messages: Message[]): Pending[] {
  return messages
    .filter((m) => m.kind === "options" && m.card?.requestId && m.card.tool && !m.card.answered && !m.card.dismissed)
    .map((m) => ({
      message: m,
      requestId: m.card!.requestId!,
      tool: m.card!.tool!,
      allowKey: m.card!.allowKey,
      detail: m.card!.subtitle,
      held: m.card!.held,
      fence: m.card!.fence,
    }));
}

function payloadText(pending: Pending): string {
  return [pending.detail, pending.held, pending.allowKey, pending.message.card?.title].filter(Boolean).join("\n");
}

function legacyLabel(tool: string): string {
  const nice: Record<string, string> = {
    Bash: "Command approval requested",
    shell: "Command approval requested",
    Read: "File-read approval requested",
    Write: "File-change approval requested",
    Edit: "File-change approval requested",
    edit: "File-change approval requested",
  };
  return nice[tool] ?? "Approval requested";
}

export const PendingApprovalPanel = memo(function PendingApprovalPanel({
  pending,
  count,
  index,
  productAsk = false,
}: {
  pending: Pending;
  count: number;
  index: number;
  productAsk?: boolean;
}) {
  const { state } = useStore();
  const knownAddresses = productAsk ? (state.desk?.properties ?? []).map((row) => row.address) : [];
  const headline = productAsk
    ? approvalHeadline(pending.tool, payloadText(pending), knownAddresses)
    : legacyLabel(pending.tool);
  const isSubmit = pending.fence?.surface === "portal-submit";
  return (
    <div className={cn("rounded-t-2xl border-b px-4 py-3", productAsk ? "border-line bg-sheet" : "border-hairline/50 bg-raised/40")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("text-[11px] uppercase tracking-[0.18em]", productAsk ? "text-ink-muted" : "text-ink-secondary")}>Pending approval</span>
        {count > 1 && (
          <span className="rounded-full bg-raised px-1.5 py-0.5 text-[11px] tabular-nums text-ink-secondary">
            {index + 1} of {count}
          </span>
        )}
        <span className="text-[13px] text-ink" title={pending.tool}>
          {headline}
        </span>
        {!productAsk && <span className="font-mono text-[11px] text-ink-muted">{pending.tool}</span>}
      </div>
      {isSubmit ? (
        <p className="mt-2 text-[15px] font-medium leading-relaxed text-ink">{pending.detail}</p>
      ) : (
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink">
          {pending.detail}
        </pre>
      )}
      {isSubmit ? (
        <p className="mt-2 text-[12.5px] text-hold">Check the form in the browser before you allow.</p>
      ) : null}
      {pending.held && <div className="mt-2 text-[12px] text-hold">{pending.held}</div>}
    </div>
  );
});

export function PendingApprovalActions({
  pending,
  threadId,
  bot,
  onCancelTurn,
  alwaysAllowable = true,
  productAsk = false,
}: {
  pending: Pending;
  threadId: string;
  /** who asked — "always allow" is remembered against them */
  bot?: Bot;
  onCancelTurn: () => void;
  /** Always allow writes a standing rule for this approval key. */
  alwaysAllowable?: boolean;
  productAsk?: boolean;
}) {
  const { dispatch } = useStore();
  const productBud = productAsk || bot?.id === "bud" || bot?.name === "Bud";
  const isSubmit = pending.fence?.surface === "portal-submit";
  const ruleOffer = isSubmit ? null : pending.fence?.ruleOffer ?? null;
  const decide = (
    behavior: "allow" | "deny",
    options?: { always?: boolean; scope?: "once" | "session"; rule?: { surface: "portal-read" | "portal-prefill"; origin: string } },
  ) =>
    dispatch({
      type: "decideRequest",
      threadId,
      requestId: pending.requestId,
      behavior,
      message: behavior === "deny" ? "Denied by the user." : undefined,
      scope: options?.scope,
      rule: options?.rule,
      alwaysAllow: options?.always && bot && pending.allowKey ? { botId: bot.id, key: pending.allowKey } : undefined,
    });

  const base = "pm-control rounded-full px-3.5 text-[13.5px] transition-colors";
  return (
    <div className="flex flex-col items-end gap-2 px-2 py-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {isSubmit ? (
          <button
            type="button"
            onClick={() => decide("allow", { scope: "once" })}
            className={cn("pm-decision rounded-full px-3.5 text-[13.5px] font-medium transition-colors", "bg-agency text-white hover:bg-agency-hover")}
          >
            Allow this Submit
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => decide("allow", { scope: "once" })}
              className={cn(base, productBud ? "border border-line text-ink hover:bg-raised" : "bg-agency font-medium text-white hover:bg-agency-hover")}
            >
              Allow once
            </button>
            {/* On a fenced browser step a task-wide grant would stop the worker
                asking, and the fence only sees what it asks. The server coerces it
                to once anyway; the honest offer here is the site rule below. */}
            {productBud && !pending.fence && (
              <button
                type="button"
                onClick={() => decide("allow", { scope: "session" })}
                title="Allow matching low-risk steps for this Bud task. Sensitive or consequential steps can still ask."
                className={cn(base, "bg-agency font-medium text-white hover:bg-agency-hover")}
              >
                Allow for this task
              </button>
            )}
          </>
        )}
        {alwaysAllowable && bot && pending.allowKey && !productBud && (
          <button
            type="button"
            onClick={() => decide("allow", { always: true })}
            title={`Save a rule: stop asking about ${pending.allowKey}`}
            className={cn(base, "border border-line text-ink hover:bg-raised")}
          >
            Always allow
          </button>
        )}
        <button
          type="button"
          onClick={() => decide("deny")}
          className={cn(base, "border border-danger/40 text-danger hover:bg-danger/10")}
        >
          Deny
        </button>
        <button
          type="button"
          onClick={onCancelTurn}
          className={cn(base, "text-ink-muted hover:bg-raised hover:text-ink")}
        >
          Stop this turn
        </button>
      </div>
      {ruleOffer ? (
        <div className="flex w-full max-w-full flex-col items-end gap-1">
          <button
            type="button"
            onClick={() => decide("allow", { scope: "once", rule: { surface: ruleOffer.surface, origin: ruleOffer.origin } })}
            className={cn(base, "border border-line text-ink hover:bg-raised")}
          >
            {alwaysAllowOfferLabel(ruleOffer.label)}
          </button>
          <p className="text-[12px] text-ink-muted">
            Saved as a standing rule. Revoke it any time on You → Bud's rules.
          </p>
        </div>
      ) : null}
    </div>
  );
}
