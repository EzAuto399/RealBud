import { useCopyText } from "@/lib/use-copy-text";
import { useEffect, useId, useState, type ReactNode, type Ref } from "react";
import { Check, ChevronLeft, ChevronRight, Copy, Pencil, Repeat2, Send, TextQuote } from "lucide-react";
import { fmtDateTime } from "@/lib/au";
import { channelMessage } from "@/lib/channel-message";
import { formatTime } from "@/state/store";
import { MausAvatar } from "./Avatar";
import { ChannelMark } from "./ChannelMark";

/** The channel stamp is presentation metadata; saved history stays untouched. */
export function AskMessage({ text, at, user, children, onEdit, onMakeRepeatable, onSendToPhone, onSendSummary, phoneHandoffBusy, versions, editButtonRef, versionsRef }: {
  text: string;
  at: number;
  user: boolean;
  children: ReactNode;
  onEdit?: () => void;
  editButtonRef?: Ref<HTMLButtonElement>;
  versionsRef?: Ref<HTMLElement>;
  onMakeRepeatable?: () => void;
  /** Send this reply to the paired phone channel. Absent when no phone is paired. */
  onSendToPhone?: () => void;
  onSendSummary?: () => void;
  phoneHandoffBusy?: boolean;
  versions?: { current: number; total: number; onPrevious?: () => void; onNext?: () => void };
}) {
  const origin = user ? channelMessage(text) : null;
  const body = origin?.body ?? text;
  const bodyId = useId();
  const [expanded, setExpanded] = useState(false);
  const { state: copyState, copy } = useCopyText(body);
  useEffect(() => { if (copyState === "failed") setExpanded(true); }, [copyState]);
  const longRequest = user && (body.length > 600 || body.split("\n").length > 8);
  const hasDate = Number.isFinite(new Date(at).getTime());
  return (
    <article className={user ? "ask-message ask-request" : "ask-message ask-answer"} aria-label={origin ? `${origin.sender} · ${origin.channel}` : user ? "Your request" : "Bud’s response"}>
      <header className="ask-message-heading">
        {!user && <MausAvatar color="green" state="idle" size={24} trackPointer={false} />}
        {origin && <ChannelMark channel={origin.channel} />}
        <div className="ask-message-identity">
          <span className="ask-message-author">{origin ? <bdi>{origin.sender}</bdi> : user ? "You" : "Bud"}</span>
          {origin && <span className="ask-message-channel">via {origin.channel}</span>}
        </div>
        <time dateTime={hasDate ? new Date(at).toISOString() : undefined} title={hasDate ? fmtDateTime(at) : undefined}>{hasDate ? formatTime(at) : "Time unavailable"}</time>
      </header>
      <div className={user ? "ask-request-body" : "ask-answer-body"}>
        {user ? <>
          <div id={bodyId} className={longRequest && !expanded ? "ask-request-collapsed" : undefined}>{body.trim() ? body : <span className="ask-message-empty">No message text was saved.</span>}</div>
          {longRequest && <button type="button" className="ask-text-button mt-2" aria-controls={bodyId} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : "Read full request"}</button>}
        </> : children}
      </div>
      <footer className="ask-message-actions">
        {body.trim() && <button type="button" className="ask-text-button" onClick={() => void copy()} disabled={copyState === "copying"} aria-label={copyState === "failed" ? "Try copying again" : user ? "Copy request" : "Copy response"}>
          {copyState === "copied" ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
          {copyState === "copied" ? "Copied" : copyState === "copying" ? "Copying…" : copyState === "failed" ? "Try again" : "Copy"}
        </button>}
        {user && onEdit && body.trim() && <button ref={editButtonRef} type="button" onClick={onEdit} className="ask-text-button"><Pencil size={14} aria-hidden />Edit & resend</button>}
        {onMakeRepeatable && <button type="button" className="ask-text-button ask-repeat-action" onClick={onMakeRepeatable} title="Carry this request and result into an editable job plan"><Repeat2 size={15} aria-hidden />Make this repeatable</button>}
        {onSendToPhone && <button type="button" className="ask-button min-h-8 px-3 text-[12px]" disabled={phoneHandoffBusy} aria-busy={phoneHandoffBusy || undefined} onClick={onSendToPhone} title="Send this reply to your phone"><Send size={14} aria-hidden />{phoneHandoffBusy ? "Sending…" : "Send to phone"}</button>}
        {onSendSummary && <button type="button" className="ask-text-button" disabled={phoneHandoffBusy} aria-busy={phoneHandoffBusy || undefined} onClick={onSendSummary} title="Send a short summary to your phone"><TextQuote size={14} aria-hidden />{phoneHandoffBusy ? "Sending…" : "Send summary"}</button>}
        {versions && versions.total > 1 && <nav ref={versionsRef} tabIndex={-1} className="ask-message-versions" aria-label={`Request versions, ${versions.current} of ${versions.total}`}>
          <button type="button" className="ask-text-button" aria-label="Previous request version" disabled={!versions.onPrevious} onClick={versions.onPrevious}><ChevronLeft size={16} aria-hidden /></button>
          <span aria-live="polite">{versions.current} of {versions.total}</span>
          <button type="button" className="ask-text-button" aria-label="Next request version" disabled={!versions.onNext} onClick={versions.onNext}><ChevronRight size={16} aria-hidden /></button>
        </nav>}
        <span role="status" className={copyState === "failed" ? "ask-copy-feedback" : "sr-only"}>{copyState === "failed" ? "Couldn’t copy. Try again, or select the message text." : copyState === "copied" ? "Copied to clipboard" : ""}</span>
      </footer>
    </article>
  );
}
