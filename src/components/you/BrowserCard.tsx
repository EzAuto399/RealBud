import { useCallback, useEffect, useRef, useState } from "react";
import { api, useStore } from "@/state/store";
import { BROWSER_EXTENSION_LINKS, type BrowserStatus } from "../../../shared/browser";

const labels: Record<BrowserStatus["state"], string> = {
  not_installed: "Helper missing", off: "Not connected", starting: "Connecting", extension_needed: "Add the browser extension",
  choose_browser: "Choose your browser", ready: "Connected", disconnected: "Connection lost", needs_update: "Update needed", recovery_required: "Needs attention",
};
const button = "min-h-11 rounded border border-line px-3 py-2 text-sm font-medium text-ink hover:bg-selected focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-agency disabled:cursor-not-allowed disabled:opacity-50";

export function BrowserCard() {
  const { state } = useStore();
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const epoch = useRef(0);
  const mounted = useRef(true);
  const mutating = useRef(false);
  const refresh = useCallback(async () => {
    if (mutating.current) return;
    const request = ++epoch.current;
    try {
      const next = await api("/api/browser", undefined, { timeoutMs: 10_000 }) as BrowserStatus;
      if (mounted.current && request === epoch.current) { setStatus(next); setError(""); }
    } catch {
      if (mounted.current && request === epoch.current) setError("The browser connection could not be checked. Check again before starting work.");
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    if (state.connected) void refresh();
    const onFocus = () => { if (state.connected) void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => { mounted.current = false; epoch.current++; window.removeEventListener("focus", onFocus); };
  }, [state.connected, refresh]);
  const action = async (name: string, body = {}) => {
    if (mutating.current) return;
    mutating.current = true; epoch.current++; setBusy(name); setError(""); setNotice("");
    try {
      const next = await api(`/api/browser/${name}`, { method: "POST", body: JSON.stringify(body) }, { timeoutMs: 90_000 }) as BrowserStatus;
      if (mounted.current) { setStatus(next); setNotice(name === "stop" ? "Browser work stopped. Check unfinished work before running it again." : name === "disconnect" ? "Browser access is off. Your browser sign-ins have not been changed." : name === "select" ? "Browser selected for this computer." : "Browser helper connected. Follow the next step below."); }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "This change could not be confirmed. Check the connection before retrying."); }
    finally { mutating.current = false; if (mounted.current) setBusy(""); }
  };
  const disabled = !!busy || !state.connected;
  const ready = status?.state === "ready" && !error && state.connected;
  const chosen = status?.browsers.find(b => b.id === status.selectedBrowserId);
  return <details id="you-browser" className="settings-section">
    <summary><span>Browser</span><span className="settings-section-hint">{!state.connected ? "RealBud is offline" : error ? "Check connection" : status ? labels[status.state] : "Checking connection…"}</span></summary>
    <div className="settings-section-body space-y-4 text-sm leading-relaxed">
      <div>
        <h3 className="text-[15px] font-medium">Use the browser you already know</h3>
        <p className="mt-1 text-ink-secondary">Bud works in your selected Chrome or Edge profile on this computer. Joining an office does not share your browser or sign-ins.</p>
      </div>
      <div className="border-l-2 border-agency pl-3" role="status" aria-live="polite">
        <p className="font-medium">{ready ? status?.active ? "Browser work is running" : `${chosen?.name || "Browser"} connected` : status ? labels[status.state] : "Checking your browser"}</p>
        <p className="mt-1 text-ink-secondary">{status?.detail || "Reading this computer’s connection status…"}</p>
      </div>
      {status?.state === "not_installed" && <p className="text-ink-secondary">Ask your setup person for the complete RealBud app. No terminal commands are needed.</p>}
      {status && ["off", "disconnected"].includes(status.state) && <button type="button" className={button + " bg-agency text-white hover:bg-agency-hover"} disabled={disabled} onClick={() => void action("connect")}>{busy === "connect" ? "Connecting…" : status.enabled ? "Reconnect browser helper" : "Connect my browser"}</button>}
      {status?.enabled && ["extension_needed", "disconnected", "needs_update"].includes(status.state) && <div className="space-y-3">
        <ol className="list-decimal space-y-2 pl-5 text-ink-secondary">
          <li>Add the browser extension to the profile you use for work.</li>
          <li>Open the extension beside your address bar and enable <strong className="font-medium text-ink">Local connection</strong>. Keep tab confirmation and requests for help on.</li>
          <li>Come back here and check the connection.</li>
        </ol>
        <div className="flex flex-wrap gap-2">
          <a className={button + " inline-flex items-center"} href={BROWSER_EXTENSION_LINKS.chrome} target="_blank" rel="noreferrer">Add to Chrome <span className="sr-only">(opens browser store)</span></a>
          <a className={button + " inline-flex items-center"} href={BROWSER_EXTENSION_LINKS.edge} target="_blank" rel="noreferrer">Add to Edge <span className="sr-only">(opens browser store)</span></a>
        </div>
      </div>}
      {status?.enabled && !status.active && !!status.browsers.length && <fieldset className="space-y-2" disabled={disabled}>
        <legend className="mb-2 font-medium">Browser for this computer</legend>
        {status.browsers.map(browser => <div key={browser.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-2">
          <span className="min-w-0 break-words">{browser.name}{browser.label ? ` · ${browser.label}` : ""}{!browser.compatible ? " · Update extension" : ""}</span>
          {browser.id === status.selectedBrowserId ? <span className="text-agency">Selected</span> : <button type="button" className={button} disabled={disabled || !browser.compatible} onClick={() => void action("select", { browserId: browser.id })}>Use this browser<span className="sr-only">: {browser.name} {browser.label}</span></button>}
        </div>)}
      </fieldset>}
      {ready && !status?.active && <p className="text-ink-secondary"><strong className="font-medium text-ink">To start:</strong> open the job’s website and sign in yourself. In Schedule, choose your saved job and press <strong className="font-medium text-ink">Run beside me</strong>. The browser will ask before lending Bud a tab.</p>}
      {(status?.active || status?.state === "recovery_required") && <div className="space-y-2">
        <button type="button" className={button + " border-danger text-danger"} disabled={disabled} onClick={() => void action("stop")}>{busy === "stop" ? "Releasing browser…" : "Stop browser work and take over"}</button>
        <p className="text-ink-secondary">Wait for release to finish before entering passwords or codes. Stop does not undo an action that already happened.</p>
      </div>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={disabled} onClick={() => void refresh()}>Check connection</button>
        {status?.enabled && <button type="button" className={button} disabled={disabled} onClick={() => void action("disconnect")}>{busy === "disconnect" ? "Disconnecting…" : "Turn browser access off"}</button>}
      </div>
      <details className="border-t border-line pt-3">
        <summary className="cursor-pointer font-medium">How Bud works on websites</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-secondary">
          <li>One saved job, its named websites and the browser you chose.</li>
          <li>You sign in and control payments, transfers, sending and signing.</li>
          <li>For bank work, start with reading statements and transaction history. Enter financial details yourself.</li>
          <li>A stopped or interrupted job stays stopped. Review what happened before starting another step.</li>
          <li>Page content Bud reads is used by your connected model to do the job. Keep unrelated tabs outside the job.</li>
        </ul>
      </details>
      <details className="border-t border-line pt-3 text-ink-secondary"><summary className="cursor-pointer">Connection details</summary><p className="mt-2">BrowserSkill {status?.version || "0.3.0"} · Local connection port {status?.port || 52800}. Browser access is managed by this RealBud installation.</p></details>
      {busy && <p role="status">{busy === "stop" || busy === "disconnect" ? "Waiting for the browser to confirm release…" : "Saving and checking your connection…"}</p>}
      {notice && <p role="status" className="text-agency">{notice}</p>}
      {error && <p role="alert" className="text-danger">{error}</p>}
    </div>
  </details>;
}
