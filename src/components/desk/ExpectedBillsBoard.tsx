import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarClock, Loader2 } from "lucide-react";

import { cn } from "@/lib/cn";
import { api } from "@/state/store";
import { OpenBillsView } from "../OpenBillsView";
import type { ExpectedBillsPage } from '@shared/source-bills-api';
import { billPageUrl, expectedBillsPage, mergeBillRows } from '@/lib/source-bill-pages';
import { SourceBillsPanel } from "./SourceBillsPanel";

type BillRow = {
  id: string;
  propertyId: string;
  kind: string;
  status: string;
  note: string;
  sourceKind?: string;
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
  settled: "Closed",
};

export function ExpectedBillsBoard({ className, compact = false }: { className?: string; compact?: boolean }) {
  const [page, setPage] = useState<ExpectedBillsPage<BillRow> | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const generation = useRef(0), mounted = useRef(true);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const body = expectedBillsPage<BillRow>(await api(billPageUrl('/api/expected-bills', { origin: compact ? 'all' : 'legacy', limit: 20 }), undefined, { timeoutMs: 15_000 }));
      if (mounted.current && current === generation.current) setPage(body);
    } catch (cause) {
      if (mounted.current && current === generation.current) setError(cause instanceof Error ? cause.message : "Bills board could not load. Check the connection and try again.");
    } finally {
      if (mounted.current && current === generation.current) setLoading(false);
    }
  }, [compact]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; generation.current++; }; }, [load]);
  const more = async () => {
    if (!page?.nextCursor || loading) return;
    const current = generation.current, cursor = page.nextCursor; setLoading(true); setError('');
    try {
      const next = expectedBillsPage<BillRow>(await api(billPageUrl('/api/expected-bills', { origin: compact ? 'all' : 'legacy', limit: 20, cursor })));
      if (!mounted.current || current !== generation.current) return;
      if (next.nextCursor === cursor) throw new Error('The bill page changed. Refresh before loading more.');
      const groups = Object.fromEntries(Object.keys(GROUP_LABEL).map(key => [key, mergeBillRows(page.groups[key as keyof Groups], next.groups[key as keyof Groups])])) as Groups;
      setPage({ ...next, bills: mergeBillRows(page.bills, next.bills), groups });
    } catch (cause) { if (mounted.current && current === generation.current) setError(cause instanceof Error ? cause.message : 'More bills could not be loaded.'); }
    finally { if (mounted.current && current === generation.current) setLoading(false); }
  };
  const groups = page?.groups ?? null;

  const total = page?.total ?? 0;

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
            Saved bills by property, with source review and a calendar for confirmed due dates and expected arrivals.
          </p>
        </div>
      </div>
      {compact ? <div className="mt-3 space-y-2"><p className="text-sm text-ink-secondary">{loading ? 'Checking saved bills…' : error ? 'Saved bill count could not be refreshed. Open the full view to try again.' : groups ? `${total} saved bill records. Open the full view to review source messages, due dates and expected arrivals.` : 'Saved bills are unavailable. Open the full view to review recovery details.'}</p><OpenBillsView /></div> : <>
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
        <p className="mt-3 text-[13px] text-ink-secondary">No earlier bill-register records. Source-reviewed bills and calendar appear below.</p>
      ) : (
        <div className="mt-3 space-y-3"><p className="text-sm text-ink-secondary">Earlier bill register · {page?.bills.length} of {total} records loaded.</p><div className="grid gap-3 sm:grid-cols-2">
          {(Object.keys(GROUP_LABEL) as (keyof Groups)[]).map((key) => {
            const rows = groups[key];
            if (!rows.length) return null;
            return (
              <div key={key}>
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
                  {GROUP_LABEL[key]} · {rows.length} loaded
                </h3>
                <ul className="mt-1.5 space-y-1.5">
                  {rows.map((bill) => (
                    <li key={bill.id} className="rounded-lg border border-line bg-paper px-2.5 py-1.5 text-[12.5px] text-ink">
                      <span className="font-medium">{bill.kind}</span>
                      <span className="text-ink-muted"> · {bill.status}</span>
                      <p className="text-xs text-ink-muted">{bill.propertyId} · Earlier bill register</p>
                      {bill.note ? <p className="mt-0.5 text-[12px] text-ink-secondary">{bill.note}</p> : null}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>{page?.nextCursor && <button className="min-h-11 rounded border border-line px-3 text-sm" disabled={loading} onClick={() => void more()}>Load more earlier bills</button>}</div>
      )}
      <SourceBillsPanel onSaved={() => void load()} />
      </>}
    </section>
  );
}
