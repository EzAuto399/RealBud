// A consequential browser step (pay, sign, send, notice, delete, account
// change) as a real decision: what will happen, where, each fact the page
// confirmed, the time left, and approve / decline / stop the whole task.
// The broker already refused anything it could not verify and re-checks the
// same facts before pressing; this card never widens that decision.
import { Check, CircleAlert, Clock, Square } from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
  browserApprovalFact,
  browserApprovalMoney,
  unconfirmedBrowserApprovalFacts,
  type BrowserApprovalCard,
  type BrowserApprovalCardFact,
  type BrowserApprovalFactName,
} from "@shared/browser-approval-card";
import type { BrowserConsequentialKind } from "@shared/browser-task";
import { cn } from "@/lib/cn";

const NOUNS: Record<BrowserConsequentialKind, string> = { pay: "payment", sign: "signature", send: "message", notice: "notice", delete: "deletion", "account-change": "account change" };
const FACT_WORDS: Record<BrowserApprovalFactName, string> = { recipient: "payee", amount: "amount", currency: "currency", reference: "reference", document: "document title", documentHash: "document text", to: "recipient", subject: "subject", bodyHash: "message text", bodyExcerpt: "message excerpt", target: "item it changes" };
const APPROVE: Record<BrowserConsequentialKind, string> = { pay: "Pay", sign: "Sign this document", send: "Send this message", notice: "Issue this notice", delete: "Delete this item", "account-change": "Change this account" };

const confirmedValue = (card: BrowserApprovalCard, name: BrowserApprovalFactName): string | null => {
  const fact = browserApprovalFact(card, name);
  return fact?.confirmed && fact.value ? fact.value : null;
};

/** The question the card asks, e.g. "Pay A$1,240.00 to Fictional Strata Pty Ltd?". */
export function browserApprovalTitle(card: BrowserApprovalCard | null): string {
  if (!card) return "Approval details unavailable";
  const money = browserApprovalMoney(card), payee = confirmedValue(card, "recipient"), to = confirmedValue(card, "to");
  const document = confirmedValue(card, "document"), target = confirmedValue(card, "target");
  switch (card.kind) {
    case "pay": return money && payee ? `Pay ${money} to ${payee}?` : `Approve a payment on ${card.site}?`;
    case "send": return to ? `Send this message to ${to}?` : `Approve a message on ${card.site}?`;
    case "sign": return document ? `Sign “${document}”?` : `Approve a signature on ${card.site}?`;
    case "notice": return document ? `Issue the notice “${document}”?` : `Approve a notice on ${card.site}?`;
    case "delete": return target ? `Delete ${target}?` : `Approve a deletion on ${card.site}?`;
    case "account-change": return target ? `Change the account: ${target}?` : `Approve an account change on ${card.site}?`;
  }
}

/** The approve button names the verb and its object, e.g. "Pay A$1,240.00". */
export function browserApprovalApproveLabel(card: BrowserApprovalCard | null): string {
  if (!card) return "Approve";
  const money = card.kind === "pay" ? browserApprovalMoney(card) : null;
  return money ? `Pay ${money}` : card.kind === "pay" ? "Pay" : APPROVE[card.kind];
}

export const browserApprovalDeclineLabel = (card: BrowserApprovalCard | null): string => card ? `Decline ${NOUNS[card.kind]}` : "Decline";

/** Why approval is unavailable, or null when the person may approve. */
export function browserApprovalBlocked(card: BrowserApprovalCard | null, now: number): string | null {
  if (!card) return "The details of this approval are incomplete or damaged, so it cannot be approved. Decline it or stop the task.";
  const missing = [...new Set(unconfirmedBrowserApprovalFacts(card).map(name => FACT_WORDS[name]))];
  if (missing.length) return `Bud could not confirm the ${missing.join(", ")} on the page, so this ${NOUNS[card.kind]} cannot be approved here. Decline it, or stop the task and finish it yourself.`;
  if (now >= card.expiresAt) return `This approval expired. Nothing was pressed. If the ${NOUNS[card.kind]} is still wanted, ask Bud to read the page and prepare it again.`;
  return null;
}

export function browserApprovalTimeLeft(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return seconds > 0 ? `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "Expired";
}

/** Ticks once a second until the approval expires. */
export function useApprovalClock(expiresAt: number | null, fixed?: number): number {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  useEffect(() => {
    if (fixed !== undefined || expiresAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= expiresAt) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [expiresAt, fixed]);
  return fixed ?? now;
}

interface Row { label: string; value: string; confirmed: boolean }
const row = (label: string, fact: BrowserApprovalCardFact | undefined): Row =>
  ({ label, value: fact?.value ?? "Not shown on the page", confirmed: fact?.confirmed ?? false });
const textRow = (label: string, fact: BrowserApprovalCardFact | undefined, what: string): Row => ({
  label,
  confirmed: fact?.confirmed ?? false,
  value: fact?.confirmed ? `Bud read the ${what} on the page. If it changes, nothing is pressed.` : `Bud could not read the ${what} completely.`,
});
export function browserApprovalRows(card: BrowserApprovalCard): Row[] {
  const fact = (name: BrowserApprovalFactName) => browserApprovalFact(card, name);
  switch (card.kind) {
    case "pay": {
      const amount = fact("amount"), currency = fact("currency"), money = browserApprovalMoney(card);
      return [
        row("Payee", fact("recipient")),
        { label: "Amount", confirmed: Boolean(money), value: money ?? ([amount?.value, currency?.value].filter(Boolean).join(" ") || "Not shown on the page") },
        ...(fact("reference") ? [row("Reference", fact("reference"))] : []),
      ];
    }
    case "sign":
    case "notice": return [row("Document", fact("document")), textRow("Document text", fact("documentHash"), "document text")];
    case "send": return [row("To", fact("to")), ...(fact("subject") ? [row("Subject", fact("subject"))] : []), textRow("Message text", fact("bodyHash"), "message text")];
    default: return [row("Item", fact("target"))];
  }
}

/** Title, where it happens, the verified facts and the time left. */
export function BrowserApprovalFacts({ approval, now, status }: {
  approval: BrowserApprovalCard | null;
  now: number;
  /** Replaces the time left once the card is settled (e.g. "Stopped. …"). */
  status?: string;
}) {
  const expired = approval ? now >= approval.expiresAt : false;
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="text-[12px] text-ink-muted">
          {`${status ? "Approval" : "Needs your approval"}${approval ? ` · this ${NOUNS[approval.kind]} only` : ""}`}
        </span>
        {!status && approval ? (
          <span className={cn("inline-flex items-center gap-1 text-[12px] tabular-nums", expired ? "text-danger" : "text-ink-muted")}>
            <Clock size={13} aria-hidden="true" />
            {browserApprovalTimeLeft(approval.expiresAt, now)}
          </span>
        ) : null}
      </div>
      <h3 className="mt-1 break-words text-[16px] font-semibold leading-snug text-ink">{browserApprovalTitle(approval)}</h3>
      {approval ? (
        <p className="mt-1 break-words text-[13px] text-ink-muted">Button “{approval.control}” on {approval.site}</p>
      ) : null}
      {approval ? (
        <dl aria-label="Details confirmed on the page" className="mt-2 divide-y divide-line border-y border-line">
          {browserApprovalRows(approval).map(item => (
            <div key={item.label} className="grid grid-cols-1 gap-x-3 gap-y-0.5 py-2 min-[720px]:grid-cols-[8rem_minmax(0,1fr)]">
              <dt className="text-[12px] text-ink-muted">{item.label}</dt>
              <dd className="min-w-0">
                <span className="block break-words text-[14px] text-ink tabular-nums">{item.value}</span>
                <span className={cn("mt-0.5 inline-flex items-center gap-1 text-[12px]", item.confirmed ? "text-agency" : "text-hold")}>
                  {item.confirmed ? <Check size={13} aria-hidden="true" /> : <CircleAlert size={13} aria-hidden="true" />}
                  {item.confirmed ? "Confirmed on the page" : "Not confirmed on the page"}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {status ? <p className="mt-2 text-[13px] text-ink">{status}</p> : null}
    </div>
  );
}

/** Approve (verb and object), decline, and Stop for the whole task. */
export function BrowserApprovalButtons({ approval, now, onApprove, onDecline, onStop }: {
  approval: BrowserApprovalCard | null;
  now: number;
  onApprove: () => void;
  onDecline: () => void;
  onStop: () => void;
}) {
  const reasonId = useId();
  const blocked = browserApprovalBlocked(approval, now);
  return (
    <div className="flex w-full flex-col gap-2 px-4 py-3">
      <p id={reasonId} role="status" className={cn("text-[13px] leading-relaxed", blocked ? "text-hold" : "text-ink-muted")}>
        {blocked ?? "Approve only if these details match the page. Bud reads them again before pressing and presses nothing if they changed."}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={blocked !== null}
          aria-describedby={reasonId}
          onClick={() => { if (!browserApprovalBlocked(approval, Math.max(now, Date.now()))) onApprove(); }}
          className="pm-decision rounded bg-agency px-4 text-[14px] font-medium text-white transition-colors hover:bg-agency-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-agency"
        >
          {browserApprovalApproveLabel(approval)}
        </button>
        <button
          type="button"
          onClick={onDecline}
          className="pm-control rounded border border-danger/40 px-3.5 text-[14px] text-danger transition-colors hover:bg-danger/10"
        >
          {browserApprovalDeclineLabel(approval)}
        </button>
        <button
          type="button"
          onClick={onStop}
          title="Ends Bud's whole task and closes browser work. Nothing more is pressed."
          className="pm-control inline-flex items-center gap-1.5 rounded border border-line px-3.5 text-[14px] text-ink transition-colors hover:bg-selected"
        >
          <Square size={12} className="fill-current" aria-hidden="true" />
          Stop the task
        </button>
      </div>
    </div>
  );
}

/** The transcript record of a settled or waiting approval. */
export function browserApprovalStatus(answered: string | undefined, approval: BrowserApprovalCard | null, now: number): string | undefined {
  const noun = approval ? NOUNS[approval.kind] : "step";
  if (answered === "stopped") return "Stopped. Nothing was pressed, and this approval can no longer be used.";
  if (answered === "allow") return `Approved for this one ${noun}. Bud re-checks the page before pressing; the result counts only once Bud reads it back.`;
  if (answered) return "Not approved. Nothing was pressed.";
  if (approval && now >= approval.expiresAt) return "Expired. Nothing was pressed.";
  return undefined;
}

/** The composer's top half while an approval waits: the facts and time left. */
export function BrowserPendingPanel({ approval, count, index, now }: { approval: BrowserApprovalCard | null; count: number; index: number; now?: number }) {
  const clock = useApprovalClock(approval?.expiresAt ?? null, now);
  return (
    <div className="border-b border-line bg-sheet px-4 py-3">
      {count > 1 ? <p className="mb-1 text-[12px] tabular-nums text-ink-muted">{index + 1} of {count} waiting</p> : null}
      <BrowserApprovalFacts approval={approval} now={clock} />
    </div>
  );
}

/** The composer's decision row while an approval waits. */
export function BrowserPendingActions(props: { approval: BrowserApprovalCard | null; now?: number; onApprove: () => void; onDecline: () => void; onStop: () => void }) {
  const clock = useApprovalClock(props.approval?.expiresAt ?? null, props.now);
  return <BrowserApprovalButtons {...props} now={clock} />;
}

/** The transcript card: the same facts, and what happened to the approval. */
export function BrowserApprovalRecord({ approval, answered, now }: { approval: BrowserApprovalCard | null; answered?: string; now?: number }) {
  const clock = useApprovalClock(answered ? null : approval?.expiresAt ?? null, now);
  const status = browserApprovalStatus(answered, approval, clock) ?? `${approval ? browserApprovalTimeLeft(approval.expiresAt, clock) : "Waiting"}. Answer it below the conversation.`;
  return <BrowserApprovalFacts approval={approval} now={clock} status={status} />;
}
