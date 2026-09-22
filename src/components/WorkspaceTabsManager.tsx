import { useState } from 'react';
import { MAX_WORKSPACE_TABS, WORKSPACE_VIEW_FILTERS, type WorkspaceTab, type WorkspaceViewKind } from '@shared/workspace-tabs';
import { useWorkspaceTabs, WORKSPACE_FILTER_LABELS, WORKSPACE_VIEW_LABELS } from '@/lib/workspace-tabs';
import { useStore } from '@/state/store';

const button = 'min-h-11 rounded border border-line bg-sheet px-3 py-2 text-[14px] text-ink hover:bg-selected disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-agency';
const input = 'min-h-11 w-full rounded border border-line bg-sheet px-3 py-2 text-[14px] text-ink focus-visible:outline-2 focus-visible:outline-agency';
const cloneTab = (tab: WorkspaceTab) => ({ ...tab, view: { ...tab.view } });
export function WorkspaceTabsManager() {
  const { data, loading, saving, error, refresh, save, reset } = useWorkspaceTabs();
  const { dispatch } = useStore();
  const [draft, setDraft] = useState<WorkspaceTab | null>(null);
  const [revision, setRevision] = useState(0);
  const [existing, setExisting] = useState(false);
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState<{ type: 'remove'; id: string; label: string; revision: number } | { type: 'reset'; revision: number | undefined; token: string | undefined } | null>(null);
  const state = data?.state;
  const blocked = loading || saving || !state;
  const change = async (tabs: WorkspaceTab[], expectedRevision: number, message: string) => {
    setNotice('');
    try { await save(tabs, expectedRevision); setDraft(null); setConfirm(null); setNotice(message); }
    catch { /* Provider preserves the error and requires a fresh read. */ }
  };
  const edit = (tab?: WorkspaceTab) => {
    if (!state) return;
    setExisting(!!tab); setRevision(state.revision); setConfirm(null); setNotice('');
    setDraft(tab ? cloneTab(tab) : { id: `view-${crypto.randomUUID()}`, label: '', visible: true, view: { kind: 'tasks', filter: 'all' } });
  };
  const move = (index: number, distance: number) => {
    if (!state) return;
    const tabs = state.tabs.map(cloneTab);
    [tabs[index], tabs[index + distance]] = [tabs[index + distance], tabs[index]];
    void change(tabs, state.revision, 'View order saved.');
  };
  return <main className="h-full min-w-0 flex-1 overflow-y-auto bg-paper p-4 sm:p-6">
    <div className="mx-auto max-w-3xl space-y-5">
      <header><p className="text-[13px] text-ink-muted">Your private workspace</p><h1 className="text-2xl font-semibold text-ink">Manage saved views</h1><p className="mt-2 text-[14px] leading-relaxed text-ink-secondary">Add shortcuts to the work you use most. Names, filters and order stay on this RealBud workspace. Changing a view does not change records, permissions or schedules.</p></header>
      <p className="text-[14px] text-ink-secondary">Desk, Ask, Schedule and You always stay available, with their usual keyboard shortcuts.</p>
      {loading && <p role="status">Loading saved views…</p>}
      {error && <p role="alert" className="text-[14px] text-danger">{error} Refresh before making another change.</p>}
      {data?.recovery && <p role="alert" className="rounded border border-hold p-3 text-[14px]">{data.recovery.message}</p>}
      {state && <>
        <div className="flex flex-wrap items-center gap-3"><button className={button} disabled={blocked || state.tabs.length >= MAX_WORKSPACE_TABS || !!draft} onClick={() => edit()}>Add saved view</button><span className="text-[13px] text-ink-muted">{state.tabs.length} of {MAX_WORKSPACE_TABS} views</span></div>
        {state.tabs.length === 0 && !draft && <div className="rounded-lg border border-line bg-sheet p-5"><h2 className="font-medium">Make this workspace yours</h2><p className="mt-2 text-[14px] text-ink-secondary">Try “Mail priorities” for private mail work, “Waiting for a reply” for waiting tasks, “Bills to review” for bills that need you, or “My scheduled work” for active jobs.</p></div>}
        <ul className="divide-y divide-line">{state.tabs.map((tab, index) => <li key={tab.id} className="space-y-3 py-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><div className="min-w-0"><h2 className="break-words font-medium text-ink">{tab.label}{!tab.visible && <span className="ml-2 text-[13px] font-normal text-ink-muted">Hidden</span>}</h2><p className="text-[13px] text-ink-secondary">{WORKSPACE_VIEW_LABELS[tab.view.kind]} · {WORKSPACE_FILTER_LABELS[tab.view.filter]}</p></div><button className={button} disabled={blocked || !tab.visible} onClick={() => dispatch({ type: 'showWorkspaceTab', id: tab.id })}>Open<span className="sr-only"> {tab.label}</span></button></div>
          <div className="flex flex-wrap gap-2">
            <button className={button} disabled={blocked || !!draft} onClick={() => edit(tab)}>Edit<span className="sr-only"> {tab.label}</span></button>
            <button className={button} disabled={blocked || !!draft} onClick={() => void change(state.tabs.map(item => item.id === tab.id ? { ...item, visible: !item.visible } : item), state.revision, tab.visible ? 'View hidden. You can show it here again.' : 'View shown.')}>{tab.visible ? 'Hide' : 'Show'}<span className="sr-only"> {tab.label}</span></button>
            <button className={button} disabled={blocked || !!draft || index === 0} onClick={() => move(index, -1)} aria-label={`Move ${tab.label} up`}>Move up</button>
            <button className={button} disabled={blocked || !!draft || index === state.tabs.length - 1} onClick={() => move(index, 1)} aria-label={`Move ${tab.label} down`}>Move down</button>
            <button className={button} disabled={blocked || !!draft} onClick={() => setConfirm({ type: 'remove', id: tab.id, label: tab.label, revision: state.revision })}>Remove<span className="sr-only"> {tab.label}</span></button>
          </div>
        </li>)}</ul>
      </>}
      {draft && <form className="space-y-4 rounded-lg border border-agency bg-sheet p-4" onSubmit={event => {
        event.preventDefault(); if (!state) return;
        void change(existing ? state.tabs.map(tab => tab.id === draft.id ? draft : tab) : [...state.tabs, draft], revision, existing ? 'Saved view updated.' : 'Saved view added.');
      }}>
        <h2 className="font-medium">{existing ? 'Edit saved view' : 'New saved view'}</h2>
        {state && revision !== state.revision && <p role="alert" className="text-[14px] text-hold">Saved views changed in another window. Your wording is kept. Cancel and reopen this view to edit the current version.</p>}
        <label htmlFor="workspace-view-name" className="block space-y-1 text-[14px]"><span>View name</span><input id="workspace-view-name" autoFocus className={input} value={draft.label} required maxLength={40} onChange={event => setDraft({ ...draft, label: event.target.value })} /></label>
        <div className="grid gap-4 sm:grid-cols-2"><label htmlFor="workspace-view-kind" className="block space-y-1 text-[14px]"><span>Work to show</span><select id="workspace-view-kind" aria-label="Work to show" className={input} value={draft.view.kind} onChange={event => { const kind = event.target.value as WorkspaceViewKind; setDraft({ ...draft, view: { kind, filter: WORKSPACE_VIEW_FILTERS[kind][0] } }); }}>{Object.entries(WORKSPACE_VIEW_LABELS).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></label>
          <label htmlFor="workspace-view-filter" className="block space-y-1 text-[14px]"><span>Filter</span><select id="workspace-view-filter" aria-label="Filter" className={input} value={draft.view.filter} onChange={event => setDraft({ ...draft, view: { ...draft.view, filter: event.target.value } })}>{WORKSPACE_VIEW_FILTERS[draft.view.kind].map(filter => <option key={filter} value={filter}>{WORKSPACE_FILTER_LABELS[filter]}</option>)}</select></label></div>
        <p className="text-[13px] text-ink-secondary">Preview: {draft.label.trim() || 'New view'} shows {WORKSPACE_VIEW_LABELS[draft.view.kind].toLowerCase()} · {WORKSPACE_FILTER_LABELS[draft.view.filter].toLowerCase()}. Shared work still requires your office sign-in.</p>
        <div className="flex flex-wrap gap-2"><button className={button} disabled={blocked || !draft.label.trim() || revision !== state?.revision}>Save view</button><button type="button" className={button} disabled={saving} onClick={() => setDraft(null)}>Cancel edit</button></div>
      </form>}
      {confirm && <div role="group" aria-label="Confirm saved view change" className="space-y-3 rounded-lg border border-hold bg-sheet p-4"><h2 className="font-medium">{confirm.type === 'remove' ? `Remove “${confirm.label}”?` : 'Reset your saved views?'}</h2><p className="text-[14px]">{confirm.type === 'remove' ? 'This removes the shortcut. Its tasks, bills and job records remain.' : 'All personal saved view shortcuts will be removed. Standard navigation and business records remain. Damaged settings are kept as a recovery copy.'}</p><div className="flex flex-wrap gap-2"><button className={button} disabled={loading || saving || (confirm.type === 'reset' ? confirm.revision !== state?.revision || confirm.token !== data?.recovery?.resetToken : !state || confirm.revision !== state.revision)} onClick={() => {
        if (confirm.type === 'remove' && state) void change(state.tabs.filter(tab => tab.id !== confirm.id), confirm.revision, 'View removed. Records remain unchanged.');
        else void reset().then(() => { setDraft(null); setConfirm(null); setNotice('Saved views reset. Standard navigation remains.'); }).catch(() => {});
      }}>Confirm {confirm.type === 'remove' ? 'removal' : 'reset'}</button><button className={button} disabled={saving} onClick={() => setConfirm(null)}>Keep current views</button></div></div>}
      <p role="status" className="text-[14px] text-ink-secondary">{saving ? 'Saving views…' : notice}</p>
      <footer className="flex flex-wrap gap-2 border-t border-line pt-4"><button className={button} disabled={loading || saving} onClick={() => void refresh()}>Refresh views</button><button className={button} disabled={loading || saving || !data || !!draft || (!!state && state.tabs.length === 0)} onClick={() => setConfirm({ type: 'reset', revision: state?.revision, token: data?.recovery?.resetToken })}>Reset saved views</button><button className={button} onClick={() => dispatch({ type: 'showYou' })}>Open settings</button></footer>
    </div>
  </main>;
}
