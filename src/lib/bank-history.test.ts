import { describe, expect, it } from 'vitest';
import { appendBankHistory, bankHistoryUrl, hasUnsavedBankDecisions, parseBankHistory } from './bank-history';

const summary = (id: string) => ({ id: `bank:${id.repeat(64)}`, revision: 1, createdAt: 1000, rows: 2, originalDigest: 'd'.repeat(64) });
const first = { version: 2 as const, batches: [summary('a')], total: 25, nextCursor: 'page2' };
describe('bank history and decision preservation', () => {
  it('reads truthful totals rather than treating a page as complete history', () => {
    expect(parseBankHistory(first).total).toBe(25);
    expect(parseBankHistory({ ...first, batches: [], nextCursor: 'later' }).nextCursor).toBe('later');
    expect(() => parseBankHistory({ batches: first.batches })).toThrow();
    expect(parseBankHistory({ ...first, batches: [{ ...summary('a'), createdAt: 1.5, reviewedAt: 2.5 }] }).batches[0].createdAt).toBe(1.5);
  });
  it.each([
    { ...first, total: -1 }, { ...first, nextCursor: '' }, { ...first, batches: [summary('a'), summary('a')] },
    { ...first, batches: [{ ...summary('a'), originalDigest: 'invalid' }] },
    { ...first, batches: [{ ...summary('a'), revision: 0 }] },
    { ...first, batches: [{ ...summary('a'), reviewedAt: Infinity }] },
  ])('rejects malformed history while callers retain the previous page', value => { expect(() => parseBankHistory(value)).toThrow(); });
  it('appends the same insertion snapshot without duplicates and retains current review revisions', () => {
    const next = { ...first, batches: [{ ...summary('a'), revision: 2 }, summary('b')], nextCursor: null };
    expect(appendBankHistory(first, next, 'page2').batches).toEqual([{ ...summary('a'), revision: 2 }, summary('b')]);
    expect(first.batches[0].revision).toBe(1);
  });
  it('refuses replies from before a refresh, shifted totals, and repeating cursors', () => {
    expect(() => appendBankHistory({ ...first, nextCursor: 'new' }, { ...first, nextCursor: null }, 'page2')).toThrow();
    expect(() => appendBankHistory(first, { ...first, total: 26, nextCursor: null }, 'page2')).toThrow();
    expect(() => appendBankHistory(first, first, 'page2')).toThrow();
    expect(bankHistoryUrl('a+b=')).toBe('/api/bank-reference?limit=20&cursor=a%2Bb%3D');
  });
  it('protects partial reasons and explicit keep decisions, while a cleared untouched row is not dirty', () => {
    expect(hasUnsavedBankDecisions({})).toBe(false);
    expect(hasUnsavedBankDecisions({ a: { action: 'assign', propertyId: '', reason: ' ' } })).toBe(false);
    expect(hasUnsavedBankDecisions({ a: { action: 'keep', reason: '' } })).toBe(true);
    expect(hasUnsavedBankDecisions({ a: { propertyId: 'Property1', reason: '' } })).toBe(true);
    expect(hasUnsavedBankDecisions({ a: { reason: 'Partial human review' } })).toBe(true);
  });
});
