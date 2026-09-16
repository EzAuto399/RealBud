import { createPortal } from "react-dom";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Loader2, Paperclip, Plus, RefreshCw, X } from "lucide-react";
import { api } from "@/state/store";
import { cn } from "@/lib/cn";
import { officeSources, useOfficeSources } from "@/lib/connected-apps-refresh";
import { officeAppLabel, officeSourceState, readyOfficeApps, OFFICE_SOURCE_LABELS } from "@shared/office-sources";

async function setSourceEnabled(slug: string, enabled: boolean) {
  officeSources.invalidate();
  try {
    const access = await api(`/api/connected-apps/sources/${slug}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
    officeSources.accept(access);
  } finally { await officeSources.refresh(); }
}

/** Connected office apps stay available in Ask — no per-turn on/off. */
async function ensureConnectedSourcesAvailable(
  snapshot: ReturnType<typeof useOfficeSources>["snapshot"],
) {
  const excluded = snapshot?.excludedApps ?? [];
  if (!excluded.length) return;
  for (const slug of excluded) {
    if (!snapshot?.services[slug]?.connected) continue;
    try { await setSourceEnabled(slug, true); }
    catch { /* keep trying on the next refresh */ }
  }
}

/** Status chips only. Connected means available — dismiss is for the notice, not the app. */
export function ComposerOfficeSourceChips() {
  const { snapshot, loading, error, pendingService } = useOfficeSources();
  const healing = useRef(false);
  useEffect(() => {
    if (!snapshot || healing.current) return;
    const needs = (snapshot.excludedApps ?? []).some(slug => snapshot.services[slug]?.connected);
    if (!needs) return;
    healing.current = true;
    void ensureConnectedSourcesAvailable(snapshot).finally(() => { healing.current = false; });
  }, [snapshot]);
  const rows = Object.keys(snapshot?.services ?? {}).filter(slug => snapshot?.services[slug]?.connected);
  if (!rows.length && !pendingService && !error) return null;
  return <div className="mb-2 flex flex-wrap items-center gap-1.5" aria-label="Office sources available in Ask">
    {rows.map(slug => {
      const status = officeSourceState(snapshot, slug);
      if (status === "excluded") return null;
      return <span key={slug} className="inline-flex min-h-8 items-center rounded-full border border-line bg-sheet px-2.5 text-[12px] text-ink-secondary">
        {officeAppLabel(slug)} · {OFFICE_SOURCE_LABELS[status]}
      </span>;
    })}
    {pendingService ? <span role="status" className="text-[12px] text-ink-muted">{officeAppLabel(pendingService)} sign-in · waiting for the browser</span> : null}
    {error ? <span role="status" className="basis-full text-[12px] text-ink-muted">{error.replace(/^Composio MCP:\s*/i, "").replace(/\bMCP\b/gi, "connection")}</span> : null}
    {loading && !rows.length ? <span role="status" className="text-[12px] text-ink-muted">Checking office sources…</span> : null}
  </div>;
}

/** One compact panel for files, current app access, and recovery. */
export function ComposerOfficeToolkit({ disabled, onAttachFiles, onConnectApp, productAsk }: {
  disabled?: boolean; onAttachFiles: () => void; onConnectApp?: (label?: string) => void; productAsk?: boolean;
}) {
  const { snapshot, loading, error, pendingService } = useOfficeSources();
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
      if (rect) {
        // The composer may move outside the viewport while the panel is
        // focused or scrolled. Keep every recovery action reachable.
        const bottom = Math.max(12, Math.min(window.innerHeight - 132, window.innerHeight - rect.top + 8));
        setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - Math.min(360, window.innerWidth - 48) - 12)), bottom, maxHeight: Math.min(480, Math.max(120, window.innerHeight - bottom - 12)) });
      }
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
  const slugs = Object.keys(snapshot?.services ?? {}).filter(slug => {
    const service = snapshot?.services[slug];
    return Boolean(service?.connected || /init|pending/i.test(service?.status ?? ""));
  });
  const empty = !slugs.length && !pendingService;
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
      <div className="border-t border-line px-3 py-2"><p className="text-[13px] font-semibold">Office sources</p><p className="mt-1 text-[12px] text-ink-muted">{empty ? "Connect an office app to use it here." : "Connected apps stay available in Ask. Manage them in Connections."}</p></div>
      {empty ? <div className="border-t border-line px-3 py-3"><button type="button" className="min-h-11 text-[13px] text-agency" onClick={() => { close(); onConnectApp?.(); }}>Open Connections</button></div> : null}
      {slugs.map(slug => {
        const status = pendingService === slug ? "signing-in" : officeSourceState(snapshot, slug);
        const active = snapshot?.services[slug]?.connected;
        return <div key={slug} className="flex min-h-14 items-center justify-between gap-2 border-t border-line px-3 py-2">
          <div className="min-w-0"><p className="text-[13px] font-medium">{officeAppLabel(slug)}</p><p className="truncate text-[12px] text-ink-muted">{loading ? "Checking…" : status === "excluded" ? "Ready" : OFFICE_SOURCE_LABELS[status]}</p></div>
          {status === "choose-account" ? <select aria-label={`${officeAppLabel(slug)} account`} defaultValue="" disabled={loading || Boolean(changing)} className="min-h-11 max-w-[180px] rounded border border-line bg-sheet px-2 text-[12px]" onChange={async event => {
            const accountId = event.target.value;
            if (!accountId || changing) return;
            setChanging(slug);
            try {
              const access = await api(`/api/connected-apps/sources/${slug}`, { method: "PATCH", body: JSON.stringify({ accountId, enabled: true }) });
              officeSources.accept(access);
            } catch { setNotice("That account couldn’t be selected. Refresh and try again."); }
            finally { setChanging(null); }
          }}><option value="">Choose account</option>{snapshot?.services[slug]?.accounts.filter(account => /^active$/i.test(account.status)).map(account => <option key={account.id} value={account.id}>{account.label || account.id}</option>)}</select>
            : active ? <span className="min-h-11 px-2 text-[12px] text-ink-muted">Available in Ask</span>
            : <button type="button" disabled={Boolean(changing) || loading || status === "signing-in"} className="min-h-11 rounded-lg px-2 text-[12px] text-agency hover:bg-raised disabled:opacity-50" onClick={() => { close(); onConnectApp?.(officeAppLabel(slug)); }}>{status === "signing-in" ? "Finish sign-in" : "Connect"}</button>}
        </div>;
      })}
      {error || notice ? <p role="alert" className="px-3 py-2 text-[12px] text-hold">{(error || notice).replace(/^Composio MCP:\s*/i, "").replace(/\bMCP\b/gi, "connection")}</p> : null}
      <div className="flex items-center justify-between border-t border-line px-3 py-2">
        <button type="button" disabled={loading} className="inline-flex min-h-11 items-center gap-1 text-[12px] text-ink-secondary" onClick={() => void officeSources.refresh()}>{loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} {loading ? "Checking…" : "Refresh"}</button>
        <button type="button" className="min-h-11 text-[12px] text-agency" onClick={() => { close(); onConnectApp?.(); }}>Manage connections</button>
      </div>
      {snapshot?.configured ? <p className="px-3 pb-3 text-[12px] text-ink-muted">{readyOfficeApps(snapshot).length ? `${snapshot.tools.names.length} app tools available` : "No office apps available to this ask"}</p> : null}
    </div>, document.body) : null}
  </div>;
}
