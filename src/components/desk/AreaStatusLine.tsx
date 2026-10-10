import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { Loop, LoopRun, LoopSchedule } from '@shared/contracts';
import { AREA_LOOPS, coreOfficeDesk, type DeskAreaId } from '@shared/desk-areas';
import { evaluatorForLoop } from '@shared/workflow-catalog';
import { api, useStore } from '@/state/store';
import { beginLoopRequest, confirmLoopReceipt, pendingLoopRequest, rejectLoopRequest, type PendingLoopRequest } from '@/lib/manual-loop-request';
import { nextRunText } from '@/lib/schedule-rows';

const HOUR = 3_600_000, DAY = 24 * HOUR;
const SECONDARY = 'pm-control min-h-11 rounded-lg border border-line bg-sheet px-3 text-sm text-ink hover:bg-raised disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';
const PRIMARY = 'pm-control min-h-11 rounded-lg border border-agency bg-agency px-4 text-sm font-medium text-sheet hover:bg-agency-hover disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-agency';
/** What an area needs before its first check, in plain words. */
const NEEDS: Record<DeskAreaId, string> = {
  mail: 'Choose its Gmail account and review time in Agency workflow setup, then switch it on in Schedule.',
  bills: 'Choose its Gmail account and bills plan in Agency workflow setup, then switch it on in Schedule.',
  bank: 'Review Bank references in Agency workflow setup, then switch it on in Schedule. You can still review a bank file here.',
  'shared-work': '',
};

export type AreaStatusKind = 'loading' | 'unreadable' | 'not-set-up' | 'checking' | 'checked' | 'didnt-run' | 'stale' | 'never';
export type AreaStatus = { kind: AreaStatusKind; text: string; label?: string; detail?: string };
type StatusInput = { area: DeskAreaId; title: string; loop: Loop | undefined; runs: readonly LoopRun[]; read: 'loading' | 'ready' | 'error'; timeZone: string | undefined; now: number };

/** The longest wait between two scheduled checks, or null when the schedule never fires. */
export function cadenceMs(schedule: LoopSchedule): number | null {
  if (schedule.intervalDays) return schedule.intervalDays * DAY;
  if (schedule.monthly) return 34 * DAY; // the first weekday can slip past a weekend
  const days = [...new Set(schedule.weekdays)].sort((a, b) => a - b);
  if (!days.length) return null;
  return Math.max(...days.map((day, index) => (days[(index + 1) % days.length] - day + 7) % 7 || 7)) * DAY;
}

/** Durations need no timezone, so they stand in when the office's zone is unknown. */
function ago(delta: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'} ago`;
  if (delta < 60_000) return 'just now';
  if (delta < HOUR) return unit(Math.floor(delta / 60_000), 'minute');
  if (delta < DAY) return unit(Math.floor(delta / HOUR), 'hour');
  return unit(Math.floor(delta / DAY), 'day');
}
const format = (ms: number, timeZone: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-AU', { timeZone, ...options }).format(ms).replace(/\s/g, ' ');
/** "Mon 6 Oct, 8:03 am" in the office's zone; never this computer's zone presented as the office's. */
function when(ms: number, timeZone: string | undefined, now: number): string {
  if (!timeZone) return ago(now - ms);
  try { return `${format(ms, timeZone, { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '')}, ${format(ms, timeZone, { hour: 'numeric', minute: '2-digit', hour12: true })}`; }
  catch { return ago(now - ms); }
}
function startedAt(ms: number, timeZone: string | undefined, now: number): string {
  if (!timeZone) return ago(now - ms);
  try { return format(ms, timeZone, { hour: 'numeric', minute: '2-digit', hour12: true }); } catch { return ago(now - ms); }
}
function next(loop: Loop, now: number, timeZone: string | undefined): string {
  if (!loop.enabled) return ' · automatic checks are off';
  if (loop.nextRunAt == null) return '';
  return timeZone ? ` · next ${nextRunText(loop.nextRunAt, now, timeZone).replace(/^(Today|Tomorrow)/, word => word.toLowerCase())}` : ' · next check time not confirmed';
}

/** One area's status line (docs/DESK-WORK-AREAS-2026-10-10.md §5). It never says "nothing new":
 * the area's own list says what a completed check found. */
export function areaStatus({ area, title, loop, runs, read, timeZone, now }: StatusInput): AreaStatus {
  if (read === 'loading') return { kind: 'loading', text: 'Reading when this was last checked…' };
  if (read === 'error') return { kind: 'unreadable', text: 'When this was last checked could not be read. Saved work below is unchanged.' };
  const own = runs.filter(run => run.loopId === loop?.id).sort((a, b) => b.createdAt - a.createdAt);
  if (!loop || !loop.available) return { kind: 'not-set-up', text: `${title} isn't set up yet`, detail: "Automatic checks aren't available on this computer yet." };
  if (!loop.enabled && !own.length) return { kind: 'not-set-up', text: `${title} isn't set up yet`, detail: NEEDS[area] };
  const active = own.find(run => run.status === 'queued' || run.status === 'running');
  if (active) return { kind: 'checking', text: `Checking… started ${startedAt(active.startedAt ?? active.createdAt, timeZone, now)}` };
  // A run a restart interrupted and a newer run carried on is not the latest word.
  const latest = own.find(run => run.status !== 'resumed');
  if (latest && ['failed', 'missed', 'interrupted'].includes(latest.status)) {
    return { kind: 'didnt-run', label: "Didn't run", text: when(latest.manual ? latest.createdAt : latest.scheduledFor, timeZone, now), detail: latest.detail };
  }
  const checked = own.find(run => ['completed', 'partial', 'awaiting-approval'].includes(run.status));
  if (!checked) return { kind: 'never', text: `Not checked yet${next(loop, now, timeZone)}` };
  const at = checked.finishedAt ?? checked.startedAt ?? checked.createdAt, cadence = cadenceMs(loop.schedule);
  if (cadence !== null && now - at > cadence + 12 * HOUR) return { kind: 'stale', label: 'Out of date', text: `Last checked ${ago(now - at)}${next(loop, now, timeZone)}` };
  return { kind: 'checked', text: `${checked.status === 'partial' ? 'Partly checked' : 'Checked'} ${when(at, timeZone, now)}${next(loop, now, timeZone)}`,
    ...(checked.status === 'awaiting-approval' ? { detail: 'Something from this check is waiting for your approval.' } : {}) };
}

/** Status line for one Desk work area: what ran, when, what runs next, and Check now.
 * Check now starts the area's job exactly as Schedule's Run now does: a request id kept on
 * this device and the schedule revision on screen, so a lost reply is checked, never repeated.
 * `checkNow={false}`: the area's own panel starts this work for the person at the desk (Bank's
 * import strip), so only a lost Run now reply is offered here, as Check previous run. */
export function AreaStatusLine({ area, title, onStarted, checkNow = true }: { area: DeskAreaId; title?: string; onStarted?: () => void; checkNow?: boolean }) {
  const { state, dispatch, refreshActivity } = useStore();
  const loopId = AREA_LOOPS[area]?.[0];
  const loop = state.loops.find(candidate => candidate.id === loopId);
  const [pending, setPending] = useState<PendingLoopRequest | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const inFlight = useRef(false), reasonId = useId();
  const syncPending = useCallback(() => {
    if (!loopId) return;
    try { setPending(pendingLoopRequest(loopId)); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Run recovery is unavailable.'); }
  }, [loopId]);
  useEffect(() => {
    syncPending();
    window.addEventListener('storage', syncPending);
    return () => window.removeEventListener('storage', syncPending);
  }, [syncPending]);
  if (!loopId) return null;

  const name = title ?? coreOfficeDesk().areas.find(row => row.id === area)?.title ?? 'This area';
  const status = areaStatus({ area, title: name, loop, runs: state.loopRuns, read: state.activityLoad.routines, timeZone: state.desk?.book?.agency.timezone || undefined, now: Date.now() });
  const recovery = state.scheduleRecovery.active || Boolean(state.desk?.recovery?.active);
  const reason = busy ? 'Starting the check…'
    : !state.connected ? 'Not connected. Check now works again once RealBud reconnects.'
    : recovery ? 'Paused while the book is in recovery. Saved results are still shown.'
    : status.kind === 'loading' ? 'Reading the schedule…'
    : status.kind === 'unreadable' ? 'The schedule could not be read.'
    : pending ? null
    : !loop?.available ? 'Finish setup first.'
    : status.kind === 'checking' ? 'Already checking. Wait for this check to finish.'
    : !loop.enabled && !loop.waitingForPlan && !evaluatorForLoop(loop.id)?.runWhileOff ? 'Switch it on in Schedule first.'
    : null;
  const offer = checkNow || Boolean(pending);

  const check = async () => {
    if (inFlight.current || !loop) return;
    inFlight.current = true; setBusy(true); setError(''); setNotice('');
    let request: PendingLoopRequest | null = null, accepted = false;
    try {
      request = beginLoopRequest(loop.id, loop.revision);
      const { run } = await api(`/api/loops/${loop.id}/run`, { method: 'POST', body: JSON.stringify(request) }, { timeoutMs: 15_000 });
      if (!run?.id) throw new Error('This check could not be confirmed. Check previous run before starting more work.');
      accepted = true;
      const finished = confirmLoopReceipt(loop.id, request, run);
      dispatch({ type: 'loopRunPatched', run });
      setNotice(finished ? 'The previous check had already finished. Its result is shown here.' : 'Checking. You can keep working; results appear here.');
      onStarted?.();
    } catch (cause) {
      // Only an authoritative refusal drops the request; a lost reply keeps it for Check previous run.
      if (request && !accepted) { try { rejectLoopRequest(loop.id, request, (cause as { status?: number }).status); } catch { /* keep the saved identity */ } }
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false; setBusy(false); syncPending();
    }
  };
  const finishSetup = () => { location.hash = 'schedule-agency'; dispatch({ type: 'showRoutines' }); };

  return <div role="group" aria-label={`${name} status`} className="area-status">
    <p role="status" className="area-status-text">
      {status.label && <span className="area-status-label">{status.label}</span>}
      {status.label && ' · '}
      {loop && status.kind !== 'not-set-up' && <span className="text-ink-muted">{loop.name} · </span>}
      <span className={status.kind === 'not-set-up' ? 'font-medium text-ink' : undefined}>{status.text}</span>
      {status.detail && <span className="block break-words">{status.detail}</span>}
    </p>
    <div className="area-status-actions">
      {status.kind === 'not-set-up' && <button type="button" className={SECONDARY} onClick={finishSetup}>Finish setup</button>}
      {status.kind === 'unreadable' && <button type="button" className={SECONDARY} onClick={() => void refreshActivity()}>Try again</button>}
      {offer && <button type="button" className={PRIMARY} disabled={Boolean(reason)} aria-describedby={reason ? reasonId : undefined} onClick={() => void check()}>{pending ? 'Check previous run' : 'Check now'}</button>}
    </div>
    {offer && reason && <p id={reasonId} className="area-status-reason">{reason}</p>}
    {error && <p role="alert" className="area-status-reason text-hold">{error}</p>}
    {notice && <p role="status" className="area-status-reason">{notice}</p>}
  </div>;
}
