export interface AskIntakeResultData {
  created: number;
  skipped: number;
  unparsed: string[];
}

export function AskIntakeResult({
  result,
  onReview,
}: {
  result: AskIntakeResultData;
  onReview: () => void;
}) {
  const propertyLabel = result.created === 1 ? "property" : "properties";
  const skippedLabel = result.skipped === 1 ? "row" : "rows";

  return (
    <div
      role="status"
      aria-live="polite"
      className="mt-2.5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-agency/20 bg-agency/5 px-3 py-2.5"
    >
      <div className="min-w-[14rem] flex-1 text-[12px] leading-relaxed text-ink-secondary">
        <div className="font-medium text-ink">
          {result.created > 0
            ? `${result.created} ${propertyLabel} staged on Desk.`
            : "No properties were staged."}
        </div>
        {result.skipped > 0 ? (
          <div>{result.skipped} duplicate or incomplete {skippedLabel} skipped.</div>
        ) : null}
        {result.unparsed.length > 0 ? (
          <div className="line-clamp-2 text-hold">Check: {result.unparsed.join(" · ")}</div>
        ) : null}
      </div>
      {result.created > 0 ? (
        <button
          type="button"
          onClick={onReview}
          className="pm-tactile rounded-lg bg-agency px-3 py-1.5 text-[12px] font-medium text-white hover:bg-agency-hover"
        >
          Review on Desk
        </button>
      ) : null}
    </div>
  );
}
