import type { BillFacts } from '@shared/source-bills';
import { validBillDate } from '@shared/bill-dates';
export interface BillFactsDraft { propertyId: string; kind: string; vendor: string; amount: string; invoiceDate: string; dueDate: string; note: string }
export const emptyBillFacts = (): BillFactsDraft => ({ propertyId: '', kind: '', vendor: '', amount: '', invoiceDate: '', dueDate: '', note: '' });
export const draftBillFacts = (facts: BillFacts): BillFactsDraft => ({ ...facts, amount: facts.amountCents === null ? '' : (facts.amountCents / 100).toFixed(2), invoiceDate: facts.invoiceDate ?? '', dueDate: facts.dueDate ?? '' });
export function savedBillFacts(draft: BillFactsDraft): BillFacts {
  let amountCents: number | null = null;
  if (draft.amount.trim()) {
    const match = /^(0|[1-9]\d{0,9})(?:\.(\d{1,2}))?$/.exec(draft.amount.trim());
    if (!match) throw new Error('Enter the AUD amount using digits and up to two decimal places, or leave it blank when unknown.');
    amountCents = Number(BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0')));
  }
  for (const value of [draft.invoiceDate, draft.dueDate]) if (value && !validBillDate(value)) throw new Error('Check the invoice and due dates. Leave unknown dates blank.');
  return { propertyId: draft.propertyId, kind: draft.kind, vendor: draft.vendor, amountCents, currency: 'AUD', invoiceDate: draft.invoiceDate || null, dueDate: draft.dueDate || null, note: draft.note };
}
export const displayBillDate = (value: string | null) => value && validBillDate(value) ? new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`)) : 'Not confirmed';
