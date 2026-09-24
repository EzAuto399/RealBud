import { describe, expect, it } from 'vitest';
import type { MailTaskPage, MailWorkItem } from '@shared/mail-ingestion';
import { appendMailPage, mailPageUrl, readMailScanPage, readMailTaskPage, retainSelectedMailItem } from './mail-pages';

const item = (id: string): MailWorkItem => ({ id, revision: 1, subject: `Conversation ${id}`, owner: '', note: '', missingFacts: [] } as unknown as MailWorkItem);
const first: MailTaskPage = { version: 2, revision: 10, group: 'all', q: '', total: 3, counts: { total: 3, open: 2, waiting: 0, reference: 0, done: 1, snoozed: 0, highPriority: 1, needsReview: 2 }, items: [item('a')], nextCursor: 'next' };
describe('bounded retained mail pages', () => {
  it('uses authoritative global counts and scoped totals', () => {
    expect(readMailTaskPage({ ...first, group: 'done', total: 1 }, { group: 'done', q: '' }).counts.total).toBe(3);
    expect(() => readMailTaskPage({ version: 1, items: [] })).toThrow('Refresh');
  });
  it.each([{ group: 'open' }, { q: 'different' }, { counts: { ...first.counts, open: 4 } }, { total: 4 }, { items: [item('a'), item('a')] }])('rejects invalid or foreign task page %j', fields => {
    expect(() => readMailTaskPage({ ...first, ...fields }, { group: 'all', q: '' })).toThrow('Refresh');
  });
  it('appends an unchanged revision without modifying old records or editing state', () => {
    const next = { ...first, items: [item('b'), item('c')], nextCursor: null };
    expect(appendMailPage(first, next, 'next').items.map(item => item.id)).toEqual(['a', 'b', 'c']);
    expect(first.items.map(item => item.id)).toEqual(['a']);
  });
  it.each([{ revision: 11 }, { group: 'open' as const }, { q: 'new' }, { total: 2 }, { nextCursor: 'next' }, { items: [item('a')] }])('refuses a stale, looping or overlapping continuation %j', fields => {
    expect(() => appendMailPage(first, { ...first, items: [item('b')], nextCursor: null, ...fields }, 'next')).toThrow('Your open edits are kept');
  });
  it('keeps empty filtered continuation pages and rejects a replaced request cursor', () => {
    expect(appendMailPage(first, { ...first, items: [], nextCursor: 'third' }, 'next').nextCursor).toBe('third');
    expect(() => appendMailPage(first, { ...first, items: [], nextCursor: null }, 'old')).toThrow();
  });
  it('encodes full scope and special characters without empty parameters', () => {
    expect(mailPageUrl('/items', { group: 'all', q: '收據 & paid?', cursor: 'a+b=', limit: 20, ignored: null })).toBe('/items?group=all&q=%E6%94%B6%E6%93%9A+%26+paid%3F&cursor=a%2Bb%3D&limit=20');
  });
  it('retains the selected source outside a refreshed page without replacing loaded versions', () => {
    const selected = item('a'), next = item('b');
    expect(retainSelectedMailItem([next], selected)).toEqual([selected, next]);
    const updated = { ...selected, revision: 2 };
    expect(retainSelectedMailItem([updated], selected)).toEqual([updated]);
    expect(retainSelectedMailItem([], selected)).toEqual([selected]);
  });
  it('validates scan pages independently from task pages', () => {
    const scan = { version: 2, revision: 10, total: 1, nextCursor: null, items: [{ id: 'scan-a', status: 'failed', startedAt: 1000, gaps: ['Fictional incomplete coverage'] }] };
    expect(readMailScanPage(scan).items[0].status).toBe('failed');
    expect(() => readMailScanPage({ ...scan, items: [{ ...scan.items[0], status: 'unknown' }] })).toThrow();
  });
});
