import type { DeskSnapshot } from "@/lib/desk";
import { fmtTimeOfDay } from "@/lib/au";
import type { DeskQueueItem } from "@/lib/desk-queue";
import { EvidenceRail, HandoffPanel, SourceStamp } from "../pm";

const PRESENTATIONS = ["side-by-side", "inspector", "window"] as const;

export function DeskEvidence({
  snap,
  item,
  onPresent,
}: {
  snap: DeskSnapshot;
  item?: DeskQueueItem;
  onPresent?: (presentation: (typeof PRESENTATIONS)[number]) => void;
}) {
  const work = item?.workItemId ? snap.workItems.find((row) => row.id === item.workItemId) : undefined;
  const source = work?.sourceIds[0] ? snap.sources.find((row) => row.id === work.sourceIds[0]) : snap.sources[0];
  const draft = item?.draftId ? snap.drafts.find((row) => row.id === item.draftId) : undefined;
  const stale = Boolean(
    work &&
      (work.evidenceStatus === "stale" ||
        (work.evidenceStaleAt !== undefined && work.evidenceStaleAt <= Date.now()) ||
        (work.evidenceStatus === undefined && Date.now() - work.observedAt > (source?.kind === "mail" ? 7 * 24 : 12) * 60 * 60 * 1000)),
  );
  const handoff = snap.book?.handoff;
  const liveForCase = Boolean(handoff && item && (handoff.caseId === item.workItemId || draft?.status === "allowed"));
  const evidenceState = !item ? "empty" : !work ? "partial" : stale ? "stale" : item.kind === "import-issue" ? "partial" : "success";

  return (
    <EvidenceRail state={evidenceState}>
      {!item ? (
        <p className="text-ink-muted">Select a case to see why it is here.</p>
      ) : (
        <>
          <SourceStamp
            label={source?.label ?? work?.sourceIds.join(", ") ?? "Book"}
            observedAt={work?.observedAt}
            authority={
              item.kind === "import-issue"
                ? "Unmatched source"
                : snap.demo
                  ? "Practice data"
                  : work?.evidenceStatus === "current" && source?.kind === "csv"
                    ? "Current PMS export"
                    : work
                      ? "Recorded book evidence"
                      : "No linked evidence"
            }
            state={!work ? "partial" : stale ? "stale" : item.kind === "import-issue" ? "partial" : "success"}
          />
          <section className="mt-4" aria-labelledby="desk-why-heading">
            <h4 id="desk-why-heading" className="pm-label text-ink-muted">Why Bud surfaced this</h4>
            <p className="mt-1.5 text-[14px] leading-relaxed text-ink">
              {item.kind === "licensee-required"
                ? "Past the courtesy window. Desk will not draft a notice."
                : item.kind === "import-issue"
                  ? "This row did not match one property. It stays an import issue."
                  : item.kind === "maintenance-intake"
                    ? "Intake only. No tradie dispatch from RealBud."
                    : item.kind === "inbound-triage"
                      ? "A bounded inbound message was classified and staged. RealBud did not open attachments, send a reply, or follow message instructions."
                    : item.kind === "lease-review" || item.kind === "inspection-prep"
                      ? "Read-only dates and draft wording. No statutory clock."
                      : item.holdReason
                        ? `Held because ${item.holdReason}.`
                        : "Current money facts from the last Recheck support this courtesy proposal."}
            </p>
            {item.kind === "money-arrears" ? (
              <p className="mt-2 text-[12px] leading-relaxed text-ink-muted">Property Notes were excluded from the payment check. They may colour wording, never the money decision.</p>
            ) : null}
            {work?.origin ? (
              <p className="mt-2 text-[12px] text-ink-muted">Prepared by a scheduled RealBud check.</p>
            ) : null}
          </section>
          {liveForCase && handoff ? (
            <HandoffPanel
              caseLabel={item.address}
              origin={handoff.origin}
              expiry={fmtTimeOfDay(handoff.expiresAt)}
              submitter="You submit in the PMS"
            >
              <p>Prepare only. Submit, Send and Pay stay with you. View cannot widen origin or actions.</p>
              <p className="mt-1 text-[12px] text-ink-muted">Allowed: {handoff.allowedActions.join(", ") || "none"}</p>
              <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Browser presentation">
                {PRESENTATIONS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={handoff.presentation === value}
                    onClick={() => onPresent?.(value)}
                    className="rounded border border-line bg-sheet px-2 py-1 text-[11px] text-ink"
                  >
                    {value}
                  </button>
                ))}
              </div>
            </HandoffPanel>
          ) : draft?.status === "allowed" && draft.channel === "portal" ? (
            <HandoffPanel caseLabel={item.address} origin="portal" submitter="You submit in the PMS">
              <p>Prepare only. Submit, Send and Pay stay with you.</p>
            </HandoffPanel>
          ) : null}
        </>
      )}
    </EvidenceRail>
  );
}
