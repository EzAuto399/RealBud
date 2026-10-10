import { useState } from "react";
import { Check, ExternalLink, Loader2 } from "lucide-react";
import { useStore } from "@/state/store";
import type { BrowserLinkRequest, OfficeLinkStatus } from "../../server/office-link";
import {
  approvalTimeLeft, asksToRemoveComputer, browserLinkMessage, computerLimitReached, defaultComputerName, linkedOffice, modelAccessMessage, modelAccessState,
  officeLinkRecoveryMessage, openApproval, pendingRequest, useBrowserLink, APPROVAL_PAGE_EXPIRED, type BrowserLinkPhase,
} from "./you/browser-link";
import { useApprovalClock } from "./BrowserApprovalCard";
import { OwnerRequestButton } from "./OwnerRequestButton";

const primary = "pm-decision flex w-full items-center justify-center gap-2 rounded bg-agency px-4 text-[14px] font-medium text-white transition-transform hover:bg-agency-hover active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none";
const secondary = "pm-control inline-flex items-center justify-center gap-1.5 rounded border border-line bg-sheet px-3 text-[13px] text-ink hover:bg-raised/60 disabled:opacity-40";
const quiet = "pm-control inline-flex items-center gap-1.5 rounded px-1 text-[13px] text-ink-secondary underline-offset-2 hover:text-ink hover:underline disabled:opacity-40";
const field = "pm-control mt-1 block w-full rounded border border-line bg-paper px-3 font-mono text-[13px] text-ink";

export interface ConnectOfficeViewProps {
  status: OfficeLinkStatus | null;
  phase: BrowserLinkPhase;
  error: string;
  code: string;
  /** A pasted code is being redeemed. */
  codeBusy: boolean;
  onStart: () => void;
  onOpenAgain: (request: BrowserLinkRequest) => void;
  onCancel: (request: BrowserLinkRequest) => void;
  onRetry: (request: BrowserLinkRequest) => void;
  onCode: (value: string) => void;
  onLinkCode: () => void;
  /** Read the saved link again after it could not be loaded. */
  onRefresh: () => void;
  /** Fixed clock for tests; live, the time left ticks every second. */
  now?: number;
  /** The surrounding screen already says this computer was disconnected. */
  revokedShown?: boolean;
}

/**
 * Connect this computer to the office's RealBud account: the pasted link code
 * is the one primary action, with a quiet owner option that approves in the
 * browser and shows the matching code while it waits. Linked, it names the
 * office and stops asking.
 */
export function ConnectOfficeView(props: ConnectOfficeViewProps) {
  const { status, phase, error, code, codeBusy } = props;
  const office = linkedOffice(status, phase);
  const request = pendingRequest(phase);
  const codePending = status?.state === "pending" && !status.browser;
  const problem = phase.kind === "unreachable" || phase.kind === "failed" ? phase.message : "";
  const expiresAt = request ? Date.parse(request.expiresAt) : null;
  const now = useApprovalClock(expiresAt, props.now);
  // The page expired while this computer waited: say so and start again here.
  const lapsed = request !== null && expiresAt !== null && now >= expiresAt && phase.kind !== "cancelling";
  // Declined or expired is said once, in its own alert below; the live region doesn't repeat it.
  const ended = phase.kind === "declined" || phase.kind === "expired";
  const announce = office ? `Connected to ${office}.` : lapsed || ended ? "" : browserLinkMessage(phase);
  const access = office ? modelAccessMessage(status, { passive: true }) : null;
  const recovery = officeLinkRecoveryMessage(status);
  const failure = error || (office ? recovery !== access ? recovery : "" : status?.error !== problem ? status?.error : "");

  return <div className="space-y-3 text-[13.5px] text-ink" data-connect-office="">
    <p role="status" aria-live="polite" className="sr-only">{[announce, access ?? ""].filter(Boolean).join(" ")}</p>
    {office ? <div className="flex items-start gap-3 rounded border border-agency/25 bg-selected/60 px-3 py-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-agency text-white" aria-hidden="true"><Check size={15} /></span>
      <div>
        <p className="font-medium">Connected to {office}</p>
        {access ? <p className="mt-0.5 text-[12.5px] text-ink-secondary" aria-busy={modelAccessState(status) === "setting-up" || undefined}>{access}</p> : null}
        {asksToRemoveComputer(access) ? <div className="mt-2"><OwnerRequestButton request="removeComputer" /></div> : null}
      </div>
    </div> : request ? <>
      <p className="font-medium">Your browser opened realbud.app. Sign in with the email RealBud invited, check the page shows code {request.displayCode}, then approve.</p>
      <p className="rounded border border-line bg-paper px-4 py-3 text-center" aria-hidden="true">
        <span className="block text-[12px] text-ink-muted">Code on this computer</span>
        <span className="block font-mono text-[22px] font-semibold tracking-[0.12em] text-ink tabular-nums">{request.displayCode}</span>
      </p>
      {lapsed ? <p role="alert" className="text-danger">{APPROVAL_PAGE_EXPIRED}</p>
        : phase.kind === "waiting" ? <p className="flex items-center gap-2 text-ink-muted"><Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />Waiting for your approval… <span className="tabular-nums">{approvalTimeLeft(request, now)}</span></p> : null}
      {problem ? <p role="alert" className="text-danger">{problem}</p> : null}
      <div className="flex flex-wrap gap-2">
        {lapsed ? <button type="button" className={secondary} onClick={props.onStart}>Start a new request</button>
          : phase.kind === "unreachable"
          ? <button type="button" className={secondary} onClick={() => props.onRetry(request)}>Try again</button>
          : <button type="button" className={secondary} disabled={phase.kind === "cancelling"} onClick={() => props.onOpenAgain(request)}><ExternalLink size={14} aria-hidden="true" />Open the page again</button>}
        <button type="button" className={secondary} disabled={phase.kind === "cancelling"} aria-busy={phase.kind === "cancelling" || undefined} onClick={() => props.onCancel(request)}>{phase.kind === "cancelling" ? "Cancelling…" : "Cancel"}</button>
      </div>
    </> : <>
      {ended ? <p role="alert">{browserLinkMessage(phase)}</p> : null}
      {status?.state === "revoked" && !props.revokedShown ? <p>This computer was removed from your office. Connect it again to continue.</p> : null}
      {problem ? <p role="alert" className="text-danger">{problem}</p> : null}
      {codePending ? <p>Connecting with a code was interrupted. Paste the same code below to finish safely.</p> : null}
      {/* The link code is the day-one path for office staff; browser approval stays available for owners. */}
      <form className="space-y-2" onSubmit={event => { event.preventDefault(); props.onLinkCode(); }}>
        <label className="block text-ink">Link code<input required title="" autoComplete="off" spellCheck={false} value={code} onChange={event => props.onCode(event.target.value)} placeholder="Paste the code here" className={field} /></label>
        <button type="submit" className={primary} disabled={codeBusy || !status || !code.trim()} aria-busy={codeBusy || undefined}>{codeBusy ? "Connecting… this can take up to a minute." : "Connect with this code"}</button>
      </form>
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-muted">
        {computerLimitReached(failure) ? <OwnerRequestButton request="freePlace" /> : <><span>No code yet?</span><OwnerRequestButton request="linkCode" /></>}
      </div>
      {codePending ? null : <div className="border-t border-line pt-2 text-[12.5px] text-ink-muted">
        <button type="button" className={quiet} disabled={!status || phase.kind === "starting"} aria-busy={phase.kind === "starting" || undefined} onClick={props.onStart}>
          {phase.kind === "starting" ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ExternalLink size={14} aria-hidden="true" />}
          {ended ? "Start a new request" : "I’m the office owner: approve in my browser"}
        </button>
        <p>{phase.kind === "starting" ? "Opening your browser…" : "Owners: realbud.app → Computers → Pair a new computer."}</p>
      </div>}
    </>}
    {failure ? <p role="alert" className="text-danger">{failure}{!status ? <> <button type="button" className="pm-control underline underline-offset-2" onClick={props.onRefresh}>Try again</button></> : null}</p> : null}
  </div>;
}

/** The connect flow wired to the local service, named after the person on this computer. */
export function useConnectOffice(personName?: string) {
  const link = useBrowserLink();
  const [code, setCode] = useState("");
  const [codeBusy, setCodeBusy] = useState(false);
  const label = link.status?.label || defaultComputerName(personName);
  const linkWithCode = async () => {
    if (codeBusy) return;
    setCodeBusy(true); link.setError("");
    try { await link.linkCode(code.trim(), label); setCode(""); }
    catch (cause) { link.setError(cause instanceof Error ? cause.message : "This computer could not be connected. Try again."); }
    finally { setCodeBusy(false); }
  };
  const view: ConnectOfficeViewProps = {
    status: link.status, phase: link.phase, error: link.error, code, codeBusy,
    onStart: () => void link.start(label), onOpenAgain: item => openApproval(item.approvalUrl),
    onCancel: item => void link.cancel(item), onRetry: link.retry, onCode: setCode, onLinkCode: () => void linkWithCode(),
    onRefresh: () => { link.setError(""); void link.refresh(true).catch(() => link.setError("Website link status could not be loaded. Try again.")); },
  };
  return { ...link, office: linkedOffice(link.status, link.phase), view };
}

/** Inline connect for Bud setup when this computer is not yet connected. */
export function ConnectOffice() {
  const { state } = useStore();
  // Optional: a status-only surface may render before the store hydrates.
  const { view } = useConnectOffice(state?.config?.profile?.name);
  return <ConnectOfficeView {...view} />;
}
