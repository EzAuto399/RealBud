// Schedule — named product loops on RealBud's clock. A loop is "Desk, but
// the clock pressed Recheck": RealBud owns WHEN, the admitted source route
// and the cards. There is no bot picker, free-text prompt or second clock.
// Nothing sends while nobody is looking.
import { useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleDot,
  Clock,
  Hourglass,
  Loader2,
  Pause,
  Play,
  Sparkles,
} from "lucide-react";

import { cn } from "@/lib/cn";
import { fmtTimeOfDay, whenLabel } from "@/lib/au";
import { buildRoutineCalendarMonth, moveRoutineCalendarMonth } from "@/lib/routine-calendar";
import { liveRoutineOutcome, resolveRoutineDependencies, routineMutationsLocked, routineNeedsAttention, type RoutineDependencyView } from "@/lib/routine-readiness";
import type { Loop, LoopId, LoopRun, LoopRunStatus } from "@/lib/routines";
import { RecoveryNotice } from "./pm";
import { api, useStore } from "@/state/store";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CALENDAR_DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function scheduleLabel(loop: Loop): string {
  const [hour, minute] = loop.schedule.time.split(":").map(Number);
  const days = loop.schedule.weekdays;
  const dayLabel =
    days.length === 7
      ? "Every day"
      : days.join(",") === "1,2,3,4,5"
        ? "Weekdays"
        : days.map((day) => DAY_NAMES[day]).join(", ");
  const time = fmtTimeOfDay(new Date(2000, 0, 1, hour, minute).getTime());
  return `${dayLabel} at ${time}`;
}

/** Day chips are local until Save. Never show the last saved Next as if the unsaved clock already applied. */
export function routineNextCaption(dirty: boolean, nextLabel: string | null): string | null {
  if (dirty) return "Save to set the next run";
  return nextLabel ? `Next: ${nextLabel}` : null;
}

function statusChip(status: LoopRunStatus) {
  switch (status) {
    case "queued":
      return { icon: <Hourglass size={12} />, label: "queued", cls: "text-ink-secondary" };
    case "running":
      return { icon: <Loader2 size={12} className="animate-spin" />, label: "running", cls: "text-accent" };
    case "completed":
      return { icon: <CheckCircle2 size={12} />, label: "done", cls: "text-success" };
    case "failed":
    case "missed":
    case "interrupted":
      return { icon: <CircleAlert size={12} />, label: status, cls: "text-danger" };
  }
}

function dependencyStyle(state: RoutineDependencyView["state"]): string {
  if (state === "ready") return "border-agency/30 bg-selected text-agency";
  if (state === "attention" || state === "blocked") return "border-hold/35 bg-hold/10 text-hold";
  return "border-line bg-paper text-ink-muted";
}

function DependencyIcon({ state }: { state: RoutineDependencyView["state"] }) {
  if (state === "ready") return <CheckCircle2 size={11} />;
  if (state === "attention" || state === "blocked") return <CircleAlert size={11} />;
  return <CircleDot size={11} />;
}

function RoutineCalendar({ loops, onEdit }: { loops: Loop[]; onEdit: (loopId: LoopId) => void }) {
  const today = new Date();
  const [anchor, setAnchor] = useState({ year: today.getFullYear(), month: today.getMonth() });
  const calendar = useMemo(
    () => buildRoutineCalendarMonth(loops, anchor.year, anchor.month),
    [anchor.month, anchor.year, loops],
  );
  const weeks = Array.from({ length: 6 }, (_, index) => calendar.days.slice(index * 7, index * 7 + 7));
  const visibleLoops = loops.filter((loop) => loop.available);
  const move = (delta: number) => setAnchor((current) => moveRoutineCalendarMonth(current.year, current.month, delta));

  return (
    <div className="overflow-hidden rounded-2xl border border-hairline/50 bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline/40 px-4 py-3">
        <div>
          <h3 aria-live="polite" className="text-[15px] font-semibold text-ink">{calendar.label}</h3>
          <p className="mt-0.5 text-[12px] text-ink-secondary">
            Select a routine on the calendar to edit its recurring clock below.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => move(-1)}
            aria-label="Previous month"
            className="pm-tactile rounded-lg border border-hairline/50 bg-sheet p-2 text-ink hover:bg-raised"
          >
            <ChevronLeft size={15} />
          </button>
          <button
            type="button"
            onClick={() => {
              const now = new Date();
              setAnchor({ year: now.getFullYear(), month: now.getMonth() });
            }}
            className="pm-tactile rounded-lg border border-hairline/50 bg-sheet px-3 py-1.5 text-[12px] text-ink hover:bg-raised"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => move(1)}
            aria-label="Next month"
            className="pm-tactile rounded-lg border border-hairline/50 bg-sheet p-2 text-ink hover:bg-raised"
          >
            <ChevronRight size={15} />
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] table-fixed border-collapse">
          <caption className="sr-only">Recurring RealBud routines for {calendar.label}</caption>
          <thead>
            <tr>
              {CALENDAR_DAY_NAMES.map((name) => (
                <th key={name} scope="col" className="border-b border-hairline/40 bg-inset/50 px-2 py-2 text-left text-[10.5px] font-medium uppercase tracking-[0.1em] text-ink-secondary">
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week, weekIndex) => (
              <tr key={week[0].key}>
                {week.map((day, dayIndex) => {
                  const dateLabel = new Date(day.at).toLocaleDateString("en-AU", {
                    weekday: "long",
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  });
                  return (
                    <td
                      key={day.key}
                      aria-label={dateLabel}
                      className={cn(
                        "h-[108px] align-top p-1.5",
                        dayIndex > 0 && "border-l border-hairline/35",
                        weekIndex > 0 && "border-t border-hairline/35",
                        !day.inMonth && "bg-inset/25 text-ink-secondary/45",
                      )}
                    >
                      <span
                        className={cn(
                          "inline-flex size-6 items-center justify-center rounded-full text-[11.5px]",
                          day.today ? "bg-accent font-semibold text-white" : day.inMonth ? "text-ink" : "text-ink-secondary/50",
                        )}
                      >
                        {day.day}
                      </span>
                      {day.occurrences.map((occurrence) => (
                        <button
                          key={occurrence.loopId}
                          type="button"
                          onClick={() => onEdit(occurrence.loopId)}
                          aria-label={`Edit ${occurrence.name}, scheduled ${dateLabel} at ${fmtTimeOfDay(occurrence.at)}`}
                          title={`Edit ${occurrence.name}`}
                          className={cn(
                            "pm-tactile mt-1 block w-full rounded-md px-1.5 py-1 text-left text-[10.5px] leading-tight",
                            !occurrence.enabled || occurrence.timezonePaused
                              ? "border border-hairline/50 bg-inset text-ink-secondary"
                              : occurrence.loopId === "owner-letter"
                                ? "bg-portal/10 text-portal hover:bg-portal/15"
                                : "bg-selected text-agency hover:brightness-95",
                          )}
                        >
                          <span className="block truncate font-medium">{occurrence.name}</span>
                          <span className="block truncate opacity-80">
                            {fmtTimeOfDay(occurrence.at)}
                            {!occurrence.enabled ? " · paused" : occurrence.timezonePaused ? " · timezone hold" : ""}
                          </span>
                        </button>
                      ))}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-hairline/40 px-4 py-2.5 text-[11px] text-ink-secondary">
        {visibleLoops.map((loop) => (
          <button
            key={loop.id}
            type="button"
            onClick={() => onEdit(loop.id)}
            className="pm-tactile flex items-center gap-1.5 rounded-full border border-hairline/45 bg-sheet px-2 py-1 hover:bg-raised"
          >
            <span className={cn("size-2 rounded-full", loop.id === "owner-letter" ? "bg-portal" : "bg-accent")} />
            {loop.name}{!loop.enabled ? " (paused)" : ""}
          </button>
        ))}
        <span className="ml-auto">Calendar dates are a preview; the typed routine controls remain authoritative.</span>
      </div>
    </div>
  );
}

function LoopCard({
  loop,
  lastRun,
  lastRunProduced,
  activeRun,
  dependencies,
  busy,
  controlsDisabled,
  onRun,
  onToggle,
  onRetune,
}: {
  loop: Loop;
  lastRun?: LoopRun;
  lastRunProduced: number;
  activeRun?: LoopRun;
  dependencies: RoutineDependencyView[];
  busy: boolean;
  controlsDisabled: boolean;
  onRun: () => void;
  onToggle: () => void;
  onRetune: (when: { time: string; weekdays: number[] }) => void;
}) {
  const [time, setTime] = useState(loop.schedule.time);
  const [days, setDays] = useState<number[]>(loop.schedule.weekdays);
  useEffect(() => {
    setTime(loop.schedule.time);
    setDays(loop.schedule.weekdays);
  }, [loop.id, loop.revision, loop.schedule.time, loop.schedule.weekdays]);
  const dirty = time !== loop.schedule.time || days.join(",") !== loop.schedule.weekdays.join(",");
  const nextCaption = routineNextCaption(
    dirty,
    loop.available && loop.enabled && loop.nextRunAt ? whenLabel(loop.nextRunAt) : null,
  );
  const dependencyAttention = routineNeedsAttention(dependencies);
  const toggleDay = (day: number) =>
    setDays((prev) => (prev.includes(day) ? (prev.length > 1 ? prev.filter((d) => d !== day) : prev) : [...prev, day].sort((a, b) => a - b)));

  return (
    <article
      id={`routine-${loop.id}`}
      tabIndex={-1}
      aria-label={`${loop.name} routine settings`}
      className={cn("border p-4", loop.available ? "border-line bg-sheet" : "border-dashed border-line bg-paper")}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold text-ink">{loop.name}</span>
            {loop.available ? (
              loop.enabled ? (
                <span className="rounded-full border border-accent/25 bg-accent/10 px-2 py-0.5 text-[12px] text-accent">On</span>
              ) : (
                <span className="rounded-full border border-hairline/50 bg-inset px-2 py-0.5 text-[12px] text-ink-secondary">Paused</span>
              )
            ) : (
              <span className="flex items-center gap-1 rounded-full border border-hairline/50 bg-inset px-2 py-0.5 text-[12px] text-ink-secondary">
                <Sparkles size={10} /> Planned
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-[12px] text-ink-secondary">
            <Clock size={12} />
            {scheduleLabel(loop)}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {activeRun && (
            <span className={cn("flex items-center gap-1.5 rounded-full bg-inset px-2.5 py-1 text-[11px]", statusChip(activeRun.status).cls)}>
              {statusChip(activeRun.status).icon}
              {statusChip(activeRun.status).label}
            </span>
          )}
          {loop.available && (
            <>
              <button
                onClick={onToggle}
                disabled={controlsDisabled}
                title={loop.enabled ? "Pause this routine" : "Resume this routine"}
                className="flex items-center gap-1.5 rounded-xl border border-hairline/50 px-3 py-1.5 text-[12.5px] text-ink hover:bg-raised disabled:opacity-40"
              >
                {loop.enabled ? <Pause size={13} /> : <Play size={13} />}
                {loop.enabled ? "Pause" : "Resume"}
              </button>
              <button
                onClick={onRun}
                disabled={controlsDisabled || !loop.enabled || Boolean(activeRun)}
                className="flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-40"
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                Run now
              </button>
            </>
          )}
        </div>
      </div>
      <p className="mt-2.5 max-w-[52rem] text-[12.5px] leading-relaxed text-ink-secondary">{loop.description}</p>
      {loop.available && !lastRun ? (
        <p className="mt-2 text-[12px] text-ink-muted">This replaces that check after setup. Run now, or wait for the clock.</p>
      ) : loop.available && lastRun ? (
        <p className="mt-2 text-[12px] text-ink-muted">The clock owns this now. Exceptions from the last run stay on Desk.</p>
      ) : null}

      {dependencies.length > 0 ? (
        <div className="mt-3 border-y border-hairline/35 py-2.5">
          <div className="flex flex-wrap items-center gap-1.5" aria-label={`${loop.name} connections and readiness`}>
            <span className="mr-1 text-[12px] font-medium uppercase tracking-[0.1em] text-ink-secondary">Uses</span>
            {dependencies.map((dependency) => (
              <span
                key={dependency.id}
                title={`${dependency.purpose} ${dependency.detail}`}
                className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[12px]", dependencyStyle(dependency.state))}
              >
                <DependencyIcon state={dependency.state} />
                {dependency.label} · {dependency.status}
              </span>
            ))}
          </div>
          {dependencyAttention ? (
            <p className="mt-1.5 text-[12px] leading-relaxed text-ink-muted">
              {dependencyAttention.detail}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* When — the PM owns the clock. A planned loop can be timed now so it
          starts the moment it is built, but it cannot run or turn on yet. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-hairline/30 bg-inset/40 px-3 py-2.5">
        <span className="text-[12px] font-medium uppercase tracking-[0.12em] text-ink-secondary">When</span>
        <input
          type="time"
          value={time}
          disabled={controlsDisabled}
          onChange={(event) => setTime(event.target.value)}
          aria-label={`${loop.name} time of day`}
          className="rounded-lg border border-hairline/50 bg-panel px-2 py-1 text-[13px] text-ink"
        />
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label={`${loop.name} days`}>
          {DAY_NAMES.map((name, day) => {
            const active = days.includes(day);
            const onlySelectedDay = active && days.length === 1;
            return (
              <button
                key={day}
                onClick={() => toggleDay(day)}
                disabled={controlsDisabled || onlySelectedDay}
                aria-pressed={active}
                aria-label={`${onlySelectedDay ? "Keep" : active ? "Remove" : "Add"} ${name} for ${loop.name}`}
                title={onlySelectedDay ? "Keep at least one day" : (active ? "Remove " : "Add ") + name}
                className={cn(
                  "rounded-lg px-2 py-1 text-[12px] transition-colors",
                  active ? "bg-accent font-medium text-white" : "bg-raised text-ink-secondary hover:text-ink",
                  onlySelectedDay && "cursor-not-allowed opacity-55",
                )}
              >
                {name}
              </button>
            );
          })}
        </div>
        {dirty && (
          <button
            onClick={() => onRetune({ time, weekdays: days })}
            disabled={controlsDisabled}
            title={`Save ${scheduleLabel({ ...loop, schedule: { type: "daily", time, weekdays: days } })}`}
            className="ml-auto flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-40"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
            Save
          </button>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-secondary">
        {loop.timezonePaused && (
          <span className="text-warning">Paused — agency timezone does not match this computer</span>
        )}
        {nextCaption ? <span>{nextCaption}</span> : null}
        {lastRun && (
          <span className="flex items-center gap-1.5">
            Last: {whenLabel(lastRun.scheduledFor)} ·{" "}
            <span className={cn("flex items-center gap-1", statusChip(lastRun.status).cls)}>
              {statusChip(lastRun.status).icon}
              {statusChip(lastRun.status).label}
            </span>
          </span>
        )}
        {lastRun?.status === "completed" ? (
          <span className="min-w-0 basis-full truncate" title={lastRun.detail ?? liveRoutineOutcome(lastRunProduced)}>
            “{liveRoutineOutcome(lastRunProduced)}”
          </span>
        ) : lastRun?.detail ? (
          <span className="min-w-0 basis-full truncate" title={lastRun.detail}>“{lastRun.detail}”</span>
        ) : null}
      </div>
    </article>
  );
}

function runStepStyle(status: NonNullable<LoopRun["steps"]>[number]["status"]): string {
  if (status === "completed") return "border-agency/30 bg-selected text-agency";
  if (status === "failed" || status === "interrupted") return "border-danger/30 bg-danger/10 text-danger";
  return "border-line bg-paper text-ink-muted";
}

function RunReceipt({
  run,
  produced,
  unseen,
  expanded,
  attention,
  onToggle,
  onOpenDesk,
  onReview,
}: {
  run: LoopRun;
  produced: number;
  unseen: boolean;
  expanded: boolean;
  attention: RoutineDependencyView | null;
  onToggle: () => void;
  onOpenDesk: () => void;
  onReview: () => void;
}) {
  const chip = statusChip(run.status);
  const hasReceipt = Boolean(run.steps?.length);
  const reviewLabel = attention?.setupTarget === "worker"
    ? "Review worker"
    : attention?.setupTarget === "connections"
      ? "Review connections"
      : "Review Desk";
  return (
    <article className={cn("border bg-panel", unseen ? "border-danger/35" : "border-hairline/45")}>
      <div className="flex min-w-0 flex-wrap items-center gap-2 px-3.5 py-2.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="pm-tactile flex min-w-[16rem] flex-1 items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-agency/50"
        >
          <ChevronDown size={14} className={cn("shrink-0 transition-transform", expanded && "rotate-180")} />
          <span className={cn("flex shrink-0 items-center gap-1.5 text-[12px]", chip.cls)}>{chip.icon}{chip.label}</span>
          <span className="truncate text-[13px] font-medium text-ink">{run.loopName}</span>
          {run.manual ? <span className="rounded bg-inset px-1.5 py-0.5 text-[12px] text-ink-secondary">manual</span> : null}
          <span className="shrink-0 text-[12px] text-ink-secondary">{whenLabel(run.scheduledFor)}</span>
          {unseen ? <span className="size-2 shrink-0 rounded-full bg-danger" aria-label="Unseen failure" /> : null}
        </button>
        {attention && ["failed", "missed", "interrupted"].includes(run.status) ? (
          <button type="button" onClick={onReview} className="pm-control pm-tactile rounded border border-hold/40 bg-hold/10 px-2.5 text-[12px] font-medium text-hold hover:bg-hold/15">
            {reviewLabel}
          </button>
        ) : null}
        <button type="button" onClick={onOpenDesk} className="pm-control pm-tactile rounded border border-line bg-sheet px-2.5 text-[12px] font-medium text-ink hover:border-agency/55">
          {produced ? `${produced} on Desk` : "Open Desk"}
        </button>
      </div>
      {expanded ? (
        <div className="border-t border-hairline/40 px-4 py-3">
          {hasReceipt ? (
            <ol className="space-y-2" aria-label={`${run.loopName} run receipt`}>
              {run.steps!.map((step) => (
                <li key={step.id} className="grid gap-1 sm:grid-cols-[9rem_1fr] sm:gap-3">
                  <span className={cn("inline-flex w-fit items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium", runStepStyle(step.status))}>
                    {step.status === "completed" ? <CheckCircle2 size={11} /> : step.status === "running" ? <Loader2 size={11} className="animate-spin" /> : <CircleAlert size={11} />}
                    {step.status}
                  </span>
                  <div>
                    <div className="text-[12.5px] font-medium text-ink">{step.label}</div>
                    {step.detail ? <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-muted">{step.detail}</p> : null}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-[12px] text-ink-muted">This is a legacy run. It has a final result but no phase receipt.</p>
          )}
          {run.status === "completed" || run.detail ? (
            <p className="mt-3 border-t border-line/70 pt-2 text-[12px] leading-relaxed text-ink-muted">
              Outcome: {run.status === "completed" ? liveRoutineOutcome(produced) : run.detail}
            </p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function RoutinesPage() {
  const { state, dispatch } = useStore();
  const [busy, setBusy] = useState<LoopId | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [monthPreviewOpen, setMonthPreviewOpen] = useState(false);
  const routineRecoveryActive = routineMutationsLocked({
    deskRecovery: Boolean(state.desk?.recovery?.active),
    localIssues: state.config?.localRecovery?.issues,
  });

  const runNow = async (loop: Loop) => {
    if (routineRecoveryActive) return;
    setBusy(loop.id);
    setError("");
    setNotice("");
    try {
      await api(`/api/loops/${loop.id}/run`, { method: "POST" });
      const desk = await api("/api/desk");
      dispatch({ type: "deskSnapshot", snapshot: desk });
      dispatch({ type: "showDesk" });
      setNotice(`${loop.name} started. Exceptions are on Desk.`);
    } catch (cause) {
      try {
        const current = await api("/api/loops");
        dispatch({ type: "loopsHydrated", loops: current.loops, runs: current.runs ?? [] });
      } catch {
        // Preserve the mutation error; the normal store poll retries state.
      }
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (loop: Loop) => {
    if (routineRecoveryActive) return;
    setBusy(loop.id);
    setError("");
    setNotice("");
    try {
      const { loop: patched } = await api(`/api/loops/${loop.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !loop.enabled, expectedRevision: loop.revision }),
      });
      dispatch({ type: "loopPatched", loop: patched });
      setNotice(`${loop.name} ${patched.enabled ? "resumed" : "paused"}.`);
    } catch (cause) {
      try {
        const current = await api("/api/loops");
        dispatch({ type: "loopsHydrated", loops: current.loops, runs: current.runs ?? [] });
      } catch {
        // Preserve the mutation error; the normal store poll retries state.
      }
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const retune = async (loop: Loop, when: { time: string; weekdays: number[] }) => {
    if (routineRecoveryActive) return;
    setBusy(loop.id);
    setError("");
    setNotice("");
    try {
      const { loop: patched } = await api(`/api/loops/${loop.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...when, expectedRevision: loop.revision }),
      });
      dispatch({ type: "loopPatched", loop: patched });
      setNotice(`${loop.name} saved: ${scheduleLabel(patched)}.`);
    } catch (cause) {
      try {
        const current = await api("/api/loops");
        dispatch({ type: "loopsHydrated", loops: current.loops, runs: current.runs ?? [] });
      } catch {
        // Preserve the mutation error; the normal store poll retries state.
      }
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const lastRunByLoop = new Map<string, LoopRun>();
  for (const run of state.loopRuns) {
    if (!lastRunByLoop.has(run.loopId)) lastRunByLoop.set(run.loopId, run);
  }
  const activeByLoop = new Map<string, LoopRun>();
  for (const run of state.loopRuns) {
    if (["queued", "running"].includes(run.status)) activeByLoop.set(run.loopId, run);
  }
  const dependenciesByLoop = new Map<LoopId, RoutineDependencyView[]>();
  for (const loop of state.loops) {
    dependenciesByLoop.set(loop.id, resolveRoutineDependencies(loop, { desk: state.desk }));
  }
  const unseenFailures = state.loopRuns.filter((run) => ["failed", "missed", "interrupted"].includes(run.status) && !run.seenAt);
  const focusRoutine = (loopId: LoopId) => {
    const target = document.getElementById(`routine-${loopId}`);
    if (!target) return;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    target.focus({ preventScroll: true });
  };

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-app">
      <header className="shrink-0 px-5 pb-4 pt-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2.5">
              <CalendarDays size={21} className="text-accent" />
              <h1 className="pm-screen-title text-ink">Schedule</h1>
            </div>
            <p className="mt-1 max-w-[52rem] text-[12.5px] text-ink-muted">
              After setup, Morning money and Friday letters replace those desk checks. Exceptions land on Desk.
            </p>
          </div>
          {unseenFailures.length > 0 && (
            <span className="flex items-center gap-1.5 rounded-full border border-danger/25 bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger">
              <CircleAlert size={12} />
              {unseenFailures.length} need attention
            </span>
          )}
        </div>
        {state.desk?.recovery?.active ? (
          <div className="mt-3">
            <RecoveryNotice>Desk is in recovery. Named routines are paused. The clock will not Recheck or mint a browser session.</RecoveryNotice>
          </div>
        ) : null}
        {state.config?.localRecovery?.issues.some((issue) => issue.area === "routine clock" && issue.action === "attention") ? (
          <div className="mt-3">
            <RecoveryNotice>Routine state could not be verified. Every clock is paused and the original state was preserved; review Recovery in You.</RecoveryNotice>
          </div>
        ) : null}
        {notice && (
          <div role="status" aria-live="polite" className="mt-3 flex items-start gap-2 rounded border border-agency/30 bg-selected px-3 py-2.5 text-[13px] text-agency">
            <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
            {notice}
          </div>
        )}
        {error && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-[13px] text-danger">
            <CircleAlert size={16} className="mt-0.5 shrink-0" />
            {error}
          </div>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
        <section className="space-y-3">
          <h2 className="text-[12px] font-semibold text-ink">Routines</h2>
          {state.loops.map((loop) => (
            <LoopCard
              // revision in the key: an accepted clock change anywhere
              // rebuilds the editor from server truth instead of stale state
              key={`${loop.id}:${loop.revision}`}
              loop={loop}
              lastRun={lastRunByLoop.get(loop.id)}
              lastRunProduced={(state.desk?.book?.cases ?? []).filter((item) => item.origin?.runId === lastRunByLoop.get(loop.id)?.id).length}
              activeRun={activeByLoop.get(loop.id)}
              dependencies={dependenciesByLoop.get(loop.id) ?? []}
              busy={busy === loop.id}
              controlsDisabled={routineRecoveryActive || busy !== null}
              onRun={() => void runNow(loop)}
              onToggle={() => void toggle(loop)}
              onRetune={(when) => void retune(loop, when)}
            />
          ))}
        </section>

        <section className="mt-8 space-y-3">
          <h2 className="text-[12px] font-semibold text-ink">Runs</h2>
          {state.loopRuns.length === 0 ? (
            <div className="rounded-2xl border border-hairline/40 bg-panel px-4 py-6 text-[13.5px] text-ink-secondary">
              No runs yet. The first routine result lands here when the clock — or you — press Recheck.
            </div>
          ) : (
            <div className="space-y-1.5">
              {state.loopRuns.slice(0, 15).map((run) => {
                const unseen = ["failed", "missed", "interrupted"].includes(run.status) && !run.seenAt;
                const produced = (state.desk?.book?.cases ?? []).filter((item) => item.origin?.runId === run.id).length;
                const attention = routineNeedsAttention(dependenciesByLoop.get(run.loopId) ?? []);
                const markSeen = () => {
                  if (unseen) dispatch({ type: "markLoopRunSeen", runId: run.id });
                };
                const review = () => {
                  markSeen();
                  if (attention?.setupTarget === "worker") dispatch({ type: "showYou", focus: "worker" });
                  else if (attention?.setupTarget === "connections") dispatch({ type: "showYou", focus: "connections" });
                  else dispatch({ type: "showDesk" });
                };
                return (
                  <RunReceipt
                    key={run.id}
                    run={run}
                    produced={produced}
                    unseen={unseen}
                    expanded={expandedRunId === run.id}
                    attention={attention}
                    onToggle={() => {
                      markSeen();
                      setExpandedRunId((current) => current === run.id ? null : run.id);
                    }}
                    onOpenDesk={() => {
                      markSeen();
                      dispatch({ type: "showDesk" });
                    }}
                    onReview={review}
                  />
                );
              })}
            </div>
          )}
          <p className="text-[12px] text-ink-secondary/70">
            The clock is RealBud's. A routine presses Desk Recheck — it never sends while nobody is looking.
          </p>
          <div className="pt-2">
            <button
              type="button"
              aria-expanded={monthPreviewOpen}
              onClick={() => setMonthPreviewOpen((open) => !open)}
              className="text-[12px] font-medium text-ink-muted hover:text-ink hover:underline"
            >
              {monthPreviewOpen ? "Hide month" : "Preview month"}
            </button>
            {monthPreviewOpen ? (
              <div className="mt-3">
                <RoutineCalendar loops={state.loops} onEdit={focusRoutine} />
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}
