import { createPortal } from "react-dom";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Loader2, Paperclip, Plus, RefreshCw, X } from "lucide-react";
import { api, useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { officeSources, useOfficeSources } from "@/lib/connected-apps-refresh";
import { officeAppLabel, officeSourceState, readyOfficeApps, OFFICE_SOURCE_LABELS } from "@shared/office-sources";
import { connectedAppsMode } from "./GmailReadOnlySetup";

async function setSourceEnabled(slug: string, enabled: boolean) {
  officeSources.invalidate();
  try {
    const access = await api(`/api/connected-apps/sources/${slug}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
    officeSources.accept(access);
  } finally { await officeSources.refresh(); }
}

/** This is available access, not an attachment or permission to execute. */
export function ComposerOfficeSourceChips() {
  const { snapshot, loading, error, pendingService } = useOfficeSources();
  const [changing, setChanging] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const rows = Object.keys(snapshot?.services ?? {}).filter(slug => snapshot?.services[slug]?.connected || snapshot?.excludedApps?.includes(slug));
  if (!rows.length && !pendingService && !error && !notice) return null;
  return <div className="mb-2 flex flex-wrap items-center gap-1.5" aria-label="Office sources available in Ask">
    {rows.map(slug => {
      const status = officeSourceState(snapshot, slug);
      const off = status === "excluded";
      return <span key={slug} className="inline-flex min-h-8 items-center gap-1 rounded-full border border-line bg-sheet pl-2.5 pr-1 text-[12px] text-ink-secondary">
        {officeAppLabel(slug)} · {OFFICE_SOURCE_LABELS[status]}
        <button type="button" disabled={Boolean(changing) || loading} aria-label={`${off ? "Use" : "Turn off"} ${officeAppLabel(slug)} in Ask`}
          className="flex size-7 items-center justify-center rounded-full hover:bg-raised disabled:opacity-50"
          onClick={async () => {
            setChanging(slug); setNotice("");
            try { await setSourceEnabled(slug, off); setNotice(off ? `${officeAppLabel(slug)} is available for your next ask.` : `${officeAppLabel(slug)} is off. Bud won’t use it until you add it again.`); }
            catch { setNotice("Couldn’t confirm that change. Check Add before continuing."); }
            finally { setChanging(null); }
          }}>
          {changing === slug ? <Loader2 size={12} className="animate-spin" /> : off ? <Plus size={12} /> : <X size={12} />}
        </button>
      </span>;
    })}
    {pendingService ? <span role="status" className="text-[12px] text-ink-muted">{officeAppLabel(pendingService)} sign-in · waiting for the browser</span> : null}
    {error || notice ? <span role="status" className="basis-full text-[12px] text-ink-muted">{error || notice}</span> : null}
  </div>;
}

/** One compact panel for files, current app access, and recovery. */
export function ComposerOfficeToolkit({ disabled, onAttachFiles, onConnectApp, productAsk }: {
  disabled?: boolean; onAttachFiles: () => void; onConnectApp?: (label?: string) => void; productAsk?: boolean;
}) {
  const { state } = useStore();
  const { snapshot, loading, error, pendingService } = useOfficeSources();
  const mode = connectedAppsMode(state.config?.composio);
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const [position, setPosition] = useState({ left: 16, bottom: 80, maxHeight: 480 });
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - Math.min(360, window.innerWidth - 48) - 12)), bottom: window.innerHeight - rect.top + 8, maxHeight: Math.min(480, Math.max(120, rect.top - 24)) });
    };
    place(); window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  const close = () => { setOpen(false); triggerRef.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    void officeSources.refresh();
    panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node) && !panelRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);
  const slugs = [...new Set([...(mode === "gmail-readonly" ? ["gmail"] : ["gmail", "outlook"]), ...Object.keys(snapshot?.services ?? {}).filter(slug => snapshot?.services[slug]?.connected || /init|pending/i.test(snapshot?.services[slug]?.status ?? ""))])];
  const toggle = async (slug: string, enabled: boolean) => {
    if (changing) return;
    setChanging(slug); setNotice("");
    try { await setSourceEnabled(slug, enabled); }
    catch { setNotice("Couldn’t confirm the change. Your draft is kept. Try again."); }
    finally { setChanging(null); }
  };
  return <div ref={rootRef} className="relative shrink-0" onKeyDown={event => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (open && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    if (open && event.key === "Tab") {
      const items = [...(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [])];
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
    }
  }}>
    <button ref={triggerRef} type="button" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined}
      aria-label="Add files or office sources" title="Add" onClick={() => setOpen(value => !value)}
      className={cn("flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40", productAsk && "ask-attach", open && "bg-raised text-ink")}>
      <Plus size={18} />{productAsk ? <span>Add</span> : null}
    </button>
    {open ? createPortal(<div ref={panelRef} id={panelId} role="dialog" aria-label="Add files or office sources" style={position} className="fixed z-[60] w-[min(360px,calc(100vw-48px))] overflow-y-auto rounded-xl border border-line bg-sheet shadow-lg">
      <div className="flex items-center justify-between border-b border-line px-3 py-2"><strong className="text-[13px]">Add to your work</strong><button type="button" aria-label="Close Add" className="flex size-9 items-center justify-center rounded hover:bg-raised" onClick={close}><X size={16} /></button></div>
      <button type="button" className="flex min-h-11 w-full items-center gap-2 px-3 text-[13px] hover:bg-raised" onClick={() => { close(); onAttachFiles(); }}><Paperclip size={15} />Attach file</button>
      <div className="border-t border-line px-3 py-2"><p className="text-[13px] font-semibold">Office sources</p><p className="mt-1 text-[12px] text-ink-muted">Bud can use these when the job needs them. You review app actions.</p></div>
      {slugs.map(slug => {
        const status = pendingService === slug ? "signing-in" : officeSourceState(snapshot, slug);
        const active = snapshot?.services[slug]?.connected;
        const off = status === "excluded";
        return <div key={slug} className="flex min-h-14 items-center justify-between gap-2 border-t border-line px-3 py-2">
          <div className="min-w-0"><p className="text-[13px] font-medium">{officeAppLabel(slug)}</p><p className="truncate text-[12px] text-ink-muted">{loading ? "Checking…" : OFFICE_SOURCE_LABELS[status]}</p></div>
          {status === "choose-account" ? <select aria-label={`${officeAppLabel(slug)} account`} defaultValue="" disabled={loading || Boolean(changing)} className="min-h-11 max-w-[180px] rounded border border-line bg-sheet px-2 text-[12px]" onChange={async event => {
            const accountId = event.target.value;
            if (!accountId || changing) return;
            setChanging(slug);
            try {
              const access = await api(`/api/connected-apps/sources/${slug}`, { method: "PATCH", body: JSON.stringify({ accountId }) });
              officeSources.accept(access);
            } catch { setNotice("That account couldn’t be selected. Refresh and try again."); }
            finally { setChanging(null); }
          }}><option value="">Choose account</option>{snapshot?.services[slug]?.accounts.filter(account => /^active$/i.test(account.status)).map(account => <option key={account.id} value={account.id}>{account.label || account.id}</option>)}</select> : active ? <button type="button" aria-pressed={!off} disabled={loading || Boolean(changing)} className="min-h-11 rounded-lg px-2 text-[12px] text-agency hover:bg-raised disabled:opacity-50" onClick={() => void toggle(slug, off)}>{off ? "Use in Ask" : "Turn off"}</button>
            : <button type="button" disabled={Boolean(changing) || loading || status === "signing-in"} className="min-h-11 rounded-lg px-2 text-[12px] text-agency hover:bg-raised disabled:opacity-50" onClick={() => { close(); onConnectApp?.(officeAppLabel(slug)); }}>{status === "signing-in" ? "Finish sign-in" : "Connect"}</button>}
        </div>;
      })}
      {error || notice ? <p role="alert" className="px-3 py-2 text-[12px] text-hold">{error || notice}</p> : null}
      <div className="flex items-center justify-between border-t border-line px-3 py-2">
        <button type="button" disabled={loading} className="inline-flex min-h-11 items-center gap-1 text-[12px] text-ink-secondary" onClick={() => void officeSources.refresh()}>{loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} {loading ? "Checking…" : "Refresh"}</button>
        <button type="button" className="min-h-11 text-[12px] text-agency" onClick={() => { close(); onConnectApp?.(); }}>Manage connections</button>
      </div>
      {snapshot?.configured ? <p className="px-3 pb-3 text-[12px] text-ink-muted">{readyOfficeApps(snapshot).length ? `${snapshot.tools.names.length} app tools available` : "No office apps available to this ask"}</p> : null}
    </div>, document.body) : null}
  </div>;
}
