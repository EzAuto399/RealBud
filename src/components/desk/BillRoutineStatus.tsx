import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, useStore } from '@/state/store';
import { readRoutineResult, type RoutineResult } from '@shared/routine-result';
import { readBillFollowUp, readBillFollowUpPage, type BillFollowUp, type BillFollowUpFilter, type BillFollowUpPage } from '@shared/bill-followups';

const button = 'min-h-11 rounded-lg border border-line px-3 py-2 text-sm disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';
const input = 'min-h-11 w-full rounded-lg border border-line bg-sheet px-3 py-2 text-sm text-ink';
const STATE_LABEL: Record<BillFollowUp['state'], string> = { 'coverage-hold': 'Coverage hold', 'review-hold': 'Source review needed', 'missing-review': 'Missing-arrival review' };

export function BillRoutineResult({ result }: { result: RoutineResult }) {
  return <section aria-label="Latest weekly bills result" className="space-y-2 text-sm">
    <h4 className="font-medium">Latest weekly bills review</h4>
    <p>{result.detail}</p>
    <p className="text-ink-secondary break-words">Checked account: {result.accountId} · {new Date(result.windowStartAt).toLocaleString()} to {new Date(result.windowEndAt).toLocaleString()}</p>
    <p className="text-ink-secondary">Saved {new Date(result.finishedAt).toLocaleString()}. Continue candidates in Saved bill reviews. Received invoice dates and expected arrival windows remain separate in the calendar.</p>
    {result.gaps.length > 0 && <details open><summary className="min-h-11 cursor-pointer text-hold">Coverage needs review</summary><ul className="list-disc pl-5">{result.gaps.map((gap, i) => <li key={i} className="break-words">{gap}</li>)}</ul></details>}
  </section>;
}

export function BillFollowUpList({ page, busy, onDecide, onPlan, onFilter, onMore }: {
  page: BillFollowUpPage; busy: boolean;
  onDecide: (item: BillFollowUp) => void; onPlan: (item: BillFollowUp, owner: string, followUpOn: string) => void;
  onFilter: (filter: BillFollowUpFilter) => void; onMore: () => void;
}) {
  const submit = (item: BillFollowUp) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onPlan(item, String(data.get('owner') ?? '').trim(), String(data.get('followUpOn') ?? ''));
  };
  return <section aria-label="Arrival follow-ups" className="space-y-2 text-sm">
    <div className="flex flex-wrap items-end justify-between gap-2">
      <h4 className="font-medium">Arrival follow-ups · {page.counts.open} open</h4>
      <label className="block">Show<select aria-label="Show follow-ups" className={`${input} mt-1`} value={page.filter} disabled={busy} onChange={e => onFilter(e.target.value as BillFollowUpFilter)}>
        <option value="open">Open</option><option value="resolved">Resolved</option><option value="all">All</option>
      </select></label>
    </div>
    {page.items.length === 0 ? <p className="text-ink-secondary">{page.filter === 'resolved' ? 'No resolved follow-ups.' : 'No follow-ups to show.'}</p> :
    <ul className="divide-y divide-line">{page.items.map(item => {
      const open = item.status === 'open', last = item.history.at(-1);
      return <li key={item.id} data-followup-id={item.id} className="py-2 space-y-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="font-medium break-words">{item.propertyId} · {item.label}</p>
            <p className="text-ink-secondary break-words">{item.from} to {item.to} · {STATE_LABEL[item.state]}{item.owner ? ` · ${item.owner}` : ''}{item.followUpOn ? ` · Follow up ${item.followUpOn}` : ''}{open ? '' : ' · Resolved'}{item.active ? '' : ' · Not in the latest review'}</p>
            {last && <p className="text-ink-secondary break-words">{last.note}</p>}
          </div>
          <button type="button" className={`${button} shrink-0`} disabled={busy} aria-label={`${open ? 'Resolve' : 'Reopen'} ${item.propertyId} · ${item.label}`} onClick={() => onDecide(item)}>{open ? 'Resolve' : 'Reopen'}</button>
        </div>
        <details>
          <summary className="min-h-11 cursor-pointer">{open ? 'Details and assignment' : 'Details'}</summary>
          <p className="break-words">{item.reason}</p>
          {open && <form key={item.revision} aria-label={`Assign ${item.propertyId} · ${item.label}`} className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={submit(item)}>
            <label className="block">Who follows up<input name="owner" maxLength={100} defaultValue={item.owner} className={`${input} mt-1`} disabled={busy} /></label>
            <label className="block">Follow up on<input name="followUpOn" type="date" defaultValue={item.followUpOn} className={`${input} mt-1`} disabled={busy} /></label>
            <button type="submit" className={button} disabled={busy}>Save</button>
          </form>}
          {item.history.length > 1 && <ul className="mt-2 list-disc pl-5 text-ink-secondary">{item.history.slice(0, -1).reverse().map((h, i) => <li key={i} className="break-words">{new Date(h.at).toLocaleDateString()} · {h.note || (h.action === 'resolved' ? 'Resolved' : h.action === 'reopened' ? 'Reopened' : h.action)}</li>)}</ul>}
        </details>
      </li>;
    })}</ul>}
    {page.nextCursor && <button type="button" className={button} disabled={busy} onClick={onMore}>Show more follow-ups</button>}
  </section>;
}

function BillFollowUps({ runId }: { runId: string }) {
  const [page, setPage] = useState<BillFollowUpPage | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const load = useCallback(async (filter: BillFollowUpFilter, cursor?: string) => {
    const query = new URLSearchParams({ filter, limit: '20', ...(cursor ? { cursor } : {}) });
    const next = readBillFollowUpPage(await api(`/api/bill-register/followups?${query}`));
    setPage(prior => cursor && prior ? { ...next, items: [...prior.items, ...next.items] } : next);
  }, []);
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setMessage('');
    try { await work(); }
    catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 409) { setMessage('This follow-up changed. The list has been refreshed.'); await load(page?.filter ?? 'open').catch(() => {}); }
      else setMessage(status ? (error as Error).message : 'We could not confirm that change. Refresh the list to check before trying again.');
    } finally { setBusy(false); }
  };
  const change = (body: Record<string, unknown>) => run(async () => {
    const saved = readBillFollowUp((await api('/api/bill-register/followups', { method: 'PATCH', body: JSON.stringify(body) })).item);
    await load(page?.filter ?? 'open');
    setMessage(saved.status === 'resolved' ? 'Follow-up resolved.' : 'Follow-up saved.');
  });
  useEffect(() => {
    let alive = true;
    void load('open').catch(() => { if (alive) setMessage('Follow-ups could not be loaded. The saved weekly result is unchanged.'); });
    return () => { alive = false; };
  }, [runId, load]);
  if (!page) return message ? <p role="alert" className="text-sm text-hold">{message}</p> : null;
  return <>
    {message && <p role="status" className="text-sm">{message}</p>}
    <BillFollowUpList page={page} busy={busy}
      onDecide={item => void change({ id: item.id, expectedRevision: item.revision, action: item.status === 'open' ? 'resolve' : 'reopen', note: '' })}
      onPlan={(item, owner, followUpOn) => void change({ id: item.id, expectedRevision: item.revision, action: 'plan', owner, followUpOn })}
      onFilter={filter => void run(() => load(filter))}
      onMore={() => void run(() => load(page.filter, page.nextCursor ?? undefined))} />
  </>;
}

export function BillRoutineStatus() {
  const { state } = useStore();
  const latest = state.loopRuns?.find(run => run.loopId === 'weekly-bills');
  const [result, setResult] = useState<RoutineResult | null>(null), [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void api('/api/bill-register/routine').then((value: { result: unknown }) => {
      const result = value.result === null ? null : readRoutineResult(value.result);
      if (alive) { setResult(result); setError(''); }
    }).catch(() => { if (alive) setError('The latest weekly result could not be loaded. Saved bill reviews remain available.'); });
    return () => { alive = false; };
  }, [latest?.id, latest?.status]);
  if (error) return <p role="alert" className="text-sm text-hold">{error}</p>;
  return result ? <div className="space-y-4"><BillRoutineResult result={result} /><BillFollowUps runId={result.runId} /></div>
    : <p className="text-sm text-ink-secondary">Weekly bills review is available in Schedule after agency and invoice-plan review. No recurring run is confirmed yet.</p>;
}
