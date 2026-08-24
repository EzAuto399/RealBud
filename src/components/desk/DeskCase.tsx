import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import type { DeskSnapshot, Draft } from "@/lib/desk";
import { aud } from "@/lib/desk";
import { fmtDate, fmtDateTime } from "@/lib/au";
import type { DeskQueueItem } from "@/lib/desk-queue";
import { CaseHeader, DecisionBar, FactSummary, SafeguardStatus, StatusLabel } from "../pm";
import { CASE_KIND_LABELS, CONTACT_ROLE_LABELS } from "./labels";

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
}: {
  snap: DeskSnapshot;
  item?: DeskQueueItem;
  busy: string | null;
  emptyReason: string;
  onAllow: (draft: Draft) => void;
  onDeny: (draft: Draft) => void;
  onEdit: (draft: Draft, body: string) => void;
  onCopy: (body: string) => void;
  onPrepare: (draft: Draft) => void;
}) {
  const draft = item?.draftId ? snap.drafts.find((row) => row.id === item.draftId) : undefined;
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(draft?.body ?? "");
  useEffect(() => {
    setEditing(false);
    setBody(draft?.body ?? "");
  }, [draft?.id, draft?.body]);

  if (!item) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center text-[14px] text-ink-muted">
        {emptyReason}
      </div>
    );
  }

  const property = snap.properties.find((row) => row.id === item.propertyId);
  const work = item?.workItemId ? snap.workItems.find((row) => row.id === item.workItemId) : undefined;
  const facts = item.propertyId ? snap.ledger.find((row) => row.propertyId === item.propertyId) : undefined;
  const waiting = Boolean(draft && busy === draft.id);
  const tenancies = snap.book?.tenancies.filter((row) => row.propertyId === item.propertyId) ?? [];
  const contacts = snap.book?.contacts.filter((row) => row.propertyId === item.propertyId) ?? [];
  const decisions = snap.book?.decisions.filter((row) => row.caseId === item.workItemId || row.proposalId === item.draftId) ?? [];
  const kindLabel = CASE_KIND_LABELS[item.kind] ?? item.kind;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CaseHeader
        title={item.address}
        status={
          <StatusLabel tone={item.bucket === "needs-you" ? "agency" : item.bucket === "licensee" ? "danger" : item.bucket === "held" ? "hold" : "muted"}>
            {kindLabel} · {item.state}
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
        ) : item.kind === "licensee-required" ? (
          <p className="text-[14px] text-ink">
            For the licensee. RealBud will not draft a notice or start a statutory clock. {item.meta}
          </p>
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
            Inbound triage. Declared, not a clock run. {item.holdReason ?? item.meta}
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-x-6">
              <FactSummary label="Days since due" value={facts ? String(facts.daysSinceDue) : "Unknown"} observedAt={work?.observedAt} />
              <FactSummary label="Rent" value={facts ? (facts.rentLanded ? "Landed" : "Not seen") : "Unknown"} />
              <FactSummary label="Levy" value={facts ? (facts.levyPaid ? "Marked paid" : "Not marked paid") : "Unknown"} />
              <FactSummary label="Courtesy" value={facts?.daysSinceCourtesy == null ? "Not reminded" : `${facts.daysSinceCourtesy}d ago`} />
            </div>
            <div className="mt-4">
              <h3 className="pm-label text-ink-muted">Safeguards</h3>
              <SafeguardStatus label="Hardship" active={Boolean(work?.recipient.hardship)} />
              <SafeguardStatus label="Dispute" active={Boolean(work?.recipient.dispute)} />
              <SafeguardStatus label="Payment arrangement" active={Boolean(work?.recipient.paymentArrangement)} />
              <SafeguardStatus label="Do not contact" active={Boolean(work?.recipient.doNotContact)} />
            </div>
            {draft ? (
              <div className="mt-4">
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
              </div>
            ) : (
              <p className="mt-4 text-[14px] text-ink-muted">{item.holdReason ? `Held · ${item.holdReason}` : "No proposal on this case yet."}</p>
            )}
          </>
        )}

        {tenancies.length ? (
          <div className="mt-5">
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
      </div>

      {draft && draft.status === "pending" ? (
        <DecisionBar
          busy={waiting}
          onAllow={() => onAllow(draft)}
          onEdit={() => setEditing(true)}
          onDeny={() => onDeny(draft)}
          onCopy={() => onCopy(draft.body)}
        />
      ) : draft && draft.status === "allowed" ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
          <button type="button" onClick={() => onCopy(draft.body)} className="pm-control rounded border border-line bg-sheet px-3 text-[14px] text-ink">
            Copy
          </button>
          {draft.channel === "portal" ? (
            <button type="button" onClick={() => onPrepare(draft)} className="pm-control rounded bg-portal px-3 text-[14px] font-medium text-white">
              Prepare portal
            </button>
          ) : null}
          <span className="text-[12px] text-ink-muted">Approved wording. You send from the PMS. RealBud did not send it.</span>
        </div>
      ) : null}
    </div>
  );
}
