import { useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { Card } from "../SettingsPrimitives";
import { LINK_POLL_INTERVAL_MS, isLinkRequestIssued } from "@shared/installation-link";
import type { BrowserLinkRequest, BrowserLinkView, OfficeLinkStatus } from "../../../server/office-link";

/** Where the browser approval stands on this screen. */
export type BrowserLinkPhase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "waiting"; request: BrowserLinkRequest }
  | { kind: "cancelling"; request: BrowserLinkRequest }
  /** With a request: a status check failed. Without: starting failed. */
  | { kind: "unreachable"; message: string; request?: BrowserLinkRequest }
  | { kind: "failed"; message: string }
  | { kind: "declined" }
  | { kind: "expired" }
  | { kind: "linked"; agencyLabel: string };

const UNREADABLE = "RealBud could not read the website link answer. Try again.";

function approval(value: Record<string, unknown>): BrowserLinkRequest | null {
  const { approvalUrl, displayCode, expiresAt } = value;
  let origin: string;
  try { origin = new URL(String(approvalUrl)).origin; } catch { return null; }
  const issued = { version: 1, purpose: "installation-link-issued", approvalUrl, displayCode, expiresAt };
  return isLinkRequestIssued(issued, origin) ? { approvalUrl: issued.approvalUrl, displayCode: issued.displayCode, expiresAt: issued.expiresAt } : null;
}

/** Re-validate a browser-link answer from the local service; anything malformed is null. */
export function readBrowserLinkView(value: unknown): BrowserLinkView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const view = value as Record<string, unknown>;
  switch (view.state) {
    case "none": case "expired": case "declined": return { state: view.state };
    case "linked": return typeof view.agencyLabel === "string" ? { state: "linked", agencyLabel: view.agencyLabel } : null;
    case "pending": { const pending = approval(view); return pending ? { state: "pending", ...pending } : null; }
    default: return null;
  }
}

/** A pending approval the service saved, for resuming after a restart. */
export function savedBrowserRequest(status: OfficeLinkStatus | null): BrowserLinkRequest | null {
  const browser: unknown = status?.state === "pending" ? status.browser : undefined;
  return browser && typeof browser === "object" ? approval(browser as Record<string, unknown>) : null;
}

function phaseFor(view: BrowserLinkView): BrowserLinkPhase {
  switch (view.state) {
    case "pending": return { kind: "waiting", request: { approvalUrl: view.approvalUrl, displayCode: view.displayCode, expiresAt: view.expiresAt } };
    case "linked": return { kind: "linked", agencyLabel: view.agencyLabel };
    case "expired": return { kind: "expired" };
    case "declined": return { kind: "declined" };
    default: return { kind: "idle" };
  }
}

/**
 * Bud's model access after a link. Approval carries no credential: it arrives
 * with the first status report, so until that report settles it is being set up.
 */
export type ModelAccessState = "ready" | "setting-up" | "not-yet" | "failed";
export function modelAccessState(status: OfficeLinkStatus | null): ModelAccessState | null {
  if (status?.state !== "linked" || status.serviceWithdrawn) return null;
  if (status.provisioned === true) return "ready";
  if (status.error) return "failed";
  return status.lastReportedAt ? "not-yet" : "setting-up";
}
const MODEL_ACCESS: Record<ModelAccessState, string> = {
  ready: "Bud’s model access is set up.",
  "setting-up": "Setting up Bud’s model access…",
  "not-yet": "Bud’s model access has not arrived from your account yet. RealBud checks again with each status update.",
  failed: "Bud’s model access is not set up yet. Use Update status to try again.",
};

/** The sentences the live region announces for a phase. */
export function browserLinkMessage(phase: BrowserLinkPhase): string {
  switch (phase.kind) {
    case "waiting": case "cancelling": return `Approve this computer in your browser. The page shows code ${phase.request.displayCode}.`;
    case "declined": return "This computer was declined in your browser. Nothing was linked.";
    case "expired": return "The approval page expired before this computer was approved. Nothing was linked.";
    case "linked": return `Linked to ${phase.agencyLabel}.`;
    default: return "";
  }
}

function openApproval(url: string) {
  if (typeof window === "undefined") return;
  if (window.ogb?.openExternal) void window.ogb.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

const primary = "pm-decision inline-flex items-center rounded bg-agency px-4 text-[14px] font-medium text-white hover:bg-agency-hover disabled:opacity-40";
const secondary = "pm-control rounded border border-line px-3 py-2";
const field = "mt-1 block w-full rounded border border-line bg-paper px-3 py-2";

export interface WebsiteLinkCardViewProps {
  status: OfficeLinkStatus | null;
  phase: BrowserLinkPhase;
  label: string;
  code: string;
  busy: boolean;
  error: string;
  confirm: boolean;
  onLabel: (value: string) => void;
  onCode: (value: string) => void;
  onStart: () => void;
  onOpenAgain: (request: BrowserLinkRequest) => void;
  onCancel: (request: BrowserLinkRequest) => void;
  onRetry: (request: BrowserLinkRequest) => void;
  onLinkCode: () => void;
  onReport: () => void;
  onDisconnect: () => void;
  onConfirm: (open: boolean) => void;
  onRefresh: () => void;
}

export function WebsiteLinkCardView(props: WebsiteLinkCardViewProps) {
  const { status, phase, label, code, busy, error, confirm } = props;
  const linked = status?.state === "linked";
  const request = phase.kind === "waiting" || phase.kind === "cancelling" || (phase.kind === "unreachable" && phase.request) ? phase.request : null;
  const codePending = status?.state === "pending" && !status.browser;
  const problem = phase.kind === "unreachable" || phase.kind === "failed" ? phase.message : "";
  // The service also keeps its last failure; never show the same sentence twice.
  const failure = error || (status?.error !== problem ? status?.error : "");
  // Just linked in the browser: always name the office it joined, with a way out.
  const joined = phase.kind === "linked";
  // Access is a saved service fact, not a transient browser-approval phase.
  const access = modelAccessState(status);
  const message = browserLinkMessage(phase);
  const nameField = <label className="block">Computer name<input required maxLength={80} autoComplete="off" value={label} onChange={event => props.onLabel(event.target.value)} placeholder="Reception Mac" className={field} /></label>;
  return <Card title="Website account" subtitle="Link this computer with your RealBud account. Your account can then set up Bud’s model access and account connections here.">
    <div className="space-y-3 text-sm">
      <p className="text-ink-secondary">This link is separate from local office collaboration. Linking a computer does not join an office host or share work with colleagues.</p>
      <p className="text-ink-secondary">The website receives this computer’s name, app and Bud versions, readiness, and last check-in. Your conversations, documents, and connected-app keys stay here.</p>
      {status?.serviceWithdrawn ? <p role="status" className="rounded border border-line p-3">Service access was withdrawn; your records are kept. Everything saved on this computer stays readable and exportable. Ask service support to add this computer again to restore connected accounts and Bud’s model.</p> : null}
      {/* One polite live region, always in the page, announces every approval change. */}
      <p role="status" aria-live="polite" className="sr-only">{[message, access ? MODEL_ACCESS[access] : ""].filter(Boolean).join(" ")}</p>
      {message ? <p className={request || joined ? "font-medium text-ink" : "text-ink-secondary"}>{message}</p> : null}
      {request ? <p className="rounded border border-line bg-paper px-4 py-3 text-center" aria-hidden="true">
        <span className="block text-[12px] text-ink-muted">Code on this computer</span>
        <span className="block font-mono text-[22px] font-semibold tracking-[0.12em] text-ink">{request.displayCode}</span>
      </p> : null}
      {access ? <p className="text-ink-secondary" aria-busy={access === "setting-up" || undefined}>{MODEL_ACCESS[access]}</p> : null}
      {joined ? <>
        <button type="button" className={secondary} disabled={busy} onClick={props.onDisconnect}>Not your office? Disconnect</button>
      </> : null}
      {problem ? <p role="alert" className="text-danger">{problem}</p> : null}
      {linked ? <>
        <p><strong>{status.agencyLabel}</strong> · {status.label}</p>
        <p className="text-ink-muted">{status.lastReportedAt ? `Last reported ${new Date(status.lastReportedAt).toLocaleString()}` : "Linked. Send a status update to finish checking the connection."}</p>
        <div className="flex flex-wrap gap-3">
          <button className={secondary} disabled={busy} onClick={props.onReport}>{busy ? "Updating…" : "Update status"}</button>
          <button className={secondary} disabled={busy} onClick={() => props.onConfirm(true)}>Disconnect website</button>
        </div>
      </> : request ? <>
        {phase.kind === "waiting" ? <p className="text-ink-muted">Waiting…</p> : null}
        <div className="flex flex-wrap gap-3">
          {phase.kind === "unreachable"
            ? <button type="button" className={secondary} onClick={() => props.onRetry(request)}>Try again</button>
            : <button type="button" className={secondary} disabled={phase.kind === "cancelling"} onClick={() => props.onOpenAgain(request)}>Open the page again</button>}
          <button type="button" className={secondary} disabled={phase.kind === "cancelling"} aria-busy={phase.kind === "cancelling" || undefined} onClick={() => props.onCancel(request)}>{phase.kind === "cancelling" ? "Cancelling…" : "Cancel"}</button>
        </div>
      </> : phase.kind === "linked" ? null : <>
        {status?.state === "revoked" ? <p>This website link was revoked. Link again to reconnect.</p> : null}
        {codePending ? <div><p>Linking with a code was interrupted. Paste the same code to retry safely.</p><button type="button" disabled={busy} className="mt-1 underline" onClick={props.onDisconnect}>Cancel pending link</button></div> : <>
          {nameField}
          <button type="button" className={primary} disabled={!status || phase.kind === "starting" || !label.trim()} aria-busy={phase.kind === "starting" || undefined} onClick={props.onStart}>
            {phase.kind === "starting" ? "Opening your browser…" : phase.kind === "declined" || phase.kind === "expired" ? "Start again" : phase.kind === "unreachable" ? "Try again" : "Link with your RealBud account"}
          </button>
          <p className="text-ink-muted">Your browser opens your RealBud account. Check the code matches this screen, then approve this computer.</p>
        </>}
        <details open={codePending || undefined} className="rounded border border-line px-3 py-2">
          <summary className="pm-control flex cursor-pointer items-center">Have a link code instead?</summary>
          <form onSubmit={event => { event.preventDefault(); props.onLinkCode(); }} className="mt-2 space-y-3">
            <p>Open <a className="text-agency underline" href="https://realbud.app/account/installations" target="_blank" rel="noreferrer">Account → Computers</a>, create a link code, then paste it below.</p>
            {codePending ? nameField : null}
            <label className="block">Link code<input required autoComplete="off" spellCheck={false} value={code} onChange={event => props.onCode(event.target.value)} placeholder="rb1_…" className={`${field} font-mono`} /></label>
            <button disabled={busy || !status || !code.trim() || !label.trim()} className={secondary}>{busy ? "Linking…" : "Link this computer"}</button>
          </form>
        </details>
      </>}
      {confirm ? <div className="rounded border border-line p-3"><p>Disconnect this computer from the website and disable requests for its workspace? Your local work and subscription stay as they are. Preparation already running may still finish; check its saved outcome.</p><div className="mt-2 flex gap-3"><button className={secondary} disabled={busy} onClick={props.onDisconnect}>Disconnect</button><button className={secondary} disabled={busy} onClick={() => props.onConfirm(false)}>Keep linked</button></div></div> : null}
      {failure ? <p role="alert" className="text-danger">{failure} <button className="underline" onClick={props.onRefresh}>Refresh</button></p> : null}
      <p className="text-xs text-ink-muted">Linking also enables status reporting. To accept selected work requests, review the separate workspace permission below.</p>
    </div>
  </Card>;
}

export function WebsiteLinkCard() {
  const [status, setStatus] = useState<OfficeLinkStatus | null>(null);
  const [code, setCode] = useState(""); const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [phase, setPhase] = useState<BrowserLinkPhase>({ kind: "idle" });
  const polling = useRef<Promise<unknown> | null>(null);
  const changed = () => window.dispatchEvent(new Event("realbud-website-link-changed"));
  /** Reads the link; with `resume`, an approval the service saved (after a restart) is picked up again. */
  const refresh = async (resume = false) => {
    const next = await api("/api/office-link") as OfficeLinkStatus;
    setStatus(next);
    const saved = resume ? savedBrowserRequest(next) : null;
    if (saved) {
      setPhase({ kind: "waiting", request: saved });
      if (next.label) setLabel(current => current || next.label!);
    }
  };
  useEffect(() => { void refresh(true).catch(() => setError("Website link status could not be loaded. Try again.")); }, []);

  // Ask while this card is open and an approval is waiting: at once, then every interval.
  const waitingFor = phase.kind === "waiting" ? phase.request : null;
  useEffect(() => {
    if (!waitingFor) return;
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      const call = api("/api/office-link/browser-link", undefined, { timeoutMs: 30_000 });
      polling.current = call.catch(() => undefined);
      let next: BrowserLinkPhase;
      try {
        const view = readBrowserLinkView(await call);
        next = view ? phaseFor(view) : { kind: "unreachable", message: UNREADABLE, request: waitingFor };
      } catch (cause) {
        next = { kind: "unreachable", message: cause instanceof Error ? cause.message : UNREADABLE, request: waitingFor };
      } finally { polling.current = null; }
      if (!alive) return;
      if (next.kind === "waiting") { timer = window.setTimeout(() => void tick(), LINK_POLL_INTERVAL_MS); return; }
      setPhase(next);
      if (next.kind !== "unreachable") { void refresh().catch(() => {}); changed(); }
    };
    void tick();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [waitingFor]);

  // Just linked: re-read the link until the first report settles model access.
  const settingUp = phase.kind === "linked" && modelAccessState(status) === "setting-up";
  useEffect(() => {
    if (!settingUp) return;
    const timer = window.setTimeout(() => void refresh().catch(() => {}), LINK_POLL_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [settingUp, status]);

  const start = async () => {
    setPhase({ kind: "starting" }); setError("");
    try {
      const view = readBrowserLinkView(await api("/api/office-link/browser-link", { method: "POST", body: JSON.stringify({ label }) }, { timeoutMs: 20_000 }));
      if (view?.state !== "pending") throw new Error(UNREADABLE);
      openApproval(view.approvalUrl);
      setPhase(phaseFor(view));
      void refresh().catch(() => {});
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : UNREADABLE;
      setPhase((cause as { code?: string })?.code === "website_unreachable" ? { kind: "unreachable", message } : { kind: "failed", message });
      // A lost answer may still have saved a request: pick it up instead of starting a second one.
      void refresh(true).catch(() => {});
    }
  };
  const cancel = async (waiting: BrowserLinkRequest) => {
    setPhase({ kind: "cancelling", request: waiting }); setError("");
    // A status check already in flight finishes first, so the two never race.
    await polling.current;
    try {
      const view = readBrowserLinkView(await api("/api/office-link/browser-link", { method: "DELETE", body: "{}" }, { timeoutMs: 20_000 }));
      setPhase(view?.state === "linked" ? phaseFor(view) : { kind: "idle" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The approval could not be cancelled. Try again.");
      setPhase({ kind: "waiting", request: waiting });
    } finally { void refresh().catch(() => {}); changed(); }
  };
  const act = async (action: "link" | "report" | "disconnect") => {
    setBusy(true); setError("");
    try {
      await api(`/api/office-link${action === "report" ? "/report" : ""}`, { method: action === "disconnect" ? "DELETE" : "POST", body: action === "link" ? JSON.stringify({ code, label }) : "{}" }, { timeoutMs: 20_000 });
      if (action !== "report") { setCode(""); setPhase({ kind: "idle" }); }
      setConfirm(false); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "The website link could not be updated."); }
    finally { setBusy(false); changed(); }
  };

  return <WebsiteLinkCardView status={status} phase={phase} label={label} code={code} busy={busy} error={error} confirm={confirm}
    onLabel={setLabel} onCode={setCode} onStart={() => void start()} onOpenAgain={item => openApproval(item.approvalUrl)}
    onCancel={item => void cancel(item)} onRetry={item => { setError(""); setPhase({ kind: "waiting", request: item }); }}
    onLinkCode={() => void act("link")} onReport={() => void act("report")} onDisconnect={() => void act("disconnect")}
    onConfirm={setConfirm} onRefresh={() => { setError(""); void refresh().catch(() => setError("Status could not be loaded.")); }} />;
}
