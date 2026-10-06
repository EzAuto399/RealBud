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

/** Desk content sections. Header, banners, recovery and error notices are not
 * sections: they always show. `queue` (Needs you) is mandatory and visible. */
export const DESK_SECTION_IDS = ['brief', 'mail', 'bills', 'shared-work', 'go-live', 'queue', 'activity'] as const;
export type DeskSectionId = typeof DESK_SECTION_IDS[number];
export type DeskSection = { id: DeskSectionId; visible: boolean };
export interface DeskLayout { sections: DeskSection[] }
/** Accepted desk layouts, newest first. `savedAt` is null for the layout that
 * was in place before the first customization. */
export type DeskLayoutHistoryEntry = { revision: number; savedAt: number | null; sections: DeskSection[] };
export const MAX_DESK_LAYOUT_HISTORY = 10;
export const DESK_SECTION_LABELS: Record<DeskSectionId, string> = {
  brief: 'Morning brief',
  mail: 'Mail priorities',
  bills: 'Bills and calendar',
  'shared-work': 'Shared work',
  'go-live': 'Get started',
  queue: 'Needs you',
  activity: 'Activity',
};
/** Today's Desk order; also the fallback for an absent or invalid layout. */
export const defaultDeskSections = (): DeskSection[] => DESK_SECTION_IDS.map(id => ({ id, visible: true }));
/** A calm starting Desk for a freshly linked office: brief, Get started (it hides itself once every step is done) and Needs you. */
export const simpleDeskSections = (): DeskSection[] => DESK_SECTION_IDS.map(id => ({ id, visible: id === 'brief' || id === 'go-live' || id === 'queue' }));

/** Right-hand context panels. Approval surfaces always show: the panel only
 * mirrors and links to the case, where Approve, Stop and recovery stay. */
export const SHELL_PANEL_IDS = ['evidence', 'approvals', 'today', 'activity', 'accounts'] as const;
export type ShellPanelId = typeof SHELL_PANEL_IDS[number];
export const SHELL_PANEL_LABELS: Record<ShellPanelId, string> = {
  evidence: 'Evidence', approvals: 'Approvals waiting', today: 'Today', activity: 'Bud activity', accounts: 'Connected accounts',
};
export const LOCKED_SHELL_PANELS: readonly ShellPanelId[] = ['approvals'];
/** Desk sections that carry approval, safety or recovery work and so cannot be hidden. */
export const LOCKED_DESK_SECTIONS: readonly DeskSectionId[] = ['queue'];
export const SHELL_PANEL_WIDTH = { min: 280, max: 560, default: 340 } as const;
export type ShellPanel = { id: ShellPanelId; visible: boolean };
export interface ShellLayout { panelWidth: number; panels: ShellPanel[] }
const RECOMMENDED_PANELS: readonly ShellPanelId[] = ['evidence', 'approvals', 'today'];
export const defaultShellLayout = (): ShellLayout => ({ panelWidth: SHELL_PANEL_WIDTH.default, panels: SHELL_PANEL_IDS.map(id => ({ id, visible: RECOMMENDED_PANELS.includes(id) })) });

export interface WorkspaceTabs {
  version: 2; revision: number; tabs: WorkspaceTab[];
  desk: DeskLayout; history: DeskLayoutHistoryEntry[];
  /** Absent until the person first arranges or resizes the side panel. */
  shell?: ShellLayout;
}
export interface WorkspaceTabsResponse {
  state: WorkspaceTabs | null;
  recovery: { message: string; resetToken: string } | null;
}
export const validWorkspaceTabId = (value: unknown): value is string => typeof value === 'string' && /^view-[a-z0-9-]{1,64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export function validWorkspaceRevision(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
export const sameDeskSections = (a: readonly DeskSection[], b: readonly DeskSection[]) => a.length === b.length && a.every((section, index) => section.id === b[index]!.id && section.visible === b[index]!.visible);

/** Strict: every known section exactly once, no unknown or duplicate ids, and
 * Needs you present and visible. Throws a user-facing sentence. */
export function parseDeskSections(value: unknown): DeskSection[] {
  if (!Array.isArray(value) || value.length !== DESK_SECTION_IDS.length) throw new Error('Choose every Desk section once.');
  const seen = new Set<string>();
  const sections = value.map(raw => {
    if (!object(raw) || !exact(raw, ['id', 'visible']) || typeof raw.id !== 'string' || !(DESK_SECTION_IDS as readonly string[]).includes(raw.id) || seen.has(raw.id) || typeof raw.visible !== 'boolean') throw new Error('Choose every Desk section once.');
    seen.add(raw.id);
    return { id: raw.id as DeskSectionId, visible: raw.visible };
  });
  if (!sections.some(section => section.id === 'queue' && section.visible)) throw new Error('Needs you always stays on Desk.');
  return sections;
}
/** Strict: every panel once, a whole-pixel width in range, approvals visible. Throws a user-facing sentence. */
export function parseShellLayout(value: unknown): ShellLayout {
  if (!object(value) || !exact(value, ['panelWidth', 'panels'])) throw new Error('Check the side panel settings.');
  const width = value.panelWidth;
  if (!Number.isSafeInteger(width) || Number(width) < SHELL_PANEL_WIDTH.min || Number(width) > SHELL_PANEL_WIDTH.max) throw new Error('Choose a side panel width that fits the window.');
  if (!Array.isArray(value.panels) || value.panels.length !== SHELL_PANEL_IDS.length) throw new Error('Choose every side panel once.');
  const seen = new Set<string>();
  const panels = value.panels.map(raw => {
    if (!object(raw) || !exact(raw, ['id', 'visible']) || typeof raw.id !== 'string' || !(SHELL_PANEL_IDS as readonly string[]).includes(raw.id) || seen.has(raw.id) || typeof raw.visible !== 'boolean') throw new Error('Choose every side panel once.');
    seen.add(raw.id);
    return { id: raw.id as ShellPanelId, visible: raw.visible };
  });
  if (panels.some(panel => LOCKED_SHELL_PANELS.includes(panel.id) && !panel.visible)) throw new Error('Approvals waiting always stays in the side panel.');
  return { panelWidth: Number(width), panels };
}
/** Renderer fallback: an absent or invalid layout renders today's order. */
export function deskSectionsOrDefault(value: unknown): DeskSection[] {
  try { return parseDeskSections(value); } catch { return defaultDeskSections(); }
}
function parseDeskLayout(value: unknown): DeskLayout {
  if (!object(value) || !exact(value, ['sections'])) throw new Error('Desk layout has an invalid format.');
  return { sections: parseDeskSections(value.sections) };
}
function parseHistory(value: unknown, revision: number): DeskLayoutHistoryEntry[] {
  if (!Array.isArray(value) || value.length > MAX_DESK_LAYOUT_HISTORY) throw new Error('Desk layout history has an invalid format.');
  const revisions = new Set<number>();
  return value.map(raw => {
    if (!object(raw) || !exact(raw, ['revision', 'savedAt', 'sections']) || !validWorkspaceRevision(raw.revision) || raw.revision > revision || revisions.has(raw.revision) ||
      !(raw.savedAt === null || (Number.isSafeInteger(raw.savedAt) && Number(raw.savedAt) > 0))) throw new Error('Desk layout history has an invalid format.');
    revisions.add(raw.revision);
    return { revision: raw.revision, savedAt: raw.savedAt as number | null, sections: parseDeskSections(raw.sections) };
  });
}
function parseTabs(value: unknown): WorkspaceTab[] {
  if (!Array.isArray(value) || value.length > MAX_WORKSPACE_TABS) throw new Error('Saved views have an invalid format.');
  const ids = new Set<string>();
  return value.map(raw => {
    if (!object(raw) || !exact(raw, ['id', 'label', 'visible', 'view']) || !validWorkspaceTabId(raw.id) || ids.has(raw.id) || typeof raw.label !== 'string' || !raw.label.trim() || raw.label.length > 40 || /[\x00-\x1f\x7f‪-‮⁦-⁩]/.test(raw.label) || typeof raw.visible !== 'boolean' || !object(raw.view) || !exact(raw.view, ['kind', 'filter'])) throw new Error('Check the saved view names and settings.');
    const kind = raw.view.kind;
    if (typeof kind !== 'string' || !Object.hasOwn(WORKSPACE_VIEW_FILTERS, kind) || typeof raw.view.filter !== 'string' || !(WORKSPACE_VIEW_FILTERS[kind as WorkspaceViewKind] as readonly string[]).includes(raw.view.filter)) throw new Error('Choose a supported saved view and filter.');
    ids.add(raw.id);
    return { id: raw.id, label: raw.label.trim(), visible: raw.visible, view: { kind: kind as WorkspaceViewKind, filter: raw.view.filter } };
  });
}
/** Accepts stored version 1 (tabs only) and migrates it to version 2 with the
 * default Desk order and no history. The revision and tabs are unchanged. */
export function parseWorkspaceTabs(value: unknown): WorkspaceTabs {
  if (object(value) && value.version === 1) {
    if (!exact(value, ['version', 'revision', 'tabs']) || !validWorkspaceRevision(value.revision)) throw new Error('Saved views have an invalid format.');
    return { version: 2, revision: value.revision, tabs: parseTabs(value.tabs), desk: { sections: defaultDeskSections() }, history: [] };
  }
  const keys = ['version', 'revision', 'tabs', 'desk', 'history'];
  if (!object(value) || !(exact(value, keys) || exact(value, [...keys, 'shell'])) || value.version !== 2 || !validWorkspaceRevision(value.revision)) throw new Error('Saved views have an invalid format.');
  const state: WorkspaceTabs = { version: 2, revision: value.revision, tabs: parseTabs(value.tabs), desk: parseDeskLayout(value.desk), history: parseHistory(value.history, value.revision) };
  return Object.hasOwn(value, 'shell') ? { ...state, shell: parseShellLayout(value.shell) } : state;
}
export function parseWorkspaceTabsResponse(value: unknown): WorkspaceTabsResponse {
  if (!object(value) || !exact(value, ['state', 'recovery'])) throw new Error('Saved views could not be checked. Refresh before changing them.');
  if (value.state === null) {
    if (!object(value.recovery) || !exact(value.recovery, ['message', 'resetToken']) || typeof value.recovery.message !== 'string' || typeof value.recovery.resetToken !== 'string' || !/^[a-f0-9]{64}$/.test(value.recovery.resetToken)) throw new Error('Saved view recovery could not be checked.');
    return { state: null, recovery: { message: value.recovery.message, resetToken: value.recovery.resetToken } };
  }
  if (value.recovery !== null) throw new Error('Saved views could not be checked.');
  const state = parseWorkspaceTabs(value.state);
  if (!object(value.state) || value.state.version !== 2) throw new Error('Saved views could not be checked.');
  return { state, recovery: null };
}
