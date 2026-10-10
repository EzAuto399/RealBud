import { useEffect, useRef, useState } from 'react';
import { mailChangedSinceReview, type MailThread, type MailWorkItem, type MailWorkspaceMetadata, type MailTaskPage, type MailScanPage } from '@shared/mail-ingestion';
import { appendMailPage, mailPageUrl, readMailTaskPage, readMailScanPage } from '@/lib/mail-pages';
import { api, useStore } from '@/state/store';
import { useWorkspaceTabs } from '@/lib/workspace-tabs';
import { MAX_WORKSPACE_TABS } from '@shared/workspace-tabs';
import { workspaceViewHash } from '@/lib/app-route';
import { mailReviewDrafts, mailReviewDirty, mailReviewStale, readMailReviewContext, sameMailReviewScope, type MailReviewContext, type MailReviewDraft, type MailReviewEdit as Edit } from '@/lib/mail-review-drafts';
import { markMailNotNoise } from '@/components/work/MailPriorityCard';
import { AreaStatusLine } from './AreaStatusLine';

type Schedule = { revision: number; enabled: boolean; timezone: string; localTime: string; weekdays: number[]; nextRunAt: number | null; available: boolean; detail: string };
type Snapshot = MailWorkspaceMetadata & { schedule?: Schedule; operation?: { state: 'running' | 'failed' | 'complete' | 'interrupted'; kind: 'review'; startedAt: number; detail: string; requestId?: string } };
export type MailWorkGroup = 'open' | 'waiting' | 'reference' | 'snoozed' | 'done';
type Group = MailWorkGroup;
const groups: Record<Group, string> = { open: 'Needs attention', waiting: 'Waiting', reference: 'Reference', snoozed: 'Snoozed', done: 'Done' };
/** Filters worth showing: Needs attention always, the selected one, and any other with work in it. */
export const visibleMailGroups = (counts: Partial<Record<Group, number>> | undefined, selected: Group): Group[] =>
  (Object.keys(groups) as Group[]).filter(value => value === 'open' || value === selected || (counts?.[value] ?? 0) > 0);
const dispositions: Record<MailWorkItem['disposition'], string> = { 'urgent-review': 'Urgent review', 'reply-review': 'Reply to review', 'action-review': 'Action to review', waiting: 'Waiting for a response', reference: 'Reference only', noise: 'No action needed', hold: 'Source or decision needed' };
const button = 'min-h-11 rounded-lg border border-line px-3 py-2 text-sm disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';
const input = 'min-h-11 w-full rounded-lg border border-line bg-sheet px-3 py-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-agency';
const date = (at: number | null, timeZone?: string) => { if (at === null || !Number.isFinite(at)) return 'Not recorded'; try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', ...(timeZone ? { timeZone } : {}) }).format(at); } catch { return 'Time unavailable'; } };
/** Open conversations Jev's screen set aside; they list under Reference until a person says otherwise. */
export const mailScreened = (item: MailWorkItem) => item.status === 'open' && item.screenedBy === 'jev';
/** Same PATCH as the Work card's Not noise. A conflict or lost response may hide a committed change, so the saved list is reread either way. */
export async function sendNotNoise(request: Parameters<typeof markMailNotNoise>[0], item: MailWorkItem, refresh: () => Promise<unknown>) {
  try { await markMailNotNoise(request, item); }
  catch (cause) {
    await refresh().catch(() => undefined);
    throw (cause as { status?: number })?.status === 409 ? new Error('This conversation changed elsewhere. The list was refreshed; check it again.') : cause;
  }
  await refresh();
}
export function NotNoiseButton({ item, disabled, onClick }: { item: MailWorkItem; disabled: boolean; onClick: () => void }) {
  if (!mailScreened(item)) return null;
  return <button className={button} aria-label={`Not noise: ${item.subject || 'Untitled conversation'}`} title="Puts it back for Bud’s next review" disabled={disabled} onClick={onClick}>Not noise</button>;
}

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
  const [edit, setEditState] = useState<Edit | null>(null), [source, setSource] = useState<{ accountId: string; receiptId: string; thread: MailThread } | null>(null);
  const [context, setContext] = useState<MailReviewContext | null>(null), [draftContext, setDraftContext] = useState<MailReviewContext | null>(null);
  const contextRef = useRef<MailReviewContext | null>(null), draftRef = useRef<MailReviewDraft | null>(null);
  currentEdit.current = edit;
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const discardElement = useRef<HTMLDivElement | null>(null), editorElement = useRef<HTMLFormElement | null>(null), sourceElement = useRef<HTMLElement | null>(null);
  const alive = useRef(true), pending = useRef(false), refreshing = useRef(false), refreshSequence = useRef(0);
  const adoptDraft = (entry: MailReviewDraft) => {
    draftRef.current = entry; currentEdit.current = entry.edit; setDraftContext(entry.context); setEditState(entry.edit);
  };
  const openEdit = (item: MailWorkItem) => {
    try {
      if (!contextRef.current) throw new Error('Refresh the private workspace before editing.');
      adoptDraft(mailReviewDrafts.open(contextRef.current, item)); setLatestEditItem(item); setDiscard(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'This review could not be opened.'); }
  };
  const setEdit = (next: Edit) => {
    try {
      if (!draftRef.current) throw new Error('Reopen this review before editing.');
      adoptDraft(mailReviewDrafts.write(draftRef.current.context, next, draftRef.current.sequence));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Your retained review could not be changed.'); }
  };
  const discardDraft = (reload = false) => {
    const held = draftRef.current;
    if (held) mailReviewDrafts.remove(held.context, held.edit.item.id, held.sequence);
    draftRef.current = null; currentEdit.current = null; setEditState(null); setDraftContext(null); setDiscard(null);
    if (reload && latestEditItem) openEdit(latestEditItem);
  };
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
    const sequence = ++refreshSequence.current, [next, setup]: [Snapshot, unknown] = await Promise.all([api('/api/mail-workspace'), api('/api/agency-setup')]);
    const nextContext = readMailReviewContext(setup);
    if (next.version !== 2 || !next.counts) throw new Error('The saved mail summary could not be checked. Refresh before continuing.');
    if (alive.current && sequence === refreshSequence.current) {
      const previousContext = contextRef.current;
      contextRef.current = nextContext; setContext(nextContext);
      if (previousContext && !sameMailReviewScope(previousContext, nextContext)) {
        // Keep the old private draft in memory, but never display it in another scope.
        draftRef.current = null; currentEdit.current = null; setEditState(null); setDraftContext(null); setLatestEditItem(null); setSource(null); setPage(null); setDiscard(null);
        setNotice('The private workspace or selected Gmail account changed. Reviews from the earlier scope remain held in this session.');
      }
      if (!compact && !currentEdit.current) {
        const retained = mailReviewDrafts.current(nextContext);
        if (retained) { adoptDraft(retained); setLatestEditItem(null); }
      }
      setSnapshot(next); setError('');
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
  const counts = page && snapshot && page.revision >= snapshot.revision ? page.counts : snapshot?.counts;
  const items = page?.items ?? [], schedule = snapshot?.schedule, timeZone = schedule?.timezone;
  const latest = latestEditItem, stale = Boolean(edit && (!draftContext || mailReviewStale({ context: draftContext, edit }, context, latest)));
  const editDirty = !!edit && mailReviewDirty(edit);
  const retainedDrafts = context ? mailReviewDrafts.list(context).filter(entry => entry.dirty && entry.edit.item.id !== edit?.item.id) : [];
  const discardEdits = (action: 'cancel' | 'reload') => {
    if (editDirty) setDiscard(action);
    else discardDraft(action === 'reload');
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
    <h2 className="text-lg font-medium">Mail priorities and follow-ups</h2>
    <AreaStatusLine area="mail" onStarted={() => void refresh().catch(() => { if (alive.current) setError('Saved mail work could not be refreshed. The last loaded records remain visible.'); })} />
    {snapshot?.latestScan && snapshot.latestScan.status !== 'complete' && <p role="status" className="text-sm text-hold">The latest Gmail collection is {snapshot.latestScan.status}, so an empty list does not mean there is nothing to do. Its receipt is under Setup.</p>}
    {snapshot && <><div role="group" aria-label="Filter saved mail work" className="flex flex-wrap gap-2">{visibleMailGroups(counts, group).map(value => <button key={value} className={`${button} ${group === value ? 'bg-agency-soft border-agency' : ''}`} aria-pressed={group === value} disabled={busy || loadingPage} onClick={() => setGroup(value)}>{groups[value]} ({counts?.[value]})</button>)}</div><label className="block text-sm">Find a conversation<input aria-label="Find a conversation" className={`${input} mt-1`} value={query} maxLength={200} onChange={event => setQuery(event.target.value)} placeholder="Subject, reviewer or next action" /></label>{!items.length && !error && !loadingPage && <p className="text-sm text-ink-secondary">No saved conversations match this view. The status line above says when mail was last checked.</p>}<p role="status" className="text-sm text-ink-secondary">{loadingPage ? 'Checking retained conversations…' : page ? `Showing ${items.length} of ${page.total} conversations in ${groups[page.group as Group] ?? 'all groups'}${page.q ? ` matching “${page.q}”` : ''}. Search covers all retained conversations.` : 'No conversation page is loaded yet.'}</p><ul className="space-y-3">{items.map(item => <li key={item.id} className="rounded-lg border border-line p-3 space-y-2"><div className="flex flex-wrap justify-between gap-2"><h3 className="font-medium break-words">{item.subject || 'Untitled conversation'}</h3><span className={`text-sm ${item.priority === 'high' ? 'text-hold' : 'text-ink-secondary'}`}>{item.priority} priority</span></div><p className="text-sm">{dispositions[item.disposition]} · {item.owner || 'Unassigned'}{item.reviewed ? ' · Your saved review' : ' · Needs human review'}</p>{mailChangedSinceReview(item) ? <p className="text-sm font-medium text-hold">New reply since you reviewed</p> : item.newEvidence && <p className="text-sm text-hold">New source evidence — review what changed before closing this item.</p>}<p className="text-sm break-words">{item.nextAction}</p><p className="text-xs text-ink-secondary break-words">{item.reason}</p>{!!item.missingFacts.length && <details><summary className="min-h-11 cursor-pointer text-sm">Missing facts ({item.missingFacts.length})</summary><ul className="list-disc pl-5 text-sm">{item.missingFacts.map((fact, index) => <li key={index}>{fact}</li>)}</ul></details>}{item.note && <p className="text-sm whitespace-pre-wrap break-words">Your note: {item.note}</p>}<p className="text-xs text-ink-secondary">Last source message {date(item.lastMessageAt, timeZone)}{item.status === 'snoozed' ? ` · Snoozed until ${date(item.snoozedUntil, timeZone)}` : ''}</p><div className="flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={() => void run(async () => { const result = await api(`/api/mail-workspace/items/${item.id}/source`); if (alive.current) setSource(result); })}>View source conversation</button><button className={button} disabled={busy || !context || item.accountId !== context.accountId} onClick={() => openEdit(item)}>Review or edit this item</button><button className={button} disabled={busy || edit?.item.id === item.id} onClick={() => void run(async () => { await patch(item, { status: item.status === 'done' ? 'open' : 'done' }); if (alive.current) setNotice(item.status === 'done' ? 'Item reopened. No external message was sent.' : 'Item marked done in this workspace. Gmail is unchanged.'); })}>{item.status === 'done' ? 'Reopen item' : 'Mark done'}</button><NotNoiseButton item={item} disabled={busy || edit?.item.id === item.id} onClick={() => void run(async () => { await sendNotNoise(api, item, refresh); if (alive.current) setNotice('Back in Needs attention. Bud will prepare it in the next review. Nothing was sent.'); })} /></div></li>)}</ul>{page?.nextCursor && <button className={button} disabled={busy || loadingPage || page.group !== group || page.q !== query.trim()} onClick={() => void run(() => loadPage(page.group as Group, page.q, true))}>Load more conversations</button>}</>}
    {!!retainedDrafts.length && <aside aria-label="Retained unsaved mail reviews" className="rounded-lg border border-line p-3 space-y-2"><p className="text-sm">Unsaved reviews are held privately in this window across views. Save or discard them before closing or reloading.</p><div className="flex flex-wrap gap-2">{retainedDrafts.map(entry => <button key={entry.edit.item.id} className={button} disabled={busy} onClick={() => { adoptDraft(entry); setLatestEditItem(null); setDiscard(null); void run(async () => { await refresh(); }); }}>Continue: {entry.edit.item.subject || 'Untitled conversation'}</button>)}</div></aside>}
    {discard && <div ref={discardElement} tabIndex={-1} role="alertdialog" aria-label="Discard unsaved mail edits" className="rounded-lg border border-hold p-3 space-y-2"><p className="text-sm">Discard the unsaved changes to this item? Saved reviews and source evidence stay available.</p><div className="flex flex-wrap gap-2"><button className={button} onClick={() => { discardDraft(discard === 'reload'); }}>Discard unsaved item edits</button><button className={button} onClick={() => { setDiscard(null); editorElement.current?.focus({ preventScroll: true }); editorElement.current?.scrollIntoView({ block: 'nearest' }); }}>Keep editing this item</button></div></div>}
    {edit && <form ref={editorElement} tabIndex={-1} aria-label="Review saved mail item" className="rounded-lg border border-agency p-3 space-y-3" onSubmit={event => { event.preventDefault(); void run(async () => { const snoozedUntil = edit.status === 'snoozed' ? new Date(edit.snoozedUntil).getTime() : null; if (edit.status === 'snoozed' && (!Number.isFinite(snoozedUntil) || snoozedUntil! <= Date.now())) throw new Error('Choose a future snooze date and time.'); const held = draftRef.current;
      if (!held || stale) throw new Error('Refresh the current workspace and source before saving this retained review.');
      const [setup, saved] = await Promise.all([api('/api/agency-setup'), api(`/api/mail-workspace/items/${edit.item.id}`)]);
      const checkedContext = readMailReviewContext(setup);
      if (mailReviewStale(held, checkedContext, saved.item)) { await refresh(); throw new Error('The workspace, account, setup or source changed. Your draft is retained; review the current record before saving.'); }
      await patch(edit.item, { priority: edit.priority, owner: edit.owner, note: edit.note, disposition: edit.disposition, nextAction: edit.nextAction, status: edit.status, snoozedUntil, expectedWorkspaceId: held.context.workspaceId, expectedSetupRevision: held.context.setupRevision, expectedAccountId: held.context.accountId });
      const cleared = mailReviewDrafts.remove(held.context, held.edit.item.id, held.sequence);
      if (alive.current && cleared && draftRef.current?.sequence === held.sequence) { draftRef.current = null; currentEdit.current = null; setEditState(null); setDraftContext(null); setDiscard(null); setNotice('Your review was saved. Future preparation preserves your choices.'); } }); }}><h3 className="font-medium break-words">Review: {edit.item.subject}</h3>{stale && <p role="alert" className="text-sm text-hold">This workspace, setup or saved source changed. Your edits are kept in this session; inspect the current source and explicitly reload before saving.</p>}<div className="grid gap-3 sm:grid-cols-2"><label className="block text-sm">Priority<select aria-label="Priority" className={`${input} mt-1`} value={edit.priority} disabled={busy} onChange={event => setEdit({ ...edit, priority: event.target.value as MailWorkItem['priority'] })}><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select></label><label className="block text-sm">Responsible reviewer (local label)<input aria-label="Responsible reviewer (local label)" className={`${input} mt-1`} value={edit.owner} maxLength={120} disabled={busy} onChange={event => setEdit({ ...edit, owner: event.target.value })} /></label><label className="block text-sm">What this conversation needs<select aria-label="What this conversation needs" className={`${input} mt-1`} value={edit.disposition} disabled={busy} onChange={event => setEdit({ ...edit, disposition: event.target.value as MailWorkItem['disposition'] })}>{Object.entries(dispositions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="block text-sm">Work status<select aria-label="Work status" className={`${input} mt-1`} value={edit.status} disabled={busy} onChange={event => setEdit({ ...edit, status: event.target.value as MailWorkItem['status'] })}><option value="open">Open</option><option value="snoozed">Snoozed</option><option value="done">Done</option></select></label></div>{edit.status === 'snoozed' && <label className="block text-sm">Snooze until ({Intl.DateTimeFormat().resolvedOptions().timeZone})<input className={`${input} mt-1`} type="datetime-local" value={edit.snoozedUntil} disabled={busy} onChange={event => setEdit({ ...edit, snoozedUntil: event.target.value })} /></label>}<label className="block text-sm">Next action<textarea aria-label="Next action" className={`${input} mt-1`} value={edit.nextAction} maxLength={2000} disabled={busy} onChange={event => setEdit({ ...edit, nextAction: event.target.value })} /></label><label className="block text-sm">Your note<textarea aria-label="Your note" className={`${input} mt-1`} value={edit.note} maxLength={2000} disabled={busy} onChange={event => setEdit({ ...edit, note: event.target.value })} /></label><div className="flex flex-wrap gap-2"><button type="submit" className={button} disabled={busy || stale}>Save reviewed item</button>{stale && latest && <button type="button" className={button} disabled={busy} onClick={() => discardEdits('reload')}>Reload this item and discard my edits</button>}<button type="button" className={button} disabled={busy} onClick={() => discardEdits('cancel')}>Cancel item edits</button></div></form>}
    {source && <aside ref={sourceElement} tabIndex={-1} aria-label="Saved source conversation" className="rounded-lg border border-agency p-3 space-y-3"><div className="flex flex-wrap justify-between gap-2"><h3 className="font-medium">Saved source conversation</h3><button className={button} onClick={() => setSource(null)}>Close source conversation</button></div><p className="text-sm text-ink-secondary break-all">Account {source.accountId} · source receipt {source.receiptId}</p><p className="text-sm text-ink-secondary">Plain saved message text. Viewing it does not contact a sender, load remote images or change Gmail. Attachment contents were not downloaded.</p>{!source.thread.historyComplete && <p className="text-sm text-hold">This saved conversation history is incomplete.</p>}{source.thread.messages.map(message => <details key={message.id} className="rounded border border-line p-3"><summary className="min-h-11 cursor-pointer break-words text-sm">{date(message.at, timeZone)} · {message.direction} · {message.subject || 'Untitled message'}</summary><div className="mt-2 space-y-2 text-sm"><p className="break-words">From: {message.from}</p><p className="break-words">To: {message.to}</p><p className="whitespace-pre-wrap break-words">{message.body}</p>{message.bodyTruncated && <p className="text-hold">The saved message text is truncated; review the missing content in Gmail before deciding.</p>}{!!message.attachments.length && <ul className="list-disc pl-5">{message.attachments.map(attachment => <li key={attachment.id} className="break-words">{attachment.name} · {attachment.mimeType} · metadata only</li>)}</ul>}</div></details>)}</aside>}
    {!snapshot && <p className="text-sm text-ink-secondary">{error ? 'Saved mail work is unavailable. No empty-inbox conclusion can be drawn.' : 'Loading saved mail work…'}</p>}
    <details className="area-setup"><summary>Setup</summary><div className="space-y-4">
      <p className="text-sm text-ink-secondary">A persistent review list from the private Gmail account and scope you chose in Agency workflow setup. Check now collects mail and prepares priorities with Bud; Collect reviewed Gmail scope only saves new messages.</p>
      <div className="flex flex-wrap gap-2"><button className={button} disabled={busy || running} onClick={() => void run(async () => { await api('/api/mail-workspace/scan', { method: 'POST', body: '{}' }, { timeoutMs: 270_000 }); await refresh(); if (alive.current) setNotice('Collection request returned. Check its coverage receipt here before relying on the saved list.'); })}>Collect reviewed Gmail scope</button><button className={button} disabled={busy} onClick={() => void run(async () => { await refresh(); if (alive.current) setNotice('Saved work and receipt refreshed.'); })}>Refresh saved mail work</button></div>
      <p className="text-sm text-ink-secondary">Bud’s preparation uses the configured model service. These actions do not send replies, change Gmail labels, download attachment contents, pay bills or import accounting records.</p>
      {snapshot?.operation && <p role="status" className={`text-sm ${['failed', 'interrupted'].includes(snapshot.operation.state) ? 'text-hold' : 'text-ink-secondary'}`}>Priority review: {snapshot.operation.state}. {snapshot.operation.detail}</p>}
      {snapshot?.latestScan ? <div className="rounded-lg border border-line p-3 space-y-2 text-sm"><div className="flex flex-wrap justify-between gap-2"><strong className="font-medium">Latest source collection: {snapshot.latestScan.status}</strong><span>{date(snapshot.latestScan.completedAt ?? snapshot.latestScan.startedAt, timeZone)}</span></div><p>{snapshot.latestScan.messageCount} messages · {snapshot.latestScan.threadCount} conversations · {snapshot.latestScan.pages} pages</p><p className="text-ink-secondary">Source window: {date(snapshot.latestScan.windowStartAt, timeZone)} to {date(snapshot.latestScan.windowEndAt, timeZone)}. {timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone}.</p>{snapshot.latestScan.status !== 'complete' && <p className="text-hold">This scan cannot establish complete source coverage. Existing work remains available; an empty list does not mean there is nothing to do.</p>}{!!snapshot.latestScan.gaps.length && <details><summary className="min-h-11 cursor-pointer">Review source gaps ({snapshot.latestScan.gaps.length})</summary><ul className="list-disc pl-5 break-words">{snapshot.latestScan.gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul></details>}<p className="text-ink-secondary">{snapshot.latestReview ? `Last prepared review: ${date(snapshot.latestReview.at, timeZone)}.${snapshot.latestReview.sourceReceiptId !== snapshot.latestScan.id ? ' A newer collection is available. Check its coverage and items marked as new evidence.' : ''}` : 'No prepared review is recorded yet.'}</p></div> : snapshot && <p className="text-sm text-ink-secondary">No source collection is recorded. Finish agency setup and explicitly collect the reviewed Gmail scope.</p>}
      <div className="rounded-lg border border-line p-3 space-y-2"><h3 className="text-sm font-medium">Morning schedule</h3>{schedule ? <><p className="text-sm">{schedule.enabled ? 'Enabled' : 'Off'} · {schedule.localTime} · {schedule.timezone}</p><p className="text-sm text-ink-secondary">{schedule.detail}{schedule.enabled ? ` Next start: ${date(schedule.nextRunAt, schedule.timezone)}.` : ''}</p><button className={button} disabled={busy || (!schedule.enabled && !schedule.available)} onClick={() => void run(async () => { const enabled = !schedule.enabled; await api('/api/mail-workspace/schedule', { method: 'PATCH', body: JSON.stringify({ enabled }) }); const next = await refresh(); if (next.schedule?.enabled !== enabled) throw new Error('The schedule change could not be confirmed. Refresh before retrying.'); if (alive.current) setNotice(enabled ? 'Morning schedule enabled using the reviewed agency time and weekdays.' : 'Morning schedule is off. Any already running review keeps its own receipt.'); })}>{schedule.enabled ? 'Turn off morning schedule' : 'Enable reviewed morning schedule'}</button></> : <p className="text-sm text-ink-secondary">Schedule state is unavailable. Refresh after finishing agency setup; no schedule was enabled by opening this panel.</p>}<p className="text-xs text-ink-secondary">The local service must be running and connected. The scheduled time is a start time; source and model work can finish later.</p></div>
      {snapshot && <details className="rounded-lg border border-line p-3 text-sm"><summary className="min-h-11 cursor-pointer">Collection history</summary><div className="space-y-2"><p>Retained collection receipts show the checked source window and any coverage gaps.</p><button className={button} disabled={busy} onClick={() => void run(() => loadScans())}>Refresh collection history</button>{scanPage && <p>{scanPage.items.length} of {scanPage.total} retained collections shown.</p>}<ul className="space-y-2">{scanPage?.items.map(scan => <li key={scan.id} className="rounded border border-line p-3"><p>{date(scan.startedAt, timeZone)} · {scan.status} · {scan.threadCount} conversations</p><p className="text-ink-secondary">Source window {date(scan.windowStartAt, timeZone)} to {date(scan.windowEndAt, timeZone)}</p>{!!scan.gaps.length && <details><summary className="min-h-11 cursor-pointer">Coverage gaps ({scan.gaps.length})</summary><ul className="list-disc pl-5 break-words">{scan.gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul></details>}</li>)}</ul>{scanPage?.nextCursor && <button className={button} disabled={busy} onClick={() => void run(() => loadScans(true))}>Load more collection receipts</button>}</div></details>}
    </div></details>
    {error && <p role="alert" className="text-sm text-danger">{error}{snapshot ? ' Previously loaded records remain visible.' : ''}</p>}
    <p role="status" className="text-sm text-ink-secondary">{busy ? 'Waiting for the operation’s saved result…' : notice}</p>
  </section>;
}
