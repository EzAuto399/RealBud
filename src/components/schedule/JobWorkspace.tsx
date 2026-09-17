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
import { BankReferenceReview } from "./BankReferenceReview";
import { PortalJobActions } from "./PortalJobActions";
import { budAvailability, budFacingCopy } from "@/lib/bud-setup";
import { canUseTaskStarter } from "@/lib/pm-task-starters";
import { PmTaskStarters } from "../PmTaskStarters";
import { hasUnfinishedJobDraft } from "@/lib/work-continuation";
import { beginManualJobRequest, confirmManualJobReceipt, pendingManualJobRequest, resumeManualJobRequest } from "@/lib/manual-job-request";

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
}: {
  onSetup?: () => void;
  onShowAsk?: () => void;
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
  const availability = budAvailability(state.hermes, state.connected, Boolean(state.desk?.recovery?.active));
  const blocked = !state.connected || Boolean(state.desk?.recovery?.active) || loading || Boolean(loadError);
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

  const open = (recipe: Recipe) => {
    if (busy || unfinished) {
      setError(!plan && unfinished
        ? "Build or clear your description before opening another job."
        : "Save or cancel your changes before opening another job.");
      return;
    }
    setDraft({ text: recipe.description, plan: recipe, fields: jobPlanFields(recipe), saved: true });
    setError("");
    setNotice("");
    const workspace = document.getElementById("bud-job-builder");
    workspace?.scrollIntoView({ block: "start" });
    workspace?.focus({ preventScroll: true });
  };

  const accept = (next: Recipe[], id: string) => {
    const saved = next.find((item) => item.id === id);
    if (!saved) throw new Error("The saved job could not be read back. Reload jobs to check it before trying again.");
    onRecipes(next);
    setDraft({ text: saved.description, plan: saved, fields: jobPlanFields(saved), saved: true });
  };

  const perform = async (label: string, work: () => Promise<void>) => {
    if (inFlight.current || busy || blocked) return;
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
      // Keep the shaped plan in app memory even if the following save fails.
      setDraft({ text: draft.text, plan: shaped.draft, fields: jobPlanFields(shaped.draft), saved: false });
      const body = await api(
        "/api/recipes",
        { method: "POST", body: JSON.stringify({ draft: { ...shaped.draft, expectedRevision: 0 } }) },
        { timeoutMs: 15_000 },
      );
      accept(body.recipes ?? [], shaped.draft.id);
      setNotice("Plan saved for review. Nothing is scheduled yet. Check the steps, then rehearse them.");
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
    setNotice("Write the steps and save the plan. The job will stay paused until you approve it.");
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

  const run = (mode: "run" | "prepare") =>
    perform(mode === "run" ? "Rehearsing the saved steps…" : "Preparing the work…", async () => {
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
        throw new Error(`${budFacingCopy(cause, "The run response could not be confirmed.")} Use Check ${mode === "run" ? "rehearsal result" : "previous run"} to recover this attempt.`);
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
          ? "Rehearsal receipt is below. It describes the steps; it does not prove access to a live source."
          : "The run's result and any work held for you are below.",
      );
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

  const reviewJobs = recipes.filter((recipe) => !recipe.schedule || recipeNeedsPlanApproval(recipe));
  const showSection = (id: string) => {
    const section = document.getElementById(id);
    section?.scrollIntoView({ block: "start", behavior: "instant" });
    section?.focus({ preventScroll: true });
  };
  return (
    <>
    <section
      id="bud-job-builder"
      tabIndex={-1}
      className="mb-6 scroll-mt-4 rounded-lg border border-line bg-sheet"
      aria-labelledby="bud-new-job-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 id="bud-new-job-title" className="text-[16px] font-semibold text-ink">
            {plan ? "Your job plan" : "Teach Bud a job"}
          </h2>
          <p className="mt-1 text-[13px] text-ink-muted">Describe the work, review the plan, then prepare and check the result.</p>
        </div>
        {plan ? (
          <button
            type="button"
            disabled={busy || dirty}
            onClick={() => {
              setDraft(EMPTY_JOB_DRAFT);
              setError("");
              setNotice("");
            }}
            className={buttonClass}
          >
            Close plan
          </button>
        ) : null}
      </div>
      <div className="p-4">
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

        {!availability.ready && state.connected ? (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-l-2 border-hold pl-3">
            <p role="status" className="max-w-xl text-[14px] text-hold">{availability.detail}{!blocked ? " You can write and save the steps yourself." : ""}</p>
            {availability.action ? (
              <button type="button" className={buttonClass} onClick={() => {
                if (onSetup) { onSetup(); return; }
                if (availability.target === "you-recovery") { location.hash = availability.target; dispatch({ type: "showYou" }); }
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
                placeholder="Every Friday, compare the current arrears export with our notes and prepare the follow-ups that need review."
                className={`${inputClass} resize-y`}
              />
            </label>
            <p className="mt-1 text-[13px] text-ink-muted">
              Name the source and the result you need. Add a time for a recurring job, or keep it on demand.
            </p>
            <details className="mt-2">
              <summary className="cursor-pointer py-2 text-[14px] text-ink-muted">Start from a PM task example</summary>
              <PmTaskStarters disabled={busy || blocked} onChoose={(text) => {
                if (!canUseTaskStarter(draft.text)) {
                  setNotice("Your description is kept. Clear it first if you want to use an example.");
                  return;
                }
                setDraft({ ...draft, text });
                setError("");
                setNotice("Example added. Edit the source, result and timing before building your plan.");
              }} />
            </details>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy || blocked || !availability.ready || !draft.text.trim()}
                onClick={() => void build()}
                className={primaryClass}
              >
                <Sparkles size={16} />
                Build my plan
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
            <WorkContextCard title={fields.title || "Untitled job"} detail={fields.description} status={stale ? "Changed elsewhere" : dirty || !draft.saved ? "Unsaved changes" : recipeNeedsPlanApproval(plan) ? "Plan needs approval" : plan.status === "paused" ? "Paused" : plan.schedule ? "Scheduled" : "Ready on demand"} />
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
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-y border-line py-2">
              <p className="text-[14px] text-ink">
                {stale ? "Reload the saved version before continuing." : dirty ? "Next: save your changes for review." : activeRun?.status === "queued" ? "This job is waiting to start. Check its status below." : running ? "Bud is working. Check the result below." : recipeNeedsPlanApproval(plan) ? "Next: review the steps and approve the saved plan." : plan.status === "paused" ? "This job is paused." : "The plan is approved. Review each result before using it."}
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={buttonClass} onClick={() => showSection("job-plan-decisions")}>Plan actions</button>
                <button type="button" className={buttonClass} onClick={() => showSection("job-plan-results")}>View results{runs.length ? ` (${runs.length})` : ""}</button>
              </div>
            </div>
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
              <fieldset className="border-t border-line pt-3">
                <legend className="pr-2 text-[14px] font-medium text-ink">When should this run?</legend>
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
              <details className="border-t border-line pt-2">
                <summary className="cursor-pointer py-2 text-[14px] font-medium text-ink">
                  Sources and permissions{" "}
                  <span className="font-normal text-ink-muted">
                    ·{" "}
                    {recipeSourceLine({
                      capabilities: fields.capabilities,
                      allowedOrigins: fields.origins
                        .split(/[\n,]/)
                        .map((item) => item.trim())
                        .filter(Boolean),
                    })}
                  </span>
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
            <ApprovalScope kind="plan" />
            <div id="job-plan-decisions" tabIndex={-1} aria-label="Plan actions" className="sticky bottom-0 -mx-4 mt-4 flex flex-wrap items-center gap-2 border-t border-line bg-sheet px-4 py-3">
              {dirty ? (
                <>
                  <button
                    type="button"
                    disabled={busy || blocked || stale}
                    onClick={() => void save()}
                    className={primaryClass}
                  >
                    Save plan
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setDraft(
                        draft.saved
                          ? { ...draft, fields: jobPlanFields(plan) }
                          : { ...EMPTY_JOB_DRAFT, text: draft.text },
                      );
                      setError("");
                    }}
                    className={buttonClass}
                  >
                    {draft.saved ? "Cancel changes" : "Discard draft"}
                  </button>
                  <span className="text-[13px] text-ink-muted">Save before rehearsing or approving.</span>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={busy || blocked || stale || (!pendingRequests.shadow && (running || !availability.ready))}
                    onClick={() => void run("run")}
                    className={buttonClass}
                  >
                    <Play size={15} />
                    {pendingRequests.shadow ? "Check rehearsal result" : "Rehearse steps"}
                  </button>
                  {recipeNeedsPlanApproval(plan) ? (
                    <button
                      type="button"
                      disabled={busy || blocked || stale || running}
                      onClick={() => void approve()}
                      className={primaryClass}
                    >
                      <CheckCircle2 size={16} />
                      {plan.schedule ? "Approve and schedule" : "Approve for on-demand use"}
                    </button>
                  ) : pendingRequests.prepare || (recipeClockRunnable(plan) && !portal) ? (
                    <button
                      type="button"
                      disabled={busy || blocked || stale || (!pendingRequests.prepare && (running || !availability.ready))}
                      onClick={() => void run("prepare")}
                      className={primaryClass}
                    >
                      <Play size={16} />
                      {pendingRequests.prepare ? "Check previous run" : "Prepare now"}
                    </button>
                  ) : null}
                  {!recipeNeedsPlanApproval(plan) ? (
                    <button
                      type="button"
                      disabled={busy || blocked || stale || running}
                      className={buttonClass}
                      onClick={() =>
                        void perform("Updating this job…", async () => {
                          const body = await api(
                            `/api/recipes/${plan.id}`,
                            {
                              method: "PATCH",
                              body: JSON.stringify({
                                status: plan.status === "paused" ? "active" : "paused",
                                expectedRevision: plan.revision,
                              }),
                            },
                            { timeoutMs: 15_000 },
                          );
                          accept(body.recipes ?? [], plan.id);
                          await refreshClock();
                        })
                      }
                    >
                      {plan.status === "paused" ? "Resume job" : "Pause job"}
                    </button>
                  ) : null}
                </>
              )}
            </div>
            <p className="mt-2 text-[13px] text-ink-muted">
              Rehearsal explains the saved steps without opening sources or changing records. Live results need a
              separate run.
            </p>
            {portal && !dirty && !stale && !blocked ? (
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
              <JobRunFeed jobId={plan.id} className="mt-4" />
            </div>
          </div>
        ) : null}
      </div>
      {reviewJobs.length ? (
        <div className="border-t border-line px-4 py-3">
          <h3 className="text-[14px] font-medium text-ink">Review and on-demand jobs</h3>
          <ul className="mt-2 divide-y divide-line">
            {reviewJobs.map((recipe) => (
              <li key={recipe.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-3">
                <div className="min-w-0 flex-1">
                  <p className="break-words text-[14px] font-medium text-ink">{recipe.title}</p>
                  <p className="text-[13px] text-ink-muted">
                    {recipeNeedsPlanApproval(recipe)
                      ? "Needs your approval"
                      : recipe.status === "paused"
                        ? "Paused"
                        : "Ready"}{" "}
                    · {recipe.schedule ? recipeScheduleLine(recipe.schedule, timezone) : "Only when you run it"}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busy || dirty}
                  onClick={() => open(recipe)}
                  className={buttonClass}
                  aria-label={`Open job: ${recipe.title}`}
                >
                  Open job
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
    <div className="mb-6"><BankReferenceReview /></div>
    </>
  );
}
