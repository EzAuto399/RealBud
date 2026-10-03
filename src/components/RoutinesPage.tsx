import { useWorkspaceScroll, useWorkspaceViewState } from "@/lib/workspace-view-state";
import { openDeskTasks } from "@/lib/desk-view-state";
// Schedule is one compact list of jobs; each row opens one detail drawer.
// All execution still uses RealBud's existing scheduler and approval boundaries.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CalendarDays, CircleAlert, History, Plus, Search, Square } from "lucide-react";

import "@/schedule.css";
import type { Recipe } from "@/lib/desk";
import type { Loop, LoopId, LoopRun } from "@/lib/routines";
import { producedByRunId, scheduleSummary } from "@/lib/schedule-week";
import { RecoveryNotice } from "./pm";
import { api, useStore } from "@/state/store";
import { EMPTY_JOB_DRAFT, jobPlanFields } from "@/lib/job-plan";
import { hasUnfinishedJobDraft } from "@/lib/work-continuation";
import { buildWorkActivity, type WorkActivity } from "@/lib/work-activity";
import { resolveProductBud } from "@/lib/product-bud";
import { pendingManualJobRequest } from "@/lib/manual-job-request";
import { buildScheduleRows, RECOVERY_NOTICE, stableOrder, type ScheduleRow } from "@/lib/schedule-rows";
import { filterScheduleRows, scheduleRowSection, type ScheduleFilter } from "@/lib/schedule-presentation";
import { acknowledgeActivity, JobWorkspace } from "./schedule/JobWorkspace";
import { WorkflowPacksCard } from "./schedule/WorkflowPacksCard";
import { JobRunFeed } from "./desk/JobRunFeed";
import { ExecutionHistory } from "./schedule/ExecutionHistory";
import { FlaggedReceipt, JobDrawer, LoopDetail, type LoopTimingChange } from "./schedule/JobDrawer";
import { isAttendedMode } from "@/lib/job-run";
import { JobList } from "./schedule/JobList";
import { beginLoopRequest, pendingLoopRequest, resumeLoopRequest, confirmLoopReceipt, rejectLoopRequest, type PendingLoopRequest } from "@/lib/manual-loop-request";

/** `flagged` pins the receipt that needed review when the job was opened, so it
 * is shown directly and acknowledging it does not swap it out of the detail. */
type Flagged = { kind: "loop" | "job"; id: string; word: string };
type Drawer = { mode: "job"; key: string; flagged?: Flagged; reviewResult?: boolean } | { mode: "create" } | { mode: "archive" } | { mode: "packs" };
const SCHEDULE_FILTERS: readonly { key: ScheduleFilter; label: string }[] = [
  { key: "all", label: "All jobs" }, { key: "attention", label: "Needs you" },
  { key: "scheduled", label: "Scheduled" }, { key: "paused", label: "Paused" },
];

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
  const [pendingJobs, setPendingJobs] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedKey, setSelectedKey] = useWorkspaceViewState("scheduleSelected");
  const [drawer, setDrawer] = useState<Drawer | null>(null);
  const [interacting, setInteracting] = useState(false);
  const [search, setSearch] = useWorkspaceViewState("scheduleSearch");
  const [filter, setFilter] = useWorkspaceViewState("scheduleFilter");
  const searchRef = useRef<HTMLInputElement>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [keptRetune, setKeptRetune] = useWorkspaceViewState("scheduleTiming");
  const [showAllRuns, setShowAllRuns] = useWorkspaceViewState("scheduleResults");
  const order = useRef<string[]>([]);
  const closeGuards = useRef(new Set<() => boolean>());
  const scrollRef = useWorkspaceScroll("schedule", !jobsLoading);
  // Only the book's confirmed zone; the snapshot's default zone is this computer's.
  const timezone = state.desk?.book?.agency.timezone || undefined;
  const recovery = state.scheduleRecovery.active || Boolean(state.desk?.recovery?.active);

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

  const liveRun = Boolean(busy) || state.loopRuns.some((run) => run.status === "queued" || run.status === "running");
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), liveRun ? 1_000 : 60_000);
    return () => window.clearInterval(id);
  }, [liveRun]);

  const loopIds = state.loops.map((loop) => loop.id).join(",");
  const syncPending = useCallback(() => {
    try {
      const pending: Record<string, PendingLoopRequest> = {};
      for (const id of loopIds.split(",").filter(Boolean)) {
        const request = pendingLoopRequest(id);
        if (request) pending[id] = request;
      }
      setPendingRequests(pending);
      const jobs = new Set<string>();
      for (const recipe of recipes) if (pendingManualJobRequest({ id: recipe.id, revision: recipe.revision, mode: "prepare" })) jobs.add(recipe.id);
      setPendingJobs(jobs);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Run recovery is unavailable."); }
  }, [loopIds, recipes]);
  useEffect(() => {
    syncPending();
    window.addEventListener("storage", syncPending);
    return () => window.removeEventListener("storage", syncPending);
  }, [syncPending]);
  // A run started inside the drawer may leave a pending request behind.
  useEffect(() => { if (!state.jobDraftBusy) syncPending(); }, [state.jobDraftBusy, syncPending]);

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
      setPauseNotice(finished ? `Previous result found. Open ${loop.name} to review it.` : "Bud has the work. You can keep using RealBud; the result will appear here.");
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
      if (loop.id === "inbound-triage") {
        // Morning priorities adopts the reviewed agency schedule through its own path.
        const enabled = !loop.enabled;
        await api("/api/mail-workspace/schedule", { method: "PATCH", body: JSON.stringify({ enabled }) });
        const body = await api("/api/loops", undefined, { timeoutMs: 15_000 });
        dispatch({ type: "loopsHydrated", loops: body.loops ?? [], runs: body.runs ?? [], recovery: body.recovery });
        const confirmed = (body.loops as Loop[] | undefined)?.find((item) => item.id === loop.id);
        if (confirmed?.enabled !== enabled) throw new Error("The schedule change could not be confirmed. Refresh before retrying.");
        setPauseNotice(enabled ? `${loop.name} is on, using the reviewed agency time and weekdays` : `${loop.name} paused until you Resume`);
        return;
      }
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

  const retune = async (loop: Loop, when: LoopTimingChange) => {
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
      setPauseNotice(`${loop.name}: ${scheduleSummary(patched.schedule)}${patched.enabled ? '' : ' · paused'}`);
      dispatch({ type: "loopPatched", loop: patched });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      actionFlight.current = false;
      setBusy(null);
    }
  };

  /** Resume a paused saved job with the exact version on screen. */
  const resumeRecipe = async (recipe: Recipe) => {
    if (actionFlight.current || state.jobDraftBusy || !state.connected || recovery) return;
    actionFlight.current = true;
    setError("");
    try {
      const body = await api(`/api/recipes/${recipe.id}`, { method: "PATCH", body: JSON.stringify({ status: "active", expectedRevision: recipe.revision }) }, { timeoutMs: 15_000 });
      if (Array.isArray(body.recipes)) setRecipes(body.recipes);
      setPauseNotice(`${recipe.title} is on again`);
      await refreshSchedule();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      actionFlight.current = false;
    }
  };

  const deskCounts = producedByRunId([...(state.desk?.book?.cases ?? []), ...(state.desk?.workItems ?? [])]);
  const rows = useMemo(() => buildScheduleRows({
    loops: state.loops,
    recipes,
    loopRuns: state.loopRuns,
    jobRuns: state.jobRuns,
    pendingLoops: new Set(Object.keys(pendingRequests)),
    pendingJobs,
    recovery,
    nowMs,
    timeZone: timezone,
  }), [state.loops, recipes, state.loopRuns, state.jobRuns, pendingRequests, pendingJobs, recovery, nowMs, timezone]);
  // Keep the order stable while someone is reading or acting on the list.
  const frozen = Boolean(drawer) || interacting;
  const keys = frozen ? stableOrder(order.current, rows.map((row) => row.key)) : rows.map((row) => row.key);
  order.current = keys;
  const rowByKey = new Map(rows.map((row) => [row.key, row]));
  const visibleRows = keys.map((key) => rowByKey.get(key)).filter((row): row is ScheduleRow => Boolean(row));
  const matchingRows = filterScheduleRows(visibleRows, filter, search);
  const matchingKeys = new Set(matchingRows.map((row) => row.key));
  // Filters must never hide the local Stop control for attended work.
  const runningCount = visibleRows.filter((row) => scheduleRowSection(row) === "running").length;
  const filteredRows = visibleRows.filter((row) => matchingKeys.has(row.key) || scheduleRowSection(row) === "running");
  const attentionCount = filterScheduleRows(rows, "attention").length;

  /** Load a saved job into the plan editor without overwriting unsaved work. */
  const openRecipeDraft = (recipe: Recipe): boolean => {
    const draft = state.jobDraft;
    if (draft.plan?.id === recipe.id) return true;
    if (state.jobDraftBusy || hasUnfinishedJobDraft(draft)) {
      setError(draft.plan && draft.saved
        ? `Save or cancel the changes in ${draft.plan.title || "your open job"} before opening another job.`
        : "Your new job is kept. Open Add a job to finish or clear it before opening another job.");
      return false;
    }
    dispatch({ type: "jobDraft", draft: { text: recipe.description, plan: recipe, fields: jobPlanFields(recipe), saved: true } });
    return true;
  };

  const registerCloseGuard = useCallback((guard: () => boolean) => {
    closeGuards.current.add(guard);
    return () => { closeGuards.current.delete(guard); };
  }, []);
  /** Every drawer change (close, switch, deep link) first asks open work to let go. */
  const guardsAllow = () => {
    for (const guard of closeGuards.current) if (!guard()) return false;
    return true;
  };
  const changeDrawer = (next: Drawer | null): boolean => {
    if (drawer && !guardsAllow()) return false;
    setDrawer(next);
    return true;
  };

  const openRow = (row: ScheduleRow, reviewResult = false) => {
    if (drawer && !guardsAllow()) return;
    if (row.recipe && !openRecipeDraft(row.recipe)) return;
    setError("");
    setPauseNotice("");
    setSelectedKey(row.key);
    // Only the explicit review action opens the exact receipt immediately.
    // Generic job opening does not acknowledge its result.
    const flagged = row.attentionRun && row.attention ? { ...row.attentionRun, word: row.attention } : undefined;
    setDrawer({ mode: "job", key: row.key, reviewResult, ...(flagged ? { flagged } : {}) });
  };

  const openCreate = () => {
    const draft = state.jobDraft;
    if (draft.plan && draft.saved) {
      if (state.jobDraftBusy || hasUnfinishedJobDraft(draft)) {
        setError(`Save or cancel the changes in ${draft.plan.title || "your open job"} before adding another job.`);
        return;
      }
      dispatch({ type: "jobDraft", draft: EMPTY_JOB_DRAFT });
    }
    if (drawer && !guardsAllow()) return;
    setError("");
    setDrawer({ mode: "create" });
  };

  const closeDrawer = () => {
    if (!guardsAllow()) return;
    if (drawer?.mode === "job" || drawer?.mode === "create") {
      const draft = state.jobDraft;
      // A saved plan with no edits is closed; unfinished work stays for later.
      if (!state.jobDraftBusy && draft.plan && !hasUnfinishedJobDraft(draft)) dispatch({ type: "jobDraft", draft: EMPTY_JOB_DRAFT });
    }
    const filteredAway = drawer?.mode === "job" && !filteredRows.some((row) => row.key === drawer.key);
    setDrawer(null);
    // Reviewing a receipt can remove the originating row from Needs you.
    // Give keyboard users a useful return point when that control no longer exists.
    if (filteredAway) requestAnimationFrame(() => searchRef.current?.focus());
  };

  const stopAttended = () => {
    // The same interruption Stop uses in the job's results: Bud's whole turn ends.
    const bud = resolveProductBud(state.bots);
    if (bud) dispatch({ type: "interrupt", botId: bud.id });
    else setError("Bud is not available to stop. Open the job to check its progress.");
  };

  const rowAction = (row: ScheduleRow) => {
    const loopOnly = row.loop && !row.recipe ? row.loop : undefined;
    const origin = document.activeElement;
    const restoreAfterResume = () => requestAnimationFrame(() => {
      if (origin instanceof HTMLElement && !origin.isConnected && document.activeElement === document.body) searchRef.current?.focus();
    });
    switch (row.action) {
      case "stop": stopAttended(); return;
      case "review-result": openRow(row, true); return;
      case "run-now":
        if (row.loop && !row.loop.waitingForPlan) void runNow(row.loop);
        else openRow(row);
        return;
      case "check-previous":
        if (row.loop && pendingRequests[row.loop.id]) void runNow(row.loop, pendingRequests[row.loop.id]);
        else openRow(row);
        return;
      case "resume":
        if (loopOnly) void toggle(loopOnly).then(restoreAfterResume, restoreAfterResume);
        else if (row.recipe) void resumeRecipe(row.recipe).then(restoreAfterResume, restoreAfterResume);
        return;
      default: openRow(row);
    }
  };

  // Deep links: a saved job, the job builder, or agency workflow setup
  // (`#schedule-packs`, used by the Desk setup steps). Read once, then cleared.
  const consumeHash = useRef<() => void>(() => {});
  // A saved job handed over without a deep link (Workspace saved views set the
  // plan and open Schedule) opens in the drawer once jobs have loaded.
  const handoffChecked = useRef(false);
  consumeHash.current = () => {
    const hash = location.hash.replace(/^#/, "");
    if (!hash || hash.startsWith("/") || !/^(?:job-|schedule-|bud-job-builder$)/.test(hash)) {
      if (handoffChecked.current || jobsLoading || jobsError) return;
      handoffChecked.current = true;
      const plan = state.jobDraft.plan;
      if (!plan || drawer) return;
      const row = rowByKey.get(`job:${plan.id}`);
      if (row && state.jobDraft.saved) setDrawer({ mode: "job", key: row.key });
      else if (!state.jobDraft.saved) setDrawer({ mode: "create" });
      return;
    }
    const job = /^job-([\w-]+)$/.exec(hash);
    handoffChecked.current = true;
    if (job) {
      if (jobsLoading || jobsError) return;
      const row = rowByKey.get(`job:${job[1]}`);
      if (row) openRow(row);
      else setError("That job is no longer available. Choose a saved job below.");
    } else if (hash === "bud-job-builder") {
      openCreate();
    } else if (hash === "schedule-packs") {
      changeDrawer({ mode: "packs" });
    } else if (hash === "schedule-runs") {
      changeDrawer({ mode: "archive" });
    } else if (!hash.startsWith("schedule-")) {
      return;
    }
    history.replaceState(null, "", location.pathname + location.search);
  };
  useEffect(() => { consumeHash.current(); }, [jobsLoading, jobsError]);
  useEffect(() => {
    const onHash = () => consumeHash.current();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const openDesk = () => {
    openDeskTasks();
    dispatch({ type: "showDesk" });
  };
  const deskResultCount = (activity: WorkActivity) => (activity.kind === "routine"
    ? deskCounts[activity.run.id] ?? 0
    : state.loopRuns.filter((run) => run.jobRunId === activity.run.id).reduce((count, run) => count + (deskCounts[run.id] ?? 0), 0));
  const activityCount = buildWorkActivity(state.jobRuns, state.loopRuns).length;
  const changeBlocked = Boolean(busy) || state.jobDraftBusy || !state.connected;

  const drawerRow = drawer?.mode === "job" ? rowByKey.get(drawer.key) : undefined;
  const drawerTitle = drawer?.mode === "create" ? "Add a job"
    : drawer?.mode === "archive" ? "Past results"
    : drawer?.mode === "packs" ? "Workflow setup"
    : drawerRow?.name ?? "Job";
  const loopRunsFor = (loopId: string): LoopRun[] => state.loopRuns.filter((run) => run.loopId === loopId);
  const workspace = (
    <JobWorkspace
      onSetup={onSetup}
      onShowAsk={onShowAsk}
      recipes={recipes}
      loading={jobsLoading}
      loadError={jobsError}
      timezone={timezone}
      onRecipes={setRecipes}
      onRefresh={refreshSchedule}
      onDeleted={() => setDrawer(null)}
    />
  );

  const flagged = drawer?.mode === "job" ? drawer.flagged : undefined;
  const flaggedLoopRun = flagged?.kind === "loop" ? state.loopRuns.find((run) => run.id === flagged.id) : undefined;
  const flaggedJobRun = flagged?.kind === "job" ? state.jobRuns.find((run) => run.id === flagged.id) : undefined;
  const flaggedReceipt = flagged ? (
    <FlaggedReceipt
      key={flagged.id}
      word={flagged.word}
      initiallyOpen={drawer?.mode === "job" && drawer.reviewResult}
      loopRun={flaggedLoopRun}
      jobRun={flaggedJobRun}
      deskCount={flaggedLoopRun ? deskCounts[flaggedLoopRun.id] ?? 0 : flaggedJobRun ? deskResultCount({ kind: "job", id: `job:${flaggedJobRun.id}`, at: flaggedJobRun.createdAt, run: flaggedJobRun }) : 0}
      onOpenDesk={openDesk}
      onReviewed={() => {
        if (flaggedLoopRun) acknowledgeActivity({ kind: "routine", id: `routine:${flaggedLoopRun.id}`, at: flaggedLoopRun.createdAt, run: flaggedLoopRun }, state.loopRuns, dispatch);
        if (flaggedJobRun) acknowledgeActivity({ kind: "job", id: `job:${flaggedJobRun.id}`, at: flaggedJobRun.createdAt, run: flaggedJobRun }, state.loopRuns, dispatch);
      }}
    />
  ) : null;
  // Running website work keeps Stop in the drawer's fixed header.
  const runningAttended = drawerRow?.recipe
    ? state.jobRuns.find((run) => run.jobId === drawerRow.recipe!.id && isAttendedMode(run.mode) && run.status === "running")
    : undefined;
  const drawerActions = runningAttended ? (
    <>
      <span className="text-[13px] text-ink">Bud is working on the website now.</span>
      <button type="button" aria-label={`Stop now: ${runningAttended.jobTitle}`} onClick={stopAttended} className="pm-decision inline-flex items-center gap-1.5 rounded border border-line bg-sheet px-4 text-[14px] font-medium text-ink hover:bg-selected">
        <Square size={13} className="fill-current" aria-hidden />Stop
      </button>
    </>
  ) : undefined;
  const notices = (
    <>
      {error && (
        <div role="alert" className="mt-3 flex items-start gap-2 rounded border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
          <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
          {error}
        </div>
      )}
      {pauseNotice && !error ? (
        <div role="status" className="mt-3 rounded border border-hold/30 bg-hold/10 px-3 py-2 text-[13px] text-hold">
          {pauseNotice}
        </div>
      ) : null}
    </>
  );

  let drawerBody: ReactNode = null;
  if (drawer?.mode === "create") drawerBody = workspace;
  else if (drawer?.mode === "packs") drawerBody = <WorkflowPacksCard onInstalled={refreshSchedule} className="mb-0 border-0 bg-transparent p-0" />;
  else if (drawer?.mode === "archive") {
    drawerBody = (
      <div className="space-y-3">
        <JobRunFeed
          limit={showAllRuns ? 50 : 8}
          className="border-0 bg-transparent p-0"
          onOpenResult={(activity) => acknowledgeActivity(activity, state.loopRuns, dispatch)}
          deskResultCount={deskResultCount}
          onOpenDesk={openDesk}
        />
        {activityCount > 8 ? (
          <button type="button" onClick={() => setShowAllRuns((value) => !value)} className="pm-control rounded-lg border border-line bg-sheet px-3 text-[13px] text-ink">
            {showAllRuns ? "Show recent 8" : `Show recent ${Math.min(activityCount, 50)}`}
          </button>
        ) : null}
        <ExecutionHistory label="Older saved results" />
      </div>
    );
  } else if (drawer?.mode === "job") {
    if (!drawerRow) drawerBody = <p className="text-[14px] text-ink-secondary">This job is no longer available.</p>;
    else if (drawerRow.recipe) {
      drawerBody = (
        <>
          {flaggedReceipt}
          {workspace}
        </>
      );
    } else if (drawerRow.loop) {
      const loop = drawerRow.loop;
      drawerBody = (
        <>
        {flaggedReceipt}
        <LoopDetail
          loop={loop}
          runs={loopRunsFor(loop.id)}
          flaggedRunId={drawer.flagged?.kind === "loop" ? drawer.flagged.id : undefined}
          manualOnly={drawerRow.manualOnly}
          next={drawerRow.next}
          busy={busy === loop.id}
          disabled={changeBlocked || recovery}
          recovery={recovery}
          nowMs={nowMs}
          runStartedAt={busy === loop.id ? runStartedAt : null}
          pendingRequest={pendingRequests[loop.id]}
          timingOpen={keptRetune.has(loop.id)}
          deskCount={(run) => deskCounts[run.id] ?? 0}
          onTimingOpen={(open) => {
            setKeptRetune((ids) => {
              const next = new Set(ids);
              if (open) next.add(loop.id);
              else next.delete(loop.id);
              return next;
            });
          }}
          onRun={() => void runNow(loop, pendingRequests[loop.id])}
          onToggle={() => void toggle(loop)}
          onRetune={(when) => void retune(loop, when)}
          onOpenSetup={() => changeDrawer({ mode: "packs" })}
          onOpenDesk={openDesk}
          registerCloseGuard={registerCloseGuard}
        />
        </>
      );
    }
  }
  const drawerBusy = (drawer?.mode === "job" || drawer?.mode === "create") && state.jobDraftBusy;

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-paper">
      <header className="shrink-0 px-4 pb-3 pt-4 min-[720px]:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <CalendarDays size={21} className="text-agency" aria-hidden />
            <h1 className="pm-screen-title text-ink">Schedule</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => changeDrawer({ mode: "archive" })} className="pm-control inline-flex items-center gap-1.5 rounded px-3 text-[13px] text-ink-muted hover:bg-raised hover:text-ink">
              <History size={15} aria-hidden />Past results
            </button>
            <button type="button" onClick={openCreate} className="pm-decision inline-flex items-center gap-1.5 rounded bg-agency px-4 text-[14px] font-medium text-white hover:bg-agency-hover">
              <Plus size={16} aria-hidden />Add a job
            </button>
          </div>
        </div>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-muted">
          {attentionCount ? `${attentionCount} ${attentionCount === 1 ? "job needs" : "jobs need"} your attention. Choose a job below to see what it needs.` : "Review your jobs, check results and choose what happens next."}
        </p>
        {recovery ? (
          <div role="alert" className="mt-3">
            <RecoveryNotice>{RECOVERY_NOTICE}</RecoveryNotice>
          </div>
        ) : null}
        {/* Messages follow the work: inside the drawer while it is open. */}
        {drawer ? null : notices}
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 min-[720px]:px-6">
        {jobsLoading && !visibleRows.length ? <p role="status" className="py-3 text-[14px] text-ink-muted">Loading your jobs…</p> : null}
        {jobsError ? (
          <div role="alert" className="mb-3 flex flex-wrap items-center gap-2 text-[14px] text-danger">
            {jobsError}
            <button type="button" className="pm-control rounded border border-line px-3 text-[13px] text-ink hover:bg-selected" onClick={() => void refreshSchedule().catch(() => {})}>Reload jobs</button>
          </div>
        ) : null}
        {!jobsLoading && !jobsError && !visibleRows.length ? (
          <div className="py-6">
            <p className="text-[14px] text-ink-secondary">No jobs yet.</p>
            <button type="button" onClick={openCreate} className="pm-control mt-2 rounded border border-line px-3 text-[13px] text-ink hover:bg-selected">Add a job</button>
          </div>
        ) : null}
        {visibleRows.length ? (
          <>
          <div className="schedule-toolbar">
            <div className="schedule-filters" role="group" aria-label="Filter jobs">
              {SCHEDULE_FILTERS.map((item) => (
                <button key={item.key} type="button" className="schedule-filter" aria-pressed={filter === item.key} onClick={() => setFilter(item.key)}>
                  {item.label}<span className="schedule-filter-count">{filterScheduleRows(visibleRows, item.key, search).length}</span>
                </button>
              ))}
            </div>
            <label className="schedule-search">
              <span className="sr-only">Search jobs</span>
              <Search size={16} aria-hidden />
              <input ref={searchRef} type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search jobs" />
            </label>
          </div>
          <p role="status" className={runningCount || search || filter !== "all" ? "mb-3 text-[13px] text-ink-muted" : "sr-only"}>
            {search || filter !== "all" ? `${matchingRows.length} ${matchingRows.length === 1 ? "job matches" : "jobs match"} this view. ` : ""}
            {runningCount ? "In-progress jobs stay visible in every view." : !search && filter === "all" ? `Showing ${filteredRows.length} jobs.` : ""}
          </p>
          {filteredRows.length ? <div className="schedule-work-list">
            <JobList
              rows={filteredRows}
              freezeOrder={frozen}
              selectedKey={drawer?.mode === "job" ? drawer.key : selectedKey}
              actionBlocked={(row) => row.action !== "stop" && !["view-result", "review-result", "review-plan", "view-progress"].includes(row.action) && changeBlocked}
              onOpen={(row) => openRow(row)}
              onAction={rowAction}
              onInteract={setInteracting}
            />
          </div> : (
            <div className="py-8 text-[14px] text-ink-muted">
              <p>{search.trim() ? `No jobs match “${search.trim()}” in this view.` : filter === "attention" ? "No jobs need your attention right now." : filter === "scheduled" ? "No jobs have a confirmed next run." : "No paused jobs."}</p>
              <button type="button" className="pm-control mt-2 rounded border border-line bg-sheet px-3 text-ink hover:bg-selected" onClick={() => { setSearch(""); setFilter("all"); requestAnimationFrame(() => searchRef.current?.focus()); }}>Show all jobs</button>
            </div>
          )}
          </>
        ) : null}
      </div>

      {drawer ? (
        <JobDrawer title={drawerTitle} busy={drawerBusy} wide={drawerRow?.loop?.id === "bank-references" || drawer.mode === "packs"} actions={drawerActions} notice={error || pauseNotice ? <div className="-mt-3">{notices}</div> : undefined} onClose={closeDrawer}>
          {drawerBody}
        </JobDrawer>
      ) : null}
    </main>
  );
}
