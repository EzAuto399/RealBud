import { isObservedStale, type DeskSnapshot } from "@/lib/desk";
import { fmtDateTime, fmtTimeOfDay } from "@/lib/au";
import type { DeskQueueItem } from "@/lib/desk-queue";
import { holdMeta } from "@/lib/desk-queue";
import { EvidenceRail, HandoffPanel, SourceStamp } from "../pm";

const PRESENTATIONS = ["side-by-side", "inspector", "window"] as const;
const PRESENTATION_LABELS: Record<(typeof PRESENTATIONS)[number], string> = {
  "side-by-side": "Side by side",
  inspector: "Inspector",
  window: "Window",
};

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
  const stale = isObservedStale(work?.observedAt);
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
              ? "For the licensed person — RealBud will not draft a notice or start a statutory clock."
              : item.kind === "import-issue"
                ? "This row did not match one property. It stays an import issue."
                : item.kind === "maintenance-intake"
                  ? "Intake only. No tradie dispatch from RealBud."
                  : item.kind === "lease-review" || item.kind === "inspection-prep"
                    ? "Read-only dates and draft wording. No statutory clock."
                    : item.bucket === "waiting" && item.holdReason
                      ? item.action
                      : item.holdReason
                        ? `Held · ${holdMeta(item.holdReason)}.`
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
              <p>Prepare only. Submit, Pay and Send stay with you. View cannot widen the site or actions.</p>
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
                    {PRESENTATION_LABELS[value]}
                  </button>
                ))}
              </div>
            </HandoffPanel>
          ) : draft?.status === "allowed" && draft.channel === "portal" ? (
            <HandoffPanel caseLabel={item.address} origin="portal" submitter="You submit in the PMS">
              <p>Prepare only. Submit, Pay and Send stay with you.</p>
            </HandoffPanel>
          ) : null}
        </>
      )}
    </EvidenceRail>
  );
}
