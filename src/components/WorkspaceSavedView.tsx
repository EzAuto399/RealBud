import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceTab } from '@shared/workspace-tabs';
import type { DeskSnapshot, Recipe } from '@shared/contracts';
import { api, useStore } from '@/state/store';
import { buildDeskQueue, type QueueFilter } from '@/lib/desk-queue';
import { openDeskCase } from '@/lib/desk-view-state';
import { jobPlanFields } from '@/lib/job-plan';
import { hasUnfinishedJobDraft } from '@/lib/work-continuation';
import { WORKSPACE_FILTER_LABELS, WORKSPACE_VIEW_LABELS } from '@/lib/workspace-tabs';
import { ExpectedBillsBoard } from './desk/ExpectedBillsBoard';
import type { ExpectedBillGroup, ExpectedBillsPage } from '@shared/source-bills-api';
import { billPageUrl, expectedBillsPage, mergeBillRows } from '@/lib/source-bill-pages';
import { SourceBillsPanel } from './desk/SourceBillsPanel';
import { OpenBillsView } from './OpenBillsView';
import { SharedWorkPanel } from './desk/SharedWorkPanel';
import { MailWorkPanel, type MailWorkGroup } from './desk/MailWorkPanel';

const button = 'min-h-11 rounded border border-line bg-sheet px-3 py-2 text-[14px] text-ink hover:bg-selected disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-agency';
type Bill = { id: string; propertyId: string; kind: string; status: string; note: string; sourceKind?: string };
type Data = { kind: 'tasks'; snapshot: DeskSnapshot } | { kind: 'jobs'; recipes: Recipe[] };
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function parseData(kind: WorkspaceTab['view']['kind'], value: unknown): Data {
  if (!isRecord(value)) throw new Error('The work list was incomplete. Refresh to check again.');
  if (kind === 'tasks' && Array.isArray(value.properties) && Array.isArray(value.drafts)) return { kind, snapshot: value as unknown as DeskSnapshot };
  if (kind === 'jobs' && Array.isArray(value.recipes) && value.recipes.every(item => isRecord(item) && typeof item.id === 'string' && typeof item.title === 'string' && ['shadow', 'active', 'paused'].includes(String(item.status)))) return { kind, recipes: value.recipes as Recipe[] };
  throw new Error('The work list was incomplete. Refresh to check again.');
}
export function WorkspaceSavedView({ tab }: { tab: WorkspaceTab }) {
  const { state, dispatch } = useStore();
  const [data, setData] = useState<Data | null>(null), [error, setError] = useState('');
  const [loading, setLoading] = useState(true), [query, setQuery] = useState('');
  const [page, setPage] = useState(0), [checked, setChecked] = useState<number | null>(null);
  const alive = useRef(true), generation = useRef(0);
  const load = useCallback(async () => {
    if (tab.view.kind === 'shared-work' || tab.view.kind === 'mail' || tab.view.kind === 'bills') { setLoading(false); return; }
    const request = ++generation.current;
    setLoading(true); setError('');
    try {
      const endpoint = tab.view.kind === 'tasks' ? '/api/desk' : tab.view.kind === 'jobs' ? '/api/recipes' : '/api/expected-bills';
      const next = parseData(tab.view.kind, await api(endpoint));
      if (alive.current && generation.current === request) { setData(next); setChecked(Date.now()); setPage(0); }
    } catch (cause) {
      if (alive.current && generation.current === request) { setData(null); setError(cause instanceof Error ? cause.message : 'Work could not be loaded.'); }
    } finally { if (alive.current && generation.current === request) setLoading(false); }
  }, [tab.view.kind, tab.view.filter]);
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; generation.current++; }; }, [load]);
  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (data?.kind === 'tasks') return buildDeskQueue(data.snapshot).filter(item => tab.view.filter === 'all' || item.bucket === tab.view.filter as QueueFilter).filter(item => !needle || `${item.address} ${item.action} ${item.meta}`.toLocaleLowerCase().includes(needle)).map(item => ({ id: item.id, title: item.action, detail: item.address, note: item.holdReason ?? item.meta, status: WORKSPACE_FILTER_LABELS[item.bucket], open: () => { openDeskCase(item.id); dispatch({ type: 'showDesk' }); }, action: 'Open case' }));
    if (data?.kind === 'jobs') return data.recipes.filter(item => tab.view.filter === 'all' || item.status === tab.view.filter).filter(item => !needle || `${item.title} ${item.description}`.toLocaleLowerCase().includes(needle)).map(item => ({ id: item.id, title: item.title, detail: item.description, note: item.schedule ? `Scheduled at ${item.schedule.time}` : 'No recurring schedule', status: WORKSPACE_FILTER_LABELS[item.status], open: () => {
      if (state.jobDraftBusy || hasUnfinishedJobDraft(state.jobDraft)) {
        dispatch({ type: 'error', message: 'Your unfinished job plan is kept. Save or cancel its changes in Schedule before opening another job.' });
      } else {
        dispatch({ type: 'jobDraft', draft: { text: item.description, plan: item, fields: jobPlanFields(item), saved: true } });
      }
      dispatch({ type: 'showRoutines' });
    }, action: 'Open job' }));

    return [];
  }, [data, query, tab.view.filter, dispatch, state.jobDraft, state.jobDraftBusy]);
  const pageCount = Math.max(1, Math.ceil(rows.length / 25));
  return <main className="h-full min-w-0 flex-1 overflow-y-auto bg-paper p-4 sm:p-6">
    <div className="mx-auto max-w-4xl space-y-5"><header><p className="text-[13px] text-ink-muted">Saved view · {WORKSPACE_VIEW_LABELS[tab.view.kind]}</p><h1 className="break-words text-2xl font-semibold text-ink">{tab.label}</h1><p className="mt-2 text-[14px] text-ink-secondary">{WORKSPACE_FILTER_LABELS[tab.view.filter]} · {tab.view.kind === 'shared-work' ? 'Your permitted office work' : 'This private workspace'}. Opening a view does not start a job.</p></header>
      <div className="flex flex-wrap gap-2"><button className={button} onClick={() => dispatch({ type: 'showWorkspaceTab' })}>Manage views</button>{!['shared-work', 'mail', 'bills'].includes(tab.view.kind) && <button className={button} disabled={loading} onClick={() => void load()}>Refresh work</button>}</div>
      {tab.view.kind === 'bills' ? tab.view.filter === 'all' ? <ExpectedBillsBoard key={tab.id} /> : <SavedBillsList key={`${tab.id}:${tab.view.filter}`} group={tab.view.filter as ExpectedBillGroup} /> : tab.view.kind === 'shared-work' ? <SharedWorkPanel initialExpanded initialFilter={tab.view.filter as 'with-me' | 'by-me'} /> : tab.view.kind === 'mail' ? <MailWorkPanel key={`${tab.id}:${tab.view.filter}`} initialGroup={tab.view.filter as MailWorkGroup} /> : <>
        <label className="block text-[14px]"><span className="mb-1 block">Find in this view</span><input className="min-h-11 w-full rounded border border-line bg-sheet px-3 py-2 focus-visible:outline-2 focus-visible:outline-agency" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} type="search" /></label>
        {loading && <p role="status">Checking work…</p>}
        {error && <p role="alert" className="text-danger">{error} Use Refresh work to try again.</p>}
        {data?.kind === 'tasks' && data.snapshot.recovery?.active && <p role="alert" className="rounded border border-hold p-3">The local book needs recovery. Open Desk to review its recovery steps.</p>}
        {data?.kind === 'tasks' && data.snapshot.demo && <p className="text-[14px] text-hold">These are sample records.</p>}
        {!loading && !error && data && rows.length === 0 && <div className="rounded border border-line bg-sheet p-5"><h2 className="font-medium">Nothing matches this view</h2><p className="mt-2 text-[14px] text-ink-secondary">Try another search or edit the view’s filter. No records were removed.</p></div>}
        {!error && data && <><p className="text-[13px] text-ink-muted">{rows.length} matching {rows.length === 1 ? 'record' : 'records'}{checked ? ` · Checked ${new Date(checked).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</p><ul className="divide-y divide-line rounded-lg border border-line bg-sheet px-4">{rows.slice(page * 25, (page + 1) * 25).map(row => <li key={row.id} className="space-y-2 py-4"><div className="flex flex-wrap items-start justify-between gap-3"><h2 className="min-w-0 break-words font-medium text-ink">{row.title}</h2><span className="text-[13px] text-ink-muted">{row.status}</span></div><p className="break-words text-[14px] text-ink-secondary">{row.detail}</p>{row.note && <p className="break-words text-[14px] text-ink-secondary">{row.note}</p>}<button className={button} onClick={row.open}>{row.action}<span className="sr-only">: {row.title}</span></button></li>)}</ul>{pageCount > 1 && <div className="flex items-center gap-3"><button className={button} disabled={page === 0} onClick={() => setPage(old => old - 1)}>Previous</button><span className="text-[13px]">Page {page + 1} of {pageCount}</span><button className={button} disabled={page >= pageCount - 1} onClick={() => setPage(old => old + 1)}>Next</button></div>}</>}
      </>}
    </div>
  </main>;
}

/** Filtered shortcuts query the full retained register, never a loaded page. */
function SavedBillsList({ group }: { group: ExpectedBillGroup }) {
  const [page, setPage] = useState<ExpectedBillsPage<Bill> | null>(null), [query, setQuery] = useState(''), [error, setError] = useState('');
  const [loading, setLoading] = useState(true), [selected, setSelected] = useState<string | null>(null);
  const generation = useRef(0), alive = useRef(true);
  const load = useCallback(async (cursor?: string) => {
    const current = cursor ? generation.current : ++generation.current;
    setLoading(true); setError('');
    try {
      const next = expectedBillsPage<Bill>(await api(billPageUrl('/api/expected-bills', { group, query: query.trim(), cursor, limit: 20 })));
      if (!alive.current || current !== generation.current) return;
      if (cursor && next.nextCursor === cursor) throw new Error('This bill page changed. Refresh before loading more.');
      setPage(previous => cursor ? previous?.nextCursor === cursor ? { ...next, bills: mergeBillRows(previous.bills, next.bills) } : previous : next);
    } catch (cause) { if (alive.current && current === generation.current) setError(cause instanceof Error ? cause.message : 'Bills could not be loaded.'); }
    finally { if (alive.current && current === generation.current) setLoading(false); }
  }, [group, query]);
  useEffect(() => {
    alive.current = true; generation.current++; setPage(null); setLoading(true);
    const timer = window.setTimeout(() => { void load(); }, 200);
    return () => { alive.current = false; generation.current++; window.clearTimeout(timer); };
  }, [load]);
  return <section aria-label="Saved bills list" className="space-y-4">
    <div className="flex flex-wrap gap-2"><OpenBillsView /><button className={button} disabled={loading} onClick={() => void load()}>Refresh work</button></div>
    <label className="block text-sm"><span className="mb-1 block">Find in this view</span><input type="search" maxLength={200} className="min-h-11 w-full rounded border border-line bg-sheet p-3" value={query} onChange={event => setQuery(event.target.value)} /></label>
    <p className="text-sm text-ink-secondary">Search checks all retained bills matching this view, including earlier bill-register records.</p>
    {loading && <p role="status">Checking bill records…</p>}{error && <p role="alert" className="text-danger">{error}</p>}
    {page && <><p className="text-sm text-ink-secondary">{page.bills.length} of {page.total} matching records loaded · {page.counts.source} source-reviewed and {page.counts.legacy} earlier records.</p>
      {!page.bills.length && <p>No bills on this loaded page.{page.nextCursor ? ' More pages are available below.' : ''}</p>}
      <ul className="divide-y divide-line rounded-lg border border-line bg-sheet px-4">{page.bills.map(row => <li key={row.id} className="space-y-2 py-4"><h2 className="break-words font-medium">{row.kind}</h2><p className="text-sm text-ink-secondary break-words">{row.propertyId} · {row.status}</p>{row.note && <p className="text-sm break-words">{row.note}</p>}{row.sourceKind === 'mail-reviewed' ? <button className={button} disabled={selected !== null && selected !== row.id} onClick={() => setSelected(row.id)}>Open received bill<span className="sr-only">: {row.kind}</span></button> : <p className="text-sm text-ink-secondary">Earlier bill register · retained in the full bills view.</p>}</li>)}</ul>
      {page.nextCursor && <button className={button} disabled={loading} onClick={() => void load(page.nextCursor!)}>Load more matching bills</button>}</>}
    {selected && <div className="space-y-3"><button className={button} onClick={() => setSelected(null)}>Close selected review and keep draft</button><SourceBillsPanel key={selected} initialBillId={selected} onSaved={() => void load()} /></div>}
  </section>;
}
