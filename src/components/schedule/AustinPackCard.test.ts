import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AustinPackView } from '@shared/austin-pack';
import type { Loop } from '@/lib/routines';

vi.mock('@/state/store', () => ({ api: vi.fn(), useStore: () => ({ state: {}, dispatch: vi.fn() }) }));

import { AustinPackCard, AustinPlanDetail, checklistLink, parseAustinPackView } from './AustinPackCard';
import { scheduleRowGuidance } from '@/lib/schedule-presentation';
import { scheduleSummary } from '@/lib/schedule-week';

const plan = { reads: 'Fictional reads.', waitsFor: 'Fictional wait.', notifies: 'Fictional notice.', approval: 'Fictional approval.' };
const view = (installed: boolean, done: Partial<Record<string, boolean>> = {}): AustinPackView => ({
  pack: { id: 'austin-office-schedule', revision: 1, title: 'Austin office workflows' },
  timeZone: 'Australia/Brisbane', timeZoneFromOffice: false, installed: installed ? { revision: 1, at: 1 } : null,
  loops: [{ loopId: 'bank-references', owner: 'Accounts', plan, needs: ['redbark', 'tenants'] }, { loopId: 'inbound-triage', owner: 'Accounts', note: 'Starts at 7:30 so the list is ready by about 8:00.', plan, needs: [] }],
  rules: [{ id: 'maintenance-month', text: 'Calendar month by received date.', matches: true }],
  checklist: (['gmail', 'redbark', 'rei', 'tenants', 'suppliers', 'workflows'] as const).map(id => ({ id, label: `Label ${id}`, done: Boolean(done[id]), detail: `Detail ${id}`, ...(id === 'workflows' ? { next: 'maintenance-review' } : {}) })),
});
const loops = [{ id: 'maintenance-review', name: 'Maintenance checks' }] as Loop[];

describe('Austin pack card', () => {
  it('offers the install with plain words and no checklist before install', () => {
    const html = renderToStaticMarkup(createElement(AustinPackCard, { view: view(false), loops, onChanged: () => {} }));
    expect(html).toContain('Install the Austin pack');
    expect(html).toContain('Brisbane times');
    expect(html).toContain('stays off until you review it');
    expect(html).not.toContain('Austin setup checklist');
  });

  it('lists every checklist item with its state and a link to where it is done', () => {
    const html = renderToStaticMarkup(createElement(AustinPackCard, { view: view(true, { gmail: true }), loops, onChanged: () => {} }));
    expect(html).toContain('1 of 6 done');
    expect(html).toContain('Label gmail<span class="sr-only"> (done)</span>');
    expect(html).toContain('Label redbark<span class="sr-only"> (not done)</span>');
    for (const label of ['Open Connected apps: Label gmail', 'Open Bank reference review: Label tenants', 'Open Maintenance checks: Label suppliers', 'Review Maintenance checks: Label workflows']) expect(html).toContain(`aria-label="${label}"`);
  });

  it('maps each item to a working destination', () => {
    const items = view(true).checklist;
    expect(items.map(item => checklistLink(item, loops))).toEqual([
      { label: 'Open Connected apps', hash: 'you-connected-apps' }, { label: 'Open Connected apps', hash: 'you-connected-apps' },
      { label: 'Open Bank reference review', hash: 'job-bank-references' }, { label: 'Open Bank reference review', hash: 'job-bank-references' },
      { label: 'Open Maintenance checks', bills: true }, { label: 'Review Maintenance checks', hash: 'job-maintenance-review' },
    ]);
  });

  it('refuses a malformed answer instead of showing a partial checklist', () => {
    expect(parseAustinPackView(view(true))).toBeTruthy();
    expect(() => parseAustinPackView({ ...view(true), checklist: [{ id: 'unknown', label: 'x', detail: 'y', done: true }] })).toThrow(/could not be read/);
    expect(() => parseAustinPackView({ ...view(true), loops: [{ loopId: 'x' }] })).toThrow();
  });

  it('shows what a job reads, waits for, tells and needs, only once installed', () => {
    const html = renderToStaticMarkup(createElement(AustinPlanDetail, { view: view(true, { tenants: true }), loopId: 'bank-references' }));
    expect(html).toContain('What this job does · Accounts');
    expect(html).toContain('Fictional wait.');
    expect(html).toContain('Not yet: Label redbark. Detail redbark');
    expect(html).toContain('Done: Label tenants');
    expect(renderToStaticMarkup(createElement(AustinPlanDetail, { view: view(false), loopId: 'bank-references' }))).toBe('');
    expect(renderToStaticMarkup(createElement(AustinPlanDetail, { view: view(true), loopId: 'inbound-triage' }))).toContain('ready by about 8:00');
  });
});

describe('Schedule rows for pack jobs', () => {
  it('shows an off pack job with its office time, and the monthly cadence in words', () => {
    const loop = { id: 'maintenance-review', name: 'Maintenance checks', enabled: false, schedule: { type: 'daily', time: '08:30', weekdays: [1, 2, 3, 4, 5], timezone: 'Australia/Brisbane' } } as Loop;
    expect(scheduleRowGuidance({ key: 'loop:maintenance-review', name: loop.name, loop, next: 'Paused', attention: null, action: 'resume', actionLabel: 'Resume', actionDisabled: false, group: 2, sortAt: 0 })).toBe('Off · Weekdays 8:30 am, Brisbane time. Review it, then switch it on.');
    expect(scheduleSummary({ time: '09:00', weekdays: [1, 2, 3, 4, 5], monthly: 'first-weekday' })).toBe('First weekday of each month 9:00 am');
  });
});
