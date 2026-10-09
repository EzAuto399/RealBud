import { MAIL_SENDS } from "@shared/app-tool-policy";
import { officeAppLabel } from "@shared/office-sources";
import { DESIGN_PREVIEW_REASON } from "@/lib/design-preview";
import { officeSources, useOfficeSources } from "@/lib/connected-apps-refresh";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Landmark, Loader2, RefreshCw, Search } from "lucide-react";
import { api, useStore } from "@/state/store";
import { fmtDateTime } from "@/lib/au";
import {
  activeConnectedAccounts, APP_OPERATION_LABELS, canPrepareConnectedEmail, connectedAppOperationContext,
  connectedEmailContext, EARLIER_CONNECTION_CODE, EMAIL_APPS, needsEarlierConnectionCheck, needsOwnerCheck, operationsToShow, readConnectedAppOperations, selectedConnectedAccount,
  type ConnectedAppOperation, type EmailApp,
} from "@/lib/connected-apps";
import { resolveProductBudId } from "@/lib/product-bud";
import { appConnectionPrompt, BANK_CSV_FALLBACK, connectedAppCatalog, filterConnectedAppCatalog, OFFICE_GMAIL_SLUG, REDBARK_APP_SLUG, type ConnectedAppCatalogEntry } from '@/lib/connected-app-catalog';
import { useSetupState } from "@/lib/use-setup-state";
import { OwnerRequestButton } from "./OwnerRequestButton";
import { SetupGateNote } from "./SetupGateNote";
import { useHermiosConnection, type HermiosConnectionControls } from "@/lib/hermios-connection-api";
import { useConnector, type ConnectorControls } from "@/lib/redbark-connection-api";
import { useConnectorRegistry } from "@/lib/mcp-connector-api";
import { OfficeConnectors } from "./ConnectorReview";
import { Card } from "./SettingsPrimitives";
import { HermiosMark } from "./HermiosMark";
import { connectedAppsMode, hasUnconfirmedGmailSettingsChange, useConnectionSettingsPending, selectedConnectedAppsConfigured } from "./GmailReadOnlySetup";
import { CHANGED_CONNECTION_MAIL_ACKNOWLEDGEMENT, MANUAL_MAIL_ACKNOWLEDGEMENT, connectedMailGatewayOrigin, opaqueDigest } from '@shared/connected-app-binding';
import { companyApi } from '@/lib/company-api';

type MailRecoveryView = { operationId: string; expectedRevision: number; toolName: string; account: { provider: 'gmail' | 'outlook'; accountId: string; companyId: string; gatewayOrigin: string; label: string };
  recoveryBindingDigest: string; reviewDigest: string; connectionChanged: boolean; startedAt: number; originalReview: { card: string; exact: string; approvedAt: number } };
function mailRecoveryView(value: unknown): MailRecoveryView {
  const row = value as MailRecoveryView;
  if (!row || typeof row !== 'object' || typeof row.operationId !== 'string' || !/^[a-f0-9-]{36}$/.test(row.operationId) || !Number.isSafeInteger(row.expectedRevision) || row.expectedRevision < 0 ||
    typeof row.toolName !== 'string' || !row.account || !['gmail', 'outlook'].includes(row.account.provider) || typeof row.account.accountId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.account.accountId) ||
    typeof row.account.companyId !== 'string' || !/^[A-Za-z0-9._:@+-]{1,128}$/.test(row.account.companyId) || typeof row.account.gatewayOrigin !== 'string' || connectedMailGatewayOrigin(row.account.gatewayOrigin) !== row.account.gatewayOrigin ||
    typeof row.account.label !== 'string' || !/^[^\r\n\u0000-\u001f\u007f]{1,300}$/.test(row.account.label) || !opaqueDigest(row.recoveryBindingDigest) || !opaqueDigest(row.reviewDigest) || typeof row.connectionChanged !== 'boolean' ||
    !Number.isSafeInteger(row.startedAt) || !row.originalReview || typeof row.originalReview.card !== 'string' || !row.originalReview.card || row.originalReview.card.length > 1_500_000 ||
    typeof row.originalReview.exact !== 'string' || row.originalReview.exact.length > 1_500_000 || !Number.isSafeInteger(row.originalReview.approvedAt)) throw new Error('This mail account or original review could not be verified for recovery.');
  return row;
}

const control = "pm-control inline-flex items-center justify-center gap-1.5 rounded-lg border border-line bg-sheet px-3 py-1.5 text-[12.5px] text-ink hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50";

const sendsMail = (operation: ConnectedAppOperation) => MAIL_SENDS.has(operation.toolName) || operation.toolSlugs.some(slug => MAIL_SENDS.has(slug));

/** An unconfirmed receipt RealBud cannot check: one with no saved account
 *  details, or a send recorded under an earlier company or managed gateway. The
 *  owner checks the app and says so here. Nothing is sent or undone. */
export function OwnerCheckNote({ operation, busy, onCheck, earlierConnection = false }: { operation: ConnectedAppOperation; busy: boolean; onCheck: () => void; earlierConnection?: boolean }) {
  const what = operation.toolSlugs.join(", ") || operation.toolName || "this action";
  return (
    <div className="mt-2 rounded-lg border border-line p-3">
      <p className="text-ink">{earlierConnection
        ? "This send was recorded under an earlier company or managed gateway, so RealBud can’t check it against today’s connection."
        : "This older action has no saved account details, so RealBud can’t check it for you."}</p>
      <p className="mt-1 text-ink-secondary">{earlierConnection
        ? "Open that mailbox and look in Sent to see whether it went. Until the office owner marks this checked, Bud warns before sending the same message again."
        : sendsMail(operation)
        ? "Open the mailbox and look in Sent to see whether it went. Bud holds new mail sends until the office owner marks this checked."
        : "Open the app and see whether it happened. Bud holds this action until the office owner marks this checked."}
        {" "}Marking it checked only records that you looked. It does not send, repeat or undo anything.</p>
      <button type="button" className={`${control} mt-2`} disabled={busy} aria-label={`I checked it in the app: ${what}`} onClick={onCheck}>I checked it in the app</button>
    </div>
  );
}

const APP_MARK: Record<string, { letter: string; tone: string }> = {
  gmail: { letter: "G", tone: "bg-[#ea4335] text-white" },
  outlook: { letter: "O", tone: "bg-[#0078d4] text-white" },
  notion: { letter: "N", tone: "bg-ink text-white" },
  googlecalendar: { letter: "C", tone: "bg-[#1a73e8] text-white" },
  googledrive: { letter: "D", tone: "bg-[#188038] text-white" },
  googlesheets: { letter: "S", tone: "bg-[#188038] text-white" },
  googledocs: { letter: "D", tone: "bg-[#1a73e8] text-white" },
  xero: { letter: "X", tone: "bg-[#007b9a] text-white" },
  slack: { letter: "S", tone: "bg-[#611f69] text-white" },
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

const primary = `${control} !border-agency/30 !bg-agency !text-white hover:!bg-agency-hover`;

type HermiosTileControls = Pick<HermiosConnectionControls, "view" | "connect" | "check" | "refresh">;

/** Bud's own Hermios connection, first in the list. Its state comes only from
 *  the RealBud service; the connection service's app list never sets it. */
export function HermiosFeaturedTile({ app, controls, disabled, onOpenDesk }: {
  app: ConnectedAppCatalogEntry; controls: HermiosTileControls; disabled: boolean; onOpenDesk: () => void;
}) {
  const { view, connect, check, refresh } = controls;
  const { state, loading, readError, busy, notice } = view;
  const blocked = disabled || busy !== null;
  const status = !state ? (loading ? "Checking Bud's Hermios connection…" : readError ?? app.status) : app.status;
  const connectButton = (label: string, sr?: string) => (
    <button type="button" className={primary} disabled={blocked} aria-busy={busy === "connect"} onClick={() => void connect()}>
      {busy === "connect" ? "Opening Hermios sign-in…" : label}{sr ? <span className="sr-only">{sr}</span> : null}
    </button>
  );
  const checkButton = (
    <button type="button" className={control} disabled={blocked} aria-busy={busy === "check"} onClick={() => void (state ? check() : refresh())}>
      {busy === "check" ? "Checking…" : "Check again"}<span className="sr-only"> for Hermios</span>
    </button>
  );
  const action = !state ? (loading ? null : checkButton)
    : state.status === "not_connected" ? connectButton("Connect Bud to your Hermios")
    : state.status === "connecting" ? checkButton
    : state.status === "connected" ? null
    : connectButton("Connect again", " to Hermios");
  return (
    <li className="flex min-w-0 flex-col rounded-xl border border-agency/30 bg-sheet p-4 sm:col-span-2" data-app-slug={app.slug} data-featured="true">
      <div className="flex items-start gap-3">
        <HermiosMark size={40} />
        <div className="min-w-0 flex-1">
          <h4 className="break-words text-[14px] font-semibold text-ink">{app.label}</h4>
          <p className="text-[12.5px] text-ink-secondary">{app.purpose}</p>
        </div>
      </div>
      <p role="status" className={`mt-2 break-words text-[12.5px] font-medium ${state?.status === "connected" ? "text-agency" : "text-ink"}`}>{status}</p>
      <p className="mt-1 text-[11.5px] text-ink-muted">{app.detail}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {action}
        <button type="button" className={control} onClick={onOpenDesk}>Go to Desk</button>
      </div>
      <p className="mt-1 text-[11.5px] text-ink-muted">Hermios is the tab beside Needs you on Desk.</p>
      {notice || (readError && state) ? (
        <p role={notice && !notice.problem ? "status" : "alert"} className={`mt-2 text-[12px] ${notice && !notice.problem ? "text-ink-secondary" : "text-hold"}`}>{notice?.text ?? readError}</p>
      ) : null}
    </li>
  );
}

/** Ask's inline bank-feed action: connect where the person asked, through the
 *  same service call (and owner/admin check) as the Workspace tile. */
export function BankFeedConnect({ controls }: { controls?: Pick<ConnectorControls, "view" | "connect" | "check" | "refresh"> }) {
  const own = useConnector();
  const { view, connect, check, refresh } = controls ?? own;
  const { state, loading, readError, busy, notice } = view;
  const status = state?.status;
  const line = !state ? (loading ? "Checking the bank feed…" : readError)
    : status === "connected" ? `Bank feed connected${state.account?.label ? ` (${state.account.label})` : ""}.`
    : status === "connecting" ? "Finish the Redbark sign-in in your browser, then check here."
    : !state.canManage ? `Only the office owner or an administrator can connect the bank feed. ${BANK_CSV_FALLBACK}`
    : null;
  const action = !state ? (loading ? null : <button type="button" className={control} disabled={busy !== null} onClick={() => void refresh()}>Check again</button>)
    : status === "connected" ? null
    : status === "connecting" ? <button type="button" className={control} disabled={busy !== null} aria-busy={busy === "check"} onClick={() => void check()}>{busy === "check" ? "Checking…" : "Check connection"}</button>
    : state.canManage ? <button type="button" className={primary} disabled={busy !== null} aria-busy={busy === "connect"} onClick={() => void connect()}>{busy === "connect" ? "Opening Redbark sign-in…" : status === "not_connected" ? "Connect bank feed" : "Connect again"}</button>
    : null;
  return (
    <span className="my-1 flex flex-wrap items-center gap-2">
      {action}
      {line ? <span role="status" className={`text-[12.5px] ${status === "connected" ? "text-agency" : "text-ink-secondary"}`}>{line}</span> : null}
      {state && !state.canManage && status === "not_connected" ? <OwnerRequestButton request="bankFeed" /> : null}
      {notice ? <span role={notice.problem ? "alert" : "status"} className={`text-[12px] ${notice.problem ? "text-hold" : "text-ink-secondary"}`}>{notice.text}</span> : null}
    </span>
  );
}

type BankFeedTileControls = Pick<ConnectorControls, "view" | "connect" | "check" | "disconnect" | "refresh">;

/** The office bank feed (Redbark). Same layout as the Hermios tile, but listed
 *  with the other apps. Only the office owner or an admin sees Connect and
 *  Disconnect; the service enforces that either way. Disconnect asks twice. */
export function BankFeedTile({ app, controls, disabled }: { app: ConnectedAppCatalogEntry; controls: BankFeedTileControls; disabled: boolean }) {
  const { view, connect, check, disconnect, refresh } = controls;
  const { state, loading, readError, busy, notice } = view;
  const [confirming, setConfirming] = useState(false);
  const blocked = disabled || busy !== null;
  const manage = state?.canManage === true;
  const status = !state ? (loading ? "Checking the bank feed…" : readError ?? app.status) : app.status;
  const sr = <span className="sr-only"> for the bank feed</span>;
  const connectButton = (label: string) => (
    <button type="button" className={primary} disabled={blocked} aria-busy={busy === "connect"} onClick={() => void connect()}>
      {busy === "connect" ? "Opening Redbark sign-in…" : label}{sr}
    </button>
  );
  const checkButton = (label = "Check again") => (
    <button type="button" className={control} disabled={blocked} aria-busy={busy === "check"} onClick={() => void (state ? check() : refresh())}>
      {busy === "check" ? "Checking…" : label}{sr}
    </button>
  );
  const disconnectControls = !manage ? null : confirming ? (
    <>
      <button type="button" className={`${control} !text-danger`} disabled={blocked} aria-busy={busy === "disconnect"} onClick={() => { setConfirming(false); void disconnect(); }}>
        {busy === "disconnect" ? "Disconnecting…" : "Confirm disconnect"}{sr}
      </button>
      <button type="button" className={control} disabled={busy !== null} onClick={() => setConfirming(false)}>Keep connected</button>
    </>
  ) : (
    <button type="button" className={control} disabled={blocked} onClick={() => setConfirming(true)}>Disconnect{sr}</button>
  );
  const actions = !state ? (loading ? null : checkButton())
    : state.status === "not_connected" ? (manage ? connectButton("Connect bank feed") : null)
    : state.status === "connecting" ? checkButton()
    : state.status === "connected" ? <>{checkButton("Check")}{disconnectControls}</>
    : state.status === "unavailable" ? <>{checkButton()}{manage ? connectButton("Connect again") : null}</>
    : manage ? connectButton("Connect again") : null;
  return (
    <li className="flex min-w-0 flex-col rounded-xl border border-line bg-sheet p-3" data-app-slug={app.slug}>
      <div className="flex items-start gap-3">
        <span aria-hidden className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary"><Landmark size={18} /></span>
        <div className="min-w-0 flex-1"><h4 className="break-words text-[13px] font-medium text-ink">{app.label}</h4><p className="text-[11.5px] text-ink-muted">{app.category}</p></div>
      </div>
      <p className="mt-2 text-[12.5px] text-ink-secondary">{app.purpose}</p>
      <p role="status" className={`mt-2 break-words text-[12px] font-medium ${state?.status === "connected" ? "text-agency" : "text-ink"}`}>{status}</p>
      <p className="mt-1 text-[11.5px] text-ink-muted">{app.detail}</p>
      {actions || app.ownerRequest ? <div className="mt-3 flex flex-wrap items-center gap-2">{actions}{app.ownerRequest ? <OwnerRequestButton request={app.ownerRequest} /> : null}</div> : null}
      {notice || (readError && state) ? (
        <p role={notice && !notice.problem ? "status" : "alert"} className={`mt-2 text-[12px] ${notice && !notice.problem ? "text-ink-secondary" : "text-hold"}`}>{notice?.text ?? readError}</p>
      ) : null}
    </li>
  );
}

export function ConnectedAppsCard({ onAsk, onBrowser, onOpenDesk }: { onAsk?: () => void; onBrowser?: () => void; onOpenDesk?: () => void } = {}) {
  const { state, dispatch } = useStore();
  const hermios = useHermiosConnection();
  const bankFeed = useConnector();
  const officeConnectors = useConnectorRegistry();
  const currentState = useRef(state);
  currentState.current = state;
  const mode = connectedAppsMode(state.config?.composio);
  // Gmail read-only is the one fixed-app mode. A managed office connects any
  // app on demand through its own connection service.
  const readOnly = mode === "gmail-readonly";
  const managed = state.config?.composio.managed === true;
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
  const [mailRecovery, setMailRecovery] = useState<MailRecoveryView | null>(null);
  /** Receipts Inspect named as recorded under an earlier company or gateway. */
  const [earlierConnection, setEarlierConnection] = useState<ReadonlySet<string>>(() => new Set());
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [customApp, setCustomApp] = useState("");
  const [appQuery, setAppQuery] = useState('');
  const [appFilter, setAppFilter] = useState<'all' | 'connected'>('all');
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

  const prepareMailRecovery = async (operation: ConnectedAppOperation) => {
    setRecoveryBusy(true); setOperationsError(''); setMailRecovery(null);
    try {
      const row = mailRecoveryView(await api(`/api/connected-apps/operations/${operation.id}/recovery`, { headers: companyApi.memberSessionHeaders() }));
      if (row.operationId !== operation.id || row.expectedRevision !== (operation.revision ?? 0)) throw new Error('This receipt changed. Refresh recent activity and inspect the current operation.');
      setMailRecovery(row);
    } catch (error) {
      // Only the owner's check in the app can settle such a send; offer it in place.
      if ((error as { code?: unknown } | null)?.code === EARLIER_CONNECTION_CODE && !operation.acknowledgement) { setEarlierConnection(previous => new Set(previous).add(operation.id)); return; }
      setOperationsError(error instanceof Error ? error.message : 'The original mail account could not be verified. Its outcome remains held.');
    }
    finally { setRecoveryBusy(false); }
  };
  const recordMailOutcome = async (outcome: 'sent' | 'not-sent') => {
    if (!mailRecovery || recoveryBusy) return;
    setRecoveryBusy(true); setOperationsError('');
    try {
      await api(`/api/connected-apps/operations/${mailRecovery.operationId}/reconcile`, { method: 'POST', headers: companyApi.memberSessionHeaders(), body: JSON.stringify({ expectedRevision: mailRecovery.expectedRevision, outcome,
        recoveryBindingDigest: mailRecovery.recoveryBindingDigest, reviewDigest: mailRecovery.reviewDigest,
        acknowledgement: mailRecovery.connectionChanged ? CHANGED_CONNECTION_MAIL_ACKNOWLEDGEMENT : MANUAL_MAIL_ACKNOWLEDGEMENT }) });
      setMailRecovery(null); await loadOperations();
    } catch (error) { setOperationsError(error instanceof Error ? error.message : 'This outcome could not be recorded. Refresh and inspect the exact account again.'); }
    finally { setRecoveryBusy(false); }
  };

  const acknowledgeOperation = async (operation: ConnectedAppOperation) => {
    if (recoveryBusy) return;
    setRecoveryBusy(true); setOperationsError('');
    try {
      await api(`/api/connected-apps/operations/${operation.id}/acknowledge`, { method: 'POST', headers: companyApi.memberSessionHeaders(), body: JSON.stringify({ expectedRevision: operation.revision ?? 0 }) });
      await loadOperations();
    } catch (error) { setOperationsError(error instanceof Error ? error.message : 'This could not be marked checked. Refresh recent activity and try again.'); }
    finally { setRecoveryBusy(false); }
  };

  useEffect(() => {
    setSelected({});
    void loadStatus();
    void loadOperations();
    return () => { operationsRequest.current?.abort(); };
  }, [state.config, loadStatus, loadOperations]);

  const askConnect = (label: string) => {
    const text = appConnectionPrompt(label);
    if (DESIGN_PREVIEW_REASON || !text || !configured || !budId || budBusy || !state.connected || settingsPending || loading || connecting) return false;
    setConnecting(label);
    setError("");
    dispatch({ type: "error", message: null });
    onAsk?.();
    dispatch({ type: "showAsk" });
    dispatch({ type: "send", botId: budId, text });
    setConnecting(null);
    return true;
  };

  const checkAccess = () => { void loadStatus(); void loadOperations(); };
  const stageEmail = async (app: EmailApp) => {
    if (DESIGN_PREVIEW_REASON || !configured || error || loading || !state.connected || budBusy || hasUnconfirmedGmailSettingsChange()) return;
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
  const catalog = connectedAppCatalog(snapshot, { configured, readOnly, managed, hermios: hermios.view.state, bankFeed: bankFeed.view.state });
  const visibleApps = filterConnectedAppCatalog(catalog, appQuery, appFilter);
  // Connecting asks Bud in Work, so it waits for setup's gate (office link, then Bud ready), said before the click.
  const gate = useSetupState().gates.connectApps;
  const budReady = state.hermes?.ready === true;
  const canConnect = !DESIGN_PREVIEW_REASON && configured && Boolean(budId) && gate.on && budReady && !budBusy && state.connected && !loading && !settingsPending && !connecting;
  const customConnect = () => {
    if (askConnect(customApp)) setCustomApp('');
  };

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h3 className="text-[15px] font-medium text-ink">Work apps</h3><p className="mt-0.5 text-[13px] text-ink-secondary">Find an app and connect your work account.</p></div>
        <div className="flex flex-wrap gap-2">
        {onBrowser && <button type="button" className={control} onClick={onBrowser}>Work browser</button>}
        <button type="button" className={control} disabled={!configured || Boolean(loading) || settingsPending || !state.connected} onClick={checkAccess}>
          {loading === "check" ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <RefreshCw size={14} aria-hidden />}
          {loading === "check" ? "Checking…" : "Check access"}
        </button>
        </div>
      </div>
      {DESIGN_PREVIEW_REASON && <p role="status" className="mt-3 rounded-lg bg-agency-soft p-3 text-[13px] text-ink">{DESIGN_PREVIEW_REASON} Search and explore the app list here.</p>}
      <p className="mt-2 text-[11.5px] text-ink-muted" aria-live="polite">
        {configured ? readOnly ? 'Gmail read-only configured' : managed ? 'Office connection service configured' : 'Connection service configured' : 'Connection setup needed'}
        {' · '}{loading ? 'Checking…' : snapshot?.checkedAt ? `Checked ${fmtDateTime(Date.parse(snapshot.checkedAt))}` : 'Access not checked yet'}
      </p>
      {/* Setup's reason and its fix, in place: link first, then Bud. */}
      {!gate.on && state.connected && !DESIGN_PREVIEW_REASON ? <SetupGateNote gate={gate} className="mt-2" />
        : !configured ? <p className="mt-2 text-[13px] text-ink-secondary">Your service administrator needs to activate connections on this computer. You can then connect your work accounts here.</p> : null}

      {error ? <p role="alert" className="mt-2 text-[13px] text-danger">{error}</p> : null}
      {!budId ? <div className="mt-2 flex flex-wrap items-center gap-2">
        <p role="alert" className="text-[13px] text-danger">Bud is not ready on this desk yet. Open Work once, then try Connect again.</p>
        <button type="button" className={control} onClick={() => { onAsk?.(); dispatch({ type: "showAsk" }); }}>Open Work</button>
      </div> : null}
      {!state.connected ? <p role="status" className="mt-2 text-[13px] text-hold">Reconnecting to RealBud…</p> : null}

      <section aria-labelledby={`${id}-catalog`} className="mt-3 space-y-3">
        <h3 id={`${id}-catalog`} className="sr-only">Find your work apps</h3>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-h-11 min-w-0 basis-56 flex-1 items-center gap-2 rounded-lg border border-line bg-sheet px-3 focus-within:ring-2 focus-within:ring-agency/30">
            <Search size={16} className="shrink-0 text-ink-muted" aria-hidden />
            <input type="search" aria-label="Search apps" placeholder="Search apps, mail, calendar, CRM…" value={appQuery} maxLength={100} onChange={event => setAppQuery(event.target.value)} className="min-h-11 min-w-0 flex-1 bg-transparent text-[13px] text-ink !outline-none" />
          </label>
          <div className="flex gap-1" role="group" aria-label="Filter apps">
            {(['all', 'connected'] as const).map(filter => <button key={filter} type="button" className={`${control} ${appFilter === filter ? '!border-agency/30 !bg-agency-soft' : ''}`} aria-pressed={appFilter === filter} onClick={() => setAppFilter(filter)}>
              {filter === 'all' ? 'All apps' : `Connected (${catalog.filter(app => app.connected).length})`}
            </button>)}
          </div>
        </div>
        <p className={visibleApps.length ? 'sr-only' : 'text-[12px] text-ink-secondary'} role="status">{visibleApps.length ? `${visibleApps.length} ${visibleApps.length === 1 ? 'app' : 'apps'} shown` : appQuery.trim() ? 'No apps match this search.' : 'No connected apps yet.'}</p>
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {visibleApps.map(app => {
            if (app.featured) return <HermiosFeaturedTile key={app.slug} app={app} controls={hermios} disabled={Boolean(DESIGN_PREVIEW_REASON) || !state.connected} onOpenDesk={onOpenDesk ?? (() => dispatch({ type: "showDesk" }))} />;
            if (app.slug === REDBARK_APP_SLUG) return <BankFeedTile key={app.slug} app={app} controls={bankFeed} disabled={Boolean(DESIGN_PREVIEW_REASON) || !state.connected} />;
            const service = app.slug === OFFICE_GMAIL_SLUG ? snapshot?.officeShared : snapshot?.services[app.slug];
            const accounts = activeConnectedAccounts(service);
            return <li key={app.slug} className="flex min-w-0 flex-col rounded-xl border border-line bg-sheet p-3" data-app-slug={app.slug}>
              <div className="flex items-start gap-3">
                <AppMark slug={app.slug === OFFICE_GMAIL_SLUG ? 'gmail' : app.slug} />
                <div className="min-w-0 flex-1"><h4 className="break-words text-[13px] font-medium text-ink">{app.label}</h4><p className="text-[11.5px] text-ink-muted">{app.category}</p></div>
              </div>
              <p className="mt-2 text-[12.5px] text-ink-secondary">{app.purpose}</p>
              <p className="mt-2 text-[12px] font-medium text-ink">{app.connected ? `Connected · ${app.status}` : app.status}</p>
              {app.connected && accounts.length > 0 && <ul className="mt-1 space-y-1 text-[12px] text-ink-secondary" aria-label={`${app.label} connected accounts`}>{accounts.map((account, index) => <li key={account.id} className="break-words">{account.label || `Connected account ${index + 1}`}</li>)}</ul>}
              {((app.slug === 'gmail' && (sharedMail || snapshot?.mailboxMode === 'both')) || app.slug === OFFICE_GMAIL_SLUG) && <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">{app.detail}</p>}
              {app.action && <button type="button" className={`${control} mt-3 self-start`} disabled={!canConnect} aria-label={app.action === 'find' ? `Find ${app.label} connection` : `Connect ${app.label}`} onClick={() => askConnect(app.label)}>
                {connecting === app.label ? 'Starting…' : app.action === 'find' ? 'Find connection' : `Connect ${app.label}`}
              </button>}
              {app.ownerRequest ? <div className="mt-3"><OwnerRequestButton request={app.ownerRequest} /></div> : null}
            </li>;
          })}
        </ul>
        <details className="text-[12px] text-ink-secondary">
          <summary className="cursor-pointer">How connections work</summary>
          <p className="mt-2">Common apps are suggestions. Bud checks connection availability before sign-in; connected accounts come from your service. Review the requested permissions on the app's sign-in page. Browser access is set up separately below.</p>
        </details>
      </section>
      <OfficeConnectors controls={officeConnectors} />

      {configured ? (
        <div className="mt-4 space-y-4">
          {snapshot?.mailboxMode === "both" ? <p className="text-sm text-ink-secondary">Your own Gmail, plus the office shared Gmail when the owner allows this computer. Say which mailbox you mean; Bud asks when it isn't clear.</p>
            : snapshot?.sourceKind === "personal" && <p className="text-sm text-ink-secondary">Personal Gmail for this desktop.</p>}
          {sharedMail && <p className="text-sm text-ink-secondary">{snapshot?.services.gmail?.connected ? 'Office shared Gmail is connected for this desktop. No additional sign-in is needed.' : 'The office shared Gmail is not available yet. The office owner connects it on realbud.app → Computers → Gmail for this office and allows this computer; then select Check access.'}</p>}

          {!readOnly ? (
            <section aria-labelledby={`${id}-any`}>
              <h3 id={`${id}-any`} className="text-[13px] font-medium text-ink">Find another app</h3>
              <p className="mt-1 text-[12.5px] text-ink-secondary">Name an app and Bud will check whether your connection service offers it.</p>
              <form
                className="mt-2 flex flex-wrap items-center gap-2"
                onSubmit={(event) => { event.preventDefault(); customConnect(); }}
              >
                <input
                  type="text"
                  aria-label="App to connect"
                  placeholder="App name, e.g. Xero"
                  className="pm-control min-w-0 flex-1 rounded-lg border border-line bg-sheet px-3 text-[13px] text-ink"
                  value={customApp}
                  maxLength={40}
                  disabled={!canConnect}
                  onChange={(event) => setCustomApp(event.target.value)}
                />
                <button type="submit" className={control} disabled={!canConnect || !customApp.trim()}>
                  Find connection
                </button>
              </form>
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
                        disabled={Boolean(DESIGN_PREVIEW_REASON) || !available || !state.connected || budBusy || settingsPending}
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
              {operationsToShow(operations).map((operation) => (
                <li key={operation.id} className="py-3 text-[12.5px]">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className={operation.status === "failed" || operation.status === "unknown" ? "font-medium text-hold" : "font-medium text-ink"}>
                      {APP_OPERATION_LABELS[operation.status]}
                    </span>
                    <span className="text-[12px] text-ink-muted">{fmtDateTime(Date.parse(operation.startedAt))}</span>
                  </div>
                  <p className="mt-1 break-words text-ink-secondary">{operation.toolSlugs.join(", ") || operation.toolName || "Connected app operation"}</p>
                  <p className="mt-1 break-all text-ink-secondary">Operation {operation.id}</p>
                  {operation.repeatOf ? <p className="mt-1 text-ink-secondary">Separately approved intentional repeat of {operation.repeatOf}.</p> : null}
                  {operation.reconciliation ? <p role="status" className="mt-2 text-ink-secondary">You recorded after inspecting the mail app: message {operation.reconciliation.outcome === 'sent' ? 'was sent' : 'was not sent'}. Manual evidence · {fmtDateTime(Date.parse(operation.reconciliation.at))}. The provider outcome remains {operation.status}. A new send still needs its own approval.</p> : null}
                  {operation.identified && MAIL_SENDS.has(operation.toolName) && (operation.status === 'unknown' || operation.status === 'failed') && !operation.reconciliation && !needsEarlierConnectionCheck(operation, earlierConnection) ? (
                    <button type="button" className={`${control} mt-2`} disabled={recoveryBusy || budBusy} onClick={() => void prepareMailRecovery(operation)}>Inspect and record mail outcome</button>
                  ) : null}
                  {needsOwnerCheck(operation) ? <OwnerCheckNote operation={operation} busy={recoveryBusy} onCheck={() => void acknowledgeOperation(operation)} /> : null}
                  {needsEarlierConnectionCheck(operation, earlierConnection) ? <OwnerCheckNote operation={operation} earlierConnection busy={recoveryBusy} onCheck={() => void acknowledgeOperation(operation)} /> : null}
                  {operation.acknowledgement ? <p role="status" className="mt-2 text-ink-secondary">Marked checked in the app · {fmtDateTime(Date.parse(operation.acknowledgement.at))}. The recorded outcome stays {operation.status === 'failed' ? 'failed' : 'unknown'}; a new action still needs its own approval.</p> : null}
                  {!operation.identified && operation.status === 'failed' ? <p className="mt-2 text-ink-secondary">The app reported a failure. Check it in the app before asking Bud to try again.</p> : null}
                  {mailRecovery?.operationId === operation.id ? (
                    <div className="mt-3 rounded-lg border border-line p-3">
                      <p className="font-medium text-ink">Check {mailRecovery.account.label} in {mailRecovery.account.provider === 'gmail' ? 'Gmail' : 'Outlook'}</p>
                      <p className="mt-1 break-all text-ink-secondary">Verified account {mailRecovery.account.accountId} · {mailRecovery.toolName} · operation {mailRecovery.operationId}</p>
                      <p className="mt-1 break-all text-ink-secondary">Company {mailRecovery.account.companyId} · managed gateway {mailRecovery.account.gatewayOrigin}</p>
                      <p className="mt-1 text-ink-secondary">Original approval {fmtDateTime(mailRecovery.originalReview.approvedAt)} · dispatch recorded {fmtDateTime(mailRecovery.startedAt)}</p>
                      {mailRecovery.connectionChanged ? <p role="alert" className="mt-2 font-medium text-hold">The connection changed since the original approval. The account above is the same exact verified account. Inspect the original reviewed message below in that account before recording a manual outcome.</p> : null}
                      <details className="mt-3" open><summary className="cursor-pointer font-medium text-ink">Original approved message and recipients</summary><pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words text-ink-secondary">{mailRecovery.originalReview.card}</pre></details>
                      <details className="mt-2"><summary className="cursor-pointer text-ink-secondary">Original exact request</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-ink-secondary">{mailRecovery.originalReview.exact}</pre></details>
                      <p className="mt-2 text-ink-secondary">Open this exact account in the mail app and inspect the operation. Record only what you checked. These controls save your manual evidence; they do not send mail or prove provider delivery.</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button type="button" className={control} disabled={recoveryBusy} onClick={() => void recordMailOutcome('sent')}>{mailRecovery.connectionChanged ? 'I checked the original message after reconnection: sent' : 'I checked: message was sent'}</button>
                        <button type="button" className={control} disabled={recoveryBusy} onClick={() => void recordMailOutcome('not-sent')}>{mailRecovery.connectionChanged ? 'I checked the original message after reconnection: not sent' : 'I checked: message was not sent'}</button>
                        <button type="button" className={control} disabled={recoveryBusy} onClick={() => setMailRecovery(null)}>Cancel</button>
                      </div>
                    </div>
                  ) : null}
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
