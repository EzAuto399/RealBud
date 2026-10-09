import type { BillFacts, BillMaintenanceClassification } from '@shared/source-bills';
import { validBillDate } from '@shared/bill-dates';
export interface BillFactsDraft { propertyId: string; kind: string; vendor: string; amount: string; invoiceNumber?: string; invoiceVersion?: string; supplierReference?: string; workDescription?: string; maintenanceClassification?: BillMaintenanceClassification; invoiceDate: string; dueDate: string; note: string }
export const emptyBillFacts = (): BillFactsDraft => ({ propertyId: '', kind: '', vendor: '', amount: '', invoiceNumber: '', invoiceVersion: '', supplierReference: '', workDescription: '', maintenanceClassification: 'unclassified', invoiceDate: '', dueDate: '', note: '' });
export const draftBillFacts = (facts: BillFacts): BillFactsDraft => ({ ...facts, invoiceNumber: facts.invoiceNumber ?? '', invoiceVersion: facts.invoiceVersion ?? '', supplierReference: facts.supplierReference ?? '', workDescription: facts.workDescription ?? '', maintenanceClassification: facts.maintenanceClassification ?? 'unclassified', amount: facts.amountCents === null ? '' : (facts.amountCents / 100).toFixed(2), invoiceDate: facts.invoiceDate ?? '', dueDate: facts.dueDate ?? '' });
export function savedBillFacts(draft: BillFactsDraft): BillFacts {
  let amountCents: number | null = null;
  if (draft.amount.trim()) {
    const match = /^(0|[1-9]\d{0,9})(?:\.(\d{1,2}))?$/.exec(draft.amount.trim());
    if (!match) throw new Error('Enter the AUD amount using digits and up to two decimal places, or leave it blank when unknown.');
    amountCents = Number(BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0')));
  }
  for (const value of [draft.invoiceDate, draft.dueDate]) if (value && !validBillDate(value)) throw new Error('Check the invoice and due dates. Leave unknown dates blank.');
  const invoiceNumber = draft.invoiceNumber?.trim() || null, invoiceVersion = draft.invoiceVersion?.trim() || null;
  if ((invoiceNumber?.length ?? 0) > 120 || (invoiceVersion?.length ?? 0) > 80 || /[\u0000-\u001f\u007f]/.test(`${invoiceNumber ?? ''}${invoiceVersion ?? ''}`)) throw new Error('Check the invoice number and version. Use the references shown on the original invoice.');
  if (invoiceVersion && !invoiceNumber) throw new Error('Enter the invoice number before its version, or leave both blank when unknown.');
  const supplierReference = draft.supplierReference?.trim() || null, workDescription = draft.workDescription?.trim() || null;
  if ((supplierReference?.length ?? 0) > 120 || /[\u0000-\u001f\u007f]/.test(supplierReference ?? '')) throw new Error('Check the supplier reference. Use the reference from your supplier list, or leave it blank when unknown.');
  if ((workDescription?.length ?? 0) > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(workDescription ?? '')) throw new Error('Shorten the work description to 1,000 characters of plain text.');
  const maintenanceClassification = draft.maintenanceClassification ?? 'unclassified';
  if (!['unclassified', 'maintenance', 'not-maintenance'].includes(maintenanceClassification)) throw new Error('Choose a valid staff maintenance classification.');
  return { maintenanceClassification, propertyId: draft.propertyId, kind: draft.kind, vendor: draft.vendor, amountCents, currency: 'AUD', invoiceNumber, invoiceVersion, supplierReference, workDescription, invoiceDate: draft.invoiceDate || null, dueDate: draft.dueDate || null, note: draft.note };
}
export const displayBillDate = (value: string | null) => value && validBillDate(value) ? new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`)) : 'Not confirmed';
