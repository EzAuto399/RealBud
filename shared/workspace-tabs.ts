import { AREA_LAYOUTS, AREA_LOOPS, DESK_AREA_IDS, DESK_LAYOUT_LABELS, NOTICE_LEVELS, NOTICE_LEVEL_LABELS, isDeskAreaId, type DeskAreaId, type DeskLayoutName, type NoticeLevel, type OfficeDesk, type OfficeDeskArea } from './desk-areas.ts';

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

/** Desk content sections, the work areas (`shared/desk-areas.ts`) among them. Header,
 * banners, recovery and error notices are not sections: they always show. `queue`
 * (Needs you) is mandatory and visible. */
export const DESK_SECTION_IDS = ['brief', 'mail', 'bills', 'bank', 'shared-work', 'go-live', 'queue', 'activity'] as const;
export type DeskSectionId = typeof DESK_SECTION_IDS[number];
/** `notify` and `layout` are this computer's own choice for a work area; absent means the office preset. */
export type DeskSection = { id: DeskSectionId; visible: boolean; notify?: NoticeLevel; layout?: DeskLayoutName };
export interface DeskLayout { sections: DeskSection[] }
/** Accepted desk layouts, newest first. `savedAt` is null for the layout that
 * was in place before the first customization. */
export type DeskLayoutHistoryEntry = { revision: number; savedAt: number | null; sections: DeskSection[] };
export const MAX_DESK_LAYOUT_HISTORY = 10;
export const DESK_SECTION_LABELS: Record<DeskSectionId, string> = {
  brief: 'Morning brief',
  mail: 'Mail priorities',
  bills: 'Bills and calendar',
  bank: 'Bank references',
  'shared-work': 'Shared work',
  'go-live': 'Get started',
  queue: 'Needs you',
  activity: 'Activity',
};
/** Areas whose scheduled jobs report into them: only these take a notice level. */
export const NOTICE_AREA_IDS: readonly DeskAreaId[] = DESK_AREA_IDS.filter(id => AREA_LOOPS[id]);
/** Areas that can render more than one layout: only these take a layout choice. */
export const LAYOUT_AREA_IDS: readonly DeskAreaId[] = DESK_AREA_IDS.filter(id => AREA_LAYOUTS[id].length > 1);
const or = (items: readonly string[]) => new Intl.ListFormat('en-AU', { type: 'disjunction' }).format(items);
const NOTIFY_RULE = `Set notices only for ${or(NOTICE_AREA_IDS.map(id => DESK_SECTION_LABELS[id]))}, to ${or(NOTICE_LEVELS.map(level => NOTICE_LEVEL_LABELS[level]))}.`;
const LAYOUT_RULE = `Choose a layout only for ${or(LAYOUT_AREA_IDS.map(id => `${DESK_SECTION_LABELS[id]} (${or(AREA_LAYOUTS[id].map(layout => DESK_LAYOUT_LABELS[layout]))})`))}.`;
/** Today's Desk order; also the fallback for an absent or invalid layout. */
export const defaultDeskSections = (): DeskSection[] => DESK_SECTION_IDS.map(id => ({ id, visible: true }));
/** A calm starting Desk for a freshly linked office: on Tasks, the brief, Get started (it hides itself once every step
 * is done) and Needs you; every work area stays a tab, since a tab costs the page nothing and a hidden one can't be found. */
export const simpleDeskSections = (): DeskSection[] => DESK_SECTION_IDS.map(id => ({ id, visible: id === 'brief' || id === 'go-live' || id === 'queue' || isDeskAreaId(id) }));
/** The office's starting Desk: today's order with the area slots in the preset's order (areas
 * it does not list keep theirs, after it), every section shown, no personal notice or layout. */
export function officeDefaultSections(office: OfficeDesk): DeskSection[] {
  const areas = [...new Set([...office.areas.map(area => area.id), ...DESK_AREA_IDS])];
  let next = 0;
  return DESK_SECTION_IDS.map(id => ({ id: isDeskAreaId(id) ? areas[next++]! : id, visible: true }));
}
/** A work area as this computer shows it: the office preset, with this computer's visibility and its own notice level and layout where set. */
export type DeskArea = Omit<OfficeDeskArea, 'available'> & { visible: boolean };
/** The office's available areas, in saved order. */
export function effectiveDeskAreas(sections: readonly DeskSection[], office: OfficeDesk): DeskArea[] {
  return sections.flatMap(section => {
    const area = office.areas.find(row => row.id === section.id && row.available);
    return area ? [{ id: area.id, title: area.title, layout: section.layout ?? area.layout, notify: section.notify ?? area.notify, visible: section.visible }] : [];
  });
}

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
  version: 3; revision: number; tabs: WorkspaceTab[];
  desk: DeskLayout; history: DeskLayoutHistoryEntry[];
  /** Absent until the person first arranges or resizes the side panel. */
  shell?: ShellLayout;
}
export interface WorkspaceTabsResponse {
  state: WorkspaceTabs | null;
  recovery: { message: string; resetToken: string } | null;
  /** The office's Desk preset; a person's choices in `state` win over it. */
  office: OfficeDesk;
}
export const validWorkspaceTabId = (value: unknown): value is string => typeof value === 'string' && /^view-[a-z0-9-]{1,64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const UNSAFE_TEXT = /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/;
export function validWorkspaceRevision(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
export const sameDeskSections = (a: readonly DeskSection[], b: readonly DeskSection[]) => a.length === b.length && a.every((section, index) => {
  const other = b[index]!;
  return section.id === other.id && section.visible === other.visible && section.notify === other.notify && section.layout === other.layout;
});
/** One plain line for what changed between two Desk layouts ("showed Mail priorities; hid Activity;
 * set Bills and calendar notices to Each new item"). */
export function deskChangeSummary(before: readonly DeskSection[], after: readonly DeskSection[]): string {
  const was = new Map(before.map(section => [section.id, section]));
  const names = (visible: boolean) => after.filter(section => section.visible === visible && was.get(section.id)?.visible === !visible).map(section => DESK_SECTION_LABELS[section.id]).join(', ');
  const notices = after.filter(section => section.notify !== was.get(section.id)?.notify)
    .map(section => `set ${DESK_SECTION_LABELS[section.id]} notices to ${section.notify ? NOTICE_LEVEL_LABELS[section.notify] : 'the office default'}`);
  const layouts = after.filter(section => section.layout !== was.get(section.id)?.layout)
    .map(section => `showed ${DESK_SECTION_LABELS[section.id]} ${section.layout ? `as ${DESK_LAYOUT_LABELS[section.layout]}` : 'in the office default layout'}`);
  const moved = before.map(section => section.id).join() !== after.map(section => section.id).join();
  return [names(true) && `showed ${names(true)}`, names(false) && `hid ${names(false)}`, ...notices, ...layouts, moved && 'changed the order'].filter(Boolean).join('; ') || 'no change';
}

/** Strict: every known section exactly once, no unknown or duplicate ids or keys, a notice
 * level only where the area sends notices, a layout only from the area's own choices, and
 * Needs you visible. With `fill` (stored files and version 2 bodies) a known section the
 * list lacks is added at the end, shown. Throws a user-facing sentence. */
export function parseDeskSections(value: unknown, fill = false): DeskSection[] {
  if (!Array.isArray(value) || (!fill && value.length !== DESK_SECTION_IDS.length)) throw new Error('Choose every Desk section once.');
  const seen = new Set<string>();
  const sections = value.map((raw): DeskSection => {
    if (!object(raw) || Object.keys(raw).some(key => !['id', 'visible', 'notify', 'layout'].includes(key)) || typeof raw.id !== 'string' || !(DESK_SECTION_IDS as readonly string[]).includes(raw.id) || seen.has(raw.id) || typeof raw.visible !== 'boolean') throw new Error('Choose every Desk section once.');
    const id = raw.id as DeskSectionId;
    seen.add(id);
    if (raw.notify !== undefined && !((NOTICE_AREA_IDS as readonly string[]).includes(id) && (NOTICE_LEVELS as readonly unknown[]).includes(raw.notify))) throw new Error(NOTIFY_RULE);
    if (raw.layout !== undefined && !((LAYOUT_AREA_IDS as readonly string[]).includes(id) && (AREA_LAYOUTS[id as DeskAreaId] as readonly unknown[]).includes(raw.layout))) throw new Error(LAYOUT_RULE);
    return { id, visible: raw.visible, ...(raw.notify !== undefined ? { notify: raw.notify as NoticeLevel } : {}), ...(raw.layout !== undefined ? { layout: raw.layout as DeskLayoutName } : {}) };
  });
  if (fill) sections.push(...DESK_SECTION_IDS.filter(id => !seen.has(id)).map(id => ({ id, visible: true })));
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
  return { sections: parseDeskSections(value.sections, true) };
}
function parseHistory(value: unknown, revision: number): DeskLayoutHistoryEntry[] {
  if (!Array.isArray(value) || value.length > MAX_DESK_LAYOUT_HISTORY) throw new Error('Desk layout history has an invalid format.');
  const revisions = new Set<number>();
  return value.map(raw => {
    if (!object(raw) || !exact(raw, ['revision', 'savedAt', 'sections']) || !validWorkspaceRevision(raw.revision) || raw.revision > revision || revisions.has(raw.revision) ||
      !(raw.savedAt === null || (Number.isSafeInteger(raw.savedAt) && Number(raw.savedAt) > 0))) throw new Error('Desk layout history has an invalid format.');
    revisions.add(raw.revision);
    return { revision: raw.revision, savedAt: raw.savedAt as number | null, sections: parseDeskSections(raw.sections, true) };
  });
}
function parseTabs(value: unknown): WorkspaceTab[] {
  if (!Array.isArray(value) || value.length > MAX_WORKSPACE_TABS) throw new Error('Saved views have an invalid format.');
  const ids = new Set<string>();
  return value.map(raw => {
    if (!object(raw) || !exact(raw, ['id', 'label', 'visible', 'view']) || !validWorkspaceTabId(raw.id) || ids.has(raw.id) || typeof raw.label !== 'string' || !raw.label.trim() || raw.label.length > 40 || UNSAFE_TEXT.test(raw.label) || typeof raw.visible !== 'boolean' || !object(raw.view) || !exact(raw.view, ['kind', 'filter'])) throw new Error('Check the saved view names and settings.');
    const kind = raw.view.kind;
    if (typeof kind !== 'string' || !Object.hasOwn(WORKSPACE_VIEW_FILTERS, kind) || typeof raw.view.filter !== 'string' || !(WORKSPACE_VIEW_FILTERS[kind as WorkspaceViewKind] as readonly string[]).includes(raw.view.filter)) throw new Error('Choose a supported saved view and filter.');
    ids.add(raw.id);
    return { id: raw.id, label: raw.label.trim(), visible: raw.visible, view: { kind: kind as WorkspaceViewKind, filter: raw.view.filter } };
  });
}
/** Accepts stored version 1 (tabs only: today's Desk order, no history) and version 2
 * (before work-area notices and layouts) and returns version 3. A known section a stored
 * layout lacks is added at the end, shown, so a new section never sends the file to
 * recovery. The revision and tabs are unchanged. */
export function parseWorkspaceTabs(value: unknown): WorkspaceTabs {
  if (object(value) && value.version === 1) {
    if (!exact(value, ['version', 'revision', 'tabs']) || !validWorkspaceRevision(value.revision)) throw new Error('Saved views have an invalid format.');
    return { version: 3, revision: value.revision, tabs: parseTabs(value.tabs), desk: { sections: defaultDeskSections() }, history: [] };
  }
  const keys = ['version', 'revision', 'tabs', 'desk', 'history'];
  if (!object(value) || !(exact(value, keys) || exact(value, [...keys, 'shell'])) || (value.version !== 2 && value.version !== 3) || !validWorkspaceRevision(value.revision)) throw new Error('Saved views have an invalid format.');
  const state: WorkspaceTabs = { version: 3, revision: value.revision, tabs: parseTabs(value.tabs), desk: parseDeskLayout(value.desk), history: parseHistory(value.history, value.revision) };
  return Object.hasOwn(value, 'shell') ? { ...state, shell: parseShellLayout(value.shell) } : state;
}
/** Strict: the office's Desk preset as the server sends it. Each area at most once, with a
 * plain title, a layout it can render, and a notice level only where it sends notices. */
export function parseOfficeDesk(value: unknown): OfficeDesk {
  const invalid = new Error("Your office's Desk setup could not be checked. Refresh before changing it.");
  if (!object(value) || !exact(value, ['source', 'areas']) || !object(value.source) || !Array.isArray(value.areas)) throw invalid;
  const source = value.source;
  if (!(exact(source, ['kind']) && source.kind === 'core') && !(exact(source, ['kind', 'packId', 'revision']) && source.kind === 'pack' && typeof source.packId === 'string' && /^[a-z][a-z0-9-]{1,79}$/.test(source.packId) && Number.isSafeInteger(source.revision) && Number(source.revision) >= 1)) throw invalid;
  const seen = new Set<string>();
  const areas = value.areas.map((raw): OfficeDeskArea => {
    if (!object(raw) || !exact(raw, ['id', 'title', 'layout', 'notify', 'available']) || !isDeskAreaId(raw.id) || seen.has(raw.id) || typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > 80 || UNSAFE_TEXT.test(raw.title) ||
      !(AREA_LAYOUTS[raw.id] as readonly unknown[]).includes(raw.layout) || !(AREA_LOOPS[raw.id] ? (NOTICE_LEVELS as readonly unknown[]).includes(raw.notify) : raw.notify === null) || typeof raw.available !== 'boolean') throw invalid;
    seen.add(raw.id);
    return { id: raw.id, title: raw.title, layout: raw.layout as DeskLayoutName, notify: raw.notify as NoticeLevel | null, available: raw.available };
  });
  return { source: source.kind === 'core' ? { kind: 'core' } : { kind: 'pack', packId: source.packId as string, revision: Number(source.revision) }, areas };
}
export function parseWorkspaceTabsResponse(value: unknown): WorkspaceTabsResponse {
  if (!object(value) || !exact(value, ['state', 'recovery', 'office'])) throw new Error('Saved views could not be checked. Refresh before changing them.');
  const office = parseOfficeDesk(value.office);
  if (value.state === null) {
    if (!object(value.recovery) || !exact(value.recovery, ['message', 'resetToken']) || typeof value.recovery.message !== 'string' || typeof value.recovery.resetToken !== 'string' || !/^[a-f0-9]{64}$/.test(value.recovery.resetToken)) throw new Error('Saved view recovery could not be checked.');
    return { state: null, recovery: { message: value.recovery.message, resetToken: value.recovery.resetToken }, office };
  }
  if (value.recovery !== null) throw new Error('Saved views could not be checked.');
  const state = parseWorkspaceTabs(value.state);
  if (!object(value.state) || value.state.version !== 3) throw new Error('Saved views could not be checked.');
  return { state, recovery: null, office };
}
