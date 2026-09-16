import { useScheduleTiming, useWorkspaceScroll, useWorkspaceViewState } from "@/lib/workspace-view-state";
import { openDeskTasks } from "@/lib/desk-view-state";
// Schedule owns taught job plans, starter routines and their results.
// All execution still uses RealBud's existing clock and approval boundaries.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  Clock,
  Hourglass,
  Loader2,
  Pause,
  Play,
} from "lucide-react";

import { cn } from "@/lib/cn";
import { whenLabel } from "@/lib/au";
import { morningBrief } from "@/lib/morning-brief";
import type { JobRun, Recipe } from "@/lib/desk";
import {
  findRecipeForLoop,
  recipeHasPortalCapability,
} from "@/lib/portal-job";
import type { Loop, LoopId, LoopRun, LoopRunStatus } from "@/lib/routines";
import { DAY_NAMES, producedByRunId, scheduleSummary, WEEKDAYS_MON_FIRST, type WeekSlot } from "@/lib/schedule-week";
import { attendedRunLabel, latestAttendedFor, loopRunStatusLabel, queuedAttended } from "@/lib/job-run";
import { jobRunProgress, recheckProgress } from "@/lib/task-progress";
import { RecoveryNotice, StatusLabel } from "./pm";
import { PortalJobActions } from "./schedule/PortalJobActions";
import { MonthCalendar } from "./schedule/MonthCalendar";
import { WeekCalendar } from "./schedule/WeekCalendar";
import { api, useStore } from "@/state/store";
import { jobPlanFields } from "@/lib/job-plan";
import { hasUnfinishedJobDraft } from "@/lib/work-continuation";
import { buildWorkActivity, routineRunsForActivity } from "@/lib/work-activity";
import { JobWorkspace } from "./schedule/JobWorkspace";
import { WorkflowPacksCard } from "./schedule/WorkflowPacksCard";
import { JobRunFeed } from "./desk/JobRunFeed";
import { beginLoopRequest, pendingLoopRequest, resumeLoopRequest, confirmLoopReceipt, rejectLoopRequest, type PendingLoopRequest } from "@/lib/manual-loop-request";

function RunStatus({ status }: { status: LoopRunStatus }) {
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

function LoopCard({
  loop,
  lastRun,
  activeRun,
  busy,
  disabled,
  selected,
  retuneOpen,
  nowMs,
  runStartedAt,
  onRun,
  pendingRequest,
  recovery,
  onToggle,
  onRetune,
  onRetuneOpen,
  onReview,
  recipe,
  jobRuns,
  onRecipe,
  onJobRun,
  onShowAsk,
}: {
  loop: Loop;
  lastRun?: LoopRun;
  activeRun?: LoopRun;
  busy: boolean;
  disabled: boolean;
  selected: boolean;
  retuneOpen: boolean;
  nowMs: number;
  runStartedAt: number | null;
  onRun: () => void;
  pendingRequest?: PendingLoopRequest;
  recovery: boolean;
  onToggle: () => void;
  onRetune: (when: { time: string; weekdays: number[] }) => void;
  onRetuneOpen: (open: boolean) => void;
  onReview: () => void;
  recipe?: Recipe;
  jobRuns?: readonly JobRun[];
  onRecipe?: (recipe: Recipe) => void;
  onJobRun?: (run: JobRun) => void;
  onShowAsk?: () => void;
}) {
  const { time, setTime, days, setDays } = useScheduleTiming(loop.id, loop.schedule.time, loop.schedule.weekdays);
  const savedDays = loop.schedule.weekdays.join(",");
  const dirty = time !== loop.schedule.time || days.join(",") !== savedDays;
  const toggleDay = (day: number) =>
    setDays((prev) => (prev.includes(day) ? (prev.length > 1 ? prev.filter((d) => d !== day) : prev) : [...prev, day].sort((a, b) => a - b)));
  const live = Boolean(activeRun && (activeRun.status === "queued" || activeRun.status === "running"));
  const progressStart = live
    ? (activeRun!.startedAt ?? activeRun!.createdAt)
    : busy
      ? runStartedAt
      : null;
  const progressElapsed = progressStart != null ? Math.max(0, Math.floor((nowMs - progressStart) / 1_000)) : 0;
  const progress = live || (busy && runStartedAt != null)
    ? loop.id === "morning-arrears"
      ? recheckProgress(progressElapsed)
      : jobRunProgress(progressElapsed, Boolean(loop.waitingForPlan))
    : null;
  const resultRun = live ? activeRun : lastRun;
  const attended = recipe && jobRuns ? queuedAttended(jobRuns, recipe.id) ?? latestAttendedFor(jobRuns, recipe.id) : undefined;
  const attendedChip = attended ? attendedRunLabel(attended) : null;
  const isTaughtJob = Boolean(recipe);
  const controlsDisabled = busy || disabled;

  const content = (
    <article
      id={`routine-${loop.id}`}
      tabIndex={-1}
      className={cn(
        "min-w-0 rounded-lg border p-4",
        loop.available ? "border-line bg-sheet" : "border-dashed border-line bg-sheet/70",
        selected && "border-agency bg-selected",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-semibold text-ink">{loop.name}</span>
            {loop.available ? (
              recovery ? <StatusLabel tone="hold">Paused for recovery</StatusLabel> : loop.waitingForPlan ? (
                <StatusLabel tone="hold">Review plan</StatusLabel>
              ) : loop.enabled ? (
                <StatusLabel tone="agency">On</StatusLabel>
              ) : (
                <StatusLabel tone="muted">Paused</StatusLabel>
              )
            ) : (
              <StatusLabel tone="muted" title="Declared for later. Not broken — this build cannot run it yet.">
                Planned
              </StatusLabel>
            )}
          </div>
          {loop.available && loop.enabled && loop.nextRunAt ? (
            <div className="mt-1 flex items-center gap-1.5 text-[12px] text-ink-muted">
              <Clock size={12} aria-hidden />
              Next {whenLabel(loop.nextRunAt)}
            </div>
          ) : loop.timezonePaused ? (
            <p className="mt-1 text-[12px] text-hold">Paused — agency timezone does not match this computer</p>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {/* The attended state sits beside Run beside me (PortalJobActions);
              a second pill in the header said the same thing twice. */}
          {recipe && !loop.waitingForPlan ? <button type="button" onClick={onReview} disabled={controlsDisabled} className="pm-control rounded border border-line px-3 text-[13px] text-ink hover:bg-selected disabled:opacity-40">Edit job</button> : null}
          {!attendedChip && resultRun ? <RunStatus status={resultRun.status} /> : null}
          {loop.available && (
            <>
              {loop.waitingForPlan ? (
                <button
                  type="button"
                  onClick={onReview}
                  disabled={controlsDisabled}
                  className="pm-control inline-flex items-center gap-1.5 rounded-lg border border-hold/30 bg-hold/5 px-3 text-[12.5px] text-hold hover:bg-hold/10 disabled:opacity-40"
                >
                  <CheckCircle2 size={13} aria-hidden />
                  Review plan
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onToggle}
                  disabled={controlsDisabled}
                  title={loop.enabled ? "Pause this routine" : "Resume this routine"}
                  className="pm-control inline-flex items-center gap-1.5 rounded-lg border border-line px-3 text-[12.5px] text-ink hover:bg-raised disabled:opacity-40"
                >
                  {loop.enabled ? <Pause size={13} aria-hidden /> : <Play size={13} aria-hidden />}
                  {loop.enabled ? "Pause" : "Resume"}
                </button>
              )}
              <button
                type="button"
                key={pendingRequest?.requestId ?? "new-run"}
                onClick={onRun}
                disabled={controlsDisabled || (!pendingRequest && !loop.enabled && !loop.waitingForPlan) || (!pendingRequest && Boolean(activeRun))}
                className={
                  isTaughtJob
                    ? "pm-control inline-flex items-center gap-1.5 rounded-lg border border-line px-3.5 text-[12.5px] text-ink hover:bg-raised disabled:opacity-40"
                    : "pm-control inline-flex items-center gap-1.5 rounded-lg bg-agency px-3.5 text-[12.5px] font-medium text-white hover:bg-agency-hover disabled:opacity-40"
                }
              >
                {busy ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Play size={13} aria-hidden />}
                {pendingRequest ? "Check previous run" : loop.id === "morning-arrears"
                  ? "Recheck"
                  : loop.waitingForPlan
                    ? "Rehearse (nothing is browsed)"
                    : isTaughtJob
                      ? "Prepare now"
                      : "Run now"}
              </button>
            </>
          )}
        </div>
      </div>
      {progress ? (
        <p role="status" className="mt-2 text-[13px] text-ink-muted">
          <span className="font-medium text-ink">{progress.label}</span>
          <span> · {progress.reassurance}</span>
          <span className="ml-1 tabular-nums">{progressElapsed}s</span>
        </p>
      ) : null}
      {activeRun?.detail && live ? <p role="status" className="mt-2 text-[13px] text-hold">{activeRun.detail}</p> : null}
      {lastRun?.detail && !progress ? (
        <p className="mt-2 min-w-0 truncate text-[12px] text-ink-muted" title={lastRun.detail}>“{lastRun.detail}”</p>
      ) : null}
      {recipe && recipeHasPortalCapability(recipe) && jobRuns && onRecipe && onJobRun && onShowAsk ? (
        <PortalJobActions
          recipe={recipe}
          runs={jobRuns}
          onRecipe={onRecipe}
          onRun={onJobRun}
          onShowAsk={onShowAsk}
        />
      ) : null}

      {!recipe ? <details
        className="mt-3"
        open={retuneOpen}
        onToggle={(event) => onRetuneOpen(event.currentTarget.open)}
      >
        <summary className="pm-control flex cursor-pointer items-center rounded-lg px-2 text-[13px] font-medium text-ink hover:bg-raised">
          Change time · {scheduleSummary(loop.schedule)}
        </summary>
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-muted">{loop.description}</p>
        {!loop.available ? (
          <p className="mt-2 text-[12px] text-ink-muted">You can choose a time now. This job will stay paused until its steps are ready.</p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-sheet px-3 py-2.5">
          <input
            type="time"
            value={time}
            onChange={(event) => setTime(event.target.value)}
            aria-label={`${loop.name} time of day`}
            className="pm-control rounded-lg border border-line bg-sheet px-2 text-[13px] text-ink"
          />
          <div className="flex min-w-0 flex-wrap items-center gap-1" role="group" aria-label={`${loop.name} days`}>
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
          </div>
          {dirty && (
            <button
              type="button"
              onClick={() => onRetune({ time, weekdays: days })}
              disabled={controlsDisabled}
              title={`Save ${scheduleSummary({ time, weekdays: days })}`}
              className="pm-control ml-auto inline-flex items-center gap-1.5 rounded-lg bg-agency px-3 text-[12px] font-medium text-white hover:bg-agency-hover disabled:opacity-40"
            >
              {busy ? <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <CheckCircle2 size={12} aria-hidden />}
              Save
            </button>
          )}
        </div>
      </details> : <p className="mt-3 text-[13px] text-ink-muted">{scheduleSummary(loop.schedule)} · Change timing in Edit job.</p>}
    </article>
  );
  return loop.available ? content : (
    <details className="rounded-lg border border-line bg-sheet">
      <summary className="cursor-pointer px-4 py-3 text-[13px] text-ink-muted">{loop.name} · not available yet</summary>
      {content}
    </details>
  );
}

export function RoutinesPage({ onSetup, onShowAsk }: { onSetup?: () => void; onShowAsk?: () => void } = {}) {
  const { state, dispatch, refreshHermes } = useStore();
  const mounted = useRef(true);
  const refreshFlight = useRef(0);
  const actionFlight = useRef(false);
  const jobWasBusy = useRef(state.jobDraftBusy);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [jobsError, setJobsError] = useState("");
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [busy, setBusy] = useState<LoopId | null>(null);
  const [error, setError] = useState("");
  const [pauseNotice, setPauseNotice] = useState("");
  const [pendingRequests, setPendingRequests] = useState<Record<string, PendingLoopRequest>>({});
  const [selectedId, setSelectedId] = useWorkspaceViewState("scheduleSelected");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [calendarAnchorMs, setCalendarAnchorMs] = useState(() => Date.now());
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [keptRetune, setKeptRetune] = useWorkspaceViewState("scheduleTiming");
  const [showAllRuns, setShowAllRuns] = useWorkspaceViewState("scheduleResults");
  const scrollRef = useWorkspaceScroll("schedule", !jobsLoading);
  const timezone = state.desk?.book?.agency.timezone || state.desk?.timezone;

  const refreshSchedule = useCallback(async () => {
    const request = ++refreshFlight.current;
    try {
      const [body, jobs, receipts] = await Promise.all([
        api("/api/loops", undefined, { timeoutMs: 15_000 }),
        api("/api/recipes", undefined, { timeoutMs: 15_000 }),
        api("/api/job-runs", undefined, { timeoutMs: 15_000 }),
      ]);
      if (!mounted.current || request !== refreshFlight.current) return;
      dispatch({ type: "loopsHydrated", loops: body.loops ?? [], runs: body.runs ?? [], recovery: body.recovery });
      dispatch({ type: "jobRuns", runs: receipts.runs ?? [] });
      setRecipes(jobs.recipes ?? []);
      setJobsError("");
    } catch (cause) {
      if (!mounted.current || request !== refreshFlight.current) return;
      setJobsError(cause instanceof Error ? cause.message : "Saved jobs could not load. Try again.");
      throw cause;
    } finally {
      if (mounted.current && request === refreshFlight.current) setJobsLoading(false);
    }
  }, [dispatch]);

  useEffect(() => {
    mounted.current = true;
    void refreshSchedule().catch(() => {}); // refreshSchedule displays the failure.
    return () => { mounted.current = false; };
  }, [refreshSchedule]);

  useEffect(() => {
    if (jobWasBusy.current && !state.jobDraftBusy) void refreshSchedule().catch(() => {});
    jobWasBusy.current = state.jobDraftBusy;
  }, [state.jobDraftBusy, refreshSchedule]);

  useEffect(() => {
    const match = /^#job-([\w-]+)$/.exec(location.hash);
    if (!match || jobsLoading || jobsError) return;
    const recipe = recipes.find((item) => item.id === match[1]);
    const draft = state.jobDraft;
    if (state.jobDraftBusy || hasUnfinishedJobDraft(draft)) {
      setError(draft.plan
        ? "Your unfinished plan is still here. Save or cancel its changes, then open the other job below."
        : "Your job description is kept. Build its plan or clear the description before opening another job.");
    } else if (recipe) {
      dispatch({ type: "jobDraft", draft: { text: recipe.description, plan: recipe, fields: jobPlanFields(recipe), saved: true } });
    } else {
      setError("That job is no longer available. Choose a saved job below.");
    }
    history.replaceState(null, "", location.pathname + location.search);
  }, [recipes, jobsLoading, jobsError, dispatch, state.jobDraft, state.jobDraftBusy]);

  useEffect(() => {
    if (jobsLoading) return;
    const hash = location.hash.replace(/^#/, "");
    if (!hash || hash.startsWith("job-")) return;
    const section = document.getElementById(hash);
    if (!section) return;
    requestAnimationFrame(() => {
      section.scrollIntoView({ block: "start" });
      section.focus({ preventScroll: true });
    });
    history.replaceState(null, "", location.pathname + location.search);
  }, [jobsLoading]);

  const liveRun = Boolean(busy) || state.loopRuns.some((run) => run.status === "queued" || run.status === "running");
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), liveRun ? 1_000 : 60_000);
    return () => window.clearInterval(id);
  }, [liveRun]);

  const openJob = (recipe: Recipe) => {
    const draft = state.jobDraft;
    if (state.jobDraftBusy || hasUnfinishedJobDraft(draft)) {
      setError(draft.plan
        ? "Save or cancel the changes in your open plan before opening another job."
        : "Your job description is kept. Build its plan or clear the description before opening another job.");
      return;
    }
    dispatch({ type: "jobDraft", draft: { text: recipe.description, plan: recipe, fields: jobPlanFields(recipe), saved: true } });
    setError("");
    const builder = document.getElementById("bud-job-builder");
    builder?.scrollIntoView({ block: "nearest" });
    builder?.focus({ preventScroll: true });
  };

  const focusRoutine = (id: LoopId) => {
    const recipe = findRecipeForLoop(recipes, id);
    if (recipe) { openJob(recipe); return; }
    setSelectedId(id);
    const card = document.getElementById(`routine-${id}`);
    card?.scrollIntoView({ behavior: "auto", block: "start" });
    card?.focus({ preventScroll: true });
  };

  const loopIds = state.loops.map((loop) => loop.id).join(",");
  const syncPending = useCallback(() => {
    try {
      const pending: Record<string, PendingLoopRequest> = {};
      for (const id of loopIds.split(",").filter(Boolean)) {
        const request = pendingLoopRequest(id);
        if (request) pending[id] = request;
      }
      setPendingRequests(pending);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Run recovery is unavailable."); }
  }, [loopIds]);
  useEffect(() => {
    syncPending();
    window.addEventListener("storage", syncPending);
    return () => window.removeEventListener("storage", syncPending);
  }, [syncPending]);

  const runNow = async (loop: Loop, captured?: PendingLoopRequest) => {
    if (actionFlight.current || !state.connected || state.desk?.recovery?.active || state.scheduleRecovery.active) return;
    actionFlight.current = true;
    setBusy(loop.id);
    setRunStartedAt(Date.now());
    setError("");
    setPauseNotice("");
    let request: PendingLoopRequest | null = null;
    let accepted = false;
    try {
      request = captured ? resumeLoopRequest(loop.id, captured) : beginLoopRequest(loop.id, loop.revision);
      if (!request) {
        await refreshSchedule();
        setPauseNotice("This request was already checked in another window. Results are refreshed.");
        return;
      }
      const { run } = await api(`/api/loops/${loop.id}/run`, { method: "POST", body: JSON.stringify(request) }, { timeoutMs: 15_000 });
      if (!run?.id) throw new Error("This run could not be confirmed. Check previous run before starting more work.");
      accepted = true;
      const finished = confirmLoopReceipt(loop.id, request, run);
      dispatch({ type: "loopRunPatched", run });
      // The durable receipt and live updates own long work. Keep the page usable.
      await refreshSchedule();
      setPauseNotice(finished ? "Previous result found. Review it in Results." : "Bud has the work. You can keep using RealBud; the result will appear here.");
      void refreshHermes();
    } catch (cause) {
      if (request && !accepted) {
        try { rejectLoopRequest(loop.id, request, (cause as { status?: number }).status); }
        catch { /* Keep the original failure visible; pending identity stays saved. */ }
      }
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      actionFlight.current = false;
      if (mounted.current) {
        syncPending();
        setBusy(null);
        setRunStartedAt(null);
      }
    }
  };

  const toggle = async (loop: Loop) => {
    if (actionFlight.current || !state.connected || state.desk?.recovery?.active || state.scheduleRecovery.active) return;
    actionFlight.current = true;
    setBusy(loop.id);
    setError("");
    try {
      const { loop: patched } = await api(`/api/loops/${loop.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !loop.enabled }),
      });
      dispatch({ type: "loopPatched", loop: patched });
      setPauseNotice(loop.enabled ? `${loop.name} paused until you Resume` : `${loop.name} is on again`);
      await refreshSchedule();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      actionFlight.current = false;
      setBusy(null);
    }
  };

  const retune = async (loop: Loop, when: { time: string; weekdays: number[] }) => {
    if (actionFlight.current || !state.connected || state.desk?.recovery?.active || state.scheduleRecovery.active) return;
    actionFlight.current = true;
    setBusy(loop.id);
    setError("");
    try {
      const { loop: patched } = await api(`/api/loops/${loop.id}`, {
        method: "PATCH",
        body: JSON.stringify(when),
      });
      setKeptRetune((ids) => new Set(ids).add(loop.id));
      setPauseNotice(`${loop.name} now runs ${scheduleSummary(when)}`);
      dispatch({ type: "loopPatched", loop: patched });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      actionFlight.current = false;
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
  const unseenFailures = state.loopRuns.filter((run) => ["failed", "missed", "interrupted", "partial", "awaiting-approval"].includes(run.status) && !run.seenAt);
  const activityCount = buildWorkActivity(state.jobRuns, state.loopRuns).length;
  const deskCounts = producedByRunId(state.desk?.book?.cases ?? []);
  const brief = state.desk ? morningBrief(state.desk) : null;
  const weekFacts = {
    runs: state.loopRuns,
    desk: state.desk && brief
      ? {
          lastRunAt: state.desk.lastRunAt,
          hands: state.desk.hands,
          handsDetail: state.desk.handsDetail,
          needsYou: brief.needsYou,
          checkedCount: brief.checkedCount,
          producedByRunId: producedByRunId([...(state.desk.book?.cases ?? []), ...state.desk.workItems]),
        }
      : undefined,
    worker: { lastTest: state.hermes?.lastTest ?? null },
  };
  const calendarLoops = state.scheduleRecovery.active
    ? state.loops.map((loop) => ({ ...loop, enabled: false, nextRunAt: null }))
    : state.loops;

  function selectCalendarSlot(slot: WeekSlot) {
    setCalendarAnchorMs(slot.dayMs);
    if (slot.produced > 0) {
      openDeskTasks();
      dispatch({ type: "showDesk" });
      return;
    }
    if (slot.runId) {
      setShowAllRuns(true);
      const receipt = state.loopRuns.find((run) => run.id === slot.runId);
      const activityId = receipt?.jobRunId ? `activity-job-${receipt.jobRunId}` : `activity-routine-${slot.runId}`;
      requestAnimationFrame(() => {
        const region = document.getElementById("schedule-runs");
        const result = region?.querySelector<HTMLDetailsElement>(`[data-activity-id="${activityId}"]`);
        if (result) {
          result.open = true;
          result.scrollIntoView({ block: "center" });
          result.querySelector("summary")?.focus({ preventScroll: true });
        } else {
          region?.scrollIntoView({ block: "nearest" });
          region?.focus({ preventScroll: true });
        }
      });
      return;
    }
    focusRoutine(slot.loopId);
  }

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-paper">
      <header className="shrink-0 px-5 pb-4 pt-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2.5">
              <CalendarDays size={21} className="text-agency" />
              <h1 className="pm-screen-title text-ink">Schedule</h1>
            </div>
            <p className="mt-1 max-w-[52rem] text-[12.5px] text-ink-muted">
              Create jobs, choose when they run, and review what Bud prepared.
            </p>
          </div>
          {unseenFailures.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setShowAllRuns(true);
                const results = document.getElementById("schedule-runs");
                results?.scrollIntoView({ behavior: "auto", block: "start" });
                results?.focus({ preventScroll: true });
              }}
              className="pm-control inline-flex items-center gap-1.5 rounded-full border border-danger/25 bg-danger/10 px-2.5 text-[12px] text-danger"
            >
              <CircleAlert size={12} aria-hidden />
              {unseenFailures.length} {unseenFailures.length === 1 ? "needs" : "need"} attention
            </button>
          )}
        </div>
        <nav aria-label="Schedule sections" className="mt-3 flex flex-wrap gap-1 border-b border-line pb-3">
          {([
            ["schedule-week", "This week"],
            ["bud-job-builder", "Job plans"],
            ["schedule-runs", `Results${activityCount ? ` (${activityCount})` : ""}`],
            ["schedule-packs", "Import packs"],
          ] as const).map(([id, label]) => (
            <button key={id} type="button" className="pm-control rounded-md px-3 text-[13px] text-ink-muted hover:bg-selected hover:text-ink" onClick={() => {
              const section = document.getElementById(id);
              section?.scrollIntoView({ block: "nearest" });
              section?.focus({ preventScroll: true });
            }}>{label}</button>
          ))}
        </nav>
        {state.scheduleRecovery.active ? (
          <div role="alert" className="mt-3">
            <RecoveryNotice>{state.scheduleRecovery.detail} Results already saved are still available below.</RecoveryNotice>
          </div>
        ) : null}
        {state.desk?.recovery?.active ? (
          <div className="mt-3">
            <RecoveryNotice>The property book needs recovery. Scheduled work is paused; saved results remain available.</RecoveryNotice>
          </div>
        ) : null}
        {error && (
          <div role="alert" className="mt-3 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-[13px] text-danger">
            <CircleAlert size={16} className="mt-0.5 shrink-0" />
            {error}
          </div>
        )}
        {pauseNotice && !error ? (
          <div role="status" className="mt-3 rounded-xl border border-hold/30 bg-hold/10 px-3 py-2.5 text-[13px] text-hold">
            {pauseNotice}
          </div>
        ) : null}
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
        <div id="schedule-week" tabIndex={-1} role="region" aria-label="This week's schedule" className="mb-6">
          <div className="grid gap-4 lg:grid-cols-[minmax(16rem,18rem)_minmax(0,1fr)] lg:items-stretch">
            <MonthCalendar
              loops={calendarLoops}
              nowMs={nowMs}
              timeZone={timezone}
              facts={weekFacts}
              anchorMs={calendarAnchorMs}
              selectedDayMs={calendarAnchorMs}
              onAnchorChange={setCalendarAnchorMs}
              onSelectDay={setCalendarAnchorMs}
            />
            <WeekCalendar
              loops={calendarLoops}
              nowMs={nowMs}
              timeZone={timezone}
              facts={weekFacts}
              deskNote={brief?.headline ?? null}
              selectedId={selectedId}
              anchorMs={calendarAnchorMs}
              onAnchorChange={setCalendarAnchorMs}
              onSelect={selectCalendarSlot}
            />
          </div>
        </div>

        <JobWorkspace onSetup={onSetup} onShowAsk={onShowAsk} recipes={recipes} loading={jobsLoading} loadError={jobsError} timezone={timezone} onRecipes={setRecipes} onRefresh={refreshSchedule} />

        <section className="space-y-3">
          <h2 className="text-[13px] font-medium text-ink-muted">Scheduled jobs</h2>
          {state.loops.filter((loop) => !findRecipeForLoop(recipes, loop.id) || !loop.waitingForPlan).map((loop) => (
            <LoopCard
              key={loop.id}
              loop={loop}
              lastRun={lastRunByLoop.get(loop.id)}
              activeRun={activeByLoop.get(loop.id)}
              busy={busy === loop.id}
              disabled={Boolean(busy) || state.jobDraftBusy || !state.connected || Boolean(state.desk?.recovery?.active) || state.scheduleRecovery.active}
              selected={selectedId === loop.id}
              retuneOpen={keptRetune.has(loop.id)}
              nowMs={nowMs}
              runStartedAt={busy === loop.id ? runStartedAt : null}
              recovery={state.scheduleRecovery.active}
              pendingRequest={pendingRequests[loop.id]}
              onRun={() => void runNow(loop, pendingRequests[loop.id])}
              onToggle={() => void toggle(loop)}
              onRetune={(when) => void retune(loop, when)}
              onRetuneOpen={(open) => {
                setKeptRetune((ids) => {
                  const next = new Set(ids);
                  if (open) next.add(loop.id);
                  else next.delete(loop.id);
                  return next;
                });
              }}
              onReview={() => {
                const recipe = findRecipeForLoop(recipes, loop.id);
                if (recipe) openJob(recipe);
              }}
              recipe={findRecipeForLoop(recipes, loop.id)}
              jobRuns={state.jobRuns}
              onRecipe={(next) => {
                setRecipes((current) => {
                  const exists = current.some((item) => item.id === next.id);
                  return exists ? current.map((item) => (item.id === next.id ? next : item)) : [next, ...current];
                });
              }}
              onJobRun={(run) => dispatch({ type: "jobRun", run })}
              onShowAsk={onShowAsk ?? (() => dispatch({ type: "showAsk" }))}
            />
          ))}
        </section>

        <section id="schedule-runs" tabIndex={-1} aria-label="Results from all jobs" className="mt-8 space-y-3">
          <div>
            <h2 className="text-[15px] font-semibold text-ink">Results from all jobs</h2>
            <p className="mt-1 text-[13px] text-ink-muted">Open a result to read the prepared work, check its sources or continue with Bud.</p>
          </div>
          <JobRunFeed
            limit={showAllRuns ? 50 : 8}
            onOpenResult={(activity) => {
              for (const run of routineRunsForActivity(activity, state.loopRuns)) {
                if (!run.seenAt && ["failed", "missed", "interrupted", "partial"].includes(run.status)) {
                  dispatch({ type: "markLoopRunSeen", runId: run.id });
                }
              }
            }}
            deskResultCount={(activity) => routineRunsForActivity(activity, state.loopRuns)
              .reduce((count, run) => count + (deskCounts[run.id] ?? 0), 0)}
            onOpenDesk={() => {
              openDeskTasks();
              dispatch({ type: "showDesk" });
            }}
          />
          {activityCount > 8 ? (
            <button
              type="button"
              onClick={() => setShowAllRuns((value) => !value)}
              className="pm-control rounded-lg border border-line bg-sheet px-3 text-[13px] text-ink"
            >
              {showAllRuns ? "Show recent 8" : `Show recent ${Math.min(activityCount, 50)}`}
            </button>
          ) : null}
        </section>

        <div className="mt-8">
          <WorkflowPacksCard onInstalled={refreshSchedule} />
        </div>
      </div>
    </main>
  );
}
