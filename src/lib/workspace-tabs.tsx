import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '@/state/store';
import { parseWorkspaceTabsResponse, type DeskSection, type WorkspaceTab, type WorkspaceTabsResponse } from '@shared/workspace-tabs';

type TabsContext = {
  data: WorkspaceTabsResponse | null; loading: boolean; saving: boolean; error: string;
  refresh(): Promise<void>; save(tabs: WorkspaceTab[], expectedRevision: number): Promise<void>; reset(): Promise<void>;
  /** Desk layout changes: a 409 keeps the last good layout and rereads it, so the caller keeps its draft. */
  saveDesk(sections: DeskSection[], expectedRevision: number): Promise<void>; revertDesk(toRevision: number, expectedRevision: number): Promise<void>;
};
const Context = createContext<TabsContext | null>(null);
export function WorkspaceTabsProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<WorkspaceTabsResponse | null>(null);
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const alive = useRef(true), generation = useRef(0), pending = useRef(false);
  const refresh = useCallback(async () => {
    if (pending.current) return;
    const request = ++generation.current;
    setLoading(true); setError('');
    try {
      const next = parseWorkspaceTabsResponse(await api('/api/workspace-tabs'));
      if (alive.current && generation.current === request) setData(next);
    } catch (cause) {
      if (alive.current && generation.current === request) { setData(null); setError(cause instanceof Error ? cause.message : 'Saved views could not be checked.'); }
    } finally { if (alive.current && generation.current === request) setLoading(false); }
  }, []);
  useEffect(() => {
    alive.current = true; void refresh();
    const focus = () => { void refresh(); };
    window.addEventListener('focus', focus);
    return () => { alive.current = false; generation.current++; window.removeEventListener('focus', focus); };
  }, [refresh]);
  const mutate = async (path: string, body: unknown, method: string, desk = false) => {
    if (pending.current) throw new Error('Wait for the current saved view change.');
    pending.current = true; generation.current++; setSaving(true); setLoading(false); setError('');
    let conflict = false;
    try {
      const next = parseWorkspaceTabsResponse(await api(path, { method, body: JSON.stringify(body) }));
      if (alive.current) setData(next);
    } catch (cause) {
      // A definitive Desk conflict leaves the stored layout in place; anything else may hide a committed write.
      conflict = desk && (cause as { status?: number }).status === 409;
      if (alive.current && !conflict) { setData(null); setError(cause instanceof Error ? cause.message : 'The change could not be confirmed. Refresh before retrying.'); }
      throw cause;
    } finally { pending.current = false; if (alive.current) setSaving(false); if (conflict) void refresh(); }
  };
  return <Context.Provider value={{ data, loading, saving, error, refresh,
    save: (tabs, expectedRevision) => mutate('/api/workspace-tabs', { version: 1, tabs, expectedRevision }, 'PUT'),
    reset: () => mutate('/api/workspace-tabs/reset', { expectedRevision: data?.state?.revision, ...(data?.recovery ? { resetToken: data.recovery.resetToken } : {}), confirm: true }, 'POST'),
    saveDesk: (sections, expectedRevision) => {
      if (!data?.state) return Promise.reject(new Error('Saved views need checking before the Desk layout can change.'));
      return mutate('/api/workspace-tabs', { version: 2, tabs: data.state.tabs, desk: { sections }, expectedRevision }, 'PUT', true);
    },
    revertDesk: (toRevision, expectedRevision) => mutate('/api/workspace-tabs/revert', { expectedRevision, toRevision }, 'POST', true),
  }}>{children}</Context.Provider>;
}
export function useWorkspaceTabs() {
  const context = useContext(Context);
  if (!context) throw new Error('Workspace views need their provider.');
  return context;
}
export const WORKSPACE_VIEW_LABELS = { tasks: 'Tasks', bills: 'Bills', jobs: 'Saved jobs', 'shared-work': 'Shared work', mail: 'Mail priorities and follow-ups' };
export const WORKSPACE_FILTER_LABELS: Record<string, string> = {
  all: 'All', now: 'Needs you', next: 'Next', waiting: 'Waiting', done: 'Done',
  'needs-you': 'Needs you', 'due-soon': 'Due or expected', 'in-process': 'In process', settled: 'Settled',
  shadow: 'Needs plan approval', active: 'Active', paused: 'Paused', 'with-me': 'Shared with me', 'by-me': 'Shared by me',
  open: 'Needs attention', reference: 'Reference', snoozed: 'Snoozed',
};
