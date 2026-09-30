import { useEffect } from "react";
import type { HermesStatus } from "@/state/store";
import { budAutoSetupRetryable, budAutoSetupView, budAvailability, budFacingCopy, budReadinessFailure, budSetupJourney, BUD_SETUP_STEPS } from "@/lib/bud-setup";
import { useBudStatusMonitor } from "@/lib/bud-status-monitor";
import { api, useStore } from "@/state/store";
import { scrollYouTarget } from "@/lib/you-navigation";
import { Card } from "./SettingsPrimitives";
import { ConnectOffice } from "./ConnectOffice";
import { WEBSITE_LINK_CHANGED } from "./you/browser-link";

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

const stepLabels = {
  install: "Bud installed", safeguards: "Property safeguards", model: "Model connection", verify: "Private readiness check",
};
const secondaryButton = "pm-control rounded border border-line bg-sheet px-4 text-sm text-ink hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-agency disabled:opacity-50";

export function ManagedBudStatus({ id, status, connected, recovering = false, active = true, onRefresh, onServiceAdministration, onShowAsk }: ManagedBudStatusProps) {
  const { dispatch } = useStore();
  const { pending, error, refresh } = useBudStatusMonitor({ enabled: connected && active, onRefresh });
  const availability = budAvailability(status, connected, recovering, { canAdminister: false });
  const known = connected && !error && !!status && status.cli.probeState !== "timeout" && status.cli.probeState !== "error";
  const ready = known && availability.ready;
  const needsAccountLink = known && !recovering && !ready && !status?.modelAccess?.managed && !status?.modelAccess?.withdrawn
    && budAvailability(status, connected).target === "attach-model";
  const lastFailure = budAutoSetupView(status)?.working ? null : budReadinessFailure(status);
  // Connecting inline delivers model access: check Bud again once the link settles.
  useEffect(() => {
    if (!needsAccountLink) return;
    const linked = () => { void refresh(); };
    window.addEventListener(WEBSITE_LINK_CHANGED, linked);
    return () => window.removeEventListener(WEBSITE_LINK_CHANGED, linked);
  }, [needsAccountLink, refresh]);
  const journey = budSetupJourney({
    statusLoaded: known,
    workerInstalled: Boolean(status?.cli.installed && !status.bootstrapPending),
    workerPinned: Boolean(status?.cli.compatible ?? status?.cli.matchesPin),
    safeguardsInstalled: Boolean(status?.pack.installed),
    approvalsManual: Boolean(status?.pack.approvalsManual),
    workroomReady: Boolean(status?.pack.workroomReady),
    modelChecked: Boolean(status?.model),
    modelAttached: Boolean(status?.model?.attached && !status.modelAccess?.withdrawn),
    verified: Boolean(status?.ready && !status.modelAccess?.withdrawn && !recovering),
  });
  // Automatic setup after an approved office link needs no administrator.
  const automatic = connected && !error && !recovering ? budAutoSetupView(status) : null;
  const autoStep = automatic?.working ? status?.autoSetup?.step ?? 0 : 0;
  // Automatic setup's own hold already says what to do; the administrator text
  // is only for a computer without an active office link and grant.
  const needsAdministrator = known && !ready && !recovering && !status?.modelAccess?.withdrawn && !needsAccountLink && !automatic?.working
    && !budAutoSetupRetryable(status) && status?.autoSetup?.state !== "held" && !status?.modelAccess?.managed;

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
        <p className="text-sm font-medium">{error ? "Status unavailable" : availability.label}</p>
        <p className="mt-1 text-sm leading-relaxed text-ink-secondary">{error
          ? `${budFacingCopy(error, "Could not check Bud's status.")} Your draft and saved plans are kept.`
          : availability.detail}</p>
      </div>
      <dl className="mt-4 divide-y divide-line" aria-label="Bud setup checks">
        {BUD_SETUP_STEPS.map(step => {
          const progress = journey.stepState[step];
          const index = BUD_SETUP_STEPS.indexOf(step) + 1;
          const label = autoStep ? (index < autoStep ? "Ready" : index === autoStep ? "In progress" : "Waiting")
            : !known ? "Not checked"
            : step === "model" && status?.modelAccess?.withdrawn ? "Access withdrawn"
            : step === "model" && status?.model?.attached && progress !== "complete" ? "Configured"
            : step === "model" && status?.model && !status.model.attached ? "Not connected"
            : progress === "complete" ? "Ready"
            : progress === "current" ? (step === "verify" && !lastFailure ? "Not checked" : "Needs attention")
            : step === "model" && journey.stage === "checking" ? "Not checked" : "Waiting";
          return <div key={step} className="flex items-center justify-between gap-4 py-3 text-sm">
            <dt className="min-w-0">{stepLabels[step]}</dt>
            <dd className={`shrink-0 ${label === "Ready" ? "text-agency" : "text-ink-secondary"}`}>{label}</dd>
          </div>;
        })}
      </dl>
      {!ready && known && lastFailure && <p className="mt-3 text-sm text-danger" role="status">Last readiness check: {lastFailure}</p>}
      {needsAccountLink ? <div className="mt-3 space-y-3">
          <p className="text-sm leading-relaxed text-ink-secondary">Connect this computer to your office so Bud gets its AI access. The private readiness check still needs to pass before Bud can work.</p>
          <div className="max-w-[32rem]"><ConnectOffice /></div>
        </div>
        : needsAdministrator ? <p className="mt-3 text-sm leading-relaxed text-ink-secondary">Your service administrator needs to complete the remaining check. Status updates automatically. You can keep drafting and save plans in Schedule.</p> : null}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {recovering && connected && <button type="button" className="pm-decision rounded bg-agency px-4 text-sm font-medium text-white hover:bg-agency-hover" onClick={() => openYou("you-recovery")}>Unlock book</button>}
        {onShowAsk && <button type="button" className={ready ? "pm-decision rounded bg-agency px-4 text-sm font-medium text-white hover:bg-agency-hover" : secondaryButton} onClick={onShowAsk}>Return to Ask</button>}
        {budAutoSetupRetryable(status) && connected && <button type="button" className={secondaryButton} disabled={pending}
          onClick={() => { void api("/api/hermes/auto-setup/retry", { method: "POST", body: "{}" }).catch(() => {}).finally(() => { void refresh(); }); }}>Try setup again</button>}
        <button type="button" className={secondaryButton} disabled={pending || !connected} aria-busy={pending} onClick={() => { void refresh(); }}>{pending ? "Checking…" : "Check again"}</button>
      </div>
      {needsAdministrator && <button type="button" className="pm-control mt-2 text-sm text-ink-secondary underline underline-offset-4" onClick={() => openYou("you-service-admin")}>Service administration</button>}
    </Card>
  </section>;
}
