import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { Card } from "../SettingsPrimitives";
import type { OfficeLinkStatus } from "../../../server/office-link";

export function WebsiteLinkCard() {
  const [status, setStatus] = useState<OfficeLinkStatus | null>(null);
  const [code, setCode] = useState(""); const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const refresh = async () => { setStatus(await api("/api/office-link")); };
  useEffect(() => { void refresh().catch(() => setError("Website link status could not be loaded. Try again.")); }, []);
  const act = async (action: "link" | "report" | "disconnect") => {
    setBusy(true); setError("");
    try {
      await api(`/api/office-link${action === "report" ? "/report" : ""}`, { method: action === "disconnect" ? "DELETE" : "POST", body: action === "link" ? JSON.stringify({ code, label }) : "{}" }, { timeoutMs: 20_000 });
      if (action !== "report") setCode("");
      setConfirm(false); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "The website link could not be updated."); }
    finally { setBusy(false); window.dispatchEvent(new Event("realbud-website-link-changed")); }
  };
  const linked = status?.state === "linked";
  return <Card title="Website account" subtitle="Optional. See this computer’s status in your RealBud website account.">
    <div className="space-y-3 text-sm">
      <p className="text-ink-secondary">This link is separate from local office collaboration. Linking a computer does not join an office host or share work with colleagues.</p>
      <p className="text-ink-secondary">The website receives this computer’s name, app and Bud versions, readiness, and last check-in. Your conversations, documents, and connected-app keys stay here.</p>
      {status?.serviceWithdrawn ? <p role="status" className="rounded border border-line p-3">Service access was withdrawn; your records are kept. Everything saved on this computer stays readable and exportable. Ask service support to add this computer again to restore connected accounts and Bud’s model.</p> : null}
      {linked ? <>
        <p><strong>{status.agencyLabel}</strong> · {status.label}</p>
        <p className="text-ink-muted">{status.lastReportedAt ? `Last reported ${new Date(status.lastReportedAt).toLocaleString()}` : "Linked. Send a status update to finish checking the connection."}</p>
        <div className="flex flex-wrap gap-3">
          <button className="pm-control rounded border border-line px-3 py-2" disabled={busy} onClick={() => void act("report")}>{busy ? "Updating…" : "Update status"}</button>
          <button className="pm-control rounded border border-line px-3 py-2" disabled={busy} onClick={() => setConfirm(true)}>Disconnect website</button>
        </div>
      </> : <form onSubmit={event => { event.preventDefault(); void act("link"); }} className="space-y-3">
        {status?.state === "revoked" ? <p role="status">This website link was revoked. Create a new code to reconnect.</p> : null}
        {status?.state === "pending" ? <div><p role="status">Linking was interrupted. Paste the same code to retry safely.</p><button type="button" disabled={busy} className="mt-1 underline" onClick={() => void act("disconnect")}>Cancel pending link</button></div> : null}
        <p>Open <a className="text-agency underline" href="https://realbud.app/account/installations" target="_blank" rel="noreferrer">Account → Computers</a>, create a link code, then paste it below.</p>
        <label className="block">Computer name<input required maxLength={80} autoComplete="off" value={label} onChange={event => setLabel(event.target.value)} placeholder="Reception Mac" className="mt-1 block w-full rounded border border-line bg-paper px-3 py-2" /></label>
        <label className="block">Link code<input required autoComplete="off" spellCheck={false} value={code} onChange={event => setCode(event.target.value)} placeholder="rb1_…" className="mt-1 block w-full rounded border border-line bg-paper px-3 py-2 font-mono" /></label>
        <button disabled={busy || !status || !code.trim() || !label.trim()} className="pm-control rounded border border-line px-3 py-2">{busy ? "Linking…" : "Link this computer"}</button>
      </form>}
      {confirm ? <div className="rounded border border-line p-3"><p>Disconnect this computer from the website and disable requests for its workspace? Your local work and subscription stay as they are. Preparation already running may still finish; check its saved outcome.</p><div className="mt-2 flex gap-3"><button disabled={busy} onClick={() => void act("disconnect")}>Disconnect</button><button disabled={busy} onClick={() => setConfirm(false)}>Keep linked</button></div></div> : null}
      {(error || status?.error) ? <p role="alert" className="text-red-700">{error || status?.error} <button className="underline" onClick={() => { setError(""); void refresh().catch(() => setError("Status could not be loaded.")); }}>Refresh</button></p> : null}
      <p className="text-xs text-ink-muted">Linking enables status reporting. To accept selected work requests, review the separate workspace permission below. Bud setup and service access are managed separately.</p>
    </div>
  </Card>;
}
