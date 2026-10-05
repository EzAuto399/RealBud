import { useEffect, useState } from "react";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import type { UsageBudget } from "@shared/usage-budget";
import { deskRunStatus, nextLoopLine } from "./shell-layout";
import type { ShellBrowser } from "./shell-status";

const dot = { agency: "bg-agency", hold: "bg-hold", muted: "bg-ink-muted", danger: "bg-danger" } as const;

/** Slim facts across the bottom. Stale, sample or unreported facts say so; nothing
 *  here is presented as live unless it is. Hidden below 960px. */
export function StatusBar({ browser, stopping, stopError, onStop, budget }: { browser: ShellBrowser; stopping: boolean; stopError: string; onStop: () => void; budget: UsageBudget | null }) {
  const { state } = useStore();
  // Re-read relative times each minute so "checked 5 min ago" does not freeze.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(timer); }, []);
  const run = deskRunStatus(state.desk, now);
  return (
    <footer className="rb-status-bar" aria-label="Status bar">
      <span className="rb-status-item"><span className={cn("rb-status-dot", state.connected ? dot.agency : dot.hold)} aria-hidden />{state.connected ? "Connected" : "Offline — reconnecting"}</span>
      <span className="rb-status-item"><span className={cn("rb-status-dot", dot[run.tone])} aria-hidden />{run.label}</span>
      <span className="rb-status-item">{nextLoopLine(state.loops, now)}</span>
      {browser?.active ? (
        <span className="rb-status-item">
          <span className={cn("rb-status-dot", dot.hold)} aria-hidden />Browser task running · {browser.account}
          <button type="button" className="rb-status-stop" disabled={stopping || !state.connected} onClick={onStop}>{stopping ? "Stopping…" : "Stop browser task"}</button>
        </span>
      ) : null}
      {stopError ? <span className="rb-status-item text-danger">{stopError}</span> : null}
      {/* No linked office or no validated report: say nothing rather than a placeholder. */}
      {budget?.state === "ready" || budget?.state === "disabled" ? (
        <span className="rb-status-item rb-status-spend">
          {budget.state === "ready" ? `Spend ${budget.label} of budget` : "Spend budget not enabled"}
        </span>
      ) : null}
    </footer>
  );
}
