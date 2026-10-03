import { useLayoutEffect, useRef, useState } from 'react';
import { MessageCircle, RefreshCw } from 'lucide-react';
import { useWorkspaceTabs, WORKSPACE_FILTER_LABELS, WORKSPACE_VIEW_LABELS } from '@/lib/workspace-tabs';
import { useStore } from '@/state/store';
import { Card } from './SettingsPrimitives';

const button = 'pm-control inline-flex min-h-11 items-center justify-center gap-2 rounded border border-line bg-sheet px-3 py-2 text-[14px] text-ink hover:bg-selected disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-agency';
const quietButton = 'pm-control inline-flex min-h-11 items-center justify-center gap-2 rounded px-3 py-2 text-[14px] text-ink-secondary hover:bg-selected hover:text-ink disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-agency';

/** Read-only: Bud changes saved views (each change is approved in Ask). Only the damaged-settings recovery stays here. */
export function WorkspaceTabsManager() {
  const { data, loading, saving, error, refresh, reset } = useWorkspaceTabs();
  const { dispatch } = useStore();
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState<{ revision: number | undefined; token: string | undefined } | null>(null);
  const confirmationElement = useRef<HTMLDivElement>(null), confirmationOpener = useRef<HTMLElement | null>(null), heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    if (confirm) {
      confirmationElement.current?.focus({ preventScroll: true });
      confirmationElement.current?.scrollIntoView({ block: 'nearest' });
    } else if (confirmationOpener.current) {
      const opener = confirmationOpener.current;
      confirmationOpener.current = null;
      const target = opener.isConnected && !opener.matches(':disabled') && opener.getClientRects().length ? opener : heading.current;
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: 'nearest' });
    }
  }, [confirm]);
  const state = data?.state;
  const blocked = loading || saving || !state;
  return <main className="h-full min-h-0 min-w-0 flex-1 overflow-y-auto bg-paper p-4 min-[720px]:p-8">
    <div className="mx-auto max-w-4xl space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-4">
        <div className="min-w-0"><h1 ref={heading} tabIndex={-1} className="text-[26px] font-semibold tracking-tight text-ink focus-visible:outline-2 focus-visible:outline-agency">Saved views</h1><p className="mt-1 text-[14px] text-ink-secondary">Bud sets these up. Ask Bud to add, rename, hide, reorder or remove a view.</p></div>
        <div className="flex items-center gap-1">
          <button className="pm-decision inline-flex min-h-11 items-center gap-2 rounded bg-agency px-4 py-2 text-[14px] font-medium text-sheet hover:bg-agency-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-agency" onClick={() => dispatch({ type: 'showAsk' })}><MessageCircle size={16} aria-hidden />Ask Bud</button>
          <button className={quietButton} aria-label="Refresh views" title="Refresh views" disabled={loading || saving} onClick={() => void refresh()}><RefreshCw size={17} aria-hidden /></button>
        </div>
      </header>
      {loading && <p role="status" className="text-[14px] text-ink-secondary">Loading saved views…</p>}
      {error && <p role="alert" className="text-[14px] text-danger">{error} Refresh before making another change.</p>}
      {data?.recovery && <Card><div role="alert" className="space-y-3"><p className="text-[14px] text-hold">{data.recovery.message}</p><button className={button} disabled={loading || saving} onClick={event => { confirmationOpener.current = event.currentTarget; setConfirm({ revision: state?.revision, token: data.recovery?.resetToken }); }}>Reset saved views</button></div></Card>}
      {confirm && <div ref={confirmationElement} tabIndex={-1} role="group" aria-label="Confirm saved view change" className="rounded-lg focus-visible:outline-2 focus-visible:outline-agency"><Card><div className="space-y-3"><h2 className="font-medium">Reset your saved views?</h2><p className="text-[14px]">All personal saved view shortcuts will be removed. Standard navigation and business records remain. Damaged settings are kept as a recovery copy.</p><div className="flex flex-wrap gap-2"><button className={button} disabled={loading || saving || confirm.revision !== state?.revision || confirm.token !== data?.recovery?.resetToken} onClick={() => {
        void reset().then(() => { setConfirm(null); setNotice('Saved views reset. Standard navigation remains.'); }).catch(() => {});
      }}>Confirm reset</button><button className={button} disabled={saving} onClick={() => setConfirm(null)}>Keep current views</button></div></div></Card></div>}
      {state && <section aria-label="Saved views">
        {state.tabs.length === 0 && <p className="py-8 max-w-lg text-[14px] leading-relaxed text-ink-secondary">No saved views yet. Ask Bud for one, such as “Waiting for a reply” or “Bills to review”.</p>}
        <ul className="divide-y divide-line">{state.tabs.map(tab => <li key={tab.id} className="flex flex-wrap items-center gap-x-5 gap-y-1 py-3">
          <div className="min-w-0 flex-1 basis-48"><div className="flex flex-wrap items-center gap-x-2"><h2 className="break-words text-[15px] font-medium text-ink">{tab.label}</h2>{!tab.visible && <span className="text-[12px] text-ink-muted">Hidden</span>}</div><p className="mt-0.5 text-[13px] text-ink-secondary">{WORKSPACE_VIEW_LABELS[tab.view.kind]} · {WORKSPACE_FILTER_LABELS[tab.view.filter]}</p></div>
          <button className={`${button} ml-auto shrink-0`} disabled={blocked || !tab.visible} onClick={() => dispatch({ type: 'showWorkspaceTab', id: tab.id })}>Open<span className="sr-only"> {tab.label}</span></button>
        </li>)}</ul>
      </section>}
      <p role="status" aria-live="polite" className="text-[14px] text-ink-secondary">{saving ? 'Saving views…' : notice}</p>
      <footer className="border-t border-line pt-4 text-[13px] leading-relaxed text-ink-muted">Views change what you see, not your records or permissions. Desk, Ask, Schedule and Workspace stay available.</footer>
    </div>
  </main>;
}
