import { useWorkspaceViewState } from "@/lib/workspace-view-state";
import { CopyButton } from "../CopyButton";
import { WorkContextCard } from "../WorkContextCard";
import { useId, useMemo, useState } from "react";
import { Loader2, MessageSquare, Play } from "lucide-react";

import { fmtDateTime } from "@/lib/au";
import type { JobRun } from "@/lib/desk";
import type { LoopRun } from "@/lib/routines";
import {
  attendedEvidenceLine,
  attendedRunLabel,
  isAttendedMode,
  jobRunStatusChip,
  jobRunSummaryLine,
  runsForJob,
  safeJobRunDetail,
  preparedJobText,
} from "@/lib/job-run";
import { api, useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { buildWorkActivity, type WorkActivity } from "@/lib/work-activity";
import { hasHeldPreparationContext, jobRunContext } from "@/lib/work-continuation";
import { StatusLabel } from "../pm";

function routineStatusChip(status: LoopRun["status"]): { label: string; className: string } {
  if (status === "completed") return { label: "Finished", className: "bg-agency/10 text-agency" };
  if (status === "awaiting-approval") return { label: "Needs you", className: "bg-hold/10 text-hold" };
  if (status === "partial") return { label: "Partial", className: "bg-hold/10 text-hold" };
  if (status === "queued" || status === "running") return { label: status === "queued" ? "Queued" : "Running", className: "bg-selected text-agency" };
  return { label: status === "missed" ? "Missed" : status === "interrupted" ? "Interrupted" : "Failed", className: "bg-danger/10 text-danger" };
}

export function JobRunFeed({
  jobId,
  limit = 8,
  className,
  onOpenResult,
  deskResultCount,
  onOpenDesk,
}: {
  jobId?: string;
  limit?: number;
  className?: string;
  onOpenResult?: (activity: WorkActivity) => void;
  deskResultCount?: (activity: WorkActivity) => number;
  onOpenDesk?: () => void;
}) {
  const { state, dispatch, refreshActivity } = useStore();
  const titleId = useId();
  const [expandedActivities, setExpandedActivities] = useWorkspaceViewState("expandedActivities");
  const remember = (id: string, open: boolean) => setExpandedActivities(current => open ? current.includes(id) ? current : [...current, id].slice(-100) : current.includes(id) ? current.filter(value => value !== id) : current);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [startError, setStartError] = useState("");
  const [announce, setAnnounce] = useState("");
  const boundedLimit = Math.max(1, Math.min(50, limit));
  const runs = jobId ? runsForJob(state.jobRuns, jobId) : state.jobRuns;
  const loopRuns = state.loopRuns;
  const loading = state.activityLoad.jobs === "loading" || (!jobId && state.activityLoad.routines === "loading");
  const loadFailed = state.activityLoad.jobs === "error" || (!jobId && state.activityLoad.routines === "error");

  const visible = useMemo(() => {
    const rows = buildWorkActivity(runs, jobId ? [] : loopRuns);
    rows.sort((a, b) => {
      const queued = (row: typeof a) =>
        row.kind === "job" && isAttendedMode(row.run.mode) && row.run.status === "queued" ? 1 : 0;
      const delta = queued(b) - queued(a);
      if (delta !== 0) return delta;
      return b.at - a.at || b.id.localeCompare(a.id);
    });
    return rows.slice(0, boundedLimit);
  }, [boundedLimit, jobId, loopRuns, runs]);

  const startQueued = async (run: JobRun) => {
    setStartingId(run.id);
    setStartError("");
    try {
      const body = (await api(`/api/recipes/${run.jobId}/attend`, {
        method: "POST",
        body: JSON.stringify({ runId: run.id }),
      })) as { run?: JobRun };
      if (!body.run) throw new Error("Bud could not start that run.");
      dispatch({ type: "jobRun", run: body.run });
      const text = `Running ${body.run.jobTitle} beside you — answer Bud's requests in Ask; sign in when the page asks.`;
      setAnnounce(text);
      dispatch({ type: "showAsk" });
    } catch (cause) {
      setStartError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStartingId(null);
    }
  };

  const deskLink = (activity: WorkActivity) => {
    const count = deskResultCount?.(activity) ?? 0;
    return count > 0 && onOpenDesk ? (
      <button type="button" onClick={onOpenDesk} className="pm-control mt-2 rounded border border-line bg-sheet px-3 text-[13px] text-ink hover:bg-selected">
        Review {count} {count === 1 ? "task" : "tasks"} on Desk
      </button>
    ) : null;
  };

  return (
    <section className={cn("rounded-xl border border-line bg-sheet p-3.5", className)} aria-labelledby={titleId}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 id={titleId} className="text-[13px] font-medium text-ink">Work activity</h2>
          <p className="mt-0.5 text-[13px] text-ink-muted">{jobId ? "Prepared work, sources and any steps waiting for you." : "Rechecks, routines and taught jobs in one activity trail."}</p>
        </div>
      </div>

      {!state.connected ? <p role="status" className="mt-3 text-[13px] text-hold">Reconnecting. Shown results are from the last successful load.</p> : null}
      {loading && state.connected ? <p role="status" className="mt-3 text-[13px] text-ink-muted">Loading activity…</p> : null}
      {loadFailed ? <div role="alert" className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-hold">
        Some activity could not be loaded. Existing results are kept.
        <button type="button" disabled={loading || !state.connected} onClick={() => void refreshActivity()} className="pm-control rounded border border-line px-3 text-ink hover:bg-selected disabled:opacity-40">Reload activity</button>
      </div> : null}
      {!loading && !loadFailed && state.connected && visible.length === 0 ? (
        <p className="mt-3 text-[13px] text-ink-secondary">{jobId ? "No runs yet. Your first rehearsal and prepared work will appear here." : "No work has run yet. Recheck the book or rehearse a taught job."}</p>
      ) : null}
      {visible.length ? (
        <ul className="mt-2 divide-y divide-line">
          {visible.map((activity) => {
            if (activity.kind === "routine") {
              const run = activity.run;
              const chip = routineStatusChip(run.status);
              return (
                <li key={activity.id} className="py-2.5 first:pt-1 last:pb-0">
                  <details open={expandedActivities.includes(`routine-${run.id}`)} data-activity-id={`activity-routine-${run.id}`} onToggle={(event) => { remember(`routine-${run.id}`, event.currentTarget.open); if (event.currentTarget.open) onOpenResult?.(activity); }}>
                    <summary className="cursor-pointer list-none">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-medium text-ink">{run.loopName}</div>
                          <div className="mt-0.5 text-[11.5px] text-ink-muted">
                            {run.manual ? "Run now" : "Scheduled run"} · {fmtDateTime(run.startedAt ?? run.createdAt)}
                          </div>
                        </div>
                        <span className={cn("shrink-0 rounded px-2 py-0.5 text-[11px]", chip.className)}>{chip.label}</span>
                      </div>
                    </summary>
                    <div className="mt-2 rounded-lg border border-hairline/40 bg-inset/40 px-3 py-2 text-[12px] text-ink-secondary">
                      <p>{run.detail || "No detail recorded."}</p>
                      <p className="mt-1 text-[11.5px] text-ink-muted">
                        Scheduled for {fmtDateTime(run.scheduledFor)} · Nothing was sent, submitted, or paid.
                      </p>
                      {deskLink(activity)}
                    </div>
                  </details>
                </li>
              );
            }
            const run = activity.run;
            const preparedText = preparedJobText(run);
            const chip = jobRunStatusChip(run.status);
            const attended = attendedRunLabel(run);
            const readyQueued = isAttendedMode(run.mode) && run.status === "queued";
            return (
              <li key={activity.id} className="py-2.5 first:pt-1 last:pb-0">
                {readyQueued ? (
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <StatusLabel tone="hold">Ready beside you</StatusLabel>
                    <button
                      type="button"
                      disabled={startingId != null}
                      onClick={() => void startQueued(run)}
                      className="pm-decision inline-flex items-center gap-1.5 rounded-lg bg-agency px-3 text-[13px] font-medium text-white hover:bg-agency-hover disabled:opacity-40"
                    >
                      {startingId === run.id ? (
                        <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden />
                      ) : (
                        <Play size={13} aria-hidden />
                      )}
                      Start beside me
                    </button>
                  </div>
                ) : null}
                {isAttendedMode(run.mode) && run.status === "running" ? <button type="button" className="pm-control mb-2 rounded border border-line px-3 text-sm" onClick={() => void (async () => {
                  try { await api("/api/human-handoffs", { method: "POST", body: JSON.stringify({ runId: run.id, reason: "login" }) }); await refreshActivity(); }
                  catch (cause) { setStartError(cause instanceof Error ? cause.message : "The sign-in handover could not be confirmed."); }
                })()}>Pause for sign-in or verification code</button> : null}
                <details open={expandedActivities.includes(`job-${run.id}`)} data-activity-id={`activity-job-${run.id}`} onToggle={(event) => { remember(`job-${run.id}`, event.currentTarget.open); if (event.currentTarget.open) onOpenResult?.(activity); }}>
                  <summary className="cursor-pointer list-none">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium text-ink">{run.jobTitle}</div>
                        <div className="mt-0.5 text-[11.5px] text-ink-muted">{jobRunSummaryLine(run)}</div>
                      </div>
                      {attended && !readyQueued ? (
                        <StatusLabel tone={attended.tone}>{attended.label}</StatusLabel>
                      ) : !readyQueued ? (
                        <span className={cn("shrink-0 rounded px-2 py-0.5 text-[11px]", chip.className)}>{chip.label}</span>
                      ) : null}
                    </div>
                  </summary>
                  <div className="mt-2 rounded-lg border border-hairline/40 bg-inset/40 px-3 py-2 text-[12px] text-ink-secondary">
                    <p>{safeJobRunDetail(run.detail) || "No detail recorded."}</p>
                    {preparedText ? (
                      <div className="mt-3 border-y border-line py-3">
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                          <h4 className="text-[14px] font-medium text-ink">{run.status === "partial" ? "Partial prepared work" : "Prepared work"}</h4>
                          <div className="flex flex-wrap gap-2">
                          <CopyButton text={preparedText} label="Copy prepared text" />
                          <button type="button" className="pm-control inline-flex items-center gap-1.5 rounded bg-agency px-3 text-[13px] text-white hover:bg-agency-hover" onClick={() => {
                            const context = jobRunContext(run, crypto.randomUUID());
                            if (context) dispatch({ type: "stageAskContext", context });
                          }}><MessageSquare size={14} aria-hidden />Continue with Bud</button>
                          </div>
                        </div>
                        <p className="select-text whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink">{preparedText}</p>
                      </div>
                    ) : null}
                    <WorkContextCard title={run.jobTitle} detail={run.spec.description} status={chip.label} />
                    <p className="mt-1 text-[11.5px] text-ink-muted">
                      {run.trigger === "schedule" ? "Scheduled run" : "Run now"} · plan v{run.jobRevision} · {fmtDateTime(run.startedAt ?? run.createdAt)}
                    </p>
                    {run.status === "awaiting-approval" ? (
                      <p className="mt-2 font-medium text-hold">
                        Held for you. Nothing was sent, submitted, or paid.
                      </p>
                    ) : null}
                    {run.approvalRequests.length ? (
                      <ul className="mt-1 list-disc space-y-1 pl-5 text-hold">
                        {run.approvalRequests.map((request, index) => (
                          <li key={`${index}-${request}`}>{request}</li>
                        ))}
                      </ul>
                    ) : null}
                    {!preparedText && hasHeldPreparationContext(run) ? (
                      <div className="mt-3 border-t border-line pt-3">
                        <p className="mb-2 text-[13px] text-ink-secondary">Continue with this job and its open questions attached. You can add the facts in Ask before sending.</p>
                        <button type="button" className="pm-control inline-flex items-center gap-1.5 rounded bg-agency px-3 text-[13px] text-white hover:bg-agency-hover" onClick={() => {
                          const context = jobRunContext(run, crypto.randomUUID());
                          if (context) dispatch({ type: "stageAskContext", context });
                        }}><MessageSquare size={14} aria-hidden />Continue with Bud</button>
                      </div>
                    ) : null}
                    {deskLink(activity)}
                    {isAttendedMode(run.mode) && run.evidence.length ? (
                      <details className="mt-2 border-t border-line pt-2">
                        <summary className="cursor-pointer text-[12px] text-ink-secondary">
                          What Bud did · {run.evidence.length} {run.evidence.length === 1 ? "action" : "actions"}
                        </summary>
                        <ul className="mt-1 space-y-1">
                          {run.evidence.map((item, index) => {
                            const line = attendedEvidenceLine(item);
                            return (
                              <li
                                key={`${item.at}-${index}`}
                                className={line.denied ? "text-hold" : "text-ink-muted"}
                              >
                                <span className="inline-flex flex-wrap items-center gap-1.5">
                                  {line.label}
                                  {line.rule ? (
                                    <span className="rounded-full border border-line px-1.5 py-0.5 text-[10px] text-ink-muted">
                                      rule
                                    </span>
                                  ) : null}
                                </span>
                                {line.denied ? " · stopped by the fence" : null}
                              </li>
                            );
                          })}
                        </ul>
                      </details>
                    ) : run.evidence.length ? (
                      <ul className="mt-2 space-y-1 border-t border-line pt-2 text-ink-muted">
                        {run.evidence.filter((item) => !preparedText || item.kind !== "output").map((item, index) => {
                          const line = attendedEvidenceLine(item);
                          return (
                            <li key={`${item.at}-${index}`}>
                              <span className="inline-flex flex-wrap items-center gap-1.5">
                                <span className="font-medium text-ink-secondary">{item.kind}</span>
                                <span>· {line.submitApproved ? line.label : item.note}</span>
                                {line.rule ? (
                                  <span className="rounded-full border border-line px-1.5 py-0.5 text-[10px] text-ink-muted">
                                    rule
                                  </span>
                                ) : null}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      ) : null}
      {startError ? (
        <p role="alert" className="mt-2 text-[12.5px] text-hold">
          {startError}
        </p>
      ) : null}
      {announce ? (
        <p role="status" aria-live="polite" className="mt-2 text-[12.5px] text-ink-secondary">
          {announce}
        </p>
      ) : null}
    </section>
  );
}
