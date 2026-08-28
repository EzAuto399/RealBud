import { useEffect, useState } from "react";
import { Check, ChevronDown, CircleAlert, Clock3, History, Loader2, Mail, Paperclip, ShieldCheck } from "lucide-react";

import type { DeskSnapshot, Draft } from "@/lib/desk";
import { aud } from "@/lib/desk";
import { fmtDate, fmtDateTime } from "@/lib/au";
import type { DeskQueueItem } from "@/lib/desk-queue";
import { CaseHeader, DecisionBar, FactSummary, SafeguardStatus, StatusLabel } from "../pm";
import { CASE_KIND_LABELS, CONTACT_ROLE_LABELS } from "./labels";

type ReviewAssist = NonNullable<NonNullable<DeskSnapshot["book"]>["reviewAssist"]>[number];

function comparisonLabel(state: ReviewAssist["recipient"], first = "First review"): string {
  if (state === "same") return "Unchanged";
  if (state === "changed") return "Changed";
  return first;
}

function ReviewMemory({ review, wordingOpen, onToggleWording }: {
  review: ReviewAssist;
  wordingOpen: boolean;
  onToggleWording: () => void;
}) {
  const familiar = review.mode === "familiar";
  const title = familiar ? "Ready for a quick review" : review.mode === "first-time" ? "First review" : "Check what changed";
  const summary = familiar
    ? "Bud checked the current source and found no changes in the recipient, channel, wording pattern or safeguards."
    : review.mode === "first-time"
      ? "Bud prepared this card, but there is no earlier Allow for this property and work type."
      : review.moneyBoundary
        ? "Bud found a money boundary. The flag stays fully expanded and RealBud cannot move trust."
        : review.safeguardAttention
          ? "A recipient safeguard is active, so this card stays fully expanded."
          : review.evidence === "attention"
            ? "The source is no longer current enough for a shortened review."
            : "One or more review fields differ from the last allowed card.";
  const evidence = review.evidence === "current"
    ? `Current${review.observedAt ? ` · ${fmtDateTime(review.observedAt)}` : ""}`
    : review.evidence === "practice"
      ? "Practice-book evidence"
      : "Fresh source check required";
  const wording = review.editedOnCard ? "Edited on this card" : comparisonLabel(review.wording, "First wording review");

  return (
    <section className={`mb-4 rounded-lg border px-3.5 py-3 ${familiar ? "border-agency/30 bg-selected/35" : review.mode === "attention" ? "border-hold/35 bg-hold/5" : "border-line bg-card"}`} aria-label="Review memory">
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded ${familiar ? "bg-selected text-agency" : review.mode === "attention" ? "bg-hold/10 text-hold" : "bg-raised text-ink-muted"}`}>
          {familiar ? <Check size={15} /> : review.mode === "attention" ? <CircleAlert size={15} /> : <History size={15} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
            {review.priorAllowedCount > 0 ? (
              <span className="rounded bg-sheet px-2 py-0.5 text-[10.5px] font-medium text-ink-muted">
                {review.priorAllowedCount} similar Allow{review.priorAllowedCount === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">{summary}</p>
        </div>
      </div>
      <dl className="mt-3 grid gap-x-5 gap-y-2 border-y border-line/70 py-2 text-[12px] sm:grid-cols-2">
        <div className="flex items-start justify-between gap-3"><dt className="text-ink-muted">Facts</dt><dd className="text-right font-medium text-ink">{evidence}</dd></div>
        <div className="flex items-start justify-between gap-3"><dt className="text-ink-muted">Recipient</dt><dd className="text-right font-medium text-ink">{comparisonLabel(review.recipient)}</dd></div>
        <div className="flex items-start justify-between gap-3"><dt className="text-ink-muted">Channel</dt><dd className="text-right font-medium text-ink">{comparisonLabel(review.channel)}</dd></div>
        <div className="flex items-start justify-between gap-3"><dt className="text-ink-muted">Wording</dt><dd className="text-right font-medium text-ink">{wording}</dd></div>
      </dl>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11.5px] text-ink-muted">Allow approves this exact version once. Future matching cards may be shorter, but they are never automatically approved or sent.</p>
        <button
          type="button"
          aria-expanded={wordingOpen}
          onClick={onToggleWording}
          className="inline-flex min-h-8 items-center gap-1 text-[12px] font-medium text-agency hover:underline"
        >
          {wordingOpen ? "Hide exact wording" : "Review exact wording"}
          <ChevronDown size={13} className={wordingOpen ? "rotate-180" : ""} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

export function DeskCase({
  snap,
  item,
  busy,
  emptyReason,
  onAllow,
  onDeny,
  onEdit,
  onCopy,
  onPrepare,
  onWaiting,
  onClose,
  onSnooze,
  onCancel,
  copyPulse = false,
  shareAddress = false,
}: {
  snap: DeskSnapshot;
  item?: DeskQueueItem;
  busy: string | null;
  emptyReason: string;
  copyPulse?: boolean;
  shareAddress?: boolean;
  onAllow: (draft: Draft) => void;
  onDeny: (draft: Draft) => void;
  onEdit: (draft: Draft, body: string) => void;
  onCopy: (body: string) => void;
  onPrepare: (draft: Draft) => void;
  onWaiting: (workItemId: string) => void;
  onClose: (workItemId: string) => void;
  onSnooze: (workItemId: string, until: number) => void;
  onCancel: (workItemId: string) => void;
}) {
  const draft = item?.draftId ? snap.drafts.find((row) => row.id === item.draftId) : undefined;
  const review = draft ? snap.book?.reviewAssist?.find((row) => row.proposalId === draft.id) : undefined;
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(draft?.body ?? "");
  const [wordingOpen, setWordingOpen] = useState(true);
  useEffect(() => {
    setEditing(false);
    setBody(draft?.body ?? "");
  }, [draft?.id, draft?.body]);
  useEffect(() => {
    setWordingOpen(review?.mode !== "familiar");
  }, [draft?.id, review?.mode]);

  if (!item) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center text-[14px] text-ink-muted">
        {emptyReason}
      </div>
    );
  }

  const property = snap.properties.find((row) => row.id === item.propertyId);
  const work = item?.workItemId ? snap.workItems.find((row) => row.id === item.workItemId) : undefined;
  const factsAreCurrent = snap.demo || work?.evidenceStatus === undefined || work.evidenceStatus === "current";
  const facts = factsAreCurrent && item.propertyId ? snap.ledger.find((row) => row.propertyId === item.propertyId) : undefined;
  const waiting = Boolean(draft && busy === draft.id);
  const tenancies = snap.book?.tenancies.filter((row) => row.propertyId === item.propertyId) ?? [];
  const contacts = snap.book?.contacts.filter((row) => row.propertyId === item.propertyId) ?? [];
  const decisions = snap.book?.decisions.filter((row) => row.caseId === item.workItemId || row.proposalId === item.draftId) ?? [];
  const kindLabel = CASE_KIND_LABELS[item.kind] ?? item.kind;
  const safeguards = [
    { label: "Hardship", active: Boolean(work?.recipient.hardship) },
    { label: "Dispute", active: Boolean(work?.recipient.dispute) },
    { label: "Payment arrangement", active: Boolean(work?.recipient.paymentArrangement) },
    { label: "Do not contact", active: Boolean(work?.recipient.doNotContact) },
  ];
  const activeSafeguards = safeguards.filter((safeguard) => safeguard.active);
  const statusLabel =
    item.bucket === "needs-you"
      ? `${kindLabel} · decision ready`
      : item.bucket === "licensee"
        ? `${kindLabel} · licensed review`
      : item.bucket === "held"
          ? `${kindLabel} · held`
          : item.bucket === "waiting"
            ? `${kindLabel} · waiting for reply`
          : `${kindLabel} · ${item.state}`;
  const draftWording = draft ? (
    wordingOpen || editing ? <div className="mt-4">
      <h3 className="pm-label text-ink-muted">Proposed wording</h3>
      {editing ? (
        <>
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={8}
            className="mt-2 w-full resize-y rounded border border-line bg-paper px-3 py-2.5 text-[14px] leading-relaxed text-ink"
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={waiting || !body.trim()}
              onClick={() => {
                onEdit(draft, body);
                setEditing(false);
              }}
              className="pm-control rounded bg-agency px-3 text-[13px] font-medium text-white disabled:opacity-40"
            >
              {waiting ? <Loader2 size={14} className="animate-spin" /> : "Save wording"}
            </button>
            <button
              type="button"
              onClick={() => {
                setBody(draft.body);
                setEditing(false);
              }}
              className="pm-control rounded px-3 text-[13px] text-ink-muted hover:bg-raised"
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <pre className="mt-2 whitespace-pre-wrap font-sans text-[14px] leading-relaxed text-ink">{draft.body}</pre>
      )}
    </div> : null
  ) : (
    <p className="mt-4 text-[14px] text-ink-muted">{item.holdReason ? `Held · ${item.holdReason}` : "No proposal on this case yet."}</p>
  );

  return (
    <div className="desk-case-open flex h-full min-h-0 flex-col">
      <CaseHeader
        title={item.address}
        shareAddress={shareAddress}
        status={
          <StatusLabel tone={item.bucket === "needs-you" ? "agency" : item.bucket === "licensee" ? "danger" : item.bucket === "held" ? "hold" : "muted"}>
            {statusLabel}
          </StatusLabel>
        }
      >
        {property
          ? `${property.tenantName} · ${property.tenantPhone} · ${aud(property.weeklyRentCents)}/wk`
          : item.kind === "import-issue"
            ? "Unmatched or ambiguous source row. Not a property."
            : item.meta}
      </CaseHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {item.kind === "import-issue" ? (
          <p className="text-[14px] text-ink">
            Held as an import issue ({item.holdReason}). Link or reject it in the book after the source is matched. RealBud did not invent a property.
          </p>
        ) : item.kind === "source-incident" ? (
          <section className="rounded border border-hold/30 bg-hold/5 p-4">
            <h3 className="text-[14px] font-semibold text-ink">Bud paused this source safely</h3>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-muted">{work?.holdReason ?? item.meta}</p>
            <dl className="mt-3 grid gap-2 text-[12px] sm:grid-cols-2">
              <div><dt className="text-ink-muted">Source state</dt><dd className="mt-0.5 font-medium text-ink">{work?.sourceIncident?.code ?? "attention required"}</dd></div>
              <div><dt className="text-ink-muted">Book affected</dt><dd className="mt-0.5 font-medium text-ink">{work?.sourceIncident?.affectedPropertyCount ?? 0} properties</dd></div>
            </dl>
            <p className="mt-3 text-[11.5px] text-ink-muted">One incident represents the source-wide outage. No payment facts, reminders or wording were invented.</p>
          </section>
        ) : item.kind === "licensee-required" ? (
          <p className="text-[14px] text-ink">
            For the licensee. RealBud will not draft a notice or start a statutory clock. {item.meta}
          </p>
        ) : (item.kind === "maintenance-intake" || item.kind === "inbound-triage") && work?.inbound ? (
          <>
            <section className="rounded-lg border border-line bg-card p-4" aria-label="Inbound message summary">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
                    <Mail size={14} aria-hidden="true" />
                    Read-only {snap.demo ? "sample " : ""}inbox
                  </div>
                  <h3 className="mt-2 text-[16px] font-semibold text-ink">{work.inbound.subject || "No subject"}</h3>
                  <p className="mt-1 text-[13px] text-ink-muted">{work.inbound.senderName || "Unknown sender"} · {work.inbound.senderAddress}</p>
                </div>
                <StatusLabel tone={work.inbound.priority === "urgent-review" ? "danger" : work.inbound.priority === "licensed-review" ? "danger" : work.inbound.priority === "priority" ? "hold" : "muted"}>
                  {work.inbound.priority.replaceAll("-", " ")}
                </StatusLabel>
              </div>
              <p className="mt-4 text-[14px] leading-relaxed text-ink">{work.inbound.summary}</p>
              <dl className="mt-4 grid gap-3 border-t border-line pt-3 text-[12px] sm:grid-cols-3">
                <div><dt className="text-ink-muted">Received</dt><dd className="mt-0.5 font-medium text-ink">{fmtDateTime(work.inbound.receivedAt)}</dd></div>
                <div><dt className="text-ink-muted">Thread</dt><dd className="mt-0.5 font-medium text-ink">{work.inbound.messageCount} {work.inbound.messageCount === 1 ? "message" : "messages"}</dd></div>
                <div><dt className="text-ink-muted">Attachments</dt><dd className="mt-0.5 flex items-center gap-1 font-medium text-ink"><Paperclip size={12} />{work.inbound.attachmentCount} unopened</dd></div>
              </dl>
              {work.inbound.flags.length ? (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {work.inbound.flags.map((flag) => <span key={flag} className="rounded-full bg-raised px-2 py-1 text-[10.5px] text-ink-muted">{flag.replaceAll("-", " ")}</span>)}
                </div>
              ) : null}
              <p className="mt-3 text-[11.5px] leading-relaxed text-ink-muted">
                Bud classified bounded text only. Attachments stay unopened, message instructions grant no tools, and no reply or contractor action occurs here.
              </p>
            </section>
            {work.state === "waiting" && work.inbound.followUpAt ? (
              <div className="mt-3 flex items-start gap-2 rounded border border-agency/20 bg-agency/5 px-3 py-2.5 text-[13px] text-ink">
                <Clock3 size={15} className="mt-0.5 shrink-0 text-agency" />
                <div><span className="font-medium">Waiting for sender.</span> Shop follow-up: {fmtDateTime(work.inbound.followUpAt)}. This is an operational reminder, not a legal deadline.</div>
              </div>
            ) : null}
            {draftWording}
          </>
        ) : item.kind === "maintenance-intake" ? (
          <p className="text-[14px] text-ink">
            Maintenance intake. Classify and attach evidence. RealBud does not dispatch a tradie. {item.holdReason ?? item.meta}
          </p>
        ) : item.kind === "lease-review" ? (
          <p className="text-[14px] text-ink">
            Lease review. Dates and checklists only. No statutory action. {item.holdReason ?? item.meta}
          </p>
        ) : item.kind === "inspection-prep" ? (
          <p className="text-[14px] text-ink">
            Inspection prep. Checklist and draft wording. No statutory action. {item.holdReason ?? item.meta}
          </p>
        ) : item.kind === "inbound-triage" ? (
          <p className="text-[14px] text-ink">
            Inbound triage is declared but this card has no admitted message evidence. {item.holdReason ?? item.meta}
          </p>
        ) : (
          <>
            {draft && review ? (
              <ReviewMemory review={review} wordingOpen={wordingOpen} onToggleWording={() => setWordingOpen((open) => !open)} />
            ) : null}
            <div className="grid grid-cols-2 gap-x-6">
              <FactSummary label="Days since due" value={facts ? String(facts.daysSinceDue) : "Unknown"} observedAt={work?.observedAt} />
              <FactSummary label="Rent" value={facts ? (facts.rentLanded ? "Landed" : "Not seen") : "Unknown"} />
              <FactSummary label="Levy" value={facts ? (facts.levyPaid ? "Marked paid" : "Not marked paid") : "Unknown"} />
              <FactSummary label="Courtesy" value={facts?.daysSinceCourtesy == null ? "Not reminded" : `${facts.daysSinceCourtesy}d ago`} />
            </div>
            <div className="mt-4">
              <h3 className="pm-label text-ink-muted">Safeguards</h3>
              {activeSafeguards.length === 0 ? (
                <div className="mt-2 flex items-start gap-2.5 rounded border border-agency/20 bg-agency/5 px-3 py-2.5 text-[13px] text-ink">
                  <ShieldCheck size={16} className="mt-0.5 shrink-0 text-agency" aria-hidden="true" />
                  <div>
                    <div className="font-medium">Checked · none active</div>
                    <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-muted">Hardship, dispute, payment arrangement and do-not-contact are clear.</div>
                  </div>
                </div>
              ) : (
                <div className="mt-1">
                  {activeSafeguards.map((safeguard) => (
                    <SafeguardStatus key={safeguard.label} label={safeguard.label} active />
                  ))}
                  <p className="mt-2 text-[11.5px] text-ink-muted">Other safeguard checks are clear.</p>
                </div>
              )}
            </div>
            {draftWording}
          </>
        )}

        {tenancies.length || contacts.length || decisions.length ? (
          <details key={item.id} className="mt-5 border-t border-line pt-3" open={review?.mode !== "familiar"}>
            <summary className="cursor-pointer text-[12.5px] font-medium text-agency">
              Property context and decision history
              <span className="ml-2 font-normal text-ink-muted">
                {tenancies.length} {tenancies.length === 1 ? "tenancy" : "tenancies"} · {contacts.length} {contacts.length === 1 ? "person" : "people"} · {decisions.length} {decisions.length === 1 ? "decision" : "decisions"}
              </span>
            </summary>
            {tenancies.length ? (
              <div className="mt-4">
                <h3 className="pm-label text-ink-muted">Tenancies</h3>
                <ul className="mt-1 space-y-1 text-[13px] text-ink">
                  {tenancies.map((tenancy) => (
                    <li key={tenancy.id}>
                      {tenancy.status === "current" ? "Current" : "Closed"} · {aud(tenancy.weeklyRentCents)}/wk
                      {tenancy.closedAt ? ` · ${fmtDate(tenancy.closedAt)}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {contacts.length ? (
              <div className="mt-4">
                <h3 className="pm-label text-ink-muted">People</h3>
                <ul className="mt-1 space-y-1 text-[13px] text-ink">
                  {contacts.map((contact) => (
                    <li key={contact.id}>
                      {CONTACT_ROLE_LABELS[contact.role] ?? contact.role} · {contact.name} · {contact.phone}
                      {contact.safeguards.doNotContact ? " · do not contact" : ""}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {decisions.length ? (
              <div className="mt-4">
                <h3 className="pm-label text-ink-muted">Decisions</h3>
                <ul className="mt-1 space-y-1 text-[13px] text-ink-muted">
                  {decisions.map((decision) => (
                    <li key={decision.id}>
                      {decision.action} · {decision.actor} · {fmtDateTime(decision.at)} · revision …{decision.revisionId.slice(-8)}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-[12px] text-ink-muted">A recorded decision never means RealBud sent.</p>
              </div>
            ) : null}
          </details>
        ) : null}
      </div>

      {draft && draft.status === "pending" ? (
        <DecisionBar
          busy={waiting}
          onAllow={() => onAllow(draft)}
          onEdit={() => {
            setWordingOpen(true);
            setEditing(true);
          }}
          onDeny={() => onDeny(draft)}
        />
      ) : draft && draft.status === "allowed" && work?.state === "waiting" && item.workItemId ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
          <button type="button" onClick={() => onClose(item.workItemId!)} className="pm-control rounded bg-agency px-3 text-[14px] font-medium text-white">
            Resolved externally
          </button>
          <button type="button" onClick={() => onSnooze(item.workItemId!, Date.now() + 24 * 60 * 60 * 1_000)} className="pm-control rounded border border-line bg-sheet px-3 text-[13px] text-ink">
            Remind tomorrow
          </button>
          <button type="button" onClick={() => onCancel(item.workItemId!)} className="pm-control rounded px-3 text-[13px] text-ink-muted hover:bg-raised">
            Close without action
          </button>
          <span className="text-[12px] text-ink-muted">Waiting is recorded; RealBud still did not send the reply. These are shop reminders, never legal clocks.</span>
        </div>
      ) : draft && draft.status === "allowed" ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
          <button
            type="button"
            onClick={() => onCopy(draft.body)}
            className={copyPulse
              ? "copy-pulse pm-control rounded border border-line bg-sheet px-3 text-[14px] text-ink"
              : "pm-control rounded border border-line bg-sheet px-3 text-[14px] text-ink"}
          >
            Copy
          </button>
          {draft.channel === "portal" ? (
            <button type="button" onClick={() => onPrepare(draft)} className="pm-control rounded bg-portal px-3 text-[14px] font-medium text-white">
              Prepare portal
            </button>
          ) : null}
          {draft.kind === "inbound-reply" && item.workItemId && work?.state === "approved" ? (
            <button type="button" onClick={() => onWaiting(item.workItemId!)} className="pm-control rounded border border-agency/30 bg-selected px-3 text-[14px] font-medium text-agency">
              Sent externally — wait for reply
            </button>
          ) : null}
          <span className="text-[12px] text-ink-muted">Approved wording. You send from the PMS. RealBud did not send it.</span>
        </div>
      ) : draft && draft.status === "stale" ? (
        <div className="border-t border-line bg-hold/5 px-4 py-3 text-[13px] text-ink-muted">
          Superseded by newer evidence. This wording cannot be allowed; Recheck creates a new proposal only when current PMS facts support one.
        </div>
      ) : null}
    </div>
  );
}
