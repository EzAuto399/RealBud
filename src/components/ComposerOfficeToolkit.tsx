import { createPortal } from "react-dom";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { AlertCircle, ArrowRight, Check, ChevronRight, Loader2, Paperclip, Plus, RefreshCw, X } from "lucide-react";
import { api } from "@/state/store";
import { cn } from "@/lib/cn";
import { officeSources, useOfficeSources } from "@/lib/connected-apps-refresh";
import { officeAppLabel } from "@shared/office-sources";
import { COMPOSER_SOURCE_LABELS, composerOfficeSourceSlugs, composerOfficeSourceState } from "@/lib/composer-office-sources";

async function setSourceEnabled(slug: string, enabled: boolean) {
  officeSources.invalidate();
  try {
    const access = await api(`/api/connected-apps/sources/${slug}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
    officeSources.accept(access);
  } finally { await officeSources.refresh(); }
}

/** Connected office apps stay available in Ask — no per-turn on/off. */
async function ensureConnectedSourcesAvailable(snapshot: ReturnType<typeof useOfficeSources>["snapshot"]) {
  for (const slug of snapshot?.excludedApps ?? []) {
    if (!snapshot?.services[slug]?.connected) continue;
    try { await setSourceEnabled(slug, true); }
    catch { /* keep trying on the next refresh */ }
  }
}

const sourceError = (message: string) => message.replace(/^Composio MCP:\s*/i, "").replace(/\bMCP\b/gi, "connection");

/** Files are a request action; connections are persistent sources with explicit recovery. */
export function ComposerOfficeToolkit({ disabled, onAttachFiles, onConnectApp, productAsk }: {
  disabled?: boolean; onAttachFiles: () => void; onConnectApp?: (label?: string) => void; productAsk?: boolean;
}) {
  const { snapshot, loading, error, pendingService } = useOfficeSources();
  // Preserve connection availability without putting connection badges in the draft.
  const healing = useRef(false);
  useEffect(() => {
    if (!snapshot || healing.current) return;
    if (!(snapshot.excludedApps ?? []).some(slug => snapshot.services[slug]?.connected)) return;
    healing.current = true;
    void ensureConnectedSourcesAvailable(snapshot).finally(() => { healing.current = false; });
  }, [snapshot]);
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [checked, setChecked] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelFocusRef = useRef<HTMLElement | null>(null);
  const panelId = useId();
  const descriptionId = useId();
  const [position, setPosition] = useState<CSSProperties>({ left: 12, bottom: 80, maxHeight: 480, width: 380 });
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(380, window.innerWidth - 24);
      const above = Math.max(0, Math.min(rect.top - 20, window.innerHeight - 24));
      const below = Math.max(0, window.innerHeight - Math.max(12, rect.bottom + 8) - 12);
      const showAbove = above >= 400 || above >= below;
      setPosition({
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), width,
        ...(showAbove ? { bottom: window.innerHeight - Math.min(window.innerHeight - 12, rect.top - 8) } : { top: Math.max(12, rect.bottom + 8) }),
        maxHeight: Math.min(480, showAbove ? above : below),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  const close = () => { setOpen(false); triggerRef.current?.focus({ preventScroll: true }); };
  // Loading can disable the focused button; selecting an account replaces the
  // select altogether. Keep keyboard focus in the panel in either case.
  useLayoutEffect(() => {
    if (!open || !panelFocusRef.current || document.activeElement !== document.body) return;
    const previous = panelFocusRef.current;
    const next = previous.isConnected && !previous.matches(":disabled")
      ? previous : panelRef.current?.querySelector<HTMLButtonElement>("[data-autofocus]");
    next?.focus({ preventScroll: next === previous });
  });
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (!open) return;
    setNotice("");
    setChecked(false);
    void officeSources.refresh();
    panelRef.current?.querySelector<HTMLButtonElement>("[data-autofocus]")?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node) && !panelRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key !== "Tab") return;
      const items = [...(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]') ?? [])];
      const outsidePanel = !panelRef.current?.contains(document.activeElement);
      if (event.shiftKey && (outsidePanel || document.activeElement === items[0])) { event.preventDefault(); items.at(-1)?.focus(); }
      if (!event.shiftKey && (outsidePanel || document.activeElement === items.at(-1))) { event.preventDefault(); items[0]?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keyboard);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", keyboard); panelFocusRef.current = null; };
  }, [open]);
  const refresh = async () => {
    setNotice("");
    setChecked(false);
    const result = await officeSources.refresh();
    setChecked(Boolean(result && !result.error));
  };
  const slugs = composerOfficeSourceSlugs(snapshot, pendingService);
  const empty = !slugs.length;
  return <div ref={rootRef} className={cn("relative shrink-0", productAsk && "ask-add-control")}>
    <button ref={triggerRef} type="button" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined}
      aria-label="Add files or apps" title="Add files or apps" onClick={() => setOpen(value => !value)}
      className={cn("flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40", productAsk && "ask-attach", open && "bg-raised text-ink")}>
      <Plus size={18} aria-hidden />{productAsk ? <span>Add</span> : null}
    </button>
    {open ? createPortal(<div ref={panelRef} id={panelId} role="dialog" aria-label="Add to your work" aria-describedby={descriptionId} onFocusCapture={event => { panelFocusRef.current = event.target as HTMLElement; }} style={position} className={cn("ask-add-panel", productAsk && "ask-workspace")}>
      <div className="ask-add-header">
        <div><h2>Add to your work</h2><p id={descriptionId}>Give Bud the context it needs.</p></div>
        <button type="button" aria-label="Close Add" className="ask-add-close" onClick={close}><X size={18} aria-hidden /></button>
      </div>
      <div className="ask-add-body">
        <button type="button" data-autofocus className="ask-add-file" onClick={() => { close(); onAttachFiles(); }}>
          <span className="ask-add-icon"><Paperclip size={20} aria-hidden /></span>
          <span><strong>Attach files</strong><small>Documents, spreadsheets, images and text</small></span>
          <ChevronRight size={16} aria-hidden />
        </button>
        <section className="ask-add-sources" aria-label="Connected apps">
          <div className="ask-add-section-heading"><h3>Connected apps</h3>{loading && <Loader2 size={15} className="animate-spin" aria-label="Checking access" />}</div>
          <p className="ask-add-description">{empty ? loading ? "Checking your connections…" : error ? "Check access or open Connections to continue." : "Connect an app once, then use it in your requests." : "Use these apps by naming them in your request."}</p>
          {empty && !loading && !error ? <p className="ask-add-empty">No apps connected yet. You can still attach files.</p> : null}
          {slugs.map(slug => {
            const status = composerOfficeSourceState(snapshot, slug, pendingService, error);
            const service = snapshot?.services[slug];
            const selectedAccount = service?.accounts.find(account => account.id === service.selectedAccountId)
              ?? (service?.accounts.length === 1 ? service.accounts[0] : undefined);
            return <div key={slug} className="ask-add-source" data-state={status}>
              <div className="ask-add-source-name"><strong>{officeAppLabel(slug)}</strong>{selectedAccount?.label ? <small title={selectedAccount.label}>{selectedAccount.label}</small> : null}</div>
              {status === "ready" ? <span className="ask-add-available"><Check size={14} aria-hidden />Available</span>
                : status === "choose-account" ? <label className="ask-add-account"><span>{changing === slug ? "Selecting account…" : "Choose an account to continue"}</span><select aria-label={`${officeAppLabel(slug)} account`} value="" disabled={loading || Boolean(changing)} onChange={async event => {
                  const accountId = event.target.value;
                  if (!accountId || changing) return;
                  setChanging(slug);
                  setNotice("");
                  try {
                    const access = await api(`/api/connected-apps/sources/${slug}`, { method: "PATCH", body: JSON.stringify({ accountId, enabled: true }) });
                    officeSources.accept(access);
                  } catch { setNotice("Couldn’t confirm the account selection. Check access before trying again."); }
                  finally { setChanging(null); }
                }}><option value="">Choose account</option>{service?.accounts.filter(account => /^active$/i.test(account.status)).map((account, index) => <option key={account.id} value={account.id}>{account.label || `Account ${index + 1}`}</option>)}</select></label>
                : <div className="ask-add-source-recovery"><span>{COMPOSER_SOURCE_LABELS[status]}</span>
                  {status !== "signing-in" && (status === "unchecked"
                    ? <button type="button" disabled={loading} onClick={() => void refresh()}>Check access</button>
                    : onConnectApp ? <button type="button" disabled={Boolean(changing)} onClick={() => { close(); onConnectApp(); }}>Review connection<ChevronRight size={14} aria-hidden /></button> : null)}
                </div>}
            </div>;
          })}
        </section>
        {error || notice ? <p role="alert" className="ask-add-error"><AlertCircle size={16} aria-hidden /><span>{sourceError(notice || error)}</span></p> : null}
      </div>
      <div className="ask-add-footer">
        <button type="button" disabled={loading || Boolean(changing)} className="ask-add-refresh" onClick={() => void refresh()}>{loading ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <RefreshCw size={15} aria-hidden />}{loading ? "Checking…" : "Check access"}</button>
        {onConnectApp ? <button type="button" className="ask-add-manage" onClick={() => { close(); onConnectApp(); }}>{empty && !error ? "Connect an app" : "Manage connections"}<ArrowRight size={15} aria-hidden /></button> : null}
      </div>
      <span role="status" className="sr-only">{checked ? "App access checked." : ""}</span>
    </div>, document.body) : null}
  </div>;
}
