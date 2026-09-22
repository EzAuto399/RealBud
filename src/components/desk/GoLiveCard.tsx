import { useEffect, useState } from "react";

import { propertyExportRow, type GoLiveWorkflow } from "@/lib/go-live";
import {
  SETUP_STEP_COUNT,
  budStatusLine,
  currentSetupStep,
  readAgencySetupFacts,
  setupSequence,
  setupSequenceComplete,
  type AgencySetupRead,
  type ScheduleRead,
  type SetupStep,
} from "@/lib/setup-sequence";
import type { Office } from "@/lib/office-setup";
import { api, useStore } from "@/state/store";

const STATE_LABEL: Record<SetupStep["state"], string> = {
  done: "Done",
  current: "Now",
  later: "Later",
  unknown: "Not checked yet",
};

export function GoLiveCard({
  mode,
  agencyName,
  workerReady,
  compact = false,
  workflow = "workspace",
  agencySetup,
  onConnectExport,
}: {
  mode: "demo" | "live";
  agencyName: string;
  workerReady: boolean;
  compact?: boolean;
  workflow?: GoLiveWorkflow;
  /** Supply the host facts to skip this card's own bounded read of them. */
  agencySetup?: AgencySetupRead;
  onConnectExport: () => void;
  /**
   * Still accepted from the Desk and You callers. Each of the three steps has
   * its own single action (the agency setup card, or Connections on You), and
   * Bud is a status line rather than a step, so these place no control here.
   */
  jurisdictions?: readonly string[];
  office?: Office | null;
  onAttachWorker?: () => void;
  attachWorkerLabel?: string;
  onSaveAgency?: (name: string) => void;
  onNameAgency?: () => void;
}) {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(!compact);
  // Unknown setup state stays unknown: a failed or slow read may never read as
  // finished setup, so the step carries its own honest wording instead.
  const [read, setRead] = useState<AgencySetupRead>(undefined);
  const supplied = agencySetup !== undefined;
  // The store already hydrates the loops once per session, so the schedule fact
  // reuses that slice instead of reading /api/loops again. Anything short of a
  // finished read stays "not checked yet".
  const routines = state?.activityLoad?.routines;
  const schedule: ScheduleRead =
    routines === "ready"
      ? {
          read: "ready",
          loops: (state.loops ?? []).map((loop) => ({
            id: loop.id,
            available: loop.available,
            enabled: loop.enabled,
            nextRunAt: loop.nextRunAt,
          })),
        }
      : { read: routines === "error" ? "error" : "loading" };
  const steps = setupSequence({
    officeAgencyName: agencyName,
    agencySetup: supplied ? agencySetup : read,
    schedule,
  });
  const current = currentSetupStep(steps);
  const exportRow = propertyExportRow({ mode, workflow });

  useEffect(() => {
    if (compact) setOpen(false);
  }, [compact]);

  useEffect(() => {
    if (supplied) return;
    let alive = true;
    const controller = new AbortController();
    // A hung read must become a visible "could not be read", never a permanent
    // "Reading…", and leaving the card cancels it.
    const timer = setTimeout(() => controller.abort(), 15_000);
    void api("/api/agency-setup", { signal: controller.signal })
      .then((view: unknown) => {
        if (alive) setRead(readAgencySetupFacts(view));
      })
      .catch(() => {
        if (alive) setRead("unavailable");
      });
    return () => {
      alive = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [supplied]);

  const openWorkflowSetup = () => {
    // Schedule's own section scroll runs off the hash once its screen mounts;
    // the direct call covers the case where that section is already on screen.
    if (typeof location !== "undefined") location.hash = "schedule-packs";
    dispatch({ type: "showRoutines" });
    if (typeof document !== "undefined") document.getElementById("schedule-packs")?.scrollIntoView({ block: "start" });
  };

  // Accounts are connected on You; the other two steps are taken in the agency
  // setup card on Schedule. Each step has exactly one of these.
  const openStep = (step: SetupStep) => {
    if (step.target === "you-connected-apps") {
      if (typeof location !== "undefined") location.hash = "you-connected-apps";
      dispatch({ type: "showYou" });
      return;
    }
    openWorkflowSetup();
  };

  if (setupSequenceComplete(steps) && (!exportRow || exportRow.done)) return null;

  if (compact && !open) {
    return (
      <section className="mt-3 border border-line bg-sheet px-3.5 py-2" aria-label="Workspace setup">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full items-center justify-between gap-2 text-left text-[13px] text-ink"
        >
          <span>
            Workspace setup · {current ? `Step ${current.number} of ${SETUP_STEP_COUNT}: ${current.title}` : "every step checked"}
            <span className="text-ink-muted"> · Each workflow is still reviewed on its own.</span>
          </span>
          <span className="text-[12px] text-agency">Open</span>
        </button>
      </section>
    );
  }

  const done = steps.filter((step) => step.state === "done");
  const ahead = steps.filter((step) => step.state === "later" || step.state === "unknown");

  return (
    <section className="mt-3 rounded-lg border border-line bg-sheet px-3.5 py-3" aria-label="Workspace setup">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[13px] font-medium text-ink">Workspace setup</div>
          <p className="mt-0.5 text-[12px] text-ink-muted">
            {SETUP_STEP_COUNT} steps, in order. Each step reads this workspace’s own recorded state; a step that cannot be read says so instead of looking finished.
          </p>
        </div>
        {compact ? (
          <button type="button" onClick={() => setOpen(false)} className="text-[12px] text-ink-muted hover:text-ink">
            Hide
          </button>
        ) : null}
      </div>

      {done.length ? (
        <p className="mt-2 text-[12px] text-ink-muted">
          Done: {done.map((step) => `${step.number}. ${step.title}`).join(" · ")}
        </p>
      ) : null}

      {current ? (
        <div className="mt-2 rounded border border-line bg-inset px-3 py-2">
          <div className="text-[13px] font-medium text-ink">
            Step {current.number} of {SETUP_STEP_COUNT}: {current.title}
          </div>
          <p className="mt-0.5 text-[12.5px] text-ink-secondary">{current.why}</p>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">{current.status}</p>
          <button
            type="button"
            onClick={() => openStep(current)}
            aria-label={current.actionLabel}
            className="pm-control mt-1.5 rounded border border-line bg-sheet px-3 text-[13px] text-ink"
          >
            {current.actionLabel}
          </button>
        </div>
      ) : (
        <p className="mt-2 text-[12.5px] text-ink-secondary">Every setup step is recorded as done. Each run is still reviewed on its own.</p>
      )}

      {ahead.length ? (
        <ol className="mt-2 space-y-1">
          {ahead.map((step) => (
            <li key={step.id} className="text-[12.5px] text-ink-muted">
              <span className="text-ink-muted">{STATE_LABEL[step.state]}</span>
              {" · "}
              {step.number}. {step.title}
              {step.state === "unknown" ? <span className="text-hold"> — {step.status}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}

      {exportRow && !exportRow.done ? (
        <div className="mt-2 border-t border-line pt-2 text-[12.5px]">
          <div className="text-ink">Also needed for this workflow · {exportRow.title}</div>
          <p className="text-ink-muted">{exportRow.detail}</p>
          <button
            type="button"
            onClick={onConnectExport}
            aria-label="Open properties"
            className="pm-control mt-1.5 rounded border border-line bg-sheet px-3 text-[13px] text-ink"
          >
            Open properties
          </button>
        </div>
      ) : null}

      {/* Bud is not a step: this setup can be read and reviewed before a worker
          is installed, so its readiness is one status line under the path. */}
      <p className="mt-2 border-t border-line pt-2 text-[12px] text-ink-muted">
        {budStatusLine(workerReady)} · setup can be reviewed before Bud is installed.
      </p>
    </section>
  );
}
