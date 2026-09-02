import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Play } from "lucide-react";

import { fmtDateTime } from "@/lib/au";
import type { JobRun } from "@/lib/desk";
import type { LoopRun } from "@/lib/routines";
import {
  attendedEvidenceLine,
  attendedRunLabel,
  isAttendedMode,
  jobRunStatusChip,
  jobRunSummaryLine,
  runningAttended,
  safeJobRunDetail,
} from "@/lib/job-run";
import { api, useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { buildWorkActivity } from "@/lib/work-activity";
import { StatusLabel } from "../pm";

function routineStatusChip(status: LoopRun["status"]): { label: string; className: string } {
  if (status === "completed") return { label: "Finished", className: "bg-agency/10 text-agency" };
  if (status === "partial") return { label: "Partial", className: "bg-hold/10 text-hold" };
  if (status === "queued" || status === "running") return { label: status === "queued" ? "Queued" : "Running", className: "bg-selected text-agency" };
  return { label: status === "missed" ? "Missed" : status === "interrupted" ? "Interrupted" : "Failed", className: "bg-danger/10 text-danger" };
}

export function JobRunFeed({
  jobId,
  limit = 8,
  className,
}: {
  jobId?: string;
  limit?: number;
  className?: string;
}) {
  const { dispatch } = useStore();
  const [runs, setRuns] = useState<JobRun[] | null>(null);
  const [loopRuns, setLoopRuns] = useState<LoopRun[] | null>(null);
  const [error, setError] = useState("");
  const [startingId, setStartingId] = useState<string | null>(null);
  const [startError, setStartError] = useState("");
  const [announce, setAnnounce] = useState("");
  const boundedLimit = Math.max(1, Math.min(50, limit));

  const load = useCallback(() => {
    const query = new URLSearchParams({ limit: String(Math.max(boundedLimit, 20)) });
    if (jobId) query.set("jobId", jobId);
    void Promise.all([
      api(`/api/job-runs?${query.toString()}`) as Promise<{ runs?: JobRun[] }>,
      api("/api/loops") as Promise<{ runs?: LoopRun[] }>,
    ])
      .then(([jobs, loops]) => {
        setRuns(Array.isArray(jobs.runs) ? jobs.runs : []);
        setLoopRuns(Array.isArray(loops.runs) ? loops.runs : []);
        setError("");
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [boundedLimit, jobId]);

  const attendedLive = Boolean(runs && runningAttended(runs, jobId));
  useEffect(() => {
    load();
    const timer = window.setInterval(load, attendedLive ? 3_000 : 10_000);
    return () => window.clearInterval(timer);
  }, [attendedLive, load]);

  const visible = useMemo(() => {
    const rows = buildWorkActivity(
      (runs ?? []).filter((run) => !jobId || run.jobId === jobId),
      jobId ? [] : (loopRuns ?? []),
    );
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
      setRuns((prev) => (prev ?? []).map((item) => (item.id === body.run!.id ? body.run! : item)));
      const text = `Running ${body.run.jobTitle} beside you — answer Bud's requests in Ask; sign in when the page asks.`;
      setAnnounce(text);
      dispatch({ type: "showAsk" });
    } catch (cause) {
      setStartError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStartingId(null);
    }
  };

  return (
    <section className={cn("rounded-xl border border-line bg-sheet p-3.5", className)} aria-labelledby="work-activity-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 id="work-activity-title" className="text-[13px] font-medium text-ink">Work activity</h2>
          <p className="mt-0.5 text-[12px] text-ink-muted">Rechecks, routines, and taught jobs — one receipt trail.</p>
        </div>
        {error ? (
          <button type="button" onClick={load} className="text-[12px] font-medium text-agency hover:underline">
            Retry
          </button>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-[12px] text-danger">
          {runs ? `Could not refresh receipts — ${error}` : error}
        </p>
      ) : null}
      {!error && (runs == null || loopRuns == null) ? <p role="status" className="mt-3 text-[12px] text-ink-muted">Loading activity…</p> : null}
      {runs && loopRuns && visible.length === 0 ? (
        <p className="mt-3 text-[12px] text-ink-secondary">No work has run yet. Recheck the book or rehearse a taught job.</p>
      ) : null}
      {visible.length ? (
        <ul className="mt-2 divide-y divide-line">
          {visible.map((activity) => {
            if (activity.kind === "routine") {
              const run = activity.run;
              const chip = routineStatusChip(run.status);
              return (
                <li key={activity.id} className="py-2.5 first:pt-1 last:pb-0">
                  <details>
                    <summary className="cursor-pointer list-none">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-medium text-ink">{run.loopName}</div>
                          <div className="mt-0.5 text-[11.5px] text-ink-muted">
                            {run.manual ? "Run now" : "RealBud clock"} · {fmtDateTime(run.startedAt ?? run.createdAt)}
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
                    </div>
                  </details>
                </li>
              );
            }
            const run = activity.run;
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
                <details>
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
                    <p className="mt-1 text-[11.5px] text-ink-muted">
                      {run.trigger === "schedule" ? "RealBud clock" : "Run now"} · plan v{run.jobRevision} · {fmtDateTime(run.startedAt ?? run.createdAt)}
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
                        {run.evidence.map((item, index) => {
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
