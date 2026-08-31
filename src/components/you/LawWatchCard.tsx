import { useState } from "react";
import { Loader2 } from "lucide-react";

import { lastCheckedLine, noDriftLine, readLawWatch, type LawWatch } from "@/lib/law-watch";
import { api } from "@/state/store";
import { Card } from "../SettingsPrimitives";

export function LawWatchCard({
  watch,
  error,
  onWatch,
  onError,
}: {
  watch: LawWatch | null;
  error: string;
  onWatch: (watch: LawWatch) => void;
  onError: (message: string) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState<number | null>(null);
  const [scheduleBusy, setScheduleBusy] = useState(false);

  const fail = (cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause));

  const checkNow = () => {
    if (checking) return;
    setChecking(true);
    onError("");
    void api("/api/law-watch/check", { method: "POST" })
      .then((body) => onWatch(readLawWatch(body)))
      .catch(fail)
      .finally(() => setChecking(false));
  };

  const apply = (index: number) => {
    if (applying != null || checking) return;
    setApplying(index);
    onError("");
    void api("/api/law-watch/apply", { method: "POST", body: JSON.stringify({ index }) })
      .then((body) => onWatch(readLawWatch(body)))
      .catch(fail)
      .finally(() => setApplying(null));
  };

  const setScheduled = (on: boolean) => {
    if (!watch || scheduleBusy) return;
    setScheduleBusy(true);
    onError("");
    void api("/api/law-watch/schedule", { method: "POST", body: JSON.stringify({ on }) })
      .then((body) => onWatch({ ...watch, scheduled: body.scheduled === true }))
      .catch(fail)
      .finally(() => setScheduleBusy(false));
  };

  return (
    <Card
      title="Law watch"
      subtitle="Bud re-reads the current Acts against the shop reference and flags drift. You confirm what lands — the reference never rewrites itself."
    >
      {error ? <p className="text-[12.5px] text-danger">{error}</p> : null}
      {watch ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[13px] text-ink-secondary">{lastCheckedLine(watch.lastCheckedAt)}</p>
            <button
              type="button"
              disabled={checking}
              className="pm-control inline-flex items-center gap-1.5 rounded border border-line px-2 py-0.5 text-[12px] font-medium text-ink hover:bg-raised disabled:opacity-40"
              onClick={checkNow}
            >
              {checking ? <Loader2 size={12} className="animate-spin motion-reduce:animate-none" /> : null}
              Check the law now
            </button>
          </div>
          {watch.lastCheckedAt != null && watch.drift.length === 0 ? (
            <p className="mt-3 text-[13px] text-ink-secondary">{noDriftLine(watch.checkedSources.length)}</p>
          ) : null}
          {watch.drift.length > 0 ? (
            <ul className="mt-3 text-[13px] text-ink">
              {watch.drift.map((item, index) => (
                <li key={`${item.jurisdiction}-${item.topic}-${index}`} className="border-t border-line py-3 first:border-t-0 first:pt-0">
                  <p className="font-semibold text-ink">
                    {item.jurisdiction} · {item.topic}
                  </p>
                  <p className="mt-1 text-[12px] text-ink">Now: {item.current}</p>
                  <p className="text-[12px] text-ink">Reference says: {item.reference}</p>
                  {item.note ? <p className="mt-1 text-[12px] text-ink-muted">{item.note}</p> : null}
                  <button
                    type="button"
                    disabled={applying === index || checking}
                    className="mt-2 inline-flex items-center gap-1 text-[12px] text-ink-muted underline-offset-2 hover:text-ink hover:underline disabled:opacity-40"
                    onClick={() => apply(index)}
                  >
                    {applying === index ? <Loader2 size={12} className="animate-spin motion-reduce:animate-none" /> : null}
                    Apply to the reference
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <label className="mt-4 flex items-center gap-2 text-[13px] text-ink">
            <input
              type="checkbox"
              checked={watch.scheduled}
              disabled={scheduleBusy || checking}
              onChange={(event) => setScheduled(event.target.checked)}
            />
            Weekly on the clock
          </label>
          {watch.scheduled ? (
            <p className="mt-1 text-[12px] text-ink-muted">
              Mondays at 8:00 am · joins the clock after you approve the plan under Bud&apos;s jobs.
            </p>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}
