import type { LoopRun } from '@shared/contracts';
import { areaForLoop, coreOfficeDesk, type NoticeLevel } from '@shared/desk-areas';
import type { NeedsYouArea, NeedsYouSnapshot } from '@shared/needs-you';
import { reiWaitNotice } from '@shared/rei-sign-in-wait';
import { NOTICE_AREA_IDS, effectiveDeskAreas, officeDefaultSections } from '@shared/workspace-tabs';
import { evaluatorForLoop } from '@shared/workflow-catalog';
import { getNeedsYou, refreshNeedsYou, subscribeNeedsYou } from './needs-you';
import { showDesk } from './notify-desktop';
import { lastWorkspaceTabs } from './workspace-tabs';

const SETTLED = ['completed', 'awaiting-approval', 'partial', 'failed', 'missed', 'interrupted'];
const HOLDS = ['failed', 'missed', 'interrupted'];
/** Each new item: at most this many item notices per run, then one "And N more". */
const ITEM_NOTICES = 3;
const delivered = new Set<string>();
const previousHold = new Map<string, string>();

type AreaNotice = { area: NeedsYouArea; title: string; level: NoticeLevel };
/** Where a job's runs report and how loudly: this computer's level for the work area, else the office
 * preset, else the core default before either is read. An area the office's Desk doesn't show sends its
 * notices to Schedule. Null for a job in no area: its catalog flag decides, as before. */
function areaNotice(loopId: string): AreaNotice | null {
  const id = areaForLoop(loopId);
  if (!id) return null;
  const read = lastWorkspaceTabs(), office = read?.office ?? coreOfficeDesk();
  const shown = effectiveDeskAreas(read?.state?.desk.sections ?? officeDefaultSections(office), office).find(area => area.id === id);
  const preset = shown ?? office.areas.find(area => area.id === id) ?? coreOfficeDesk().areas.find(area => area.id === id)!;
  return { area: shown ? id : 'schedule', title: preset.title, level: preset.notify ?? 'off' };
}

/** A notice names the item, never an amount or account number its title may carry (a mail subject can). */
const noticeTitle = (title: string) => title.replace(/[$€£]\s?\d[\d,]*(?:\.\d+)?|\d[\d ,.-]{4,}\d/g, '…');

/** Review keys per area from the first read after app start, plus every key told since, so a restart
 * never floods. An area joins once a read could check it. */
const known = new Map<NeedsYouArea, Set<string>>();
const reviews = (snapshot: NeedsYouSnapshot, area: NeedsYouArea) => snapshot.items.filter(item => item.area === area && item.level === 'review');
const readable = (snapshot: NeedsYouSnapshot, area: NeedsYouArea) => !snapshot.unavailable.some(row => row.area === area);
subscribeNeedsYou(() => {
  const { snapshot } = getNeedsYou();
  for (const area of NOTICE_AREA_IDS) if (snapshot && !known.has(area) && readable(snapshot, area)) known.set(area, new Set(reviews(snapshot, area).map(item => item.key)));
});

function tell(title: string, body: string, tag: string, area?: NeedsYouArea): boolean {
  try {
    const notification = new Notification(title, { body, tag });
    notification.onclick = () => { showDesk(area); notification.close(); };
    return true;
  } catch { return false; /* Saved result and attention state remain in the app. */ }
}
const remember = (id: string) => { delivered.add(id); if (delivered.size > 200) delivered.delete(delivered.values().next().value!); };
const runNotice = (run: LoopRun, area?: NeedsYouArea) => tell(run.loopName, run.detail || 'Open RealBud to review the saved result.', `realbud-${run.loopId}`, area);

/** Only new, settled app results; reconnect snapshots and unchanged runs stay quiet. Problems (a held or
 * partial run) notify at every level; findings follow the work area's level. */
export function notifyRoutineRun(run: LoopRun): void {
  const rei = reiWaitNotice(run);
  if (rei) { notifyReiWait(run, rei === 'waiting'); return; }
  const notice = areaNotice(run.loopId);
  if (!(notice || evaluatorForLoop(run.loopId)?.notify) || run.seenAt || !SETTLED.includes(run.status) ||
      typeof Notification === 'undefined' || Notification.permission !== 'granted' || delivered.has(run.id)) return;
  const hold = HOLDS.includes(run.status), signature = `${run.status}:${run.detail}`;
  if (hold && previousHold.get(run.loopId) === signature) return;
  if (hold) previousHold.set(run.loopId, signature); else previousHold.delete(run.loopId);
  const level = !notice || hold || run.status === 'partial' ? 'summary' : notice.level;
  if (level === 'off') return;
  if (notice && level === 'each') { remember(run.id); void noticeNewItems(run, notice); return; }
  if (runNotice(run, notice?.area)) remember(run.id);
}

/** Needs you after this run: a read already in flight may predate it, so wait for the one queued behind it too. */
async function readAfterRun() {
  await refreshNeedsYou();
  if (getNeedsYou().checking) await new Promise<void>(done => { const stop = subscribeNeedsYou(() => { if (!getNeedsYou().checking) { stop(); done(); } }); });
  return getNeedsYou();
}
/** Each new item: one notice per review item the area didn't have before, up to the cap, then one for the rest.
 * When Needs you can't say what is new, one notice for the run instead: unread is never "nothing new". */
async function noticeNewItems(run: LoopRun, notice: AreaNotice): Promise<void> {
  const { snapshot, error } = await readAfterRun();
  const seen = known.get(notice.area);
  if (error || !snapshot || !seen || !readable(snapshot, notice.area)) { runNotice(run, notice.area); return; }
  const fresh = reviews(snapshot, notice.area).filter(item => !seen.has(item.key));
  for (const item of fresh) seen.add(item.key);
  for (const item of fresh.slice(0, ITEM_NOTICES)) tell(notice.title, noticeTitle(item.title), `realbud-${item.key}`, notice.area);
  if (fresh.length > ITEM_NOTICES) tell(notice.title, `And ${fresh.length - ITEM_NOTICES} more`, `realbud-${notice.area}-more`, notice.area);
}

/** A run waiting at REI sign-in notifies while it runs (once, plus at most one midday reminder) and the bank import's
 * miss notifies too. Both are holds: the same line again, as after a restart, stays quiet (shared/rei-sign-in-wait.ts). */
function notifyReiWait(run: LoopRun, waiting: boolean): void {
  if (run.seenAt || typeof Notification === 'undefined' || Notification.permission !== 'granted' || delivered.has(run.id)) return;
  const signature = `${run.status}:${run.detail}`;
  if (previousHold.get(run.loopId) === signature) return;
  previousHold.set(run.loopId, signature);
  // A waiting run is not delivered yet: its reminder and its result still notify.
  if (tell(run.loopName, run.detail || 'Open RealBud to see what is waiting.', `realbud-${run.loopId}`, areaNotice(run.loopId)?.area) && !waiting) delivered.add(run.id);
}
