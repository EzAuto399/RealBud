import { useCallback, useEffect, useRef, useState } from "react";
import { api, useStore } from "@/state/store";
import { DESIGN_PREVIEW_REASON } from "@/lib/design-preview";
import type { BrowserStatus } from "../../../shared/browser";

const labels: Record<BrowserStatus["state"], string> = {
  not_installed: "Browser unavailable", off: "Not connected", starting: "Opening work browser", extension_needed: "Browser setup needs an update",
  choose_browser: "Choose your browser", ready: "Work browser ready", disconnected: "Work browser closed", needs_update: "Update needed", recovery_required: "Needs attention",
};
const button = "min-h-11 rounded border border-line px-3 py-2 text-sm font-medium text-ink hover:bg-selected focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-agency disabled:cursor-not-allowed disabled:opacity-50";

function actionError(cause: unknown, name: string): string {
  const message = cause instanceof Error ? cause.message : "";
  if (/QA denied non-connector fetch/i.test(message)) return "This design preview cannot open a work browser. Open the RealBud desktop app to connect your browser.";
  if (/install.*(?:Chrome|Edge)|(?:Chrome|Edge).*not (?:found|installed)/i.test(message)) return "Install Google Chrome or Microsoft Edge, then check the browser connection again.";
  if (name === "stop" || name === "disconnect") return "Browser release could not be confirmed. Check the connection before taking over or starting more work.";
  return "The work browser could not be opened or changed. Check the connection for the next recovery step.";
}

export function BrowserCard({ id = "you-browser", defaultOpen = false, disabledReason, onAsk }: {
  id?: string; defaultOpen?: boolean; disabledReason?: string; onAsk?: () => void;
} = {}) {
  const { state } = useStore();
  const unavailable = disabledReason ?? DESIGN_PREVIEW_REASON;
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [checking, setChecking] = useState(false);
  const epoch = useRef(0);
  const mounted = useRef(true);
  const mutating = useRef(false);
  const refresh = useCallback(async () => {
    if (mutating.current || unavailable || !state.connected) return;
    const request = ++epoch.current;
    setChecking(true);
    try {
      const next = await api("/api/browser", undefined, { timeoutMs: 10_000 }) as BrowserStatus;
      if (mounted.current && request === epoch.current) { setStatus(next); setError(""); }
    } catch {
      if (mounted.current && request === epoch.current) setError("The browser connection could not be checked. Check again before starting work.");
    } finally { if (mounted.current && request === epoch.current) setChecking(false); }
  }, [unavailable, state.connected]);
  useEffect(() => {
    mounted.current = true;
    if (state.connected && !unavailable) void refresh(); else setChecking(false);
    const onFocus = () => { if (state.connected && !unavailable) void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => { mounted.current = false; epoch.current++; window.removeEventListener("focus", onFocus); };
  }, [state.connected, unavailable, refresh]);
  const action = async (name: string, body = {}) => {
    if (mutating.current || unavailable || !state.connected) return;
    mutating.current = true; const request = ++epoch.current; setChecking(false); setBusy(name); setError(""); setNotice("");
    try {
      const next = await api(`/api/browser/${name}`, { method: "POST", body: JSON.stringify(body) }, { timeoutMs: 90_000 }) as BrowserStatus;
      if (mounted.current && request === epoch.current) { setStatus(next); setNotice(name === "stop" ? "Browser work stopped. You can take over in the browser." : name === "disconnect" ? "Browser closed. Your work profile is saved." : name === "select" ? "Browser selected." : ""); }
    } catch (cause) { if (mounted.current && request === epoch.current) setError(actionError(cause, name)); }
    finally { mutating.current = false; if (mounted.current) setBusy(""); }
  };
  const disabled = !!busy || !state.connected || !!unavailable;
  const ready = status?.state === "ready" && !error && state.connected && !unavailable;
  const chosen = status?.browsers.find(b => b.id === status.selectedBrowserId);
  const connectionLabel = unavailable ? "Preview only" : !state.connected ? "RealBud is offline" : error ? "Connection needs checking" : checking ? "Checking browser connection…" : ready && status?.active ? "Browser work is running" : status ? labels[status.state] : "Checking browser connection…";
  const connectionDetail = unavailable || (!state.connected ? "Reconnect RealBud to use the work browser." : error ? "" : status?.active ? "Bud is using the work browser. Stop the task to take over."
    : ready ? "Tell Bud what you want to do in Ask. Use the work browser to sign in if the website asks."
    : status?.state === "recovery_required" ? "Release the earlier browser task, then check any unfinished work."
    : status?.state === "not_installed" ? "Install Google Chrome or Microsoft Edge, then check again."
    : status && ["extension_needed", "needs_update"].includes(status.state) ? "Update RealBud, then check the connection again."
    : status?.state === "choose_browser" ? "Choose a compatible browser in Browser options below."
    : status && ["off", "disconnected"].includes(status.state) ? "Open your saved work profile to use websites with Bud."
    : "Checking this computer’s work browser…");
  const needsRelease = !!status?.active || status?.state === "recovery_required";
  const canOpen = status && ["off", "disconnected"].includes(status.state) && !error;
  const checkedAt = status?.checkedAt && Number.isFinite(status.checkedAt) ? new Date(status.checkedAt) : null;
  return <details id={id} open={defaultOpen || undefined} className="settings-section">
    <summary><span>Work browser</span><span className="settings-section-hint">{connectionLabel}</span></summary>
    <div className="settings-section-body space-y-3 text-sm leading-relaxed">
      <p role="status" aria-live="polite" className="text-ink-secondary">{connectionDetail}</p>
      {!unavailable && (needsRelease ? <button type="button" className={button + " border-danger text-danger"} disabled={disabled} onClick={() => void action("stop")}>{busy === "stop" ? "Releasing browser…" : "Stop browser work and take over"}</button>
        : canOpen ? <button type="button" className={button + " bg-agency text-white hover:bg-agency-hover"} disabled={disabled} onClick={() => void action("connect")}>{busy === "connect" ? "Opening work browser…" : "Open work browser"}</button>
        : ready && onAsk ? <button type="button" className={button + " bg-agency text-white hover:bg-agency-hover"} disabled={disabled || checking} onClick={onAsk}>Ask Bud to use a website</button>
        : !ready && <button type="button" className={button} disabled={disabled || checking} onClick={() => void refresh()}>{checking ? "Checking connection…" : "Check browser connection"}</button>)}
      {!unavailable && error && <p role="alert" className="text-danger">{error}</p>}
      {!unavailable && notice && <p role="status" className="text-agency">{notice}</p>}
      <details className="border-t border-line pt-3">
        <summary className="cursor-pointer font-medium">Browser options and sign-in help</summary>
        <div className="mt-3 space-y-3 text-ink-secondary">
          <p>Your separate work profile retains website sign-ins. Websites decide when they expire; this connection check does not renew them.</p>
          <p>To sign in or change account, stop any running browser work and wait for release, then use the work browser yourself. Return to Ask when you are ready. Stopping does not undo completed actions or restart the task.</p>
          <p>Bud can read websites and use permitted search and filter controls. Website record changes, uploads and downloads are not available in this build.</p>
          {!unavailable && status?.enabled && !status.active && (status.browsers.length > 1 || status.state === "choose_browser") && <fieldset className="space-y-2" disabled={disabled}>
            <legend className="mb-2 font-medium">Browser for this computer</legend>
            {status.browsers.map(browser => <div key={browser.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-2">
              <span className="min-w-0 break-words">{browser.name}{browser.label ? ` · ${browser.label}` : ""}{!browser.compatible ? " · Update needed" : ""}</span>
              {browser.id === status.selectedBrowserId ? <span className="text-agency">Selected</span> : <button type="button" className={button} disabled={disabled || !browser.compatible} onClick={() => void action("select", { browserId: browser.id })}>Use this browser<span className="sr-only">: {browser.name} {browser.label}</span></button>}
            </div>)}
          </fieldset>}
          {!unavailable && <div className="flex flex-wrap gap-2">
            {(ready || needsRelease || canOpen) && <button type="button" className={button} disabled={disabled || checking} onClick={() => void refresh()}>{checking ? "Checking connection…" : "Check browser connection"}</button>}
            {status?.enabled && <button type="button" className={button} disabled={disabled} onClick={() => void action("disconnect")}>{busy === "disconnect" ? "Disconnecting…" : "Turn browser access off"}</button>}
          </div>}
          {!unavailable && checkedAt && <p className="text-xs text-ink-muted">Last checked <time dateTime={checkedAt.toISOString()}>{checkedAt.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>{chosen ? ` · ${chosen.name}` : ""}. Engine {status?.version}.</p>}
          <p className="text-xs text-ink-muted">Turning browser access off closes the work browser and retains its profile. No extension is needed.</p>
        </div>
      </details>
    </div>
  </details>;
}
