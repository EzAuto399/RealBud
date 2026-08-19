// Schedule — named product loops on RealBud's clock. A loop is "Desk, but
// the clock pressed Recheck": RealBud owns WHEN and the cards; Hermes owns
// HOW (headless facts). There is no bot picker, no free-text prompt, and
// never a Hermes cron UI. Nothing sends while nobody is looking.
import { useState } from "react";
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
import type { Loop, LoopId, LoopRun, LoopRunStatus } from "@/lib/routines";
import { api, useStore } from "@/state/store";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function scheduleLabel(loop: Loop): string {
  const [hour, minute] = loop.schedule.time.split(":").map(Number);
  const days = loop.schedule.weekdays;
  const dayLabel =
    days.length === 7
      ? "Every day"
      : days.join(",") === "1,2,3,4,5"
        ? "Weekdays"
        : days.map((day) => DAY_NAMES[day]).join(", ");
  const time = new Date(2000, 0, 1, hour, minute).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${dayLabel} at ${time}`;
}

function niceWhen(at: number): string {
  const date = new Date(at);
  const today = new Date().toDateString() === date.toDateString() ? "today" : "tomorrow";
  return `${today} at ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
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
      return { icon: <CircleAlert size={12} />, label: status, cls: "text-danger" };
  }
}

function LoopCard({
  loop,
  lastRun,
  activeRun,
  busy,
  onRun,
  onToggle,
}: {
  loop: Loop;
  lastRun?: LoopRun;
  activeRun?: LoopRun;
  busy: boolean;
  onRun: () => void;
  onToggle: () => void;
}) {
  return (
    <article className={cn("rounded-2xl border p-4", loop.available ? "border-hairline/40 bg-panel" : "border-dashed border-hairline/30 bg-panel/50")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold text-ink">{loop.name}</span>
            {loop.available ? (
              loop.enabled ? (
                <span className="rounded-full border border-accent/25 bg-accent/10 px-2 py-0.5 text-[10.5px] text-accent">On</span>
              ) : (
                <span className="rounded-full border border-hairline/50 bg-inset px-2 py-0.5 text-[10.5px] text-ink-secondary">Paused</span>
              )
            ) : (
              <span className="flex items-center gap-1 rounded-full border border-hairline/50 bg-inset px-2 py-0.5 text-[10.5px] text-ink-secondary">
                <Sparkles size={10} /> Planned
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-[12px] text-ink-secondary">
            <Clock size={12} />
            {loop.available ? scheduleLabel(loop) : "Schedule declared with the loop"}
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
                disabled={busy}
                title={loop.enabled ? "Pause this loop" : "Resume this loop"}
                className="flex items-center gap-1.5 rounded-xl border border-hairline/50 px-3 py-1.5 text-[12.5px] text-ink hover:bg-raised disabled:opacity-40"
              >
                {loop.enabled ? <Pause size={13} /> : <Play size={13} />}
                {loop.enabled ? "Pause" : "Resume"}
              </button>
              <button
                onClick={onRun}
                disabled={busy || !loop.enabled || Boolean(activeRun)}
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
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-ink-secondary">
        {loop.available && loop.enabled && loop.nextRunAt && <span>Next: {niceWhen(loop.nextRunAt)}</span>}
        {lastRun && (
          <span className="flex items-center gap-1.5">
            Last: {niceWhen(lastRun.scheduledFor)} ·{" "}
            <span className={cn("flex items-center gap-1", statusChip(lastRun.status).cls)}>
              {statusChip(lastRun.status).icon}
              {statusChip(lastRun.status).label}
            </span>
          </span>
        )}
        {lastRun?.detail && <span className="min-w-0 basis-full truncate" title={lastRun.detail}>“{lastRun.detail}”</span>}
      </div>
    </article>
  );
}

export function RoutinesPage() {
  const { state, dispatch } = useStore();
  const [busy, setBusy] = useState<LoopId | null>(null);
  const [error, setError] = useState("");

  const runNow = async (loopId: LoopId) => {
    setBusy(loopId);
    setError("");
    try {
      await api(`/api/loops/${loopId}/run`, { method: "POST" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
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
  const unseenFailures = state.loopRuns.filter((run) => ["failed", "missed"].includes(run.status) && !run.seenAt);

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-app">
      <header className="shrink-0 px-5 pb-4 pt-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2.5">
              <CalendarDays size={21} className="text-accent" />
              <h1 className="text-[20px] font-semibold tracking-tight text-ink">Schedule</h1>
            </div>
            <p className="mt-1 max-w-[52rem] text-[12.5px] text-ink-secondary">
              Named loops on RealBud's clock. Hermes fetches the facts headless; the cards land on Desk for you to allow or deny. Nothing sends while nobody is looking.
            </p>
          </div>
          {unseenFailures.length > 0 && (
            <span className="flex items-center gap-1.5 rounded-full border border-danger/25 bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger">
              <CircleAlert size={12} />
              {unseenFailures.length} need attention
            </span>
          )}
        </div>
        {error && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-[13px] text-danger">
            <CircleAlert size={16} className="mt-0.5 shrink-0" />
            {error}
          </div>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
        <section className="space-y-3">
          <h2 className="text-[12px] font-medium uppercase tracking-[0.14em] text-ink-secondary">The loops</h2>
          {state.loops.map((loop) => (
            <LoopCard
              key={loop.id}
              loop={loop}
              lastRun={lastRunByLoop.get(loop.id)}
              activeRun={activeByLoop.get(loop.id)}
              busy={busy === loop.id}
              onRun={() => void runNow(loop.id)}
              onToggle={() => void toggle(loop)}
            />
          ))}
        </section>

        <section className="mt-8 space-y-3">
          <h2 className="text-[12px] font-medium uppercase tracking-[0.14em] text-ink-secondary">Runs</h2>
          {state.loopRuns.length === 0 ? (
            <div className="rounded-2xl border border-hairline/40 bg-panel px-4 py-6 text-[13.5px] text-ink-secondary">
              No runs yet. The first check lands here when the clock — or you — press Recheck.
            </div>
          ) : (
            <div className="space-y-1.5">
              {state.loopRuns.slice(0, 15).map((run) => {
                const chip = statusChip(run.status);
                const unseen = ["failed", "missed"].includes(run.status) && !run.seenAt;
                return (
                  <button
                    key={run.id}
                    onClick={() => unseen && dispatch({ type: "markLoopRunSeen", runId: run.id })}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left",
                      unseen ? "border-danger/30 bg-danger/5" : "border-hairline/40 bg-panel hover:bg-raised/50",
                    )}
                  >
                    <span className={cn("flex items-center gap-1.5 text-[12px]", chip.cls)}>
                      {chip.icon}
                      {chip.label}
                    </span>
                    <span className="text-[13px] font-medium text-ink">{run.loopName}</span>
                    {run.manual && <span className="rounded-md bg-inset px-1.5 py-0.5 text-[10px] text-ink-secondary">manual</span>}
                    <span className="text-[11.5px] text-ink-secondary">{niceWhen(run.scheduledFor)}</span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-ink-secondary" title={run.detail}>
                      {run.detail}
                    </span>
                    {unseen && <span className="size-2 shrink-0 rounded-full bg-danger" />}
                  </button>
                );
              })}
            </div>
          )}
          <p className="text-[11.5px] text-ink-secondary/70">
            The Hermes worker keeps <code className="rounded bg-raised px-1 py-0.5">cron_mode: deny</code> — it reads when asked, and never sends while nobody is looking.
          </p>
        </section>
      </div>
    </main>
  );
}
