import { describe, expect, it } from 'vitest';
import { emptyBillFacts, savedBillFacts, draftBillFacts, displayBillDate } from './source-bill-form';
describe('source bill manual facts', () => {
  it('keeps classification undecided until a staff choice, independent of supplier or payment facts', () => {
    expect(savedBillFacts(emptyBillFacts()).maintenanceClassification).toBe('unclassified');
    const classified = savedBillFacts({ ...emptyBillFacts(), maintenanceClassification: 'maintenance' });
    expect(savedBillFacts(draftBillFacts(classified))).toEqual(classified);
    expect(() => savedBillFacts({ ...emptyBillFacts(), maintenanceClassification: 'model-approved' as any })).toThrow('staff maintenance classification');
  });
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
  it('retains invoice references as text, including leading zeros, across correction', () => {
    const saved = savedBillFacts({ ...emptyBillFacts(), invoiceNumber: '  000142/A  ', invoiceVersion: ' revised 2 ' });
    expect(saved).toMatchObject({ invoiceNumber: '000142/A', invoiceVersion: 'revised 2' });
    expect(savedBillFacts(draftBillFacts(saved))).toEqual(saved);
    expect(savedBillFacts({ ...draftBillFacts(saved), invoiceNumber: '', invoiceVersion: '' })).toMatchObject({ invoiceNumber: null, invoiceVersion: null });
  });
  it('requires a number for a version and holds malformed references', () => {
    expect(() => savedBillFacts({ ...emptyBillFacts(), invoiceVersion: '2' })).toThrow('invoice number');
    expect(() => savedBillFacts({ ...emptyBillFacts(), invoiceNumber: 'a'.repeat(121) })).toThrow('invoice number');
    expect(() => savedBillFacts({ ...emptyBillFacts(), invoiceNumber: 'INV\n123' })).toThrow('invoice number');
  });
  it('keeps supplier reference and work description as optional reviewed text, blank meaning unknown', () => {
    const saved = savedBillFacts({ ...emptyBillFacts(), supplierReference: ' SUP-FICTIONAL-042 ', workDescription: ' Fictional gutter clean\nrear yard ' });
    expect(saved).toMatchObject({ supplierReference: 'SUP-FICTIONAL-042', workDescription: 'Fictional gutter clean\nrear yard' });
    expect(savedBillFacts(draftBillFacts(saved))).toEqual(saved);
    expect(savedBillFacts(emptyBillFacts())).toMatchObject({ supplierReference: null, workDescription: null });
    const legacy = savedBillFacts(emptyBillFacts()); delete legacy.supplierReference; delete legacy.workDescription;
    expect(draftBillFacts(legacy)).toMatchObject({ supplierReference: '', workDescription: '' });
    expect(() => savedBillFacts({ ...emptyBillFacts(), supplierReference: 'a'.repeat(121) })).toThrow('supplier reference');
    expect(() => savedBillFacts({ ...emptyBillFacts(), workDescription: 'a'.repeat(1001) })).toThrow('work description');
  });
});
