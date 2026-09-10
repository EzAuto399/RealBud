import { OFFICE_SOURCE_LABELS, officeSourceState } from "@shared/office-sources";
import { officeSources, useOfficeSources } from "@/lib/connected-apps-refresh";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowRight, Loader2, RefreshCw } from "lucide-react";
import { api, useStore } from "@/state/store";
import { fmtDateTime } from "@/lib/au";
import {
  activeConnectedAccounts, APP_OPERATION_LABELS, canPrepareConnectedEmail, connectedAppOperationContext,
  connectedEmailContext, EMAIL_APPS, readConnectedAppOperations, selectedConnectedAccount,
  type ConnectedAppOperation, type EmailApp,
} from "@/lib/connected-apps";
import { ApiKeyRow } from "./ApiKeys";
import { Card } from "./SettingsPrimitives";
import { connectedAppsMode, GmailReadOnlySetup, hasUnconfirmedGmailSettingsChange, selectedConnectedAppsConfigured } from "./GmailReadOnlySetup";

const control = "pm-control inline-flex items-center justify-center gap-1.5 rounded-lg border border-line bg-sheet px-3 py-1.5 text-[12.5px] text-ink hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50";

export function ConnectedAppsCard() {
  const { state, dispatch } = useStore();
  const currentState = useRef(state);
  currentState.current = state;
  const mode = connectedAppsMode(state.config?.composio);
  const readOnly = mode === "gmail-readonly";
  const configured = selectedConnectedAppsConfigured(state.config?.composio);
  const budBusy = Boolean(state.bots.find(bot => bot.id === "bud")?.busy);
  const [settingsPending, setSettingsPending] = useState(hasUnconfirmedGmailSettingsChange);
  const settingsPendingRef = useRef(settingsPending);
  const sourceView = useOfficeSources();
  const { snapshot } = sourceView;
  const [selected, setSelected] = useState<Partial<Record<EmailApp, string>>>({});
  const loading = sourceView.loading ? "check" : null;
  const [localError, setError] = useState("");
  const error = localError || sourceView.error;
  const [operations, setOperations] = useState<ConnectedAppOperation[]>([]);
  const [operationsLoading, setOperationsLoading] = useState(false);
  const [operationsError, setOperationsError] = useState("");
  const operationsRequest = useRef<AbortController | null>(null);
  const id = useId();

  const loadStatus = useCallback(async (_check = false) => {
    setError("");
    return officeSources.refresh();
  }, []);

  const loadOperations = useCallback(async () => {
    operationsRequest.current?.abort();
    const controller = new AbortController();
    operationsRequest.current = controller;
    setOperationsLoading(true);
    setOperationsError("");
    try {
      const body = await api("/api/connected-apps/operations", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
      const rows = readConnectedAppOperations(body);
      if (!controller.signal.aborted) setOperations(rows);
    } catch {
      if (!controller.signal.aborted) setOperationsError("Recent app activity could not be refreshed. Previous receipts are kept below.");
    } finally {
      if (!controller.signal.aborted) setOperationsLoading(false);
    }
  }, []);

  useEffect(() => {
    setSelected({});
    void loadStatus();
    void loadOperations();
    return () => { operationsRequest.current?.abort(); };
  }, [state.config, loadStatus, loadOperations]);

  const checkAccess = () => { void loadStatus(true); void loadOperations(); };
  const stageEmail = async (app: EmailApp) => {
    if (!configured || error || loading || !state.connected || budBusy || settingsPendingRef.current) return;
    const config = state.config;
    const accountId = selectedConnectedAccount(snapshot?.services[app], selected[app])?.id;
    // A tab can outlive the server observation or a key change in another
    // window. Fetch current status before touching the unsent Ask draft.
    const fresh = await loadStatus();
    const latest = currentState.current;
    if (!fresh || latest.config !== config || settingsPendingRef.current || !latest.connected || latest.bots.find(bot => bot.id === "bud")?.busy) return;
    if (accountId) {
      try { officeSources.accept(await api(`/api/connected-apps/sources/${app}`, { method: "PATCH", body: JSON.stringify({ accountId, enabled: true }) })); }
      catch { setError("The account choice couldn’t be saved. Refresh and try again."); return; }
    }
    const context = accountId ? connectedEmailContext(officeSources.getSnapshot().snapshot, app, accountId, crypto.randomUUID()) : null;
    if (context) dispatch({ type: "stageAskContext", context });
    else if (!fresh.error) setError("App access or the selected account changed. Check access and choose the account before preparing a task.");
  };

  return (
    <Card title="Connected apps" subtitle="Connect office apps and choose what Bud can use.">
      <fieldset disabled={settingsPending} className="min-w-0">
        {readOnly ? <details>
          <summary className="min-h-11 cursor-pointer py-3 text-[13px] text-ink-secondary">Other connected apps key</summary>
          <ApiKeyRow section="composio" />
        </details> : <ApiKeyRow section="composio" onSaved={() => {
          setSelected({}); void loadStatus();
        }} />}
      </fieldset>
      <GmailReadOnlySetup config={state.config} connected={state.connected}
        onPendingChange={pending => { settingsPendingRef.current = pending; setSettingsPending(pending); }}
        onSaved={config => { setSelected({}); dispatch({ type: "configStatus", config }); }} />
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <div className="text-[13px] text-ink-secondary" aria-live="polite">
          <p className="font-medium text-ink">{readOnly ? (configured ? "Gmail read-only setup saved" : "Gmail read-only setup incomplete") : (configured ? "Key saved" : "No key saved")}</p>
          <p>{loading ? (loading === "check" ? "Checking account status and available tools…" : "Loading the last access check…")
            : snapshot?.checkedAt ? `Last checked ${fmtDateTime(Date.parse(snapshot.checkedAt))}` : "Account access has not been checked."}</p>
        </div>
        <button type="button" className={control} disabled={!configured || Boolean(loading) || settingsPending || !state.connected} onClick={checkAccess}>
          {loading === "check" ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <RefreshCw size={14} aria-hidden />}
          {loading === "check" ? "Checking…" : "Check access"}
        </button>
      </div>
      {error ? <p role="alert" className="mt-2 text-[13px] text-danger">{error}</p> : null}
      {!state.connected ? <p role="status" className="mt-2 text-[13px] text-hold">Reconnecting to RealBud. App checks will be available when it returns.</p> : null}
      {readOnly ? <p className="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">This connection uses the Gmail read-only configuration. Google consent and mailbox access are checked separately. Outlook and other apps use the Connected apps connection.</p> : null}
      {configured ? <>
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">Finish sign-in in your browser. Account access refreshes automatically when you return.</p>
        <div className={`mt-3 grid gap-3 ${readOnly ? "" : "sm:grid-cols-2"}`}>
          {EMAIL_APPS.filter(app => !readOnly || app.slug === "gmail").map(app => {
            const service = snapshot?.services[app.slug];
            const active = activeConnectedAccounts(service);
            const account = selectedConnectedAccount(service, selected[app.slug]);
            const needsChoice = active.length > 1 || Boolean(service?.accountSelectionRequired && active.length);
            const available = !error && !loading && canPrepareConnectedEmail(snapshot, app.slug, selected[app.slug]);
            return <section key={app.slug} aria-labelledby={`${id}-${app.slug}`} className="min-w-0 rounded-lg border border-line p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id={`${id}-${app.slug}`} className="text-[14px] font-medium text-ink">{app.label}</h3>
                <span className="text-[12px] text-ink-secondary">{OFFICE_SOURCE_LABELS[officeSourceState(snapshot, app.slug)]}</span>
              </div>
              {needsChoice ? <label className="mt-3 block text-[12.5px] text-ink-secondary">
                Account for this task
                <select className="pm-control mt-1 w-full min-w-0 rounded-lg border border-line bg-sheet px-2 text-[13px] text-ink" value={selected[app.slug] ?? ""}
                  disabled={Boolean(loading)} onChange={event => setSelected(current => ({ ...current, [app.slug]: event.target.value }))}>
                  <option value="">Choose an active account</option>
                  {active.map(row => <option key={row.id} value={row.id}>{row.label || `Account ${row.id}`}</option>)}
                </select>
              </label> : account ? <p className="mt-2 break-words text-[13px] text-ink">{account.label || `Account ${account.id}`}</p> : null}
              {service?.connected && !active.length ? <p className="mt-2 text-[12.5px] text-hold">The provider has not identified an active account. Check access before preparing a task.</p> : null}
              {service?.accounts.some(row => !/^active$/i.test(row.status)) ? <details className="mt-2 text-[12px] text-ink-secondary">
                <summary className="cursor-pointer">Other account statuses</summary>
                <ul className="mt-1 space-y-1">{service.accounts.filter(row => !/^active$/i.test(row.status)).map(row => <li className="break-words" key={row.id}>{row.label || `Account ${row.id}`} · {row.status}</li>)}</ul>
              </details> : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className={control} disabled={budBusy || !state.connected || Boolean(loading) || settingsPending} onClick={() => {
                  dispatch({ type: "showAsk" }); dispatch({ type: "send", botId: "bud", text: `connect ${app.label}` });
                }}>{service?.connected ? `Check ${app.label} with Bud` : `Connect ${app.label}`}</button>
                <button type="button" className={`${control} !border-agency/30 !bg-agency !text-white hover:!bg-agency-hover`} disabled={!available || !state.connected || budBusy || settingsPending} onClick={() => void stageEmail(app.slug)}>
                  Prepare email follow-ups <ArrowRight size={14} aria-hidden />
                </button>
              </div>
              {needsChoice ? <p className="mt-2 text-[12px] text-ink-muted">Bud must confirm this account in the tool before reading. This choice grants no access.</p> : null}
            </section>;
          })}
        </div>
        <p className="mt-3 text-[12.5px] leading-relaxed text-ink-secondary">Prepare an editable request for the last 7 days, up to 10 threads. Bud groups property follow-ups and drafts reply text in Ask. Each app call still needs your review. Your unsent draft stays saved.</p>
        {snapshot?.checkedAt && (!readOnly || snapshot.services.gmail?.connected) && (!snapshot.tools.available || !snapshot.tools.names.length) && !error ? <p className="mt-2 text-[12.5px] text-hold">App tools were not available at the last check. Check access again before preparing email work.</p> : null}
        {snapshot?.tools.available && snapshot.tools.names.length ? <details className="mt-2 text-[12px] text-ink-secondary">
          <summary className="cursor-pointer">Available tool discovery · {snapshot.tools.names.length}</summary>
          <p className="mt-1">These tools were reported by the broker. Mailbox scopes and a successful read have not been verified.</p>
          <ul className="mt-2 max-h-36 space-y-1 overflow-auto">{snapshot.tools.names.map(name => <li className="break-all" key={name}>{name}</li>)}</ul>
        </details> : null}
        <p className="mt-2 text-[12px] text-ink-muted">Recurring email jobs are not connected yet. This prepares one task; it does not send or change mailbox content.</p>
        {budBusy ? <p role="status" className="mt-2 text-[12.5px] text-ink-secondary">Bud is finishing a task. You can check access now and prepare another task when it finishes.</p> : null}
        {!readOnly ? <details className="mt-3 text-[12.5px] text-ink-secondary">
          <summary className="cursor-pointer">Connect another work app</summary>
          <div className="mt-2 flex flex-wrap gap-2">{["Notion", "Google Calendar"].map(app => <button key={app} type="button" className={control} disabled={budBusy || !state.connected || Boolean(loading) || settingsPending} onClick={() => {
            dispatch({ type: "showAsk" }); dispatch({ type: "send", botId: "bud", text: `connect ${app}` });
          }}>Connect {app}</button>)}</div>
          <p className="mt-2">Bud checks these connections in Ask. The email access check above covers Gmail and Outlook.</p>
        </details> : null}
      </> : null}
      <details className="mt-4 border-t border-line pt-3">
        <summary className="cursor-pointer text-[13px] font-medium text-ink">Recent app activity · {operations.length}</summary>
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-[12px] text-ink-secondary">Operation receipts are separate from permission to act.</p>
          <button type="button" className={control} disabled={operationsLoading || !state.connected} onClick={() => void loadOperations()}>{operationsLoading ? "Refreshing…" : "Refresh activity"}</button>
        </div>
        {operationsError ? <p role="alert" className="mt-2 text-[12.5px] text-danger">{operationsError}</p> : null}
        {!operations.length && !operationsError ? <p role="status" className="mt-2 text-[12.5px] text-ink-secondary">{operationsLoading ? "Loading activity…" : "No connected-app operations recorded yet."}</p> : null}
        <ul className="mt-2 divide-y divide-line">{operations.slice(0, 5).map(operation => <li key={operation.id} className="py-3 text-[12.5px]">
          <div className="flex flex-wrap items-baseline justify-between gap-2"><span className={operation.status === "failed" || operation.status === "unknown" ? "font-medium text-hold" : "font-medium text-ink"}>{APP_OPERATION_LABELS[operation.status]}</span><span className="text-[12px] text-ink-muted">{fmtDateTime(Date.parse(operation.startedAt))}</span></div>
          <p className="mt-1 break-words text-ink-secondary">{operation.toolSlugs.join(", ") || operation.toolName || "Connected app operation"}</p>
          {operation.detail ? <p className="mt-1 break-words text-ink-secondary">{operation.detail}</p> : null}
          {operation.status === "unknown" ? <p className="mt-1 text-hold">Check the app before trying again. This action may have completed.</p> : null}
          <button type="button" className={`${control} mt-2`} disabled={budBusy} onClick={() => dispatch({ type: "stageAskContext", context: connectedAppOperationContext(operation, crypto.randomUUID()) })}>Review receipt with Bud</button>
        </li>)}</ul>
        {operations.length > 5 ? <p className="text-[12px] text-ink-muted">Showing the 5 most recent operations.</p> : null}
      </details>
      <p className="mt-3 text-[12px] leading-relaxed text-ink-muted">App passwords and provider tokens stay with the provider. Never paste them into Ask.</p>
    </Card>
  );
}
