import type { DeskSnapshot } from "@/lib/desk";
import { fmtDateTime, fmtTimeOfDay } from "@/lib/au";
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
  const stale = work && Date.now() - work.observedAt > 12 * 60 * 60 * 1000;
  const handoff = snap.book?.handoff;
  const liveForCase = Boolean(handoff && item && (handoff.caseId === item.workItemId || draft?.status === "allowed"));

  return (
    <EvidenceRail state={!item ? "empty" : stale ? "stale" : item.kind === "import-issue" ? "partial" : "success"}>
      {!item ? (
        <p className="text-ink-muted">Select a case to see why it is here.</p>
      ) : (
        <>
          <SourceStamp
            label={source?.label ?? work?.sourceIds.join(", ") ?? "Book"}
            observedAt={work?.observedAt}
            authority={item.kind === "import-issue" ? "unmatched" : snap.demo ? "demo" : "legacy"}
            state={stale ? "stale" : item.kind === "import-issue" ? "partial" : "success"}
          />
          <p className="mt-3 text-[14px] text-ink">
            {item.kind === "licensee-required"
              ? "Past the courtesy window. Desk will not draft a notice."
              : item.kind === "import-issue"
                ? "This row did not match one property. It stays an import issue."
                : item.kind === "maintenance-intake"
                  ? "Intake only. No tradie dispatch from RealBud."
                  : item.kind === "lease-review" || item.kind === "inspection-prep"
                    ? "Read-only dates and draft wording. No statutory clock."
                    : item.holdReason
                      ? `Held because ${item.holdReason}.`
                      : "Current money facts from the last Recheck. Notes are not used here."}
          </p>
          {work ? (
            <p className="mt-2 text-[12px] text-ink-muted">
              Observed {fmtDateTime(work.observedAt)} · {work.sourceIds.join(", ") || "demo book"}
              {work.origin ? ` · from ${work.origin.loopId}` : ""}
            </p>
          ) : null}
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
