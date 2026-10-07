/** The Austin pack's schedule view (GET /api/austin-pack). Server builds it in
 * server/austin-pack.ts; Desk's Get started card and Schedule's job details read it. */
export const AUSTIN_CHECKLIST_IDS = ['gmail', 'redbark', 'rei', 'tenants', 'suppliers', 'workflows'] as const;
/** The Auston schedule file's six catalogue loops, in file order. */
export const AUSTIN_LOOP_IDS = ['bank-references', 'weekly-bills', 'inbound-triage', 'maintenance-review', 'rei-supplier-check', 'inspection-draft'] as const;
export type AustinChecklistId = typeof AUSTIN_CHECKLIST_IDS[number];
export interface AustinPlan { reads: string; waitsFor: string; notifies: string; approval: string }
export interface AustinPackLoop { loopId: string; owner: string; note?: string; plan: AustinPlan; needs: AustinChecklistId[] }
export interface AustinChecklistItem { id: AustinChecklistId; label: string; done: boolean; detail: string; /** workflows: the first loop still off. */ next?: string }
export interface AustinPackView {
  pack: { id: string; revision: number; title: string };
  /** Office timezone from agency setup, else the pack's default. */
  timeZone: string;
  timeZoneFromOffice: boolean;
  /** loopIds: the workflows role packs set on this PC; absent means all of them. */
  installed: { revision: number; at: number; loopIds?: string[] } | null;
  loops: AustinPackLoop[];
  rules: Array<{ id: string; text: string; matches: boolean }>;
  checklist: AustinChecklistItem[];
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => typeof v === 'string';
/** A malformed answer is an error, never a half-filled checklist. */
export function parseAustinPackView(body: unknown): AustinPackView {
  const ok = object(body) && object(body.pack) && str(body.pack.title) && str(body.timeZone) && typeof body.timeZoneFromOffice === 'boolean' &&
    (body.installed === null || (object(body.installed) && Number.isFinite(body.installed.revision) &&
      (body.installed.loopIds === undefined || (Array.isArray(body.installed.loopIds) && body.installed.loopIds.every(str))))) &&
    Array.isArray(body.loops) && body.loops.every(l => object(l) && str(l.loopId) && str(l.owner) && object(l.plan) && ['reads', 'waitsFor', 'notifies', 'approval'].every(k => str((l.plan as Record<string, unknown>)[k]))) &&
    Array.isArray(body.rules) && body.rules.every(r => object(r) && str(r.text) && typeof r.matches === 'boolean') &&
    Array.isArray(body.checklist) && body.checklist.every(i => object(i) && (AUSTIN_CHECKLIST_IDS as readonly unknown[]).includes(i.id) && str(i.label) && str(i.detail) && typeof i.done === 'boolean');
  if (!ok) throw new Error('The Auston setup could not be read. Reload Schedule.');
  return body as unknown as AustinPackView;
}

/**
 * Auston-only loops Schedule leaves out on this PC: off, never run, and not set
 * by a role pack here (no install yet means none; a whole-office install without
 * `loopIds` means all). Morning priorities (`inbound-triage`) is a core loop and
 * always shows. An unread pack view hides nothing: unknown is not "not installed".
 */
export function hiddenAustinLoopIds(view: AustinPackView | null, loops: ReadonlyArray<{ id: string; enabled: boolean }>, ran: ReadonlySet<string>): Set<string> {
  if (!view) return new Set();
  const installed: readonly string[] = view.installed ? view.installed.loopIds ?? AUSTIN_LOOP_IDS : [];
  return new Set(loops.filter(loop => loop.id !== 'inbound-triage' && (AUSTIN_LOOP_IDS as readonly string[]).includes(loop.id) &&
    !loop.enabled && !installed.includes(loop.id) && !ran.has(loop.id)).map(loop => loop.id));
}
