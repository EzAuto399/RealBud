/** The Austin pack's schedule view (GET /api/austin-pack). Server builds it in
 * server/austin-pack.ts; the Schedule checklist and job details read it. */
export const AUSTIN_CHECKLIST_IDS = ['gmail', 'redbark', 'rei', 'tenants', 'suppliers', 'workflows'] as const;
export type AustinChecklistId = typeof AUSTIN_CHECKLIST_IDS[number];
export interface AustinPlan { reads: string; waitsFor: string; notifies: string; approval: string }
export interface AustinPackLoop { loopId: string; owner: string; note?: string; plan: AustinPlan; needs: AustinChecklistId[] }
export interface AustinChecklistItem { id: AustinChecklistId; label: string; done: boolean; detail: string; /** workflows: the first loop still off. */ next?: string }
export interface AustinPackView {
  pack: { id: string; revision: number; title: string };
  /** Office timezone from agency setup, else the pack's default. */
  timeZone: string;
  timeZoneFromOffice: boolean;
  installed: { revision: number; at: number } | null;
  loops: AustinPackLoop[];
  rules: Array<{ id: string; text: string; matches: boolean }>;
  checklist: AustinChecklistItem[];
}
