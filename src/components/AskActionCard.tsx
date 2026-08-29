import { useEffect, useState } from "react";
import { CalendarDays, Check, ChevronDown, CircleAlert, Clock3, Loader2, MonitorUp, Settings2, ShieldCheck, X } from "lucide-react";

import type { AskActionProposal } from "@shared/ask-actions";
import { askActionApprovalCopy, askConnectReceiptCopy, isCompletedToolConnect, isSpentConnectReceipt, isUnsupportedOfficeConnect, readAdmittedAskWorkRoutingPlan } from "@shared/ask-actions";
import { askConnectFromSpentAction } from "@/lib/ask-connect";
import { describeSessionHeal } from "@/lib/session-heal";
import { cn } from "@/lib/cn";
import { api, useStore, type Message } from "@/state/store";
import { AskConnectionPicker } from "./AskConnectionPicker";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function daysLabel(days: number[]): string {
  return days.join(",") === "1,2,3,4,5" ? "Weekdays" : days.map((day) => DAY_NAMES[day] ?? String(day)).join(", ");
}

function money(cents: number): string {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(cents / 100);
}

function actionRows(action: AskActionProposal): Array<{ label: string; before?: string; after: string }> {
  switch (action.kind) {
    case "run-routine":
      return [{ label: "Routine", after: action.loopName }, { label: "When", after: "Run once now" }];
    case "change-routine": {
      const rows: Array<{ label: string; before?: string; after: string }> = [];
      if (action.before.enabled !== action.after.enabled) rows.push({ label: "Status", before: action.before.enabled ? "On" : "Paused", after: action.after.enabled ? "On" : "Paused" });
      if (action.before.time !== action.after.time) rows.push({ label: "Time", before: action.before.time, after: action.after.time });
      if (action.before.weekdays.join(",") !== action.after.weekdays.join(",")) rows.push({ label: "Days", before: daysLabel(action.before.weekdays), after: daysLabel(action.after.weekdays) });
      return rows;
    }
    case "add-property":
      return action.properties.flatMap((property) => [
        { label: "Property", after: property.address },
        { label: "Tenancy", after: `${property.tenantName} · ${property.tenantPhone} · ${money(property.weeklyRentCents)}/wk` },
      ]);
    case "configure-property":
      return Object.entries(action.changes).map(([key, value]) => ({
        label: ({ rentSource: "Rent source", graceDays: "Grace days", courtesyUntilDay: "Courtesy until", notifyChannel: "Courtesy channel" } as Record<string, string>)[key] ?? key,
        before: String(action.before[key as keyof typeof action.before]),
        after: String(value),
      }));
    case "set-agency-name":
      return [{ label: "Agency", before: action.beforeName || "Not named", after: action.afterName || "Not named" }];
    case "open-setup":
      return [{ label: "Setup", after: action.service ?? action.target.replaceAll("-", " ") }];
    case "choose-connection":
      return [{
        label: "Choice",
        after: action.selectedId
          ? (action.options.find((option) => option.id === action.selectedId)?.label ?? action.selectedId)
          : "Pick one approved connection",
      }];
    case "prepare-handoff":
      return [
        { label: "Property", after: action.address },
        { label: "Work", after: action.draftKind === "levy-from-rent" ? "Levy follow-up" : action.draftKind === "owner-letter" ? "Owner update" : "Courtesy wording" },
        { label: "Boundary", after: action.mode === "practice" ? "Practice portal · you Submit" : "Bounded PMS handoff · you Submit" },
      ];
  }
}

function primaryLabel(action: AskActionProposal): string {
  switch (action.kind) {
    case "run-routine": return "Allow once & run";
    case "add-property": return "Allow once & add";
    case "prepare-handoff": return "Allow once & prepare";
    case "open-setup": return "Continue setup";
    default: return "Allow once & apply";
  }
}

function revisionCheck(action: AskActionProposal): string {
  if (action.kind === "run-routine" || action.kind === "change-routine") {
    return `Routine revision ${action.expectedLoopRevision} is checked again before work starts.`;
  }
  if (action.kind !== "open-setup" && action.kind !== "choose-connection") {
    return `Desk revision ${action.expectedDeskRevision} is checked again before work starts.`;
  }
  return "Navigation-only request; connection state remains unchanged.";
}

function spentConnectStatus(action: AskActionProposal): string {
  return askConnectReceiptCopy(action).status;
}

export function SpentConnectReceipt({
  action,
  onOpen,
}: {
  action: AskActionProposal;
  onOpen?: () => void;
}) {
  return (
    <article
      className={cn(
        "w-full max-w-[760px] border bg-sheet px-3 py-2 text-ink",
        isCompletedToolConnect(action) ? "copy-pulse border-agency/40" : "border-line",
      )}
      aria-label="Earlier connection card"
    >
      <div className="flex min-h-10 items-center gap-2">
        <Settings2 size={15} className={cn("shrink-0", isCompletedToolConnect(action) ? "text-agency" : "text-ink-muted")} aria-hidden="true" />
        <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold">{action.title}</h3>
        <span className={cn("shrink-0 text-[12px]", isUnsupportedOfficeConnect(action) ? "text-hold" : isCompletedToolConnect(action) ? "text-agency" : "text-ink-muted")}>{spentConnectStatus(action)}</span>
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            className="shrink-0 text-[12px] font-medium text-agency hover:underline"
          >
            {askConnectReceiptCopy(action).open}
          </button>
        ) : null}
      </div>
      {isCompletedToolConnect(action) && action.detail ? (
        <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">{action.detail}</p>
      ) : null}
    </article>
  );
}

export function SpentConnectReceiptGroup({
  actions,
  onOpen,
}: {
  actions: AskActionProposal[];
  onOpen?: (action: AskActionProposal) => void;
}) {
  const [open, setOpen] = useState(false);
  const latest = actions[actions.length - 1];
  if (!latest) return null;
  return (
    <article
      className="w-full max-w-[760px] border border-line bg-sheet px-3 py-2 text-ink"
      aria-label="Earlier connection cards"
    >
      <div className="flex min-h-10 items-center gap-2">
        <Settings2 size={15} className="shrink-0 text-ink-muted" aria-hidden="true" />
        <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold">
          {actions.length} earlier connection cards
        </h3>
        <span className="min-w-0 max-w-[10rem] truncate text-[12px] text-ink-muted">{latest.title}</span>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="shrink-0 text-[12px] font-medium text-ink hover:underline"
        >
          {open ? "Hide" : "Show"}
        </button>
        {onOpen && latest.status === "allowed" ? (
          <button
            type="button"
            onClick={() => onOpen(latest)}
            className="shrink-0 text-[12px] font-medium text-agency hover:underline"
          >
            Open latest
          </button>
        ) : null}
      </div>
      {open ? (
        <ul className="mt-1.5 space-y-1 border-t border-line pt-1.5">
          {actions.map((action) => (
            <li key={action.id} className="flex min-h-8 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{action.title}</span>
              <span className={cn("shrink-0 text-[12px]", isUnsupportedOfficeConnect(action) ? "text-hold" : "text-ink-muted")}>{spentConnectStatus(action)}</span>
              {onOpen && action.status === "allowed" ? (
                <button
                  type="button"
                  onClick={() => onOpen(action)}
                  className="shrink-0 text-[12px] font-medium text-agency hover:underline"
                >
                  {askConnectReceiptCopy(action).open}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

export function AskSpentConnectGroup({ messages }: { messages: Message[] }) {
  const { dispatch } = useStore();
  const actions = messages.flatMap((message) => (message.action ? [message.action] : []));
  return (
    <SpentConnectReceiptGroup
      actions={actions}
      onOpen={(action) => {
        const request = askConnectFromSpentAction(action);
        if (request) dispatch({ type: "openAskConnect", target: request.target, service: request.service });
      }}
    />
  );
}

function preparedLabel(at: number): string {
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
}

export function AskActionApprovalContext({ action, compact = false }: {
  action: AskActionProposal;
  compact?: boolean;
}) {
  const copy = askActionApprovalCopy(action);
  if (action.status === "allowed") {
    const connectName = action.kind === "open-setup"
      ? action.service ?? "this source"
      : action.kind === "choose-connection"
        ? (action.options.find((option) => option.id === action.selectedId)?.service ?? "this source")
        : null;
    if (connectName && isUnsupportedOfficeConnect(action)) {
      return (
        <section role="status" className="mt-2.5 rounded-lg border border-hold/30 bg-hold/5 px-3 py-2.5" aria-label="Not a named office source">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-hold/15 text-hold"><CircleAlert size={13} aria-hidden="true" /></span>
            <div>
              <h4 className="text-[12.5px] font-semibold text-hold">{action.title}</h4>
              <p className="mt-0.5 text-[12px] leading-relaxed text-ink">{copy.completed}</p>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
                Social accounts stay out. Pick a named office source if that is what you meant.
              </p>
            </div>
          </div>
        </section>
      );
    }
    if (connectName) {
      return (
        <section role="status" className="mt-2.5 rounded-lg border border-agency/30 bg-agency/5 px-3 py-2.5" aria-label="Connection card">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-agency text-white"><Check size={13} aria-hidden="true" /></span>
            <div>
              <h4 className="text-[12.5px] font-semibold text-agency">{`Connect ${connectName} here`}</h4>
              <p className="mt-0.5 text-[12px] leading-relaxed text-ink">{copy.completed}</p>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
                Ask again any time to reopen the card. Keys stay on this device. Nothing connected automatically.
              </p>
            </div>
          </div>
        </section>
      );
    }
    return (
      <section role="status" className="mt-2.5 rounded-lg border border-agency/30 bg-agency/5 px-3 py-2.5" aria-label="Completed approval request">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-agency text-white"><Check size={13} aria-hidden="true" /></span>
          <div>
            <h4 className="text-[12.5px] font-semibold text-agency">Bud completed the allowed step</h4>
            <p className="mt-0.5 text-[12px] leading-relaxed text-ink">{copy.completed}</p>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
              This Allow was used once. Future matching work may be quicker to review, but it will still need Allow.
            </p>
          </div>
        </div>
      </section>
    );
  }
  if (action.status === "denied") {
    return (
      <section role="status" className="mt-2.5 rounded-lg border border-line bg-raised/50 px-3 py-2.5" aria-label="Declined approval request">
        <div className="flex items-start gap-2.5">
          <X size={16} className="mt-0.5 shrink-0 text-ink-muted" aria-hidden="true" />
          <div><h4 className="text-[12.5px] font-semibold text-ink">Nothing ran</h4><p className="mt-0.5 text-[12px] text-ink-muted">Bud closed this request without applying the change.</p></div>
        </div>
      </section>
    );
  }
  if (action.status === "stale") {
    return (
      <section role="alert" className="mt-2.5 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5" aria-label="Stopped approval request">
        <div className="flex items-start gap-2.5">
          <CircleAlert size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
          <div><h4 className="text-[12.5px] font-semibold text-danger">Bud stopped safely</h4><p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">{action.failure ?? "The target changed after this request was prepared. Ask Bud to build a current request."}</p></div>
        </div>
      </section>
    );
  }

  if (action.kind === "choose-connection") {
    return (
      <p className="mt-1.5 text-[12px] leading-relaxed text-ink-muted">
        Pick the source this office already uses. Keys stay on this device.
      </p>
    );
  }

  if (compact) {
    return (
      <section className="mt-2.5 rounded border border-hold/25 bg-hold/5 px-3 py-2" aria-label="Approval request summary">
        <p className="text-[12px] leading-relaxed text-ink"><span className="font-semibold">One exact action:</span> {action.detail}</p>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">{copy.boundary} Future work still needs Allow.</p>
      </section>
    );
  }

  return (
    <section className="mt-3 overflow-hidden rounded-lg border border-hold/30 bg-paper" aria-label="Approval request">
      <div className="flex items-start gap-3 border-b border-line/70 bg-hold/5 px-3.5 py-3">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-hold/10 text-hold"><ShieldCheck size={15} aria-hidden="true" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-[13px] font-semibold text-ink">Before Bud starts</h4>
            <span className="rounded-full border border-hold/25 bg-sheet px-2 py-0.5 text-[12px] font-medium text-hold">One-time approval</span>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">Review the exact scope. RealBud checks it again when you Allow.</p>
        </div>
      </div>
      <dl className="divide-y divide-line/70 px-3.5 text-[12px]">
        <div className="grid gap-1 py-2.5 sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-3"><dt className="font-medium text-ink-muted">Why</dt><dd className="leading-relaxed text-ink">{action.detail}</dd></div>
        <div className="grid gap-1 py-2.5 sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-3"><dt className="font-medium text-ink-muted">Permission</dt><dd className="leading-relaxed text-ink">{copy.permission}</dd></div>
        <div className="grid gap-1 py-2.5 sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-3"><dt className="font-medium text-ink-muted">Stops at</dt><dd className="leading-relaxed text-ink">{copy.boundary}</dd></div>
      </dl>
      <div className="border-t border-line/70 bg-sheet/70 px-3.5 py-2.5">
        <p className="text-[12px] leading-relaxed text-ink-muted">A future exact match can be shorter to review, but RealBud never turns it into automatic approval.</p>
        <details className="group mt-1.5">
          <summary className="flex min-h-7 cursor-pointer list-none items-center gap-1 text-[12px] font-medium text-agency marker:content-none">
            Request details <ChevronDown size={12} className="transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <dl className="mt-1.5 grid gap-1.5 border-l-2 border-line pl-3 text-[12px] text-ink-muted sm:grid-cols-[6rem_minmax(0,1fr)]">
            <dt>Request</dt><dd className="font-mono">…{action.id.slice(-8)}</dd>
            <dt>Prepared</dt><dd className="inline-flex items-center gap-1"><Clock3 size={11} aria-hidden="true" />{preparedLabel(action.createdAt)}</dd>
            <dt>Freshness</dt><dd>{revisionCheck(action)}</dd>
          </dl>
        </details>
      </div>
    </section>
  );
}

const ROUTE_LABELS = {
  "structured-batch": "Structured local batch",
  "local-analysis": "Local analysis",
  "remote-analysis": "Cloud analysis",
  "scripted-browser": "Scripted browser",
  "isolated-browser": "Isolated browser",
  "remote-browser": "Cloud browser",
  "desktop-cua": "Visible computer use",
} as const;

function secondsLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} min`;
}

export function AskActionExecutionPlan({ plan }: { plan: unknown }) {
  const admitted = readAdmittedAskWorkRoutingPlan(plan);
  if (!admitted) return null;
  const lanes = admitted.lanes.filter((lane) => lane.itemCount > 0);
  const estimate = admitted.estimate.basis === "measured"
    ? `${secondsLabel(admitted.estimate.minimumSeconds!)}–${secondsLabel(admitted.estimate.maximumSeconds!)}`
    : "Timing not measured";
  const usesCloud = lanes.some((lane) => lane.kind === "remote-analysis" || lane.kind === "remote-browser");
  const usesVisibleComputer = lanes.some((lane) => lane.kind === "desktop-cua");
  const boundary = usesCloud
    ? "Connected cloud lane · fresh connection and one-time job approval required"
    : usesVisibleComputer
      ? "On this computer · one visible lane · you keep control of Submit"
      : "On this device · no work is routed to cloud";
  return (
    <section className="mt-2 border border-agency/25 bg-selected/45 px-3 py-2" aria-label="Execution route">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h4 className="text-[12px] font-semibold uppercase tracking-[0.12em] text-agency">Execution route</h4>
        <span className="text-[12px] font-medium text-ink-muted">{admitted.selectedMode.replaceAll("-", " ")}</span>
      </div>
      <div className="mt-1.5 space-y-1">
        {lanes.map((lane, index) => (
          <div key={`${lane.kind}-${index}`} className="flex flex-wrap justify-between gap-x-3 text-[12px]">
            <span className="font-medium text-ink">{ROUTE_LABELS[lane.kind]}</span>
            <span className="text-ink-muted">
              {lane.itemCount} {lane.itemCount === 1 ? "record" : "records"} · {lane.batchCount} {lane.batchCount === 1 ? "batch" : "batches"} · {lane.concurrency} {lane.concurrency === 1 ? "lane" : "lanes"}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-1.5 text-[12px] text-ink-muted">{estimate}</p>
      <p className="mt-1 text-[12px] font-medium text-agency">{boundary}</p>
      {admitted.fallbackReasons.length > 0
        ? <p className="mt-1 text-[12px] leading-relaxed text-hold">{admitted.fallbackReasons.join(" ")}</p>
        : null}
    </section>
  );
}

export function AskActionCard({ botId, threadId, message, compact = false }: {
  botId: string;
  threadId: string;
  message: Message;
  compact?: boolean;
}) {
  const { dispatch } = useStore();
  const action = message.action;
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (action?.status !== "pending") setError("");
  }, [action?.status]);
  if (!action) return null;

  if (isSpentConnectReceipt(action)) {
    const request = askConnectFromSpentAction(action);
    return (
      <SpentConnectReceipt
        action={action}
        onOpen={request
          ? () => dispatch({ type: "openAskConnect", target: request.target, service: request.service })
          : undefined}
      />
    );
  }

  const decide = async (decision: "allow" | "deny", selection?: string) => {
    if (busy || action.status !== "pending") return;
    setBusy(decision);
    setError("");
    try {
      const result = await api(`/api/bots/${botId}/actions/${message.id}`, {
        method: "POST",
        body: JSON.stringify({ decision, ...(selection ? { selection } : {}) }),
      });
      if (result.message) dispatch({ type: "messagePatched", threadId, message: result.message });
      if (result.snapshot) dispatch({ type: "deskSnapshot", snapshot: result.snapshot });
      if (result.loop) dispatch({ type: "loopPatched", loop: result.loop });
      if (result.run) dispatch({ type: "loopRunPatched", run: result.run });
      if (result.navigation) {
        const service = action.kind === "choose-connection"
          ? action.options.find((option) => option.id === selection)?.service
          : action.kind === "open-setup" ? action.service : undefined;
        dispatch({ type: "openAskConnect", target: result.navigation, service });
      }
      else if (decision === "allow" && action.kind === "run-routine") dispatch({ type: "showDesk" });
    } catch (cause) {
      setError(describeSessionHeal(cause).detail);
    } finally {
      setBusy(null);
    }
  };

  const settled = action.status !== "pending";
  const tone = action.status === "allowed" ? "agency" : action.status === "denied" ? "muted" : action.status === "stale" ? "danger" : action.kind === "choose-connection" ? "muted" : "hold";
  const statusLabel = action.status === "pending"
    ? action.kind === "choose-connection" ? "Pick one" : "Needs your Allow"
    : action.status === "allowed"
      ? (action.kind === "open-setup" || action.kind === "choose-connection"
        ? askConnectReceiptCopy(action).status
        : "Completed")
      : action.status === "denied" ? "Not run" : "Stopped safely";
  const rows = actionRows(action);

  return (
    <article className={cn(
      "w-full border bg-sheet text-ink",
      compact ? "px-3 py-2.5" : "max-w-[760px] px-4 py-3.5",
      tone === "agency" ? "border-agency/40" : tone === "danger" ? "border-danger/40" : tone === "hold" ? "border-hold/40" : "border-line",
    )}>
      <div className="flex items-start gap-3">
        <span className={cn("mt-0.5 flex size-8 shrink-0 items-center justify-center rounded", action.kind.includes("routine") ? "bg-selected text-agency" : action.kind === "prepare-handoff" ? "bg-portal/10 text-portal" : "bg-raised text-ink-muted")}>
          {action.kind.includes("routine") ? <CalendarDays size={16} /> : action.kind === "prepare-handoff" ? <MonitorUp size={16} /> : <Settings2 size={16} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[14px] font-semibold">{action.title}</h3>
            <span className={cn(
              "rounded px-2 py-0.5 text-[12px] font-medium",
              tone === "agency" ? "bg-agency/10 text-agency" : tone === "danger" ? "bg-danger/10 text-danger" : tone === "hold" ? "bg-hold/10 text-hold" : "bg-raised text-ink-muted",
            )}>{statusLabel}</span>
          </div>
          <AskActionApprovalContext action={action} compact={compact} />
          {action.kind === "run-routine" && action.executionPlan
            ? <AskActionExecutionPlan plan={action.executionPlan} />
            : null}
          {action.kind === "choose-connection" ? (
            <AskConnectionPicker
              options={action.options}
              selectedId={action.selectedId}
              disabled={busy !== null}
              onChoose={(id) => void decide("allow", id)}
            />
          ) : (
            <>
              {!compact ? <h4 className="mt-3 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-muted">Exact action</h4> : null}
              <dl className="mt-2 divide-y divide-line/60 border-y border-line/60 text-[12px]">
                {rows.map((row, index) => (
                  <div key={`${row.label}-${index}`} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 py-1.5">
                    <dt className="text-ink-muted">{row.label}</dt>
                    <dd className="min-w-0 break-words">
                      {row.before !== undefined ? <><span className="text-ink-muted line-through">{row.before}</span><span aria-hidden="true"> → </span></> : null}
                      <span className="font-medium text-ink">{row.after}</span>
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          )}
          {error ? <p className="mt-2 text-[12px] text-danger" role="alert">{error}</p> : null}
          {!settled ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {action.kind !== "choose-connection" ? (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void decide("allow")}
                  className="pm-control pm-tactile inline-flex items-center gap-1.5 rounded bg-agency px-3 text-[12.5px] font-semibold text-white hover:bg-agency-hover disabled:opacity-50"
                >
                  {busy === "allow" ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                  {busy === "allow" ? "Running allowed step…" : primaryLabel(action)}
                </button>
              ) : null}
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void decide("deny")}
                className="pm-control pm-tactile inline-flex items-center gap-1.5 rounded border border-line px-3 text-[12.5px] text-ink-muted hover:bg-raised disabled:opacity-50"
              >
                {busy === "deny" ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />}
                {busy === "deny" ? "Closing…" : "Not now"}
              </button>
            </div>
          ) : action.status === "allowed" ? (
            <div className="mt-2 flex gap-2">
              {action.kind === "run-routine" ? (
                <button type="button" onClick={() => dispatch({ type: "showDesk" })} className="text-[12px] font-medium text-agency hover:underline">Open Desk</button>
              ) : action.kind === "change-routine" ? (
                <button type="button" onClick={() => dispatch({ type: "showRoutines" })} className="text-[12px] font-medium text-agency hover:underline">View Schedule</button>
              ) : action.kind === "open-setup" || action.kind === "choose-connection" ? (
                <button
                  type="button"
                  onClick={() => {
                    const selected = action.kind === "choose-connection"
                      ? action.options.find((option) => option.id === action.selectedId)
                      : null;
                    dispatch({
                      type: "openAskConnect",
                      target: selected?.target ?? (action.kind === "open-setup" ? action.target : "connections"),
                      service: selected?.service ?? (action.kind === "open-setup" ? action.service : undefined),
                    });
                  }}
                  className="text-[12px] font-medium text-agency hover:underline"
                >
                  Open connect card
                </button>
              ) : action.kind === "add-property" || action.kind === "configure-property" || action.kind === "set-agency-name" || action.kind === "prepare-handoff" ? (
                <button type="button" onClick={() => dispatch({ type: "showDesk" })} className="text-[12px] font-medium text-agency hover:underline">View Desk</button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}
