/**
 * The per-request AI usage behind one RealBud office invoice, as CSV the office
 * downloads from its billing page (GET /v1/portal/invoices/{id}/ai-usage, proxied
 * by the website at /api/account/invoices/{id}/ai-usage and linked from the
 * invoice document).
 *
 * Rows come from Modelvia's own requests CSV of each Modelvia invoice
 * consolidated on the RealBud invoice (its customer prices: amount and GST per
 * request), read under RealBud's client key; date/time, user/project and tokens
 * are joined from Modelvia's client analytics by request id and left blank when
 * it has no such row. Only invoices recorded on THIS office's invoice, for THIS
 * office's bound Modelvia customer, are ever read. No wholesale, platform-fee or
 * markup figure exists in either source's columns used here.
 */
import { GatewayError, requireThat } from './contracts.ts';
import type { Invoice } from './billing.ts';
import type { UsageLedger } from './ledger.ts';
import type { ModelviaClientBilling } from './modelvia-client-billing.ts';
import { officeCustomer } from './office-ai-billing.ts';

export const AI_USAGE_CSV_HEADER = ['realbud_invoice', 'modelvia_invoice', 'request_id', 'date_time', 'used_by', 'project', 'model', 'tokens_in', 'tokens_out', 'amount_aud', 'gst_aud'];

const dollars = (cents: string) => { const n = BigInt(cents), a = n < 0n ? -n : n; return `${n < 0n ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`; };
/** Brisbane (UTC+10, no daylight saving) local time with its offset. */
const brisbane = (at: number) => `${new Date(at + 36_000_000).toISOString().slice(0, 19)}+10:00`;
/** RFC 4180; a cell a spreadsheet would read as a formula gets an apostrophe. */
const cell = (value: string) => {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export async function officeAiUsageCsv(options: { ledger: UsageLedger; modelvia?: ModelviaClientBilling }, invoice: Invoice): Promise<string> {
  const ids = invoice.aiUsage?.modelviaInvoices.map(entry => entry.id) ?? [];
  requireThat(ids.length, 'ai_usage_not_on_invoice', 404);
  requireThat(options.modelvia?.customerInvoiceRequests, 'modelvia_client_unconfigured', 503);
  // The customer recorded on the invoice, else (older invoices) the office's
  // binding; an office can never be moved once it accepted resale.
  const customerId = invoice.aiUsage!.modelviaCustomerId ?? officeCustomer(options.ledger, invoice.companyId);
  requireThat(customerId && customerId === officeCustomer(options.ledger, invoice.companyId), 'office_modelvia_customer_unbound', 409);
  const lines = [AI_USAGE_CSV_HEADER.join(',')];
  for (const modelviaInvoice of ids) {
    let rows;
    try { rows = await options.modelvia!.customerInvoiceRequests!(customerId!, modelviaInvoice); }
    catch (error) { throw error instanceof GatewayError ? error : new GatewayError('modelvia_unreadable', 502); }
    for (const r of rows) lines.push([invoice.id, modelviaInvoice, r.requestId, r.createdAt !== undefined ? brisbane(r.createdAt) : '', r.usedBy ?? '', r.projectId ?? '',
      r.model, r.tokensIn ?? '', r.tokensOut ?? '', dollars(r.amountCents), dollars(r.gstCents)].map(cell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
