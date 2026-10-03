import { useEffect, useId, useRef, useState } from 'react';
import type { MailTaskPage, MailWorkItem, MailWorkspaceMetadata } from '@shared/mail-ingestion';
import { MAX_WORKSPACE_TABS } from '@shared/workspace-tabs';
import { mailPageUrl, readMailTaskPage } from '@/lib/mail-pages';
import { workspaceViewHash } from '@/lib/app-route';
import { useWorkspaceTabs } from '@/lib/workspace-tabs';
import { api, useStore } from '@/state/store';

/** Same snapshot shape MailWorkPanel reads from GET /api/mail-workspace. */
export type MailCardSnapshot = MailWorkspaceMetadata & {
  schedule?: { revision: number };
  operation?: { state: 'running' | 'failed' | 'complete' | 'interrupted'; detail: string; requestId?: string } | null;
};
export type MailCardTab = 'open' | 'waiting' | 'done';
type Request = (path: string, init?: RequestInit, opts?: { timeoutMs?: number }) => Promise<any>;

const TABS: Record<MailCardTab, string> = { open: 'Needs you', waiting: 'Waiting', done: 'Done' };
const PRIMARY: Partial<Record<MailWorkItem['disposition'], string>> = { 'reply-review': 'Review reply', 'urgent-review': 'Review now', 'action-review': 'Review', hold: 'Check source' };
const ROWS = 5;
const control = 'min-h-10 rounded-xl border border-line px-3 text-sm text-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';
const link = 'min-h-10 px-1 text-sm text-agency underline underline-offset-2 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';
const shortDate = (at: number) => { try { return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(at); } catch { return 'the start of the window'; } };

/** Hide the card when mail work isn't set up: no collection and no saved items. */
export const mailCardVisible = (snapshot: MailCardSnapshot | null): snapshot is MailCardSnapshot =>
  !!snapshot && snapshot.version === 2 && !!snapshot.counts && (snapshot.latestScan !== null || snapshot.counts.total > 0);
/** A scan that didn't finish cleanly can't establish coverage. */
export const mailCoveragePartial = (snapshot: MailCardSnapshot) =>
  !!snapshot.latestScan && ['partial', 'failed', 'interrupted'].includes(snapshot.latestScan.status);
export const mailNeedsPreparing = (snapshot: MailCardSnapshot) =>
  !snapshot.latestReview || (!!snapshot.latestScan && snapshot.latestReview.sourceReceiptId !== snapshot.latestScan.id);
/** Same PATCH MailWorkPanel sends: the item's revision guards against a concurrent edit. */
export const setMailItemStatus = (request: Request, item: MailWorkItem, status: 'open' | 'done') =>
  request(`/api/mail-workspace/items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ expectedRevision: item.revision, status }) });

export function MailPriorityCardView({ snapshot, page, tab, showAll, busy, preparing, uncertainReview, notice, error, onTab, onShowAll, onOpen, onDone, onPrepare }: {
  snapshot: MailCardSnapshot | null; page: MailTaskPage | null; tab: MailCardTab; showAll: boolean; busy: boolean; preparing: boolean; uncertainReview: boolean;
  notice: string; error: string; onTab: (tab: MailCardTab) => void; onShowAll: () => void; onOpen: () => void; onDone: (item: MailWorkItem) => void; onPrepare: () => void;
}) {
  const panelId = useId();
  if (!mailCardVisible(snapshot)) return null;
  const counts = page && page.revision >= snapshot.revision ? page.counts : snapshot.counts;
  const current = page?.group === tab ? page : null, items = current?.items ?? [];
  const visible = showAll ? items : items.slice(0, ROWS), scan = snapshot.latestScan;
  return <section aria-label="Mail priorities" className="space-y-3 rounded-xl border border-line bg-sheet p-4 text-sm text-ink" aria-busy={busy}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-[15px] font-medium">Mail priorities</h2>
      <div role="tablist" aria-label="Mail priorities filter" className="flex gap-1">
        {(Object.keys(TABS) as MailCardTab[]).map(value => <button key={value} type="button" role="tab" id={`${panelId}-${value}`} aria-selected={tab === value} aria-controls={panelId}
          className={`${control} ${tab === value ? 'border-agency bg-selected' : '!border-transparent text-ink-muted hover:text-ink'}`} onClick={() => onTab(value)}>{TABS[value]} {counts[value]}</button>)}
      </div>
    </div>
    <div role="tabpanel" id={panelId} aria-labelledby={`${panelId}-${tab}`}>
      {!current ? <p className="text-ink-muted">Checking saved mail…</p> : !items.length ? <p className="text-ink-muted">Nothing here.</p> :
        <ul className="divide-y divide-line">{visible.map(item => {
          const primary = PRIMARY[item.disposition] ?? 'Open', subject = item.subject || 'Untitled conversation';
          return <li key={item.id} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{subject}{item.priority === 'high' && <span className="ml-2 text-hold">High priority</span>}</p>
              <p className="truncate text-agency">{item.nextAction}</p>
            </div>
            {tab !== 'done' && <button type="button" className={`${control} shrink-0`} aria-label={`${primary}: ${subject}`} onClick={onOpen}>{primary}</button>}
            <button type="button" className={`${control} shrink-0`} aria-label={`${tab === 'done' ? 'Reopen' : 'Done'}: ${subject}`} disabled={busy} onClick={() => onDone(item)}>{tab === 'done' ? 'Reopen' : 'Done'}</button>
          </li>;
        })}</ul>}
      {!showAll && current && current.total > ROWS && <button type="button" className={link} onClick={onShowAll}>Show all {current.total}</button>}
    </div>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {scan && mailCoveragePartial(snapshot) && <p className="text-hold">Read {scan.messageCount} emails since {shortDate(scan.windowStartAt)}. Some couldn’t be read. <button type="button" className={link} onClick={onOpen}>See which</button></p>}
      {(mailNeedsPreparing(snapshot) || uncertainReview) && <button type="button" className={control} disabled={busy || preparing || !Number.isSafeInteger(snapshot.schedule?.revision)} onClick={onPrepare}>{uncertainReview ? 'Check and retry' : 'Prepare priorities'}</button>}
      <button type="button" className={`${link} ml-auto`} onClick={onOpen}>Open full view</button>
    </div>
    <p className="text-ink-muted">Nothing is sent without your OK.</p>
    {error && <p role="alert" className="text-hold">{error}</p>}
    <p role="status" className="text-ink-muted">{preparing ? 'Bud is preparing priorities…' : snapshot.operation?.state === 'failed' || snapshot.operation?.state === 'interrupted' ? `Last preparation ${snapshot.operation.state}. ${snapshot.operation.detail}` : notice}</p>
  </section>;
}

/** Daily Mail priorities on Work. Reuses MailWorkPanel's endpoints, revision guard and
 * review-request reconciliation; detailed editing stays in the full saved view. */
export function MailPriorityCard({ className = '' }: { className?: string }) {
  const tabs = useWorkspaceTabs(), { dispatch } = useStore();
  const [snapshot, setSnapshot] = useState<MailCardSnapshot | null>(null), [page, setPage] = useState<MailTaskPage | null>(null);
  const [tab, setTab] = useState<MailCardTab>('open'), [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [uncertainReview, setUncertainReview] = useState(false);
  const alive = useRef(true), pending = useRef(false), view = useRef({ tab, showAll }), pageSeq = useRef(0), refreshSeq = useRef(0), reviewRequest = useRef<{ requestId: string; expectedRevision: number } | null>(null);
  view.current = { tab, showAll };

  const loadPage = async (group: MailCardTab, all: boolean) => {
    const sequence = ++pageSeq.current;
    const next = readMailTaskPage(await api(mailPageUrl('/api/mail-workspace/items', { group, limit: all ? 100 : ROWS })), { group, q: '' });
    if (alive.current && sequence === pageSeq.current) setPage(next);
  };
  const refresh = async () => {
    const sequence = ++refreshSeq.current, next: MailCardSnapshot = await api('/api/mail-workspace');
    if (next?.version !== 2 || !next.counts) throw new Error('The saved mail summary could not be checked. Refresh before continuing.');
    if (alive.current && sequence === refreshSeq.current) {
      setSnapshot(next);
      if (reviewRequest.current && next.operation?.requestId === reviewRequest.current.requestId) { reviewRequest.current = null; setUncertainReview(false); setNotice('The saved receipt confirms this request.'); }
      if (mailCardVisible(next)) await loadPage(view.current.tab, view.current.showAll);
    }
    return next;
  };
  // Not set up, 404 or no permission: stay hidden (snapshot stays null), never an empty shell.
  useEffect(() => { alive.current = true; void refresh().catch(() => undefined); return () => { alive.current = false; pageSeq.current++; refreshSeq.current++; }; }, []);
  useEffect(() => { if (snapshot) void loadPage(tab, showAll).catch(cause => { if (alive.current) setError(cause instanceof Error ? cause.message : 'Saved mail could not be read.'); }); }, [tab, showAll]);
  const preparing = snapshot?.operation?.state === 'running' || snapshot?.latestScan?.status === 'running';
  useEffect(() => {
    if (!preparing) return;
    const timer = setInterval(() => { if (!pending.current) void refresh().catch(() => { if (alive.current) setError('Still preparing. The latest result could not be refreshed; don’t start another until it’s known.'); }); }, 5_000);
    return () => clearInterval(timer);
  }, [preparing]);

  const run = async (work: () => Promise<void>) => {
    if (pending.current) return; pending.current = true; setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'The change could not be confirmed. Refresh before retrying.'); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const done = (item: MailWorkItem) => void run(async () => {
    const status = item.status === 'done' ? 'open' : 'done';
    try { await setMailItemStatus(api, item, status); }
    catch (cause) {
      // A conflict or lost response may hide a committed change: show the saved state, keep the person informed.
      await refresh().catch(() => undefined);
      throw (cause as { status?: number })?.status === 409 ? new Error('This item changed — check it again.') : cause;
    }
    await refresh();
    if (alive.current) setNotice(status === 'done' ? 'Marked done here. Gmail is unchanged.' : 'Reopened. Nothing was sent.');
  });
  // Mirrors MailWorkPanel.requestReview: a lost response keeps the same request ID so a retry only reconciles it.
  const prepare = () => void run(async () => {
    const current = await refresh();
    if (uncertainReview && !reviewRequest.current) return;
    if (current.operation?.state === 'running' || current.latestScan?.status === 'running') throw new Error('Priorities are already being prepared.');
    if (!Number.isSafeInteger(current.schedule?.revision)) throw new Error('Mail priorities need checking in Schedule before preparing.');
    const request = reviewRequest.current ?? { requestId: crypto.randomUUID(), expectedRevision: current.schedule!.revision };
    reviewRequest.current = request;
    try {
      const result = await api('/api/mail-workspace/review', { method: 'POST', body: JSON.stringify(request) }, { timeoutMs: 30_000 });
      if (!result?.run?.id || result.run.requestId !== request.requestId) throw new Error('The preparation receipt did not match this request.');
      reviewRequest.current = null; if (alive.current) { setUncertainReview(false); setNotice('Preparation started.'); }
    } catch (cause) {
      const status = (cause as { status?: number })?.status;
      if (status && status >= 400 && status < 500) { reviewRequest.current = null; if (alive.current) setUncertainReview(false); }
      else {
        if (alive.current) setUncertainReview(true);
        try { if ((await refresh()).operation?.requestId === request.requestId) return; } catch { /* keep the request for reconciliation */ }
      }
      throw cause;
    }
    await refresh();
  });
  // Same as MailWorkPanel's OpenMailView: reuse the saved mail view, or add one.
  const open = () => void run(async () => {
    const state = tabs.data?.state;
    if (!state) throw new Error('Saved views are still loading. Try again in a moment.');
    const show = (id: string) => { window.location.hash = workspaceViewHash(id); dispatch({ type: 'showWorkspaceTab', id }); };
    const existing = state.tabs.find(saved => saved.view.kind === 'mail');
    if (existing) {
      if (!existing.visible) await tabs.save(state.tabs.map(saved => saved.id === existing.id ? { ...saved, visible: true } : saved), state.revision);
      return show(existing.id);
    }
    if (state.tabs.length >= MAX_WORKSPACE_TABS) throw new Error('Your saved views are full. Remove an unused one in Manage views, then try again.');
    const id = `view-${crypto.randomUUID()}`;
    await tabs.save([...state.tabs, { id, label: 'Mail priorities', visible: true, view: { kind: 'mail', filter: 'open' } }], state.revision);
    show(id);
  });

  if (!mailCardVisible(snapshot)) return null;
  return <div className={className}><MailPriorityCardView snapshot={snapshot} page={page} tab={tab} showAll={showAll} busy={busy} preparing={preparing} uncertainReview={uncertainReview}
    notice={notice} error={error} onTab={next => { setTab(next); setShowAll(false); }} onShowAll={() => setShowAll(true)} onOpen={open} onDone={done} onPrepare={prepare} /></div>;
}
