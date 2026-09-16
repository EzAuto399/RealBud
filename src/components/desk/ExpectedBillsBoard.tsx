import { useCallback, useEffect, useState } from "react";
import { CalendarClock, Loader2 } from "lucide-react";

import { cn } from "@/lib/cn";
import { api } from "@/state/store";

type BillRow = {
  id: string;
  propertyId: string;
  kind: string;
  status: string;
  note: string;
};

type Groups = {
  "needs-you": BillRow[];
  "due-soon": BillRow[];
  "in-process": BillRow[];
  settled: BillRow[];
};

const GROUP_LABEL: Record<keyof Groups, string> = {
  "needs-you": "Needs you",
  "due-soon": "Due / expected",
  "in-process": "In process",
  settled: "Settled",
};

export function ExpectedBillsBoard({ className }: { className?: string }) {
  const [groups, setGroups] = useState<Groups | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const body = await api("/api/expected-bills", undefined, { timeoutMs: 15_000 });
      setGroups(body.groups ?? { "needs-you": [], "due-soon": [], "in-process": [], settled: [] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Bills board could not load. Check the connection and try again.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const total = groups
    ? groups["needs-you"].length + groups["due-soon"].length + groups["in-process"].length + groups.settled.length
    : 0;

  return (
    <section
      aria-label="Expected bills"
      className={cn("rounded-xl border border-line bg-sheet p-4", className)}
    >
      <div className="flex items-start gap-2.5">
        <CalendarClock size={18} className="mt-0.5 shrink-0 text-agency" aria-hidden />
        <div>
          <h2 className="text-[14px] font-medium text-ink">Bills board</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-secondary">
            Saved owner bill records by property. The Expected bills pack prepares a review in Schedule; it does not update these records automatically.
          </p>
        </div>
      </div>
      {error ? <div role="alert" className="mt-2 text-[12.5px] text-danger">
        <p>{error}</p>
        <button type="button" onClick={() => void load()} disabled={loading} className="pm-control mt-2 rounded border border-line bg-sheet px-3 text-[13px] text-ink hover:bg-selected disabled:opacity-40">
          Try again
        </button>
      </div> : null}
      {loading ? (
        <p role="status" className="mt-3 flex items-center gap-2 text-[13px] text-ink-muted">
          <Loader2 size={14} className="animate-spin" aria-hidden /> Loading…
        </p>
      ) : error || groups == null ? null : total === 0 ? (
        <p className="mt-3 text-[13px] text-ink-secondary">No saved bill rows yet. Review pack outputs and held items in Schedule → Results.</p>
      ) : (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {(Object.keys(GROUP_LABEL) as (keyof Groups)[]).map((key) => {
            const rows = groups[key];
            if (!rows.length) return null;
            return (
              <div key={key}>
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
                  {GROUP_LABEL[key]} · {rows.length}
                </h3>
                <ul className="mt-1.5 space-y-1.5">
                  {rows.slice(0, 6).map((bill) => (
                    <li key={bill.id} className="rounded-lg border border-line bg-paper px-2.5 py-1.5 text-[12.5px] text-ink">
                      <span className="font-medium">{bill.kind}</span>
                      <span className="text-ink-muted"> · {bill.status}</span>
                      {bill.note ? <p className="mt-0.5 text-[12px] text-ink-secondary">{bill.note}</p> : null}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
