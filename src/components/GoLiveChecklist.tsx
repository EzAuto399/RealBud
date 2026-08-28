import { useEffect, useState } from "react";
import {
  ArrowRight,
  BellRing,
  Building2,
  Cable,
  CheckCircle2,
  KeyRound,
  Loader2,
  Monitor,
  PauseCircle,
  ShieldAlert,
  Upload,
} from "lucide-react";

import { cn } from "@/lib/cn";
import {
  goLiveReadiness,
  recoveryKeySaved,
  setupGuideItems,
  workerVerified,
  RECOVERY_KEY_SAVED_EVENT,
  RECOVERY_KEY_SAVED_KEY,
  WORKER_VERIFICATION_EVENT,
  WORKER_VERIFICATION_KEY,
  type GoLiveStep,
  type PocketGuideStatus,
  type SetupGuideItem,
  type WorkerSetupStatus,
} from "@/lib/onboarding";
import { useDesktopCapabilities } from "./DesktopCapabilities";

export function GoLiveChecklist({
  mode,
  recoveryActive,
  worker,
  agencyName,
  onOpenPortfolio,
  onOpenDesk,
  onOpenWorker,
  onOpenAgency,
  onOpenComputerUse,
  onOpenRecovery,
  onOpenReminders,
  onOpenConnections,
  remindersAvailable,
  remindersOn,
  pocket,
  alwaysShow = false,
  compact = false,
}: {
  mode: "demo" | "live";
  recoveryActive: boolean;
  worker: WorkerSetupStatus | null;
  agencyName?: string | null;
  onOpenPortfolio?: () => void;
  onOpenDesk: () => void;
  onOpenWorker: () => void;
  onOpenAgency: () => void;
  onOpenComputerUse: () => void;
  onOpenRecovery: () => void;
  onOpenReminders: () => void;
  onOpenConnections: () => void;
  remindersAvailable: boolean;
  remindersOn: boolean;
  pocket?: PocketGuideStatus | null;
  alwaysShow?: boolean;
  /** Desk keeps the complete setup map visible without taking the work panes
   * below their usable height. You renders the explanatory version. */
  compact?: boolean;
}) {
  const desktop = useDesktopCapabilities();
  const [guidanceVersion, setGuidanceVersion] = useState(0);

  useEffect(() => {
    const refresh = () => setGuidanceVersion((value) => value + 1);
    const onStorage = (event: StorageEvent) => {
      if (event.key === WORKER_VERIFICATION_KEY || event.key === RECOVERY_KEY_SAVED_KEY) refresh();
    };
    window.addEventListener(WORKER_VERIFICATION_EVENT, refresh);
    window.addEventListener(RECOVERY_KEY_SAVED_EVENT, refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(WORKER_VERIFICATION_EVENT, refresh);
      window.removeEventListener(RECOVERY_KEY_SAVED_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const readiness = goLiveReadiness({
    mode,
    recoveryActive,
    worker,
    workerIsVerified: workerVerified(worker),
    agencyName,
  });
  const guideItems = setupGuideItems({
    agencyName,
    recoveryActive,
    recoverySaved: recoveryKeySaved(),
    desktopReady: desktop.ready,
    desktop: desktop.capabilities,
    remindersAvailable,
    remindersOn,
    pocket,
  });
  void guidanceVersion;

  if (readiness.complete && !alwaysShow) return null;

  const guideActions: Record<SetupGuideItem["id"], () => void> = {
    agency: onOpenAgency,
    "computer-use": onOpenComputerUse,
    recovery: onOpenRecovery,
    reminders: onOpenReminders,
    connections: onOpenConnections,
  };

  if (compact) {
    const nextEssential = readiness.steps.find((step) => step.id !== "agency" && step.state !== "done");
    const remaining = readiness.requiredTotal - readiness.requiredDone;
    const chipTitle = readiness.complete
      ? "Essentials ready"
      : nextEssential?.id === "book"
        ? "Verify book"
        : nextEssential?.title ?? "Prepare Bud";
    return (
      <button
        type="button"
        onClick={nextEssential?.id === "book" ? onOpenPortfolio ?? onOpenDesk : onOpenWorker}
        aria-labelledby="go-live-title"
        className="pm-tactile flex w-full items-center justify-between gap-3 border border-line bg-sheet px-3 py-2 text-left hover:border-agency/60 hover:bg-selected/35"
      >
        <span className="min-w-0">
          <span id="go-live-title" className="block text-[13px] font-semibold text-ink">
            {chipTitle}
          </span>
          {!readiness.complete ? (
            <span className="mt-0.5 block text-[12px] text-ink-muted">
              {remaining} left. Opens the setup guide.
            </span>
          ) : (
            <span className="mt-0.5 block text-[12px] text-ink-muted">Agency and connections live in You.</span>
          )}
        </span>
        <span className="shrink-0 text-[12px] font-medium tabular-nums text-ink-muted" role="status">
          {readiness.requiredDone}/{readiness.requiredTotal}
        </span>
      </button>
    );
  }

  return (
    <section aria-labelledby="go-live-title" className="animate-pop-in border border-line bg-sheet px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-[18rem] flex-1">
          <h2 id="go-live-title" className="text-[14px] font-semibold text-ink">
            {readiness.complete ? "RealBud essentials are ready" : "Set up RealBud around your work"}
          </h2>
          <p className="mt-0.5 text-[12px] text-ink-muted">
            Prepare Bud, connect a model securely, then bring in the portfolio from Ask, a current PMS export, or selected files and images.
          </p>
        </div>
        <span className="rounded bg-inset px-2 py-1 text-[11px] font-medium tabular-nums text-ink-muted" role="status">
          {readiness.requiredDone}/{readiness.requiredTotal} essentials ready
        </span>
      </div>
      <div className="mt-3 grid gap-px overflow-hidden border border-line bg-line min-[700px]:grid-cols-2">
        {readiness.steps.filter((step) => step.id !== "agency").map((step) => (
          <ChecklistStep
            key={step.id}
            step={step}
            number={step.id === "worker" ? 1 : 2}
            onAction={
              step.id === "book"
                ? onOpenPortfolio ?? onOpenDesk
                : onOpenWorker
            }
            actionLabel={
              step.id === "book"
                ? "Verify book"
                : step.title === "Prepare Bud"
                  ? "Prepare Bud"
                  : "Continue Bud setup"
            }
          />
        ))}
      </div>
      <div className="mt-2.5 border border-line bg-paper px-3 py-2.5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">Helpful next</h3>
          <span className="text-[10.5px] text-ink-muted">These do not block the desk</span>
        </div>
        <div className="mt-2 grid gap-1.5 min-[560px]:grid-cols-2 min-[840px]:grid-cols-5">
          {guideItems.map((item) => (
            <SetupGuideLink key={item.id} item={item} onAction={guideActions[item.id]} />
          ))}
        </div>
      </div>
      <p className="mt-2 text-[10.5px] leading-relaxed text-ink-muted">
        Computer permissions are requested only after you choose Set up. Pilot-gated services show requirements, never a cosmetic Connect button.
      </p>
    </section>
  );
}

function SetupGuideLink({ item, onAction, compact = false }: { item: SetupGuideItem; onAction: () => void; compact?: boolean }) {
  const Icon = item.id === "agency"
    ? Building2
    : item.id === "computer-use"
      ? Monitor
      : item.id === "recovery"
        ? KeyRound
        : item.id === "reminders"
          ? BellRing
          : Cable;
  const StateIcon = item.state === "done"
    ? CheckCircle2
    : item.state === "checking"
      ? Loader2
      : item.state === "held" || item.state === "action"
        ? ShieldAlert
        : PauseCircle;
  return (
    <button
      type="button"
      onClick={onAction}
      title={item.detail}
      aria-label={`${item.title}: ${item.status}. ${item.detail}`}
      data-state={item.state}
      className={cn(
        "pm-tactile flex min-w-0 items-center gap-1.5 border bg-sheet px-2 text-left hover:border-agency/60 hover:bg-selected/35",
        compact ? "min-h-12 py-1.5" : "py-2",
        item.state === "held" || item.state === "action" ? "border-hold/40" : "border-line",
      )}
    >
      <Icon size={12} className="shrink-0 text-agency" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] font-semibold text-ink">{item.title}</span>
        <span className={cn(
          "mt-0.5 flex items-center gap-1 truncate text-[10px]",
          item.state === "done" ? "text-agency" : item.state === "held" || item.state === "action" ? "text-hold" : "text-ink-muted",
        )}>
          <StateIcon size={10} className={item.state === "checking" ? "animate-spin" : undefined} aria-hidden="true" />
          {item.status}
        </span>
      </span>
    </button>
  );
}

function ChecklistStep({ step, number, onAction, actionLabel }: { step: GoLiveStep; number: number; onAction: () => void; actionLabel: string }) {
  const Icon =
    step.state === "done"
      ? CheckCircle2
      : step.state === "held"
        ? ShieldAlert
        : step.state === "checking"
          ? Loader2
          : step.id === "book"
            ? Upload
            : ArrowRight;
  const actionable = step.state === "action" || step.state === "optional";

  return (
    <div className="flex min-h-[92px] flex-col bg-sheet px-3 py-2.5" data-state={step.state}>
      <div className="flex items-start gap-2.5">
        <Icon
          size={16}
          className={cn(
            "mt-0.5 shrink-0",
            step.state === "checking" && "animate-spin",
            step.state === "done" ? "text-agency" : step.state === "held" ? "text-hold" : "text-ink-muted",
          )}
        />
        <div className="min-w-0">
          <div className="truncate text-[12.5px] font-semibold text-ink"><span className="text-ink-muted">{number}.</span> {step.title}</div>
          <p className="mt-0.5 text-[11.5px] leading-[1.35] text-ink-muted">{step.detail}</p>
        </div>
      </div>
      {actionable ? (
        <button
          type="button"
          onClick={onAction}
          className="pm-tactile mt-auto self-start rounded px-2 py-1 text-[11.5px] font-medium text-agency hover:bg-selected"
        >
          {actionLabel} <span aria-hidden="true">→</span>
        </button>
      ) : step.state === "done" ? (
        <span className="mt-auto pl-[26px] text-[11px] font-medium text-agency">Ready</span>
      ) : null}
    </div>
  );
}
