// Schedule — named product loops on RealBud's clock. A loop is "Desk, but
// the clock pressed Recheck": RealBud owns WHEN and the cards; Hermes owns
// HOW (headless facts). There is no bot picker, no free-text prompt, and
// never a Hermes cron UI. Nothing sends while nobody is looking.
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
  Sparkles,
} from "lucide-react";

import { cn } from "@/lib/cn";
import { whenLabel } from "@/lib/au";
import { morningBrief } from "@/lib/morning-brief";
import type { JobRun, Recipe } from "@/lib/desk";
import {
  findRecipeForLoop,
  PORTAL_JOB_PATH_COPY,
  recipeNeedsPlanApproval,
  recipeSourceLine,
} from "@/lib/portal-job";
import type { Loop, LoopId, LoopRun, LoopRunStatus } from "@/lib/routines";
import { DAY_NAMES, producedByRunId, recipeScheduleLine, scheduleSummary, WEEKDAYS_MON_FIRST } from "@/lib/schedule-week";
import { attendedRunLabel, latestAttendedFor, loopRunStatusLabel, queuedAttended, runningAttended } from "@/lib/job-run";
import { jobBuildProgress, jobRunProgress, recheckProgress } from "@/lib/task-progress";
import { RecoveryNotice, StatusLabel } from "./pm";
import { PortalJobActions } from "./schedule/PortalJobActions";
import { WeekCalendar } from "./schedule/WeekCalendar";
import { api, useStore } from "@/state/store";

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

function BudJobBuilder({
  timezone,
  onScheduleChanged,
}: {
  timezone?: string;
  onScheduleChanged: () => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"build" | "approve" | "discard" | null>(null);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [buildStartedAt, setBuildStartedAt] = useState<number | null>(null);
  const [buildElapsed, setBuildElapsed] = useState(0);
  const inFlight = useRef(false);
  const pending = [...recipes]
    .filter((recipe) => Boolean(recipe.schedule) && recipeNeedsPlanApproval(recipe))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const draft = (draftId ? recipes.find((recipe) => recipe.id === draftId) : undefined) ?? pending[0] ?? null;

  useEffect(() => {
    let alive = true;
    void api("/api/recipes")
      .then((body: { recipes?: Recipe[] }) => {
        if (!alive) return;
        const next = body.recipes ?? [];
        setRecipes(next);
        if (next.some((recipe) => recipe.schedule && recipeNeedsPlanApproval(recipe))) {
          setNotice("Recovered a saved plan that still needs review. It is not on the clock.");
        }
      })
      .catch((cause) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (busy !== "build" || buildStartedAt == null) return;
    setBuildElapsed(Math.max(0, Math.floor((Date.now() - buildStartedAt) / 1_000)));
    const id = window.setInterval(
      () => setBuildElapsed(Math.max(0, Math.floor((Date.now() - buildStartedAt) / 1_000))),
      1_000,
    );
    return () => window.clearInterval(id);
  }, [busy, buildStartedAt]);

  const build = async () => {
    const outcome = text.trim();
    if (!outcome || inFlight.current) return;
    inFlight.current = true;
    setBusy("build");
    setBuildStartedAt(Date.now());
    setBuildElapsed(0);
    setError("");
    setNotice("");
    try {
      const shaped = await api("/api/recipes/draft", {
        method: "POST",
        body: JSON.stringify({ text: outcome }),
      }) as { draft?: Recipe };
      if (!shaped.draft) throw new Error("Bud did not return a usable job plan.");
      if (!shaped.draft.schedule) {
        setNotice("Bud understood the outcome but not when it should run. Add a day and time, then build it again.");
        return;
      }
      const saved = await api("/api/recipes", {
        method: "POST",
        body: JSON.stringify({ draft: shaped.draft }),
      }) as { recipes?: Recipe[] };
      const recipe = saved.recipes?.find((item) => item.id === shaped.draft!.id);
      if (!recipe) throw new Error("RealBud could not save that job plan.");
      setRecipes(saved.recipes ?? [recipe]);
      setDraftId(recipe.id);
      setNotice("Plan built in shadow mode. Review it once before RealBud adds it to the clock.");
      await onScheduleChanged().catch(() => {
        setNotice("Plan saved in shadow mode. Reload Schedule if the new clock card does not appear yet.");
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      setBusy(null);
      setBuildStartedAt(null);
    }
  };

  const approve = async () => {
    if (!draft?.schedule || inFlight.current) return;
    inFlight.current = true;
    setBusy("approve");
    setError("");
    try {
      const body = await api(`/api/recipes/${draft.id}`, {
        method: "PATCH",
        body: JSON.stringify({ planApproved: true, status: "active" }),
      }) as { recipes?: Recipe[] };
      const approved = body.recipes?.find((item) => item.id === draft.id);
      if (!approved) throw new Error("RealBud could not approve that job plan.");
      setRecipes(body.recipes ?? [approved]);
      setDraftId(approved.id);
      setNotice("Scheduled. RealBud owns the clock; Bud prepares the work and holds every consequential next step.");
      await onScheduleChanged().catch(() => {
        setNotice("Scheduled. Reload Schedule if the new clock card does not appear yet.");
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  const discard = async () => {
    if (!draft || inFlight.current) return;
    if (!draft.schedule || draft.planApprovedAt == null) {
      inFlight.current = true;
      setBusy("discard");
      setError("");
      try {
        if (draft.schedule) await api(`/api/recipes/${draft.id}`, { method: "DELETE" });
        setRecipes((current) => current.filter((recipe) => recipe.id !== draft.id));
        setDraftId(null);
        setNotice("");
        await onScheduleChanged().catch(() => {
          setNotice("The plan was removed. Reload Schedule if its card is still visible.");
        });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        inFlight.current = false;
        setBusy(null);
      }
      return;
    }
    setDraftId(null);
    setText("");
    setNotice("");
  };

  const approved = Boolean(draft?.planApprovedAt && draft.approvedRevision === draft.revision && draft.status === "active");

  return (
    <section id="bud-job-builder" tabIndex={-1} className="mb-6 rounded-xl border border-agency/20 bg-sheet p-4" aria-labelledby="bud-new-job-title">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-agency/10 text-agency">
          <Sparkles size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="bud-new-job-title" className="text-[15px] font-semibold text-ink">Give Bud any recurring job</h2>
          <p className="mt-0.5 max-w-[50rem] text-[12.5px] leading-relaxed text-ink-muted">
            {PORTAL_JOB_PATH_COPY}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="min-w-0 flex-1 text-[12px] font-medium text-ink-secondary">
          Outcome and timing
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={2}
            maxLength={4_000}
            disabled={Boolean(busy) || Boolean(draft)}
            placeholder="Every weekday at 7:30 am, check the current arrears facts, prepare safe follow-ups, and put only decisions on Desk."
            className="mt-1.5 w-full resize-y rounded-lg border border-line bg-sheet px-3 py-2 text-[13px] leading-relaxed text-ink focus:border-agency disabled:opacity-60"
          />
        </label>
        <button
          type="button"
          disabled={Boolean(busy) || !text.trim() || Boolean(draft)}
          onClick={() => void build()}
          className="pm-control inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg bg-agency px-3.5 text-[12.5px] font-medium text-white hover:bg-agency-hover disabled:opacity-40"
        >
          {busy === "build" ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none" /> : <Sparkles size={13} />}
          Let Bud build it
        </button>
      </div>

      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
      {notice ? <p role="status" className="mt-2 text-[12px] text-ink-secondary">{notice}</p> : null}
      {busy === "build" ? (
        <div role="status" className="mt-2 rounded-lg border border-agency/20 bg-agency/5 px-3 py-2 text-[12px] text-ink-secondary">
          <span className="font-medium text-ink">{jobBuildProgress(buildElapsed).label}</span>
          <span> · {jobBuildProgress(buildElapsed).reassurance}</span>
          <span className="ml-1 tabular-nums text-ink-muted">{buildElapsed}s</span>
        </div>
      ) : null}

      {draft ? (
        <div className="mt-3 rounded-lg border border-line bg-inset/40 px-3.5 py-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <div className="text-[13.5px] font-semibold text-ink">{draft.title}</div>
              <div className="mt-0.5 text-[11.5px] text-ink-muted">
                {draft.schedule ? recipeScheduleLine(draft.schedule, timezone) : "Timing not found"}
              </div>
            </div>
            <StatusLabel tone={approved ? "agency" : "hold"}>
              {approved ? "On the clock" : draft.schedule ? "Needs one approval" : "Needs timing"}
            </StatusLabel>
          </div>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-[12px] leading-relaxed text-ink-secondary">
            {draft.steps.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}
          </ol>
          <dl className="mt-3 grid gap-1.5 rounded-lg border border-line/70 bg-sheet px-3 py-2 text-[11.5px] leading-relaxed">
            <div><dt className="inline font-medium text-ink">Sources: </dt><dd className="inline text-ink-muted">{recipeSourceLine(draft)}</dd></div>
            <div><dt className="inline font-medium text-ink">Success evidence: </dt><dd className="inline text-ink-muted">{draft.evidence || "Each completed step leaves a receipt"}</dd></div>
            <div><dt className="inline font-medium text-ink">If a source misses: </dt><dd className="inline text-ink-muted">Stop, name the miss, and leave the exception visible.</dd></div>
            <div><dt className="inline font-medium text-ink">Authority: </dt><dd className="inline text-ink-muted">Prepare only — never send, pay, submit, dispatch, or issue a notice.</dd></div>
          </dl>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {draft.schedule && !approved ? (
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void approve()}
                className="pm-control inline-flex items-center gap-1.5 rounded-lg bg-agency px-3 text-[12.5px] font-medium text-white hover:bg-agency-hover disabled:opacity-40"
              >
                {busy === "approve" ? <Loader2 size={12} className="animate-spin motion-reduce:animate-none" /> : <CheckCircle2 size={12} />}
                Approve plan and schedule
              </button>
            ) : null}
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={() => void discard()}
              className="pm-control rounded-lg px-3 text-[12px] text-ink-muted hover:bg-raised hover:text-ink disabled:opacity-40"
            >
              {busy === "discard" ? "Removing…" : approved ? "Build another" : "Discard"}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function LoopCard({
  loop,
  lastRun,
  activeRun,
  busy,
  selected,
  retuneOpen,
  nowMs,
  runStartedAt,
  onRun,
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
  selected: boolean;
  retuneOpen: boolean;
  nowMs: number;
  runStartedAt: number | null;
  onRun: () => void;
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
  const [time, setTime] = useState(loop.schedule.time);
  const [days, setDays] = useState<number[]>(loop.schedule.weekdays);
  const savedDays = loop.schedule.weekdays.join(",");
  useEffect(() => {
    setTime(loop.schedule.time);
    setDays(loop.schedule.weekdays);
    // savedDays is the joined weekday key; avoid resetting while the PM is still editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- weekdays compared by savedDays
  }, [loop.schedule.time, savedDays]);
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
  const progress = live || busy
    ? loop.id === "morning-arrears"
      ? recheckProgress(progressElapsed)
      : jobRunProgress(progressElapsed, Boolean(loop.waitingForPlan))
    : null;
  const resultRun = live ? activeRun : lastRun;
  const attended = recipe && jobRuns ? queuedAttended(jobRuns, recipe.id) ?? latestAttendedFor(jobRuns, recipe.id) : undefined;
  const attendedChip = attended ? attendedRunLabel(attended) : null;
  const isTaughtJob = Boolean(recipe);

  return (
    <article
      id={`routine-${loop.id}`}
      tabIndex={-1}
      className={cn(
        "min-w-0 rounded-xl border p-4",
        loop.available ? "border-line bg-sheet" : "border-dashed border-line bg-sheet/70",
        selected && "border-agency bg-selected",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-semibold text-ink">{loop.name}</span>
            {loop.available ? (
              loop.waitingForPlan ? (
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
          {attendedChip ? (
            <StatusLabel tone={attendedChip.tone}>{attendedChip.label}</StatusLabel>
          ) : resultRun ? (
            <RunStatus status={resultRun.status} />
          ) : null}
          {loop.available && (
            <>
              {loop.waitingForPlan ? (
                <button
                  type="button"
                  onClick={onReview}
                  disabled={busy}
                  className="pm-control inline-flex items-center gap-1.5 rounded-lg border border-hold/30 bg-hold/5 px-3 text-[12.5px] text-hold hover:bg-hold/10 disabled:opacity-40"
                >
                  <CheckCircle2 size={13} aria-hidden />
                  Review plan
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onToggle}
                  disabled={busy}
                  title={loop.enabled ? "Pause this routine" : "Resume this routine"}
                  className="pm-control inline-flex items-center gap-1.5 rounded-lg border border-line px-3 text-[12.5px] text-ink hover:bg-raised disabled:opacity-40"
                >
                  {loop.enabled ? <Pause size={13} aria-hidden /> : <Play size={13} aria-hidden />}
                  {loop.enabled ? "Pause" : "Resume"}
                </button>
              )}
              <button
                type="button"
                onClick={onRun}
                disabled={busy || (!loop.enabled && !loop.waitingForPlan) || Boolean(activeRun)}
                className={
                  isTaughtJob
                    ? "pm-control inline-flex items-center gap-1.5 rounded-lg border border-line px-3.5 text-[12.5px] text-ink hover:bg-raised disabled:opacity-40"
                    : "pm-control inline-flex items-center gap-1.5 rounded-lg bg-agency px-3.5 text-[12.5px] font-medium text-white hover:bg-agency-hover disabled:opacity-40"
                }
              >
                {busy ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Play size={13} aria-hidden />}
                {loop.id === "morning-arrears"
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
      {lastRun?.detail && !progress ? (
        <p className="mt-2 min-w-0 truncate text-[12px] text-ink-muted" title={lastRun.detail}>“{lastRun.detail}”</p>
      ) : null}
      {recipe && jobRuns && onRecipe && onJobRun && onShowAsk ? (
        <PortalJobActions
          recipe={recipe}
          runs={jobRuns}
          onRecipe={onRecipe}
          onRun={onJobRun}
          onShowAsk={onShowAsk}
        />
      ) : null}

      <details
        className="mt-3"
        open={retuneOpen}
        onToggle={(event) => onRetuneOpen(event.currentTarget.open)}
      >
        <summary className="pm-control flex cursor-pointer items-center rounded-lg px-2 text-[13px] font-medium text-ink hover:bg-raised">
          Change time · {scheduleSummary(loop.schedule)}
        </summary>
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-muted">{loop.description}</p>
        {!loop.available ? (
          <p className="mt-2 text-[12px] text-ink-muted">Planned — you can set the clock now; RealBud will not run this until it is built.</p>
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
              disabled={busy}
              title={`Save ${scheduleSummary({ time, weekdays: days })}`}
              className="pm-control ml-auto inline-flex items-center gap-1.5 rounded-lg bg-agency px-3 text-[12px] font-medium text-white hover:bg-agency-hover disabled:opacity-40"
            >
              {busy ? <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <CheckCircle2 size={12} aria-hidden />}
              Save
            </button>
          )}
        </div>
      </details>
    </article>
  );
}

export function RoutinesPage() {
  const { state, dispatch, refreshHermes } = useStore();
  const mounted = useRef(true);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [jobRuns, setJobRuns] = useState<JobRun[]>([]);
  const [busy, setBusy] = useState<LoopId | null>(null);
  const [error, setError] = useState("");
  const [pauseNotice, setPauseNotice] = useState("");
  const [selectedId, setSelectedId] = useState<LoopId | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [keptRetune, setKeptRetune] = useState<ReadonlySet<string>>(() => new Set());
  const [showAllRuns, setShowAllRuns] = useState(false);
  const timezone = state.desk?.book?.agency.timezone || state.desk?.timezone;

  const refreshSchedule = useCallback(async () => {
    const body = await api("/api/loops") as { loops?: Loop[]; runs?: LoopRun[] };
    dispatch({ type: "loopsHydrated", loops: body.loops ?? [], runs: body.runs ?? [] });
    const jobs = (await api("/api/recipes")) as { recipes?: Recipe[] };
    setRecipes(jobs.recipes ?? []);
  }, [dispatch]);

  useEffect(() => {
    return () => {
      mounted.current = false;
    };
  }, []);

  const liveRun = Boolean(busy) || state.loopRuns.some((run) => run.status === "queued" || run.status === "running");
  const attendedLive = Boolean(runningAttended(jobRuns));
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), liveRun ? 1_000 : 60_000);
    return () => window.clearInterval(id);
  }, [liveRun]);

  useEffect(() => {
    let alive = true;
    void api("/api/recipes")
      .then((body: { recipes?: Recipe[] }) => {
        if (alive) setRecipes(body.recipes ?? []);
      })
      .catch(() => {});
    void api("/api/job-runs?limit=50")
      .then((body: { runs?: JobRun[] }) => {
        if (alive && Array.isArray(body.runs)) setJobRuns(body.runs);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!attendedLive) return;
    const id = window.setInterval(() => {
      void api("/api/job-runs?limit=50")
        .then((body: { runs?: JobRun[] }) => {
          if (Array.isArray(body.runs)) setJobRuns(body.runs);
        })
        .catch(() => {});
    }, 3_000);
    return () => window.clearInterval(id);
  }, [attendedLive]);

  const focusRoutine = (id: LoopId) => {
    setSelectedId(id);
    const card = document.getElementById(`routine-${id}`);
    card?.scrollIntoView({ behavior: "auto", block: "start" });
    card?.focus({ preventScroll: true });
  };

  const runNow = async (loopId: LoopId) => {
    setBusy(loopId);
    setRunStartedAt(Date.now());
    setError("");
    try {
      const started = await api(`/api/loops/${loopId}/run`, { method: "POST" });
      const runId = started?.run?.id as string | undefined;
      if (!runId) throw new Error("This job is paused or unavailable. Review its clock state and try again.");
      let latest: { loops?: Loop[]; runs?: LoopRun[] } | undefined;
      for (let i = 0; i < 305 && runId; i++) {
        if (!mounted.current) return;
        const polled = (await api("/api/loops")) as { loops?: Loop[]; runs?: LoopRun[] };
        latest = polled;
        const settled = (polled.runs ?? []).find((run) => run.id === runId);
        if (settled && !["queued", "running"].includes(settled.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      if (!mounted.current) return;
      if (latest?.loops) dispatch({ type: "loopsHydrated", loops: latest.loops, runs: latest.runs ?? [] });
      const desk = await api("/api/desk");
      dispatch({ type: "deskSnapshot", snapshot: desk });
      await refreshHermes();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) {
        setBusy(null);
        setRunStartedAt(null);
      }
    }
  };

  const toggle = async (loop: Loop) => {
    setBusy(loop.id);
    setError("");
    try {
      const { loop: patched } = await api(`/api/loops/${loop.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !loop.enabled }),
      });
      dispatch({ type: "loopPatched", loop: patched });
      setPauseNotice(loop.enabled ? `${loop.name} paused until you Resume` : `${loop.name} is on again`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const retune = async (loop: Loop, when: { time: string; weekdays: number[] }) => {
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
  const unseenFailures = state.loopRuns.filter((run) => ["failed", "missed", "interrupted"].includes(run.status) && !run.seenAt);
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
              RealBud keeps the clock. Named checks press Desk Recheck; Bud-built jobs prepare bounded work and leave a receipt. Nothing sends while nobody is looking.
            </p>
          </div>
          {unseenFailures.length > 0 && (
            <button
              type="button"
              onClick={() => document.getElementById("schedule-runs")?.scrollIntoView({ behavior: "auto", block: "start" })}
              className="pm-control inline-flex items-center gap-1.5 rounded-full border border-danger/25 bg-danger/10 px-2.5 text-[12px] text-danger"
            >
              <CircleAlert size={12} aria-hidden />
              {unseenFailures.length} need attention
            </button>
          )}
        </div>
        {state.desk?.recovery?.active ? (
          <div className="mt-3">
            <RecoveryNotice>Desk is in recovery. Named routines are paused. The clock will not Recheck or mint a browser session.</RecoveryNotice>
          </div>
        ) : null}
        {error && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-[13px] text-danger">
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

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
        <BudJobBuilder timezone={timezone} onScheduleChanged={refreshSchedule} />
        <div className="mb-6">
          <WeekCalendar
            loops={state.loops}
            nowMs={nowMs}
            timeZone={timezone}
            facts={weekFacts}
            deskNote={brief?.headline ?? null}
            selectedId={selectedId}
            onSelect={(slot) => {
              if (slot.produced > 0) {
                dispatch({ type: "showDesk" });
                return;
              }
              focusRoutine(slot.loopId);
            }}
          />
        </div>

        <section className="space-y-3">
          <h2 className="text-[13px] font-medium text-ink-muted">Work on the clock</h2>
          {state.loops.map((loop) => (
            <LoopCard
              key={loop.id}
              loop={loop}
              lastRun={lastRunByLoop.get(loop.id)}
              activeRun={activeByLoop.get(loop.id)}
              busy={busy === loop.id}
              selected={selectedId === loop.id}
              retuneOpen={keptRetune.has(loop.id)}
              nowMs={nowMs}
              runStartedAt={busy === loop.id ? runStartedAt : null}
              onRun={() => void runNow(loop.id)}
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
                const builder = document.getElementById("bud-job-builder");
                builder?.scrollIntoView({ behavior: "auto", block: "start" });
                builder?.focus({ preventScroll: true });
              }}
              recipe={findRecipeForLoop(recipes, loop.id)}
              jobRuns={jobRuns}
              onRecipe={(next) => {
                setRecipes((current) => {
                  const exists = current.some((item) => item.id === next.id);
                  return exists ? current.map((item) => (item.id === next.id ? next : item)) : [next, ...current];
                });
              }}
              onJobRun={(run) => setJobRuns((current) => [run, ...current.filter((item) => item.id !== run.id)])}
              onShowAsk={() => dispatch({ type: "showAsk" })}
            />
          ))}
        </section>

        <section id="schedule-runs" className="mt-8 space-y-3">
          <h2 className="text-[13px] font-medium text-ink-muted">Runs</h2>
          {state.loopRuns.length === 0 ? (
            <div className="rounded-lg border border-line bg-sheet px-4 py-6 text-[13.5px] text-ink-muted">
              No runs yet. The first check lands here when the clock — or you — press Recheck.
            </div>
          ) : (
            <div className="space-y-1.5">
              {state.loopRuns.slice(0, showAllRuns ? 50 : 5).map((run) => {
                const unseenDanger = ["failed", "missed", "interrupted"].includes(run.status) && !run.seenAt;
                const unseenPartial = run.status === "partial" && !run.seenAt;
                const unseen = unseenDanger || unseenPartial;
                const produced = (state.desk?.book?.cases ?? []).filter((item) => item.origin?.runId === run.id).length;
                return (
                  <button
                    key={run.id}
                    type="button"
                    onClick={() => {
                      if (unseen) dispatch({ type: "markLoopRunSeen", runId: run.id });
                      dispatch({ type: "showDesk" });
                    }}
                    className={cn(
                      "flex w-full min-w-0 flex-wrap items-center gap-2 rounded-xl border px-3.5 py-2.5 text-left sm:flex-nowrap sm:gap-3",
                      unseenDanger
                        ? "border-danger/30 bg-danger/5"
                        : unseenPartial
                          ? "border-hold/30 bg-hold/5"
                          : "border-line bg-sheet hover:bg-raised/50",
                    )}
                  >
                    <RunStatus status={run.status} />
                    <span className="text-[13px] font-medium text-ink">{run.loopName}</span>
                    {run.manual ? <StatusLabel tone="muted">manual</StatusLabel> : null}
                    <span className="text-[12px] text-ink-muted">{whenLabel(run.scheduledFor)}</span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-ink-muted" title={run.detail}>
                      {run.detail}
                    </span>
                    <span className="shrink-0 text-[12px] text-ink-muted">
                      {run.jobRunId ? "Receipt on Desk" : produced ? `${produced} on Desk` : "Open Desk"}
                    </span>
                    {unseen && <span className="size-2 shrink-0 rounded-full bg-danger" aria-hidden />}
                  </button>
                );
              })}
            </div>
          )}
          {state.loopRuns.length > 5 ? (
            <button
              type="button"
              onClick={() => setShowAllRuns((value) => !value)}
              className="pm-control rounded-lg border border-line bg-sheet px-3 text-[12px] text-ink"
            >
              {showAllRuns ? "Show recent 5" : `Show all ${Math.min(state.loopRuns.length, 50)}`}
            </button>
          ) : null}
        </section>
      </div>
    </main>
  );
}
