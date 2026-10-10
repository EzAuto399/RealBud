import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '@/state/store';
import { deskChangeSummary, parseWorkspaceTabsResponse, validWorkspaceRevision, type DeskSection, type ShellLayout, type WorkspaceTab, type WorkspaceTabs, type WorkspaceTabsResponse } from '@shared/workspace-tabs';
import type { OfficeDesk } from '@shared/desk-areas';

/** The service saved a change (detail `{ revision, by? }` from its event), or the
 *  event stream reconnected (no detail) and announcements may have been missed. */
export const WORKSPACE_TABS_CHANGED = 'realbud:workspace-tabs-changed';
type Announcement = { revision?: number; by?: 'bud' };
const announcement = (detail: unknown): Announcement => {
  const value = detail && typeof detail === 'object' ? detail as Record<string, unknown> : {};
  return { ...(validWorkspaceRevision(value.revision) ? { revision: value.revision } : {}), ...(value.by === 'bud' ? { by: 'bud' as const } : {}) };
};

/** What a window does with an announcement: nothing to read when it already holds that
 *  revision, wait while its own save is in flight, otherwise reread. A reconnect (no
 *  revision) and a lower revision reread too: a recovery reset starts again at 1. */
export function announcementNeeds(said: { revision?: number }, held: number | undefined, saving: boolean): 'held' | 'later' | 'reread' {
  if (said.revision !== undefined && said.revision === held) return 'held';
  return saving ? 'later' : 'reread';
}

/** A Desk layout Bud saved, and the earlier layout Undo restores. */
export type BudDeskChange = { revision: number; toRevision: number; summary: string };
/** Bud's change at `revision` when it saved a new layout (newest history entry) over an earlier one; null for a saved-view-only change. */
export function budDeskChange(state: WorkspaceTabs | null | undefined, revision: number): BudDeskChange | null {
  const [made, earlier] = state?.history ?? [];
  if (!state || state.revision !== revision || made?.revision !== revision || !earlier) return null;
  return { revision, toRevision: earlier.revision, summary: deskChangeSummary(earlier.sections, made.sections) };
}
/** Undo puts back the layout before Bud's change, only while Desk is still as Bud left it.
 *  Returns the notice to show; when Desk changed since, it offers Arrange Desk to fix it by hand. */
export async function undoBudDeskChange(change: BudDeskChange, revert: (toRevision: number, expectedRevision: number) => Promise<void>): Promise<{ message: string; openArrange?: true }> {
  try { await revert(change.toRevision, change.revision); return { message: 'Desk is back as it was before Bud arranged it.' }; }
  catch (cause) {
    if ((cause as { code?: unknown }).code === 'tabs_changed') return { message: "Desk was changed after Bud's change, so nothing was undone.", openArrange: true };
    throw cause;
  }
}

type TabsContext = {
  data: WorkspaceTabsResponse | null; loading: boolean; saving: boolean; error: string;
  /** The office's Desk preset from the last good answer; null until one is read. A failed read or save keeps it,
   *  so pack titles and areas (Bank references) don't fall back to the core preset. */
  office: OfficeDesk | null;
  /** The latest Desk layout Bud saved while this window was open. */
  budChange: BudDeskChange | null;
  refresh(): Promise<void>; save(tabs: WorkspaceTab[], expectedRevision: number): Promise<void>; reset(): Promise<void>;
  /** Desk layout changes: a 409 keeps the last good layout and rereads it, so the caller keeps its draft. */
  saveDesk(sections: DeskSection[], expectedRevision: number, shell?: ShellLayout): Promise<void>; revertDesk(toRevision: number, expectedRevision: number): Promise<void>;
};
const Context = createContext<TabsContext | null>(null);
let lastRead: WorkspaceTabsResponse | null = null;
/** The last layout and office preset this window read, for readers outside React (desktop notices).
 *  Null until the first read; a failed read keeps the last good one. */
export const lastWorkspaceTabs = () => lastRead;
export function WorkspaceTabsProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<WorkspaceTabsResponse | null>(null);
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const [budChange, setBudChange] = useState<BudDeskChange | null>(null);
  const [office, setOffice] = useState<OfficeDesk | null>(null);
  const alive = useRef(true), generation = useRef(0), pending = useRef(false);
  // The last state this window holds, and an announcement heard while its own save was in flight.
  const latest = useRef<WorkspaceTabsResponse | null>(null), missed = useRef<Announcement | null>(null);
  const apply = (next: WorkspaceTabsResponse | null) => { latest.current = next; if (next) { lastRead = next; setOffice(next.office); } setData(next); };
  const refresh = useCallback(async (): Promise<WorkspaceTabsResponse | null> => {
    if (pending.current) return null;
    const request = ++generation.current;
    setLoading(true); setError('');
    try {
      const next = parseWorkspaceTabsResponse(await api('/api/workspace-tabs'));
      if (alive.current && generation.current === request) apply(next);
      return next;
    } catch (cause) {
      if (alive.current && generation.current === request) { apply(null); setError(cause instanceof Error ? cause.message : 'Saved views could not be checked.'); }
      return null;
    } finally { if (alive.current && generation.current === request) setLoading(false); }
  }, []);
  // Reread only for a revision this window does not hold; a change Bud saved offers Undo.
  const hear = useCallback((said: Announcement) => {
    const offer = (state?: WorkspaceTabs | null) => {
      const change = said.by === 'bud' && said.revision !== undefined ? budDeskChange(state, said.revision) : null;
      if (change && alive.current) setBudChange(change);
    };
    const need = announcementNeeds(said, latest.current?.state?.revision, pending.current);
    if (need === 'held') return offer(latest.current?.state);
    if (need === 'later') { missed.current = said; return; }
    void refresh().then(next => offer(next?.state));
  }, [refresh]);
  useEffect(() => {
    alive.current = true; void refresh();
    const changed = (event: Event) => hear(announcement((event as CustomEvent<unknown>).detail));
    window.addEventListener(WORKSPACE_TABS_CHANGED, changed);
    return () => { alive.current = false; generation.current++; window.removeEventListener(WORKSPACE_TABS_CHANGED, changed); };
  }, [refresh, hear]);
  const mutate = async (path: string, body: unknown, method: string, desk = false) => {
    if (pending.current) throw new Error('Wait for the current saved view change.');
    pending.current = true; generation.current++; setSaving(true); setLoading(false); setError('');
    let conflict = false;
    try {
      const next = parseWorkspaceTabsResponse(await api(path, { method, body: JSON.stringify(body) }));
      if (alive.current) apply(next);
    } catch (cause) {
      // A definitive Desk conflict leaves the stored layout in place; anything else may hide a committed write.
      conflict = desk && (cause as { status?: number }).status === 409;
      if (alive.current && !conflict) { apply(null); setError(cause instanceof Error ? cause.message : 'The change could not be confirmed. Refresh before retrying.'); }
      throw cause;
    } finally {
      pending.current = false; if (alive.current) setSaving(false);
      const heard = missed.current; missed.current = null;
      if (heard) hear(heard); else if (conflict) void refresh();
    }
  };
  return <Context.Provider value={{ data, loading, saving, error, office, budChange, refresh: async () => { await refresh(); },
    save: (tabs, expectedRevision) => mutate('/api/workspace-tabs', { version: 1, tabs, expectedRevision }, 'PUT'),
    reset: () => mutate('/api/workspace-tabs/reset', { expectedRevision: data?.state?.revision, ...(data?.recovery ? { resetToken: data.recovery.resetToken } : {}), confirm: true }, 'POST'),
    saveDesk: (sections, expectedRevision, shell) => {
      if (!data?.state) return Promise.reject(new Error('Saved views need checking before the Desk layout can change.'));
      return mutate('/api/workspace-tabs', { version: 3, tabs: data.state.tabs, desk: { sections }, ...(shell ? { shell } : {}), expectedRevision }, 'PUT', true);
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
