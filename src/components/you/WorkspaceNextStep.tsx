import { useMemo, useRef, useState } from "react";
import { ArrowRight, CalendarDays, CircleAlert, Loader2, Sparkles } from "lucide-react";

import { cn } from "@/lib/cn";
import { fmtDateTime } from "@/lib/au";
import { openDeskTasks } from "@/lib/desk-view-state";
import { scrollYouTarget } from "@/lib/you-navigation";
import { api, useStore } from "@/state/store";
import { MausAvatar } from "../Avatar";
import { dotClass, pulseState, useWorkdayStatus } from "../WorkdayPulse";

/** The top of Workspace: where the day stands and the one next step. */
export function WorkspaceNextStep() {
  const { state, dispatch } = useStore();
  const { guide, workerIssue, budBusy } = useWorkdayStatus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const working = busy || budBusy;

  // The clock's next press, so the overview looks forward as well as back.
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
      const id = guide.phase === "recovery" ? "you-recovery" : "you-worker";
      scrollYouTarget(id);
      // Keyboard users land where the eye goes, not back on this button.
      const target = document.getElementById(id);
      if (target) {
        if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
        target.focus({ preventScroll: true });
      }
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

  return (
    <section aria-label="Workspace overview" className="flex flex-col gap-3 border-b border-line px-4 pb-5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0" aria-hidden>
          <MausAvatar color="green" state={pulseState(guide.phase, working)} size={32} label="" trackPointer={false} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-[12px] text-ink-muted">
            <span className={cn("size-1.5 shrink-0 rounded-full", workerIssue ? "bg-danger" : dotClass[guide.tone])} aria-hidden />
            {guide.eyebrow}
          </p>
          <h2 className="mt-1 text-[18px] font-semibold leading-snug text-ink [overflow-wrap:anywhere]">{guide.title}</h2>
          <p className="mt-1.5 text-[14px] leading-relaxed text-ink-secondary">{guide.detail}</p>
        </div>
      </div>
      {workerIssue ? (
        <div role="status" className="flex gap-2 text-[13px] leading-relaxed text-ink-secondary">
          <CircleAlert size={18} className="mt-0.5 shrink-0 text-danger" aria-hidden />
          <p><strong className="font-medium text-ink">{workerIssue.summary}</strong> {workerIssue.detail}</p>
        </div>
      ) : null}
      {guide.actionLabel ? (
        <button
          type="button"
          onClick={() => void act()}
          disabled={working || !state.connected}
          className="pm-control flex items-center justify-between gap-3 self-start rounded border border-line bg-sheet px-3 text-[14px] font-medium text-ink hover:bg-selected disabled:cursor-default disabled:opacity-50"
        >
          <span className="flex items-center gap-2">
            {working ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Sparkles size={16} aria-hidden />}
            {working ? "Checking…" : guide.actionLabel}
          </span>
          <ArrowRight size={16} aria-hidden />
        </button>
      ) : null}
      {error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : null}
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-[13px]">
        <div className="flex gap-2"><dt className="text-ink-muted">Book</dt><dd className="text-ink">{guide.bookLabel}</dd></div>
        <div className="flex gap-2"><dt className="text-ink-muted">Bud</dt><dd className="text-ink">{working ? "Working now" : guide.budLabel}</dd></div>
      </dl>
      {nextLoop ? (
        <button
          type="button"
          className="pm-control flex items-center gap-2.5 self-start rounded px-2 text-left text-[13px] text-ink hover:bg-raised"
          onClick={() => dispatch({ type: "showRoutines" })}
        >
          <CalendarDays size={16} className="shrink-0 text-ink-muted" aria-hidden />
          <span>Up next · {nextLoop.name} <span className="text-ink-muted">{fmtDateTime(nextLoop.nextRunAt!, state.desk?.timezone)}</span></span>
          <ArrowRight size={14} className="shrink-0 text-ink-muted" aria-hidden />
        </button>
      ) : null}
    </section>
  );
}
