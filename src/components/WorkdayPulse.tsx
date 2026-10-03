import { useId, useMemo } from "react";

import { cn } from "@/lib/cn";
import { workdayGuide, type WorkdayPhase } from "@/lib/workday";
import { latestWorkerIssue } from "@/lib/worker-issues";
import { useStore } from "@/state/store";
import { MausAvatar } from "./Avatar";
import type { MausState } from "@/lib/mascot";

/** The pulse's face follows the day's truth: Bud works, alerts, waits, sleeps. */
export function pulseState(phase: WorkdayPhase, working: boolean): MausState {
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

export const dotClass = {
  agency: "bg-agency",
  hold: "bg-hold",
  danger: "bg-danger",
  muted: "bg-ink-muted",
} as const;

/** One reading of the day, shared by the sidebar row and the Workspace screen. */
export function useWorkdayStatus() {
  const { state } = useStore();
  const guide = useMemo(
    () => workdayGuide({ connected: state.connected, desk: state.desk, workerReady: Boolean(state.hermes?.ready) }),
    [state.connected, state.desk, state.hermes?.ready],
  );
  const workerIssue = useMemo(() => latestWorkerIssue(state.workerIssues), [state.workerIssues]);
  // Live agentic presence: an Ask turn or a Recheck in flight shows Bud working.
  const budBusy = Boolean(state.bots.find((b) => b.id === "bud" || b.name === "Bud")?.busy);
  return { guide, workerIssue, budBusy };
}

/**
 * The sidebar's single Workspace entry: Bud's mood, one line on the day and a
 * status dot. Details and next steps live at the top of the Workspace screen,
 * so this stays light enough for Desk to load without the Workspace chunk.
 */
export function WorkdayPulse({ shortcut }: { shortcut?: string }) {
  const { state, dispatch } = useStore();
  const { guide, workerIssue, budBusy } = useWorkdayStatus();
  const summaryId = useId();
  const summary = workerIssue ? workerIssue.summary : budBusy ? "Bud working now" : guide.title;

  return (<>
    {/* A worker failure is announced wherever the person is working. */}
    <span className="sr-only" role="status" aria-live="polite">{workerIssue ? workerIssue.summary : ""}</span>
    <button
      type="button"
      aria-label="Workspace"
      aria-describedby={summaryId}
      aria-current={state.activeView === "you" ? "page" : undefined}
      title={shortcut ? `Workspace (${shortcut})` : "Workspace"}
      className="rb-workspace-status-trigger"
      onClick={() => dispatch({ type: "showYou" })}
    >
      <span className="rb-workspace-status-mark" aria-hidden><MausAvatar color="green" state={pulseState(guide.phase, budBusy)} size={24} label="" trackPointer={false} /></span>
      <span className="rb-workspace-status-label"><span>Workspace</span><span id={summaryId}>{summary}</span></span>
      <span className={cn("rb-workspace-status-dot", workerIssue ? "bg-danger" : dotClass[guide.tone])} aria-hidden />
    </button>
  </>);
}
