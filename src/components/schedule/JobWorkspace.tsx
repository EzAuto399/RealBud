import { DESIGN_PREVIEW_REASON } from "@/lib/design-preview";
import { JOB_OUTCOME_EXAMPLES, approveSingleTry, firstTrySuggestion, latestJobTrial } from "@/lib/job-workspace";
import { useServiceAdminAccess } from "@/lib/use-service-admin-access";
import { ApprovalScope } from "../ApprovalScope";
import { WorkContextCard } from "../WorkContextCard";
import { ActionNotice } from "../ActionNotice";
import { openWorkspaceSetup } from "@/lib/workspace-setup";
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, PencilLine, Play, Sparkles } from "lucide-react";

import { cn } from "@/lib/cn";
import { recipeClockRunnable, type JobCapability, type JobRun, type Recipe } from "@/lib/desk";
import {
  EMPTY_JOB_DRAFT,
  JOB_ABILITY_LABELS,
  jobPlanChanged,
  jobPlanFields,
  jobPlanInput,
  type JobDraftState,
  type JobPlanFields,
} from "@/lib/job-plan";
import { recipeHasPortalCapability, recipeNeedsPlanApproval, recipeSourceLine } from "@/lib/portal-job";
import { DAY_NAMES, recipeScheduleLine, WEEKDAYS_MON_FIRST } from "@/lib/schedule-week";
import { api, useStore } from "@/state/store";
import { JobRunFeed } from "../desk/JobRunFeed";
import { ExecutionHistory } from "./ExecutionHistory";
import { PortalJobActions } from "./PortalJobActions";
import { routineRunsForActivity, type WorkActivity } from "@/lib/work-activity";
import type { LoopRun } from "@/lib/routines";
import { budAvailability, budFacingCopy } from "@/lib/bud-setup";
import { canUseTaskStarter } from "@/lib/pm-task-starters";
import { PmTaskStarters } from "../PmTaskStarters";
import { hasUnfinishedJobDraft } from "@/lib/work-continuation";
import { beginManualJobRequest, confirmManualJobReceipt, pendingManualJobRequest, resumeManualJobRequest } from "@/lib/manual-job-request";

const REVIEW_STATUSES = ["failed", "missed", "interrupted", "partial", "awaiting-approval"];

/** Opening a receipt acknowledges that receipt (and its linked clock receipt)
 * only. It never approves held work; held decisions stay on Desk. */
export function acknowledgeActivity(
  activity: WorkActivity,
  loopRuns: ReadonlyArray<LoopRun>,
  dispatch: ReturnType<typeof useStore>["dispatch"],
) {
  for (const run of routineRunsForActivity(activity, loopRuns)) {
    if (!run.seenAt && REVIEW_STATUSES.includes(run.status)) dispatch({ type: "markLoopRunSeen", runId: run.id });
  }
  if (activity.kind !== "job") return;
  const run = activity.run;
  if (run.seenAt || ["queued", "running"].includes(run.status)) return;
  void api(`/api/job-runs/${run.id}/seen`, { method: "POST" })
    .then((body: { run?: JobRun }) => { if (body?.run?.id === run.id) dispatch({ type: "jobRun", run: body.run }); })
    .catch(() => { /* The receipt stays marked for review; nothing else changes. */ });
}

const inputClass =
  "mt-1.5 w-full rounded border border-line bg-sheet px-3 py-2 text-[14px] text-ink disabled:opacity-60";
const buttonClass =
  "pm-control inline-flex items-center justify-center gap-2 rounded border border-line px-3 text-[13px] text-ink hover:bg-selected disabled:opacity-40";
const primaryClass =
  "pm-decision inline-flex items-center justify-center gap-2 rounded bg-agency px-4 text-[14px] font-medium text-white hover:bg-agency-hover disabled:opacity-40";

export function JobWorkspace({
  recipes,
  loading,
  loadError,
  timezone,
  onRecipes,
  onRefresh,
  onSetup,
  onShowAsk,
  onDeleted,
}: {
  onSetup?: () => void;
  onShowAsk?: () => void;
  /** The saved job was removed; its detail should close. */
  onDeleted?: () => void;
  recipes: Recipe[];
  loading: boolean;
  loadError: string;
  timezone?: string;
  onRecipes: (recipes: Recipe[]) => void;
  onRefresh: () => Promise<void>;
}) {
  const { state, dispatch } = useStore();
  const draft = state.jobDraft;
  const { plan, fields } = draft;
  const inFlight = useRef(false);
  const [operation, setOperation] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingRequests, setPendingRequests] = useState<{ shadow: string | null; prepare: string | null }>({ shadow: null, prepare: null });
  const busy = state.jobDraftBusy;
  const canAdminister = useServiceAdminAccess(state.serviceAdmin ?? state.config?.serviceAdmin);
  const availability = budAvailability(state.hermes, state.connected, Boolean(state.desk?.recovery?.active), { canAdminister });
  // Recovery holds every change until the saved schedule is trustworthy again.
  const blocked = !state.connected || Boolean(state.desk?.recovery?.active) || Boolean(state.scheduleRecovery?.active) || loading || Boolean(loadError);
  const dirty = Boolean(plan && fields && (!draft.saved || jobPlanChanged(plan, fields)));
  const unfinished = hasUnfinishedJobDraft(draft);
  const current = plan ? recipes.find((item) => item.id === plan.id) : undefined;
  const stale = Boolean(
    plan && !loading && !loadError && (draft.saved ? !current || current.revision !== plan.revision : current),
  );
  const activeRun = plan
    ? state.jobRuns.find((run) => run.jobId === plan.id && ["queued", "running"].includes(run.status))
    : undefined;
  const running = Boolean(activeRun);
  const runs = plan ? state.jobRuns.filter((run) => run.jobId === plan.id) : [];
  const portal = plan ? recipeHasPortalCapability(plan) : false;
  const trial = plan ? latestJobTrial(plan, runs) : undefined;
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const setDraft = (next: JobDraftState) => dispatch({ type: "jobDraft", draft: next });
  const change = (patch: Partial<JobPlanFields>) => fields && setDraft({ ...draft, fields: { ...fields, ...patch } });

  useEffect(() => {
    if (!plan) {
      setPendingRequests({ shadow: null, prepare: null });
      return;
    }
    // A plan without fields leaves the builder header-only — rehydrate once.
    if (!fields) {
      setDraft({ ...draft, fields: jobPlanFields(plan), saved: draft.saved });
      return;
    }
    try {
      setPendingRequests({
        shadow: pendingManualJobRequest({ ...plan, mode: "shadow" }),
        prepare: pendingManualJobRequest({ ...plan, mode: "prepare" }),
      });
    } catch {
      setError("Run recovery could not be read on this device. Check saved results before starting more work.");
    }
  }, [plan?.id, plan?.revision, fields]);

  useEffect(() => {
    // Reflect pauses/approvals from another card, without overwriting edits or
    // replacing a plan version the PM still needs to compare.
    if (!plan || !current || !draft.saved || dirty || current.revision !== plan.revision) return;
    if (JSON.stringify(current) === JSON.stringify(plan)) return;
    dispatch({
      type: "jobDraft",
      draft: { text: current.description, plan: current, fields: jobPlanFields(current), saved: true },
    });
  }, [current, plan, draft.saved, dirty, dispatch]);

  useEffect(() => {
    if (!unfinished) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unfinished]);

  const accept = (next: Recipe[], id: string) => {
    const saved = next.find((item) => item.id === id);
    if (!saved) throw new Error("The saved job could not be read back. Reload jobs to check it before trying again.");
    onRecipes(next);
    setDraft({ text: saved.description, plan: saved, fields: jobPlanFields(saved), saved: true });
  };

  const perform = async (label: string, work: () => Promise<void>) => {
    if (DESIGN_PREVIEW_REASON || inFlight.current || busy || blocked) return;
    inFlight.current = true;
    dispatch({ type: "jobDraftBusy", busy: true });
    setOperation(label);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (cause) {
      setError(budFacingCopy(cause, "That step could not finish. Your plan is still here."));
    } finally {
      inFlight.current = false;
      dispatch({ type: "jobDraftBusy", busy: false });
      setOperation("");
    }
  };

  const [refreshMissed, setRefreshMissed] = useState(false);
  const refreshClock = async () => {
    try {
      await onRefresh();
      setRefreshMissed(false);
    } catch {
      setRefreshMissed(true);
      setNotice("Your job was saved. Refresh to see its latest schedule and results.");
    }
  };

  const build = () =>
    perform("Building your plan…", async () => {
      if (!availability.ready) return;
      const shaped = (await api(
        "/api/recipes/draft",
        { method: "POST", body: JSON.stringify({ text: draft.text.trim() }) },
        { timeoutMs: 120_000 },
      )) as { draft?: Recipe };
      if (!shaped.draft)
        throw new Error(
          "Bud did not return a usable plan. Your description is still here; try again or write the steps yourself.",
        );
      // The first trial is on demand. A requested cadence remains in the description.
      const suggestion = firstTrySuggestion(shaped.draft);
      // Keep the suggestion in app memory even if the following save fails.
      setDraft({ text: draft.text, plan: suggestion, fields: jobPlanFields(suggestion), saved: false });
      setEditing(false);
      const body = await api(
        "/api/recipes",
        { method: "POST", body: JSON.stringify({ draft: { ...suggestion, expectedRevision: 0 } }) },
        { timeoutMs: 15_000 },
      );
      accept(body.recipes ?? [], shaped.draft.id);
      setNotice("Your job is ready to review. Try it once before choosing whether to repeat it.");
      await refreshClock();
    });

  const writePlan = () => {
    const now = Date.now();
    const next: Recipe = {
      id: crypto.randomUUID(),
      title: "",
      description: draft.text.trim(),
      steps: [],
      allowedOrigins: [],
      evidence: "",
      capabilities: ["read-book", "analyse", "draft"],
      limits: { maxRuntimeMinutes: 2, maxTurns: 6 },
      status: "shadow",
      createdAt: now,
      updatedAt: now,
      revision: 1,
      approvedRevision: null,
      planApprovedAt: null,
      attachment: null,
      submitAcknowledgedAt: null,
      schedule: null,
    };
    setDraft({ text: draft.text, plan: next, fields: jobPlanFields(next), saved: false });
    setError("");
    setEditing(true);
    setNotice("Write the steps and save the job. You can then approve a first try.");
  };

  const save = () =>
    perform("Saving your plan…", async () => {
      if (!plan || !fields) return;
      const body = await api(
        "/api/recipes",
        { method: "POST", body: JSON.stringify({ draft: jobPlanInput(plan, fields, draft.saved) }) },
        { timeoutMs: 15_000 },
      );
      accept(body.recipes ?? [], plan.id);
      setNotice("Plan saved. Review and approve the changes before this job runs again.");
      await refreshClock();
    });

  const approve = () =>
    perform("Approving this plan…", async () => {
      if (!plan || dirty || stale) return;
      const body = await api(
        `/api/recipes/${plan.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ planApproved: true, status: "active", expectedRevision: plan.revision }),
        },
        { timeoutMs: 15_000 },
      );
      accept(body.recipes ?? [], plan.id);
      setNotice(
        plan.schedule
          ? "Approved and scheduled. Keep RealBud running on this computer to prepare this job when it is due."
          : "Approved. This job runs only when you start it.",
      );
      await refreshClock();
    });

  const executeRun = async (plan: Recipe, mode: "run" | "prepare") => {
      const receiptMode = mode === "run" ? "shadow" : "prepare";
      const checking = pendingRequests[receiptMode];
      if (!plan || dirty || stale || (!checking && (running || !availability.ready))) return;
      const scope = { id: plan.id, revision: plan.revision, mode: receiptMode } as const;
      let requestId: string;
      if (checking) {
        setOperation("Checking the previous run…");
        const resumed = resumeManualJobRequest(scope, checking);
        if (!resumed.ready) {
          setPendingRequests((previous) => ({ ...previous, [receiptMode]: resumed.pendingRequestId }));
          setNotice(resumed.pendingRequestId
            ? "Another run is now pending on this device. Check its result before starting new work."
            : "That run is no longer pending on this device. Review the saved results below before starting new work.");
          await onRefresh();
          return;
        }
        requestId = resumed.requestId;
      } else {
        requestId = beginManualJobRequest(scope);
        setPendingRequests((previous) => ({ ...previous, [receiptMode]: requestId }));
      }
      let body: { run?: JobRun };
      try {
        body = await api(
          `/api/recipes/${plan.id}/${mode}`,
          { method: "POST", body: JSON.stringify({ expectedRevision: plan.revision, requestId }) },
          { timeoutMs: (plan.limits.maxRuntimeMinutes + 1) * 60_000 },
        );
      } catch (cause) {
        throw new Error(`${budFacingCopy(cause, "The run response could not be confirmed.")} Use Check ${mode === "run" ? "walkthrough result" : "previous run"} to recover this attempt.`);
      }
      if (!body.run)
        throw new Error("The run did not return a receipt. Reload jobs to check the result before running again.");
      dispatch({ type: "jobRun", run: body.run });
      const settled = confirmManualJobReceipt(scope, requestId, body.run);
      setPendingRequests((previous) => ({ ...previous, [receiptMode]: settled ? null : requestId }));
      setNotice(
        !settled
          ? body.run.status === "queued"
            ? "This run is waiting to start. Its progress will appear below; no second run was started."
            : "Bud is still working on this run. Its progress and saved result are below; no second run was started."
          : ["failed", "interrupted", "cancelled", "missed"].includes(body.run.status)
          ? "This run did not complete. Review the saved result below before starting another attempt."
          : mode === "run"
          ? "Walkthrough receipt is below. It describes the steps; it does not prove access to a live source."
          : "The run's result and any work held for you are below.",
      );
    };

  const run = (mode: "run" | "prepare") =>
    perform(mode === "run" ? "Walking through the saved steps…" : "Trying this job…", async () => {
      if (plan) await executeRun(plan, mode);
    });

  const approveAndTry = () => perform("Approving this job and starting one try…", async () => {
    if (!plan || dirty || stale || running || !availability.ready) return;
    let approvedRecipes: Recipe[] = [];
    const approved = await approveSingleTry(plan, async patch => {
      const body = await api(`/api/recipes/${plan.id}`, { method: "PATCH", body: JSON.stringify(patch) }, { timeoutMs: 15_000 });
      approvedRecipes = body.recipes ?? [];
      return body;
    });
    if (approvedRecipes.length) accept(approvedRecipes, plan.id);
    await executeRun(approved, "prepare");
    await refreshClock();
  });

  const toggleAbility = (ability: JobCapability) => {
    if (!fields) return;
    let next = fields.capabilities.includes(ability)
      ? fields.capabilities.filter((item) => item !== ability)
      : [...fields.capabilities, ability];
    if (ability === "portal-read" && !next.includes(ability))
      next = next.filter((item) => item !== "portal-prefill" && item !== "portal-submit");
    if (ability === "portal-prefill") {
      if (next.includes(ability) && !next.includes("portal-read")) next.push("portal-read");
      if (!next.includes(ability)) next = next.filter((item) => item !== "portal-submit");
    }
    change({ capabilities: next });
  };

  const togglePaused = () => perform("Updating this job…", async () => {
    if (!plan || dirty || stale || running) return;
    const body = await api(`/api/recipes/${plan.id}`, { method: "PATCH", body: JSON.stringify({ status: plan.status === "paused" ? "active" : "paused", expectedRevision: plan.revision }) }, { timeoutMs: 15_000 });
    accept(body.recipes ?? [], plan.id);
    await refreshClock();
  });
  // Improve steps rewrites the saved plan from its last run; the new version
  // needs approval again before it runs (the server resets approval).
  const improveSteps = () => perform("Improving the steps from the last run…", async () => {
    if (!plan || dirty || stale || running || !draft.saved) return;
    const body = (await api(`/api/recipes/${plan.id}/distill`, { method: "POST" }, { timeoutMs: 120_000 })) as { recipe?: Recipe };
    if (!body.recipe || body.recipe.id !== plan.id) throw new Error("Bud could not improve those steps. The saved plan is unchanged.");
    accept(recipes.map((item) => (item.id === plan.id ? body.recipe! : item)), plan.id);
    setNotice("Steps improved from the last run. Review and approve the new plan before it runs again.");
    await refreshClock();
  });

  const deleteJob = () => perform("Deleting this job…", async () => {
    if (!plan || dirty || running || !draft.saved) return;
    const body = await api(`/api/recipes/${plan.id}`, { method: "DELETE" }, { timeoutMs: 15_000 });
    const next = Array.isArray(body.recipes) ? (body.recipes as Recipe[]) : [];
    if (next.some((item) => item.id === plan.id)) throw new Error("The job could not be deleted. Reload jobs to check it.");
    onRecipes(next);
    setDraft(EMPTY_JOB_DRAFT);
    setConfirmDelete(false);
    await refreshClock();
    onDeleted?.();
  });

  const acknowledge = (activity: WorkActivity) => acknowledgeActivity(activity, state.loopRuns ?? [], dispatch);

  const actionBlocked = busy || blocked || stale || Boolean(DESIGN_PREVIEW_REASON);
  const showSection = (id: string) => {
    const section = document.getElementById(id);
    section?.scrollIntoView({ block: "start", behavior: "instant" });
    section?.focus({ preventScroll: true });
    if (id === "job-plan-results" && trial) {
      const result = [...(section?.querySelectorAll<HTMLDetailsElement>("details[data-activity-id]") ?? [])].find(item => item.dataset.activityId === `activity-job-${trial.id}`);
      if (result) result.open = true;
    }
  };
  return (
    <section
      id="bud-job-builder"
      tabIndex={-1}
      className="scroll-mt-4"
      aria-label={plan ? "Job plan" : "Add a job"}
    >
      <div>
        {!plan ? <p className="mb-3 text-[13px] text-ink-muted">Describe the outcome. Review Bud’s suggestion, try it once, then choose whether to repeat it.</p> : null}
        {!state.connected ? (
          <p role="status" className="mb-3 text-[14px] text-hold">
            Reconnecting. Your draft stays here; saves and runs will be available when the service returns.
          </p>
        ) : null}
        {loading ? (
          <p role="status" className="mb-3 text-[14px] text-ink-muted">
            Loading your saved jobs…
          </p>
        ) : null}
        {loadError && loadError !== error ? (
          <p role="alert" className="mb-3 text-[14px] text-danger">
            {loadError}
          </p>
        ) : null}
        {loadError && !busy ? (
          <button
            type="button"
            className={`${buttonClass} mb-3`}
            onClick={() => {
              void onRefresh()
                .then(() => setError(""))
                .catch(() => {});
            }}
          >
            Reload jobs
          </button>
        ) : null}
        {error ? (
          <p role="alert" className="mb-3 text-[14px] text-danger">
            {error}
          </p>
        ) : null}
        {refreshMissed ? <ActionNotice message="Your job was saved, but its latest schedule and results could not be loaded." onRetry={() => void refreshClock()} /> : null}
        {notice && !refreshMissed ? (
          <p role="status" className="mb-3 text-[14px] text-agency">
            {notice}
          </p>
        ) : null}
        {busy ? (
          <p role="status" className="mb-3 flex items-center gap-2 text-[14px] text-ink-muted">
            <Loader2 size={16} className="animate-spin motion-reduce:animate-none" />
            {operation || "Finishing the current step…"} Keep RealBud open until the result is saved.
          </p>
        ) : null}

        {DESIGN_PREVIEW_REASON ? <p role="status" className="mb-4 rounded border border-line bg-selected p-3 text-[14px] text-ink">{DESIGN_PREVIEW_REASON} You can describe a job and explore examples here. Suggestions, approvals and runs are available in the RealBud app.</p> : null}
        {!DESIGN_PREVIEW_REASON && !availability.ready && state.connected ? (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-l-2 border-hold pl-3">
            <p role="status" className="max-w-xl text-[14px] text-hold">{availability.detail}{!blocked ? " You can write and save the steps yourself." : ""}</p>
            {availability.action ? (
              <button type="button" className={buttonClass} onClick={() => {
                if (onSetup) { onSetup(); return; }
                if (availability.target === "you-recovery" || availability.target === "you-website") { location.hash = availability.target; dispatch({ type: "showYou" }); }
                else openWorkspaceSetup("bud");
              }}>{availability.action}</button>
            ) : null}
          </div>
        ) : null}
        {!plan ? (
          <div>
            <label className="block text-[14px] font-medium text-ink">
              What would you like Bud to do?
              <textarea
                value={draft.text}
                onChange={(event) => setDraft({ ...draft, text: event.target.value })}
                rows={3}
                maxLength={4000}
                disabled={busy || blocked}
                placeholder="Tell Bud which information to use and what you want back. For example: compare these invoices and show me what needs attention."
                className={`${inputClass} resize-y`}
              />
            </label>
            <p className="mt-1 text-[13px] text-ink-muted">
              Name the source and the result you need. You can choose repeat timing after a first try.
            </p>
            <div className="mt-3 flex flex-wrap gap-2" aria-label="Job examples">
              {JOB_OUTCOME_EXAMPLES.map(example => <button key={example.title} type="button" className={buttonClass} disabled={busy || blocked} onClick={() => {
                if (!canUseTaskStarter(draft.text)) { setNotice("Your description is kept. Clear it first to use an example."); return; }
                setDraft({ ...draft, text: example.text });
                setError("");
                setNotice("Example added. Check the source and the result you want before asking Bud.");
              }}>{example.title}</button>)}
            </div>
            <p className="mt-2 text-[12px] text-ink-muted">Mail examples use supplied evidence. Live Gmail collection belongs to your office’s connected mail workflow.</p>
            <details className="mt-2">
              <summary className="cursor-pointer py-2 text-[14px] text-ink-muted">More examples</summary>
              <PmTaskStarters disabled={busy || blocked} onChoose={(text) => {
                if (!canUseTaskStarter(draft.text)) {
                  setNotice("Your description is kept. Clear it first if you want to use an example.");
                  return;
                }
                setDraft({ ...draft, text });
                setError("");
                setNotice("Example added. Check the source and result before asking Bud.");
              }} />
            </details>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy || blocked || Boolean(DESIGN_PREVIEW_REASON) || !availability.ready || !draft.text.trim()}
                onClick={() => void build()}
                className={primaryClass}
              >
                <Sparkles size={16} />
                Suggest a job
              </button>
              {draft.text.trim() ? (
                <button type="button" disabled={busy || blocked} onClick={() => {
                  setDraft(EMPTY_JOB_DRAFT);
                  setError("");
                  setNotice("Description cleared.");
                }} className={buttonClass}>Clear description</button>
              ) : null}
            </div>
            <details className="mt-3" open={!availability.ready}>
              <summary className="cursor-pointer text-[13px] text-ink-muted">Write a plan yourself</summary>
              <p className="mt-2 text-[13px] text-ink-muted">Useful if you already have the steps, or Bud is not connected.</p>
              <button type="button" disabled={busy || blocked} onClick={writePlan} className={`${buttonClass} mt-2`}>
                <PencilLine size={15} />Write the steps myself
              </button>
            </details>
          </div>
        ) : fields ? (
          <div>
            <WorkContextCard title={fields.title || "Untitled job"} detail="Bud will prepare a result for you to review." status={stale ? "Changed elsewhere" : dirty || !draft.saved ? "Unsaved changes" : recipeNeedsPlanApproval(plan) ? "Suggestion — review before trying" : plan.status === "paused" ? "Paused" : plan.schedule ? "Repeating" : "On demand"}>
              <dl className="mt-3 space-y-2 text-[13px]">
                <div><dt className="font-medium text-ink">Source</dt><dd className="text-ink-secondary">{recipeSourceLine({ capabilities: fields.capabilities, allowedOrigins: fields.origins.split(/[\n,]/).map(value => value.trim()).filter(Boolean) })}</dd></div>
                <div><dt className="font-medium text-ink">Timing</dt><dd className="text-ink-secondary">{plan.schedule ? recipeScheduleLine(plan.schedule, timezone) : "One try at a time. Repeating is optional."}</dd></div>
              </dl>
            </WorkContextCard>
            <details className="my-4 rounded border border-line px-3 py-2">
              <summary className="cursor-pointer py-1 text-[14px] font-medium text-ink">Review steps and expected result</summary>
              <p className="mt-2 text-[13px] text-ink-secondary">{fields.evidence || "A result for you to review, with sources and anything still missing."}</p>
              <ol className="mt-2 list-decimal space-y-2 pl-5 text-[14px] text-ink-secondary">{fields.steps.split("\n").map(step => step.trim()).filter(Boolean).map((step, index) => <li key={index}>{step}</li>)}</ol>
            </details>
            {stale ? (
              <div role="alert" className="mb-3 border-l-2 border-hold pl-3 text-[14px] text-hold">
                This job changed elsewhere. Your edits have been kept; copy any changes you need before reloading the
                saved plan.
                {current ? (
                  <button
                    type="button"
                    disabled={busy}
                    className={`${buttonClass} ml-2`}
                    onClick={() => {
                      setDraft({
                        text: current.description,
                        plan: current,
                        fields: jobPlanFields(current),
                        saved: true,
                      });
                      setError("");
                    }}
                  >
                    Reload saved plan
                  </button>
                ) : null}
              </div>
            ) : null}
            <p className="mb-3 text-[13px] text-ink-secondary">{stale ? "Reload the saved version before continuing." : dirty ? "Save your changes before trying the job." : running ? "Bud is working. Its progress and result appear below." : trial ? "Review the result and any gaps below. You can adjust the job, try again or choose a repeat schedule." : portal ? "Review the website access below, then try the job beside Bud." : "A first try uses only the sources and steps shown here."}</p>
            <details open={editing || !draft.saved} onToggle={event => setEditing(event.currentTarget.open)} className="rounded border border-line px-3 py-2">
              <summary className="cursor-pointer py-1 text-[14px] font-medium text-ink">Edit job details</summary>
            <fieldset disabled={busy || blocked} className="space-y-4">
              <label className="block text-[14px] font-medium text-ink">
                Job name
                <input
                  value={fields.title}
                  maxLength={80}
                  onChange={(event) => change({ title: event.target.value })}
                  className={inputClass}
                />
              </label>
              <div>
                <label className="block text-[14px] font-medium text-ink">
                  Inputs and context
                  <textarea
                    value={fields.description}
                    rows={4}
                    maxLength={4000}
                    aria-describedby="job-inputs-help"
                    onChange={(event) => change({ description: event.target.value })}
                    className={`${inputClass} resize-y`}
                  />
                </label>
                <p id="job-inputs-help" className="mt-1 text-[13px] text-ink-muted">
                  Name the current sources or supply the facts for this job. Update old examples before reusing it; changed inputs need saving and approval.
                </p>
              </div>
              <label className="block text-[14px] font-medium text-ink">
                Steps — one per line
                <textarea
                  value={fields.steps}
                  rows={4}
                  onChange={(event) => change({ steps: event.target.value })}
                  className={`${inputClass} resize-y`}
                />
              </label>
              <label className="block text-[14px] font-medium text-ink">
                What should the result show?
                <input
                  value={fields.evidence}
                  maxLength={200}
                  placeholder="For example: changed balances, source dates, and drafts to review"
                  onChange={(event) => change({ evidence: event.target.value })}
                  className={inputClass}
                />
              </label>
              <details className="border-t border-line pt-2">
                <summary className="cursor-pointer py-2 text-[14px] font-medium text-ink">
                  Advanced · Sources and permissions
                </summary>
                <div className="mt-2 grid gap-1 sm:grid-cols-2">
                  {(Object.keys(JOB_ABILITY_LABELS) as JobCapability[])
                    .filter((ability) => ability !== "portal-submit" || plan.capabilities.includes(ability))
                    .map((ability) => (
                      <label key={ability} className="flex min-h-10 items-center gap-2 text-[14px] text-ink">
                        <input
                          type="checkbox"
                          checked={fields.capabilities.includes(ability)}
                          onChange={() => toggleAbility(ability)}
                        />
                        {JOB_ABILITY_LABELS[ability]}
                      </label>
                    ))}
                </div>
                <label className="mt-3 block text-[14px] text-ink">
                  Allowed websites — one hostname per line
                  <textarea
                    value={fields.origins}
                    rows={2}
                    onChange={(event) => change({ origins: event.target.value })}
                    placeholder="portal.example.com"
                    className={inputClass}
                  />
                </label>
                <p className="mt-2 text-[13px] text-ink-muted">
                  Each run stops after {plan.limits.maxRuntimeMinutes} minutes. Portal jobs also need site attachment
                  and run beside you. Payments, sends, signing, and statutory notices stay outside Bud's authority.
                </p>
              </details>
            </fieldset>
            </details>
            {recipeNeedsPlanApproval(plan) && !portal ? <ApprovalScope kind="plan" /> : null}
            <div id="job-plan-decisions" tabIndex={-1} aria-label="Next step" className="sticky bottom-0 -mx-4 mt-4 flex flex-wrap items-center gap-2 border-t border-line bg-sheet px-4 py-3">
              {dirty ? <>
                <button type="button" disabled={actionBlocked} onClick={() => void save()} className={primaryClass}>Save changes</button>
                <button type="button" disabled={busy} onClick={() => {
                  setDraft(draft.saved ? { ...draft, fields: jobPlanFields(plan) } : { ...EMPTY_JOB_DRAFT, text: draft.text });
                  setError(""); setEditing(false);
                }} className={buttonClass}>{draft.saved ? "Cancel changes" : "Discard draft"}</button>
              </> : <>
                {pendingRequests.prepare ? <button type="button" className={primaryClass} disabled={actionBlocked} onClick={() => void run("prepare")}>Check previous run</button>
                  : pendingRequests.shadow ? <button type="button" className={primaryClass} disabled={actionBlocked} onClick={() => void run("run")}>Check walkthrough result</button>
                  : running ? <button type="button" className={primaryClass} onClick={() => showSection("job-plan-results")}>View progress</button>
                  : !portal && recipeNeedsPlanApproval(plan) ? <button type="button" className={primaryClass} disabled={actionBlocked || (!plan.schedule && !availability.ready)} onClick={() => void (plan.schedule ? approve() : approveAndTry())}>
                    <CheckCircle2 size={16} />{plan.schedule ? "Approve repeat schedule" : "Approve and try once"}
                  </button>
                  : !portal && plan.status === "paused" ? <button type="button" className={primaryClass} disabled={actionBlocked} onClick={() => void togglePaused()}>Resume job</button>
                  : !portal && trial ? <>
                    <button type="button" className={primaryClass} onClick={() => showSection("job-plan-results")}>Review result</button>
                    <button type="button" className={buttonClass} disabled={actionBlocked || !availability.ready || !recipeClockRunnable(plan)} onClick={() => void run("prepare")}><Play size={15} />Try again</button>
                  </>
                  : !portal && recipeClockRunnable(plan) ? <button type="button" className={primaryClass} disabled={actionBlocked || !availability.ready} onClick={() => void run("prepare")}><Play size={16} />Try once</button> : null}
                {!recipeNeedsPlanApproval(plan) && plan.status === "active" ? <button type="button" disabled={actionBlocked || running} className={buttonClass} onClick={() => void togglePaused()}>Pause job</button> : null}
              </>}
            </div>
            {!dirty && !stale && !portal && recipeNeedsPlanApproval(plan) && !plan.schedule ? <p className="mt-2 text-[13px] text-ink-muted">This approves the saved steps for preparation and starts one run. No repeat schedule is enabled.</p> : null}
            {portal && !dirty && !stale && !blocked && !DESIGN_PREVIEW_REASON ? (
              <PortalJobActions
                recipe={plan}
                runs={state.jobRuns}
                onRecipe={(next) => {
                  const updated = recipes.map((item) => (item.id === next.id ? next : item));
                  accept(updated, next.id);
                  void refreshClock();
                }}
                onRun={(next) => dispatch({ type: "jobRun", run: next })}
                onShowAsk={onShowAsk ?? (() => dispatch({ type: "showAsk" }))}
              />
            ) : null}
            <div id="job-plan-results" tabIndex={-1} aria-label="Job results">
              {DESIGN_PREVIEW_REASON ? <p className="mt-4 text-[13px] text-ink-muted">Prepared results appear here after a run in the RealBud app.</p> : <JobRunFeed jobId={plan.id} className="mt-4" onOpenResult={acknowledge} />}
            </div>
            {draft.saved && current && !DESIGN_PREVIEW_REASON ? <div className="mt-3"><ExecutionHistory jobId={plan.id} /></div> : null}
            {/* TODO(phase 4): Change with Bud — Ask cannot apply schedule changes yet (server/schedule-intent.ts redirects). */}
            <details className="mt-4 rounded border border-line px-3 py-2">
              <summary className="cursor-pointer py-1 text-[14px] font-medium text-ink">Timing</summary>
              <p className="mt-2 text-[13px] text-ink-muted">Choose timing after checking a result. Saving a time does not activate it; approve the saved repeat schedule separately. Repeating these steps does not connect new sources.</p>
              {(trial || plan.schedule) ? <fieldset disabled={busy || blocked} className="mt-3">
              <fieldset className="border-t border-line pt-3">
                <legend className="pr-2 text-[14px] font-medium text-ink">When should it repeat?</legend>
                <div className="flex flex-wrap gap-x-5 gap-y-2 text-[14px]">
                  <label className="flex min-h-10 items-center gap-2">
                    <input
                      type="radio"
                      name="job-timing"
                      checked={!fields.scheduled}
                      onChange={() => change({ scheduled: false })}
                    />
                    Only when I run it
                  </label>
                  <label className="flex min-h-10 items-center gap-2">
                    <input
                      type="radio"
                      name="job-timing"
                      checked={fields.scheduled}
                      onChange={() => change({ scheduled: true })}
                    />
                    Repeat on a schedule
                  </label>
                </div>
                {fields.scheduled ? (
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <label className="text-[13px] text-ink">
                      Time
                      <input
                        type="time"
                        value={fields.time}
                        onInput={(event) => change({ time: event.currentTarget.value })}
                        onChange={(event) => change({ time: event.target.value })}
                        className={inputClass}
                      />
                    </label>
                    <div role="group" aria-label="Days to run" className="flex flex-wrap gap-1">
                      {WEEKDAYS_MON_FIRST.map((day) => (
                        <button
                          key={day}
                          type="button"
                          aria-pressed={fields.weekdays.includes(day)}
                          onClick={() =>
                            change({
                              weekdays: fields.weekdays.includes(day)
                                ? fields.weekdays.filter((item) => item !== day)
                                : [...fields.weekdays, day].sort((a, b) => a - b),
                            })
                          }
                          className={cn(
                            buttonClass,
                            fields.weekdays.includes(day) && "bg-agency text-white hover:bg-agency-hover",
                          )}
                        >
                          {DAY_NAMES[day]}
                        </button>
                      ))}
                    </div>
                    <p className="w-full text-[13px] text-ink-muted">
                      {timezone || "This computer's timezone"} · Keep RealBud running for scheduled work. Changes need
                      approval again.
                    </p>
                  </div>
                ) : null}
              </fieldset>

              </fieldset> : <p className="mt-2 text-[13px] text-ink-secondary">Try this job once first. A walkthrough does not count as a source-backed result.</p>}
            </details>
            <details className="mt-4 border-t border-line pt-3">
              <summary className="cursor-pointer text-[13px] text-ink-muted">Walk through the steps without using sources</summary>
              <p className="mt-2 text-[13px] text-ink-muted">A walkthrough explains the saved instructions. It does not open sources, verify access or prepare a live result.</p>
              <button type="button" className={`${buttonClass} mt-2`} disabled={actionBlocked || dirty || (!pendingRequests.shadow && (running || !availability.ready))} onClick={() => void run("run")}>
                {pendingRequests.shadow ? "Check walkthrough result" : "Preview steps only"}
              </button>
            </details>
            {draft.saved && current ? (
              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3" role="group" aria-label="More job actions">
                <button type="button" className={buttonClass} disabled={actionBlocked || dirty || running || !runs.some((item) => !["queued", "running"].includes(item.status))} onClick={() => void improveSteps()}>
                  <Sparkles size={15} aria-hidden />Improve steps
                </button>
                {!confirmDelete ? (
                  <button type="button" className={buttonClass} disabled={actionBlocked || dirty || running} onClick={() => setConfirmDelete(true)}>Delete job</button>
                ) : (
                  <>
                    <span className="text-[13px] text-ink">Delete this job? Saved results stay in Past results.</span>
                    <button type="button" className={cn(buttonClass, "border-danger/40 text-danger")} disabled={actionBlocked || dirty || running} onClick={() => void deleteJob()}>Confirm delete</button>
                    <button type="button" className={buttonClass} disabled={busy} onClick={() => setConfirmDelete(false)}>Keep job</button>
                  </>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
