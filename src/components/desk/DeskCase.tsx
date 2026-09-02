import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";

import { aud, isObservedStale, type DeskSnapshot, type Draft } from "@/lib/desk";
import { fmtDate, fmtDateTime, fmtTimeOfDay } from "@/lib/au";
import type { DeskQueueItem, DeskRecoveryPlan } from "@/lib/desk-queue";
import { holdMeta, recoveryPlanFor } from "@/lib/desk-queue";
import { draftViaLine } from "@/lib/phone-label";
import { CaseHeader, DecisionBar, FactSummary, SafeguardStatus, StatusLabel } from "../pm";
import { CASE_KIND_LABELS, CONTACT_ROLE_LABELS } from "./labels";

export function DeskCase({
  snap,
  item,
  busy,
  empty,
  onAllow,
  onDeny,
  onEdit,
  onCopy,
  onPrepare,
  onRecover,
}: {
  snap: DeskSnapshot;
  item?: DeskQueueItem;
  busy: string | null;
  empty: ReactNode;
  onAllow: (draft: Draft) => void;
  onDeny: (draft: Draft, reason?: string) => void;
  onEdit: (draft: Draft, body: string) => void;
  onCopy: (body: string) => void;
  onPrepare: (draft: Draft) => void;
  onRecover: (item: DeskQueueItem, plan: DeskRecoveryPlan) => void;
}) {
  const draft = item?.draftId ? snap.drafts.find((row) => row.id === item.draftId) : undefined;
  const [editing, setEditing] = useState(false);
  const [denying, setDenying] = useState(false);
  const [denyReason, setDenyReason] = useState("");
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [body, setBody] = useState(draft?.body ?? "");
  const denyInputRef = useRef<HTMLInputElement>(null);
  const denyButtonRef = useRef<HTMLButtonElement>(null);
  const returnDenyFocus = useRef(false);
  useEffect(() => {
    setEditing(false);
    setDenying(false);
    setDenyReason("");
    setBody(draft?.body ?? "");
    returnDenyFocus.current = false;
  }, [draft?.id, draft?.body]);
  useEffect(() => {
    const contacts = item?.propertyId
      ? (snap.book?.contacts.filter((row) => row.propertyId === item.propertyId) ?? [])
      : [];
    setPeopleOpen(contacts.some((contact) => contact.safeguards.doNotContact));
  }, [item?.id, item?.propertyId, snap.book?.contacts]);
  useEffect(() => {
    if (denying) {
      denyInputRef.current?.focus();
      return;
    }
    if (returnDenyFocus.current) {
      returnDenyFocus.current = false;
      denyButtonRef.current?.focus();
    }
  }, [denying]);
  const cancelDeny = () => {
    returnDenyFocus.current = true;
    setDenying(false);
    setDenyReason("");
  };

  if (!item) {
    return <>{empty}</>;
  }

  const property = snap.properties.find((row) => row.id === item.propertyId);
  const work = item?.workItemId ? snap.workItems.find((row) => row.id === item.workItemId) : undefined;
  const facts = item.propertyId ? snap.ledger.find((row) => row.propertyId === item.propertyId) : undefined;
  const waiting = Boolean(draft && busy === draft.id);
  const tenancies = snap.book?.tenancies.filter((row) => row.propertyId === item.propertyId) ?? [];
  const contacts = snap.book?.contacts.filter((row) => row.propertyId === item.propertyId) ?? [];
  const decisions = snap.book?.decisions.filter((row) => row.caseId === item.workItemId || row.proposalId === item.draftId) ?? [];
  const kindLabel = CASE_KIND_LABELS[item.kind] ?? item.kind;
  const stale = isObservedStale(work?.observedAt);
  const recovery = !draft && item.bucket !== "done" ? recoveryPlanFor(item) : null;
  const safeguards: Array<[string, boolean]> = [
    ["Hardship", Boolean(work?.recipient.hardship)],
    ["Dispute", Boolean(work?.recipient.dispute)],
    ["Payment arrangement", Boolean(work?.recipient.paymentArrangement)],
    ["Do not contact", Boolean(work?.recipient.doNotContact)],
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CaseHeader
        title={item.address}
        status={
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <StatusLabel
              tone={
                item.kind === "licensee-required"
                  ? "danger"
                  : item.bucket === "now"
                    ? "agency"
                    : item.bucket === "waiting"
                      ? "hold"
                      : "muted"
              }
            >
              {kindLabel} · {item.state}
            </StatusLabel>
            {stale && work ? (
              <StatusLabel tone="hold">Stale · last observed {fmtTimeOfDay(work.observedAt)}</StatusLabel>
            ) : null}
          </div>
        }
      >
        {property ? (
          <>
            {property.tenantName} · {property.tenantPhone} ·{" "}
            <span className="tabular-nums">{aud(property.weeklyRentCents)}/wk</span>
          </>
        ) : item.kind === "import-issue" ? (
          "Unmatched or ambiguous source row. Not a property."
        ) : (
          item.meta
        )}
      </CaseHeader>

      <div className="@container min-h-0 flex-1 overflow-y-auto px-5 py-4">
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
            <p className="text-[14px] text-ink">
              {item.action}
              {item.meta && item.meta !== item.action ? ` · ${item.meta}` : ""}
            </p>
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
                    <p className="mt-2 text-[12px] text-ink-muted">
                      Keep the disclaimer in the wording. Allow still only records a decision — RealBud does not send.
                    </p>
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
              <p className="mt-4 text-[14px] text-ink-muted">{item.holdReason ? `Held · ${holdMeta(item.holdReason)}` : "No proposal on this case yet."}</p>
            )}
            <div className="mt-4 grid grid-cols-2 gap-x-6 @md:grid-cols-4">
              <FactSummary label="Days since due" value={facts ? String(facts.daysSinceDue) : "Unknown"} observedAt={work?.observedAt} />
              <FactSummary label="Rent" value={facts ? (facts.rentLanded ? "Landed" : "Not seen") : "Unknown"} />
              <FactSummary label="Levy" value={facts ? (facts.levyPaid ? "Marked paid" : "Not marked paid") : "Unknown"} />
              <FactSummary label="Courtesy" value={facts?.daysSinceCourtesy == null ? "Not reminded" : `${facts.daysSinceCourtesy}d ago`} />
            </div>
            {safeguards.some(([, active]) => active) ? (
              <div className="mt-4">
                <h3 className="pm-label text-ink-muted">Safeguards</h3>
                {safeguards.map(([label, active]) => (
                  <SafeguardStatus key={label} label={label} active={active} />
                ))}
              </div>
            ) : (
              <details className="mt-4">
                <summary className="flex cursor-pointer items-center justify-between gap-3 py-1.5 text-[14px] text-ink">
                  <span>Safeguards</span>
                  <StatusLabel tone="muted">None in force</StatusLabel>
                </summary>
                {safeguards.map(([label, active]) => (
                  <SafeguardStatus key={label} label={label} active={active} />
                ))}
              </details>
            )}
          </>
        )}

        {tenancies.length ? (
          <details className="mt-5">
            <summary className="cursor-pointer py-1.5 text-[14px] font-medium text-ink">Tenancies · {tenancies.length}</summary>
            <ul className="mt-1 space-y-1 text-[13px] text-ink">
              {tenancies.map((tenancy) => (
                <li key={tenancy.id}>
                  {tenancy.status === "current" ? "Current" : "Closed"} ·{" "}
                  <span className="tabular-nums">{aud(tenancy.weeklyRentCents)}/wk</span>
                  {tenancy.closedAt ? ` · ${fmtDate(tenancy.closedAt)}` : ""}
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {contacts.length ? (
          <details
            className="mt-4"
            open={peopleOpen}
            onToggle={(event) => setPeopleOpen(event.currentTarget.open)}
          >
            <summary className="cursor-pointer py-1.5 text-[14px] font-medium text-ink">People · {contacts.length}</summary>
            <ul className="mt-1 space-y-1 text-[13px] text-ink">
              {contacts.map((contact) => (
                <li key={contact.id}>
                  {CONTACT_ROLE_LABELS[contact.role] ?? contact.role} · {contact.name} · {contact.phone}
                  {contact.safeguards.doNotContact ? " · do not contact" : ""}
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {decisions.length ? (
          <details className="mt-4">
            <summary className="cursor-pointer py-1.5 text-[14px] font-medium text-ink">Decisions · {decisions.length}</summary>
            <ul className="mt-1 space-y-1 text-[13px] text-ink-muted">
              {decisions.map((decision) => (
                <li key={decision.id} title={`Book revision …${decision.revisionId.slice(-8)}`}>
                  {decision.action} · {decision.actor} · {fmtDateTime(decision.at)}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[12px] text-ink-muted">A recorded decision never means RealBud sent.</p>
          </details>
        ) : null}

        {recovery ? (
          <section className="mt-5 rounded border border-line bg-raised/60 p-4" aria-label="Recovery steps">
            <h3 className="text-[14px] font-semibold text-ink">{recovery.headline}</h3>
            <dl className="mt-3 grid gap-2 text-[13px] leading-relaxed">
              <div>
                <dt className="inline font-medium text-ink">Missing: </dt>
                <dd className="inline text-ink-muted">{recovery.missing}</dd>
              </div>
              <div>
                <dt className="inline font-medium text-ink">Source: </dt>
                <dd className="inline text-ink-muted">{recovery.source}</dd>
              </div>
              <div>
                <dt className="inline font-medium text-ink">Next: </dt>
                <dd className="inline text-ink-muted">{recovery.next}</dd>
              </div>
            </dl>
            {recovery.action !== "none" && recovery.actionLabel ? (
              <button
                type="button"
                onClick={() => onRecover(item, recovery)}
                className="pm-control mt-3 rounded bg-agency px-3 text-[13px] font-medium text-white hover:bg-agency-hover"
              >
                {recovery.actionLabel}
              </button>
            ) : null}
          </section>
        ) : null}
      </div>

      {draft && draft.status === "pending" && denying ? (
        <div
          className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              cancelDeny();
            }
          }}
        >
          <label className="sr-only" htmlFor="desk-deny-reason">
            Reason (optional)
          </label>
          <input
            id="desk-deny-reason"
            ref={denyInputRef}
            type="text"
            value={denyReason}
            maxLength={280}
            placeholder="Reason (optional)"
            onChange={(event) => setDenyReason(event.target.value)}
            className="pm-control min-w-0 flex-1 rounded border border-line bg-paper px-3 text-[14px] text-ink"
          />
          <button
            type="button"
            disabled={waiting}
            onClick={() => onDeny(draft, denyReason.trim() || undefined)}
            className="pm-decision rounded bg-agency px-4 text-[14px] font-medium text-white hover:bg-agency-hover disabled:opacity-40"
          >
            Deny wording
          </button>
          <button type="button" onClick={cancelDeny} className="pm-control rounded border border-line bg-sheet px-3 text-[14px] text-ink hover:bg-raised">
            Cancel
          </button>
        </div>
      ) : draft && draft.status === "pending" ? (
        <DecisionBar
          busy={waiting}
          denyRef={denyButtonRef}
          onAllow={() => onAllow(draft)}
          onEdit={() => setEditing(true)}
          onDeny={() => setDenying(true)}
          onCopy={() => onCopy(draft.body)}
        />
      ) : draft && (draft.status === "allowed" || draft.status === "denied") ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
          {draft.status === "allowed" ? (
            <button
              type="button"
              onClick={() => onCopy(draft.body)}
              className="pm-decision rounded bg-agency px-4 text-[14px] font-medium text-white hover:bg-agency-hover"
            >
              Copy
            </button>
          ) : null}
          {draft.status === "allowed" && draft.channel === "portal" ? (
            <button type="button" onClick={() => onPrepare(draft)} className="pm-control rounded border border-line bg-sheet px-3 text-[14px] text-ink">
              Prepare portal
            </button>
          ) : null}
          <span className="text-[12px] text-ink-muted">
            {draftViaLine(draft) ??
              (draft.status === "allowed"
                ? "Copy, then send from the PMS. RealBud did not send it."
                : "Wording denied. RealBud did not send it.")}
          </span>
        </div>
      ) : null}
    </div>
  );
}
