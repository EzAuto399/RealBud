import { useEffect, useRef, useState } from "react";
import type { HermesStatus } from "@/state/store";
import { budAutoSetupRetryable, budAutoSetupView, budAvailability, budFacingCopy, budReadinessFailure, budSetupJourney, BUD_SETUP_STEP_LABELS, BUD_SETUP_STEPS } from "@/lib/bud-setup";
import { useBudStatusMonitor } from "@/lib/bud-status-monitor";
import { api, useStore } from "@/state/store";
import { scrollYouTarget } from "@/lib/you-navigation";
import { Card } from "./SettingsPrimitives";
import { ConnectOfficeView, useConnectOffice } from "./ConnectOffice";
import { modelAccessState, WEBSITE_LINK_CHANGED } from "./you/browser-link";

type ManagedBudStatusProps = {
  id: string;
  status: HermesStatus | null;
  connected: boolean;
  recovering?: boolean;
  active?: boolean;
  onRefresh: (isCurrent: () => boolean) => Promise<void>;
  onServiceAdministration?: () => void;
  onShowAsk?: () => void;
};

const secondaryButton = "pm-control rounded border border-line bg-sheet px-4 text-sm text-ink hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-agency disabled:opacity-50";

export function ManagedBudStatus({ id, status, connected, recovering = false, active = true, onRefresh, onServiceAdministration, onShowAsk }: ManagedBudStatusProps) {
  const { state, dispatch } = useStore();
  const office = useConnectOffice(state?.config?.profile?.name);
  const { pending, error, refresh } = useBudStatusMonitor({ enabled: connected && active, onRefresh });
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState("");
  const retryInFlight = useRef(false);
  const mounted = useRef(true);
  const refreshOffice = useRef(office.refresh);
  refreshOffice.current = office.refresh;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // Office status scopes withdrawal to the current installation. A worker
  // snapshot may still describe the previous link during an approved relink.
  // This affects presentation only; the retry guard retains the worker hold.
  const withdrawn = office.status ? office.status.serviceWithdrawn === true : Boolean(status?.modelAccess?.withdrawn);
  const displayStatus = status?.modelAccess && withdrawn !== status.modelAccess.withdrawn ? {
    ...status, ready: false, autoSetup: undefined, lastPing: null, lastTest: null,
    ...(status.model ? { model: { ...status.model, attached: false } } : {}),
    modelAccess: { ...status.modelAccess, managed: false, withdrawn, attached: false,
      detail: withdrawn ? "Model access was withdrawn for this computer. Your records are kept. Contact RealBud support." : status.modelAccess.detail },
  } : status;
  const availability = budAvailability(displayStatus, connected, recovering, { canAdminister: false });
  const known = connected && !error && !!status && status.cli.probeState !== "timeout" && status.cli.probeState !== "error";
  const ready = known && availability.ready;
  // An approved office link is what authorizes automatic installation. It
  // cannot wait behind the installation or safeguards it is meant to enable.
  const needsOfficeAccess = known && !recovering && !ready && !displayStatus?.modelAccess?.managed && !withdrawn;
  const officeLinked = office.status?.state === "linked";
  const officeAccess = modelAccessState(office.status);
  const officeSetupLabel = officeLinked
    ? officeAccess === "failed" || officeAccess === "skipped" || officeAccess === "not-yet" ? "Office service setup needed" : "Setting up your office connection"
    : office.status ? "Connect to your office" : office.error ? "Office connection unavailable" : "Checking office connection";
  const lastFailure = budAutoSetupView(displayStatus)?.working ? null : budReadinessFailure(displayStatus);
  // A link may finish on another setup surface. Refresh here even while a
  // missing worker prevented the old model step from becoming current.
  useEffect(() => {
    if (!active || !connected) return;
    const linked = () => {
      void refresh();
      void refreshOffice.current().catch(() => {});
    };
    window.addEventListener(WEBSITE_LINK_CHANGED, linked);
    return () => window.removeEventListener(WEBSITE_LINK_CHANGED, linked);
  }, [active, connected, refresh]);
  // Saved links can still be receiving service access after a restart. This
  // is a read-only, single-flight check; it stops when access arrives or this
  // panel closes, and never starts OAuth or changes service configuration.
  useEffect(() => {
    if (!active || !connected || !needsOfficeAccess || !officeLinked) return;
    let reading = false;
    const timer = window.setInterval(() => {
      if (reading || document.visibilityState === "hidden") return;
      reading = true;
      void refreshOffice.current().then(() => refresh()).catch(() => {}).finally(() => { reading = false; });
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [active, connected, needsOfficeAccess, officeLinked, refresh]);
  const journey = budSetupJourney({
    statusLoaded: known,
    workerInstalled: Boolean(status?.cli.installed && !status.bootstrapPending),
    workerPinned: Boolean(status?.cli.compatible ?? status?.cli.matchesPin),
    safeguardsInstalled: Boolean(status?.pack.installed),
    approvalsManual: Boolean(status?.pack.approvalsManual),
    workroomReady: Boolean(status?.pack.workroomReady),
    modelChecked: Boolean(displayStatus?.model),
    modelAttached: Boolean(displayStatus?.model?.attached && !withdrawn),
    verified: Boolean(displayStatus?.ready && !withdrawn && !recovering),
  });
  // Automatic setup after an approved office link needs no administrator.
  const automatic = connected && !error && !recovering ? budAutoSetupView(displayStatus) : null;
  const autoStep = automatic?.working ? displayStatus?.autoSetup?.step ?? 0 : 0;
  const waitingRetry = automatic?.working && displayStatus?.autoSetup?.state === "waiting_retry";
  const showOfficeAccess = needsOfficeAccess && !automatic;
  const canRetrySetup = connected && !recovering && !withdrawn && !status?.modelAccess?.withdrawn && budAutoSetupRetryable(status);
  useEffect(() => {
    // A later authoritative status can settle an uncertain response without
    // another click. Do not leave the earlier request warning beside Ready.
    if (ready || automatic?.working) setRetryError("");
  }, [ready, automatic?.working]);

  async function retrySetup() {
    if (retryInFlight.current || !canRetrySetup) return;
    retryInFlight.current = true;
    setRetrying(true);
    setRetryError("");
    try {
      await api("/api/hermes/auto-setup/retry", { method: "POST", body: "{}" });
    } catch {
      if (mounted.current) setRetryError("The setup request could not be confirmed. Checking its current status; your work is kept.");
    } finally {
      await refresh();
      retryInFlight.current = false;
      if (mounted.current) setRetrying(false);
    }
  }

  function openYou(target: string) {
    onServiceAdministration?.();
    dispatch({ type: "toggleAppSettings", open: false });
    if (location.hash === `#${target}`) scrollYouTarget(target);
    else location.hash = target;
  }

  return <section id={id} aria-label="Bud status" className="text-ink">
    <Card>
      <h2 className="text-lg font-semibold">Bud on this computer</h2>
      <div className="mt-2" role="status" aria-live="polite">
        <p className="text-sm font-medium">{error ? "Status unavailable" : showOfficeAccess ? officeSetupLabel : availability.label}</p>
        <p className="mt-1 text-sm leading-relaxed text-ink-secondary">{error
          ? `${budFacingCopy(error, "Could not check Bud's status.")} Your draft and saved plans are kept.`
          : showOfficeAccess ? officeLinked
            ? "Your office connection is saved. Bud must finish setting up and pass its test before work can start."
            : "Paste the link code your office owner sent you. RealBud then sets up Bud automatically."
          : availability.detail}</p>
      </div>
      <dl className="mt-4 divide-y divide-line" aria-label="Bud setup checks">
        {BUD_SETUP_STEPS.map(step => {
          const progress = journey.stepState[step];
          const index = BUD_SETUP_STEPS.indexOf(step) + 1;
          const label = autoStep ? (index < autoStep ? "Ready" : index === autoStep ? waitingRetry ? "Will retry" : "In progress" : "Waiting")
            : !known ? "Not checked"
            : step === "model" && withdrawn ? "Access withdrawn"
            : step === "model" && displayStatus?.model?.attached && progress !== "complete" ? "Configured"
            : step === "model" && displayStatus?.model && !displayStatus.model.attached ? "Not connected"
            : progress === "complete" ? "Ready"
            : progress === "current" ? (step === "verify" && !lastFailure ? "Not checked" : "Needs attention")
            : step === "model" && journey.stage === "checking" ? "Not checked" : "Waiting";
          return <div key={step} className="flex items-center justify-between gap-4 py-3 text-sm">
            <dt className="min-w-0">{BUD_SETUP_STEP_LABELS[step]}</dt>
            <dd className={`shrink-0 ${label === "Ready" ? "text-agency" : "text-ink-secondary"}`}>{label}</dd>
          </div>;
        })}
      </dl>
      {/* A setup hold already says what stopped and what to press; don't repeat it in red. */}
      {!ready && known && lastFailure && !automatic && <p className="mt-3 text-sm text-danger" role="status">Last readiness check: {lastFailure}</p>}
      {showOfficeAccess && <div className="mt-3 space-y-3">
        <div className="max-w-[32rem]"><ConnectOfficeView {...office.view} /></div>
      </div>}
      {retryError && <p role="alert" className="mt-3 text-sm text-danger">{retryError}</p>}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {recovering && connected && <button type="button" className="pm-decision rounded bg-agency px-4 text-sm font-medium text-white hover:bg-agency-hover" onClick={() => openYou("you-recovery")}>Unlock book</button>}
        {onShowAsk && <button type="button" className={ready || automatic?.working ? "pm-decision rounded bg-agency px-4 text-sm font-medium text-white hover:bg-agency-hover" : secondaryButton} onClick={onShowAsk}>Back to Work</button>}
        {canRetrySetup && <button type="button" className={secondaryButton} disabled={pending || retrying} aria-busy={retrying}
          onClick={() => { void retrySetup(); }}>{retrying ? "Requesting setup…" : "Try setup again"}</button>}
        {/* aria-disabled while checking: a disabled button drops keyboard focus to the page. */}
        {!automatic?.working && <button type="button" className={`${secondaryButton} aria-disabled:opacity-50`} disabled={!connected} aria-disabled={pending || undefined} aria-busy={pending} onClick={() => { if (!pending) void refresh(); }}>{pending ? "Checking…" : "Check again"}</button>}
      </div>
    </Card>
  </section>;
}
