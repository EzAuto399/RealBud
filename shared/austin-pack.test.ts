import { describe, expect, it } from 'vitest';
import { AUSTIN_LOOP_IDS, hiddenAustinLoopIds, type AustinPackView } from './austin-pack.ts';

const loops = ['morning-arrears', 'owner-letter', ...AUSTIN_LOOP_IDS, 'rei-morning-refresh'].map(id => ({ id, enabled: id === 'maintenance-review' }));
const view = (installed: AustinPackView['installed']) => ({ installed }) as AustinPackView;
const hidden = (v: AustinPackView | null | 'unread', ran: string[] = []) => [...hiddenAustinLoopIds(v, loops, new Set(ran))];

describe('hiddenAustinLoopIds (Schedule without job flicker)', () => {
  it('hides the off, never-run Auston jobs while the pack view is unread, as if none were set', () => {
    expect(hidden('unread')).toEqual(['bank-references', 'weekly-bills', 'rei-supplier-check', 'inspection-draft']);
    expect(hidden('unread')).toEqual(hidden(view(null)));
  });

  it('never hides a job that is on or has run, even before the read', () => {
    expect(hidden('unread', ['inspection-draft'])).toEqual(['bank-references', 'weekly-bills', 'rei-supplier-check']);
    expect(hidden('unread')).not.toContain('maintenance-review');
    expect(hidden('unread')).not.toContain('inbound-triage');
  });

  it('only adds rows once read: a role pack shows its jobs, a failed read shows them all', () => {
    const kevin = hidden(view({ revision: 1, at: 1, loopIds: ['bank-references', 'weekly-bills'] }));
    expect(kevin).toEqual(['rei-supplier-check', 'inspection-draft']);
    expect(kevin.every(id => hidden('unread').includes(id))).toBe(true);
    expect(hidden(view({ revision: 1, at: 1 }))).toEqual([]);
    expect(hidden(null)).toEqual([]);
  });
});
