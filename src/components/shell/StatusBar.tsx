import { useEffect, useState } from "react";
import { api, useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import type { UsageBudget } from "@shared/usage-budget";
import { openDeskTasks } from "@/lib/desk-view-state";
import { deskRunStatus, nextLoop, nextLoopLine, openScheduleLoop } from "./shell-layout";
import type { ShellBrowser } from "./shell-status";
import { useOfficeLinkStatus } from "@/lib/use-office-link";
import { startReiSignIn, useReiSignIn } from "@/lib/rei-sign-in";
import { fmtDateTime } from "@/lib/au";
import { SETUP_STEP_COUNT, type SetupDegradedKind, type SetupJumpTarget, type SetupState } from "@/lib/setup-sequence";
import { useSetupState } from "@/lib/use-setup-state";
import { countdownAt, updateReadyLine, updateStatusLine, useSecondsLeft, useUpdaterState } from "@/lib/updater";
import { openSetupTarget } from "../SetupGateNote";

const dot = { agency: "bg-agency", hold: "bg-hold", muted: "bg-ink-muted", danger: "bg-danger" } as const;

const DEGRADED_LABEL: Record<SetupDegradedKind, string> = {
  revoked: "Office access stopped",
  officeInactive: "Office account inactive",
  restartRequired: "Restart to finish Bud’s update",
  aiLimit: "AI allowance used",
  modelKey: "AI key problem",
  gmail: "Gmail needs attention",
  reiExpired: "REI: sign in needed",
  updatePending: "Update ready",
};

/** The one setup item: the most serious degraded state, else "Setup N of 5 · <next>", else nothing once ready.
 *  The full sentence is its title; the target is its fix (an owner-only fix opens the Website account card).
 *  `update` words a waiting update from the updater's own state (restarts when away, countdown, needs you). */
export function setupStatusItem(setup: Pick<SetupState, "stage" | "degraded" | "steps" | "next">, update?: { label: string; title: string } | null): { label: string; title: string; target?: SetupJumpTarget } | null {
  const issue = setup.degraded;
  // A waiting update is only news; it never hides setup progress.
  if (issue && (issue.kind !== "updatePending" || setup.stage === "ready")) {
    if (issue.kind === "updatePending" && update) return update;
    const target = issue.target ?? (issue.ownerRequest ? "you-website" : undefined);
    return { label: DEGRADED_LABEL[issue.kind], title: issue.message, ...(target ? { target } : {}) };
  }
  if (setup.stage === "ready") return null;
  const step = setup.next ?? setup.steps.find((item) => item.state !== "done");
  return step ? { label: `Setup ${step.number} of ${SETUP_STEP_COUNT} · ${step.title}`, title: step.status, target: step.target } : null;
}

/** Slim facts across the bottom. Stale, sample or unreported facts say so; nothing
 *  here is presented as live unless it is. Each fact with somewhere to go opens it;
 *  connection state is only a fact, except "not connected", which opens its fix.
 *  Hidden below 960px. */
export function StatusBar({ browser, stopping, stopError, onStop, budget }: { browser: ShellBrowser; stopping: boolean; stopError: string; onStop: () => void; budget: UsageBudget | null }) {
  const { state, dispatch, refreshHermes } = useStore();
  const updater = useUpdaterState();
  const updateSeconds = useSecondsLeft(countdownAt(updater));
  const setupItem = setupStatusItem(useSetupState(), updater?.status === "downloaded" ? { label: updateStatusLine(updater, updateSeconds), title: updateReadyLine(updater) } : null);
  // Re-read relative times each minute so "checked 5 min ago" does not freeze.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(timer); }, []);
  const { link, officeInactive } = useOfficeLinkStatus(state.connected);
  // The running service's version, so staff and support can tell which build is installed.
  const [version, setVersion] = useState("");
  useEffect(() => {
    if (!state.connected) return;
    let alive = true;
    void api("/api/health").then((body: unknown) => {
      const value = (body as { version?: unknown } | null)?.version;
      if (alive && typeof value === "string" && value !== "unreported") setVersion(value);
    }, () => {});
    return () => { alive = false; };
  }, [state.connected]);
  // "Connected" means this computer is joined to its office. The local service
  // being down is its own fact and wins over any link wording.
  // Busy means the service still answered its health check: slow, not down.
  const connection = !state.connected && state.serviceBusy ? { tone: dot.hold, label: "Busy — still working, your work is safe" }
    : !state.connected ? { tone: dot.hold, label: "Offline — reconnecting" }
    : link === "linked" && officeInactive ? { tone: dot.hold, label: "Office account inactive" }
    : link === "linked" ? { tone: dot.agency, label: "Connected" }
    : link === "not-linked" ? { tone: dot.hold, label: "Not connected to your office" }
    : link === "unavailable" ? { tone: dot.hold, label: "Office connection unavailable" }
    : { tone: dot.muted, label: "Checking office connection" };
  const run = deskRunStatus(state.desk, now);
  const loop = nextLoop(state.loops, now);
  const openDesk = () => { openDeskTasks(); dispatch({ type: "showDesk" }); };
  const openSchedule = () => (loop ? openScheduleLoop(loop.id, () => dispatch({ type: "showRoutines" })) : dispatch({ type: "showRoutines" }));
  const openSpend = () => { location.hash = "you-settings"; dispatch({ type: "showYou" }); };
  const openWebsite = () => { location.hash = "you-website"; dispatch({ type: "showYou" }); };
  // REI Cloud in plain words, only where this office uses REI. Signing in (or checking) is one click.
  const { view: rei, opening: reiOpening } = useReiSignIn();
  return (
    <footer className="rb-status-bar" aria-label="Status bar">
      {/* Not linked, or an inactive office: the Website account card explains and fixes it. */}
      {/* The setup item names the fix; the connection then stays a plain fact. */}
      {setupItem && state.connected ? (setupItem.target
        ? <button type="button" className="rb-status-item rb-status-link" title={setupItem.title} onClick={() => void openSetupTarget(setupItem.target!, dispatch, refreshHermes)}><span className={cn("rb-status-dot", dot.hold)} aria-hidden />{setupItem.label}</button>
        : <span className="rb-status-item" title={setupItem.title}><span className={cn("rb-status-dot", dot.hold)} aria-hidden />{setupItem.label}</span>) : null}
      {state.connected && !setupItem && (link === "not-linked" || (link === "linked" && officeInactive)) ? (
        <button type="button" className="rb-status-item rb-status-link" title={officeInactive ? "Open Website account" : "Reconnect this computer in Workspace"} onClick={openWebsite}><span className={cn("rb-status-dot", connection.tone)} aria-hidden />{connection.label}</button>
      ) : <span className="rb-status-item"><span className={cn("rb-status-dot", connection.tone)} aria-hidden />{connection.label}</span>}
      {rei?.used && setupItem?.target !== "rei-sign-in" ? (rei.state === "signed_in"
        ? <span className="rb-status-item" title={rei.at ? `Seen signed in ${fmtDateTime(rei.at)}` : undefined}><span className={cn("rb-status-dot", dot.agency)} aria-hidden />REI: signed in</span>
        : <button type="button" className="rb-status-item rb-status-link" title="Open REI’s sign-in page in the work browser" onClick={() => void startReiSignIn()}>
          <span className={cn("rb-status-dot", rei.state === "needed" ? dot.hold : dot.muted)} aria-hidden />{reiOpening ? "REI: opening sign-in…" : rei.state === "needed" ? "REI: sign in needed" : "REI: not checked yet"}
        </button>) : null}
      <button type="button" className="rb-status-item rb-status-link" title="Open Desk tasks" onClick={openDesk}><span className={cn("rb-status-dot", dot[run.tone])} aria-hidden />{run.label}</button>
      <button type="button" className="rb-status-item rb-status-link" title={loop ? `Open ${loop.name} in Schedule` : "Open Schedule"} onClick={openSchedule}>{nextLoopLine(state.loops, now)}</button>
      {browser?.active ? (
        <span className="rb-status-item">
          <span className={cn("rb-status-dot", dot.hold)} aria-hidden />Browser task running · {browser.account}
          <button type="button" className="rb-status-stop" disabled={stopping || !state.connected} onClick={onStop}>{stopping ? "Stopping…" : "Stop browser task"}</button>
        </span>
      ) : null}
      {stopError ? <span className="rb-status-item text-danger">{stopError}</span> : null}
      {/* No linked office or no validated report: say nothing rather than a placeholder. */}
      {budget?.state === "ready" || budget?.state === "disabled" ? (
        <button type="button" className="rb-status-item rb-status-link rb-status-spend" title="Open AI usage in Workspace" onClick={openSpend}>
          {budget.state === "ready" ? `Spend ${budget.label} of budget` : "Spend budget not enabled"}
        </button>
      ) : null}
      {version ? <span className="rb-status-item rb-status-version" title="Installed RealBud version">RealBud {version}</span> : null}
    </footer>
  );
}
