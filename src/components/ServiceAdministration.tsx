import type { ReactNode } from "react";
import { useStore } from "@/state/store";
import { useServiceAdminAccess } from "@/lib/use-service-admin-access";
import { officeSources } from "@/lib/connected-apps-refresh";
import { ApiKeyRow } from "./ApiKeys";
import { BudSetupCard } from "./BudSetupCard";
import { CareUnlockCard } from "./CareUnlockCard";
import { GmailReadOnlySetup, useConnectionSettingsPending } from "./GmailReadOnlySetup";
import { Card } from "./SettingsPrimitives";
import { ManagedConnectionsCard } from "./ManagedConnectionsCard";

function ConnectionServiceSettings() {
  const { state, dispatch } = useStore();
  const pending = useConnectionSettingsPending();
  return <Card title="Connection service" subtitle="Provider credentials are write-only. Staff connect their own accounts under Apps.">
    <fieldset disabled={pending} className="min-w-0">
      <ApiKeyRow section="composio" onSaved={() => { void officeSources.refresh(); }} />
    </fieldset>
    <GmailReadOnlySetup config={state.config} connected={state.connected} onPendingChange={() => {}}
      onSaved={config => { dispatch({ type: "configStatus", config }); void officeSources.refresh(); }} />
  </Card>;
}

/** Unmount privileged controls on lock so unsaved keys do not survive re-login. */
export function ServiceAdministration({ children }: { children?: ReactNode }) {
  const { state } = useStore();
  const allowed = useServiceAdminAccess(state.serviceAdmin ?? state.config?.serviceAdmin);
  return <details id="you-service-admin" className="settings-section">
    <summary>
      <span>Service administration</span>
      <span className="settings-section-hint">{allowed ? "Unlocked in this window" : "Administrator sign-in · technical setup"}</span>
    </summary>
    <div className="settings-section-body flex flex-col gap-4">
      <CareUnlockCard />
      {allowed ? <>
        <p className="text-[13px] leading-relaxed text-ink-secondary">Administrator access only changes setup on this computer. It does not renew service access. This build checks a locally signed grant; online billing and remote suspension still require the managed gateway.</p>
        <BudSetupCard id="you-service-worker" administration />
        <ManagedConnectionsCard />
        {!state.config?.composio.managed && <details><summary className="cursor-pointer text-sm text-ink-secondary">Legacy local connection setup</summary><div className="mt-3"><ConnectionServiceSettings /></div></details>}
        {children}
      </> : null}
    </div>
  </details>;
}
