import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/state/store';
import { fmtDateTime } from '@/lib/au';
import { attendedRunLabel, jobRunModeLabel, jobRunStatusChip, loopRunStatusLabel, preparedJobText, safeJobRunDetail } from '@/lib/job-run';
import type { JobRun } from '@/lib/desk';
import type { LoopRun } from '@/lib/routines';

type Run = JobRun | LoopRun;
type Page = { runs: Run[]; nextCursor: string | null };
const isJob = (run: Run): run is JobRun => 'jobId' in run;

/** `GET /api/job-runs/:id/cost`: Modelvia's own charge, summed on the server. */
export type RunCost = { state: 'none' } | { state: 'priced'; requests: number; chargedNanoAud: string } | { state: 'pending' | 'not-priced' | 'unavailable'; requests: number };

export function readRunCost(value: unknown): RunCost | null {
  if (!value || typeof value !== 'object') return null;
  const cost = value as Record<string, unknown>;
  if (cost.state === 'none') return { state: 'none' };
  if (!Number.isSafeInteger(cost.requests) || (cost.requests as number) < 0) return null;
  const requests = cost.requests as number;
  if (cost.state === 'priced') return typeof cost.chargedNanoAud === 'string' && /^(0|[1-9][0-9]{0,20})$/.test(cost.chargedNanoAud) ? { state: 'priced', requests, chargedNanoAud: cost.chargedNanoAud } : null;
  return cost.state === 'pending' || cost.state === 'not-priced' || cost.state === 'unavailable' ? { state: cost.state, requests } : null;
}

/** nanoAUD to whole cents; a charge below one cent never reads as free. */
function audFromNano(nano: string): string {
  const value = BigInt(nano);
  if (value > 0n && value < 5_000_000n) return 'under A$0.01';
  const cents = (value + 5_000_000n) / 10_000_000n;
  return `A$${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

/** One quiet line, or nothing when the run made no AI requests. */
export function aiCostText(cost: RunCost | null): string | null {
  if (!cost) return 'AI: cost unavailable';
  if (cost.state === 'none') return null;
  const requests = `AI: ${cost.requests} ${cost.requests === 1 ? 'request' : 'requests'}`;
  if (cost.state === 'priced') return `${requests} · ${audFromNano(cost.chargedNanoAud)}`;
  if (cost.state === 'pending') return `${requests} · cost pending`;
  if (cost.state === 'not-priced') return `${requests} · not priced for this office`;
  return `${requests} · cost unavailable`;
}

/** Read only once its run is opened; a failure never breaks the run view. */
function AiCostLine({ runId }: { runId: string }) {
  const [text, setText] = useState<string | null>('AI: checking cost…');
  useEffect(() => {
    let live = true;
    api(`/api/job-runs/${encodeURIComponent(runId)}/cost`, undefined, { timeoutMs: 20000 })
      .then(data => { if (live) setText(aiCostText(readRunCost(data?.cost))); }, () => { if (live) setText('AI: cost unavailable'); });
    return () => { live = false; };
  }, [runId]);
  return text ? <p className="text-[12px] text-ink-muted">{text}</p> : null;
}

function HistoryPages({ kind, filter }: { kind: 'jobs' | 'routines'; filter?: string }) {
  const [page, setPage] = useState<Page | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [previous, setPrevious] = useState<(string | null)[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const flight = useRef(0);
  const load = useCallback(async (next: string | null, trail: (string | null)[]) => {
    const request = ++flight.current; setBusy(true); setError('');
    try {
      const query = new URLSearchParams({ limit: '20', ...(filter ? { [kind === 'jobs' ? 'jobId' : 'loopId']: filter } : {}), ...(next ? { cursor: next } : {}) });
      const data = await api(`/api/${kind === 'jobs' ? 'job-runs' : 'loops'}/history?${query}`, undefined, { timeoutMs: 15000 });
      if (flight.current !== request) return;
      if (!Array.isArray(data.runs) || !(data.nextCursor === null || typeof data.nextCursor === 'string')) throw new Error('Saved history could not be read. Please refresh it.');
      setPage(data); setCursor(next); setPrevious(trail);
    } catch (cause) { if (flight.current === request) setError(cause instanceof Error ? cause.message : 'Saved history could not load.'); }
    finally { if (flight.current === request) setBusy(false); }
  }, [kind, filter]);
  useEffect(() => { void load(null, []); return () => { flight.current++; }; }, [load]);
  return <div className="mt-3 space-y-3" aria-busy={busy}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-[13px] text-ink-muted">{page ? `Page ${previous.length + 1} · ${page.runs.length} ${page.runs.length === 1 ? 'result' : 'results'}` : 'Saved results'}{busy ? ' · Loading…' : ''}</p>
      <button type="button" className="pm-control rounded border border-line px-3 disabled:opacity-40" disabled={busy} onClick={() => void load(null, [])}>Refresh history</button>
    </div>
    {error && <p role="alert" className="text-[13px] text-danger">{error} {page ? 'The last loaded page is still shown.' : ''}</p>}
    {!page && busy && <p role="status" className="text-[13px] text-ink-muted">Loading saved history…</p>}
    {page?.runs.length === 0 && <p className="text-[13px] text-ink-secondary">No saved {kind === 'jobs' ? 'job' : 'routine'} results yet.</p>}
    <ul className="divide-y divide-line">
      {page?.runs.map(run => { const costRunId = isJob(run) ? (run.usage ? run.id : undefined) : run.jobRunId; return <li key={run.id} className="py-3">
        <details onToggle={event => { if (event.currentTarget.open && !opened.has(run.id)) setOpened(previous => new Set(previous).add(run.id)); }}>
          <summary className="cursor-pointer text-[13px]">
            <span className="break-words font-medium">{isJob(run) ? run.jobTitle : run.loopName}</span>
            <span className="ml-2 text-ink-secondary">{isJob(run) ? (attendedRunLabel(run) ?? jobRunStatusChip(run.status)).label : loopRunStatusLabel(run.status).label}</span>
            <span className="mt-1 block text-[12px] text-ink-muted">{isJob(run) ? `${jobRunModeLabel(run.mode)} · ` : ''}{fmtDateTime(run.startedAt ?? run.createdAt)}</span>
          </summary>
          <div className="mt-3 space-y-2 rounded border border-line bg-inset/40 p-3 text-[13px] text-ink-secondary">
            <p className="whitespace-pre-wrap break-words">{isJob(run) ? safeJobRunDetail(run.detail, 32000) : run.detail || 'No detail recorded.'}</p>
            {isJob(run) && preparedJobText(run) && <pre className="whitespace-pre-wrap break-words font-sans">{preparedJobText(run)}</pre>}
            {isJob(run) && run.evidence.length > 0 && <details><summary className="cursor-pointer">Sources and notes ({run.evidence.length})</summary><ol className="mt-2 list-decimal space-y-2 pl-5">{run.evidence.map((evidence, index) => <li key={index} className="whitespace-pre-wrap break-words">{evidence.note}<span className="block text-[11px] text-ink-muted">{fmtDateTime(evidence.at)}</span></li>)}</ol></details>}
            {costRunId && opened.has(run.id) && <AiCostLine runId={costRunId} />}
            <p className="break-all text-[11px] text-ink-muted">Record {run.id}</p>
          </div>
        </details>
      </li>; })}
    </ul>
    {page && <div className="flex flex-wrap gap-2">
      <button type="button" className="pm-control rounded border border-line px-3 disabled:opacity-40" disabled={busy || !previous.length} onClick={() => void load(previous.at(-1) ?? null, previous.slice(0, -1))}>Newer results</button>
      <button type="button" className="pm-control rounded border border-line px-3 disabled:opacity-40" disabled={busy || !page.nextCursor} onClick={() => void load(page.nextCursor, [...previous, cursor])}>Older results</button>
    </div>}
  </div>;
}

/** History is read on demand and does not replace the live activity projection.
 * With a job or loop it shows only that job's earlier results; without one it
 * browses every saved result, including jobs that were removed. */
export function ExecutionHistory({ jobId, loopId, label }: { jobId?: string; loopId?: string; label?: string } = {}) {
  const scoped = jobId ? { kind: 'jobs' as const, filter: jobId } : loopId ? { kind: 'routines' as const, filter: loopId } : null;
  const [open, setOpen] = useState(false), [kind, setKind] = useState<'jobs' | 'routines'>('jobs');
  return <details className="border-t border-line pt-2" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="pm-control flex cursor-pointer items-center text-[13px] font-medium">{label ?? (scoped ? 'Earlier results' : 'Browse saved history')}</summary>
    {open && <div>
      <p className="mt-2 text-[13px] text-ink-muted">Read earlier results and their evidence. Opening history does not run work again.</p>
      {scoped ? <HistoryPages key={`${scoped.kind}:${scoped.filter}`} kind={scoped.kind} filter={scoped.filter} /> : <>
        <label className="mt-3 flex flex-wrap items-center gap-2 text-[13px]">History to show<select className="pm-control rounded border border-line bg-paper px-3" value={kind} onChange={event => setKind(event.target.value as 'jobs' | 'routines')}><option value="jobs">Jobs</option><option value="routines">Routines</option></select></label>
        <HistoryPages key={kind} kind={kind} />
      </>}
    </div>}
  </details>;
}
