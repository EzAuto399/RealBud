/** Desk work areas: one tab per workflow. The core decides which areas it can
 * render; the office's workflow pack may preset their titles, layouts and notice
 * levels; a person's choices on this computer win. Display only: an area grants
 * no access and starts no work. Dependency-free: server and renderer share it. */
export const DESK_AREA_IDS = ['mail', 'bills', 'bank', 'shared-work'] as const;
export type DeskAreaId = typeof DESK_AREA_IDS[number];
export const isDeskAreaId = (value: unknown): value is DeskAreaId => typeof value === 'string' && (DESK_AREA_IDS as readonly string[]).includes(value);

/** The approved layouts (docs/DESK-WORK-AREAS-2026-10-10.md §3). A pack naming any other is refused. */
export const DESK_LAYOUTS = ['review-list', 'priority-list', 'calendar', 'table'] as const;
export type DeskLayoutName = typeof DESK_LAYOUTS[number];
/** Layouts each area can render, its default first. */
export const AREA_LAYOUTS: Record<DeskAreaId, readonly DeskLayoutName[]> = {
  mail: ['priority-list'],
  bills: ['calendar', 'review-list'],
  bank: ['review-list'],
  'shared-work': ['review-list'],
};
export const DESK_LAYOUT_LABELS: Record<DeskLayoutName, string> = {
  'review-list': 'List', 'priority-list': 'Priority list', calendar: 'Calendar', table: 'Table',
};

/** Desktop notice level for an area's new findings. Problems (a check that didn't
 * run, expired access, a held run) notify at every level and cannot be turned off. */
export const NOTICE_LEVELS = ['each', 'summary', 'off'] as const;
export type NoticeLevel = typeof NOTICE_LEVELS[number];
export const NOTICE_LEVEL_LABELS: Record<NoticeLevel, string> = {
  each: 'Each new item', summary: 'One summary per run', off: 'Problems only',
};

/** The pack workflow each area serves (AGENCY_WORKFLOWS ids). Shared work is core and belongs to no pack. */
export const AREA_WORKFLOW: Partial<Record<DeskAreaId, string>> = {
  mail: 'morning-priorities', bills: 'bills-calendar', bank: 'bank-references',
};
/** Scheduled jobs whose runs report into an area (status line, notices). Other jobs keep their catalog `notify` flag. */
export const AREA_LOOPS: Partial<Record<DeskAreaId, readonly string[]>> = {
  mail: ['inbound-triage'],
  bills: ['weekly-bills', 'maintenance-review', 'inspection-draft'],
  bank: ['bank-references'],
};
export const areaForLoop = (loopId: string): DeskAreaId | null =>
  DESK_AREA_IDS.find(area => AREA_LOOPS[area]?.includes(loopId)) ?? null;

/** One area as this office presets it. `notify` is null for an area that sends no notices. */
export type OfficeDeskArea = { id: DeskAreaId; title: string; layout: DeskLayoutName; notify: NoticeLevel | null; available: boolean };
/** The office's Desk preset: from the active workflow pack's `desk.areas`, else the core default. */
export type OfficeDesk = { source: { kind: 'core' } | { kind: 'pack'; packId: string; revision: number }; areas: OfficeDeskArea[] };

/** Today's Desk before any pack or person changes it. Bank references shows only for an office that runs that workflow. */
export function coreOfficeDesk(selectedWorkflows: readonly string[] = []): OfficeDesk {
  return { source: { kind: 'core' }, areas: [
    { id: 'mail', title: 'Mail priorities', layout: 'priority-list', notify: 'summary', available: true },
    { id: 'bills', title: 'Bills and calendar', layout: 'calendar', notify: 'summary', available: true },
    { id: 'bank', title: 'Bank references', layout: 'review-list', notify: 'off', available: selectedWorkflows.includes('bank-references') },
    { id: 'shared-work', title: 'Shared work', layout: 'review-list', notify: null, available: true },
  ] };
}
