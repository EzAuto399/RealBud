import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { SettingsCard } from "./SettingsCard";
import type { BrowserLinkRequest, OfficeLinkStatus } from "../../../server/office-link";
import {
  approvalTimeLeft, asksToRemoveComputer, browserLinkMessage, computerLimitReached, modelAccessMessage, modelAccessState, openApproval, pendingRequest, useBrowserLink,
  APPROVAL_PAGE_EXPIRED, type BrowserLinkPhase,
} from "./browser-link";
import { useApprovalClock } from "../BrowserApprovalCard";
import { OwnerRequestButton } from "../OwnerRequestButton";
import { noteLinkAttempt } from "@/lib/use-setup-state";
import type { LinkAttempt } from "@/lib/setup-sequence";

// The protocol lives in ./browser-link; these re-exports keep existing imports working.
export { browserLinkMessage, modelAccessMessage, modelAccessState, readBrowserLinkView, savedBrowserRequest } from "./browser-link";
export type { BrowserLinkPhase, ModelAccessState } from "./browser-link";

const primary = "pm-decision inline-flex items-center rounded bg-agency px-4 text-[14px] font-medium text-white hover:bg-agency-hover disabled:opacity-40";
const secondary = "pm-control rounded border border-line px-3 py-2";
const field = "mt-1 block w-full rounded border border-line bg-paper px-3 py-2";

export interface WebsiteLinkCardViewProps {
  status: OfficeLinkStatus | null;
  phase: BrowserLinkPhase;
  label: string;
  code: string;
  busy: boolean;
  /** Which request `busy` is waiting on. Linking and updating wait on the
   * account's provisioning chain, so each says how long that can take. */
  action?: "link" | "report" | "disconnect";
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
  /** Fixed clock for tests; live, the time left ticks every second. */
  now?: number;
}

/** Get started's "Enter link code" lands here (src/lib/you-navigation.ts opens the disclosure). */
export const LINK_CODE_FIELD_ID = "you-website-code";

export function WebsiteLinkCardView(props: WebsiteLinkCardViewProps) {
  const { status, phase, label, code, busy, action, error, confirm } = props;
  const linked = status?.state === "linked";
  const request = pendingRequest(phase);
  const codePending = status?.state === "pending" && !status.browser;
  const problem = phase.kind === "unreachable" || phase.kind === "failed" ? phase.message : "";
  // The service also keeps its last failure; never show the same sentence twice.
  // An inactive office is explained by its own notice, not as a red failure.
  const failure = error || (status?.error !== problem && !(linked && status?.officeInactive) ? status?.error : "");
  // Just linked in the browser: always name the office it joined, with a way out.
  const joined = phase.kind === "linked";
  // Access is a saved service fact, not a transient browser-approval phase.
  const access = modelAccessState(status);
  const accessMessage = modelAccessMessage(status);
  const message = browserLinkMessage(phase);
  const expiresAt = request ? Date.parse(request.expiresAt) : null;
  const now = useApprovalClock(expiresAt, props.now);
  // The page expired while this computer waited: say so and start again here.
  const lapsed = request !== null && expiresAt !== null && now >= expiresAt && phase.kind !== "cancelling";
  // The office stopped accepting this computer (or withdrew its service).
  // Relinking is the way back, so the card leads with it.
  const ended = !linked && !request && !joined && (status?.state === "revoked" || status?.serviceWithdrawn === true);
  const endedOn = status?.revokedAt && !Number.isNaN(Date.parse(status.revokedAt)) ? ` on ${new Date(status.revokedAt).toLocaleDateString(undefined, { day: "numeric", month: "long" })}` : "";
  // Redeem and the first report wait on the account's provisioning chain
  // (health, readiness, then the vendor mint): say so rather than sit still.
  const waiting = action === "link" ? "Linking… this can take up to a minute." : action === "report" ? "Updating… this can take up to a minute." : "";
  const nameField = <label className="block">Computer name<input required maxLength={80} autoComplete="off" value={label} onChange={event => props.onLabel(event.target.value)} placeholder="Reception Mac" className={field} /></label>;
  const pill = !status ? null : linked ? { tone: "agency" as const, label: "Linked" } : request || status.state === "pending" ? { tone: "hold" as const, label: "Waiting for approval" } : status.state === "revoked" ? { tone: "hold" as const, label: "Link revoked" } : { tone: "muted" as const, label: "Not linked" };
  return <SettingsCard title="Website account" status={pill} details={<>
    <p>Link this computer with your RealBud account. Your account can then set up Bud’s model access and account connections here.</p>
    <p>This link is separate from local office collaboration. Linking a computer does not join an office host or share work with colleagues.</p>
    <p>The website receives this computer’s name, app and Bud versions, readiness, and last check-in. Your conversations, documents, and connected-app keys stay here.</p>
    <p>Linking also enables status reporting. Review workspace access settings before accepting selected work requests.</p>
  </>}>
    <div className="space-y-3 text-sm">
      {ended ? <div role="status" className="rounded border border-hold/30 bg-hold/10 p-3">
        <p className="font-medium text-ink">This computer was disconnected from {status?.agencyLabel || "your office"}{endedOn}.</p>
        <p className="mt-1 text-ink-secondary">Everything saved here is kept. Reconnect to bring back Bud and your connected accounts. Your office owner approves it on realbud.app.</p>
      </div> : linked && status?.officeInactive ? <div role="status" className="rounded border border-hold/30 bg-hold/10 p-3">
        <p className="font-medium text-ink">{status.agencyLabel || "Your office"}’s RealBud account is inactive.</p>
        <p className="mt-1 text-ink-secondary">This computer can’t check in until the office owner reactivates the account on <a className="text-agency underline" href="https://realbud.app/account" target="_blank" rel="noreferrer">realbud.app</a>. Nothing was removed, and it reconnects by itself once the account is active.</p>
      </div> : status?.serviceWithdrawn && linked ? <p role="status" className="rounded border border-line p-3">Your office stopped Bud’s access for this computer. Everything saved here is kept. Ask your office owner to restore it on realbud.app.</p> : null}
      {/* One polite live region, always in the page, announces every approval change. */}
      <p role="status" aria-live="polite" className="sr-only">{[message, accessMessage ?? "", waiting].filter(Boolean).join(" ")}</p>
      {message ? <p className={request || joined ? "font-medium text-ink" : "text-ink-secondary"}>{message}</p> : null}
      {request ? <p className="rounded border border-line bg-paper px-4 py-3 text-center" aria-hidden="true">
        <span className="block text-[12px] text-ink-muted">Code on this computer</span>
        <span className="block font-mono text-[22px] font-semibold tracking-[0.12em] text-ink">{request.displayCode}</span>
      </p> : null}
      {accessMessage ? <p className="text-ink-secondary" aria-busy={access === "setting-up" || undefined}>{accessMessage}</p> : null}
      {asksToRemoveComputer(accessMessage) ? <OwnerRequestButton request="removeComputer" /> : null}
      {waiting ? <p className="text-ink-secondary" aria-busy="true">{waiting}</p> : null}
      {joined ? <>
        <button type="button" className={secondary} disabled={busy} onClick={props.onDisconnect}>Not your office? Disconnect</button>
      </> : null}
      {problem ? <p role="alert" className="text-danger">{problem}</p> : null}
      {linked ? <>
        <p><strong>{status.agencyLabel}</strong> · {status.label}</p>
        <p className="text-ink-muted">{status.lastReportedAt ? `Last reported ${new Date(status.lastReportedAt).toLocaleString()}` : "Linked. Send a status update to finish checking the connection."}</p>
        <p><a className="text-agency underline underline-offset-2" href="https://realbud.app/account" target="_blank" rel="noreferrer">Billing and linked computers on realbud.app</a></p>
        <div className="flex flex-wrap gap-3">
          <button className={secondary} disabled={busy} onClick={props.onReport}>{busy ? "Updating…" : "Update status"}</button>
          <button className={secondary} disabled={busy} onClick={() => props.onConfirm(true)}>Disconnect website</button>
        </div>
      </> : request ? <>
        {lapsed ? <p role="alert" className="text-danger">{APPROVAL_PAGE_EXPIRED}</p>
          : phase.kind === "waiting" ? <p className="text-ink-muted">Waiting for approval · <span className="tabular-nums">{approvalTimeLeft(request, now)}</span></p> : null}
        <div className="flex flex-wrap gap-3">
          {lapsed ? <button type="button" className={secondary} disabled={!label.trim()} onClick={props.onStart}>Start a new request</button>
            : phase.kind === "unreachable"
            ? <button type="button" className={secondary} onClick={() => props.onRetry(request)}>Try again</button>
            : <button type="button" className={secondary} disabled={phase.kind === "cancelling"} onClick={() => props.onOpenAgain(request)}>Open the page again</button>}
          <button type="button" className={secondary} disabled={phase.kind === "cancelling"} aria-busy={phase.kind === "cancelling" || undefined} onClick={() => props.onCancel(request)}>{phase.kind === "cancelling" ? "Cancelling…" : "Cancel"}</button>
        </div>
      </> : phase.kind === "linked" ? null : <>
        {codePending ? <div><p>Linking with a code was interrupted. Paste the same code to retry safely.</p><button type="button" disabled={busy} className="mt-1 underline" onClick={props.onDisconnect}>Cancel pending link</button></div> : <>
          {nameField}
          <button type="button" className={primary} disabled={!status || phase.kind === "starting" || !label.trim()} aria-busy={phase.kind === "starting" || undefined} onClick={props.onStart}>
            {phase.kind === "starting" ? "Opening your browser…" : phase.kind === "declined" || phase.kind === "expired" ? "Start a new request" : phase.kind === "unreachable" ? "Try again" : ended ? "Reconnect this computer" : "Link with your RealBud account"}
          </button>
          <p className="text-ink-muted">Your browser opens your RealBud account. Check the code matches this screen, then approve this computer.{ended ? <> Not expecting the disconnect? Your office owner can check <a className="text-agency underline" href="https://realbud.app/account/installations" target="_blank" rel="noreferrer">Account → Computers</a>.</> : null}</p>
        </>}
        <details open={codePending || undefined} className="rounded border border-line px-3 py-2">
          <summary className="pm-control flex cursor-pointer items-center">Have a link code instead?</summary>
          <form onSubmit={event => { event.preventDefault(); props.onLinkCode(); }} className="mt-2 space-y-3">
            <p>Open <a className="text-agency underline" href="https://realbud.app/account/installations" target="_blank" rel="noreferrer">Account → Computers</a>, create a link code, then paste it below.</p>
            {codePending ? nameField : null}
            <label className="block">Link code<input id={LINK_CODE_FIELD_ID} required autoComplete="off" spellCheck={false} value={code} onChange={event => props.onCode(event.target.value)} placeholder="rb1_…" className={`${field} font-mono`} /></label>
            <button disabled={busy || !status || !code.trim() || !label.trim()} className={secondary}>{busy ? "Linking…" : "Link this computer"}</button>
            <div className="flex flex-wrap items-center gap-2 text-ink-muted">
              {computerLimitReached(failure) ? <OwnerRequestButton request="freePlace" /> : <><span>No code yet?</span><OwnerRequestButton request="linkCode" /></>}
            </div>
          </form>
        </details>
      </>}
      {confirm ? <div className="rounded border border-line p-3"><p>Disconnect this computer from the website and disable requests for its workspace? Your local work and subscription stay as they are. Preparation already running may still finish; check its saved outcome.</p><div className="mt-2 flex gap-3"><button className={secondary} disabled={busy} onClick={props.onDisconnect}>Disconnect</button><button className={secondary} disabled={busy} onClick={() => props.onConfirm(false)}>Keep linked</button></div></div> : null}
      {failure ? <p role="alert" className="text-danger">{failure} <button className="underline" onClick={props.onRefresh}>Refresh</button></p> : null}
    </div>
  </SettingsCard>;
}

/** A pasted code the website refused (409 from server/office-link.ts), in its own words; setup's link step shows it. */
export function refusedLinkAttempt(cause: unknown): LinkAttempt | null {
  const code = (cause as { code?: unknown } | null)?.code;
  return cause instanceof Error && (code === "installation_limit" || code === "link_code_refused") ? { outcome: code, message: cause.message } : null;
}

export function WebsiteLinkCard() {
  const link = useBrowserLink();
  const { status, phase, error, setError } = link;
  // Setup's link step says what the last attempt here came to; a new request clears it.
  useEffect(() => {
    if (phase.kind === "expired" || phase.kind === "declined") noteLinkAttempt({ outcome: phase.kind });
    else if (phase.kind === "starting") noteLinkAttempt(null);
  }, [phase.kind]);
  const [code, setCode] = useState(""); const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<WebsiteLinkCardViewProps["action"]>(undefined);
  const [confirm, setConfirm] = useState(false);
  // A resumed approval or a reconnect keeps the computer's earlier name.
  const resumedLabel = (status?.state === "pending" && status.browser) || status?.state === "revoked" ? status.label : undefined;
  useEffect(() => { if (resumedLabel) setLabel(current => current || resumedLabel); }, [resumedLabel]);

  const act = async (action: "link" | "report" | "disconnect") => {
    setBusy(true); setAction(action); setError("");
    try {
      if (action === "link") {
        try { await link.linkCode(code, label); } catch (cause) {
          const refused = refusedLinkAttempt(cause);
          if (refused) noteLinkAttempt(refused);
          throw cause;
        }
        noteLinkAttempt(null);
        setCode("");
      }
      else {
        // The service waits up to 60 s on the website to report, so this budget
        // sits above its own or a slow account would read as a local outage.
        await api(`/api/office-link${action === "report" ? "/report" : ""}`, { method: action === "disconnect" ? "DELETE" : "POST", body: "{}" }, { timeoutMs: action === "report" ? 70_000 : 20_000 });
        if (action === "disconnect") { setCode(""); link.setPhase({ kind: "idle" }); }
        await link.refresh();
      }
      setConfirm(false);
    } catch (e) { setError(e instanceof Error ? e.message : "The website link could not be updated."); }
    finally { setBusy(false); setAction(undefined); link.changed(); }
  };

  return <WebsiteLinkCardView status={status} phase={phase} label={label} code={code} busy={busy} action={action} error={error} confirm={confirm}
    onLabel={setLabel} onCode={setCode} onStart={() => void link.start(label)} onOpenAgain={item => openApproval(item.approvalUrl)}
    onCancel={item => void link.cancel(item)} onRetry={link.retry}
    onLinkCode={() => void act("link")} onReport={() => void act("report")} onDisconnect={() => void act("disconnect")}
    onConfirm={setConfirm} onRefresh={() => { setError(""); void link.refresh().catch(() => setError("Status could not be loaded.")); }} />;
}
