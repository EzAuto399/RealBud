import { openWorkspaceSetup } from "@/lib/workspace-setup";
import { openDeskTasks } from "@/lib/desk-view-state";
import { useMemo, useRef, useState } from "react";
import { ArrowRight, CircleAlert, Loader2, Sparkles } from "lucide-react";

import { cn } from "@/lib/cn";
import { fmtDateTime } from "@/lib/au";
import { workdayGuide, type WorkdayPhase } from "@/lib/workday";
import { latestWorkerIssue } from "@/lib/worker-issues";
import { api, useStore } from "@/state/store";
import { MausAvatar } from "./Avatar";
import type { MausState } from "@/lib/mascot";

/** The pulse's face follows the day's truth: Bud works, alerts, waits, sleeps. */
function pulseState(phase: WorkdayPhase, working: boolean): MausState {
  if (working) return "working";
  switch (phase) {
    case "offline":
      return "sleeping";
    case "recovery":
    case "worker-miss":
      return "alerting";
    case "licensee":
    case "review":
      return "notifying";
    case "clear":
      return "happy";
    default:
      return "idle";
  }
}

const toneClass = {
  agency: "border-agency/25 bg-selected/55",
  hold: "border-hold/25 bg-hold/5",
  danger: "border-danger/25 bg-danger/5",
  muted: "border-line bg-inset/45",
} as const;

const dotClass = {
  agency: "bg-agency",
  hold: "bg-hold",
  danger: "bg-danger",
  muted: "bg-ink-muted",
} as const;

/** Persistent orientation for the day: one current state and one next step. */
export function WorkdayPulse() {
  const { state, dispatch } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const guide = useMemo(
    () => workdayGuide({ connected: state.connected, desk: state.desk, workerReady: Boolean(state.hermes?.ready) }),
    [state.connected, state.desk, state.hermes?.ready],
  );
  const workerIssue = useMemo(() => latestWorkerIssue(state.workerIssues), [state.workerIssues]);

  // Live agentic presence: an Ask turn or a Recheck in flight shows Bud working.
  const budBusy = Boolean(state.bots.find((b) => b.id === "bud" || b.name === "Bud")?.busy);
  const working = busy || budBusy;

  // The clock's next press, so the pulse looks forward as well as back.
  const nextLoop = useMemo(() => {
    const now = Date.now();
    return (
      state.loops
        .filter((loop) => loop.available && loop.enabled && loop.nextRunAt != null && loop.nextRunAt > now)
        .sort((a, b) => a.nextRunAt! - b.nextRunAt!)[0] ?? null
    );
  }, [state.loops]);

  const act = async () => {
    if (!guide.action || inFlight.current || budBusy) return;
    setError("");
    if (guide.action === "desk") {
      openDeskTasks();
      dispatch({ type: "showDesk" });
      return;
    }
    if (guide.action === "you") {
      if (guide.phase === "recovery") { location.hash = "#you-recovery"; dispatch({ type: "showYou" }); }
      else openWorkspaceSetup("bud");
      return;
    }

    inFlight.current = true;
    setBusy(true);
    try {
      const path = guide.action === "practice" ? "/api/desk/practice" : "/api/desk/check";
      const snapshot = await api(path, { method: "POST", body: "{}" });
      dispatch({ type: "deskSnapshot", snapshot });
      openDeskTasks();
      dispatch({ type: "showDesk" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn’t finish checking. Your saved work is still here.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  if (state.activeView === "ask") return (
    <section className="ask-sidebar-context" aria-label="Workspace overview">
      <p className="ask-eyebrow">{nextLoop ? "Up next" : "Your workspace"}</p>
      {nextLoop ? <>
        <p className="mt-2 text-[13px] font-medium text-ink">{nextLoop.name}</p>
        <p className="mt-1 text-[12px] text-ink-muted">{fmtDateTime(nextLoop.nextRunAt!, state.desk?.timezone)}</p>
      </> : <p className="mt-2 text-[13px] text-ink-muted">{guide.bookLabel}</p>}
      <button type="button" className="ask-text-button mt-3 w-full justify-between" onClick={() => dispatch({ type: nextLoop ? "showRoutines" : "showDesk" })}>
        {nextLoop ? "View schedule" : "Open Desk"}<ArrowRight size={14} aria-hidden />
      </button>
    </section>
  );

  if (state.activeView === "desk") return (
    <section className={cn("mx-3 mb-3 rounded-lg border p-3", toneClass[guide.tone])} aria-label="Today in RealBud">
      <p className="text-[10px] font-medium uppercase tracking-[0.1em] text-ink-muted">{guide.bookLabel}</p>
      <p className="mt-1.5 flex items-center gap-2 text-[12px] font-medium text-ink"><span className={cn("size-1.5 shrink-0 rounded-full", dotClass[guide.tone])} />{working ? "Bud working now" : guide.title}</p>
      {workerIssue ? <p role="status" className="mt-2 text-[11px] text-danger">{workerIssue.summary}</p> : null}
      <details className="mt-2 text-[11px] leading-relaxed text-ink-muted">
        <summary className="cursor-pointer py-1">Workspace details</summary>
        <p className="mt-1">{guide.detail}</p>
        {workerIssue ? <p className="mt-2">{workerIssue.detail}</p> : null}
        {nextLoop ? <p className="mt-2">Next: {nextLoop.name} · {fmtDateTime(nextLoop.nextRunAt!, state.desk?.timezone)}</p> : null}
      </details>
      {guide.action === "you" ? <button type="button" onClick={() => void act()} className="pm-control mt-1 w-full text-left text-[12px] font-medium text-agency">{guide.actionLabel}<ArrowRight size={12} className="ml-2 inline" aria-hidden /></button> : null}
      {error ? <p role="alert" className="mt-2 text-[11px] text-danger">{error}</p> : null}
    </section>
  );

  return (
    <section
      className={cn("mx-3 mb-3 overflow-hidden rounded-lg border p-3", toneClass[guide.tone])}
      aria-label="Today in RealBud"
    >
      <div className="flex items-start gap-2.5">
        <MausAvatar
          color="green"
          state={pulseState(guide.phase, working)}
          size={30}
          label="Bud"
          trackPointer={false}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
            <span className={cn("size-1.5 rounded-full", dotClass[guide.tone], guide.phase === "offline" && "animate-pulse motion-reduce:animate-none")} />
            {guide.eyebrow}
          </div>
          <div className="mt-1 text-[13.5px] font-semibold leading-snug text-ink">{guide.title}</div>
        </div>
      </div>
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-secondary">{guide.detail}</p>

      {workerIssue ? (
        <div role="status" className="mt-2 flex items-start gap-1.5 rounded border border-danger/20 bg-danger/5 px-2.5 py-2 text-[11px] leading-relaxed text-ink-secondary">
          <CircleAlert size={12} className="mt-0.5 shrink-0 text-danger" />
          <span>
            <span className="font-medium text-ink">{workerIssue.summary}</span> {workerIssue.detail}
          </span>
        </div>
      ) : null}

      {guide.actionLabel ? (
        <button
          type="button"
          onClick={() => void act()}
          disabled={working || !state.connected}
          className="pm-control mt-2.5 flex w-full items-center justify-between rounded border border-line/80 bg-sheet px-2.5 text-[12px] font-medium text-ink transition-transform hover:bg-raised active:scale-[0.99] disabled:opacity-45"
        >
          <span className="flex items-center gap-1.5">
            {working ? <Loader2 size={12} className="animate-spin motion-reduce:animate-none" /> : <Sparkles size={12} className="text-agency" />}
            {working ? "Checking…" : guide.actionLabel}
          </span>
          <ArrowRight size={12} aria-hidden="true" />
        </button>
      ) : null}

      {error ? (
        <div role="alert" className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-danger">
          <CircleAlert size={12} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="mt-2.5 flex flex-wrap gap-x-2 gap-y-0.5 border-t border-line/70 pt-2 text-[10.5px] text-ink-muted">
        <span>{guide.bookLabel}</span>
        <span aria-hidden="true">·</span>
        <span>{working ? "Bud working now" : guide.budLabel}</span>
        {nextLoop ? (
          <>
            <span aria-hidden="true">·</span>
            <span>
              Next {nextLoop.name} {fmtDateTime(nextLoop.nextRunAt!, state.desk?.timezone)}
            </span>
          </>
        ) : null}
      </div>
    </section>
  );
}
