import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { BriefcaseBusiness, Building2, Check, Loader2, ShieldAlert } from "lucide-react";

import { cn } from "@/lib/cn";
import { withViewTransition } from "@/lib/motion";
import {
  nextWorkerSetupOperation,
  setSetupJourneyPending,
  workerVerified,
  type WorkerSetupOperation,
} from "@/lib/onboarding";
import { useStore } from "@/state/store";
import { RecoveryUnlockPanel } from "./RecoveryUnlockPanel";
import { HermesHandsCard } from "./SettingsModal";

export type SetupJourneyStage =
  | { kind: "recovery"; step: null; label: "Recovery"; complete: false }
  | { kind: "loading"; step: 1; label: "Prepare Bud"; complete: false }
  | { kind: "worker"; step: 1 | 2; label: "Prepare Bud" | "Connect model" | "Check Bud"; complete: false }
  | { kind: "portfolio"; step: 3; label: "Add portfolio"; complete: false }
  | { kind: "ready"; step: 3; label: "Ready"; complete: true };

export function resolveSetupJourneyStage(input: {
  hydrated: boolean;
  recoveryActive: boolean;
  workerOperation: WorkerSetupOperation;
  portfolioReady: boolean;
}): SetupJourneyStage {
  if (input.recoveryActive) return { kind: "recovery", step: null, label: "Recovery", complete: false };
  if (!input.hydrated || input.workerOperation === "checking") {
    return { kind: "loading", step: 1, label: "Prepare Bud", complete: false };
  }
  if (input.workerOperation === "install" || input.workerOperation === "pack") {
    return { kind: "worker", step: 1, label: "Prepare Bud", complete: false };
  }
  if (input.workerOperation === "model") {
    return { kind: "worker", step: 2, label: "Connect model", complete: false };
  }
  if (input.workerOperation === "test") {
    return { kind: "worker", step: 2, label: "Check Bud", complete: false };
  }
  if (!input.portfolioReady) return { kind: "portfolio", step: 3, label: "Add portfolio", complete: false };
  return { kind: "ready", step: 3, label: "Ready", complete: true };
}

export function SetupJourney({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const journeyRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const desk = state.desk;
  const deskRecovery = Boolean(desk?.recovery?.active);
  const localRecovery = state.config?.localRecovery;
  const recoveryActive = deskRecovery || Boolean(localRecovery?.active);
  const workerOperation = nextWorkerSetupOperation({
    worker: state.hermes,
    workerIsVerified: workerVerified(state.hermes),
  });
  const portfolioReady = desk?.mode === "live" && !deskRecovery;
  const stage = resolveSetupJourneyStage({
    hydrated: Boolean(state.config && state.hermes && desk),
    recoveryActive,
    workerOperation,
    portfolioReady,
  });

  const workerReady = workerOperation === "done";
  const dismiss = useCallback(() => {
    if (!recoveryActive && nextWorkerSetupOperation({
      worker: state.hermes,
      workerIsVerified: workerVerified(state.hermes),
    }) !== "done") return;
    setSetupJourneyPending(false);
    withViewTransition(() => {
      dispatch({ type: "showDesk" });
      onClose();
    });
  }, [dispatch, onClose, recoveryActive, state.hermes]);

  const openPortfolio = useCallback(() => {
    setSetupJourneyPending(false);
    withViewTransition(() => {
      dispatch({ type: "showAsk" });
      onClose();
    });
  }, [dispatch, onClose]);

  const openDesk = useCallback(() => {
    setSetupJourneyPending(false);
    withViewTransition(() => {
      dispatch({ type: "showDesk" });
      onClose();
    });
  }, [dispatch, onClose]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    journeyRef.current?.focus();
    return () => previousFocusRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dismiss]);

  return (
    <div className="fixed inset-0 z-[70] overflow-y-auto bg-paper" data-setup-journey>
      <div
        ref={journeyRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="setup-journey-title"
        aria-describedby="setup-journey-description"
        tabIndex={-1}
        className="mx-auto flex min-h-full w-full max-w-[820px] flex-col px-4 py-4 outline-none sm:px-6 sm:py-6"
      >
        <div className="mb-4 flex min-h-9 items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-agency" aria-label="RealBud">
            <span className="realbud-mark flex size-8 items-center justify-center rounded bg-selected">
              <Building2 size={16} aria-hidden="true" />
            </span>
            <span className="text-[15px] font-semibold text-ink">RealBud</span>
          </div>
          {recoveryActive ? (
            <button
              type="button"
              onClick={dismiss}
              className="pm-control pm-tactile rounded px-3 text-[12.5px] font-medium text-ink-secondary hover:bg-raised hover:text-ink"
            >
              Open Desk read-only
            </button>
          ) : workerReady && (stage.kind === "portfolio" || stage.complete) ? (
            <button
              type="button"
              onClick={openDesk}
              className="pm-control pm-tactile rounded px-3 text-[12.5px] font-medium text-ink-secondary hover:bg-raised hover:text-ink"
            >
              Continue to Desk
            </button>
          ) : null}
        </div>

        <div className="animate-pop-in flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-sheet shadow-[0_18px_60px_rgb(37_35_31/0.10)]">
          {stage.kind === "recovery" ? (
            <header className="border-b border-line px-5 py-3 sm:px-6">
              <h1 id="setup-journey-title" className="text-[18px] font-semibold tracking-[-0.02em] text-ink">Restore RealBud</h1>
              <p id="setup-journey-description" className="mt-1 text-[13px] text-ink-muted">Setup is paused until the book is safe.</p>
            </header>
          ) : (
            <header className="border-b border-line px-5 py-3 sm:px-6">
              <div className="flex items-baseline justify-between gap-3">
                <h1 id="setup-journey-title" className="text-[18px] font-semibold tracking-[-0.02em] text-ink">{stage.label}</h1>
                <p id="setup-journey-description" className="shrink-0 text-[12px] font-medium tabular-nums text-ink-muted">
                  {stage.complete ? "Done" : `${stage.step} of 3`}
                </p>
              </div>
              <SetupProgress step={stage.step ?? 1} complete={stage.complete} />
            </header>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
            <div key={stage.kind} className="desk-door">
            {stage.kind === "recovery" ? (
              <RecoveryStep deskRecovery={deskRecovery} issues={localRecovery?.issues ?? []} />
            ) : stage.kind === "loading" ? (
              <div className="flex min-h-[160px] flex-col items-center justify-center gap-2 text-ink-muted" role="status">
                <Loader2 size={18} className="animate-spin" aria-hidden="true" />
                <span className="text-[13px]">Checking this computer…</span>
              </div>
            ) : stage.kind === "worker" ? (
              <HermesHandsCard presentation="journey" autoOpenModel onOpenPortfolio={openPortfolio} />
            ) : stage.kind === "portfolio" ? (
              <FocusedStep
                icon={<BriefcaseBusiness size={22} aria-hidden="true" />}
                title="Verify your book"
                detail="A current PMS export verifies live balances. Files or a pasted list stay on Desk for review."
                action="Verify book"
                onAction={openPortfolio}
              />
            ) : (
              <FocusedStep
                icon={<Check size={23} aria-hidden="true" />}
                title="Ready"
                detail="Bud passed its check and the book is attached."
                action="Open Desk"
                onAction={openDesk}
              />
            )}
            </div>
          </div>

          {!stage.complete ? (
            <footer className="border-t border-line bg-paper px-5 py-2.5 text-[12px] text-ink-muted sm:px-6">
              Nothing is sent or paid during setup.
            </footer>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SetupProgress({ step, complete }: { step: number; complete: boolean }) {
  return (
    <div
      className="mt-2.5 grid grid-cols-3 gap-1.5"
      role="progressbar"
      aria-label="Setup progress"
      aria-valuemin={1}
      aria-valuemax={3}
      aria-valuenow={complete ? 3 : step}
    >
      {[1, 2, 3].map((position) => (
        <span key={position} className="relative h-1 overflow-hidden rounded-full bg-line" aria-hidden="true">
          <span
            className={cn(
              "setup-progress-fill absolute inset-y-0 left-0 bg-agency",
              complete || position <= step ? "w-full" : "w-0",
            )}
          />
        </span>
      ))}
    </div>
  );
}

function RecoveryStep({
  deskRecovery,
  issues,
}: {
  deskRecovery: boolean;
  issues: Array<{ area: string; action: string; detail: string }>;
}) {
  return (
    <section className="mx-auto flex w-full max-w-[34rem] flex-col items-center text-center" aria-labelledby="setup-recovery-title">
      <div className="flex size-12 items-center justify-center rounded bg-hold/10 text-hold"><ShieldAlert size={22} aria-hidden="true" /></div>
      <h2 id="setup-recovery-title" className="mt-4 text-[22px] font-semibold tracking-[-0.02em] text-ink">Your existing work is protected</h2>
      <p className="mt-2 max-w-[30rem] text-[13px] leading-relaxed text-ink-secondary">RealBud stopped before replacing state it could not verify.</p>
      {deskRecovery ? <div className="mt-5 w-full text-left"><RecoveryUnlockPanel /></div> : null}
      {issues.length ? (
        <div className="mt-5 w-full border border-line bg-paper p-3 text-left">
          <div className="text-[12.5px] font-semibold text-ink">What RealBud preserved</div>
          <ul className="mt-2 space-y-2">
            {issues.slice(0, 4).map((issue, index) => (
              <li key={`${issue.area}-${index}`} className="text-[12px] leading-relaxed text-ink-secondary">
                <span className="font-medium capitalize text-ink">{issue.area}:</span> {issue.detail}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {!deskRecovery && !issues.length ? <p className="mt-4 text-[12.5px] text-ink-muted">Open the read-only Desk, then return after RealBud finishes checking.</p> : null}
    </section>
  );
}

function FocusedStep({
  icon,
  title,
  detail,
  action,
  onAction,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <section className="flex min-h-[160px] flex-col items-center justify-center text-center" aria-labelledby="setup-focused-title">
      <div className="flex size-11 items-center justify-center rounded bg-selected text-agency">{icon}</div>
      <h2 id="setup-focused-title" className="mt-3 text-[20px] font-semibold tracking-[-0.02em] text-ink">{title}</h2>
      <p className="mt-1.5 max-w-[26rem] text-[13px] leading-relaxed text-ink-secondary">{detail}</p>
      <button type="button" onClick={onAction} className="pm-control pm-tactile mt-4 rounded bg-agency px-5 text-[13.5px] font-semibold text-white hover:bg-agency-hover">
        {action}
      </button>
    </section>
  );
}
