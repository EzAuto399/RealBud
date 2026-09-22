import { describe, expect, it } from 'vitest';
import { emptyBillFacts, savedBillFacts, draftBillFacts, displayBillDate } from './source-bill-form';
describe('source bill manual facts', () => {
  it('keeps an unknown amount/date distinct from zero and avoids floating cents', () => {
    expect(savedBillFacts(emptyBillFacts())).toMatchObject({ amountCents: null, invoiceDate: null, dueDate: null, currency: 'AUD' });
    expect(savedBillFacts({ ...emptyBillFacts(), amount: '0' }).amountCents).toBe(0);
    expect(savedBillFacts({ ...emptyBillFacts(), amount: '123.45' }).amountCents).toBe(12345);
    expect(savedBillFacts({ ...emptyBillFacts(), amount: '1.2' }).amountCents).toBe(120);
  });
  it.each(['1e3', '-2.00', '1,000.00', '1.234', '$2', 'Infinity'])('rejects an ambiguous amount %s', amount => {
    expect(() => savedBillFacts({ ...emptyBillFacts(), amount })).toThrow();
  });
  it('roundtrips reviewed fields and rejects calendar rollovers', () => {
    const saved = savedBillFacts({ ...emptyBillFacts(), amount: '123.45', invoiceDate: '2026-09-21', dueDate: '2026-10-21' });
    expect(savedBillFacts(draftBillFacts(saved))).toEqual(saved);
    expect(() => savedBillFacts({ ...emptyBillFacts(), dueDate: '2026-02-30' })).toThrow();
    expect(displayBillDate(null)).toBe('Not confirmed');
    expect(displayBillDate('2026-01-31')).toContain('31');
  });
});
