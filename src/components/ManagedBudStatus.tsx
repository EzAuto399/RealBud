import { useEffect, useRef, useState } from "react";
import type { HermesStatus } from "@/state/store";
import { budAutoSetupRetryable, budAutoSetupView, budAvailability, budFacingCopy, budReadinessFailure, budSetupJourney, BUD_SETUP_STEP_LABELS, BUD_SETUP_STEPS } from "@/lib/bud-setup";
import { useBudStatusMonitor } from "@/lib/bud-status-monitor";
import { api, useStore } from "@/state/store";
import { scrollYouTarget } from "@/lib/you-navigation";
import type { BackupServiceBridge } from "@/lib/private-backup";
import { SUPPORT_SAVED, supportSaveOutcome } from "./you/SupportCard";
import { Card } from "./SettingsPrimitives";
import { ConnectOfficeView, useConnectOffice } from "./ConnectOffice";
import { modelAccessState, WEBSITE_LINK_CHANGED } from "./you/browser-link";
import { CONTACT_SUPPORT_INLINE } from "@shared/support";

type ManagedBudStatusProps = {
  id: string;
  status: HermesStatus | null;
  connected: boolean;
  recovering?: boolean;
  active?: boolean;
  onRefresh: (isCurrent: () => boolean) => Promise<void>;
  onServiceAdministration?: () => void;
  onShowAsk?: () => void;
  /** Names the screen this status was opened from, e.g. "Back to Desk". */
  backLabel?: string;
};

export const RESTART_HELP = "RealBud stops and starts its service on this computer. Your work is kept.";
export const RESTART_FAILED = `RealBud couldn’t confirm its service restarted. Your work is kept. Start it from RealBud service under Settings & help, or ${CONTACT_SUPPORT_INLINE}.`;
export const RESTART_BUSY = "Bud is still working, so RealBud didn’t restart its service. Try again when the current work finishes. Your work is kept.";
export const RESTART_NOT_OWNED = "Another RealBud installation on this computer started this service, so only that installation can restart it. Your work is kept.";
type ServiceNote = { ok: boolean; text: string } | null;
type ServiceBridge = Partial<Omit<BackupServiceBridge, "serviceStop">> & {
  serviceStop?(options?: { ifIdle?: boolean }): Promise<{ ok: boolean; busy?: boolean; status: { running?: boolean } }>;
  saveSupportFile?: () => Promise<unknown>;
};
type ServiceKind = "restart" | "support";
let serviceActionFlight: { kind: ServiceKind; promise: Promise<ServiceNote> } | null = null;

/** Restart the office service (a Bud update waits for it) or save a support
 * file, through the desktop bridge's existing, owner-checked controls. One at
 * a time across every Bud status view: a second press joins the first. The
 * note is fixed copy, never bridge error text. */
export function budServiceAction(kind: ServiceKind, bridge: ServiceBridge | undefined): Promise<ServiceNote> {
  // A press joins an action of the same kind; another kind waits its turn.
  if (serviceActionFlight?.kind === kind) return serviceActionFlight.promise;
  const before = serviceActionFlight?.promise.catch(() => null);
  const promise: Promise<ServiceNote> = (async (): Promise<ServiceNote> => {
    await before;
    if (kind === "restart") {
      try {
        const current = await bridge!.serviceStatus!();
        if (typeof current.running !== "boolean") return { ok: false, text: RESTART_FAILED };
        if (current.running && !current.manageable) return { ok: false, text: RESTART_NOT_OWNED };
        if (current.running) {
          // Never cut off Bud's work: the service refuses this stop while busy.
          const stopped = await bridge!.serviceStop!({ ifIdle: true });
          if (!stopped.ok) return { ok: false, text: stopped.busy ? RESTART_BUSY : RESTART_FAILED };
        }
        const started = await bridge!.serviceStart!();
        if (!started.ok || started.status.running !== true) return { ok: false, text: RESTART_FAILED };
        return { ok: true, text: "RealBud’s service restarted." };
      } catch { return { ok: false, text: RESTART_FAILED }; }
    }
    let outcome;
    try { outcome = supportSaveOutcome(await bridge!.saveSupportFile!()); }
    catch { outcome = supportSaveOutcome(null); }
    return outcome.kind === "saved" ? { ok: true, text: SUPPORT_SAVED } : outcome.kind === "failed" ? { ok: false, text: outcome.message } : null;
  })().finally(() => { if (serviceActionFlight?.promise === promise) serviceActionFlight = null; });
  serviceActionFlight = { kind, promise };
  return promise;
}

const secondaryButton = "pm-control rounded border border-line bg-sheet px-4 text-sm text-ink hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-agency disabled:opacity-50";

export function ManagedBudStatus({ id, status, connected, recovering = false, active = true, onRefresh, onServiceAdministration, onShowAsk, backLabel = "Back to Work" }: ManagedBudStatusProps) {
  const { state, dispatch } = useStore();
  const office = useConnectOffice(state?.config?.profile?.name);
  const { pending, error, refresh } = useBudStatusMonitor({ enabled: connected && active, onRefresh });
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState("");
  const retryInFlight = useRef(false);
  const [serviceWorking, setServiceWorking] = useState<"restart" | "support" | null>(null);
  const [serviceNote, setServiceNote] = useState<ServiceNote>(null);
  const mounted = useRef(true);
  const refreshOffice = useRef(office.refresh);
  refreshOffice.current = office.refresh;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // Office status scopes withdrawal to the current installation. A worker
  // snapshot may still describe the previous link during an approved relink.
  // This affects presentation only; the retry guard retains the worker hold.
  // Only a fresh link (linked or pending) may override the worker's hold; an
  // unlinked or revoked computer keeps the withdrawal, never a link prompt.
  const freshLink = office.status?.state === "linked" || office.status?.state === "pending";
  const withdrawn = office.status?.serviceWithdrawn === true || (!freshLink && Boolean(status?.modelAccess?.withdrawn));
  const displayStatus = status?.modelAccess && withdrawn !== status.modelAccess.withdrawn ? {
    ...status, ready: false, autoSetup: undefined, lastPing: null, lastTest: null,
    ...(status.model ? { model: { ...status.model, attached: false } } : {}),
    modelAccess: { ...status.modelAccess, managed: false, withdrawn, attached: false,
      detail: withdrawn ? "This computer's office access ended, so Bud can't answer here. Everything saved stays on this computer. Reconnect it in Workspace → Website account." : status.modelAccess.detail },
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
  const lastFailure = budAutoSetupView(displayStatus)?.working ? null : budReadinessFailure(displayStatus, office.status ? (officeLinked ? "linked" : "not-linked") : undefined);
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
  // Before the office link exists nothing can install yet: that is waiting, not
  // a problem. A failed check, blocked update or pending restart stays a hold.
  const awaitingLink = showOfficeAccess && !officeLinked && !lastFailure && !status?.restartRequired
    && !(status?.cli.installed && !(status.cli.compatible ?? status.cli.matchesPin));
  const canRetrySetup = connected && !recovering && !withdrawn && !status?.modelAccess?.withdrawn && budAutoSetupRetryable(status);
  // Holds staff clear themselves: a Bud update waiting for the office service
  // to restart (the service outlives the window, so reopening never does it),
  // and a damaged setup record only support can read.
  const bridge = typeof window === "undefined" ? undefined : window.ogb;
  const holdActionable = connected && !error && !recovering && !withdrawn && !ready;
  const needsRestart = holdActionable && Boolean(displayStatus?.restartRequired || displayStatus?.autoSetup?.code === "held_restart");
  const needsSupportFile = holdActionable && displayStatus?.autoSetup?.state === "held" && displayStatus.autoSetup.code === "held_recovery";
  const canRestart = Boolean(bridge?.serviceStatus && bridge.serviceStop && bridge.serviceStart);
  const canSaveSupport = typeof bridge?.saveSupportFile === "function";
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

  async function serviceAction(kind: "restart" | "support") {
    if (serviceWorking) return;
    setServiceWorking(kind);
    setServiceNote(null);
    const note = await budServiceAction(kind, window.ogb);
    if (kind === "restart" && note?.ok) await refresh();
    if (mounted.current) { setServiceNote(note); setServiceWorking(null); }
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
            : progress === "current" ? (step === "verify" && !lastFailure ? "Not checked" : awaitingLink ? "Starts after you connect" : "Needs attention")
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
      {needsRestart && <p className="mt-3 text-sm text-ink-secondary">{canRestart ? RESTART_HELP : "Open the RealBud desktop app to restart its service."}</p>}
      {needsSupportFile && !canSaveSupport && <p className="mt-3 text-sm text-ink-secondary">Open the RealBud desktop app to save a support file.</p>}
      {serviceNote && <p role={serviceNote.ok ? "status" : "alert"} className={`mt-3 text-sm ${serviceNote.ok ? "text-ink-secondary" : "text-danger"}`}>{serviceNote.text}</p>}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {recovering && connected && <button type="button" className="pm-decision rounded bg-agency px-4 text-sm font-medium text-white hover:bg-agency-hover" onClick={() => openYou("you-recovery")}>Unlock book</button>}
        {withdrawn && connected && !recovering && <button type="button" className="pm-decision rounded bg-agency px-4 text-sm font-medium text-white hover:bg-agency-hover" onClick={() => openYou("you-website")}>Reconnect this computer</button>}
        {onShowAsk && <button type="button" className={ready || automatic?.working ? "pm-decision rounded bg-agency px-4 text-sm font-medium text-white hover:bg-agency-hover" : secondaryButton} onClick={onShowAsk}>{backLabel}</button>}
        {needsRestart && canRestart && <button type="button" className="pm-decision rounded bg-agency px-4 text-sm font-medium text-white hover:bg-agency-hover disabled:opacity-50"
          disabled={serviceWorking !== null} aria-busy={serviceWorking === "restart"} onClick={() => { void serviceAction("restart"); }}>
          {serviceWorking === "restart" ? "Restarting RealBud’s service…" : "Restart RealBud’s service"}</button>}
        {needsSupportFile && canSaveSupport && <button type="button" className={secondaryButton}
          disabled={serviceWorking !== null} aria-busy={serviceWorking === "support"} onClick={() => { void serviceAction("support"); }}>
          {serviceWorking === "support" ? "Saving…" : "Save a support file"}</button>}
        {canRetrySetup && <button type="button" className={secondaryButton} disabled={pending || retrying} aria-busy={retrying}
          onClick={() => { void retrySetup(); }}>{retrying ? "Requesting setup…" : "Try setup again"}</button>}
        {/* aria-disabled while checking: a disabled button drops keyboard focus to the page. */}
        {!automatic?.working && <button type="button" className={`${secondaryButton} aria-disabled:opacity-50`} disabled={!connected} aria-disabled={pending || undefined} aria-busy={pending} onClick={() => { if (!pending) void refresh(); }}>{pending ? "Checking…" : "Check again"}</button>}
      </div>
    </Card>
  </section>;
}
