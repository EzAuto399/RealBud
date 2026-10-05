import type { LoopRun } from '@shared/contracts';
import { reiWaitNotice } from '@shared/rei-sign-in-wait';
import { SHOW_DESK_EVENT } from './notify-desktop';

const delivered = new Set<string>();
const previousHold = new Map<string, string>();
/** Only new, settled app results; reconnect snapshots and unchanged runs stay quiet. */
export function notifyRoutineRun(run: LoopRun): void {
  const rei = reiWaitNotice(run);
  if (rei) { notifyReiWait(run, rei === 'waiting'); return; }
  if (!['weekly-bills', 'inbound-triage', 'maintenance-review', 'rei-supplier-check', 'inspection-draft'].includes(run.loopId) || run.seenAt ||
      !['completed', 'awaiting-approval', 'partial', 'failed', 'missed', 'interrupted'].includes(run.status) ||
      typeof Notification === 'undefined' || Notification.permission !== 'granted' || delivered.has(run.id)) return;
  const hold = ['failed', 'missed', 'interrupted'].includes(run.status), signature = `${run.status}:${run.detail}`;
  if (hold && previousHold.get(run.loopId) === signature) return;
  if (hold) previousHold.set(run.loopId, signature); else previousHold.delete(run.loopId);
  try {
    const notification = new Notification(run.loopName, { body: run.detail || 'Open RealBud to review the saved result.', tag: `realbud-${run.loopId}` });
    delivered.add(run.id);
    if (delivered.size > 200) delivered.delete(delivered.values().next().value!);
    notification.onclick = () => { window.focus(); window.dispatchEvent(new Event(SHOW_DESK_EVENT)); notification.close(); };
  } catch { /* Saved result and attention state remain in the app. */ }
}
/** A run waiting at REI sign-in notifies while it runs (once, plus at most one midday reminder) and the bank import's
 * miss notifies too. Both are holds: the same line again, as after a restart, stays quiet (shared/rei-sign-in-wait.ts). */
function notifyReiWait(run: LoopRun, waiting: boolean): void {
  if (run.seenAt || typeof Notification === 'undefined' || Notification.permission !== 'granted' || delivered.has(run.id)) return;
  const signature = `${run.status}:${run.detail}`;
  if (previousHold.get(run.loopId) === signature) return;
  previousHold.set(run.loopId, signature);
  try {
    const notification = new Notification(run.loopName, { body: run.detail || 'Open RealBud to see what is waiting.', tag: `realbud-${run.loopId}` });
    // A waiting run is not delivered yet: its reminder and its result still notify.
    if (!waiting) delivered.add(run.id);
    notification.onclick = () => { window.focus(); window.dispatchEvent(new Event(SHOW_DESK_EVENT)); notification.close(); };
  } catch { /* The wait still shows in Schedule. */ }
}
