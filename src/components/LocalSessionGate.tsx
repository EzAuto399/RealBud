import { useEffect, useState, type ReactNode } from "react";
import { api } from "@/state/store";
import { hasBrowserSession, LOCAL_SESSION_REQUIRED_EVENT, rejectLocalSession, setBrowserSessionToken } from "@/lib/local-session";

/** A plain browser tab (development, QA) has no desktop bridge to fetch the
 * local session token, and the service never serves it over HTTP, so its owner
 * pastes it once. An open workspace stays mounted while the tab reconnects, so
 * drafts survive a service restart. The desktop window never shows this. */
export function LocalSessionGate({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(hasBrowserSession);
  const [opened, setOpened] = useState(connected);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const required = () => { if (!window.ogb?.getLocalSession) setConnected(false); };
    window.addEventListener(LOCAL_SESSION_REQUIRED_EVENT, required);
    return () => window.removeEventListener(LOCAL_SESSION_REQUIRED_EVENT, required);
  }, []);

  const connect = async () => {
    if (busy) return;
    setBusy(true); setError("");
    const offered = token.trim();
    try {
      setBrowserSessionToken(offered);
      await api("/api/session", undefined, { timeoutMs: 15_000 });
      setToken(""); setConnected(true); setOpened(true);
    } catch {
      rejectLocalSession(offered);
      setError("That token was not accepted. Check the office service is running, then copy the token again.");
    } finally { setBusy(false); }
  };

  return <>
    {opened && <div className="contents" hidden={!connected} inert={!connected || undefined}>{children}</div>}
    {!connected && <main className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-paper p-4 text-ink">
      <section aria-labelledby="local-session-heading" className="w-full max-w-md space-y-4">
        <h1 id="local-session-heading" className="text-xl font-semibold">Connect this tab to RealBud</h1>
        <p>Run <code>node scripts/local-session.mjs</code> on this computer, then paste the token it prints. It stays in this tab only.</p>
        <form className="space-y-3" onSubmit={event => { event.preventDefault(); void connect(); }}>
          <label className="block">Connection token
            <input type="password" autoComplete="off" spellCheck={false} value={token} onChange={event => setToken(event.target.value)}
              disabled={busy} className="pm-control mt-1 block w-full rounded border border-line bg-sheet px-3 text-ink" />
          </label>
          <button type="submit" disabled={busy || !token.trim()} className="pm-decision rounded bg-agency px-4 text-white disabled:opacity-50">{busy ? "Connecting…" : "Connect"}</button>
        </form>
        {error && <p role="alert" className="text-danger">{error}</p>}
      </section>
    </main>}
  </>;
}
