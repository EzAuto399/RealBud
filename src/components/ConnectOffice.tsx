import { useState } from "react";
import { Check, ChevronRight, ExternalLink, Loader2 } from "lucide-react";
import { useStore } from "@/state/store";
import type { BrowserLinkRequest, OfficeLinkStatus } from "../../server/office-link";
import {
  browserLinkMessage, defaultComputerName, linkedOffice, modelAccessMessage, modelAccessState, officeLinkRecoveryMessage, openApproval, pendingRequest,
  useBrowserLink, type BrowserLinkPhase,
} from "./you/browser-link";

const primary = "pm-decision flex w-full items-center justify-center gap-2 rounded bg-agency px-4 text-[14px] font-medium text-white transition-transform hover:bg-agency-hover active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none";
const secondary = "pm-control inline-flex items-center justify-center gap-1.5 rounded border border-line bg-sheet px-3 text-[13px] text-ink hover:bg-raised/60 disabled:opacity-40";
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
}

/**
 * Connect this computer to the office's RealBud account: one primary action
 * that opens realbud.app, the matching code while it waits, and a quiet
 * pasted-code fallback. Linked, it names the office and stops asking.
 */
export function ConnectOfficeView(props: ConnectOfficeViewProps) {
  const { status, phase, error, code, codeBusy } = props;
  const office = linkedOffice(status, phase);
  const request = pendingRequest(phase);
  const codePending = status?.state === "pending" && !status.browser;
  const problem = phase.kind === "unreachable" || phase.kind === "failed" ? phase.message : "";
  const announce = office ? `Connected to ${office}.` : browserLinkMessage(phase);
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
      </div>
    </div> : request ? <>
      <p className="font-medium">Your browser opened realbud.app. Sign in with the email RealBud invited, check the page shows code {request.displayCode}, then approve.</p>
      <p className="rounded border border-line bg-paper px-4 py-3 text-center" aria-hidden="true">
        <span className="block text-[12px] text-ink-muted">Code on this computer</span>
        <span className="block font-mono text-[22px] font-semibold tracking-[0.12em] text-ink tabular-nums">{request.displayCode}</span>
      </p>
      {phase.kind === "waiting" ? <p className="flex items-center gap-2 text-ink-muted"><Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />Waiting for your approval…</p> : null}
      {problem ? <p role="alert" className="text-danger">{problem}</p> : null}
      <div className="flex flex-wrap gap-2">
        {phase.kind === "unreachable"
          ? <button type="button" className={secondary} onClick={() => props.onRetry(request)}>Try again</button>
          : <button type="button" className={secondary} disabled={phase.kind === "cancelling"} onClick={() => props.onOpenAgain(request)}><ExternalLink size={14} aria-hidden="true" />Open the page again</button>}
        <button type="button" className={secondary} disabled={phase.kind === "cancelling"} aria-busy={phase.kind === "cancelling" || undefined} onClick={() => props.onCancel(request)}>{phase.kind === "cancelling" ? "Cancelling…" : "Cancel"}</button>
      </div>
    </> : <>
      {phase.kind === "declined" || phase.kind === "expired" ? <p>{browserLinkMessage(phase)}</p> : null}
      {status?.state === "revoked" ? <p>This computer was removed from your office. Connect it again to continue.</p> : null}
      {problem ? <p role="alert" className="text-danger">{problem}</p> : null}
      {codePending ? <p>Connecting with a code was interrupted. Paste the same code below to finish safely.</p> : <>
        {/* A pasted code makes its own button the one to press (Windows issues log #37). */}
        <button type="button" className={code.trim() ? secondary : primary} disabled={!status || phase.kind === "starting"} aria-busy={phase.kind === "starting" || undefined} onClick={props.onStart}>
          {phase.kind === "starting" ? <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ExternalLink size={15} aria-hidden="true" />}
          Connect to your office
        </button>
        <p className="text-[12.5px] leading-relaxed text-ink-muted">{phase.kind === "starting" ? "Opening your browser…" : "Your browser opens realbud.app. Sign in with the email RealBud invited, check the code matches this screen, then approve."}</p>
      </>}
      <details open={codePending || undefined} className="group text-[12.5px] text-ink-secondary">
        <summary className="pm-control flex cursor-pointer list-none items-center gap-1 hover:text-ink"><ChevronRight size={14} aria-hidden="true" className="transition-transform group-open:rotate-90 motion-reduce:transition-none" />Use a link code instead</summary>
        <form className="mt-1 space-y-2" onSubmit={event => { event.preventDefault(); props.onLinkCode(); }}>
          <p>On realbud.app, open Account → Computers, create a link code, then paste it here.</p>
          <label className="block text-ink">Link code<input required autoComplete="off" spellCheck={false} value={code} onChange={event => props.onCode(event.target.value)} placeholder="rb1_…" className={field} /></label>
          <button type="submit" className={code.trim() ? primary : secondary} disabled={codeBusy || !status || !code.trim()} aria-busy={codeBusy || undefined}>{codeBusy ? "Connecting… this can take up to a minute." : "Connect with this code"}</button>
        </form>
      </details>
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
