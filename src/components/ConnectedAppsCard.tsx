import { OFFICE_SOURCE_LABELS, officeAppLabel, officeSourceState } from "@shared/office-sources";
import { officeSources, useOfficeSources } from "@/lib/connected-apps-refresh";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { api, useStore } from "@/state/store";
import { fmtDateTime } from "@/lib/au";
import {
  activeConnectedAccounts, APP_OPERATION_LABELS, canPrepareConnectedEmail, connectedAppOperationContext,
  connectedEmailContext, EMAIL_APPS, readConnectedAppOperations, selectedConnectedAccount,
  type ConnectedAppOperation, type EmailApp,
} from "@/lib/connected-apps";
import { resolveProductBudId } from "@/lib/product-bud";
import { Card } from "./SettingsPrimitives";
import { connectedAppsMode, hasUnconfirmedGmailSettingsChange, useConnectionSettingsPending, selectedConnectedAppsConfigured } from "./GmailReadOnlySetup";

const control = "pm-control inline-flex items-center justify-center gap-1.5 rounded-lg border border-line bg-sheet px-3 py-1.5 text-[12.5px] text-ink hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50";

const APP_MARK: Record<string, { letter: string; tone: string }> = {
  gmail: { letter: "G", tone: "bg-[#ea4335] text-white" },
  outlook: { letter: "O", tone: "bg-[#0078d4] text-white" },
  notion: { letter: "N", tone: "bg-ink text-white" },
  googlecalendar: { letter: "C", tone: "bg-[#1a73e8] text-white" },
};

function AppMark({ slug, size = "md" }: { slug: string; size?: "sm" | "md" }) {
  const mark = APP_MARK[slug] ?? { letter: officeAppLabel(slug).slice(0, 1).toUpperCase(), tone: "bg-agency text-white" };
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold ${mark.tone} ${size === "sm" ? "size-7 text-[11px]" : "size-9 text-[13px]"}`}
    >
      {mark.letter}
    </span>
  );
}

function officeFacingError(raw: string): string {
  return raw
    .replace(/^Composio MCP:\s*/i, "")
    .replace(/\bMCP\b/gi, "connection")
    .trim();
}

export function ConnectedAppsCard({ onAsk }: { onAsk?: () => void } = {}) {
  const { state, dispatch } = useStore();
  const currentState = useRef(state);
  currentState.current = state;
  const mode = connectedAppsMode(state.config?.composio);
  const readOnly = mode === "gmail-readonly" || state.config?.composio.managed === true;
  const configured = selectedConnectedAppsConfigured(state.config?.composio);
  const budId = resolveProductBudId(state.bots);
  const budBusy = Boolean(state.bots.find((bot) => bot.id === budId)?.busy);
  const settingsPending = useConnectionSettingsPending();
  const sourceView = useOfficeSources();
  const { snapshot } = sourceView;
  const [selected, setSelected] = useState<Partial<Record<EmailApp, string>>>({});
  const loading = sourceView.loading ? "check" : null;
  const [localError, setError] = useState("");
  const error = officeFacingError(localError || sourceView.error || snapshot?.error || "");
  const [operations, setOperations] = useState<ConnectedAppOperation[]>([]);
  const [operationsLoading, setOperationsLoading] = useState(false);
  const [operationsError, setOperationsError] = useState("");
  const [connecting, setConnecting] = useState<string | null>(null);
  const operationsRequest = useRef<AbortController | null>(null);
  const id = useId();

  const loadStatus = useCallback(async () => {
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
      if (!controller.signal.aborted) setOperationsError("Recent app activity could not be refreshed.");
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

  const askConnect = (label: string) => {
    if (!budId || budBusy || !state.connected || settingsPending) return;
    setConnecting(label);
    setError("");
    dispatch({ type: "error", message: null });
    onAsk?.();
    dispatch({ type: "showAsk" });
    dispatch({ type: "send", botId: budId, text: `connect ${label}` });
    setConnecting(null);
  };

  const checkAccess = () => { void loadStatus(); void loadOperations(); };
  const stageEmail = async (app: EmailApp) => {
    if (!configured || error || loading || !state.connected || budBusy || hasUnconfirmedGmailSettingsChange()) return;
    const config = state.config;
    const accountId = selectedConnectedAccount(snapshot?.services[app], selected[app])?.id;
    const fresh = await loadStatus();
    const latest = currentState.current;
    if (!fresh || latest.config !== config || hasUnconfirmedGmailSettingsChange() || !latest.connected || latest.bots.find((bot) => bot.id === budId)?.busy) return;
    if (accountId) {
      try { officeSources.accept(await api(`/api/connected-apps/sources/${app}`, { method: "PATCH", body: JSON.stringify({ accountId, enabled: true }) })); }
      catch { setError("The account choice couldn’t be saved. Refresh and try again."); return; }
    }
    const context = accountId ? connectedEmailContext(officeSources.getSnapshot().snapshot, app, accountId, crypto.randomUUID()) : null;
    if (context) {
      onAsk?.();
      dispatch({ type: "showAsk" });
      dispatch({ type: "stageAskContext", context });
    } else if (!fresh.error) setError("App access or the selected account changed. Check access before preparing a task.");
  };

  const connectedSlugs = Object.keys(snapshot?.services ?? {}).filter((slug) => snapshot?.services[slug]?.connected);
  const sharedMail = snapshot?.sourceKind === "office_shared";
  const connectable = EMAIL_APPS.filter((app) => !(app.slug === "gmail" && (sharedMail || (state.config?.composio.managed === true && (!snapshot?.services.gmail || !!snapshot.error)))) && (!readOnly || app.slug === "gmail") && !snapshot?.services[app.slug]?.connected);

  return (
    <Card title="Connected apps" subtitle="Connect your work accounts, check access, then prepare work in Ask.">
      <p className="text-[13px] leading-relaxed text-ink-secondary">
        {configured
          ? "Choose the accounts you want Bud to use. Your service administrator manages the connection service."
          : "Your service administrator needs to activate connections on this computer. You can then connect your own work accounts here."}
      </p>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <div className="text-[13px] text-ink-secondary" aria-live="polite">
          <p className="font-medium text-ink">{configured ? readOnly ? "Gmail read-only configured" : "Connection service configured" : "Connection setup needed"}</p>
          <p>
            {loading
              ? "Checking…"
              : snapshot?.checkedAt
                ? `Checked ${fmtDateTime(Date.parse(snapshot.checkedAt))}`
                : "Access not checked yet"}
          </p>
        </div>
        <button type="button" className={control} disabled={!configured || Boolean(loading) || settingsPending || !state.connected} onClick={checkAccess}>
          {loading === "check" ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <RefreshCw size={14} aria-hidden />}
          {loading === "check" ? "Checking…" : "Check access"}
        </button>
      </div>

      {error ? <p role="alert" className="mt-2 text-[13px] text-danger">{error}</p> : null}
      {!budId ? <p role="alert" className="mt-2 text-[13px] text-danger">Bud is not ready on this desk yet. Open Ask once, then try Connect again.</p> : null}
      {!state.connected ? <p role="status" className="mt-2 text-[13px] text-hold">Reconnecting to RealBud…</p> : null}

      {configured ? (
        <div className="mt-4 space-y-4">
          <section aria-labelledby={`${id}-connected`}>
            <h3 id={`${id}-connected`} className="text-[13px] font-medium text-ink">Connected</h3>
            {connectedSlugs.length ? (
              <ul className="mt-2 flex flex-wrap gap-2">
                {connectedSlugs.map((slug) => {
                  const service = snapshot?.services[slug];
                  const account = selectedConnectedAccount(service, selected[slug as EmailApp]);
                  const status = OFFICE_SOURCE_LABELS[officeSourceState(snapshot, slug)];
                  return (
                    <li key={slug} className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-full border border-line bg-sheet py-1.5 pl-1.5 pr-3">
                      <AppMark slug={slug} size="sm" />
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-medium text-ink">{officeAppLabel(slug)}</span>
                        <span className="block truncate text-[11.5px] text-ink-muted">{account?.label || status}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="mt-2 text-[13px] text-ink-secondary">Nothing connected yet.</p>
            )}
          </section>

          {snapshot?.sourceKind === "personal" && <p className="text-sm text-ink-secondary">Personal Gmail for this desktop.</p>}
          {sharedMail && <p className="text-sm text-ink-secondary">{snapshot?.services.gmail?.connected ? 'Office shared Gmail is connected for this desktop. No additional sign-in is needed.' : 'The office shared Gmail is not available. Ask the office owner to connect it, then check access again.'}</p>}
          {connectable.length ? (
            <section aria-labelledby={`${id}-connect`}>
              <h3 id={`${id}-connect`} className="text-[13px] font-medium text-ink">Connect</h3>
              <div className="mt-2 flex flex-wrap gap-2">
                {connectable.map((app) => (
                  <button
                    key={app.slug}
                    type="button"
                    className={control}
                    disabled={!budId || budBusy || !state.connected || Boolean(loading) || settingsPending || Boolean(connecting)}
                    onClick={() => askConnect(app.label)}
                  >
                    <AppMark slug={app.slug} size="sm" />
                    {connecting === app.label ? "Starting…" : `Connect ${app.label}`}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[12px] text-ink-muted">Bud opens sign-in in your browser. Finish there, then return here.</p>
            </section>
          ) : null}

          {connectedSlugs.some((slug) => EMAIL_APPS.some((app) => app.slug === slug)) ? (
            <section aria-labelledby={`${id}-prep`} className="rounded-lg border border-line p-3">
              <h3 id={`${id}-prep`} className="text-[13px] font-medium text-ink">Prepare mail work</h3>
              <div className="mt-2 space-y-2">
                {EMAIL_APPS.filter((app) => snapshot?.services[app.slug]?.connected).map((app) => {
                  const service = snapshot?.services[app.slug];
                  const active = activeConnectedAccounts(service);
                  const needsChoice = active.length > 1 || Boolean(service?.accountSelectionRequired && active.length);
                  const available = !error && !loading && canPrepareConnectedEmail(snapshot, app.slug, selected[app.slug]);
                  return (
                    <div key={app.slug} className="flex flex-wrap items-center gap-2">
                      <AppMark slug={app.slug} size="sm" />
                      <span className="text-[13px] text-ink">{app.label}</span>
                      {needsChoice ? (
                        <select
                          className="pm-control min-w-0 flex-1 rounded-lg border border-line bg-sheet px-2 text-[13px] text-ink"
                          value={selected[app.slug] ?? ""}
                          disabled={Boolean(loading)}
                          onChange={(event) => setSelected((current) => ({ ...current, [app.slug]: event.target.value }))}
                        >
                          <option value="">Choose account</option>
                          {active.map((row) => (
                            <option key={row.id} value={row.id}>{row.label || `Account ${row.id}`}</option>
                          ))}
                        </select>
                      ) : null}
                      <button
                        type="button"
                        className={`${control} !border-agency/30 !bg-agency !text-white hover:!bg-agency-hover`}
                        disabled={!available || !state.connected || budBusy || settingsPending}
                        onClick={() => void stageEmail(app.slug)}
                      >
                        Prepare follow-ups
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}

          {!readOnly ? (
            <details className="text-[12.5px] text-ink-secondary">
              <summary className="cursor-pointer">More apps · Notion, Calendar</summary>
              <div className="mt-2 flex flex-wrap gap-2">
                {["Notion", "Google Calendar"].map((app) => (
                  <button
                    key={app}
                    type="button"
                    className={control}
                    disabled={!budId || budBusy || !state.connected || Boolean(loading) || settingsPending}
                    onClick={() => askConnect(app)}
                  >
                    Connect {app}
                  </button>
                ))}
              </div>
            </details>
          ) : null}

          <details className="border-t border-line pt-3">
            <summary className="cursor-pointer text-[13px] font-medium text-ink">Recent activity · {operations.length}</summary>
            <div className="mt-2 flex items-center justify-between gap-2">
              <p className="text-[12px] text-ink-secondary">Receipts only — not permission to act.</p>
              <button type="button" className={control} disabled={operationsLoading || !state.connected} onClick={() => void loadOperations()}>
                {operationsLoading ? "Refreshing…" : "Refresh"}
              </button>
            </div>
            {operationsError ? <p role="alert" className="mt-2 text-[12.5px] text-danger">{operationsError}</p> : null}
            {!operations.length && !operationsError ? (
              <p role="status" className="mt-2 text-[12.5px] text-ink-secondary">{operationsLoading ? "Loading…" : "No activity yet."}</p>
            ) : null}
            <ul className="mt-2 divide-y divide-line">
              {operations.slice(0, 5).map((operation) => (
                <li key={operation.id} className="py-3 text-[12.5px]">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className={operation.status === "failed" || operation.status === "unknown" ? "font-medium text-hold" : "font-medium text-ink"}>
                      {APP_OPERATION_LABELS[operation.status]}
                    </span>
                    <span className="text-[12px] text-ink-muted">{fmtDateTime(Date.parse(operation.startedAt))}</span>
                  </div>
                  <p className="mt-1 break-words text-ink-secondary">{operation.toolSlugs.join(", ") || operation.toolName || "Connected app operation"}</p>
                  <button
                    type="button"
                    className={`${control} mt-2`}
                    disabled={budBusy}
                    onClick={() => {
                      onAsk?.();
                      dispatch({ type: "showAsk" });
                      dispatch({ type: "stageAskContext", context: connectedAppOperationContext(operation, crypto.randomUUID()) });
                    }}
                  >
                    Review with Bud
                  </button>
                </li>
              ))}
            </ul>
          </details>
        </div>
      ) : null}
    </Card>
  );
}
