import { useEffect, useRef, useState } from 'react';
import type { MailThread, MailWorkItem, MailWorkspaceMetadata, MailTaskPage, MailScanPage } from '@shared/mail-ingestion';
import { appendMailPage, mailPageUrl, readMailTaskPage, readMailScanPage } from '@/lib/mail-pages';
import { api, useStore } from '@/state/store';
import { useWorkspaceTabs } from '@/lib/workspace-tabs';
import { MAX_WORKSPACE_TABS } from '@shared/workspace-tabs';
import { workspaceViewHash } from '@/lib/app-route';

type Schedule = { revision: number; enabled: boolean; timezone: string; localTime: string; weekdays: number[]; nextRunAt: number | null; available: boolean; detail: string };
type Snapshot = MailWorkspaceMetadata & { schedule?: Schedule; operation?: { state: 'running' | 'failed' | 'complete' | 'interrupted'; kind: 'review'; startedAt: number; detail: string; requestId?: string } };
type ReviewRequest = { requestId: string; expectedRevision: number };
export type MailWorkGroup = 'open' | 'waiting' | 'reference' | 'snoozed' | 'done';
type Group = MailWorkGroup;
type Edit = { item: MailWorkItem; priority: MailWorkItem['priority']; owner: string; note: string; disposition: MailWorkItem['disposition']; nextAction: string; status: MailWorkItem['status']; snoozedUntil: string };
const groups: Record<Group, string> = { open: 'Needs attention', waiting: 'Waiting', reference: 'Reference', snoozed: 'Snoozed', done: 'Done' };
const dispositions: Record<MailWorkItem['disposition'], string> = { 'urgent-review': 'Urgent review', 'reply-review': 'Reply to review', 'action-review': 'Action to review', waiting: 'Waiting for a response', reference: 'Reference only', noise: 'No action needed', hold: 'Source or decision needed' };
const button = 'min-h-11 rounded-lg border border-line px-3 py-2 text-sm disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';
const input = 'min-h-11 w-full rounded-lg border border-line bg-sheet px-3 py-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-agency';
const date = (at: number | null, timeZone?: string) => { if (at === null || !Number.isFinite(at)) return 'Not recorded'; try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', ...(timeZone ? { timeZone } : {}) }).format(at); } catch { return 'Time unavailable'; } };
const localDateTime = (at: number | null) => at === null ? '' : new Date(at - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const editor = (item: MailWorkItem): Edit => ({ item, priority: item.priority, owner: item.owner, note: item.note, disposition: item.disposition, nextAction: item.nextAction, status: item.status, snoozedUntil: localDateTime(item.snoozedUntil) });

function OpenMailView() {
  const tabs = useWorkspaceTabs(), { dispatch } = useStore();
  const [error, setError] = useState(''), opening = useRef(false);
  const show = (id: string) => { window.location.hash = workspaceViewHash(id); dispatch({ type: 'showWorkspaceTab', id }); };
  const open = async () => {
    if (opening.current || !tabs.data?.state) return;
    opening.current = true; setError('');
    try {
      const state = tabs.data.state, existing = state.tabs.find(tab => tab.view.kind === 'mail');
      if (existing) {
        if (!existing.visible) await tabs.save(state.tabs.map(tab => tab.id === existing.id ? { ...tab, visible: true } : tab), state.revision);
        show(existing.id);
      } else {
        if (state.tabs.length >= MAX_WORKSPACE_TABS) throw new Error('Your saved views are full. Remove an unused shortcut in Manage views, then open mail again. Business records will stay saved.');
        const id = `view-${crypto.randomUUID()}`;
        await tabs.save([...state.tabs, { id, label: 'Mail priorities', visible: true, view: { kind: 'mail', filter: 'open' } }], state.revision);
        show(id);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The mail shortcut could not be saved. Refresh your saved views and try again.'); }
    finally { opening.current = false; }
  };
  return <div className="space-y-2"><button className={button} disabled={tabs.loading || tabs.saving || !tabs.data?.state} onClick={() => void open()}>Open mail priorities</button>{(error || tabs.error || tabs.data?.recovery) && <><p role="alert" className="text-sm text-danger">{error || tabs.error || tabs.data?.recovery?.message}</p><button className={button} onClick={() => dispatch({ type: 'showWorkspaceTab' })}>Manage views</button></>}</div>;
}

export function MailWorkPanel({ className = '', compact = false, initialGroup = 'open' }: { className?: string; compact?: boolean; initialGroup?: MailWorkGroup }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [group, setGroup] = useState<Group>(initialGroup), [query, setQuery] = useState('');
  const [page, setPage] = useState<MailTaskPage | null>(null), [scanPage, setScanPage] = useState<MailScanPage | null>(null), [loadingPage, setLoadingPage] = useState(false);
  const [latestEditItem, setLatestEditItem] = useState<MailWorkItem | null>(null), [discard, setDiscard] = useState<'cancel' | 'reload' | null>(null);
  const view = useRef({ group: initialGroup, q: '' }), pageSequence = useRef(0), currentEdit = useRef<Edit | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null), [source, setSource] = useState<{ accountId: string; receiptId: string; thread: MailThread } | null>(null);
  currentEdit.current = edit;
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [uncertainReview, setUncertainReview] = useState(false);
  const discardElement = useRef<HTMLDivElement | null>(null), editorElement = useRef<HTMLFormElement | null>(null), sourceElement = useRef<HTMLElement | null>(null);
  const alive = useRef(true), pending = useRef(false), refreshing = useRef(false), reviewRequest = useRef<ReviewRequest | null>(null), refreshSequence = useRef(0);
  const loadPage = async (nextGroup: Group, q: string, append = false) => {
    const sequence = ++pageSequence.current, previous = page;
    setLoadingPage(true);
    try {
      const next = readMailTaskPage(await api(mailPageUrl('/api/mail-workspace/items', { group: nextGroup, q, limit: compact ? 3 : 20, cursor: append ? previous?.nextCursor : undefined })), { group: nextGroup, q });
      if (!alive.current || sequence !== pageSequence.current) return;
      setPage(append && previous?.nextCursor ? appendMailPage(previous, next, previous.nextCursor) : next);
      setError('');
    } finally { if (alive.current && sequence === pageSequence.current) setLoadingPage(false); }
  };
  const refresh = async () => {
    const sequence = ++refreshSequence.current, next: Snapshot = await api('/api/mail-workspace');
    if (next.version !== 2 || !next.counts) throw new Error('The saved mail summary could not be checked. Refresh before continuing.');
    if (alive.current && sequence === refreshSequence.current) {
      setSnapshot(next); setError('');
      if (reviewRequest.current && next.operation?.requestId === reviewRequest.current.requestId) {
        reviewRequest.current = null; setUncertainReview(false); setNotice('The saved receipt confirms this review request. Its current status is shown below.');
      }
      const selected = currentEdit.current;
      await Promise.all([loadPage(view.current.group, view.current.q), ...(selected ? [api(`/api/mail-workspace/items/${selected.item.id}`).then((result: { item: MailWorkItem | null }) => {
        if (alive.current && sequence === refreshSequence.current && currentEdit.current?.item.id === selected.item.id) setLatestEditItem(result.item);
      })] : [])]);
    }
    return next;
  };
  useEffect(() => { alive.current = true; void refresh().catch(cause => { if (alive.current) setError(cause instanceof Error ? cause.message : 'Saved mail work could not be loaded.'); }); return () => { alive.current = false; pageSequence.current++; refreshSequence.current++; }; }, []);
  const running = snapshot?.operation?.state === 'running' || snapshot?.latestScan?.status === 'running';
  useEffect(() => { if (edit) { editorElement.current?.focus({ preventScroll: true }); editorElement.current?.scrollIntoView({ block: 'nearest' }); } }, [edit?.item.id]);
  useEffect(() => { if (discard) { discardElement.current?.focus({ preventScroll: true }); discardElement.current?.scrollIntoView({ block: 'nearest' }); } }, [discard]);
  useEffect(() => { if (source) { sourceElement.current?.focus({ preventScroll: true }); sourceElement.current?.scrollIntoView({ block: 'nearest' }); } }, [source?.thread.id]);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      if (refreshing.current) return; refreshing.current = true;
      void refresh().catch(() => { if (alive.current) setError('Work is still being checked. Its latest result could not be refreshed; do not start another attempt until its receipt is known.'); }).finally(() => { refreshing.current = false; });
    }, 5_000);
    return () => clearInterval(timer);
  }, [running]);
  useEffect(() => {
    const focus = () => {
      if (pending.current || refreshing.current) return;
      refreshing.current = true;
      void refresh().catch(() => { if (alive.current) setError('Saved mail work could not be refreshed. The last loaded records remain visible.'); }).finally(() => { refreshing.current = false; });
    };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, []);
  useEffect(() => {
    if (busy || !snapshot) return;
    const due = snapshot.nextSnoozeAt;
    if (due === null) return;
    const timer = setTimeout(() => { void refresh().catch(() => { if (alive.current) setError('A snoozed item may be due. Refresh saved mail work to check its current status.'); }); }, Math.min(2_147_483_647, Math.max(1_000, due - Date.now() + 100)));
    return () => clearTimeout(timer);
  }, [snapshot?.revision, busy]);
  useEffect(() => {
    view.current = { group, q: query.trim() };
    const timer = setTimeout(() => { void loadPage(group, query.trim()).catch(cause => { if (alive.current) setError(cause instanceof Error ? cause.message : 'The conversation page could not be read. Previously loaded records remain visible.'); }); }, 250);
    return () => clearTimeout(timer);
  }, [group, query]);
  const run = async (work: () => Promise<void>) => {
    if (pending.current) return; pending.current = true; setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'The operation could not be confirmed. Refresh the saved receipt before retrying.'); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const patch = async (item: MailWorkItem, fields: Record<string, unknown>) => {
    await api(`/api/mail-workspace/items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ expectedRevision: item.revision, ...fields }) }); await refresh();
  };
  const requestReview = async () => {
    // Read durable authority before every submission. A lost response retains the
    // same ID and revision; retrying can only reconcile that original request.
    const current = await refresh();
    if (uncertainReview && !reviewRequest.current) return;
    if (current.operation?.state === 'running' || current.latestScan?.status === 'running') throw new Error('A collection or review is already running. Wait for its saved receipt.');
    if (!Number.isSafeInteger(current.schedule?.revision)) throw new Error('The current schedule revision is unavailable. Refresh saved mail work before starting a review.');
    const request = reviewRequest.current ?? { requestId: crypto.randomUUID(), expectedRevision: current.schedule!.revision };
    reviewRequest.current = request;
    try {
      const result = await api('/api/mail-workspace/review', { method: 'POST', body: JSON.stringify(request) }, { timeoutMs: 30_000 });
      if (!result.run?.id || result.run.requestId !== request.requestId) throw new Error('The review receipt did not match this request.');
      reviewRequest.current = null; if (alive.current) { setUncertainReview(false); setNotice('Review request saved. The receipt shows whether it is queued, running or finished.'); }
    } catch (cause) {
      const status = (cause as { status?: number })?.status;
      if (status && status >= 400 && status < 500) { reviewRequest.current = null; if (alive.current) setUncertainReview(false); }
      else {
        if (alive.current) setUncertainReview(true);
        try { const reconciled = await refresh(); if (reconciled.operation?.requestId === request.requestId) return; } catch { /* Keep the original request for explicit reconciliation. */ }
      }
      throw cause;
    }
    await refresh();
  };
  const counts = page && snapshot && page.revision >= snapshot.revision ? page.counts : snapshot?.counts;
  const items = page?.items ?? [], schedule = snapshot?.schedule, timeZone = schedule?.timezone;
  const latest = latestEditItem, stale = Boolean(edit && (!latest || latest.revision !== edit.item.revision));
  const editDirty = !!edit && JSON.stringify(editor(edit.item)) !== JSON.stringify(edit);
  const discardEdits = (action: 'cancel' | 'reload') => {
    if (editDirty) setDiscard(action);
    else if (action === 'reload' && latest) { setEdit(editor(latest)); setDiscard(null); }
    else { setEdit(null); setDiscard(null); }
  };
  const loadScans = async (append = false) => {
    const previous = scanPage, next = readMailScanPage(await api(mailPageUrl('/api/mail-workspace/scans', { limit: 10, cursor: append ? previous?.nextCursor : undefined })));
    if (alive.current) setScanPage(append && previous?.nextCursor ? appendMailPage(previous, next, previous.nextCursor) : next);
  };
  if (compact) return <section aria-label="Mail priorities summary" className={`rounded-lg border border-line bg-sheet p-3 space-y-2 ${className}`}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-medium">Mail priorities</h2><OpenMailView /></div>
    {snapshot && <p className="text-sm text-ink-secondary">{counts?.open} need attention · {counts?.waiting} waiting</p>}
    <p className="text-sm text-ink-secondary">{running ? 'A collection or priority review is running. Open mail to see its receipt.' : snapshot?.latestScan ? `Latest collection: ${snapshot.latestScan.status} · ${date(snapshot.latestScan.completedAt ?? snapshot.latestScan.startedAt, timeZone)}.` : snapshot ? 'No Gmail collection is recorded yet. Set up your agency, then review the selected source.' : error ? 'Saved mail work is unavailable. Existing records are preserved.' : 'Checking saved mail work…'}</p>
    {!!items.length && <ul className="space-y-1 text-sm">{items.map(item => <li key={item.id} className="flex gap-2"><span className="min-w-0 flex-1 truncate">{item.subject || 'Untitled conversation'}</span><span className="shrink-0 text-ink-secondary">{item.priority} priority</span></li>)}</ul>}
    {snapshot?.latestScan && snapshot.latestScan.status !== 'complete' && <p className="text-sm text-hold">Source coverage needs attention. The saved count does not establish an empty inbox.</p>}
    {error && snapshot && <p role="alert" className="text-sm text-hold">The latest check failed. Previously loaded records are shown; open mail to refresh.</p>}
  </section>;
  return <section aria-label="Mail priorities and follow-ups" className={`rounded-xl border border-line bg-sheet p-4 space-y-4 ${className}`} aria-busy={busy}>
    <div><h2 className="text-lg font-medium">Mail priorities and follow-ups</h2><p className="mt-1 text-sm text-ink-secondary">A persistent review list from the private Gmail account and scope you chose in Agency workflow setup. Collecting messages and preparing a priority list are separate steps.</p></div>
    <div className="flex flex-wrap gap-2"><button className={button} disabled={busy || running || uncertainReview} onClick={() => void run(async () => { await api('/api/mail-workspace/scan', { method: 'POST', body: '{}' }, { timeoutMs: 270_000 }); await refresh(); if (alive.current) setNotice('Collection request returned. Check its coverage receipt below before relying on the saved list.'); })}>Collect reviewed Gmail scope</button><button className={button} disabled={busy || running || !schedule} onClick={() => void run(requestReview)}>{uncertainReview ? 'Reconcile and retry the same review request' : 'Collect and prepare priorities with Bud'}</button><button className={button} disabled={busy} onClick={() => void run(async () => { await refresh(); if (alive.current) setNotice('Saved work and receipt refreshed.'); })}>Refresh saved mail work</button></div>
    {uncertainReview && <p role="alert" className="text-sm text-hold">This review request has an uncertain result. Refresh checks its saved receipt. Retrying keeps the original request identifier; it does not create a second review request.</p>}
    <p className="text-sm text-ink-secondary">Bud’s preparation uses the configured model service. These actions do not send replies, change Gmail labels, download attachment contents, pay bills or import accounting records.</p>
    {snapshot?.operation && <p role="status" className={`text-sm ${['failed', 'interrupted'].includes(snapshot.operation.state) ? 'text-hold' : 'text-ink-secondary'}`}>Priority review: {snapshot.operation.state}. {snapshot.operation.detail}</p>}
    {snapshot?.latestScan ? <div className="rounded-lg border border-line p-3 space-y-2 text-sm"><div className="flex flex-wrap justify-between gap-2"><strong className="font-medium">Latest source collection: {snapshot.latestScan.status}</strong><span>{date(snapshot.latestScan.completedAt ?? snapshot.latestScan.startedAt, timeZone)}</span></div><p>{snapshot.latestScan.messageCount} messages · {snapshot.latestScan.threadCount} conversations · {snapshot.latestScan.pages} pages</p><p className="text-ink-secondary">Source window: {date(snapshot.latestScan.windowStartAt, timeZone)} to {date(snapshot.latestScan.windowEndAt, timeZone)}. {timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone}.</p>{snapshot.latestScan.status !== 'complete' && <p className="text-hold">This scan cannot establish complete source coverage. Existing work remains available; an empty list does not mean there is nothing to do.</p>}{!!snapshot.latestScan.gaps.length && <details><summary className="min-h-11 cursor-pointer">Review source gaps ({snapshot.latestScan.gaps.length})</summary><ul className="list-disc pl-5 break-words">{snapshot.latestScan.gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul></details>}<p className="text-ink-secondary">{snapshot.latestReview ? `Last prepared review: ${date(snapshot.latestReview.at, timeZone)}.${snapshot.latestReview.sourceReceiptId !== snapshot.latestScan.id ? ' A newer collection is available. Check its coverage and items marked as new evidence.' : ''}` : 'No prepared review is recorded yet.'}</p></div> : snapshot && <p className="text-sm text-ink-secondary">No source collection is recorded. Finish agency setup and explicitly collect the reviewed Gmail scope.</p>}
    <div className="rounded-lg border border-line p-3 space-y-2"><h3 className="text-sm font-medium">Morning schedule</h3>{schedule ? <><p className="text-sm">{schedule.enabled ? 'Enabled' : 'Off'} · {schedule.localTime} · {schedule.timezone}</p><p className="text-sm text-ink-secondary">{schedule.detail}{schedule.enabled ? ` Next start: ${date(schedule.nextRunAt, schedule.timezone)}.` : ''}</p><button className={button} disabled={busy || (!schedule.enabled && !schedule.available)} onClick={() => void run(async () => { const enabled = !schedule.enabled; await api('/api/mail-workspace/schedule', { method: 'PATCH', body: JSON.stringify({ enabled }) }); const next = await refresh(); if (next.schedule?.enabled !== enabled) throw new Error('The schedule change could not be confirmed. Refresh before retrying.'); if (alive.current) setNotice(enabled ? 'Morning schedule enabled using the reviewed agency time and weekdays.' : 'Morning schedule is off. Any already running review keeps its own receipt.'); })}>{schedule.enabled ? 'Turn off morning schedule' : 'Enable reviewed morning schedule'}</button></> : <p className="text-sm text-ink-secondary">Schedule state is unavailable. Refresh after finishing agency setup; no schedule was enabled by opening this panel.</p>}<p className="text-xs text-ink-secondary">The local service must be running and connected. The scheduled time is a start time; source and model work can finish later.</p></div>
    {snapshot && <><div role="group" aria-label="Filter saved mail work" className="flex flex-wrap gap-2">{(Object.keys(groups) as Group[]).map(value => <button key={value} className={`${button} ${group === value ? 'bg-agency-soft border-agency' : ''}`} aria-pressed={group === value} disabled={busy || loadingPage} onClick={() => setGroup(value)}>{groups[value]} ({counts?.[value]})</button>)}</div><label className="block text-sm">Find a conversation<input aria-label="Find a conversation" className={`${input} mt-1`} value={query} maxLength={200} onChange={event => setQuery(event.target.value)} placeholder="Subject, reviewer or next action" /></label>{!items.length && !error && !loadingPage && <p className="text-sm text-ink-secondary">No saved conversations match this view. Check the latest source coverage and review status above.</p>}<p role="status" className="text-sm text-ink-secondary">{loadingPage ? 'Checking retained conversations…' : page ? `Showing ${items.length} of ${page.total} conversations in ${groups[page.group as Group] ?? 'all groups'}${page.q ? ` matching “${page.q}”` : ''}. Search covers all retained conversations.` : 'No conversation page is loaded yet.'}</p><ul className="space-y-3">{items.map(item => <li key={item.id} className="rounded-lg border border-line p-3 space-y-2"><div className="flex flex-wrap justify-between gap-2"><h3 className="font-medium break-words">{item.subject || 'Untitled conversation'}</h3><span className={`text-sm ${item.priority === 'high' ? 'text-hold' : 'text-ink-secondary'}`}>{item.priority} priority</span></div><p className="text-sm">{dispositions[item.disposition]} · {item.owner || 'Unassigned'}{item.reviewed ? ' · Your saved review' : ' · Needs human review'}</p>{item.newEvidence && <p className="text-sm text-hold">New source evidence — review what changed before closing this item.</p>}<p className="text-sm break-words">{item.nextAction}</p><p className="text-xs text-ink-secondary break-words">{item.reason}</p>{!!item.missingFacts.length && <details><summary className="min-h-11 cursor-pointer text-sm">Missing facts ({item.missingFacts.length})</summary><ul className="list-disc pl-5 text-sm">{item.missingFacts.map((fact, index) => <li key={index}>{fact}</li>)}</ul></details>}{item.note && <p className="text-sm whitespace-pre-wrap break-words">Your note: {item.note}</p>}<p className="text-xs text-ink-secondary">Last source message {date(item.lastMessageAt, timeZone)}{item.status === 'snoozed' ? ` · Snoozed until ${date(item.snoozedUntil, timeZone)}` : ''}</p><div className="flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={() => void run(async () => { const result = await api(`/api/mail-workspace/items/${item.id}/source`); if (alive.current) setSource(result); })}>View source conversation</button><button className={button} disabled={busy || !!edit} onClick={() => { setEdit(editor(item)); setLatestEditItem(item); setDiscard(null); }}>Review or edit this item</button><button className={button} disabled={busy || edit?.item.id === item.id} onClick={() => void run(async () => { await patch(item, { status: item.status === 'done' ? 'open' : 'done' }); if (alive.current) setNotice(item.status === 'done' ? 'Item reopened. No external message was sent.' : 'Item marked done in this workspace. Gmail is unchanged.'); })}>{item.status === 'done' ? 'Reopen item' : 'Mark done'}</button></div></li>)}</ul>{page?.nextCursor && <button className={button} disabled={busy || loadingPage || page.group !== group || page.q !== query.trim()} onClick={() => void run(() => loadPage(page.group as Group, page.q, true))}>Load more conversations</button>}</>}
    {discard && <div ref={discardElement} tabIndex={-1} role="alertdialog" aria-label="Discard unsaved mail edits" className="rounded-lg border border-hold p-3 space-y-2"><p className="text-sm">Discard the unsaved changes to this item? Saved reviews and source evidence stay available.</p><div className="flex flex-wrap gap-2"><button className={button} onClick={() => { if (discard === 'reload' && latest) setEdit(editor(latest)); else setEdit(null); setDiscard(null); }}>Discard unsaved item edits</button><button className={button} onClick={() => { setDiscard(null); editorElement.current?.focus({ preventScroll: true }); editorElement.current?.scrollIntoView({ block: 'nearest' }); }}>Keep editing this item</button></div></div>}
    {edit && <form ref={editorElement} tabIndex={-1} aria-label="Review saved mail item" className="rounded-lg border border-agency p-3 space-y-3" onSubmit={event => { event.preventDefault(); void run(async () => { const snoozedUntil = edit.status === 'snoozed' ? new Date(edit.snoozedUntil).getTime() : null; if (edit.status === 'snoozed' && (!Number.isFinite(snoozedUntil) || snoozedUntil! <= Date.now())) throw new Error('Choose a future snooze date and time.'); await patch(edit.item, { priority: edit.priority, owner: edit.owner, note: edit.note, disposition: edit.disposition, nextAction: edit.nextAction, status: edit.status, snoozedUntil }); if (alive.current) { setEdit(null); setDiscard(null); setNotice('Your review was saved. Future preparation preserves your choices.'); } }); }}><h3 className="font-medium break-words">Review: {edit.item.subject}</h3>{stale && <p role="alert" className="text-sm text-hold">This saved item changed elsewhere. Your edits are kept; reload this item before saving.</p>}<div className="grid gap-3 sm:grid-cols-2"><label className="block text-sm">Priority<select aria-label="Priority" className={`${input} mt-1`} value={edit.priority} disabled={busy} onChange={event => setEdit({ ...edit, priority: event.target.value as MailWorkItem['priority'] })}><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select></label><label className="block text-sm">Responsible reviewer (local label)<input aria-label="Responsible reviewer (local label)" className={`${input} mt-1`} value={edit.owner} maxLength={120} disabled={busy} onChange={event => setEdit({ ...edit, owner: event.target.value })} /></label><label className="block text-sm">What this conversation needs<select aria-label="What this conversation needs" className={`${input} mt-1`} value={edit.disposition} disabled={busy} onChange={event => setEdit({ ...edit, disposition: event.target.value as MailWorkItem['disposition'] })}>{Object.entries(dispositions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="block text-sm">Work status<select aria-label="Work status" className={`${input} mt-1`} value={edit.status} disabled={busy} onChange={event => setEdit({ ...edit, status: event.target.value as MailWorkItem['status'] })}><option value="open">Open</option><option value="snoozed">Snoozed</option><option value="done">Done</option></select></label></div>{edit.status === 'snoozed' && <label className="block text-sm">Snooze until ({Intl.DateTimeFormat().resolvedOptions().timeZone})<input className={`${input} mt-1`} type="datetime-local" value={edit.snoozedUntil} disabled={busy} onChange={event => setEdit({ ...edit, snoozedUntil: event.target.value })} /></label>}<label className="block text-sm">Next action<textarea aria-label="Next action" className={`${input} mt-1`} value={edit.nextAction} maxLength={2000} disabled={busy} onChange={event => setEdit({ ...edit, nextAction: event.target.value })} /></label><label className="block text-sm">Your note<textarea aria-label="Your note" className={`${input} mt-1`} value={edit.note} maxLength={2000} disabled={busy} onChange={event => setEdit({ ...edit, note: event.target.value })} /></label><div className="flex flex-wrap gap-2"><button type="submit" className={button} disabled={busy || stale}>Save reviewed item</button>{stale && latest && <button type="button" className={button} disabled={busy} onClick={() => discardEdits('reload')}>Reload this item and discard my edits</button>}<button type="button" className={button} disabled={busy} onClick={() => discardEdits('cancel')}>Cancel item edits</button></div></form>}
    {snapshot && <details className="rounded-lg border border-line p-3 text-sm"><summary className="min-h-11 cursor-pointer">Collection history</summary><div className="space-y-2"><p>Retained collection receipts show the checked source window and any coverage gaps.</p><button className={button} disabled={busy} onClick={() => void run(() => loadScans())}>Refresh collection history</button>{scanPage && <p>{scanPage.items.length} of {scanPage.total} retained collections shown.</p>}<ul className="space-y-2">{scanPage?.items.map(scan => <li key={scan.id} className="rounded border border-line p-3"><p>{date(scan.startedAt, timeZone)} · {scan.status} · {scan.threadCount} conversations</p><p className="text-ink-secondary">Source window {date(scan.windowStartAt, timeZone)} to {date(scan.windowEndAt, timeZone)}</p>{!!scan.gaps.length && <details><summary className="min-h-11 cursor-pointer">Coverage gaps ({scan.gaps.length})</summary><ul className="list-disc pl-5 break-words">{scan.gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul></details>}</li>)}</ul>{scanPage?.nextCursor && <button className={button} disabled={busy} onClick={() => void run(() => loadScans(true))}>Load more collection receipts</button>}</div></details>}
    {source && <aside ref={sourceElement} tabIndex={-1} aria-label="Saved source conversation" className="rounded-lg border border-agency p-3 space-y-3"><div className="flex flex-wrap justify-between gap-2"><h3 className="font-medium">Saved source conversation</h3><button className={button} onClick={() => setSource(null)}>Close source conversation</button></div><p className="text-sm text-ink-secondary break-all">Account {source.accountId} · source receipt {source.receiptId}</p><p className="text-sm text-ink-secondary">Plain saved message text. Viewing it does not contact a sender, load remote images or change Gmail. Attachment contents were not downloaded.</p>{!source.thread.historyComplete && <p className="text-sm text-hold">This saved conversation history is incomplete.</p>}{source.thread.messages.map(message => <details key={message.id} className="rounded border border-line p-3"><summary className="min-h-11 cursor-pointer break-words text-sm">{date(message.at, timeZone)} · {message.direction} · {message.subject || 'Untitled message'}</summary><div className="mt-2 space-y-2 text-sm"><p className="break-words">From: {message.from}</p><p className="break-words">To: {message.to}</p><p className="whitespace-pre-wrap break-words">{message.body}</p>{message.bodyTruncated && <p className="text-hold">The saved message text is truncated; review the missing content in Gmail before deciding.</p>}{!!message.attachments.length && <ul className="list-disc pl-5">{message.attachments.map(attachment => <li key={attachment.id} className="break-words">{attachment.name} · {attachment.mimeType} · metadata only</li>)}</ul>}</div></details>)}</aside>}
    {!snapshot && <p className="text-sm text-ink-secondary">{error ? 'Saved mail work is unavailable. No empty-inbox conclusion can be drawn.' : 'Loading saved mail work…'}</p>}
    {error && <p role="alert" className="text-sm text-danger">{error}{snapshot ? ' Previously loaded records remain visible.' : ''}</p>}
    <p role="status" className="text-sm text-ink-secondary">{busy ? 'Waiting for the operation’s saved result…' : notice}</p>
  </section>;
}
