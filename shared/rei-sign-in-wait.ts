// A loop run waiting at REI sign-in (server/w1-sign-in-wait.ts) tells the person
// while it still runs: once, plus at most one midday reminder; the bank import's
// miss tells them too. Shared by the chat card (server/loop-chat-cards.ts) and the
// desktop notification (src/lib/notify-routine.ts); both treat it as a hold, so a
// restart's resumed wait with the same line stays quiet.
const LOOPS = ['bank-references', 'rei-supplier-check'];
const WAITING = /^(?:Reminder: s|S)ign in to REI Cloud\b/;

export function reiWaitNotice(run: { loopId: string; status: string; detail?: string | null }): 'waiting' | 'missed' | null {
  if (!LOOPS.includes(run.loopId)) return null;
  if (run.status === 'running' && WAITING.test(run.detail ?? '')) return 'waiting';
  return run.status === 'missed' ? 'missed' : null;
}
