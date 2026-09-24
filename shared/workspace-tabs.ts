/** Saved views contain display preferences only, never executable code or authority. */
export const MAX_WORKSPACE_TABS = 12;
export const WORKSPACE_VIEW_FILTERS = {
  tasks: ['all', 'now', 'next', 'waiting', 'done'],
  bills: ['all', 'needs-you', 'due-soon', 'in-process', 'settled'],
  jobs: ['all', 'shadow', 'active', 'paused'],
  'shared-work': ['with-me', 'by-me'],
  mail: ['open', 'waiting', 'reference', 'snoozed', 'done'],
} as const;
export type WorkspaceViewKind = keyof typeof WORKSPACE_VIEW_FILTERS;
export type WorkspaceTab = { id: string; label: string; visible: boolean; view: {
  kind: WorkspaceViewKind; filter: string;
} };
export interface WorkspaceTabs { version: 1; revision: number; tabs: WorkspaceTab[] }
export interface WorkspaceTabsResponse {
  state: WorkspaceTabs | null;
  recovery: { message: string; resetToken: string } | null;
}
export const validWorkspaceTabId = (value: unknown): value is string => typeof value === 'string' && /^view-[a-z0-9-]{1,64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export function validWorkspaceRevision(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
export function parseWorkspaceTabs(value: unknown): WorkspaceTabs {
  if (!object(value) || !exact(value, ['version', 'revision', 'tabs']) || value.version !== 1 || !validWorkspaceRevision(value.revision) || !Array.isArray(value.tabs) || value.tabs.length > MAX_WORKSPACE_TABS) throw new Error('Saved views have an invalid format.');
  const ids = new Set<string>();
  const tabs = value.tabs.map(raw => {
    if (!object(raw) || !exact(raw, ['id', 'label', 'visible', 'view']) || !validWorkspaceTabId(raw.id) || ids.has(raw.id) || typeof raw.label !== 'string' || !raw.label.trim() || raw.label.length > 40 || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(raw.label) || typeof raw.visible !== 'boolean' || !object(raw.view) || !exact(raw.view, ['kind', 'filter'])) throw new Error('Check the saved view names and settings.');
    const kind = raw.view.kind;
    if (typeof kind !== 'string' || !Object.hasOwn(WORKSPACE_VIEW_FILTERS, kind) || typeof raw.view.filter !== 'string' || !(WORKSPACE_VIEW_FILTERS[kind as WorkspaceViewKind] as readonly string[]).includes(raw.view.filter)) throw new Error('Choose a supported saved view and filter.');
    ids.add(raw.id);
    return { id: raw.id, label: raw.label.trim(), visible: raw.visible, view: { kind: kind as WorkspaceViewKind, filter: raw.view.filter } };
  });
  return { version: 1, revision: value.revision, tabs };
}
export function parseWorkspaceTabsResponse(value: unknown): WorkspaceTabsResponse {
  if (!object(value) || !exact(value, ['state', 'recovery'])) throw new Error('Saved views could not be checked. Refresh before changing them.');
  if (value.state === null) {
    if (!object(value.recovery) || !exact(value.recovery, ['message', 'resetToken']) || typeof value.recovery.message !== 'string' || typeof value.recovery.resetToken !== 'string' || !/^[a-f0-9]{64}$/.test(value.recovery.resetToken)) throw new Error('Saved view recovery could not be checked.');
    return { state: null, recovery: { message: value.recovery.message, resetToken: value.recovery.resetToken } };
  }
  if (value.recovery !== null) throw new Error('Saved views could not be checked.');
  return { state: parseWorkspaceTabs(value.state), recovery: null };
}
