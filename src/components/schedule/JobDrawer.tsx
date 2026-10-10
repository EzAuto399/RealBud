// The Schedule detail drawer: one job's next run, latest result, timing and
// decisions, opened from its row. One scrolling body; Escape closes and focus
// returns to the row that opened it.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, CircleAlert, Hourglass, Loader2, Pause, Play, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { api, useStore } from "@/state/store";
import { openDeskArea } from "@/lib/desk-view-state";
import { guardUnsavedWork } from "@/lib/unsaved-work";
import { useWorkspaceTabs } from "@/lib/workspace-tabs";
import { effectiveDeskAreas } from "@shared/workspace-tabs";
import { useDeskArrangement } from "../shell/DeskArrangement";
import { fmtDateTime } from "@/lib/au";
import { useDialogKeyboard } from "@/lib/use-dialog-keyboard";
import { useScheduleTiming } from "@/lib/workspace-view-state";
import type { Loop, LoopRun, LoopRunStatus } from "@/lib/routines";
import type { JobRun } from "@/lib/desk";
import { DAY_NAMES, scheduleSummary, WEEKDAYS_MON_FIRST } from "@/lib/schedule-week";
import { attendedRunLabel, isAttendedMode, jobRunModeLabel, jobRunStatusChip, loopRunStatusLabel, preparedJobText, safeJobRunDetail } from "@/lib/job-run";
import { jobRunProgress, recheckProgress } from "@/lib/task-progress";
import type { PendingLoopRequest } from "@/lib/manual-loop-request";
import { switchOnLabel } from "@/lib/schedule-rows";
import { StatusLabel } from "../pm";
import { BankReferenceReview } from "./BankReferenceReview";
import { ExecutionHistory } from "./ExecutionHistory";
import { evaluatorForLoop } from "@shared/workflow-catalog";
import type { SetupGate } from "@/lib/setup-sequence";
import { SetupGateNote } from "../SetupGateNote";

export type CloseGuardRegistrar = (guard: () => boolean) => () => void;
export type LoopTimingChange = { time: string; weekdays: number[]; intervalDays?: number | null; anchorDate?: string };

/** Side drawer shell: 560px on desktop, full width under 720px (schedule.css). */
export function JobDrawer({
  title,
  busy = false,
  wide = false,
  actions,
  notice,
  onClose,
  children,
}: {
  title: string;
  busy?: boolean;
  wide?: boolean;
  /** Fixed decision controls (for example Stop) that never scroll away. */
  actions?: ReactNode;
  /** Errors and confirmations for work started from the drawer. */
  notice?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogKeyboard(ref, onClose, busy);
  return (
    <div className="schedule-drawer-backdrop bg-ink/40" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-wide={wide ? "" : undefined}
        className="schedule-drawer border-line bg-paper shadow-xl outline-none"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line bg-sheet px-4 py-2">
          <h2 id={titleId} className="min-w-0 break-words text-[17px] font-semibold text-ink">{title}</h2>
          <button
            type="button"
            aria-label={`Close ${title}`}
            disabled={busy}
            onClick={onClose}
            className="pm-control inline-flex shrink-0 items-center gap-2 rounded px-3 text-[13px] text-ink hover:bg-selected disabled:opacity-40"
          >
            Close<X size={16} aria-hidden />
          </button>
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-sheet px-4 py-2">{actions}</div> : null}
        {notice ? <div className="shrink-0 px-4 pt-3">{notice}</div> : null}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
      </div>
    </div>
  );
}

export function RunStatus({ status }: { status: LoopRunStatus }) {
  const { label, tone } = loopRunStatusLabel(status);
  const icon =
    status === "queued" ? (
      <Hourglass size={12} aria-hidden />
    ) : status === "running" ? (
      <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden />
    ) : status === "completed" ? (
      <CheckCircle2 size={12} aria-hidden />
    ) : (
      <CircleAlert size={12} aria-hidden />
    );
  return (
    <StatusLabel tone={tone}>
      {icon}
      {label}
    </StatusLabel>
  );
}

/** A clock receipt shown as a result: status, time and its plain detail. */
export function LoopRunResult({ run, deskCount = 0, onOpenDesk }: { run: LoopRun; deskCount?: number; onOpenDesk?: () => void }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-muted">
        <RunStatus status={run.status} />
        <span className="tabular-nums">{run.manual ? "Run now" : "Scheduled run"} · {fmtDateTime(run.startedAt ?? run.createdAt)}</span>
      </div>
      <p className="whitespace-pre-wrap break-words text-[14px] text-ink">{run.detail || "No detail recorded."}</p>
      <p className="text-[12px] text-ink-muted">Nothing was sent, submitted, or paid.</p>
      {deskCount > 0 && onOpenDesk ? (
        <button type="button" onClick={onOpenDesk} className="pm-control rounded border border-line bg-sheet px-3 text-[13px] text-ink hover:bg-selected">
          Review {deskCount} {deskCount === 1 ? "task" : "tasks"} on Desk
        </button>
      ) : null}
    </div>
  );
}

/** The receipt that made the row ask for review, shown first. An explicit
 * review action can open it immediately; opening the drawer alone acknowledges
 * nothing, and reviewing never approves held work. */
export function FlaggedReceipt({
  word,
  loopRun,
  jobRun,
  deskCount = 0,
  initiallyOpen = false,
  onOpenDesk,
  onReviewed,
}: {
  word: string;
  loopRun?: LoopRun;
  jobRun?: JobRun;
  deskCount?: number;
  /** Only the explicit Review result action opens and reviews the receipt. */
  initiallyOpen?: boolean;
  onOpenDesk?: () => void;
  onReviewed: () => void;
}) {
  const reviewed = useRef(false);
  const [open, setOpen] = useState(initiallyOpen);
  const hasReceipt = Boolean(loopRun || jobRun);
  useEffect(() => {
    if (open && hasReceipt && !reviewed.current) {
      reviewed.current = true;
      onReviewed();
    }
  }, [open, hasReceipt, onReviewed]);
  const at = loopRun ? loopRun.startedAt ?? loopRun.createdAt : jobRun ? jobRun.startedAt ?? jobRun.createdAt : null;
  const prepared = jobRun ? preparedJobText(jobRun) : "";
  const unverified = word === "Unverified";
  return (
    <section aria-label="Result to review" className="mb-4 rounded border border-hold/40 bg-hold/5 px-3 py-2">
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className="pm-control flex cursor-pointer items-center gap-2 text-[14px] font-medium text-ink">
          <CircleAlert size={14} className="shrink-0 text-hold" aria-hidden />
          Review this result · {word}{at != null ? ` · ${fmtDateTime(at)}` : ""}
        </summary>
        <div className="mt-2 space-y-2 pb-1">
          {loopRun ? <LoopRunResult run={loopRun} deskCount={deskCount} onOpenDesk={onOpenDesk} /> : null}
          {jobRun ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-muted">
                <StatusLabel tone={(attendedRunLabel(jobRun)?.tone ?? (jobRun.status === "awaiting-approval" ? "hold" : "danger"))}>
                  <CircleAlert size={12} aria-hidden />{attendedRunLabel(jobRun)?.label ?? jobRunStatusChip(jobRun.status).label}
                </StatusLabel>
                <span className="tabular-nums">{jobRunModeLabel(jobRun.mode)} · {fmtDateTime(jobRun.startedAt ?? jobRun.createdAt)}</span>
              </div>
              {unverified && isAttendedMode(jobRun.mode) ? <p className="text-[14px] font-medium text-hold">Check the result on the website.</p> : null}
              <p className="whitespace-pre-wrap break-words text-[14px] text-ink">{safeJobRunDetail(jobRun.detail, 4000) || "No detail recorded."}</p>
              {prepared ? <p className="select-text whitespace-pre-wrap break-words border-t border-line pt-2 text-[14px] text-ink">{prepared}</p> : null}
              {jobRun.approvalRequests.length ? (
                <ul className="list-disc space-y-1 pl-5 text-[13px] text-hold">{jobRun.approvalRequests.map((request, index) => <li key={`${index}-${request}`}>{request}</li>)}</ul>
              ) : null}
              <p className="text-[13px] text-ink-muted">{isAttendedMode(jobRun.mode)
                ? "Check the website for any changes made during this run before trying again."
                : "Nothing was sent, submitted, or paid by this result."}</p>
            </>
          ) : null}
          {!loopRun && !jobRun ? <p className="text-[13px] text-ink-secondary">This result is no longer loaded. Open Earlier results to find it.</p> : null}
        </div>
      </details>
    </section>
  );
}

/** Time, weekdays and (for weekly bills and bank references) the cadence and
 * first date. Moved intact from the Schedule loop card. */
export function LoopTiming({
  loop,
  busy,
  controlsDisabled,
  open,
  onOpen,
  onRetune,
}: {
  loop: Loop;
  busy: boolean;
  controlsDisabled: boolean;
  open: boolean;
  onOpen: (open: boolean) => void;
  onRetune: (when: LoopTimingChange) => void;
}) {
  const { time, setTime, days, setDays } = useScheduleTiming(loop.id, loop.schedule.time, loop.schedule.weekdays);
  const savedDays = loop.schedule.weekdays.join(",");
  const [interval, setIntervalDays] = useState(loop.schedule.intervalDays ?? 0);
  const [anchor, setAnchor] = useState(loop.schedule.anchorDate ?? '');
  useEffect(() => { setIntervalDays(loop.schedule.intervalDays ?? 0); setAnchor(loop.schedule.anchorDate ?? ''); }, [loop.schedule.intervalDays, loop.schedule.anchorDate]);
  const cadenceEditable = evaluatorForLoop(loop.id)?.cadenceEditable === true;
  const dirty = time !== loop.schedule.time || days.join(",") !== savedDays || interval !== (loop.schedule.intervalDays ?? 0) || anchor !== (loop.schedule.anchorDate ?? '');
  // Unsaved timing holds the window's beforeunload and main's update restart while it is open.
  const unsaved = useRef(dirty); unsaved.current = dirty;
  useEffect(() => guardUnsavedWork(() => unsaved.current), []);
  const toggleDay = (day: number) =>
    setDays((prev) => (prev.includes(day) ? (prev.length > 1 ? prev.filter((d) => d !== day) : prev) : [...prev, day].sort((a, b) => a - b)));
  return (
    <details
      className="border-t border-line pt-2"
      open={open}
      onToggle={(event) => onOpen(event.currentTarget.open)}
    >
      <summary className="pm-control flex cursor-pointer items-center rounded-lg px-2 text-[14px] font-medium text-ink hover:bg-raised">
        Timing · {scheduleSummary(loop.schedule)}
      </summary>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">{loop.description}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-sheet px-3 py-2.5">
        {cadenceEditable && <label className="text-sm">Cadence<select aria-label={`${loop.name} cadence`} className="pm-control ml-2 rounded border border-line bg-sheet px-2" value={interval} onChange={event => setIntervalDays(Number(event.target.value))}>
          <option value={0}>Selected weekdays</option>{[1,2,3,7,14].map(days => <option key={days} value={days}>Every {days} days</option>)}
        </select></label>}
        {cadenceEditable && interval > 0 && <label className="text-sm">First date<input aria-label={`${loop.name} first date`} type="date" className="pm-control ml-2 rounded border border-line bg-sheet px-2" value={anchor} onChange={event => setAnchor(event.target.value)} /></label>}
        <input
          type="time"
          value={time}
          onChange={(event) => setTime(event.target.value)}
          aria-label={`${loop.name} time of day`}
          className="pm-control rounded-lg border border-line bg-sheet px-2 text-[13px] text-ink"
        />
        {interval === 0 && !loop.schedule.monthly && <div className="flex min-w-0 flex-wrap items-center gap-1" role="group" aria-label={`${loop.name} days`}>
          {WEEKDAYS_MON_FIRST.map((day) => {
            const name = DAY_NAMES[day];
            const active = days.includes(day);
            return (
              <button
                key={day}
                type="button"
                onClick={() => toggleDay(day)}
                aria-pressed={active}
                aria-label={name}
                title={(active ? "Remove " : "Add ") + name}
                className={cn(
                  "pm-control rounded px-2.5 text-[12.5px] transition-colors duration-200",
                  active ? "bg-agency font-medium text-white" : "bg-raised text-ink-muted hover:text-ink",
                  !active && days.length === 1 && day === days[0] && "opacity-40",
                )}
              >
                {name}
              </button>
            );
          })}
        </div>}
        {dirty && (
          <button
            type="button"
            onClick={() => onRetune({ time, weekdays: interval > 0 ? [0,1,2,3,4,5,6] : days, ...(cadenceEditable ? { intervalDays: interval || null, ...(interval ? { anchorDate: anchor } : {}) } : {}) })}
            disabled={controlsDisabled}
            title={`Save ${scheduleSummary({ time, weekdays: interval ? [0,1,2,3,4,5,6] : days, ...(interval ? { intervalDays: interval, anchorDate: anchor } : {}) })}`}
            className="pm-control ml-auto inline-flex items-center gap-1.5 rounded-lg bg-agency px-3 text-[12px] font-medium text-white hover:bg-agency-hover disabled:opacity-40"
          >
            {busy ? <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <CheckCircle2 size={12} aria-hidden />}
            Save
          </button>
        )}
      </div>
    </details>
  );
}

export type NewMailState = { enabled: boolean; available: boolean; reason?: string };
/** A malformed answer is an error, never a switch state. */
export function readNewMailState(value: unknown): NewMailState | null {
  const data = value as Record<string, unknown> | null;
  if (!data || typeof data.enabled !== "boolean" || typeof data.available !== "boolean" || (data.reason !== undefined && (typeof data.reason !== "string" || data.reason.length > 300))) return null;
  return { enabled: data.enabled, available: data.available, ...(typeof data.reason === "string" ? { reason: data.reason } : {}) };
}

/** Morning priorities only: new mail also wakes the job. The clock run stays. */
export function NewMailSwitch({ loopId, initial }: { loopId: string; initial?: NewMailState }) {
  const [state, setState] = useState<NewMailState | null>(initial ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const path = `/api/loops/${encodeURIComponent(loopId)}/new-mail`;
  const read = async () => {
    const next = readNewMailState(await api(path, undefined, { timeoutMs: 30_000 }));
    if (!next) throw new Error("This setting could not be read. Open the job again.");
    return next;
  };
  useEffect(() => {
    if (initial) return;
    let live = true;
    read().then((next) => { if (live) setState(next); }, (cause) => { if (live) setError(cause instanceof Error ? cause.message : "This setting could not be read. Open the job again."); });
    return () => { live = false; };
  }, [path, initial]);
  const change = async (enabled: boolean) => {
    setBusy(true); setError("");
    try {
      const next = readNewMailState(await api(path, { method: "POST", body: JSON.stringify({ enabled }) }, { timeoutMs: 30_000 }));
      if (!next) throw new Error("The change could not be confirmed.");
      setState(next);
    } catch (cause) {
      // The change may have saved before the reply was lost: show what is saved now.
      setError(cause instanceof Error ? cause.message : "The change could not be confirmed.");
      await read().then(setState, () => {});
    } finally { setBusy(false); }
  };
  const on = state?.enabled === true;
  // Unavailable still lets a saved "on" be turned off.
  const disabled = busy || !state || (!state.available && !on);
  return (
    <section aria-label="New mail" aria-busy={busy || !state} className="border-t border-line pt-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p id={`${loopId}-new-mail-label`} className="text-[14px] font-medium text-ink">Also check when new mail arrives</p>
          <p className="text-[13px] text-ink-muted">Usually within 15 minutes. The morning run still happens.</p>
        </div>
        <button type="button" role="switch" aria-checked={on} aria-labelledby={`${loopId}-new-mail-label`} disabled={disabled} onClick={() => void change(!on)}
          className={cn("relative min-h-11 min-w-16 shrink-0 rounded-full border border-line px-1 transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-agency disabled:cursor-not-allowed disabled:opacity-50", on ? "bg-agency" : "bg-raised")}>
          <span aria-hidden="true" className={cn("absolute top-1/2 left-1 size-8 -translate-y-1/2 rounded-full bg-sheet transition-transform motion-reduce:transition-none", on && "translate-x-6")} />
        </button>
      </div>
      {state?.reason ? <p className="mt-1 text-[13px] text-hold">{state.reason}</p> : null}
      {error ? <p role="alert" className="mt-1 text-[13px] text-danger">{error}</p> : null}
    </section>
  );
}

/** Bank review has one place per office, so one review never holds two drafts. When this office's
 * Desk offers the Bank references area (a pack may rename it) the review lives there and this job
 * opens it; otherwise it stays here. An area this person hid is shown again first, as Needs you does.
 * In this window the office preset changes only in Agency workflow setup, reached through the close guards.
 * Until the preset is read neither place mounts; a failed read offers Try again, never a second review here. */
export function BankReviewPlace({ registerCloseGuard }: { registerCloseGuard: CloseGuardRegistrar }) {
  const { dispatch } = useStore();
  const tabs = useWorkspaceTabs();
  const arrangement = useDeskArrangement();
  if (!tabs.office && (tabs.loading || tabs.saving)) return <p role="status" className="border-t border-line pt-3 text-[13px] text-ink-muted">Checking where bank files are reviewed…</p>;
  if (!tabs.office) {
    return (
      <section aria-label="Bank review" className="border-t border-line pt-3">
        <p role="status" className="text-[14px] text-hold">Couldn’t check where bank files are reviewed.</p>
        <button type="button" onClick={() => void tabs.refresh()} className="pm-control mt-2 rounded border border-line bg-sheet px-3 text-[13px] text-ink hover:bg-selected">
          Try again
        </button>
      </section>
    );
  }
  const area = effectiveDeskAreas(arrangement.sections, arrangement.office).find((row) => row.id === "bank");
  if (!area) return <div className="border-t border-line pt-3"><BankReferenceReview registerCloseGuard={registerCloseGuard} /></div>;
  const open = () => { openDeskArea("bank"); dispatch({ type: "showDesk" }); };
  return (
    <section aria-label="Bank review" className="border-t border-line pt-3">
      <p className="text-[14px] text-ink-secondary">
        {area.visible ? `Bank files are prepared and reviewed in ${area.title} on Desk.` : `Bank files are prepared and reviewed in ${area.title}, which is hidden on your Desk.`}
      </p>
      <button
        type="button"
        disabled={!area.visible && arrangement.saving}
        onClick={area.visible ? open : () => void arrangement.setSection("bank", true).then((saved) => { if (saved) open(); })}
        className="pm-control mt-2 rounded border border-line bg-sheet px-3 text-[13px] text-ink hover:bg-selected disabled:opacity-40"
      >
        {area.visible ? `Open ${area.title} on Desk` : `Show ${area.title} on my Desk`}
      </button>
    </section>
  );
}

const OPEN_GATE: SetupGate = { on: true };

/** Detail for a built-in scheduled job (not a saved plan). */
export function LoopDetail({
  loop,
  runs,
  flaggedRunId,
  manualOnly = false,
  next,
  busy,
  disabled,
  recovery,
  nowMs,
  runStartedAt,
  pendingRequest,
  timingOpen,
  deskCount,
  onTimingOpen,
  onRun,
  onToggle,
  onRetune,
  onOpenSetup,
  onOpenDesk,
  registerCloseGuard,
  about,
  switchGate = OPEN_GATE,
  runGate = OPEN_GATE,
}: {
  loop: Loop;
  /** What the job does, from an installed pack (AustinPlanDetail). */
  about?: ReactNode;
  /** Setup's gate for switching this job on or resuming it (`gates.switchOn`).
   * Held with its reason and fix, so the host never has to refuse it. */
  switchGate?: SetupGate;
  /** Setup's gate for running this job now (`gates.runNow`). */
  runGate?: SetupGate;
  /** This job's clock receipts, newest first. */
  runs: readonly LoopRun[];
  /** Shown at the top of the drawer by FlaggedReceipt; not repeated here. */
  flaggedRunId?: string;
  /** Bank review while its automation is unavailable: no run, pause or timing. */
  manualOnly?: boolean;
  next: string;
  busy: boolean;
  disabled: boolean;
  recovery: boolean;
  nowMs: number;
  runStartedAt: number | null;
  pendingRequest?: PendingLoopRequest;
  timingOpen: boolean;
  deskCount: (run: LoopRun) => number;
  onTimingOpen: (open: boolean) => void;
  onRun: () => void;
  onToggle: () => void;
  onRetune: (when: LoopTimingChange) => void;
  onOpenSetup: () => void;
  onOpenDesk: () => void;
  registerCloseGuard: CloseGuardRegistrar;
}) {
  const lastRun = runs[0];
  const activeRun = runs.find((run) => run.status === "queued" || run.status === "running");
  const live = Boolean(activeRun);
  const progressStart = live ? (activeRun!.startedAt ?? activeRun!.createdAt) : busy ? runStartedAt : null;
  const progressElapsed = progressStart != null ? Math.max(0, Math.floor((nowMs - progressStart) / 1_000)) : 0;
  const progress = live || (busy && runStartedAt != null)
    ? loop.id === "morning-arrears"
      ? recheckProgress(progressElapsed)
      : jobRunProgress(progressElapsed, Boolean(loop.waitingForPlan))
    : null;
  const controlsDisabled = busy || disabled;
  // Morning priorities adopts the reviewed agency time; it never uses the generic timing change.
  const spec = evaluatorForLoop(loop.id);
  const agencyTimed = spec?.agencyTimed === true;
  // Pause is never held; switching on, resuming and running are.
  const held = !loop.enabled && !switchGate.on ? switchGate : null;
  // A pending request stays checkable: recovering a lost receipt starts nothing new.
  const runHeld = !pendingRequest && !runGate.on ? runGate : null;
  const switchLabel = loop.enabled ? "Pause" : switchOnLabel(loop.id, runs);
  const heldId = useId();
  const runHeldId = useId();
  // One sentence when both are held for the same reason (link, Bud, AI access).
  const heldShown = held && !manualOnly && !loop.waitingForPlan ? held : null;
  const runNote = runHeld && !manualOnly && runHeld.reason !== heldShown?.reason ? runHeld : null;

  return (
    <article id={`routine-${loop.id}`} tabIndex={-1} aria-label={`${loop.name} details`} className="space-y-4 outline-none">
      <div>
        <p className="text-[12px] font-medium text-ink-muted">Next run</p>
        <p className="text-[15px] text-ink tabular-nums">{next}</p>
        {loop.timezonePaused ? <p className="mt-1 text-[13px] text-hold">Paused — agency timezone does not match this computer</p> : null}
        {recovery ? <p className="mt-1 text-[13px] text-hold">Paused for recovery. Saved results are still available.</p> : null}
      </div>

      {manualOnly ? (
        <p className="text-[14px] text-ink-secondary">Automatic bank downloads are not available yet. You can still review a bank file when you have one.</p>
      ) : <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          key={pendingRequest?.requestId ?? "new-run"}
          onClick={onRun}
          aria-describedby={runHeld ? (runNote ? runHeldId : heldId) : undefined}
          disabled={controlsDisabled || Boolean(runHeld) || (!pendingRequest && !loop.enabled && !loop.waitingForPlan && !spec?.runWhileOff) || (!pendingRequest && Boolean(activeRun))}
          className="pm-decision inline-flex items-center gap-1.5 rounded-lg bg-agency px-4 text-[13px] font-medium text-white hover:bg-agency-hover disabled:opacity-40"
        >
          {busy ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Play size={13} aria-hidden />}
          {pendingRequest ? "Check previous run" : loop.id === "morning-arrears"
            ? "Recheck"
            : loop.waitingForPlan
              ? "Rehearse (nothing is browsed)"
              : "Run now"}
        </button>
        {!loop.waitingForPlan ? (
          <button
            type="button"
            // aria-disabled while saving (the parent's `disabled` includes busy): a disabled
            // button drops keyboard focus out of the drawer, so Escape stops working.
            onClick={busy ? undefined : onToggle}
            disabled={(disabled && !busy) || Boolean(held)}
            aria-disabled={busy || undefined}
            aria-describedby={held ? heldId : undefined}
            title={`${switchLabel} this job`}
            className="pm-control inline-flex items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] text-ink hover:bg-raised disabled:opacity-40 aria-disabled:opacity-40"
          >
            {loop.enabled ? <Pause size={13} aria-hidden /> : <Play size={13} aria-hidden />}
            {switchLabel}
          </button>
        ) : null}
      </div>}
      {heldShown ? <SetupGateNote gate={heldShown} id={heldId} /> : null}
      {runNote ? <SetupGateNote gate={runNote} id={runHeldId} /> : null}
      {progress ? (
        <p role="status" className="text-[13px] text-ink-muted">
          <span className="font-medium text-ink">{progress.label}</span>
          <span> · {progress.reassurance}</span>
          <span className="ml-1 tabular-nums">{progressElapsed}s</span>
        </p>
      ) : null}
      {activeRun?.detail ? <p role="status" className="text-[13px] text-hold">{activeRun.detail}</p> : null}
      {about}

      {/* TODO(phase 4): Change with Bud — Ask cannot apply schedule changes yet (server/schedule-intent.ts redirects). */}
      {manualOnly ? null : agencyTimed ? (
        <div className="border-t border-line pt-3">
          <p className="text-[14px] font-medium text-ink">Timing · {scheduleSummary(loop.schedule)}</p>
          <p className="mt-1 text-[13px] text-ink-muted">This job uses the reviewed morning time and weekdays from agency workflow setup.</p>
          <button type="button" onClick={onOpenSetup} className="pm-control mt-2 rounded border border-line px-3 text-[13px] text-ink hover:bg-selected">Open agency workflow setup</button>
        </div>
      ) : (
        <LoopTiming loop={loop} busy={busy} controlsDisabled={controlsDisabled} open={timingOpen} onOpen={onTimingOpen} onRetune={onRetune} />
      )}
      {loop.id === "inbound-triage" && !manualOnly ? <NewMailSwitch loopId={loop.id} /> : null}

      <section aria-label="Latest result" className="border-t border-line pt-3">
        <h3 className="mb-2 text-[14px] font-medium text-ink">Latest result</h3>
        {!lastRun ? <p className="text-[13px] text-ink-secondary">No results yet.</p>
          : lastRun.id === flaggedRunId ? <p className="text-[13px] text-ink-secondary">This result is at the top, waiting for your review.</p>
          : <LoopRunResult run={lastRun} deskCount={deskCount(lastRun)} onOpenDesk={onOpenDesk} />}
      </section>

      {loop.id === "bank-references" ? <BankReviewPlace registerCloseGuard={registerCloseGuard} /> : null}

      <ExecutionHistory loopId={loop.id} />
    </article>
  );
}
