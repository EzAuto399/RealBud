import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Loop, LoopRun } from '@shared/contracts';

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock('@/state/store', () => ({ api: vi.fn(), useStore: () => ({ state: store.state, dispatch: vi.fn(), refreshActivity: vi.fn() }) }));
import { AreaStatusLine, areaStatus, cadenceMs } from './AreaStatusLine';

// Fictional clock: Brisbane is UTC+10 with no daylight saving.
const tz = 'Australia/Brisbane', HOUR = 3_600_000, DAY = 24 * HOUR;
const now = Date.parse('2026-10-06T02:00:00Z'); // Tue 6 Oct, 12:00 pm
const loop = (patch: Partial<Loop> = {}): Loop => ({ id: 'weekly-bills', name: 'Weekly bills review', description: '', available: true, enabled: true,
  schedule: { type: 'daily', time: '08:00', weekdays: [2] }, revision: 3, nextRunAt: Date.parse('2026-10-12T22:00:00Z'), evaluatorId: 'weekly-bills', evaluatorVersion: 1, ...patch });
const run = (patch: Partial<LoopRun> = {}): LoopRun => ({ id: 'run-1', loopId: 'weekly-bills', loopName: 'Weekly bills review', scheduledFor: Date.parse('2026-10-05T22:00:00Z'),
  status: 'completed', manual: false, startedAt: Date.parse('2026-10-05T22:00:00Z'), finishedAt: Date.parse('2026-10-05T22:03:00Z'), createdAt: Date.parse('2026-10-05T22:00:00Z'), ...patch });
const status = (patch: Partial<Parameters<typeof areaStatus>[0]> = {}) =>
  areaStatus({ area: 'bills', title: 'Bills and calendar', loop: loop(), runs: [run()], read: 'ready', timeZone: tz, now, ...patch });

describe('area status line states', () => {
  it('says when the last completed check ran and when the next one starts, in the office timezone', () => {
    expect(status()).toEqual({ kind: 'checked', text: 'Checked Tue 6 Oct, 8:03 am · next Tue 13 Oct, 8:00 am' });
  });

  it('shows Checking with its start time while a run is going', () => {
    expect(status({ runs: [run({ id: 'run-2', status: 'running', finishedAt: undefined, createdAt: now - HOUR }), run()] }))
      .toEqual({ kind: 'checking', text: 'Checking… started 8:00 am' });
  });

  it.each(['failed', 'missed', 'interrupted'] as const)('labels a %s run "Didn\'t run" in text, with its reason', state => {
    const result = status({ runs: [run({ id: 'run-2', status: state, detail: 'This computer was off.', createdAt: now - HOUR }), run({ createdAt: now - 8 * DAY })] });
    expect(result).toMatchObject({ kind: 'didnt-run', label: "Didn't run", text: 'Tue 6 Oct, 8:00 am', detail: 'This computer was off.' });
  });

  it('marks a check older than its cadence plus 12 hours as stale', () => {
    const at = now - 13 * DAY;
    expect(status({ runs: [run({ finishedAt: at, createdAt: at })] })).toMatchObject({ kind: 'stale', label: 'Out of date', text: 'Last checked 13 days ago · next Tue 13 Oct, 8:00 am' });
    const fresh = now - 7 * DAY - 11 * HOUR;
    expect(status({ runs: [run({ finishedAt: fresh, createdAt: fresh })] }).kind).toBe('checked');
  });

  it('says not set up, and what is needed, for an off job that never ran or an unavailable one', () => {
    const off = status({ loop: loop({ enabled: false }), runs: [] });
    expect(off.kind).toBe('not-set-up');
    expect(off.text).toBe("Bills and calendar isn't set up yet");
    expect(off.detail).toContain('Agency workflow setup');
    expect(status({ loop: loop({ available: false }) })).toMatchObject({ kind: 'not-set-up', detail: "Automatic checks aren't available on this computer yet." });
    expect(status({ loop: undefined, runs: [] }).kind).toBe('not-set-up');
  });

  it('never presents this computer’s zone as the office’s, and never claims a check it has not read', () => {
    expect(status({ timeZone: undefined })).toEqual({ kind: 'checked', text: 'Checked 3 hours ago · next check time not confirmed' });
    expect(status({ read: 'loading' }).kind).toBe('loading');
    expect(status({ read: 'error' }).text).toContain('could not be read');
    expect(status({ runs: [] })).toEqual({ kind: 'never', text: 'Not checked yet · next Tue 13 Oct, 8:00 am' });
    for (const result of [status(), status({ runs: [] }), status({ read: 'error' })]) expect(result.text).not.toMatch(/nothing new/i);
  });

  it('reads cadence from the schedule', () => {
    expect(cadenceMs({ type: 'daily', time: '08:00', weekdays: [1] })).toBe(7 * DAY);
    expect(cadenceMs({ type: 'daily', time: '08:00', weekdays: [1, 2, 3, 4, 5] })).toBe(3 * DAY);
    expect(cadenceMs({ type: 'daily', time: '08:00', weekdays: [0, 1, 2, 3, 4, 5, 6], intervalDays: 2 })).toBe(2 * DAY);
    expect(cadenceMs({ type: 'daily', time: '08:00', weekdays: [] })).toBeNull();
  });
});

describe('AreaStatusLine', () => {
  const render = (state: Record<string, unknown>, area: 'mail' | 'bills' | 'bank' | 'shared-work' = 'bills', checkNow?: boolean) => {
    store.state = { connected: true, loops: [loop()], loopRuns: [run()], activityLoad: { routines: 'ready' }, scheduleRecovery: { active: false, detail: '' }, desk: { book: { agency: { timezone: tz } } }, ...state };
    return renderToStaticMarkup(createElement(AreaStatusLine, { area, checkNow }));
  };

  it('offers Check now as the area’s one filled button', () => {
    const html = render({});
    expect(html).toContain('aria-label="Bills and calendar status"');
    expect(html).toMatch(/<button type="button" class="[^"]* bg-agency [^"]*">Check now<\/button>/);
    expect(html.match(/ bg-agency /g)).toHaveLength(1);
  });

  it('disables Check now with its reason while a check runs', () => {
    const html = render({ loopRuns: [run({ status: 'running', finishedAt: undefined })] });
    expect(html).toMatch(/<button type="button" class="[^"]*" disabled="" aria-describedby="([^"]+)">Check now<\/button>/);
    const id = html.match(/aria-describedby="([^"]+)"/)![1];
    expect(html).toContain(`<p id="${id}" class="area-status-reason">Already checking. Wait for this check to finish.</p>`);
  });

  it('holds Check now for an unavailable job and offers Finish setup in place', () => {
    const html = render({ loops: [loop({ available: false })] });
    expect(html).toContain("Bills and calendar isn&#x27;t set up yet");
    expect(html).toContain('>Finish setup</button>');
    expect(html).toContain('Finish setup first.');
    expect(html).toMatch(/disabled=""[^>]*>Check now/);
  });

  it('holds Check now while disconnected and when an off job cannot run until switched on', () => {
    expect(render({ connected: false })).toContain('Not connected. Check now works again once RealBud reconnects.');
    const bank = render({ loops: [loop({ id: 'bank-references', name: 'Bank reference review', enabled: false })], loopRuns: [run({ loopId: 'bank-references' })] }, 'bank');
    expect(bank).toContain('Switch it on in Schedule first.');
  });

  it('shows a text label for a run that did not happen', () => {
    expect(render({ loopRuns: [run({ status: 'missed' })] })).toContain('<span class="area-status-label">Didn&#x27;t run</span>');
  });

  it('keeps the status but offers no Check now when the area starts its own work', () => {
    const html = render({ loops: [loop({ id: 'bank-references', name: 'Bank reference review' })], loopRuns: [run({ loopId: 'bank-references' })] }, 'bank', false);
    expect(html).toContain('Bank reference review · </span><span>Checked Tue 6 Oct, 8:03 am');
    expect(html).not.toContain('<button');
  });

  it('renders nothing for an area without a scheduled job', () => {
    expect(render({}, 'shared-work')).toBe('');
  });
});
