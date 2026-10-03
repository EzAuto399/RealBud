import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, CalendarDays, Check, ChevronDown, ChevronUp, FileText, Folder, Layers2, Loader2, Mail, MessageSquare, Plug, Plus, RefreshCw, Table2, X } from "lucide-react";
import { api, type Message } from "@/state/store";
import { officeSources, useOfficeSources } from "@/lib/connected-apps-refresh";
import { deriveAskAppContext } from "@/lib/ask-app-context";
import { readConnectedAppOperations, type ConnectedAppOperation } from "@/lib/connected-apps";

const dismissalKey = (threadId: string) => `realbud.app-context.dismissed:${threadId}`;
function readDismissal(threadId: string) {
  try { return sessionStorage.getItem(dismissalKey(threadId)) ?? ""; } catch { return ""; }
}
function saveDismissal(threadId: string, key: string) {
  try { sessionStorage.setItem(dismissalKey(threadId), key); } catch { /* Current-view state still works with storage unavailable. */ }
}
function isDismissed(contextKey: string, dismissed: string) {
  if (contextKey === dismissed) return true;
  try {
    const [request, apps] = JSON.parse(contextKey);
    const [dismissedRequest, dismissedApps] = JSON.parse(dismissed);
    // Finishing sign-in or removing an app should not undo Hide. Only a new
    // request or an additional relevant app can bring the card back.
    return request === dismissedRequest && Array.isArray(apps) && Array.isArray(dismissedApps) && apps.every(app => dismissedApps.includes(app));
  } catch { return false; }
}
const initialPreference = (threadId: string) => ({ threadId, dismissed: readDismissal(threadId), manual: false, all: false });

/** Visibility is a presentation preference; it never switches app access on or off. */
export function useAskAppContext({ threadId, messages, enabled = true }: { threadId: string; messages: Message[]; enabled?: boolean }) {
  const sources = useOfficeSources();
  const requestId = [...messages].reverse().find(message => message.role === "user")?.id ?? "";
  const activityKey = useMemo(() => {
    const requestIndex = messages.findIndex(message => message.id === requestId);
    return JSON.stringify(messages.slice(requestIndex + 1).filter(message => message.role === "bot" && message.kind === "activity" && message.tool)
      .map(message => [message.id, message.tool!.name, message.tool!.ok]));
  }, [messages, requestId]);
  const [receipts, setReceipts] = useState<{ threadId: string; requestId: string; rows: ConnectedAppOperation[] } | null>(null);
  useEffect(() => {
    if (!enabled || !requestId || activityKey === "[]") return;
    const controller = new AbortController();
    // Read existing receipts when tool activity changes; streaming prose and
    // status polling do not start additional requests or reveal another chat.
    void api("/api/connected-apps/operations", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) })
      .then(body => {
        const rows = readConnectedAppOperations(body);
        if (!controller.signal.aborted) setReceipts({ threadId, requestId, rows });
      }).catch(() => { /* Missing evidence never becomes an inferred app use. */ });
    return () => controller.abort();
  }, [enabled, threadId, requestId, activityKey]);
  const model = useMemo(() => deriveAskAppContext({
    messages, threadId, operations: receipts?.threadId === threadId && receipts.requestId === requestId ? receipts.rows : [],
    snapshot: sources.snapshot, pendingService: sources.pendingService, error: sources.error,
  }), [messages, threadId, requestId, receipts, sources.snapshot, sources.pendingService, sources.error]);
  const lastContext = useRef({ threadId, requestId, key: model.contextKey });
  if (lastContext.current.threadId !== threadId || lastContext.current.requestId !== requestId) {
    lastContext.current = { threadId, requestId, key: model.contextKey };
  } else if (model.contextKey) {
    lastContext.current.key = model.contextKey;
  }
  const [savedPreference, setPreference] = useState(() => initialPreference(threadId));
  const preference = savedPreference.threadId === threadId ? savedPreference : initialPreference(threadId);
  useEffect(() => { if (savedPreference.threadId !== threadId) setPreference(initialPreference(threadId)); }, [savedPreference.threadId, threadId]);
  const open = enabled && (preference.manual || (model.shouldAutoOpen && !isDismissed(model.contextKey, preference.dismissed)));
  const showAll = preference.all || model.relevantApps.length === 0;
  const rows = showAll ? model.apps : model.relevantApps;
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const focusOnOpen = useRef(false);
  const focusedInPanel = useRef(false);
  const [notice, setNotice] = useState("");

  useLayoutEffect(() => {
    if (open && focusOnOpen.current) {
      panelRef.current?.querySelector<HTMLButtonElement>('[data-context-close]')?.focus({ preventScroll: true });
      focusOnOpen.current = false;
    }
    if (focusedInPanel.current && document.activeElement === document.body) {
      if (open) panelRef.current?.querySelector<HTMLButtonElement>('[data-context-close]')?.focus({ preventScroll: true });
      else {
        triggerRef.current?.focus({ preventScroll: true });
        focusedInPanel.current = false;
      }
    }
  });

  const hide = () => {
    const restore = panelRef.current?.contains(document.activeElement) || triggerRef.current === document.activeElement;
    // A failed access read temporarily clears the source snapshot. Hide still
    // applies to this request when its same app context is observed again.
    const dismissed = model.contextKey || lastContext.current.key;
    saveDismissal(threadId, dismissed);
    setPreference({ ...preference, dismissed, manual: false, all: false });
    focusOnOpen.current = false;
    focusedInPanel.current = false;
    if (restore) triggerRef.current?.focus({ preventScroll: true });
  };
  const toggle = () => {
    if (open) { hide(); return; }
    focusOnOpen.current = true;
    setNotice("");
    setPreference({ ...preference, manual: true, all: false });
    void officeSources.refresh();
  };
  const check = async () => {
    // An explicit check keeps its result visible, including a failed observation.
    setPreference({ ...preference, manual: true });
    setNotice("");
    const access = await officeSources.refresh();
    if (access && !access.error) setNotice("App access checked.");
  };
  return {
    ...model, open, showAll, rows, loading: sources.loading, error: sources.error,
    panelId, panelRef, triggerRef, focusedInPanel, notice, toggle, hide, check,
    toggleAll: () => setPreference({ ...preference, manual: true, all: !showAll }),
  };
}

type Context = ReturnType<typeof useAskAppContext>;

export function AskAppContextToggle({ context }: { context: Context }) {
  return <button ref={context.triggerRef} type="button" className="ask-app-context-toggle" aria-label="App context" aria-expanded={context.open} aria-controls={context.open ? context.panelId : undefined} onClick={context.toggle} onKeyDown={event => {
    if (event.key === "Escape" && context.open && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); context.hide(); }
  }}>
    <Layers2 size={16} aria-hidden /><span>Context</span>
    {context.relevantApps.length > 0 && <span className="ask-app-context-count" aria-label={`${context.relevantApps.length} relevant app${context.relevantApps.length === 1 ? "" : "s"}`}>{context.relevantApps.length}</span>}
  </button>;
}

function AppIcon({ slug }: { slug: string }) {
  const Icon = /gmail|outlook/.test(slug) ? Mail : /calendar/.test(slug) ? CalendarDays : /sheets/.test(slug) ? Table2 : /drive/.test(slug) ? Folder : /docs|notion/.test(slug) ? FileText : /slack|teams/.test(slug) ? MessageSquare : Plug;
  return <Icon size={18} aria-hidden />;
}

/** A nonmodal companion to the conversation: auto-opening never takes input focus. */
export function AskAppContextPanel({ context, onManage }: { context: Context; onManage: () => void }) {
  if (!context.open) return null;
  return <aside ref={context.panelRef} id={context.panelId} role="region" aria-label="Connected apps context" className="ask-app-context-rail" onFocusCapture={() => { context.focusedInPanel.current = true; }} onBlurCapture={event => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) context.focusedInPanel.current = false;
  }} onKeyDown={event => {
    if (event.key === "Escape" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); context.hide(); }
  }}>
    <div className="ask-app-context-card">
      <header className="ask-app-context-header"><div><p className="ask-app-context-eyebrow">This conversation</p><h2>App context</h2></div><button type="button" data-context-close aria-label="Hide app context" onClick={context.hide}><X size={17} aria-hidden /></button></header>
      <div className="ask-app-context-section">
        <div className="ask-app-context-section-title"><h3>{context.showAll ? "Connected apps" : "For this request"}</h3><button type="button" aria-label="Add an app connection" title="Add an app connection" onClick={onManage}><Plus size={16} aria-hidden /></button></div>
        {context.rows.length > 0 ? <ul className="ask-app-context-list">
          {context.rows.map(app => <li key={app.slug}>
            <span className="ask-app-context-icon"><AppIcon slug={app.slug} /></span>
            <div className="ask-app-context-app"><strong>{app.label}</strong>{app.reasonLabel || app.state === "ready" ? <span>{app.reasonLabel ?? "Available to your requests"}</span> : null}
              {app.state !== "ready" && <span className="ask-app-context-state">{app.statusLabel}</span>}
            </div>
            {app.state === "ready" ? <span className="ask-app-context-ready" title="Available"><Check size={15} aria-hidden /><span className="sr-only">Available</span></span>
              : app.state !== "signing-in" ? <button type="button" className="ask-app-context-review" aria-label={`Review ${app.label} connection`} onClick={onManage}>Review</button> : null}
          </li>)}
        </ul> : <p className="ask-app-context-empty">{context.loading ? "Checking your app connections…" : context.error ? "App access could not be checked." : "No apps connected yet. Add a connection when your work needs one."}</p>}
        {!context.showAll && context.apps.length > context.relevantApps.length ? <button type="button" className="ask-app-context-browse" onClick={context.toggleAll}>View all apps <span>{context.apps.length}</span><ChevronDown size={14} aria-hidden /></button>
          : context.showAll && context.relevantApps.length > 0 && context.apps.length > context.relevantApps.length ? <button type="button" className="ask-app-context-browse" onClick={context.toggleAll}>Show relevant apps<ChevronUp size={14} aria-hidden /></button> : null}
      </div>
      {context.error ? <p className="ask-app-context-error" role="status">{context.error.replace(/^Composio MCP:\s*/i, "").replace(/\bMCP\b/gi, "connection")}</p> : null}
      <footer className="ask-app-context-footer"><button type="button" disabled={context.loading} onClick={() => void context.check()}>{context.loading ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <RefreshCw size={14} aria-hidden />}{context.loading ? "Checking…" : "Check access"}</button><button type="button" onClick={onManage}>Connections<ArrowUpRight size={14} aria-hidden /></button></footer>
      <span className="sr-only" role="status">{context.notice}</span>
    </div>
  </aside>;
}
