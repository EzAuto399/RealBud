import type { CustomerPack } from '../shared/customer-packs.ts';
import { AREA_LAYOUTS, AREA_WORKFLOW, DESK_AREA_IDS, coreOfficeDesk, type DeskAreaId, type OfficeDesk, type OfficeDeskArea } from '../shared/desk-areas.ts';

/** The core area that shows a pack workflow, or null when this core can't show it on Desk. */
export const areaForWorkflow = (workflow: string): DeskAreaId | null => DESK_AREA_IDS.find(area => AREA_WORKFLOW[area] === workflow) ?? null;

type Maybe<T> = T | Promise<T>;
export interface OfficeDeskDeps {
  /** The office's saved agency setup (`agencySetup.getConfiguration()`'s settings). */
  agency: () => Maybe<{ workflowPackId: string | null; selectedWorkflows: readonly string[] }>;
  /** The installed, validated manifest of a pack, or null (`customerPacks.installedPack`). */
  installedPack: (packId: string) => Maybe<CustomerPack | null>;
}

/** The office's Desk preset: the chosen pack's `desk.areas` in pack order, then the
 * core areas it doesn't list (only Shared work stays available). Without a chosen pack
 * or a pack preset, the core default. An area this core can't show is left out, and a
 * layout its area can't render falls back to the area's default (the installed pack is
 * read by shape only). Display only: it grants no access and starts no work. */
export async function officeDesk(deps: OfficeDeskDeps): Promise<OfficeDesk> {
  const { workflowPackId, selectedWorkflows } = await deps.agency();
  const pack = workflowPackId ? await deps.installedPack(workflowPackId) : null;
  if (!pack?.desk) return coreOfficeDesk(selectedWorkflows);
  const listed = pack.desk.areas.flatMap((area): OfficeDeskArea[] => {
    const id = areaForWorkflow(area.workflow);
    return id ? [{ id, title: area.title, layout: AREA_LAYOUTS[id].includes(area.layout) ? area.layout : AREA_LAYOUTS[id][0]!, notify: area.notify, available: selectedWorkflows.includes(area.workflow) }] : [];
  });
  const rest = coreOfficeDesk().areas.filter(area => !listed.some(item => item.id === area.id)).map(area => ({ ...area, available: area.id === 'shared-work' }));
  return { source: { kind: 'pack', packId: pack.id, revision: pack.revision }, areas: [...listed, ...rest] };
}
