import { describe, expect, it } from 'vitest';
import { appendBillPage, billPageUrl, expectedBillsPage, mergeBillRows } from './source-bill-pages';

describe('bounded bill view pages', () => {
  const first = { items: [{ id: 'a', revision: 1 }], nextCursor: 'second', snapshotCursor: 'snapshot', revision: 10, total: 50 };
  it('preserves snapshot order and updates corrections without duplicating records', () => {
    const next = { ...first, items: [{ id: 'a', revision: 2 }, { id: 'b', revision: 1 }], nextCursor: 'third', revision: 12 };
    expect(appendBillPage(first, next, 'second')).toEqual({ ...next, items: [{ id: 'a', revision: 2 }, { id: 'b', revision: 1 }] });
  });
  it('refuses a stale response after refresh, foreign snapshot, or looping continuation', () => {
    expect(() => appendBillPage({ ...first, nextCursor: 'new-page' }, first, 'second')).toThrow('Refresh');
    expect(() => appendBillPage(first, { ...first, snapshotCursor: 'different', nextCursor: null }, 'second')).toThrow('Refresh');
    expect(() => appendBillPage(first, first, 'second')).toThrow('Refresh');
  });
  it('does not infer exhaustion from an empty filtered page', () => {
    const next = appendBillPage(first, { ...first, items: [], nextCursor: 'third' }, 'second');
    expect(next.items).toEqual(first.items); expect(next.nextCursor).toBe('third'); expect(next.total).toBe(50);
  });
  it('encodes the complete property and date scope without adding empty filters', () => {
    expect(billPageUrl('/calendar', { propertyId: 'A & B', from: '2026-09-21', to: '2026-12-21', cursor: 'x+y=', limit: 20, query: '' })).toBe('/calendar?propertyId=A+%26+B&from=2026-09-21&to=2026-12-21&cursor=x%2By%3D&limit=20');
  });
  it('uses authoritative totals, accepts empty continuation pages, and refuses the old whole-register shape', () => {
    const page = { version: 2, bills: [], groups: { 'needs-you': [], 'due-soon': [], 'in-process': [], settled: [] }, total: 501, counts: { legacy: 1, source: 500 }, revision: 'snapshot', nextCursor: 'next' };
    expect(expectedBillsPage(page).total).toBe(501);
    expect(() => expectedBillsPage({ groups: page.groups })).toThrow();
    expect(() => expectedBillsPage({ ...page, total: -1 })).toThrow();
    expect(mergeBillRows([{ id: 'a' }], [])).toEqual([{ id: 'a' }]);
  });
});
