import type { LoopRun } from '@shared/contracts';
import { SHOW_DESK_EVENT } from './notify-desktop';

const delivered = new Set<string>();
const previousHold = new Map<string, string>();
/** Only new, settled app results; reconnect snapshots and unchanged runs stay quiet. */
export function notifyRoutineRun(run: LoopRun): void {
  if (!['weekly-bills', 'inbound-triage', 'maintenance-review'].includes(run.loopId) || run.seenAt ||
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
